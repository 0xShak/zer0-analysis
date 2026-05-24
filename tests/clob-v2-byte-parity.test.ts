// T1.3 — ⭐ ERC-7739 byte-parity end-to-end test (BLOCKING).
//
// Builds the same Order two ways:
//   (a) @polymarket/clob-client-v2 → ExchangeOrderBuilderV2.buildSignedOrder()
//   (b) our clob.ts buildTypedData() → ethers v5 _signTypedData → wrap-1271
//
// With identical inputs (same private key, same salt, same timestamp, same
// maker/signer/amounts) the two `.signature` strings MUST be byte-identical.
// If they diverge, fall back to the SDK's createOrder with a WC signer
// adapter per the spec — do NOT ship a divergent wrap.
//
// We only test the POLY_1271 (signatureType 3) path here because that's the
// one with the ERC-7739 wrap layer. The non-1271 paths are plain EIP-712 and
// don't have a custom wrap.

import { describe, it, expect, beforeAll } from 'vitest';
import { Wallet } from 'ethers';
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { buildTypedData } from '@/lib/polymarket/clob';

// The V2 SDK's `package.json` exports field only exposes the package's
// single entry point — ExchangeOrderBuilderV2 is internal. We deliberately
// reach into the on-disk dist via a file:// URL because the *whole point*
// of this test is to compare against the SDK's actual implementation, not
// a re-derivation of it. Static `import` from a subpath fails the exports
// gate; dynamic `import(fileURL)` does not.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ExchangeOrderBuilderV2: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let SignatureTypeV2: any;

beforeAll(async () => {
  const builderPath = pathToFileURL(
    resolvePath(
      'node_modules/@polymarket/clob-client-v2/dist/order-utils/exchangeOrderBuilderV2.js',
    ),
  ).href;
  const sigTypePath = pathToFileURL(
    resolvePath(
      'node_modules/@polymarket/clob-client-v2/dist/order-utils/model/signatureTypeV2.js',
    ),
  ).href;
  const builderMod = await import(/* @vite-ignore */ builderPath);
  const sigTypeMod = await import(/* @vite-ignore */ sigTypePath);
  ExchangeOrderBuilderV2 = builderMod.ExchangeOrderBuilderV2;
  SignatureTypeV2 = sigTypeMod.SignatureTypeV2;
});
import {
  V2_DOMAIN_NAME,
  V2_DOMAIN_VERSION,
  V2_ORDER_STRUCT,
  TYPED_DATA_SIGN_STRUCT,
  POLYGON_CHAIN_ID,
  exchangeDomainFor,
  type V2OrderMessage,
} from '@/lib/polymarket/types-v2';
import { wrapErc7739Signature } from '@/telegram-bot/wc/wrap-1271';

const TEST_PRIVATE_KEY =
  '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

// A deposit-wallet address (acts as maker AND signer for POLY_1271).
const DEPOSIT_WALLET = '0x000000000000000000000000000000000000aaaa';

const FIXTURE = {
  tokenId:
    '71321045679252212594626385532706912750332728571942532289631379312455583992396',
  // Our limit-order rounding (GTC) takes shares; with size=10 and price=0.5
  // the SDK math produces makerAmount=5_000_000 and takerAmount=10_000_000
  // (both in 6-dec units).
  size: 10,
  price: 0.5,
  side: 'BUY' as const,
  tickSize: '0.01' as const,
  negRisk: false,
};

describe('T1.3 — clob-v2 byte parity (POLY_1271) ⭐', () => {
  it('our buildTypedData → sign → wrap === SDK buildSignedOrder for the same inputs', async () => {
    // ---- (a) Drive OUR pipeline first so we capture the random salt/timestamp ----
    const wallet = new Wallet(TEST_PRIVATE_KEY);
    const ourPrepared = await buildTypedData({
      tokenId: FIXTURE.tokenId,
      price: FIXTURE.price,
      size: FIXTURE.size,
      side: FIXTURE.side,
      maker: DEPOSIT_WALLET,
      signatureType: 3,
      tickSize: FIXTURE.tickSize,
      negRisk: FIXTURE.negRisk,
      orderType: 'GTC',
    });

    // Sanity: our envelope is the ERC-7739 TypedDataSign shape.
    expect(ourPrepared.typedData.primaryType).toBe('TypedDataSign');
    expect(ourPrepared.typedData.domain.name).toBe(V2_DOMAIN_NAME);
    expect(ourPrepared.typedData.domain.version).toBe(V2_DOMAIN_VERSION);
    expect(ourPrepared.typedData.domain.chainId).toBe(POLYGON_CHAIN_ID);
    expect(ourPrepared.wrapSuffix).toBeDefined();

    // ethers v5 _signTypedData wants {TypedDataSign, Order} (no EIP712Domain).
    // The SDK strips EIP712Domain at exchangeOrderBuilderV2.js:121 before
    // calling _signTypedData, so we must too for the digests to match.
    const ourSignTypes = {
      TypedDataSign: [...TYPED_DATA_SIGN_STRUCT],
      Order: [...V2_ORDER_STRUCT],
    };

    // Re-derive the inner ECDSA over our TypedDataSign payload.
    // (For signatureType 3 our typedData.message is the TypedDataSign struct.)
    const ourInnerSig = await wallet._signTypedData(
      ourPrepared.typedData.domain,
      ourSignTypes,
      ourPrepared.typedData.message,
    );

    // Pull the Order fields back out of our TypedDataSign envelope so we can
    // feed them into the wrap helper.
    const tdsMessage = ourPrepared.typedData.message as {
      contents: V2OrderMessage;
    };
    const ourOrderMessage = tdsMessage.contents;

    const ourWrapped = wrapErc7739Signature({
      innerSig: ourInnerSig,
      order: ourOrderMessage,
      exchangeDomain: exchangeDomainFor(FIXTURE.negRisk),
    });

    // ---- (b) Drive the SDK with the SAME salt + timestamp so its random
    //          generators don't desync the digests. ----
    const sdkBuilder = new ExchangeOrderBuilderV2(
      exchangeDomainFor(FIXTURE.negRisk).verifyingContract,
      POLYGON_CHAIN_ID,
      // ethers v5 Wallet implements `_signTypedData` — that's the shape the
      // SDK's `isEthersTypedDataSigner` looks for. Cast to satisfy the union.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet as any,
      () => ourOrderMessage.salt,
    );

    const sdkResult = await sdkBuilder.buildSignedOrder({
      maker: ourOrderMessage.maker,
      signer: ourOrderMessage.signer,
      tokenId: ourOrderMessage.tokenId,
      makerAmount: ourOrderMessage.makerAmount,
      takerAmount: ourOrderMessage.takerAmount,
      // SDK expects the string form 'BUY'/'SELL' on buildOrder's input.
      side: 'BUY',
      signatureType: SignatureTypeV2.POLY_1271,
      timestamp: ourOrderMessage.timestamp,
      metadata: ourOrderMessage.metadata,
      builder: ourOrderMessage.builder,
    });

    // ---- The actual byte-diff ----
    expect(ourWrapped.toLowerCase()).toBe(sdkResult.signature.toLowerCase());

    // The two pipelines must also have agreed on every Order field.
    expect(sdkResult.salt).toBe(ourOrderMessage.salt);
    expect(sdkResult.maker.toLowerCase()).toBe(
      ourOrderMessage.maker.toLowerCase(),
    );
    expect(sdkResult.signer.toLowerCase()).toBe(
      ourOrderMessage.signer.toLowerCase(),
    );
    expect(sdkResult.makerAmount).toBe(ourOrderMessage.makerAmount);
    expect(sdkResult.takerAmount).toBe(ourOrderMessage.takerAmount);
    expect(sdkResult.timestamp).toBe(ourOrderMessage.timestamp);
  });

  it('byte-parity holds for the neg-risk exchange too', async () => {
    const wallet = new Wallet(TEST_PRIVATE_KEY);

    const ourPrepared = await buildTypedData({
      tokenId: FIXTURE.tokenId,
      price: FIXTURE.price,
      size: FIXTURE.size,
      side: 'SELL',
      maker: DEPOSIT_WALLET,
      signatureType: 3,
      tickSize: FIXTURE.tickSize,
      negRisk: true,
      orderType: 'GTC',
    });

    const ourSignTypes = {
      TypedDataSign: [...TYPED_DATA_SIGN_STRUCT],
      Order: [...V2_ORDER_STRUCT],
    };
    const ourInnerSig = await wallet._signTypedData(
      ourPrepared.typedData.domain,
      ourSignTypes,
      ourPrepared.typedData.message,
    );
    const tdsMessage = ourPrepared.typedData.message as {
      contents: V2OrderMessage;
    };
    const ourOrderMessage = tdsMessage.contents;
    const ourWrapped = wrapErc7739Signature({
      innerSig: ourInnerSig,
      order: ourOrderMessage,
      exchangeDomain: exchangeDomainFor(true),
    });

    const sdkBuilder = new ExchangeOrderBuilderV2(
      exchangeDomainFor(true).verifyingContract,
      POLYGON_CHAIN_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet as any,
      () => ourOrderMessage.salt,
    );

    const sdkResult = await sdkBuilder.buildSignedOrder({
      maker: ourOrderMessage.maker,
      signer: ourOrderMessage.signer,
      tokenId: ourOrderMessage.tokenId,
      makerAmount: ourOrderMessage.makerAmount,
      takerAmount: ourOrderMessage.takerAmount,
      side: 'SELL',
      signatureType: SignatureTypeV2.POLY_1271,
      timestamp: ourOrderMessage.timestamp,
      metadata: ourOrderMessage.metadata,
      builder: ourOrderMessage.builder,
    });

    expect(ourWrapped.toLowerCase()).toBe(sdkResult.signature.toLowerCase());
  });

  it('wrapSuffix from clob.ts (innerSig-less suffix) matches SDK suffix bytes', async () => {
    // The user added an inline buildWrapSuffix() in clob.ts that returns the
    // SUFFIX only (no innerSig). Confirm those bytes equal the trailing portion
    // of the SDK's full signature.
    const wallet = new Wallet(TEST_PRIVATE_KEY);
    const ourPrepared = await buildTypedData({
      tokenId: FIXTURE.tokenId,
      price: FIXTURE.price,
      size: FIXTURE.size,
      side: 'BUY',
      maker: DEPOSIT_WALLET,
      signatureType: 3,
      tickSize: FIXTURE.tickSize,
      negRisk: false,
      orderType: 'GTC',
    });
    expect(ourPrepared.wrapSuffix).toBeDefined();

    const tdsMessage = ourPrepared.typedData.message as {
      contents: V2OrderMessage;
    };
    const ourOrderMessage = tdsMessage.contents;

    const sdkBuilder = new ExchangeOrderBuilderV2(
      exchangeDomainFor(false).verifyingContract,
      POLYGON_CHAIN_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet as any,
      () => ourOrderMessage.salt,
    );
    const sdkResult = await sdkBuilder.buildSignedOrder({
      maker: ourOrderMessage.maker,
      signer: ourOrderMessage.signer,
      tokenId: ourOrderMessage.tokenId,
      makerAmount: ourOrderMessage.makerAmount,
      takerAmount: ourOrderMessage.takerAmount,
      side: 'BUY',
      signatureType: SignatureTypeV2.POLY_1271,
      timestamp: ourOrderMessage.timestamp,
      metadata: ourOrderMessage.metadata,
      builder: ourOrderMessage.builder,
    });

    // SDK signature = inner(65 bytes = 130 hex chars + '0x' = 132 chars total)
    // ‖ suffix. Strip the inner; what's left must equal our wrapSuffix.
    const sdkSuffix = '0x' + sdkResult.signature.slice(2 + 65 * 2);
    expect(ourPrepared.wrapSuffix!.toLowerCase()).toBe(sdkSuffix.toLowerCase());
  });
});
