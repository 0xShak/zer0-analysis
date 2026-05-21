// EIP-712 signing over WalletConnect — used for both the plain V2 Order
// (sigType 1/2) and the ERC-7739 TypedDataSign nested payload (sigType 3).
//
// Returns the inner 65-byte ECDSA signature as a hex string. For sigType 3
// the caller wraps this into the ERC-7739 envelope via wrap-1271.ts before
// posting; we keep this function single-purpose so the wrap is testable in
// isolation.

import { getSignClient } from './sign-client';

const POLYGON_CAIP2 = 'eip155:137';
const DEFAULT_TIMEOUT_MS = 90_000;

export interface RequestEip712SigArgs {
  topic: string;
  eoa: string;
  // The full EIP-712 typed-data payload (`{ types, domain, primaryType, message }`).
  // We forward it untouched to the wallet via eth_signTypedData_v4.
  typedData: unknown;
  /** Override for the 90-second default. */
  timeoutMs?: number;
}

export async function requestEip712Sig(
  args: RequestEip712SigArgs,
): Promise<string> {
  const client = await getSignClient();
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const requestPromise = client.request<string>({
    topic: args.topic,
    chainId: POLYGON_CAIP2,
    request: {
      method: 'eth_signTypedData_v4',
      params: [args.eoa, JSON.stringify(args.typedData)],
    },
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error('wallet sign request timed out')),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([requestPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
