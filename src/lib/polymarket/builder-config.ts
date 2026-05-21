// Minimal duck-typed BuilderConfig.
//
// `@polymarket/builder-relayer-client` and `@polymarket/clob-client-v2` both
// accept a `builderConfig` that they only interact with via:
//   - `isValid()`                                     → boolean
//   - `generateBuilderHeaders(method, path, body?)`   → headers | undefined
//   - reading the `builderCode` field on the instance (clob-client-v2 only,
//     for V2 order attribution)
//
// `@polymarket/builder-signing-sdk` ships a full HMAC implementation, but we
// don't have HMAC creds — polymarket.com's builder page issues a
// `RELAYER_API_KEY` + `RELAYER_API_KEY_ADDRESS` pair instead. This file is
// the shim that lets us pass the simpler header pair through the SDKs'
// existing auth hook without installing the HMAC sdk.

export class RelayerApiKeyBuilderConfig {
  constructor(
    private readonly apiKey: string,
    private readonly apiKeyAddress: string,
    public readonly builderCode: string,
  ) {}

  isValid(): boolean {
    return Boolean(this.apiKey && this.apiKeyAddress);
  }

  async generateBuilderHeaders(
    _method?: string,
    _path?: string,
    _body?: string,
  ): Promise<Record<string, string>> {
    return {
      RELAYER_API_KEY: this.apiKey,
      RELAYER_API_KEY_ADDRESS: this.apiKeyAddress,
    };
  }
}

export interface BuilderHeadersPayload {
  RELAYER_API_KEY: string;
  RELAYER_API_KEY_ADDRESS: string;
  builderCode: string;
}

// Browser-side cache. The fetch is server-side via a same-origin GET; once
// per page load is plenty (env values are static for the process lifetime).
let cached: Promise<BuilderHeadersPayload> | null = null;

export async function getBuilderHeaders(): Promise<BuilderHeadersPayload> {
  if (cached) return cached;
  cached = (async () => {
    const res = await fetch('/api/polymarket/builder-headers', {
      cache: 'no-store',
    });
    if (!res.ok) {
      cached = null;
      throw new Error(`builder-headers route returned ${res.status}`);
    }
    return (await res.json()) as BuilderHeadersPayload;
  })();
  return cached;
}

export async function getBuilderConfig(): Promise<RelayerApiKeyBuilderConfig> {
  const h = await getBuilderHeaders();
  return new RelayerApiKeyBuilderConfig(
    h.RELAYER_API_KEY,
    h.RELAYER_API_KEY_ADDRESS,
    h.builderCode,
  );
}
