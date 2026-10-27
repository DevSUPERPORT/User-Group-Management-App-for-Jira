import test from 'node:test';
import assert from 'node:assert/strict';
import { ENVELOPE_FORMAT, ITERATIONS, decryptExport, encryptExport, readEnvelope } from '../static/app/src/features/admin/exportCrypto.js';

const PASS = 'correct horse battery staple';
const DATA = { format: 'superport-gum-export', version: 1, kvs: [{ key: 'config', value: { retentionMonths: 24 } }], audit: [{ id: 'a1', actorName: 'Jürgen Müller' }] };

const reasonOf = async (fn) => {
  try {
    await fn();
  } catch (e) {
    return e.reason ?? e.message;
  }
  return null;
};

test('export encryption: AES-256-GCM round trip, nothing readable in the file', async () => {
  const text = await encryptExport(DATA, PASS);
  const env = JSON.parse(text);
  assert.equal(env.format, ENVELOPE_FORMAT);
  assert.equal(env.cipher, 'AES-256-GCM');
  assert.deepEqual({ name: env.kdf.name, hash: env.kdf.hash, iterations: env.kdf.iterations }, { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS });
  assert.ok(ITERATIONS >= 600_000);
  // No plain data anywhere in the file.
  for (const secret of ['retentionMonths', 'Jürgen', 'config', 'superport-gum-export"']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(await decryptExport(readEnvelope(text), PASS), DATA);
});

test('export encryption: fresh salt and IV every time', async () => {
  const a = JSON.parse(await encryptExport(DATA, PASS));
  const b = JSON.parse(await encryptExport(DATA, PASS));
  assert.notEqual(a.kdf.salt, b.kdf.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.data, b.data);
});

test('export encryption: wrong passphrase and any tampering fail', async () => {
  const text = await encryptExport(DATA, PASS);
  assert.equal(await reasonOf(() => decryptExport(readEnvelope(text), 'correct horse battery stapl')), 'wrongPassphrase');
  assert.equal(await reasonOf(() => decryptExport(readEnvelope(text), '')), 'wrongPassphrase');

  const env = JSON.parse(text);
  const bytes = Uint8Array.from(atob(env.data), (c) => c.charCodeAt(0));
  bytes[5] ^= 1;
  const flipped = { ...env, data: btoa(String.fromCharCode(...bytes)) };
  assert.equal(await reasonOf(() => decryptExport(readEnvelope(JSON.stringify(flipped)), PASS)), 'wrongPassphrase');

  // The header is authenticated too: a higher iteration count (still allowed) must not decrypt.
  const header = { ...env, kdf: { ...env.kdf, iterations: env.kdf.iterations + 1 } };
  assert.equal(await reasonOf(() => decryptExport(readEnvelope(JSON.stringify(header)), PASS)), 'wrongPassphrase');
});

test('export encryption: weak passphrases, plain files and weakened settings are refused', async () => {
  assert.equal(await reasonOf(() => encryptExport(DATA, 'short')), 'weak');
  assert.equal(await reasonOf(() => encryptExport(DATA, '12345678901')), 'weak');
  assert.equal(await reasonOf(async () => readEnvelope(JSON.stringify(DATA))), 'notEncrypted');
  assert.equal(await reasonOf(async () => readEnvelope('not json')), 'invalid');

  const env = JSON.parse(await encryptExport(DATA, PASS));
  const variants = [
    { ...env, kdf: { ...env.kdf, iterations: 1000 } },
    { ...env, kdf: { ...env.kdf, hash: 'SHA-1' } },
    { ...env, cipher: 'AES-128-CBC' },
    { ...env, iv: btoa('short') },
    { ...env, version: 2 },
  ];
  for (const v of variants) assert.equal(await reasonOf(async () => readEnvelope(JSON.stringify(v))), 'invalid');
});
