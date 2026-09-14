// Moves the club from the Cloudflare worker to its own server. Runs on the
// maintainer's PC:
//
//   node server/migrate.mjs export   https://spbfi-reports.ogrebete.workers.dev C:\spbfi-move
//   node server/migrate.mjs freeze   https://spbfi-reports.ogrebete.workers.dev
//   node server/migrate.mjs unfreeze https://spbfi-reports.ogrebete.workers.dev
//
// Every request is signed with an Ed25519 key that only this PC holds
// (SPBFI_MIGRATE_KEY, or ~/.ssh/spbfi_migrate_ed25519.pem); the old worker
// knows the public half. The owner key and the other secrets never leave the
// old server. For each one it runs the first PBKDF2 rounds with a salt made
// here and hands back only that intermediate result; this PC runs the rest,
// and the new server keeps nothing but the final hash.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FIRST_ROUNDS = 10000, MORE_ROUNDS = 290000;

export function signedUrl(base, method, pathname, params, privateKey, now = Date.now()) {
  const url = new URL(pathname, base);
  const query = new URLSearchParams({ ...params, t: now }).toString();
  // The time is signed too, so a captured link stops working soon after.
  const signature = crypto.sign(null, Buffer.from(`${method} ${url.host}${url.pathname}?${query}`), privateKey);
  return `${url.origin}${url.pathname}?${query}&sig=${signature.toString('base64url')}`;
}

export function finishHash(firstB64u, saltB64u, first = FIRST_ROUNDS, more = MORE_ROUNDS) {
  const hash = crypto.pbkdf2Sync(Buffer.from(firstB64u, 'base64url'), Buffer.from(saltB64u, 'base64url'), more, 32, 'sha256');
  return `pbkdf2-sha256.${first}.${more}.${saltB64u}.${hash.toString('base64url')}`;
}

function migrationKey() {
  const given = process.env.SPBFI_MIGRATE_KEY;
  // The variable may hold the PEM itself or the path to it.
  const pem = given?.includes('-----BEGIN') ? given : fs.readFileSync(given || path.join(os.homedir(), '.ssh', 'spbfi_migrate_ed25519.pem'), 'utf8');
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the migration key must be an Ed25519 private key (PKCS8 PEM)');
  return key;
}

async function signedCall(base, method, pathname, params, key) {
  const response = await fetch(signedUrl(base, method, pathname, params, key), { method });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${pathname} answered ${response.status}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${method} ${pathname} answered ${response.status} with something other than JSON`);
  }
}

// systemd reads the env file line by line and gives quotes and backslashes a
// meaning of their own, so only plain values are written.
function envLine(name, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`the old server named a setting oddly: ${JSON.stringify(name).slice(0, 60)}`);
  const text = String(value);
  if (/[\r\n"'\\]/.test(text)) throw new Error(`the value of ${name} cannot go into an env file as it is`);
  return `${name}=${text}`;
}

async function exportClub(base, folder, key) {
  const dump = await signedCall(base, 'GET', '/migrate/export', {}, key);
  if (!Array.isArray(dump.docs)) throw new Error('the export has no docs array');
  const lines = [`# Club server settings exported from ${new URL(base).host} on ${new Date().toISOString()}. Hashes, not keys.`];
  const secrets = [];
  for (const [name, value] of Object.entries(dump.secrets || {})) {
    if (value === true) {
      const salt = crypto.randomBytes(16).toString('base64url');
      const { first } = await signedCall(base, 'GET', '/migrate/secret', { name, rounds: FIRST_ROUNDS, salt }, key);
      if (typeof first !== 'string' || Buffer.from(first, 'base64url').length !== 32) throw new Error(`/migrate/secret gave no usable result for ${name}`);
      lines.push(envLine(`${name}_HASH`, finishHash(first, salt)));
      secrets.push(name);
    } else if (typeof value === 'string' && value) {
      // The old server already holds only a hash; it moves as it is.
      lines.push(envLine(`${name}_HASH`, value));
      secrets.push(name);
    }
  }
  const settings = [];
  for (const [name, value] of Object.entries(dump.vars || {})) {
    if (value == null) continue;
    lines.push(envLine(name, value));
    settings.push(name);
  }
  if (dump.analytics_salt) {
    lines.push(envLine('ANALYTICS_SALT', crypto.randomBytes(24).toString('base64url')));
    settings.push('ANALYTICS_SALT');
  }

  fs.mkdirSync(folder, { recursive: true });
  // The export holds every member and the club's signing secret.
  fs.writeFileSync(path.join(folder, 'export.json'), JSON.stringify(dump), { mode: 0o600 });
  fs.writeFileSync(path.join(folder, 'club.env'), `${lines.join('\n')}\n`, { mode: 0o600 });

  // Names only: no value, no hash, nothing worth copying out of a terminal.
  const keys = dump.docs.map((row) => row?.key).filter((name) => typeof name === 'string');
  const frozen = dump.frozen ?? keys.includes('meta:frozen');
  console.log(`exported ${dump.docs.length} documents from ${new URL(base).host}`);
  console.log(`  keys:     ${keys.join(', ') || 'none'}`);
  console.log(`  frozen:   ${frozen ? 'yes' : 'no'}`);
  console.log(`  secrets:  ${secrets.join(', ') || 'none'} (written as hashes)`);
  console.log(`  settings: ${settings.join(', ') || 'none'}`);
  console.log(`wrote export.json and club.env to ${path.resolve(folder)}`);
  if (!frozen) console.log('note: the old server is not frozen, so marks made from now on stay there. For the switch itself, freeze first and export again.');
  for (const vital of ['vapid', 'club:secret']) {
    if (!keys.includes(vital)) console.error(`WARNING: ${vital} is missing from the export`);
  }
}

if (import.meta.main) {
  const [command, base, folder, ...extra] = process.argv.slice(2);
  const usage = () => {
    console.error('usage: node server/migrate.mjs export <base> <folder> | freeze <base> | unfreeze <base>');
    process.exit(2);
  };
  if (extra.length || !/^https?:\/\//.test(base || '')) usage();
  try {
    if (command === 'export' && folder) {
      await exportClub(base, folder, migrationKey());
    } else if ((command === 'freeze' || command === 'unfreeze') && !folder) {
      const result = await signedCall(base, 'POST', `/migrate/${command}`, {}, migrationKey());
      console.log(`${command}: ${JSON.stringify(result)}`);
    } else {
      usage();
    }
  } catch (error) {
    console.error(`migrate ${command} failed: ${error.message}`);
    process.exit(1);
  }
}
