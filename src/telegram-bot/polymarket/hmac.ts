// Polymarket CLOB L2 HMAC — mirrors the V2 SDK's buildPolyHmacSignature.
//
// We re-implement here (rather than importing from the SDK's `signing/hmac`
// subpath) because the V2 package only exposes its root `index` as an
// official entry — subpath imports `@polymarket/clob-client-v2/signing/...`
// trigger the SDK's "no subpath" lockdown. Reproducing the function is
// 25 lines; tested against a reference vector in the unit tests.
//
// Canonical message:   timestamp + method + requestPath + body
// Key:                 base64url-decoded secret bytes
// Output:              base64url-encoded HMAC-SHA256

function decodeBase64Secret(secret: string): Uint8Array<ArrayBuffer> {
  const normalized = secret.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  // atob is available in Node >= 16 (we target >= 20 for crypto.subtle).
  const binary = atob(padded);
  // Allocate an ArrayBuffer-backed view so the subtle.importKey type
  // accepts it (Uint8Array<SharedArrayBuffer> is rejected on TS >=5.7).
  const buf = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes as Uint8Array<ArrayBuffer>;
}

export async function buildPolyHmacSignature(
  secret: string,
  timestampSec: string,
  method: string,
  requestPath: string,
  body?: string,
): Promise<string> {
  if (!secret) throw new Error('buildPolyHmacSignature: secret is empty');
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      'buildPolyHmacSignature: globalThis.crypto.subtle unavailable; requires Node >= 20',
    );
  }
  let message = timestampSec + method + requestPath;
  if (body !== undefined) message += body;
  const keyBytes = decodeBase64Secret(secret);
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  );
  const sigBytes = new Uint8Array(sigBuf);
  let binary = '';
  for (let i = 0; i < sigBytes.length; i++) {
    binary += String.fromCharCode(sigBytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_');
}
