/**
 * Multi-game integration test — a thin vitest wrapper around
 * scripts/integration-driver.mjs.
 *
 * This suite boots REAL headless Godot games from C:\GodotGames\deckbuilder
 * through the built server (build/index.js), so it is opt-in:
 *
 *   GODOT_MCP_INTEGRATION=1 npx vitest run tests/integration/multi-game.test.ts
 *
 * Without that env var the whole describe block is skipped and nothing is
 * imported — `npm test` must never spawn a game engine (plan F5). The driver
 * itself is loaded with a dynamic import inside the test body precisely so that
 * a gated-off run does not even resolve the MCP SDK or touch build/.
 *
 * The driver owns its own timeouts, retries and cleanup; all this file does is
 * run every scenario and surface the failures.
 */

import { describe, expect, it } from 'vitest';

interface ScenarioResult {
  n: number;
  title: string;
  ok: boolean;
  ms: number;
  error: string | null;
}

interface DriverSummary {
  total: number;
  passed: number;
  failed: number;
  results: ScenarioResult[];
}

interface DriverModule {
  runAll: (options?: {
    scenario?: number | null;
    keep?: boolean;
    verbose?: boolean;
  }) => Promise<DriverSummary>;
}

/** Nine real game boots plus teardown; 30 minutes is deliberately generous. */
const DRIVER_TIMEOUT_MS = 1_800_000;

const ENABLED = process.env.GODOT_MCP_INTEGRATION === '1';

function describeFailures(summary: DriverSummary): string {
  const failures = summary.results.filter((r) => !r.ok);
  if (failures.length === 0) return 'all scenarios passed';
  return [
    `${failures.length}/${summary.total} driver scenario(s) failed:`,
    ...failures.map((r) => `  scenario ${r.n} (${r.title}): ${r.error}`),
  ].join('\n');
}

describe.runIf(ENABLED)('multi-game bridge (real Godot, opt-in)', () => {
  it(
    'passes every integration-driver scenario',
    async () => {
      // @ts-ignore -- plain-node ESM driver, no type declarations; tsconfig excludes tests/.
      const driver = (await import('../../scripts/integration-driver.mjs')) as DriverModule;

      const summary = await driver.runAll();

      expect(summary.total).toBeGreaterThan(0);
      expect(describeFailures(summary)).toBe('all scenarios passed');
      expect(summary.failed).toBe(0);
      expect(summary.passed).toBe(summary.total);
    },
    DRIVER_TIMEOUT_MS
  );
});
