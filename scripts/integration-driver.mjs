#!/usr/bin/env node
/**
 * Integration driver for the multi-game godot-mcp bridge.
 *
 * Boots the built server (build/index.js) over stdio with a real MCP client and
 * drives real headless Godot games from C:\GodotGames\deckbuilder. Nine
 * scenarios cover the multi-game surface: named boots, port allocation, per-game
 * routing, per-record buffer cursors, the ambiguous-selector error, name
 * minting, stop/removal, external-kill retention, and legacy pinned mode.
 *
 * Usage:
 *   node scripts/integration-driver.mjs               # all scenarios, in order
 *   node scripts/integration-driver.mjs --scenario 5  # one scenario, standalone
 *   node scripts/integration-driver.mjs --keep        # leave the last scenario's games alive
 *   node scripts/integration-driver.mjs --verbose     # stream server stderr live
 *
 * Exit code is 0 when every selected scenario passes, 1 otherwise.
 *
 * Every scenario is self-contained: it resets the registry, boots exactly what
 * it needs, and tears down after itself, so `--scenario N` works standalone.
 * A finally block always sweeps: collect pids via list_games, stop_project what
 * it can, `taskkill /F /PID` any leftovers, then close the clients.
 *
 * NOTE: this file deliberately has no dependencies beyond the MCP SDK that the
 * server itself already depends on. It is plain-node ESM; `node --check` it.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants — resolved from this script's own location, never process.cwd().
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER_ENTRY = join(ROOT, 'build', 'index.js');

/** `node` on PATH; overridable for odd shells. Spawned via cross-spawn by the SDK. */
const NODE_BIN = process.env.GODOT_MCP_DRIVER_NODE || 'node';

const PROJECT_PATH = 'C:\\GodotGames\\deckbuilder';
const GODOT_PATH = 'C:\\Program Files\\godot\\Godot_v4.7.1-stable_win64.exe';

/** Headless AI-vs-AI: boots a full match with no window and no human seat. */
const GAME_ARGS = ['--headless', '--ai_vs_ai'];

const PORT_RANGE = '9110-9159';
const PORT_LO = 9110;
const PORT_HI = 9159;

/** Env shared by both server flavours. The pinned/ranged selector is added per instance. */
const BASE_ENV = {
  GODOT_PATH,
  GODOT_MCP_PROFILE: 'spirits-deckbuilder',
  GODOT_MCP_AUTO_PROFILE: '1',
  DEBUG: 'true',
};

const RANGED_ENV = { ...BASE_ENV, GODOT_MCP_PORT_RANGE: PORT_RANGE };

/** Generous: a headless boot is ~7-10s and waitForReady adds connect + probe. */
const CALL_TIMEOUT_MS = 60_000;
const BOOT_TIMEOUT_MS = 120_000;

/** Ranged mode mints `game-` + 4 random bytes of hex on an omitted selector. */
const MINTED_RE = /^game-[0-9a-f]{8}$/;

/** How much server stderr to retain per instance for failure dumps. */
const STDERR_RING = 400;
const STDERR_DUMP = 60;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {{label: string, client: any, transport: any, stderr: string[], closed: boolean}[]} */
const SERVERS = [];

let VERBOSE = false;
let KEEP = false;

/** Lazily-created ranged-mode server shared by scenarios 1-8. */
let rangedHandle = null;

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function log(msg) {
  console.log(`[driver] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function secs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Assertion failure — distinguished from an unexpected crash in the report. */
class Fail extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionFailure';
  }
}

function check(cond, msg) {
  if (!cond) throw new Fail(msg);
}

function eq(actual, expected, what) {
  if (!Object.is(actual, expected)) {
    throw new Fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function checkPortInRange(port, what) {
  check(
    Number.isInteger(port) && port >= PORT_LO && port <= PORT_HI,
    `${what}: port ${JSON.stringify(port)} outside [${PORT_LO},${PORT_HI}]`
  );
}

/**
 * Poll `predicate` until it returns something truthy, or fail.
 * The predicate's truthy value is returned so callers can use what it found.
 */
async function waitFor(what, predicate, timeoutMs = 30_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Fail(`timed out after ${secs(timeoutMs)} waiting for ${what}`);
    }
    await sleep(intervalMs);
  }
}

/** True when nothing else holds `port` on loopback right now. */
function isPortFree(port) {
  return new Promise((res) => {
    const probe = createServer();
    probe.once('error', () => res(false));
    probe.once('listening', () => probe.close(() => res(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function findFreePortAtLeast(lo, hi) {
  for (let p = lo; p <= hi; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Fail(`no free port in ${lo}-${hi} to pin the legacy-mode server on`);
}

/** Windows hard kill. Already-dead pids just error; that is not fatal. */
async function taskkill(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    await execFileAsync('taskkill', ['/F', '/PID', String(pid)]);
    log(`taskkill /F /PID ${pid} ok`);
    return true;
  } catch (err) {
    log(`taskkill /F /PID ${pid} failed: ${err?.message || err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// MCP plumbing
// ---------------------------------------------------------------------------

async function startServer(label, env) {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Fail(`server entry not built: ${SERVER_ENTRY} (run npm run build)`);
  }
  const transport = new StdioClientTransport({
    command: NODE_BIN,
    args: [SERVER_ENTRY],
    cwd: ROOT,
    env,
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'godot-mcp-integration-driver', version: '1.0.0' },
    { capabilities: {} }
  );
  const handle = { label, client, transport, stderr: [], closed: false };
  SERVERS.push(handle);

  // stderr is a PassThrough available before start(), so no early lines are lost.
  const errStream = transport.stderr;
  if (errStream) {
    let pending = '';
    errStream.on('data', (chunk) => {
      pending += chunk.toString();
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? '';
      for (const line of parts) {
        handle.stderr.push(line);
        if (handle.stderr.length > STDERR_RING) handle.stderr.shift();
        if (VERBOSE) console.log(`[driver][${label}] ${line}`);
      }
    });
  }

  await client.connect(transport);
  log(`server '${label}' up (${SERVER_ENTRY})`);
  return handle;
}

async function closeServer(handle) {
  if (!handle || handle.closed) return;
  handle.closed = true;
  try {
    await handle.client.close();
  } catch (err) {
    log(`closing server '${handle.label}' failed: ${err?.message || err}`);
  }
}

/** The ranged-mode server used by scenarios 1-8. Created on first use. */
async function getRanged() {
  if (!rangedHandle || rangedHandle.closed) {
    rangedHandle = await startServer('ranged', RANGED_ENV);
  }
  return rangedHandle;
}

async function call(handle, name, args = {}, timeoutMs = CALL_TIMEOUT_MS) {
  return handle.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
}

function textOf(res) {
  const content = res?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

function isErr(res) {
  return res?.isError === true;
}

function jsonOf(res) {
  const text = textOf(res);
  try {
    return JSON.parse(text);
  } catch {
    throw new Fail(`expected a JSON tool result, got: ${text.slice(0, 400)}`);
  }
}

// ---------------------------------------------------------------------------
// Bridge-level conveniences
// ---------------------------------------------------------------------------

async function listGames(handle) {
  let res;
  try {
    res = await call(handle, 'list_games', {});
  } catch (err) {
    throw new Fail(`list_games call rejected (tool missing or server error): ${err?.message || err}`);
  }
  if (isErr(res)) throw new Fail(`list_games returned an error: ${textOf(res)}`);
  const payload = jsonOf(res);
  if (!payload || !Array.isArray(payload.games)) {
    throw new Fail(`list_games payload has no games[]: ${textOf(res).slice(0, 400)}`);
  }
  return payload;
}

/**
 * Boot one game. `game` may be null/undefined to exercise the omitted-selector
 * path (mint in ranged mode, replace-in-place in legacy pinned mode).
 */
async function bootGame(handle, game, { waitForReady = true, extraArgs = GAME_ARGS } = {}) {
  const args = { projectPath: PROJECT_PATH, extraArgs, waitForReady };
  if (game !== null && game !== undefined) args.game = game;
  const label = game ?? '(no game param)';
  const started = Date.now();
  const res = await call(handle, 'run_project', args, BOOT_TIMEOUT_MS);
  if (isErr(res)) throw new Fail(`run_project ${label} failed: ${textOf(res)}`);
  log(`booted ${label} in ${secs(Date.now() - started)}`);
  return res;
}

/** Stop every record this server tracks. Best effort — never throws. */
async function stopAllGames(handle) {
  let payload;
  try {
    payload = await listGames(handle);
  } catch (err) {
    log(`list_games during teardown of '${handle.label}' failed: ${err?.message || err}`);
    return;
  }
  for (const rec of payload.games) {
    try {
      await call(handle, 'stop_project', { game: rec.name });
      log(`stopped '${rec.name}'`);
    } catch (err) {
      log(`stop_project '${rec.name}' failed: ${err?.message || err}`);
    }
  }
}

/**
 * Bring a server back to an empty registry so the next scenario starts clean.
 * Called at the START of every scenario, which is what makes `--scenario N`
 * independent of whatever ran before it.
 */
async function resetRegistry(handle) {
  await stopAllGames(handle);
  const payload = await listGames(handle);
  check(
    payload.games.length === 0,
    `registry not empty after reset: ${payload.games.map((g) => `${g.name}/${g.status}`).join(', ')}`
  );
  // Let the OS release the just-freed ports before the next allocation probe.
  await sleep(300);
}

/** Drain a record's error cursor so later reads only see genuinely-new lines. */
async function drainErrors(handle, game) {
  for (let i = 0; i < 5; i++) {
    const res = await call(handle, 'game_get_errors', { game });
    if (isErr(res)) throw new Fail(`game_get_errors {game:'${game}'} failed: ${textOf(res)}`);
    const payload = jsonOf(res);
    if ((payload.count ?? 0) === 0) return;
  }
}

/**
 * Make a game emit one identifiable stderr line on demand, so cursor isolation
 * can be proven with markers rather than with racy line counts.
 */
async function emitStderrMarker(handle, game, marker) {
  const res = await call(handle, 'game_eval', {
    game,
    code: `printerr("${marker}")\nreturn "ok"`,
  });
  if (isErr(res)) {
    throw new Fail(`game_eval printerr on '${game}' failed: ${textOf(res)}`);
  }
}

/**
 * Marker search over a batch of captured lines.
 *
 * Joined with no separator on purpose: the bridge splits each stdio chunk on
 * '\n' without carrying a residual, so a line can land in the buffer as two
 * fragments if a chunk boundary falls mid-line. The markers are unique enough
 * that concatenation cannot produce a false positive.
 */
function containsMarker(lines, marker) {
  return (Array.isArray(lines) ? lines : []).map(String).join('').includes(marker);
}

/** Read one record's new error lines. */
async function getErrors(handle, game) {
  const res = await call(handle, 'game_get_errors', { game });
  if (isErr(res)) throw new Fail(`game_get_errors {game:'${game}'} failed: ${textOf(res)}`);
  const payload = jsonOf(res);
  return Array.isArray(payload.errors) ? payload.errors : [];
}

/** Poll one record's error stream until `marker` shows up in a returned batch. */
async function awaitMarker(handle, game, marker, timeoutMs = 20_000) {
  return waitFor(
    `marker ${marker} on '${game}' stderr`,
    async () => {
      const lines = await getErrors(handle, game);
      return containsMarker(lines, marker) ? lines : null;
    },
    timeoutMs,
    500
  );
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** 1. Boot itest-a: connected + probeOk, port inside the configured range. */
async function scenario1() {
  const handle = await getRanged();
  await resetRegistry(handle);

  const payload = jsonOf(await bootGame(handle, 'itest-a'));
  eq(payload.message, 'Godot project started', 'run_project.message');
  eq(payload.game, 'itest-a', 'run_project.game');
  eq(payload.connected, true, 'run_project.connected');
  eq(payload.probeOk, true, 'run_project.probeOk');
  checkPortInRange(payload.port, 'run_project.port');
  check(Array.isArray(payload.argv), `run_project.argv should be an array, got ${typeof payload.argv}`);
  for (const flag of GAME_ARGS) {
    check(payload.argv.includes(flag), `run_project.argv missing ${flag}: ${JSON.stringify(payload.argv)}`);
  }
  check(
    payload.argv.includes(PROJECT_PATH),
    `run_project.argv missing the project path: ${JSON.stringify(payload.argv)}`
  );
}

/** 2. Boot itest-b alongside itest-a: distinct ports, both tracked. */
async function scenario2() {
  const handle = await getRanged();
  await resetRegistry(handle);

  const a = jsonOf(await bootGame(handle, 'itest-a'));
  const b = jsonOf(await bootGame(handle, 'itest-b'));

  eq(a.game, 'itest-a', 'first run_project.game');
  eq(b.game, 'itest-b', 'second run_project.game');
  eq(b.connected, true, 'itest-b connected');
  eq(b.probeOk, true, 'itest-b probeOk');
  checkPortInRange(a.port, 'itest-a port');
  checkPortInRange(b.port, 'itest-b port');
  check(a.port !== b.port, `two live games share port ${a.port}`);

  const payload = await listGames(handle);
  eq(payload.portRange, PORT_RANGE, 'list_games.portRange');
  eq(payload.legacyPinned, false, 'list_games.legacyPinned');
  const names = payload.games.map((g) => g.name).sort();
  eq(names.join(','), 'itest-a,itest-b', 'list_games names');
  for (const rec of payload.games) {
    check(Number.isInteger(rec.pid) && rec.pid > 0, `list_games ${rec.name} has no pid: ${JSON.stringify(rec)}`);
    eq(rec.status, 'running', `list_games ${rec.name}.status`);
    eq(rec.connected, true, `list_games ${rec.name}.connected`);
    // Compared loosely: the bridge may normalise separators or casing.
    check(
      typeof rec.projectPath === 'string' && /deckbuilder$/i.test(rec.projectPath.replace(/[\\/]+$/, '')),
      `list_games ${rec.name}.projectPath unexpected: ${JSON.stringify(rec.projectPath)}`
    );
  }
  const ports = payload.games.map((g) => g.port);
  check(new Set(ports).size === ports.length, `list_games reports duplicate ports: ${ports.join(',')}`);
}

/** 3. spirits_state_probe {game} answers healthily on both games, routed correctly. */
async function scenario3() {
  const handle = await getRanged();
  await resetRegistry(handle);

  const a = jsonOf(await bootGame(handle, 'itest-a'));
  const b = jsonOf(await bootGame(handle, 'itest-b'));

  for (const [name, boot] of [
    ['itest-a', a],
    ['itest-b', b],
  ]) {
    const res = await call(handle, 'spirits_state_probe', { game: name });
    check(!isErr(res), `spirits_state_probe {game:'${name}'} errored: ${textOf(res)}`);
    const probe = jsonOf(res);
    eq(probe.ok, true, `spirits_state_probe {game:'${name}'}.ok`);
    check(typeof probe.scene === 'string', `${name} probe has no scene field: ${JSON.stringify(probe)}`);
    log(`${name} probe: scene=${probe.scene} state=${probe.game_state} round=${probe.round_index}`);

    // game_status must agree about which process this name points at.
    const statusRes = await call(handle, 'game_status', { game: name });
    check(!isErr(statusRes), `game_status {game:'${name}'} errored: ${textOf(statusRes)}`);
    const status = jsonOf(statusRes);
    eq(status.game, name, `game_status.game for ${name}`);
    eq(status.status, 'running', `game_status.status for ${name}`);
    eq(status.connectedToGame, true, `game_status.connectedToGame for ${name}`);
    eq(status.interactionPort, boot.port, `game_status.interactionPort for ${name}`);
    check(Number.isInteger(status.pid) && status.pid > 0, `game_status.pid for ${name}: ${status.pid}`);
  }
}

/**
 * 4. game_get_errors cursors are per record: draining one game neither rewinds
 *    nor advances the other, and no game ever returns the other's lines.
 */
async function scenario4() {
  const handle = await getRanged();
  await resetRegistry(handle);

  await bootGame(handle, 'itest-a');
  await bootGame(handle, 'itest-b');

  await drainErrors(handle, 'itest-a');
  await drainErrors(handle, 'itest-b');

  const MARK_A = 'ITEST_CURSOR_MARK_A';
  const MARK_B = 'ITEST_CURSOR_MARK_B';

  // --- B emits; B must see it, A must not, and B must not repeat it.
  await emitStderrMarker(handle, 'itest-b', MARK_B);
  await awaitMarker(handle, 'itest-b', MARK_B);

  const aLines = await getErrors(handle, 'itest-a');
  check(
    !containsMarker(aLines, MARK_B),
    `itest-a returned itest-b's stderr (buffers not isolated): ${JSON.stringify(aLines.slice(0, 5))}`
  );

  const bRepeatLines = await getErrors(handle, 'itest-b');
  check(
    !containsMarker(bRepeatLines, MARK_B),
    'itest-b re-delivered an already-consumed line (cursor did not advance)'
  );

  // --- A emits; symmetric check in the other direction.
  await emitStderrMarker(handle, 'itest-a', MARK_A);
  await awaitMarker(handle, 'itest-a', MARK_A);

  const bLines = await getErrors(handle, 'itest-b');
  check(
    !containsMarker(bLines, MARK_A),
    `itest-b returned itest-a's stderr (buffers not isolated): ${JSON.stringify(bLines.slice(0, 5))}`
  );
  check(
    !containsMarker(bLines, MARK_B),
    'itest-b re-delivered its own consumed marker on a later call (cursor rewound)'
  );
}

/** 5. An omitted selector with two live games is an error naming both games. */
async function scenario5() {
  const handle = await getRanged();
  await resetRegistry(handle);

  await bootGame(handle, 'itest-a');
  await bootGame(handle, 'itest-b');

  const res = await call(handle, 'game_performance', {});
  check(isErr(res), `game_performance {} with two live games should error, got: ${textOf(res).slice(0, 300)}`);
  const text = textOf(res);
  check(text.includes('Multiple games exist'), `error text missing 'Multiple games exist': ${text}`);
  check(text.includes('itest-a'), `error text missing 'itest-a': ${text}`);
  check(text.includes('itest-b'), `error text missing 'itest-b': ${text}`);
}

/**
 * 6. Ranged mode mints on an omitted selector — even when a record already
 *    exists (that replace-in-place behaviour is legacy-pinned only, per F2).
 */
async function scenario6() {
  const handle = await getRanged();
  await resetRegistry(handle);

  // waitForReady:false keeps this cheap; the record exists either way.
  await bootGame(handle, 'itest-a', { waitForReady: false });

  const minted = jsonOf(await bootGame(handle, null, { waitForReady: false }));
  eq(minted.message, 'Godot project started', 'minted run_project.message');
  check(
    typeof minted.game === 'string' && MINTED_RE.test(minted.game),
    `expected a minted name matching ${MINTED_RE}, got ${JSON.stringify(minted.game)}`
  );
  checkPortInRange(minted.port, 'minted run_project.port');
  check(Array.isArray(minted.argv), 'minted run_project.argv should be an array');

  const payload = await listGames(handle);
  const names = payload.games.map((g) => g.name);
  check(names.includes('itest-a'), `itest-a should survive an omitted-selector boot in ranged mode: ${names}`);
  check(names.includes(minted.game), `minted record ${minted.game} missing from list_games: ${names}`);
  eq(payload.games.length, 2, 'registry size after minting alongside itest-a');

  const stopRes = await call(handle, 'stop_project', { game: minted.game });
  check(!isErr(stopRes), `stop_project {game:'${minted.game}'} errored: ${textOf(stopRes)}`);
  const stopped = jsonOf(stopRes);
  eq(stopped.message, 'Godot project stopped', 'stop_project.message');
  eq(stopped.game, minted.game, 'stop_project.game');

  const after = await listGames(handle);
  check(
    !after.games.some((g) => g.name === minted.game),
    `minted record ${minted.game} should be gone after stop_project`
  );
  check(after.games.some((g) => g.name === 'itest-a'), 'itest-a should be untouched by the minted stop');
}

/** 7. Stopping one game leaves the other fully usable. */
async function scenario7() {
  const handle = await getRanged();
  await resetRegistry(handle);

  await bootGame(handle, 'itest-a');
  await bootGame(handle, 'itest-b');

  const stopRes = await call(handle, 'stop_project', { game: 'itest-a' });
  check(!isErr(stopRes), `stop_project {game:'itest-a'} errored: ${textOf(stopRes)}`);
  const stopped = jsonOf(stopRes);
  eq(stopped.message, 'Godot project stopped', 'stop_project.message');
  eq(stopped.game, 'itest-a', 'stop_project.game');

  const payload = await listGames(handle);
  check(!payload.games.some((g) => g.name === 'itest-a'), 'itest-a record should be removed by stop_project');
  check(payload.games.some((g) => g.name === 'itest-b'), 'itest-b record should survive');

  const probeRes = await call(handle, 'spirits_state_probe', { game: 'itest-b' });
  check(!isErr(probeRes), `itest-b probe errored after stopping itest-a: ${textOf(probeRes)}`);
  eq(jsonOf(probeRes).ok, true, 'itest-b probe .ok after stopping itest-a');

  // With exactly one record left, the omitted selector must resolve to it again.
  const bareRes = await call(handle, 'spirits_state_probe', {});
  check(!isErr(bareRes), `omitted selector with one live game should resolve: ${textOf(bareRes)}`);
  eq(jsonOf(bareRes).ok, true, 'omitted-selector probe .ok');
}

/** 8. An externally-killed game becomes an exited record whose buffers survive. */
async function scenario8() {
  const handle = await getRanged();
  await resetRegistry(handle);

  await bootGame(handle, 'itest-b');

  const before = await listGames(handle);
  const rec = before.games.find((g) => g.name === 'itest-b');
  check(rec && Number.isInteger(rec.pid) && rec.pid > 0, `no pid for itest-b: ${JSON.stringify(rec)}`);

  check(await taskkill(rec.pid), `taskkill /F /PID ${rec.pid} failed`);

  const exited = await waitFor(
    "itest-b to reach status 'exited'",
    async () => {
      const payload = await listGames(handle);
      const found = payload.games.find((g) => g.name === 'itest-b');
      return found && found.status === 'exited' ? found : null;
    },
    30_000,
    500
  );
  log(`itest-b exited, exitCode=${JSON.stringify(exited.exitCode)}`);

  // Buffers are retained for forensics.
  const dbgRes = await call(handle, 'get_debug_output', { game: 'itest-b' });
  check(!isErr(dbgRes), `get_debug_output on an exited record should succeed: ${textOf(dbgRes)}`);
  const dbg = jsonOf(dbgRes);
  eq(dbg.game, 'itest-b', 'get_debug_output.game');
  eq(dbg.status, 'exited', 'get_debug_output.status');
  check(Array.isArray(dbg.output), 'get_debug_output.output should be an array');
  check(Array.isArray(dbg.errors), 'get_debug_output.errors should be an array');
  const bufferedLines = (dbg.bufferedOutputLines ?? 0) + (dbg.bufferedErrorLines ?? 0);
  check(
    bufferedLines > 0,
    `expected retained buffers on the exited record, got ${JSON.stringify({
      bufferedOutputLines: dbg.bufferedOutputLines,
      bufferedErrorLines: dbg.bufferedErrorLines,
    })}`
  );
  check(
    dbg.output.length + dbg.errors.length > 0,
    'expected a retained tail on the exited record'
  );

  // Socket tools refuse an exited record with the dedicated message (N3).
  const probeRes = await call(handle, 'spirits_state_probe', { game: 'itest-b' });
  check(isErr(probeRes), 'a socket tool against an exited record should error');
  check(
    textOf(probeRes).includes("Game 'itest-b' has exited"),
    `unexpected exited-record error text: ${textOf(probeRes)}`
  );

  // stop_project reports the tail and drops the record.
  const stopRes = await call(handle, 'stop_project', { game: 'itest-b' });
  check(!isErr(stopRes), `stop_project on an exited record errored: ${textOf(stopRes)}`);
  const stopped = jsonOf(stopRes);
  eq(stopped.message, 'Godot project stopped', 'stop_project.message');
  eq(stopped.game, 'itest-b', 'stop_project.game');
  eq(stopped.exitConfirmed, true, 'stop_project.exitConfirmed for an already-exited record');
  check(Array.isArray(stopped.finalOutput), 'stop_project.finalOutput should be an array');
  check(Array.isArray(stopped.finalErrors), 'stop_project.finalErrors should be an array');
  check(
    stopped.finalOutput.length + stopped.finalErrors.length > 0,
    'stop_project should report a final tail from the retained buffers'
  );

  const after = await listGames(handle);
  check(
    !after.games.some((g) => g.name === 'itest-b'),
    'the exited record should be removed by stop_project'
  );
}

/**
 * 9. Legacy pinned mode on a fresh server instance: byte-exact empty-registry
 *    probe strings, replace-in-place on an omitted selector, and record deletion
 *    (not retention) when the game dies (F1).
 */
async function scenario9() {
  const pinned = await findFreePortAtLeast(9120, PORT_HI);
  log(`legacy scenario pinning GODOT_MCP_PORT=${pinned}`);
  const handle = await startServer(`legacy-${pinned}`, {
    ...BASE_ENV,
    GODOT_MCP_PORT: String(pinned),
  });

  try {
    // --- Empty registry: the byte-exact legacy string.
    const emptyRes = await call(handle, 'get_debug_output', {});
    check(isErr(emptyRes), 'get_debug_output on an empty registry should be an error');
    eq(textOf(emptyRes), 'No active Godot process.', 'legacy empty-registry get_debug_output text');

    const empty = await listGames(handle);
    eq(empty.legacyPinned, true, 'list_games.legacyPinned');
    eq(empty.portRange, `${pinned}-${pinned}`, 'list_games.portRange');
    eq(empty.games.length, 0, 'legacy registry should start empty');

    // --- First boot with no game param mints (registry was empty).
    const first = jsonOf(await bootGame(handle, null));
    eq(first.message, 'Godot project started', 'legacy run_project.message');
    eq(first.port, pinned, 'legacy run_project.port should be the pin');
    eq(first.connected, true, 'legacy run_project.connected');
    eq(first.probeOk, true, 'legacy run_project.probeOk');
    check(
      typeof first.game === 'string' && MINTED_RE.test(first.game),
      `legacy first boot should mint into an empty registry, got ${JSON.stringify(first.game)}`
    );

    const afterFirst = await listGames(handle);
    eq(afterFirst.games.length, 1, 'legacy registry size after the first boot');
    const rec1 = afterFirst.games.find((g) => g.name === first.game);
    check(rec1 && Number.isInteger(rec1.pid) && rec1.pid > 0, `no pid for ${first.game}: ${JSON.stringify(rec1)}`);
    eq(rec1.port, pinned, 'legacy record port');

    // --- Second no-param boot replaces the sole record in place (F2/F3).
    const second = jsonOf(await bootGame(handle, null));
    eq(second.game, first.game, 'legacy replacement should reuse the existing record name');
    eq(second.port, pinned, 'legacy replacement should reuse the pinned port');
    eq(second.connected, true, 'legacy replacement connected');
    eq(second.probeOk, true, 'legacy replacement probeOk');

    const afterSecond = await listGames(handle);
    eq(afterSecond.games.length, 1, 'legacy registry should still hold exactly one record');
    const rec2 = afterSecond.games.find((g) => g.name === first.game);
    check(rec2 && Number.isInteger(rec2.pid) && rec2.pid > 0, `no pid after replacement: ${JSON.stringify(rec2)}`);
    check(rec2.pid !== rec1.pid, `replacement should be a new process (pid still ${rec2.pid})`);

    // --- External kill: legacy mode DELETES the record, restoring the probe string.
    check(await taskkill(rec2.pid), `taskkill /F /PID ${rec2.pid} failed`);
    const finalText = await waitFor(
      'the legacy record to disappear after an external kill',
      async () => {
        const res = await call(handle, 'get_debug_output', {});
        return isErr(res) ? textOf(res) : null;
      },
      30_000,
      500
    );
    eq(finalText, 'No active Godot process.', 'legacy post-exit get_debug_output text');

    const afterKill = await listGames(handle);
    eq(afterKill.games.length, 0, 'legacy mode should delete the record on exit (F1)');
  } finally {
    if (!KEEP) await stopAllGames(handle);
    await closeServer(handle);
  }
}

const SCENARIOS = [
  { n: 1, title: 'boot itest-a: connected + probeOk, port in range', fn: scenario1 },
  { n: 2, title: 'boot itest-b: distinct port, both tracked', fn: scenario2 },
  { n: 3, title: 'spirits_state_probe {game} healthy on both', fn: scenario3 },
  { n: 4, title: 'game_get_errors cursor isolation', fn: scenario4 },
  { n: 5, title: "game_performance {} -> 'Multiple games exist'", fn: scenario5 },
  { n: 6, title: 'run_project with no game mints game-xxxxxxxx', fn: scenario6 },
  { n: 7, title: 'stop_project itest-a leaves itest-b usable', fn: scenario7 },
  { n: 8, title: 'external kill -> exited record retains buffers', fn: scenario8 },
  { n: 9, title: 'legacy pinned mode: exact strings + replace in place', fn: scenario9 },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function dumpServerStderr(reason) {
  for (const handle of SERVERS) {
    if (handle.closed || handle.stderr.length === 0) continue;
    log(`--- last ${Math.min(STDERR_DUMP, handle.stderr.length)} stderr lines from '${handle.label}' (${reason}) ---`);
    for (const line of handle.stderr.slice(-STDERR_DUMP)) console.log(`[driver][${handle.label}] ${line}`);
    log(`--- end '${handle.label}' stderr ---`);
  }
}

/** Always-runs sweep: pids first, then graceful stops, then hard kills, then close. */
async function cleanupAll() {
  if (KEEP) {
    log('--keep given: leaving games alive; closing clients only (games may be orphaned)');
  } else {
    const pids = [];
    for (const handle of SERVERS) {
      if (handle.closed) continue;
      try {
        const payload = await listGames(handle);
        for (const rec of payload.games) {
          if (Number.isInteger(rec.pid) && rec.pid > 0) pids.push(rec.pid);
        }
      } catch (err) {
        log(`cleanup list_games on '${handle.label}' failed: ${err?.message || err}`);
      }
    }
    for (const handle of SERVERS) {
      if (handle.closed) continue;
      await stopAllGames(handle);
    }
    for (const pid of pids) {
      await taskkill(pid);
    }
  }
  for (const handle of SERVERS) {
    await closeServer(handle);
  }
  SERVERS.length = 0;
  rangedHandle = null;
}

/**
 * Run the selected scenarios.
 * @param {{scenario?: number|null, keep?: boolean, verbose?: boolean}} [options]
 * @returns {Promise<{total: number, passed: number, failed: number, results: {n: number, title: string, ok: boolean, ms: number, error: string|null}[]}>}
 */
export async function runAll(options = {}) {
  VERBOSE = options.verbose === true || process.env.GODOT_MCP_DRIVER_VERBOSE === '1';
  KEEP = options.keep === true;

  const wanted =
    options.scenario === null || options.scenario === undefined
      ? SCENARIOS
      : SCENARIOS.filter((s) => s.n === options.scenario);
  if (wanted.length === 0) {
    throw new Error(`Unknown scenario ${options.scenario}; valid: 1-${SCENARIOS.length}`);
  }

  const results = [];
  log(`worktree root: ${ROOT}`);
  log(`server entry:  ${SERVER_ENTRY}`);
  log(`project:       ${PROJECT_PATH}`);
  log(`port range:    ${PORT_RANGE}`);
  log(`running ${wanted.length} scenario(s): ${wanted.map((s) => s.n).join(', ')}`);

  try {
    for (const entry of wanted) {
      log(`===== scenario ${entry.n}: ${entry.title} =====`);
      const started = Date.now();
      let error = null;
      try {
        await entry.fn();
      } catch (err) {
        error = err instanceof Fail ? err.message : `${err?.name || 'Error'}: ${err?.message || err}`;
        if (!(err instanceof Fail) && err?.stack) console.error(err.stack);
        dumpServerStderr(`scenario ${entry.n} failed`);
      } finally {
        // Per-scenario teardown; the next scenario also resets, so --keep only
        // ever leaves the LAST scenario's games alive.
        if (!KEEP && rangedHandle && !rangedHandle.closed) {
          try {
            await stopAllGames(rangedHandle);
          } catch (err) {
            log(`teardown after scenario ${entry.n} failed: ${err?.message || err}`);
          }
        }
      }
      const ms = Date.now() - started;
      results.push({ n: entry.n, title: entry.title, ok: error === null, ms, error });
      log(`${error === null ? 'PASS' : 'FAIL'} scenario ${entry.n} (${secs(ms)})${error ? `: ${error}` : ''}`);
    }
  } finally {
    await cleanupAll();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;

  log('===== summary =====');
  for (const r of results) {
    log(`${r.ok ? 'PASS' : 'FAIL'} ${r.n}  ${r.title}  (${secs(r.ms)})`);
    if (!r.ok) log(`       ${r.error}`);
  }
  log(`${passed} passed, ${failed} failed, ${results.length} total`);

  return { total: results.length, passed, failed, results };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { scenario: null, keep: false, verbose: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep') options.keep = true;
    else if (arg === '--verbose' || arg === '-v') options.verbose = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--scenario') options.scenario = Number(argv[++i]);
    else if (arg.startsWith('--scenario=')) options.scenario = Number(arg.slice('--scenario='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.scenario !== null && !Number.isInteger(options.scenario)) {
    throw new Error('--scenario expects an integer');
  }
  return options;
}

function usage() {
  console.log(
    [
      'Usage: node scripts/integration-driver.mjs [--scenario N] [--keep] [--verbose]',
      '',
      '  --scenario N   run only scenario N (1-9); each scenario is self-contained',
      '  --keep         leave the last scenario\'s games running instead of killing them',
      '  --verbose, -v  stream the MCP server\'s stderr live (DEBUG=true is always set)',
      '',
      'Scenarios:',
      ...SCENARIOS.map((s) => `  ${s.n}. ${s.title}`),
    ].join('\n')
  );
}

function isMainModule() {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[driver] ${err.message}`);
    usage();
    process.exit(1);
  }
  if (options.help) {
    usage();
    process.exit(0);
  }
  let code = 1;
  try {
    const summary = await runAll(options);
    code = summary.failed === 0 ? 0 : 1;
  } catch (err) {
    console.error(`[driver] fatal: ${err?.stack || err?.message || err}`);
    try {
      await cleanupAll();
    } catch {
      /* already reported */
    }
    code = 1;
  }
  process.exit(code);
}
