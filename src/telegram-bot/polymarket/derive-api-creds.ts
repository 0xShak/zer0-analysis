// Derive a per-user Polymarket CLOB L2 API key over WalletConnect.
//
// WHY: Polymarket V2 binds every api-key to the address that signed L1, and the
// L2 POLY_ADDRESS header at order-post must carry that same bound address. The
// bot used to authenticate all users' orders with ONE shared relay key, so the
// CLOB rejected them with "the order signer address has to be the address of
// the api key". We fix that by deriving a key per user at /connect.
//
// The key binds to the connecting EOA — NOT to the order's `signer`. For
// sigType 1/2 those coincide; for a sigType-3 deposit wallet the order's signer
// is the contract, but the api-key (and POLY_ADDRESS) still belong to the EOA
// that owns it. This mirrors Polymarket's own SDK, which derives with the EOA
// signer and sends getSignerAddress(signer) = the EOA as POLY_ADDRESS for every
// signature type. L1 auth is plain ECDSA recovery, so binding to a contract
// address can't work anyway — the EOA's signature recovers to the EOA.
//
// The bot holds NO private key — it signs over WalletConnect — so we can't hand
// the V2 SDK an ethers/viem signer. Instead we reproduce the SDK's L1 auth flow
// by hand (same philosophy as post-order.ts): build Polymarket's ClobAuth
// EIP-712 message, get the user's wallet to sign it, assemble L1 headers, and
// call /auth/{api-key,derive-api-key} directly. The signing is injected
// (`signTypedData`) so the caller wires it to the EOA over WalletConnect.

import type { ApiCreds } from './post-order';

const DEFAULT_HOST = 'https://clob.polymarket.com';
const CREATE_PATH = '/auth/api-key';
const DERIVE_PATH = '/auth/derive-api-key';

// From @polymarket/clob-client-v2/dist/signing/constants.js — must match byte
// for byte; the CLOB recovers the signer from this exact message.
const MSG_TO_SIGN = 'This message attests that I control the given wallet';
const CLOB_AUTH_DOMAIN_NAME = 'ClobAuthDomain';
const CLOB_AUTH_DOMAIN_VERSION = '1';
const POLYGON_CHAIN_ID = 137;

// ClobAuth's EIP-712 domain has NO verifyingContract (unlike the Order domain),
// so its EIP712Domain struct lists only these three fields. eth_signTypedData_v4
// requires types.EIP712Domain to mirror the domain's actual fields exactly.
const CLOB_AUTH_DOMAIN_STRUCT = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
] as const;

export interface ClobAuthTypedData {
  domain: { name: string; version: string; chainId: number };
  primaryType: 'ClobAuth';
  types: {
    EIP712Domain: ReadonlyArray<{ name: string; type: string }>;
    ClobAuth: ReadonlyArray<{ name: string; type: string }>;
  };
  message: {
    address: string;
    timestamp: string;
    nonce: number;
    message: string;
  };
}

/** Builds Polymarket's ClobAuth typed-data, mirroring buildClobEip712Signature. */
export function buildClobAuthTypedData(args: {
  address: string;
  timestampSec: number;
  nonce?: number;
}): ClobAuthTypedData {
  return {
    domain: {
      name: CLOB_AUTH_DOMAIN_NAME,
      version: CLOB_AUTH_DOMAIN_VERSION,
      chainId: POLYGON_CHAIN_ID,
    },
    primaryType: 'ClobAuth',
    types: {
      EIP712Domain: CLOB_AUTH_DOMAIN_STRUCT,
      ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' },
      ],
    },
    message: {
      address: args.address,
      timestamp: args.timestampSec.toString(),
      nonce: args.nonce ?? 0,
      message: MSG_TO_SIGN,
    },
  };
}

export interface DeriveApiCredsArgs {
  /**
   * The address the api-key binds to AND the value.address in the ClobAuth
   * message. This is the EOA that actually signs (the connecting wallet) — the
   * recovered ECDSA signer must equal it. The L2 POLY_ADDRESS header at
   * order-post must later carry this same address.
   */
  signerAddress: string;
  /**
   * Signs the ClobAuth EIP-712 typed-data and returns the 65-byte ECDSA
   * signature as hex. Wired to requestEip712Sig over WalletConnect by the
   * caller, which decides which EOA actually signs.
   */
  signTypedData: (typedData: ClobAuthTypedData) => Promise<string>;
  /** L1 nonce; defaults to 0 (matches the SDK default). */
  nonce?: number;
  /** Unix seconds for the signature + POLY_TIMESTAMP. Defaults to now. */
  timestampSec?: number;
  fetchImpl?: typeof fetch;
  host?: string;
}

interface ApiKeyRaw {
  apiKey?: string;
  secret?: string;
  passphrase?: string;
}

export class DeriveApiCredsError extends Error {
  readonly status: number;
  readonly raw: string;
  constructor(status: number, raw: string) {
    super(`Polymarket CLOB rejected api-key derivation (${status}): ${raw}`);
    this.name = 'DeriveApiCredsError';
    this.status = status;
    this.raw = raw;
  }
}

/**
 * Derive (or create) the per-user L2 creds bound to `signerAddress`.
 *
 * Mirrors the SDK's createOrDeriveApiKey: POST /auth/api-key first (creates the
 * key, or returns the existing one), and if that yields no key, GET
 * /auth/derive-api-key (deterministic — same key for the same address every
 * time). The same L1 headers authenticate both calls.
 */
export async function deriveClobApiCreds(
  args: DeriveApiCredsArgs,
): Promise<ApiCreds> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const host = args.host ?? DEFAULT_HOST;
  const nonce = args.nonce ?? 0;
  const ts = args.timestampSec ?? Math.floor(Date.now() / 1000);

  const typedData = buildClobAuthTypedData({
    address: args.signerAddress,
    timestampSec: ts,
    nonce,
  });
  const signature = await args.signTypedData(typedData);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    POLY_ADDRESS: args.signerAddress,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: ts.toString(),
    POLY_NONCE: nonce.toString(),
  };

  // 1. Try create. A successful create returns the full creds; an "already
  //    exists" path may return ok-but-empty, in which case we derive below.
  const createRes = await fetchImpl(`${host}${CREATE_PATH}`, {
    method: 'POST',
    headers,
  });
  // NB: createText / deriveText are the raw L2 credential bodies
  // ({apiKey, secret, passphrase}) — never log them (audit2.md H-A).
  const createText = await createRes.text();
  if (createRes.ok) {
    const parsed = safeParse(createText);
    if (parsed?.apiKey && parsed.secret && parsed.passphrase) {
      return {
        apiKey: parsed.apiKey,
        secret: parsed.secret,
        passphrase: parsed.passphrase,
      };
    }
  }

  // 2. Fall back to derive (idempotent for an address that already has a key).
  const deriveRes = await fetchImpl(`${host}${DERIVE_PATH}`, {
    method: 'GET',
    headers,
  });
  const deriveText = await deriveRes.text();
  if (!deriveRes.ok) {
    throw new DeriveApiCredsError(deriveRes.status, deriveText);
  }
  const parsed = safeParse(deriveText);
  if (!parsed?.apiKey || !parsed.secret || !parsed.passphrase) {
    throw new DeriveApiCredsError(
      deriveRes.status,
      `derive returned incomplete creds: ${deriveText}`,
    );
  }
  return {
    apiKey: parsed.apiKey,
    secret: parsed.secret,
    passphrase: parsed.passphrase,
  };
}

function safeParse(text: string): ApiKeyRaw | null {
  try {
    return JSON.parse(text) as ApiKeyRaw;
  } catch {
    return null;
  }
}
