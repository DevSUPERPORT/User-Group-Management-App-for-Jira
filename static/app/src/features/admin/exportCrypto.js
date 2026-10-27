// Passphrase encryption for data exports, done entirely in the browser with the
// Web Crypto API: the passphrase and the plain data never leave the admin's
// browser. AES-256-GCM encrypts and authenticates the data; the key comes from
// the passphrase via PBKDF2-SHA-256 with a random salt. The file header (format,
// algorithm, salt, IV, iterations) is bound as additional authenticated data, so
// changing any byte of the file makes decryption fail.

export const ENVELOPE_FORMAT = 'superport-gum-export-encrypted';
export const ENVELOPE_VERSION = 1;
export const MIN_PASSPHRASE = 12;
// OWASP's recommendation for PBKDF2-HMAC-SHA256.
export const ITERATIONS = 600_000;
const MAX_ITERATIONS = 10_000_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export class ExportCryptoError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text) {
  if (typeof text !== 'string') throw new ExportCryptoError('invalid');
  let s;
  try {
    s = atob(text);
  } catch {
    throw new ExportCryptoError('invalid');
  }
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function checkPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || [...passphrase].length < MIN_PASSPHRASE) throw new ExportCryptoError('weak');
}

async function deriveKey(passphrase, salt, iterations, usage) {
  const material = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

// The header fields in a fixed order; these exact bytes are authenticated.
function headerBytes(h) {
  return enc.encode(JSON.stringify([h.format, h.version, h.cipher, h.kdf.name, h.kdf.hash, h.kdf.iterations, h.kdf.salt, h.iv]));
}

export async function encryptExport(data, passphrase) {
  checkPassphrase(passphrase);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const header = {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    cipher: 'AES-256-GCM',
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: toBase64(salt) },
    iv: toBase64(iv),
  };
  const key = await deriveKey(passphrase, salt, ITERATIONS, 'encrypt');
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: headerBytes(header), tagLength: 128 }, key, enc.encode(JSON.stringify(data)));
  return JSON.stringify({ ...header, data: toBase64(new Uint8Array(cipher)) });
}

/** Parses the file and checks the header; throws ExportCryptoError('notEncrypted' | 'invalid'). */
export function readEnvelope(text) {
  let env;
  try {
    env = JSON.parse(text);
  } catch {
    throw new ExportCryptoError('invalid');
  }
  if (env && env.format === 'superport-gum-export') throw new ExportCryptoError('notEncrypted');
  const k = env?.kdf;
  const valid =
    env &&
    env.format === ENVELOPE_FORMAT &&
    env.version === ENVELOPE_VERSION &&
    env.cipher === 'AES-256-GCM' &&
    k?.name === 'PBKDF2' &&
    k.hash === 'SHA-256' &&
    Number.isInteger(k.iterations) &&
    // Never accept a weakened key derivation, even in a file that otherwise looks right.
    k.iterations >= ITERATIONS &&
    k.iterations <= MAX_ITERATIONS &&
    typeof k.salt === 'string' &&
    typeof env.iv === 'string' &&
    typeof env.data === 'string';
  if (!valid) throw new ExportCryptoError('invalid');
  if (fromBase64(k.salt).length !== SALT_BYTES || fromBase64(env.iv).length !== IV_BYTES) throw new ExportCryptoError('invalid');
  return env;
}

/** Throws ExportCryptoError('wrongPassphrase') when the passphrase is wrong or any byte of the file was changed. */
export async function decryptExport(env, passphrase) {
  if (typeof passphrase !== 'string' || !passphrase) throw new ExportCryptoError('wrongPassphrase');
  const key = await deriveKey(passphrase, fromBase64(env.kdf.salt), env.kdf.iterations, 'decrypt');
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(env.iv), additionalData: headerBytes(env), tagLength: 128 }, key, fromBase64(env.data));
  } catch {
    throw new ExportCryptoError('wrongPassphrase');
  }
  try {
    return JSON.parse(dec.decode(plain));
  } catch {
    throw new ExportCryptoError('invalid');
  }
}
