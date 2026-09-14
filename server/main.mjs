// The club server: the worker (worker/spbfi-reports.js) on Node, with the
// club's data in one SQLite file. Caddy on the same machine takes HTTPS from
// the phones and hands requests to this process on 127.0.0.1.
//
//   SPBFI_DB=/var/lib/spbfi/club.sqlite PORT=8787 HOST=127.0.0.1 node server/main.mjs
//
// Secrets and settings come from the environment; systemd reads them from
// /etc/spbfi/env. server/http.mjs lists the names the worker is given.
import http from 'node:http';
import worker from '../worker/spbfi-reports.js';
import { createHandler, workerEnv } from './http.mjs';
import { SqliteD1 } from './sqlite-d1.mjs';

const file = process.env.SPBFI_DB || '/var/lib/spbfi/club.sqlite';
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';

// The same stages the worker reports in /club/health, for the start-up line.
function clubMode(env) {
  if (!env.CLUB_OWNER_KEY && !env.CLUB_OWNER_KEY_HASH) return 'off';
  const gate = String(env.CLUB_GATE || '').trim().toLowerCase();
  return gate === 'invite' || gate === 'closed' ? gate : 'test';
}

// One env and one database object serve every request: the worker keeps the
// VAPID key pair and the club secret in memory keyed by env.DB, and a fresh
// object per request would read them from the database every time.
const db = new SqliteD1(file);
const env = workerEnv(process.env, db);
const { handle, drain } = createHandler({ worker, env });
const server = http.createServer(handle);

// Caddy keeps an idle connection to us open for 30 s. Ours must outlast that:
// if Node closed first, it could drop a connection at the very moment Caddy
// sends a request on it, and that visitor would get a 502.
server.keepAliveTimeout = 35000;
server.headersTimeout = 40000;
server.requestTimeout = 60000;

// A promise nobody awaited must not take the club down along with every
// request in flight; systemd would restart the server, but those are lost.
process.on('unhandledRejection', (reason) => {
  console.error(`unhandled rejection: ${reason?.stack || reason}`);
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: finishing the requests and pushes in flight`);
  server.close();
  server.closeIdleConnections();
  // Pushes leave after the answer. systemd allows 25 s to stop, and up to 15
  // of them go to letting those pushes reach the phones.
  if (!(await drain(15000))) console.error('stopped without waiting any longer for requests or pushes (15 s)');
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

server.listen(port, host, () => {
  console.log(`spbfi club server on http://${host}:${port} (database ${file}, club ${clubMode(env)})`);
});
