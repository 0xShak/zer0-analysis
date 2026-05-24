// T2.3 — wrap-1271 byte-diff test (BLOCKING).
//
// Confirms that wrapErc7739Signature() produces the same byte layout that
// @polymarket/clob-client-v2 → ExchangeOrderBuilderV2 → buildOrderSignature
// emits for POLY_1271 (signatureType 3) orders.
//
// The SDK's wrap (exchangeOrderBuilderV2.js#180):
//   `0x${innerSig}${appDomainSep}${contentsHash}${toHex(ORDER_TYPE_STRING)}${lenHex}`
// where lenHex = 186 as big-endian uint16 = "00ba".
//
// We don't sign anything here — we use a synthetic innerSig and re-derive the
// other three bytes spans independently with viem to keep the test honest
// (i.e., a bug in our keccak math won't pass just because both sides import
// the same module).

import { describe, it, expect } from 'vitest';
import { encodeAbiParameters, keccak256, toHex } from 'viem';
import {
  wrapErc7739Signature,
  appDomainSeparator,
  orderContentsHash,
} from '@/telegram-bot/wc/wrap-1271';
import {
  V2_ORDER_TYPE_STRING,
  V2_DOMAIN_NAME,
  V2_DOMAIN_VERSION,
  POLYGON_CHAIN_ID,
  BYTES32_ZERO,
  type V2Domain,
  type V2OrderMessage,
} from '@/lib/polymarket/types-v2';
import { CTF_EXCHANGE_V2 } from '@/lib/polymarket/contracts';

// 65 bytes of synthetic ECDSA — r ‖ s ‖ v.
const FIXTURE_INNER_SIG =
  '0x' +
  '1111111111111111111111111111111111111111111111111111111111111111' +
  '2222222222222222222222222222222222222222222222222222222222222222' +
  '1b';

const FIXTURE_DOMAIN: V2Domain = {
  name: V2_DOMAIN_NAME,
  version: V2_DOMAIN_VERSION,
  chainId: POLYGON_CHAIN_ID,
  verifyingContract: CTF_EXCHANGE_V2,
};

// Deterministic, all fields set so encodeAbiParameters has no defaults to fill.
const FIXTURE_ORDER: V2OrderMessage = {
  salt: '12345678901234567890',
  maker: '0x000000000000000000000000000000000000aaaa',
  signer: '0x000000000000000000000000000000000000bbbb',
  tokenId:
    '71321045679252212594626385532706912750332728571942532289631379312455583992396',
  makerAmount: '1000000',
  takerAmount: '1818181',
  side: 0,
  signatureType: 3,
  timestamp: '1716508800',
  metadata: BYTES32_ZERO,
  builder: BYTES32_ZERO,
};

// ---- Reference math, derived from the SDK source verbatim ----

const SDK_DOMAIN_TYPE_HASH = keccak256(
  toHex(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
  ),
);
const SDK_ORDER_TYPE_HASH = keccak256(toHex(V2_ORDER_TYPE_STRING));
const SDK_NAME_HASH = keccak256(toHex(V2_DOMAIN_NAME));
const SDK_VERSION_HASH = keccak256(toHex(V2_DOMAIN_VERSION));

function sdkAppDomainSep(domain: V2Domain): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        SDK_DOMAIN_TYPE_HASH,
        SDK_NAME_HASH,
        SDK_VERSION_HASH,
        BigInt(domain.chainId),
        domain.verifyingContract as `0x${string}`,
      ],
    ),
  );
}

function sdkContentsHash(order: V2OrderMessage): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint8' },
        { type: 'uint8' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        SDK_ORDER_TYPE_HASH,
        BigInt(order.salt),
        order.maker as `0x${string}`,
        order.signer as `0x${string}`,
        BigInt(order.tokenId),
        BigInt(order.makerAmount),
        BigInt(order.takerAmount),
        order.side,
        order.signatureType,
        BigInt(order.timestamp),
        order.metadata as `0x${string}`,
        order.builder as `0x${string}`,
      ],
    ),
  );
}

describe('T2.3 — wrap-1271 ⭐ byte-diff vs SDK reference math', () => {
  it('appDomainSeparator matches the SDK formula bit-for-bit', () => {
    const ours = appDomainSeparator(FIXTURE_DOMAIN);
    const ref = sdkAppDomainSep(FIXTURE_DOMAIN);
    expect(ours).toBe(ref);
  });

  it('orderContentsHash matches the SDK formula bit-for-bit', () => {
    const ours = orderContentsHash(FIXTURE_ORDER);
    const ref = sdkContentsHash(FIXTURE_ORDER);
    expect(ours).toBe(ref);
  });

  it('V2_ORDER_TYPE_STRING is exactly 186 ASCII bytes (SDK hardcodes that length)', () => {
    expect(Buffer.byteLength(V2_ORDER_TYPE_STRING, 'utf8')).toBe(186);
    // The SDK literally writes `186 .toString(16).padStart(4, "0")` for lenHex,
    // so any drift in our type string will desync the on-chain length field.
    expect((186).toString(16).padStart(4, '0')).toBe('00ba');
  });

  it('wrapErc7739Signature produces the exact SDK byte layout', () => {
    const appDomainSep = sdkAppDomainSep(FIXTURE_DOMAIN);
    const contentsHash = sdkContentsHash(FIXTURE_ORDER);
    const contentsTypeHex = toHex(V2_ORDER_TYPE_STRING);
    const lenHex = '00ba';

    const expected =
      '0x' +
      FIXTURE_INNER_SIG.slice(2) +
      appDomainSep.slice(2) +
      contentsHash.slice(2) +
      contentsTypeHex.slice(2) +
      lenHex;

    const actual = wrapErc7739Signature({
      innerSig: FIXTURE_INNER_SIG,
      order: FIXTURE_ORDER,
      exchangeDomain: FIXTURE_DOMAIN,
    });

    expect(actual).toBe(expected);
  });

  it('wrapped output is exactly 65+32+32+186+2 = 317 bytes', () => {
    const wrapped = wrapErc7739Signature({
      innerSig: FIXTURE_INNER_SIG,
      order: FIXTURE_ORDER,
      exchangeDomain: FIXTURE_DOMAIN,
    });
    const hex = wrapped.slice(2);
    expect(hex.length).toBe((65 + 32 + 32 + 186 + 2) * 2);
  });

  it('different verifyingContract → different appDomainSep → different wrap', () => {
    const negRiskDomain: V2Domain = {
      ...FIXTURE_DOMAIN,
      verifyingContract: '0xe2222d279d744050d28e00520010520000310F59',
    };
    const a = wrapErc7739Signature({
      innerSig: FIXTURE_INNER_SIG,
      order: FIXTURE_ORDER,
      exchangeDomain: FIXTURE_DOMAIN,
    });
    const b = wrapErc7739Signature({
      innerSig: FIXTURE_INNER_SIG,
      order: FIXTURE_ORDER,
      exchangeDomain: negRiskDomain,
    });
    expect(a).not.toBe(b);
  });
});
