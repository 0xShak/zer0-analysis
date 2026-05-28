// Server-side recovery of the web sim payer from their signature. Shared by
// /api/sim/verify (fast path) and /api/sim/pay-intent (durable fallback) so
// both bind the payment to the same proven wallet. Lives apart from
// sim-payment-auth.ts because that builder is kept viem-free for the browser
// bundle; this one needs viem and is server-only.

import { getAddress, recoverMessageAddress, type Hex } from 'viem';
import { simPaymentAuthMessage } from './sim-payment-auth';

/**
 * Recover the signer of simPaymentAuthMessage(pendingSimId) and confirm it
 * matches the claimed address. Returns the checksummed payer on success, or
 * null if the signature is invalid or doesn't match — callers reject with 401.
 */
export async function recoverSimPayer(args: {
  pendingSimId: string;
  fromAddress: string;
  signature: string;
}): Promise<string | null> {
  try {
    const recovered = await recoverMessageAddress({
      message: simPaymentAuthMessage(args.pendingSimId),
      signature: args.signature as Hex,
    });
    if (getAddress(recovered) !== getAddress(args.fromAddress)) return null;
    return getAddress(args.fromAddress);
  } catch {
    return null;
  }
}
