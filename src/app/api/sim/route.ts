import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { clientIpFromHeaders, computeFingerprint } from '@/lib/chat/fingerprint';
import { checkRateLimit } from '@/lib/chat/rate-limit';
import { createSimRequest } from '@/lib/sims/request';

// POST /api/sim — kick off a MiroShark sim from the web. Mirrors /api/chat's
// session resolution (zer0_sid cookie + fingerprint). Returns the pending_sim
// id; the client navigates to /sim/<id> to watch it run. When the payment gate
// is on, returns needs_payment + a quote instead of firing immediately.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Body = z.object({
  scenario: z.string().min(8).max(2000),
  session_id: z.string().uuid().optional(),
});

function sidCookie(value: string): string {
  return `zer0_sid=${value}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax; HttpOnly`;
}

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return Response.json(
        { error: 'invalid_body', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const { scenario } = parsed.data;
    const supabase = createAdminClient();

    // ---- zer0_sid cookie ----
    const cookieSid = req.cookies.get('zer0_sid')?.value;
    const sid =
      cookieSid && UUID_RE.test(cookieSid) ? cookieSid : crypto.randomUUID();
    const setCookieHeader = sidCookie(sid);

    // ---- optional Supabase Auth bearer token ----
    let userId: string | null = null;
    const auth = req.headers.get('authorization');
    if (auth && auth.toLowerCase().startsWith('bearer ')) {
      const token = auth.slice(7).trim();
      if (token) {
        const { data, error } = await supabase.auth.getUser(token);
        if (!error && data.user) userId = data.user.id;
      }
    }

    // ---- fingerprint + session resolution (look up by user_id, else
    // anon_fingerprint, else create a fresh web session) ----
    const ip = clientIpFromHeaders(req.headers);
    const ua = req.headers.get('user-agent') ?? '';
    const fingerprint = computeFingerprint(sid, ip, ua);

    let sessionId = parsed.data.session_id;
    if (!sessionId) {
      const lookup = userId
        ? supabase
            .from('sessions')
            .select('id')
            .eq('user_id', userId)
            .eq('channel', 'web')
            .order('created_at', { ascending: false })
            .limit(1)
        : supabase
            .from('sessions')
            .select('id')
            .eq('anon_fingerprint', fingerprint)
            .eq('channel', 'web')
            .order('created_at', { ascending: false })
            .limit(1);
      const { data: existing } = await lookup;
      if (existing && existing.length > 0) {
        sessionId = existing[0].id;
      } else {
        const { data: created, error: createErr } = await supabase
          .from('sessions')
          .insert({
            user_id: userId,
            anon_fingerprint: fingerprint,
            channel: 'web',
          })
          .select('id')
          .single();
        if (createErr || !created) {
          console.error('[sim] session insert failed', createErr);
          return Response.json({ error: 'session_create_failed' }, { status: 500 });
        }
        sessionId = created.id;
      }
    }

    // ---- rate limit (shares the web daily quota; sims are expensive) ----
    const rate = await checkRateLimit(supabase, fingerprint, userId);
    if (!rate.allowed) {
      return Response.json(
        { error: 'rate_limited', message: "You've hit today's limit." },
        { status: 429, headers: { 'set-cookie': setCookieHeader } },
      );
    }

    const result = await createSimRequest(supabase, {
      channel: 'web',
      scenario,
      userId,
      sessionId,
    });

    return Response.json(
      {
        pending_sim_id: result.pendingSim.id,
        needs_payment: result.needsPayment,
        quote: result.quote ?? null,
      },
      {
        status: 200,
        headers: {
          'set-cookie': setCookieHeader,
          'x-zer0-session-id': sessionId,
        },
      },
    );
  } catch (err) {
    console.error('[sim]', err);
    return Response.json(
      { error: 'sim_failed', message: 'something went wrong' },
      { status: 500 },
    );
  }
}
