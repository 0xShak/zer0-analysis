import { z } from 'zod';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX_NUMERIC = /^\d+$/;
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

// The CTF Exchange Order struct + signature, as returned by signTypedData
// on the frontend. We validate shape only — CLOB will reject bad sigs.
export const SignedOrderShape = z.object({
  salt: z.union([z.string(), z.number()]),
  maker: z.string().regex(ADDRESS_RE),
  signer: z.string().regex(ADDRESS_RE),
  taker: z.string().regex(ADDRESS_RE),
  tokenId: z.string().regex(HEX_NUMERIC),
  makerAmount: z.string().regex(HEX_NUMERIC),
  takerAmount: z.string().regex(HEX_NUMERIC),
  expiration: z.union([z.string(), z.number()]),
  nonce: z.union([z.string(), z.number()]),
  feeRateBps: z.union([z.string(), z.number()]),
  side: z.union([z.literal('BUY'), z.literal('SELL'), z.literal(0), z.literal(1)]),
  signatureType: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/, 'signature must be hex'),
});
export type SignedOrderT = z.infer<typeof SignedOrderShape>;

export const SubmitBody = z.object({
  tradeId: z.string().regex(UUID_V4, 'tradeId must be uuid'),
  signedOrder: SignedOrderShape,
});
export type SubmitBodyT = z.infer<typeof SubmitBody>;
