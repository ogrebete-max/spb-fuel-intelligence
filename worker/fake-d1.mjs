// A stand-in for Cloudflare D1 in tests: real SQLite (node:sqlite) behind the
// calls the worker makes — prepare, bind, first, all, run, batch — with a
// small random delay before each, so requests running at once interleave the
// way they do over the network. A batch is one transaction, as in D1.
import { DatabaseSync } from 'node:sqlite';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Statement {
  constructor(d1, sql, params = []) {
    this.d1 = d1;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
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

export class FakeD1 {
  /**
   * @param {object} options
   * @param {number} options.latencyMs  upper bound of the random delay before each call
   * @param {(sql: string) => string|null} options.failure  a message to throw instead of running `sql`
   */
  constructor({ latencyMs = 4, failure = null } = {}) {
    this.db = new DatabaseSync(':memory:');
    this.latencyMs = latencyMs;
    this.failure = failure;
    // Committed document writes, the D1 counterpart of counting KV puts.
    this.docWrites = 0;
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  batch(statements) {
    return this.perform(statements, () => {
      this.db.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        this.db.exec('COMMIT');
        this.docWrites += statements.filter((statement) => /^INSERT INTO docs\b[\s\S]*DO UPDATE/.test(statement.sql)).length;
        return results;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async perform(statements, work) {
    if (this.latencyMs) await pause(Math.random() * this.latencyMs);
    for (const statement of statements) {
      const message = this.failure?.(statement.sql);
      if (message) throw new Error(message);
    }
    try {
      return work();
    } catch (error) {
      throw new Error(`D1_ERROR: ${error.message}`);
    }
  }
}
