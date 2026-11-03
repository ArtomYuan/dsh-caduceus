#!/usr/bin/env node
/**
 * Build the browser half with the dsh checkout's bundled tsdown. No dependency
 * is installed by this package; set DSH_TSUNDOWN to another runner if needed.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const dshRoot = process.env.DSH_CHECKOUT ?? process.env.DSH_HOME ?? '/home/artom/.dsh';
const candidates = [
  process.env.DSH_TSUNDOWN,
  join(dshRoot, 'node_modules', 'tsdown', 'dist', 'run.mjs'),
  join(process.cwd(), 'node_modules', 'tsdown', 'dist', 'run.mjs'),
].filter((value) => typeof value === 'string' && value.length > 0 && existsSync(value));

if (candidates.length === 0) {
  console.error(
    "build-client: tsdown not found. Set DSH_TSUNDOWN to dsh's tsdown run.mjs (or DSH_CHECKOUT to the dsh checkout).",
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [candidates[0], '--config', 'tsdown.client.mjs'], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
