// Pins the L3 (audit2.md) at-rest encryption: AES-256-GCM round-trips, uses a
// fresh IV per call, authenticates (tamper => throw), and isEncryptedSecret
// gates the back-compat plaintext read path used during rollout.

process.env.CLOB_CREDS_ENC_KEY ??= 'test-only-encryption-key-do-not-use-in-prod';

import { describe, it, expect } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from '@/lib/crypto/secret-box';

describe('secret-box AES-256-GCM', () => {
  it('round-trips a secret', () => {
    const secret = 'poly-api-secret-abc123==';
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it('round-trips unicode + long values', () => {
    const s = '🔐 ' + 'x'.repeat(5000) + ' ünîcødé';
    expect(decryptSecret(encryptSecret(s))).toBe(s);
  });

  it('produces a v1 envelope that isEncryptedSecret recognizes', () => {
    const env = encryptSecret('hello');
    expect(env.startsWith('v1:')).toBe(true);
    expect(isEncryptedSecret(env)).toBe(true);
    expect(env).not.toContain('hello');
  });

  it('uses a fresh IV so the same plaintext encrypts differently', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('rejects a tampered envelope (auth tag)', () => {
    const env = encryptSecret('tamper-me');
    const raw = Buffer.from(env.slice('v1:'.length), 'base64');
    raw[raw.length - 1] ^= 0xff; // flip a real ciphertext byte
    const flipped = 'v1:' + raw.toString('base64');
    expect(() => decryptSecret(flipped)).toThrow();
  });

  it('isEncryptedSecret is false for plaintext (back-compat read path)', () => {
    expect(isEncryptedSecret('plain-text-api-key')).toBe(false);
    expect(isEncryptedSecret(null)).toBe(false);
    expect(() => decryptSecret('plain-text-api-key')).toThrow();
  });
});
