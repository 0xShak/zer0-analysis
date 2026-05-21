import { z } from 'zod';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX_NUMERIC = /^\d+$/;
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SignatureTypeEnum = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const PrepareBody = z.object({
  recommendationId: z.string().regex(UUID_V4, 'recommendationId must be uuid'),
  userAddress: z.string().regex(ADDRESS_RE, 'userAddress must be 0x… EVM address'),
  signatureType: SignatureTypeEnum,
  sizeOverrideUsd: z
    .number()
    .min(1, 'min $1')
    .max(100, 'max $100')
    .optional(),
});
export type PrepareBodyT = z.infer<typeof PrepareBody>;

// The CTF Exchange V2 Order struct + signature, in the shape Polymarket's
// CLOB V2 expects on the wire. The signed EIP-712 hash covers fewer fields
// than the wire body — `taker` and `expiration` are wire-only — but every
// field below is part of what we POST to `/order`. Shape only; CLOB will
// reject bad sigs.
export const SignedOrderShape = z.object({
  salt: z.union([z.string(), z.number()]),
  maker: z.string().regex(ADDRESS_RE),
  signer: z.string().regex(ADDRESS_RE),
  taker: z.string().regex(ADDRESS_RE),
  tokenId: z.string().regex(HEX_NUMERIC),
  makerAmount: z.string().regex(HEX_NUMERIC),
  takerAmount: z.string().regex(HEX_NUMERIC),
  side: z.union([z.literal('BUY'), z.literal('SELL')]),
  signatureType: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  timestamp: z.union([z.string(), z.number()]),
  expiration: z.union([z.string(), z.number()]),
  metadata: z.string().regex(BYTES32_RE, 'metadata must be 32-byte hex'),
  builder: z.string().regex(BYTES32_RE, 'builder must be 32-byte hex'),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/, 'signature must be hex'),
});
export type SignedOrderT = z.infer<typeof SignedOrderShape>;

export const SubmitBody = z.object({
  tradeId: z.string().regex(UUID_V4, 'tradeId must be uuid'),
  signedOrder: SignedOrderShape,
});
export type SubmitBodyT = z.infer<typeof SubmitBody>;
