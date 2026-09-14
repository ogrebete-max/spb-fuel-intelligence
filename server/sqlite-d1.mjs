// The club's database on its own server: SQLite through node:sqlite, behind
// the calls the worker makes of Cloudflare D1 — prepare, bind, first, all,
// run, batch. The worker was written for D1 and runs on this unchanged.
//
// node:sqlite is synchronous, so a batch runs from BEGIN to COMMIT without any
// other request getting in between: one transaction, as in D1.
import { DatabaseSync } from 'node:sqlite';

class Statement {
  constructor(d1, sql, params = []) {
    this.d1 = d1;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    // D1 refuses undefined rather than storing NULL. Refusing it here too keeps
    // a mistake that would break on Cloudflare from passing on the server.
    if (params.some((value) => value === undefined)) throw new TypeError("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
    return new Statement(this.d1, this.sql, params);
  }

  execute() {
    const statement = this.d1.db.prepare(this.sql);
    if (statement.columns().length) return { success: true, results: statement.all(...this.params), meta: { changes: 0 } };
    const info = statement.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }

  all() {
    return this.d1.perform([this], () => this.execute());
  }

  run() {
    return this.all();
  }

  async first(column) {
    const row = (await this.all()).results[0];
    if (!row) return null;
    return column ? row[column] : row;
  }
}

export class SqliteD1 {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    // The worker names its storage in /club/health, so one look at it tells
    // which kind of database is answering.
    this.kind = 'sqlite';
    // Another connection, such as the nightly copy, may hold a lock for a
    // moment; waiting for it beats failing a member's request.
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (file !== ':memory:' && file !== '') {
      // With a write-ahead log the nightly copy reads while the server writes.
      this.db.exec('PRAGMA journal_mode = WAL');
      // WAL on its own may lose the last commits in a power cut. FULL syncs
      // every commit, so a member who was told "you are in" stays in.
      this.db.exec('PRAGMA synchronous = FULL');
    }
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  batch(statements) {
    return this.perform(statements, () => {
      // IMMEDIATE takes the write lock before the first statement, so a busy
      // database is waited for up front instead of failing halfway through.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => statement.execute());
        this.db.exec('COMMIT');
        return results;
      } catch (error) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  /** Every call goes through here, so a test stand-in can add delays and failures in one place. */
  async perform(statements, work) {
    try {
      return work();
    } catch (error) {
      // D1 reports SQLite's own message behind this prefix, and the worker
      // reads it: a write based on a stale version fails a CHECK constraint.
      throw new Error(`D1_ERROR: ${error.message}`);
    }
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }
}
