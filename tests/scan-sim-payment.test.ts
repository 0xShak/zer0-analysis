// scanForSimPayment is the safety net for the orphaned-payment bug: it watches
// Base for the payer's $ZER0 Transfer to the sink. These tests pin the matching
// logic (value threshold, first-match, server-side from/to/fromBlock filtering)
// with getLogs mocked — no network.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { getAddress } from 'viem';

const { getLogsMock } = vi.hoisted(() => ({ getLogsMock: vi.fn() }));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({ getLogs: getLogsMock }),
  };
});

const TOKEN = '0x34e8bf29896722f01894c53c288e74a59c284ba3';
const FROM = '0x6816471E48A6b14Df63d3E213d22B34497f8f331';
const SINK = '0x711f7922E4eeA668299ee41a3cD15ddb2E23Bf62';
// 2,000,000 $ZER0 @ 18 decimals — the real per-sim price from the incident.
// BigInt() (not an `n` literal) keeps tsc happy at the project's ES2017 target.
const PRICE = BigInt('2000000000000000000000000');
const FROM_BLOCK = BigInt(46_579_270);

beforeAll(() => {
  process.env.ZER0_TOKEN_ADDRESS = TOKEN;
  process.env.ZER0_SIM_PRICE = '2000000';
});

beforeEach(() => {
  getLogsMock.mockReset();
});

function transferLog(args: {
  from: string;
  to: string;
  value: bigint;
  txHash: string;
}) {
  return {
    transactionHash: args.txHash,
    args: { from: args.from, to: args.to, value: args.value },
  };
}

describe('scanForSimPayment', () => {
  it('returns the matching tx when value clears the threshold', async () => {
    getLogsMock.mockResolvedValue([
      transferLog({ from: FROM, to: SINK, value: PRICE, txHash: '0xpaid' }),
    ]);
    const { scanForSimPayment } = await import('@/lib/web3/zer0-payment');
    const r = await scanForSimPayment({
      from: FROM,
      to: SINK,
      minAmount: PRICE,
      fromBlock: FROM_BLOCK,
    });
    expect(r).toEqual({ txHash: '0xpaid', value: PRICE });
  });

  it('returns null when no logs match', async () => {
    getLogsMock.mockResolvedValue([]);
    const { scanForSimPayment } = await import('@/lib/web3/zer0-payment');
    const r = await scanForSimPayment({
      from: FROM,
      to: SINK,
      minAmount: PRICE,
      fromBlock: FROM_BLOCK,
    });
    expect(r).toBeNull();
  });

  it('ignores a transfer below the price (underpayment)', async () => {
    getLogsMock.mockResolvedValue([
      transferLog({ from: FROM, to: SINK, value: PRICE - BigInt(1), txHash: '0xlow' }),
    ]);
    const { scanForSimPayment } = await import('@/lib/web3/zer0-payment');
    const r = await scanForSimPayment({
      from: FROM,
      to: SINK,
      minAmount: PRICE,
      fromBlock: FROM_BLOCK,
    });
    expect(r).toBeNull();
  });

  it('picks the first log that clears the threshold, skipping an underpayment', async () => {
    getLogsMock.mockResolvedValue([
      transferLog({ from: FROM, to: SINK, value: BigInt(1), txHash: '0xlow' }),
      transferLog({ from: FROM, to: SINK, value: PRICE, txHash: '0xgood' }),
    ]);
    const { scanForSimPayment } = await import('@/lib/web3/zer0-payment');
    const r = await scanForSimPayment({
      from: FROM,
      to: SINK,
      minAmount: PRICE,
      fromBlock: FROM_BLOCK,
    });
    expect(r?.txHash).toBe('0xgood');
  });

  it('filters getLogs by checksummed from/to and the given fromBlock', async () => {
    getLogsMock.mockResolvedValue([]);
    const { scanForSimPayment } = await import('@/lib/web3/zer0-payment');
    await scanForSimPayment({
      from: FROM,
      to: SINK,
      minAmount: PRICE,
      fromBlock: BigInt(100),
    });
    const call = getLogsMock.mock.calls[0][0];
    expect(call.address).toBe(getAddress(TOKEN));
    expect(call.args.from).toBe(getAddress(FROM));
    expect(call.args.to).toBe(getAddress(SINK));
    expect(call.fromBlock).toBe(BigInt(100));
    expect(call.toBlock).toBe('latest');
  });
});
