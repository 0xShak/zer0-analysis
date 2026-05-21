// ERC-7739 wrapping for ERC-1271 deposit-wallet signatures (signatureType 3).
//
// When the bot signs an Order under a deposit wallet, WalletConnect returns
// only the inner 65-byte ECDSA over the *TypedDataSign* digest. The deposit
// wallet's isValidSignature(hash, sig) on-chain expects a wrapped envelope
// so it can recover the original Order hash and re-verify the inner sig:
//
//   wrapped = innerSig (65)
//           ‖ APP_DOMAIN_SEPARATOR (32)   // V2 Exchange domain separator
//           ‖ contentsHash (32)            // hashStruct(Order)
//           ‖ contentsType (~186 bytes)   // UTF-8 type string
//           ‖ uint16_be(contentsType.length)  // 2 bytes
//
// This module is a pure function — no I/O — so it can be byte-diffed
// against the V2 SDK's own wrap in a unit test.

import { encodeAbiParameters, keccak256, toHex } from 'viem';
import {
  V2_DOMAIN_NAME,
  V2_DOMAIN_VERSION,
  V2_ORDER_TYPE_STRING,
  type V2Domain,
  type V2OrderMessage,
} from '../../lib/polymarket/types-v2';

const DOMAIN_TYPE_STRING =
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';

// Cached because they're constants under the V2 Exchange domain — the
// hashed name and version never change between calls.
const DOMAIN_TYPE_HASH = keccak256(toHex(DOMAIN_TYPE_STRING));
const ORDER_TYPE_HASH = keccak256(toHex(V2_ORDER_TYPE_STRING));
const CTF_EXCHANGE_NAME_HASH = keccak256(toHex(V2_DOMAIN_NAME));
const CTF_EXCHANGE_VERSION_HASH = keccak256(toHex(V2_DOMAIN_VERSION));

/**
 * EIP-712 domain separator for the V2 Exchange (or NegRisk Exchange) domain.
 * Cached only by callers; we don't cache here because verifyingContract
 * varies per market.
 */
export function appDomainSeparator(domain: V2Domain): `0x${string}` {
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
        DOMAIN_TYPE_HASH,
        CTF_EXCHANGE_NAME_HASH,
        CTF_EXCHANGE_VERSION_HASH,
        BigInt(domain.chainId),
        domain.verifyingContract as `0x${string}`,
      ],
    ),
  );
}

/**
 * hashStruct(Order) per EIP-712: keccak256(ORDER_TYPE_HASH ‖ ABI-encoded fields).
 */
export function orderContentsHash(order: V2OrderMessage): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' }, // type hash
        { type: 'uint256' }, // salt
        { type: 'address' }, // maker
        { type: 'address' }, // signer
        { type: 'uint256' }, // tokenId
        { type: 'uint256' }, // makerAmount
        { type: 'uint256' }, // takerAmount
        { type: 'uint8' }, // side
        { type: 'uint8' }, // signatureType
        { type: 'uint256' }, // timestamp
        { type: 'bytes32' }, // metadata
        { type: 'bytes32' }, // builder
      ],
      [
        ORDER_TYPE_HASH,
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

export interface WrapErc7739Args {
  /** Inner ECDSA signature returned by eth_signTypedData_v4 (with the 0x prefix). */
  innerSig: string;
  /** The Order being signed — used to compute contentsHash. */
  order: V2OrderMessage;
  /** The V2 Exchange domain the Order belongs to (negRisk-aware). */
  exchangeDomain: V2Domain;
  /**
   * The ERC-7739 contentsType string. Defaults to the canonical V2 Order
   * type string. Override only if you're testing alternate contents.
   */
  orderTypeString?: string;
}

/**
 * Wrap the inner ECDSA signature into the byte layout the deposit wallet's
 * isValidSignature expects. Returns a `0x`-prefixed hex string.
 *
 * Layout matches @polymarket/clob-client-v2 → ExchangeOrderBuilderV2 →
 * buildOrderSignature. Unit-test byte-equality before deploying.
 */
export function wrapErc7739Signature(args: WrapErc7739Args): string {
  const orderTypeString = args.orderTypeString ?? V2_ORDER_TYPE_STRING;
  const inner = stripHexPrefix(args.innerSig);
  const domainSep = stripHexPrefix(appDomainSeparator(args.exchangeDomain));
  const contentsHash = stripHexPrefix(orderContentsHash(args.order));
  // toHex returns 0x-prefixed UTF-8 bytes for a string input.
  const contentsTypeHex = stripHexPrefix(toHex(orderTypeString));
  const contentsTypeByteLen = byteLengthOfUtf8(orderTypeString);
  const lenHex = contentsTypeByteLen.toString(16).padStart(4, '0');
  return `0x${inner}${domainSep}${contentsHash}${contentsTypeHex}${lenHex}`;
}

function stripHexPrefix(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

function byteLengthOfUtf8(s: string): number {
  // Node's Buffer handles UTF-8 correctly. The V2 order type string is
  // pure ASCII so this is just s.length, but keep the path UTF-8-safe so
  // future contents (e.g. with non-ASCII field names) don't silently bug.
  return Buffer.byteLength(s, 'utf8');
}
