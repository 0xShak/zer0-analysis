// AES-256-GCM authenticated encryption for secrets at rest (audit2.md L3).
//
// Used to wrap the per-user Polymarket CLOB L2 creds (tg_clob_api_creds) and
// the WalletConnect SignClient's stored session material (walletconnect_kv) so
// a leaked SUPABASE_SERVICE_KEY or a raw DB dump no longer hands an attacker
// order-submit credentials / live session keys. These rows are bot-only, so the
// CLOB_CREDS_ENC_KEY secret only needs to be set in the bot's environment.
//
// Envelope: "v1:" ‖ base64( iv(12) ‖ authTag(16) ‖ ciphertext ). The version
// prefix lets the scheme rotate later, and `isEncryptedSecret` lets readers stay
// back-compatible with any not-yet-migrated plaintext value.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../env';

const PREFIX = 'v1:';
const IV_LEN = 12;
const TAG_LEN = 16;

// Derive a 32-byte key from the configured secret so ops can set any
// sufficiently-random string (the security rests on that string's entropy —
// use a long random value). Throws (fail-closed) if the secret is unset.
function key(): Buffer {
  return createHash('sha256').update(env.CLOB_CREDS_ENC_KEY).digest();
}

export function isEncryptedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(envelope: string): string {
  if (!isEncryptedSecret(envelope)) {
    throw new Error('decryptSecret: not a v1 secret envelope');
  }
  const buf = Buffer.from(envelope.slice(PREFIX.length), 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
