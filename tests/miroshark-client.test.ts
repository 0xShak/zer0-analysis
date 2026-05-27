// The MiroShark client is the boundary between Track A (this repo) and the
// VPS-hosted service. These tests pin the two things that boundary must get
// right with no network: the `{ success, data }` envelope handling and the
// bearer-auth header, plus URL construction for the result links.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

beforeAll(() => {
  process.env.MIROSHARK_API_URL = 'https://miro.example.xyz/';
  process.env.MIROSHARK_API_TOKEN = 'secret-token';
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(impl: () => { ok: boolean; status: number; body: string }) {
  const spy = vi.fn(async (_url: string, _init?: RequestInit) => {
    const r = impl();
    return {
      ok: r.ok,
      status: r.status,
      text: async () => r.body,
    } as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('MiroShark client envelope', () => {
  it('unwraps data on success and sends the bearer token', async () => {
    const spy = mockFetch(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify({
        success: true,
        data: { status: 'completed', graph_id: 'g-1' },
      }),
    }));
    const { getGraphTask } = await import('@/lib/miroshark/client');
    const res = await getGraphTask('task-1');
    expect(res.status).toBe('completed');
    expect(res.graph_id).toBe('g-1');

    // Authorization header + correct URL (trailing slash on base stripped).
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://miro.example.xyz/api/graph/task/task-1');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token');
  });

  it('throws MiroSharkError on success:false', async () => {
    mockFetch(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ success: false, error: 'boom' }),
    }));
    const { getGraphTask, MiroSharkError } = await import(
      '@/lib/miroshark/client'
    );
    await expect(getGraphTask('task-1')).rejects.toBeInstanceOf(MiroSharkError);
  });

  it('throws MiroSharkError with status on a non-2xx response', async () => {
    mockFetch(() => ({ ok: false, status: 502, body: 'bad gateway' }));
    const { getGraphTask, MiroSharkError } = await import(
      '@/lib/miroshark/client'
    );
    await expect(getGraphTask('task-1')).rejects.toMatchObject({
      name: 'MiroSharkError',
      status: 502,
    });
    void MiroSharkError;
  });

  it('builds result URLs without doubling the base slash', async () => {
    const { shareCardUrl, watchUrl } = await import('@/lib/miroshark/client');
    expect(shareCardUrl('s-9')).toBe(
      'https://miro.example.xyz/api/simulation/s-9/share-card.png',
    );
    expect(watchUrl('s-9')).toBe('https://miro.example.xyz/watch/s-9');
  });
});
