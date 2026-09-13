// Every worker check: the storage-agnostic ones once on KV and once on D1.
//   node worker/run-tests.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const runs = [
  ['spbfi-reports.test.mjs', 'kv'],
  ['club.test.mjs', 'kv'],
  ['club.test.mjs', 'd1'],
  ['rewards.test.mjs', 'kv'],
  ['rewards.test.mjs', 'd1'],
  ['batch.test.mjs', 'kv'],
  ['batch.test.mjs', 'd1'],
  ['club-modes.test.mjs', 'kv'],
  ['club-modes.test.mjs', 'd1'],
  ['club-return.test.mjs', 'kv'],
  ['club-return.test.mjs', 'd1'],
  ['storage.test.mjs', 'kv+d1'],
];

let failed = 0;
for (const [file, store] of runs) {
  const result = spawnSync(process.execPath, ['--no-warnings', file], {
    cwd: dir,
    env: { ...process.env, SPBFI_STORE: store },
    encoding: 'utf8',
  });
  const ok = result.status === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file} [${store}]`);
  if (!ok) {
    failed += 1;
    console.log(`${result.stdout}${result.stderr}`);
  }
}
process.exit(failed ? 1 : 0);
