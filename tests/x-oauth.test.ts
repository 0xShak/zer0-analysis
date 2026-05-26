// OAuth 1.0a signing is the one piece of the X integration that fails
// silently — a wrong signature surfaces only as a runtime 401 from the API.
// We pin it to the worked example X publishes in its "Creating a signature"
// docs, which exercises the whole risky core: RFC-3986 encoding (spaces, +,
// comma, !), parameter sorting, base-string assembly, HMAC-SHA1, base64.

import { describe, it, expect } from 'vitest';
import { oauthSignature, rfc3986 } from '@/lib/x/client';
import { clampTweet } from '@/lib/x/compose';

describe('rfc3986', () => {
  it('escapes the characters encodeURIComponent leaves alone', () => {
    expect(rfc3986('Ladies + Gentlemen')).toBe('Ladies%20%2B%20Gentlemen');
    expect(rfc3986("!*'()")).toBe('%21%2A%27%28%29');
    expect(rfc3986('a,b')).toBe('a%2Cb');
  });
  it('leaves the unreserved set (incl. ~) untouched', () => {
    expect(rfc3986('aZ09-_.~')).toBe('aZ09-_.~');
  });
});

describe('oauthSignature — X published vector', () => {
  it('reproduces the documented signature', () => {
    // https://developer.x.com/en/docs/authentication/oauth-1-0a/creating-a-signature
    const params = {
      status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
      include_entities: 'true',
      oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
      oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: '1318622958',
      oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      oauth_version: '1.0',
    };
    const sig = oauthSignature(
      'POST',
      'https://api.twitter.com/1.1/statuses/update.json',
      params,
      'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Y7zd',
      'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    );
    // HMAC-SHA1 of X's published base string with the published signing key.
    expect(sig).toBe('1weFOMIi3aYiJqLuIlqXIzDWkS8=');
  });
});

describe('clampTweet', () => {
  it('passes short text through, collapsing whitespace and stripping wrap quotes', () => {
    expect(clampTweet('  "hello   world"  ')).toBe('hello world');
  });
  it('never exceeds 280 characters', () => {
    const long = 'x'.repeat(500);
    const out = clampTweet(long);
    expect(out.length).toBeLessThanOrEqual(280);
    expect(out.endsWith('…')).toBe(true);
  });
});
