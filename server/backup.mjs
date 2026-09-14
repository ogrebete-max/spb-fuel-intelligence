// A copy of the club database, checked before it counts.
//
//   SPBFI_DB=/var/lib/spbfi/club.sqlite SPBFI_BACKUPS=/var/lib/spbfi/backups node server/backup.mjs [--label before-import]
//
// VACUUM INTO writes a consistent snapshot while the server goes on writing
// (the database keeps a write-ahead log). The copy must pass integrity_check
// before it is renamed into place, so a file called club-YYYY-MM-DD.sqlite is
// always a whole database. Daily copies older than two weeks are deleted;
// labelled ones, made by hand before a risky step, stay until someone
// deletes them.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY = /^club-(\d{4}-\d{2}-\d{2})\.sqlite$/;

function inspect(file) {
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    const verdict = copy.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row)[0]);
    if (verdict.join() !== 'ok') throw new Error(`the copy failed integrity_check: ${verdict.slice(0, 5).join('; ')}`);
    // A server that has not answered a request yet has no tables; its copy is still a good copy.
    const table = copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'docs'").get();
    return table ? copy.prepare('SELECT COUNT(*) AS n FROM docs').get().n : 0;
  } finally {
    copy.close();
  }
}

export function backup({ file, dir, keepDays = 14, now = new Date(), label = null }) {
  // Opening a missing file would create an empty database and back that up.
  if (!fs.existsSync(file)) throw new Error(`no database at ${file}`);
  if (label !== null && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(label)) throw new Error(`a label is one word of letters, digits and dashes, not ${JSON.stringify(label)}`);
  fs.mkdirSync(dir, { recursive: true });
  const name = label
    ? `club-${label}-${now.toISOString().replaceAll(':', '')}.sqlite`
    : `club-${now.toISOString().slice(0, 10)}.sqlite`;
  const target = path.join(dir, name);
  const partial = `${target}.partial`;
  // VACUUM INTO refuses to write over a file, such as one left by a copy that crashed.
  fs.rmSync(partial, { force: true });

  // Read-only, so that making a copy can never change the original.
  const source = new DatabaseSync(file, { readOnly: true });
  try {
    source.exec('PRAGMA busy_timeout = 5000');
    source.prepare('VACUUM INTO ?').run(partial);
  } finally {
    source.close();
  }

  let docs;
  try {
    docs = inspect(partial);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  // The copy holds every member and the club's signing secret: for the owner's eyes only.
  fs.chmodSync(partial, 0o600);
  fs.renameSync(partial, target);

  const today = Date.parse(now.toISOString().slice(0, 10));
  for (const entry of fs.readdirSync(dir)) {
    const day = DAILY.exec(entry)?.[1];
    if (day && today - Date.parse(day) >= keepDays * DAY_MS) fs.rmSync(path.join(dir, entry), { force: true });
  }
  return { target, docs };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--label');
  const label = at === -1 ? null : args[at + 1];
  if ((at !== -1 && !label) || args.length !== (at === -1 ? 0 : 2)) {
    console.error('usage: node server/backup.mjs [--label <word>]');
    process.exit(2);
  }
  try {
    const { target, docs } = backup({
      file: process.env.SPBFI_DB || '/var/lib/spbfi/club.sqlite',
      dir: process.env.SPBFI_BACKUPS || '/var/lib/spbfi/backups',
      label,
    });
    console.log(`backup ${target}: ${docs} documents, integrity ok`);
  } catch (error) {
    console.error(`backup failed: ${error.message}`);
    process.exit(1);
  }
}
