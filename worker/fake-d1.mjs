// A stand-in for Cloudflare D1 in tests: the club server's own SQLite database
// (server/sqlite-d1.mjs) behind the calls the worker makes — prepare, bind,
// first, all, run, batch — with a small random delay before each, so requests
// running at once interleave the way they do over the network. A batch is one
// transaction, as in D1.
//
// SPBFI_D1_FILE=1 keeps every database in a temporary file with a write-ahead
// log instead of memory, so the whole worker suite can run on files the way
// the club server does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteD1 } from '../server/sqlite-d1.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let folder = null;
let made = 0;
const onDisk = new Set();

function databaseFile() {
  if (!folder) {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'spbfi-d1-'));
    process.once('exit', removeFiles);
  }
  made += 1;
  return path.join(folder, `d1-${made}.sqlite`);
}

function removeFiles() {
  // Windows cannot delete a file that is still open, so close them all first.
  for (const d1 of onDisk) {
    try {
      d1.close();
    } catch {
      // Already closed.
    }
  }
  try {
    fs.rmSync(folder, { recursive: true, force: true });
  } catch (error) {
    // Windows may hold a file a moment longer (an antivirus scan, say). A
    // leftover folder in the temp directory is not worth failing a test for.
    if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) console.error(`could not remove ${folder}: ${error.message}`);
  }
}

export class FakeD1 extends SqliteD1 {
  /**
   * @param {object} options
   * @param {number} options.latencyMs  upper bound of the random delay before each call
   * @param {(sql: string) => string|null} options.failure  a message to throw instead of running `sql`
   */
  constructor({ latencyMs = 4, failure = null } = {}) {
    const inFile = process.env.SPBFI_D1_FILE === '1';
    super(inFile ? databaseFile() : ':memory:');
    if (inFile) onDisk.add(this);
    // It stands in for Cloudflare D1, and the worker should report it as such.
    this.kind = 'd1';
    this.latencyMs = latencyMs;
    this.failure = failure;
    // Committed document writes, the D1 counterpart of counting KV puts.
    this.docWrites = 0;
  }

  async batch(statements) {
    const results = await super.batch(statements);
    this.docWrites += statements.filter((statement) => /^INSERT INTO docs\b[\s\S]*DO UPDATE/.test(statement.sql)).length;
    return results;
  }

  async perform(statements, work) {
    if (this.latencyMs) await pause(Math.random() * this.latencyMs);
    for (const statement of statements) {
      // Thrown as given, not wrapped: a test spells out the exact error D1 reports.
      const message = this.failure?.(statement.sql);
      if (message) throw new Error(message);
    }
    return super.perform(statements, work);
  }
}
