// Loads the club's documents, exported from the old server with
// `server/migrate.mjs export`, into this server's database.
//
//   SPBFI_DB=/var/lib/spbfi/club.sqlite node server/import.mjs export.json
//
// Run it while the club server is stopped: the server reads the VAPID key and
// the club secret once and would go on using the ones it read before.
import fs from 'node:fs';
import worker from '../worker/spbfi-reports.js';
import { SqliteD1 } from './sqlite-d1.mjs';

// The old server writes this while it is frozen for the move. Carried over,
// it would freeze the new server too, and nobody could mark anything.
const LEFT_BEHIND = new Set(['meta:frozen']);

const positiveInteger = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

export async function importDump(d1, dump) {
  if (!Array.isArray(dump?.docs)) throw new Error('expected an export with a docs array');
  // The worker makes its own tables, exactly as on a first request, so the
  // shape of the database is defined in one place only.
  const answer = await worker.fetch(new Request('https://import.invalid/reports'), { DB: d1 }, { waitUntil() {} });
  if (!answer.ok) throw new Error(`the worker could not set up the database: ${answer.status} ${await answer.text()}`);

  const now = Date.now();
  const rows = new Map();
  for (const row of dump.docs) {
    if (!row || typeof row.key !== 'string' || !row.key || typeof row.body !== 'string' || LEFT_BEHIND.has(row.key)) continue;
    rows.set(row.key, row);
  }
  // One transaction: the database holds either everything it held before or
  // exactly the export, never a mixture.
  await d1.batch([
    d1.prepare('DELETE FROM docs'),
    ...[...rows.values()].map((row) => d1.prepare('INSERT INTO docs (key, body, version, updated_at) VALUES (?, ?, ?, ?)')
      .bind(row.key, row.body, positiveInteger(row.version) ?? 1, positiveInteger(row.updated_at) ?? now)),
  ]);
  return [...rows.keys()];
}

if (import.meta.main) {
  const source = process.argv[2];
  if (!source || process.argv.length !== 3) {
    console.error('usage: SPBFI_DB=/var/lib/spbfi/club.sqlite node server/import.mjs <export.json>');
    process.exit(2);
  }
  const file = process.env.SPBFI_DB || '/var/lib/spbfi/club.sqlite';
  const d1 = new SqliteD1(file);
  try {
    const keys = await importDump(d1, JSON.parse(fs.readFileSync(source, 'utf8')));
    console.log(`imported ${keys.length} documents into ${file}`);
    const vital = {
      vapid: 'Without it the server makes a new VAPID key, and no phone subscribed on the old server hears a push until it subscribes again.',
      'club:secret': "Without it every member's pass stops working, and everyone would have to join the club again.",
    };
    for (const [key, loss] of Object.entries(vital)) {
      if (keys.includes(key)) {
        console.log(`  ${key}: present`);
      } else {
        console.error(`\n  !!! WARNING: ${key} is MISSING from the export !!!\n  ${loss}\n`);
      }
    }
  } catch (error) {
    console.error(`import failed, the database is as it was: ${error.message}`);
    process.exitCode = 1;
  } finally {
    d1.close();
  }
}
