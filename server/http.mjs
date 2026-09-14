// Serves the worker (worker/spbfi-reports.js) from a Node http server the way
// Cloudflare runs it: each request becomes a fetch Request and the answer a
// Response, work handed to ctx.waitUntil goes on after the answer, and the
// visitor's address arrives as CF-Connecting-IP.
import { Buffer } from 'node:buffer';

// The settings and secrets the worker reads. Nothing else from the process
// environment reaches it: PATH, HOME and the rest are none of its business.
const WORKER_SETTINGS = [
  'CLUB_OWNER_KEY', 'CLUB_OWNER_KEY_HASH', 'CLUB_GATE', 'CLUB_READER_KEY', 'CLUB_READER_KEY_HASH',
  'GROUP_KEY', 'GROUP_KEY_HASH', 'ANALYTICS_ADMIN_KEY', 'ANALYTICS_ADMIN_KEY_HASH', 'ANALYTICS_SALT', 'ORIGIN',
];

// These describe the connection from Caddy, not the visitor's request.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'expect']);
const SAFE_HOST = /^[A-Za-z0-9.\-:\[\]]+$/;
const BODYLESS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function workerEnv(source, db) {
  const env = { DB: db };
  for (const name of WORKER_SETTINGS) {
    // A line such as `CLUB_GATE=` in the env file means "not set".
    if (source[name] != null && source[name] !== '') env[name] = source[name];
  }
  return env;
}

function peerAddress(req) {
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function isLoopback(address) {
  return address === '::1' || address.startsWith('127.');
}

export function clientAddress(req) {
  const peer = peerAddress(req);
  const forwarded = req.headers['x-forwarded-for'];
  // Only Caddy on this machine may say who the visitor is. It puts the address
  // it saw last, and that is the one entry a visitor cannot forge; anyone
  // reaching the port directly is taken at their socket address.
  if (isLoopback(peer) && forwarded) {
    const last = String(forwarded).split(',').pop().trim().replace(/^::ffff:/, '');
    if (last) return last;
  }
  return peer;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

// Keeps at most `limit` bytes, but reads the request to its end either way: an
// answer sent while the client is still uploading reaches it as a reset
// connection instead of a readable 413.
async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
    else chunks.length = 0;
  }
  return size > limit ? null : Buffer.concat(chunks);
}

function finished(res) {
  if (res.writableFinished || res.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    res.once('finish', resolve);
    res.once('close', resolve);
  });
}

export function createHandler({ worker, env, maxBodyBytes = 256 * 1024, settle = false, log = console }) {
  const background = new Set();
  const waiting = new Set();
  let inFlight = 0;

  const idle = () => inFlight === 0 && background.size === 0;
  const wakeDrain = () => {
    if (idle()) for (const resolve of waiting) resolve(true);
  };

  // Pushes go out after the answer, as on Cloudflare. Their failures are
  // logged: nobody is waiting for them, and a phone that missed a push cannot
  // tell anyone.
  function track(promise) {
    const task = Promise.resolve(promise)
      .catch((error) => log.error(`background task failed: ${error?.stack || error}`))
      .finally(() => {
        background.delete(task);
        wakeDrain();
      });
    background.add(task);
    return task;
  }

  async function serve(req, res) {
    // A path only: an absolute URL or CONNECT asks for a proxy, and this is not one.
    if (!String(req.url).startsWith('/')) {
      req.resume();
      return sendJson(res, 400, { error: 'bad_request' });
    }
    const body = await readBody(req, maxBodyBytes);
    if (body === null) return sendJson(res, 413, { error: 'body_too_large' });

    const proxied = isLoopback(peerAddress(req));
    const scheme = proxied && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const host = SAFE_HOST.test(req.headers.host || '') ? req.headers.host : 'localhost';
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      // A visitor could send CF-Connecting-IP of their choosing; only the address worked out here counts.
      if (HOP_BY_HOP.has(name) || name === 'cf-connecting-ip') continue;
      for (const item of [value].flat()) headers.append(name, item);
    }
    headers.set('cf-connecting-ip', clientAddress(req));
    let request;
    try {
      request = new Request(`${scheme}://${host}${req.url}`, { method: req.method, headers, body: BODYLESS.has(req.method) ? undefined : body });
    } catch {
      // A method fetch refuses to carry, such as TRACE: the visitor's mistake, not ours.
      return sendJson(res, 400, { error: 'bad_request' });
    }

    const mine = [];
    const ctx = {
      waitUntil: (promise) => mine.push(track(promise)),
      passThroughOnException() {},
    };
    const response = await worker.fetch(request, typeof env === 'function' ? env() : env, ctx);
    // Tests read what a request changed as soon as its answer arrives.
    if (settle) while (mine.length) await Promise.all(mine.splice(0));

    const bytes = Buffer.from(await response.arrayBuffer());
    const out = {};
    for (const [name, value] of response.headers) {
      if (name === 'content-length' || HOP_BY_HOP.has(name)) continue;
      out[name] = name === 'set-cookie' ? response.headers.getSetCookie() : value;
    }
    if (response.status !== 204 && response.status !== 304) out['content-length'] = bytes.length;
    res.writeHead(response.status, out);
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }

  async function handle(req, res) {
    inFlight += 1;
    try {
      await serve(req, res);
    } catch (error) {
      // A visitor who went away mid-request needs neither an answer nor a log line.
      const gone = error?.code === 'ECONNRESET';
      // The query string stays out of the log: it may carry a signature or a code.
      if (!gone) log.error(`${req.method} ${String(req.url).split('?')[0]}: ${error?.stack || error}`);
      if (!gone && !res.headersSent && !res.destroyed) sendJson(res, 500, { error: 'server_error' });
      else res.destroy();
    } finally {
      await finished(res);
      inFlight -= 1;
      wakeDrain();
    }
  }

  // Resolves true once no request is in flight and no background task is
  // left, or false when `ms` run out first.
  function drain(ms) {
    if (idle()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer);
        waiting.delete(done);
        resolve(value);
      };
      const timer = setTimeout(() => done(false), ms);
      waiting.add(done);
    });
  }

  return { handle, drain };
}
