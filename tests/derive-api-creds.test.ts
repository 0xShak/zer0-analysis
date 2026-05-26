import { describe, it, expect } from 'vitest';
import {
  buildClobAuthTypedData,
  deriveClobApiCreds,
  DeriveApiCredsError,
  type ClobAuthTypedData,
} from '@/telegram-bot/polymarket/derive-api-creds';

const EOA = '0x6816471e48a6b14df63d3e213d22b34497f8f331';
const SIG = '0x' + 'ab'.repeat(65);
const CREDS = { apiKey: 'key-uuid', secret: 'c2VjcmV0', passphrase: 'pass' };

/** A fetch stub that records each call and replays canned responses in order. */
function fetchStub(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[i++] ?? { status: 500, body: {} };
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('buildClobAuthTypedData', () => {
  it('builds the ClobAuth message bound to the given address', () => {
    const td = buildClobAuthTypedData({ address: EOA, timestampSec: 1700, nonce: 0 });
    expect(td.primaryType).toBe('ClobAuth');
    expect(td.domain).toEqual({ name: 'ClobAuthDomain', version: '1', chainId: 137 });
    // EIP712Domain must omit verifyingContract (ClobAuth's domain has none).
    expect(td.types.EIP712Domain.map((f) => f.name)).toEqual([
      'name',
      'version',
      'chainId',
    ]);
    expect(td.message).toEqual({
      address: EOA,
      timestamp: '1700',
      nonce: 0,
      message: 'This message attests that I control the given wallet',
    });
  });
});

describe('deriveClobApiCreds', () => {
  it('returns creds from a successful create and sends correct L1 headers', async () => {
    const { impl, calls } = fetchStub([{ status: 200, body: CREDS }]);
    let signedWith: ClobAuthTypedData | null = null;

    const creds = await deriveClobApiCreds({
      signerAddress: EOA,
      timestampSec: 1700,
      nonce: 0,
      fetchImpl: impl,
      signTypedData: async (td) => {
        signedWith = td;
        return SIG;
      },
    });

    expect(creds).toEqual(CREDS);
    // Only the create call was needed.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://clob.polymarket.com/auth/api-key');
    expect(calls[0].init?.method).toBe('POST');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.POLY_ADDRESS).toBe(EOA);
    expect(headers.POLY_SIGNATURE).toBe(SIG);
    expect(headers.POLY_TIMESTAMP).toBe('1700');
    expect(headers.POLY_NONCE).toBe('0');
    // The signed typed-data binds to the signer address.
    expect(signedWith!.message.address).toBe(EOA);
  });

  it('binds value.address + POLY_ADDRESS to exactly the address passed', async () => {
    // The key always binds to the connecting EOA — never the deposit wallet —
    // because L1 is ECDSA recovery and the EOA's sig recovers to the EOA.
    const { impl, calls } = fetchStub([{ status: 200, body: CREDS }]);
    let signedWith: ClobAuthTypedData | null = null;

    await deriveClobApiCreds({
      signerAddress: EOA,
      timestampSec: 42,
      fetchImpl: impl,
      signTypedData: async (td) => {
        signedWith = td;
        return SIG;
      },
    });

    expect(signedWith!.message.address).toBe(EOA);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.POLY_ADDRESS).toBe(EOA);
  });

  it('falls back to derive when create returns ok-but-empty', async () => {
    const { impl, calls } = fetchStub([
      { status: 200, body: {} },
      { status: 200, body: CREDS },
    ]);
    const creds = await deriveClobApiCreds({
      signerAddress: EOA,
      fetchImpl: impl,
      signTypedData: async () => SIG,
    });
    expect(creds).toEqual(CREDS);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('https://clob.polymarket.com/auth/derive-api-key');
    expect(calls[1].init?.method).toBe('GET');
  });

  it('falls back to derive when create errors', async () => {
    const { impl, calls } = fetchStub([
      { status: 400, body: { error: 'already exists' } },
      { status: 200, body: CREDS },
    ]);
    const creds = await deriveClobApiCreds({
      signerAddress: EOA,
      fetchImpl: impl,
      signTypedData: async () => SIG,
    });
    expect(creds).toEqual(CREDS);
    expect(calls).toHaveLength(2);
  });

  it('throws DeriveApiCredsError when both create and derive fail', async () => {
    const { impl } = fetchStub([
      { status: 400, body: { error: 'nope' } },
      { status: 401, body: { error: 'bad sig' } },
    ]);
    await expect(
      deriveClobApiCreds({
        signerAddress: EOA,
        fetchImpl: impl,
        signTypedData: async () => SIG,
      }),
    ).rejects.toBeInstanceOf(DeriveApiCredsError);
  });

  it('throws when derive returns incomplete creds', async () => {
    const { impl } = fetchStub([
      { status: 200, body: {} },
      { status: 200, body: { apiKey: 'k' } }, // missing secret/passphrase
    ]);
    await expect(
      deriveClobApiCreds({
        signerAddress: EOA,
        fetchImpl: impl,
        signTypedData: async () => SIG,
      }),
    ).rejects.toBeInstanceOf(DeriveApiCredsError);
  });
});
