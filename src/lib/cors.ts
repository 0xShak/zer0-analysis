// CORS for the /api/pro/* routes, which the landing site (zer0-FE) calls from
// a different origin. These routes carry NO cookies and verify every payment
// on-chain, so a permissive allowlist is safe; PRO_CORS_ORIGINS pins it down
// in prod if desired (comma-separated, or '*' for any).

import { env } from './env';

function allowedOrigin(reqOrigin: string | null): string {
  const list = env.PRO_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('*') || list.length === 0) return reqOrigin ?? '*';
  if (reqOrigin && list.includes(reqOrigin)) return reqOrigin;
  return list[0];
}

export function corsHeaders(reqOrigin: string | null): Record<string, string> {
  return {
    'access-control-allow-origin': allowedOrigin(reqOrigin),
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

/** Standard preflight response for the pro routes. */
export function preflight(reqOrigin: string | null): Response {
  return new Response(null, { status: 204, headers: corsHeaders(reqOrigin) });
}

/** JSON response with CORS headers merged in. */
export function corsJson(
  reqOrigin: string | null,
  body: unknown,
  init?: { status?: number },
): Response {
  return Response.json(body, {
    status: init?.status ?? 200,
    headers: corsHeaders(reqOrigin),
  });
}
