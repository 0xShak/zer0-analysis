// Polymarket builder authentication wiring.
//
// Two different things called "BuilderConfig" exist in the Polymarket TS
// stack — names collide but the shapes don't:
//
//   1. `@polymarket/builder-signing-sdk`'s `BuilderConfig` class. Has
//      `isValid()` + `generateBuilderHeaders()`. The relayer SDK
//      (`builder-relayer-client`) reads this to attach the four
//      `POLY_BUILDER_*` HMAC headers to every `/submit` request.
//
//   2. `@polymarket/clob-client-v2`'s `BuilderConfig` interface — just
//      `{ builderCode: string }`. The CLOB SDK reads `.builderCode` and
//      stamps it onto the V2 order's `builder` field for attribution.
//
// We construct the first in REMOTE mode pointing at our /api/polymarket
// /builder-sign route — the SDK POSTs `{ method, path, body, timestamp }`
// per relayer request, we sign with the HMAC secret server-side, return
// the four headers. The secret never leaves the server.
//
// The second is just the public bytes32 attribution code from a
// NEXT_PUBLIC env var — no signing involved, attribution code is recorded
// publicly on-chain anyway.

import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { env } from '../env';

/**
 * Browser-side `BuilderConfig` for the relayer SDK. Validates the URL
 * (must start with http:// or https://) and POSTs each `(method, path,
 * body)` to our server signer on demand.
 */
export function getRelayerBuilderConfig(): BuilderConfig {
  if (typeof window === 'undefined') {
    throw new Error('getRelayerBuilderConfig must be called in the browser');
  }
  return new BuilderConfig({
    remoteBuilderConfig: {
      url: `${window.location.origin}/api/polymarket/builder-sign`,
    },
  });
}

/**
 * Public attribution payload for `ClobClient`. The SDK reads `.builderCode`
 * and writes it into each V2 order's `builder` field. Bytes32 hex.
 */
export function getClobBuilderConfig(): { builderCode: string } | undefined {
  const code = env.NEXT_PUBLIC_POLYMARKET_BUILDER_CODE;
  if (!code) return undefined;
  return { builderCode: code };
}
