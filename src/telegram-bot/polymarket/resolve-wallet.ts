// Resolve an EOA → on-chain Polymarket trading identity (funder + signature
// type). Polymarket's V2 CLOB doesn't trade against raw EOAs — it requires one
// of three on-chain "trading wallet" shapes, all CREATE2-deterministic from
// the EOA:
//
//   1. POLY_PROXY (sigType 1)       — legacy proxy; funder = proxy, signer = EOA.
//   2. POLY_GNOSIS_SAFE (sigType 2) — gnosis safe;  funder = safe,  signer = EOA.
//   3. POLY_1271 (sigType 3)        — deposit wallet for new (post-2026) users;
//                                     funder = signer = the deposit wallet.
//
// There is NO Polymarket API that maps an EOA to its wallet shape (the old
// `data-api.polymarket.com/resolve/<eoa>` endpoint this code used to call does
// not exist — it 404s for every address, which silently dumped every user into
// the type-3 fallback with funder = raw EOA and produced "invalid order
// payload" on every trade).
//
// Instead we derive all three candidate addresses deterministically (via the
// relayer SDK's CREATE2 helpers) and detect which one is actually deployed
// on-chain with `eth_getCode`. If more than one is deployed we pick the funded
// one by pUSD balance. The returned `funder` is ALWAYS a derived contract
// address — never the raw EOA.
//
// Probes are injectable (`codeProbe` / `balanceProbe`) so the four branches are
// trivially unit-testable without RPC.

import {
  deriveDepositWalletAddress,
  deriveProxyWalletAddress,
  deriveSafeAddress,
  isContractDeployed,
} from '../../lib/polymarket/deposit-wallet';
import { getPusdBalance } from '../../lib/polymarket/allowance';

export type WalletType = 'eoa' | 'proxy' | 'safe' | 'deposit_wallet';
export type SignatureTypeNum = 0 | 1 | 2 | 3;

export interface WalletResolution {
  /** The on-chain account that holds pUSD and the user's CTF positions. */
  funder: string;
  /** The address whose ECDSA key signs orders (the EOA for type 1/2; the deposit wallet for type 3). */
  signer: string;
  signatureType: SignatureTypeNum;
  walletType: WalletType;
  /** True when no trading wallet is deployed yet — the user must provision via polymarket.com. */
  needsOnboarding: boolean;
}

export interface ResolveWalletArgs {
  eoa: string;
  /** Override the on-chain deployment check (tests inject a stub). */
  codeProbe?: (address: `0x${string}`) => Promise<boolean>;
  /** Override the pUSD balance read used to disambiguate multiple deployed wallets. */
  balanceProbe?: (address: `0x${string}`) => Promise<bigint>;
}

type WalletCandidate = Omit<WalletResolution, 'needsOnboarding'> & {
  funder: `0x${string}`;
};

/**
 * Resolve an EOA to its on-chain Polymarket trading identity.
 *
 *   - exactly one candidate deployed → that wallet, needsOnboarding=false
 *   - several deployed               → the one with the highest pUSD balance
 *                                       (ties broken by preference order)
 *   - none deployed                  → deposit-wallet shape (the provisioning
 *                                       path) with the derived deposit address
 *                                       and needsOnboarding=true
 *
 * Preference order is proxy(1) → safe(2) → deposit(3): web3-wallet users who
 * onboarded via polymarket.com hold a proxy, which we want to find first.
 *
 * Throws only if the deployment probe fails on every RPC, so the caller can
 * reply "Polymarket lookup failed, try again".
 */
export async function resolveWallet(
  args: ResolveWalletArgs,
): Promise<WalletResolution> {
  const eoa = args.eoa;
  const codeProbe = args.codeProbe ?? isContractDeployed;
  const balanceProbe = args.balanceProbe ?? getPusdBalance;

  const proxy = deriveProxyWalletAddress(eoa);
  const safe = deriveSafeAddress(eoa);
  const deposit = deriveDepositWalletAddress(eoa);

  const candidates: WalletCandidate[] = [
    { funder: proxy, signer: eoa, signatureType: 1, walletType: 'proxy' },
    { funder: safe, signer: eoa, signatureType: 2, walletType: 'safe' },
    {
      funder: deposit,
      signer: deposit,
      signatureType: 3,
      walletType: 'deposit_wallet',
    },
  ];

  const deployedFlags = await Promise.all(
    candidates.map((c) => codeProbe(c.funder)),
  );
  const deployed = candidates.filter((_, i) => deployedFlags[i]);

  if (deployed.length === 0) {
    // New user — nothing provisioned. Use the deposit-wallet shape with the
    // real derived address (NOT the raw EOA) and flag onboarding so the trade
    // path refuses cleanly until the wallet is deployed via polymarket.com.
    return {
      funder: deposit,
      signer: deposit,
      signatureType: 3,
      walletType: 'deposit_wallet',
      needsOnboarding: true,
    };
  }

  if (deployed.length === 1) {
    return { ...deployed[0], needsOnboarding: false };
  }

  // Multiple deployed (e.g. a legacy proxy AND a deposit wallet). Pick the
  // funded one; ties (or all-zero) fall back to preference order.
  let best = deployed[0];
  let bestBalance = BigInt(-1);
  for (const candidate of deployed) {
    let balance = BigInt(0);
    try {
      balance = await balanceProbe(candidate.funder);
    } catch {
      balance = BigInt(0);
    }
    if (balance > bestBalance) {
      bestBalance = balance;
      best = candidate;
    }
  }
  return { ...best, needsOnboarding: false };
}
