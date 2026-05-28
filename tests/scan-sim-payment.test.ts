// scanForSimPayment is the safety net for the orphaned-payment bug: it watches
// Base for the payer's $ZER0 Transfer to the sink. These tests pin the matching
// logic (value threshold, first-match) and the chunked getLogs scanning that
// keeps us under free RPC tiers' block-range caps — all with getLogs +
// getBlockNumber mocked, no network.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { getAddress } from 'viem';

const { getLogsMock, getBlockNumberMock } = vi.hoisted(() => ({
  getLogsMock: vi.fn(),
  getBlockNumberMock: vi.fn(),
}));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      getLogs: getLogsMock,
      getBlockNumber: getBlockNumberMock,
    }),
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
  getBlockNumberMock.mockReset();
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

describe('scanForSimPayment matching', () => {
  // Single-block window (toBlock provided) so these focus purely on matching.
  const single = { from: FROM, to: SINK, minAmount: PRICE, fromBlock: FROM_BLOCK, toBlock: FROM_BLOCK };

  it('returns the matching tx when value clears the threshold', async () => {
    getLogsMock.mockResolvedValue([
      transferLog({ from: FROM, to: SINK, value: PRICE, txHash: '0xpaid' }),
    ]);
    const { scanForSimPayment } = await import('@/lib/web3/zer0-payment');
    expect(await scanForSimPayment(single)).toEqual({
      txHash: '0xpaid',
      value: PRICE,
    });
  });

  it('returns null when no logs match', async () => {
    getLogsMock.mockResolvedValue([]);
    const { scanForSimPayment } = await import('@/lib/web3/zer0-payment');
    expect(await scanForSimPayment(single)).toBeNull();
  });

  it('ignores a transfer below the price (underpayment)', async () => {
    getLogsMock.mockResolvedValue([
      transferLog({ from: FROM, to: SINK, value: PRICE - BigInt(1), txHash: '0xlow' }),
    ]);
    const { scanForSimPayment } = await import('@/lib/web3/zer0-payment');
    expect(await scanForSimPayment(single)).toBeNull();
  });

  it('picks the first log that clears the threshold, skipping an underpayment', async () => {
    getLogsMock.mockResolvedValue([
      transferLog({ from: FROM, to: SINK, value: BigInt(1), txHash: '0xlow' }),
      transferLog({ from: FROM, to: SINK, value: PRICE, txHash: '0xgood' }),
    ]);
    const { scanForSimPayment } = await import('@/lib/web3/zer0-payment');
    expect((await scanForSimPayment(single))?.txHash).toBe('0xgood');
  });
});

describe('scanForSimPayment chunking (free-tier getLogs cap)', () => {
  it('walks the range in <=10-block windows, never an unbounded "latest" query', async () => {
    // 26-block window with no toBlock → tip comes from getBlockNumber.
    getBlockNumberMock.mockResolvedValue(FROM_BLOCK + BigInt(25));
    getLogsMock.mockResolvedValue([]); // nothing matches → it must scan every chunk
    const { scanForSimPayment } = await import('@/lib/web3/zer0-payment');

    const r = await scanForSimPayment({
      from: FROM,
      to: SINK,
      minAmount: PRICE,
      fromBlock: FROM_BLOCK,
    });
    expect(r).toBeNull();

    const calls = getLogsMock.mock.calls.map((c) => c[0]);
    // [FB,FB+9] [FB+10,FB+19] [FB+20,FB+25] → 3 chunks
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(typeof c.toBlock).toBe('bigint'); // never 'latest'
      expect(c.toBlock - c.fromBlock).toBeLessThanOrEqual(BigInt(9));
      expect(c.address).toBe(getAddress(TOKEN));
      expect(c.args.from).toBe(getAddress(FROM));
      expect(c.args.to).toBe(getAddress(SINK));
    }
    expect(calls[0].fromBlock).toBe(FROM_BLOCK);
    expect(calls[2].toBlock).toBe(FROM_BLOCK + BigInt(25)); // last chunk clamps to tip
  });

  it('stops at the first chunk that contains the payment', async () => {
    getBlockNumberMock.mockResolvedValue(FROM_BLOCK + BigInt(25));
    getLogsMock
      .mockResolvedValueOnce([]) // chunk 1: nothing
      .mockResolvedValueOnce([
        transferLog({ from: FROM, to: SINK, value: PRICE, txHash: '0xhit' }),
      ]); // chunk 2: payment
    const { scanForSimPayment } = await import('@/lib/web3/zer0-payment');

    const r = await scanForSimPayment({
      from: FROM,
      to: SINK,
      minAmount: PRICE,
      fromBlock: FROM_BLOCK,
    });
    expect(r?.txHash).toBe('0xhit');
    expect(getLogsMock).toHaveBeenCalledTimes(2); // didn't scan chunk 3
  });
});
