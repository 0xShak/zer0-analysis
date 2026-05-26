import { describe, it, expect } from 'vitest';
import { resolveWallet } from '@/telegram-bot/polymarket/resolve-wallet';
import {
  deriveProxyWalletAddress,
  deriveSafeAddress,
  deriveDepositWalletAddress,
} from '@/lib/polymarket/deposit-wallet';

const EOA = '0x1111111111111111111111111111111111111111';
const proxy = deriveProxyWalletAddress(EOA);
const safe = deriveSafeAddress(EOA);
const deposit = deriveDepositWalletAddress(EOA);

/** codeProbe stub: deployed iff the address is in `deployed`. */
function codeProbeFor(deployed: string[]) {
  const set = new Set(deployed.map((a) => a.toLowerCase()));
  return async (addr: `0x${string}`) => set.has(addr.toLowerCase());
}

describe('resolveWallet', () => {
  it('derives three distinct candidate addresses', () => {
    expect(new Set([proxy, safe, deposit].map((a) => a.toLowerCase())).size).toBe(3);
  });

  it('resolves a deployed proxy to sigType 1 (funder=proxy, signer=eoa)', async () => {
    const r = await resolveWallet({ eoa: EOA, codeProbe: codeProbeFor([proxy]) });
    expect(r).toMatchObject({
      funder: proxy,
      signer: EOA,
      signatureType: 1,
      walletType: 'proxy',
      needsOnboarding: false,
    });
  });

  it('resolves a deployed safe to sigType 2 (funder=safe, signer=eoa)', async () => {
    const r = await resolveWallet({ eoa: EOA, codeProbe: codeProbeFor([safe]) });
    expect(r).toMatchObject({
      funder: safe,
      signer: EOA,
      signatureType: 2,
      walletType: 'safe',
      needsOnboarding: false,
    });
  });

  it('resolves a deployed deposit wallet to sigType 3 (funder=signer=wallet)', async () => {
    const r = await resolveWallet({ eoa: EOA, codeProbe: codeProbeFor([deposit]) });
    expect(r).toMatchObject({
      funder: deposit,
      signer: deposit,
      signatureType: 3,
      walletType: 'deposit_wallet',
      needsOnboarding: false,
    });
  });

  it('flags onboarding when nothing is deployed — funder is the derived deposit wallet, never the raw EOA', async () => {
    const r = await resolveWallet({ eoa: EOA, codeProbe: codeProbeFor([]) });
    expect(r).toMatchObject({
      funder: deposit,
      signer: deposit,
      signatureType: 3,
      walletType: 'deposit_wallet',
      needsOnboarding: true,
    });
    // The bug we're fixing: the old code set funder = raw EOA here.
    expect(r.funder.toLowerCase()).not.toBe(EOA.toLowerCase());
  });

  it('picks the funded wallet (proxy) when several are deployed', async () => {
    const balances: Record<string, bigint> = {
      [proxy.toLowerCase()]: BigInt(5_000_000),
      [deposit.toLowerCase()]: BigInt(0),
    };
    const r = await resolveWallet({
      eoa: EOA,
      codeProbe: codeProbeFor([proxy, deposit]),
      balanceProbe: async (a) => balances[a.toLowerCase()] ?? BigInt(0),
    });
    expect(r.walletType).toBe('proxy');
    expect(r.signatureType).toBe(1);
    expect(r.needsOnboarding).toBe(false);
  });

  it('picks the deposit wallet when it holds the funds', async () => {
    const balances: Record<string, bigint> = {
      [proxy.toLowerCase()]: BigInt(0),
      [deposit.toLowerCase()]: BigInt(9_000_000),
    };
    const r = await resolveWallet({
      eoa: EOA,
      codeProbe: codeProbeFor([proxy, deposit]),
      balanceProbe: async (a) => balances[a.toLowerCase()] ?? BigInt(0),
    });
    expect(r.walletType).toBe('deposit_wallet');
    expect(r.signatureType).toBe(3);
  });
});
