// CTF Exchange V2 typed-data scaffolding.
//
// Kept separate from clob.ts so that the V2 type tables, the EIP-712 domain
// helper, and the ERC-7739 type-string builder can be imported by both the
// server-side builder and the wrap-1271 helper without dragging in the
// ClobClient/relay-signer module-state.
//
// Constants are verified against the installed @polymarket/clob-client-v2
// SDK config (`dist/order-utils/model/ctfExchangeV2TypedData.js`,
// `dist/config.js`). The CTF Exchange V2 and NegRisk CTF Exchange V2 share
// the same EIP-712 name/version; only the verifyingContract differs.

import { CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2 } from './contracts';

export const POLYGON_CHAIN_ID = 137;

export const V2_DOMAIN_NAME = 'Polymarket CTF Exchange';
export const V2_DOMAIN_VERSION = '2';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const BYTES32_ZERO =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

export const COLLATERAL_DECIMALS = 6;

// EIP-712 domain struct — used as `types.EIP712Domain` for the V2 Order
// payload and as the `name/version/chainId/verifyingContract/salt` portion
// of the ERC-7739 TypedDataSign wrapper.
export const EIP712_DOMAIN_STRUCT: ReadonlyArray<{ name: string; type: string }> = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

// The 11-field V2 Order struct that the CTF Exchange V2 contract hashes.
// V1's `taker`, `expiration`, `nonce`, `feeRateBps` are gone from the
// signed digest — they still appear in the wire body but are cosmetic.
export const V2_ORDER_STRUCT: ReadonlyArray<{ name: string; type: string }> = [
  { name: 'salt', type: 'uint256' },
  { name: 'maker', type: 'address' },
  { name: 'signer', type: 'address' },
  { name: 'tokenId', type: 'uint256' },
  { name: 'makerAmount', type: 'uint256' },
  { name: 'takerAmount', type: 'uint256' },
  { name: 'side', type: 'uint8' },
  { name: 'signatureType', type: 'uint8' },
  { name: 'timestamp', type: 'uint256' },
  { name: 'metadata', type: 'bytes32' },
  { name: 'builder', type: 'bytes32' },
];

// ERC-7739 nested TypedDataSign struct — only used when signatureType === 3
// (POLY_1271 / deposit wallet). The `contents` field is the Order being
// signed; the trailing five fields re-state the wrapping app's domain so
// the smart-contract wallet can verify it on-chain.
export const TYPED_DATA_SIGN_STRUCT: ReadonlyArray<{ name: string; type: string }> = [
  { name: 'contents', type: 'Order' },
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
  { name: 'salt', type: 'bytes32' },
];

export type TickSize = '0.1' | '0.01' | '0.001' | '0.0001';
export type SignatureTypeNum = 0 | 1 | 2 | 3;
export type WalletType = 'eoa' | 'proxy' | 'safe' | 'deposit_wallet';

export interface V2Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

export function exchangeDomainFor(negRisk: boolean): V2Domain {
  return {
    name: V2_DOMAIN_NAME,
    version: V2_DOMAIN_VERSION,
    chainId: POLYGON_CHAIN_ID,
    verifyingContract: negRisk ? NEG_RISK_CTF_EXCHANGE_V2 : CTF_EXCHANGE_V2,
  };
}

// The canonical ERC-7739 contentsType string. The wrapped signature appends
// this as UTF-8 bytes + a uint16 big-endian length, so it must match the
// Order struct byte-for-byte (no whitespace, no trailing comma).
export const V2_ORDER_TYPE_STRING =
  'Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)';

// The V2 Order in the form the EIP-712 hash sees: numeric `side`, no
// `taker`/`expiration` (those are cosmetic wire fields).
export interface V2OrderMessage {
  salt: string;
  maker: string;
  signer: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  side: 0 | 1;
  signatureType: SignatureTypeNum;
  timestamp: string;
  metadata: string;
  builder: string;
}
