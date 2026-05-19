import { NextResponse, type NextRequest } from 'next/server';

// Next.js 16 renamed middleware → proxy. Issues the zer0_sid cookie used by
// the fingerprint composite (zer0.md §6) so anonymous rate limits stick across
// reloads even before /api/chat is hit.
export function proxy(req: NextRequest) {
  const res = NextResponse.next();
  if (!req.cookies.get('zer0_sid')) {
    res.cookies.set('zer0_sid', crypto.randomUUID(), {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
      httpOnly: false,
    });
  }
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
