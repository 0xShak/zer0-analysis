import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { clientIpFromHeaders, computeFingerprint } from '@/lib/chat/fingerprint';
import { checkRateLimit } from '@/lib/chat/rate-limit';
import {
  CHAT_GROUND_RULES,
  formatRecentWorkForSystem,
  formatTradesForSystem,
  loadChatContext,
} from '@/lib/chat/context';
import { getGroq, GROQ_MODELS } from '@/lib/groq';
import { logUsage } from '@/lib/cost/log';
import { computeCost } from '@/lib/cost/openai-pricing';
import { hasActiveEntitlement } from '@/lib/rate-limit';

// Node runtime — we need crypto (already implied by streaming + supabase
// service-role client) and a long-lived ReadableStream which is awkward on
// edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Body = z.object({
  message: z.string().min(1).max(2000),
  session_id: z.string().uuid().optional(),
});

function sidCookie(value: string): string {
  // Matches prompt1 §2: 1-year expiry, lax, HttpOnly.
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
    const { message } = parsed.data;
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

    // ---- fingerprint ----
    const ip = clientIpFromHeaders(req.headers);
    const ua = req.headers.get('user-agent') ?? '';
    const fingerprint = computeFingerprint(sid, ip, ua);

    // ---- session resolution (look up by user_id when known, else by
    // anon_fingerprint, else create a fresh row) ----
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
          console.error('[chat] session insert failed', createErr);
          return Response.json(
            { error: 'session_create_failed' },
            { status: 500 },
          );
        }
        sessionId = created.id;
      }
    }
    if (!sessionId) {
      return Response.json({ error: 'no_session' }, { status: 500 });
    }

    // ---- rate limit ----
    const rate = await checkRateLimit(supabase, fingerprint, userId);
    if (!rate.allowed) {
      const entitled = await hasActiveEntitlement(supabase, {
        sessionId,
        userId: userId ?? undefined,
      });
      if (!entitled) {
        // Observability breadcrumb. prompt1 §3: scope='app' so it never
        // surfaces on the public landing stream.
        await supabase.from('thoughts').insert({
          scope: 'app',
          content: `Anonymous user fingerprint=${fingerprint.slice(0, 8)} hit daily limit`,
        });
        return new Response(
          JSON.stringify({
            paywall: true,
            reason: 'daily_limit_reached',
            placeholder_charge_url: null,
          }),
          {
            status: 402,
            headers: {
              'content-type': 'application/json',
              'set-cookie': setCookieHeader,
            },
          },
        );
      }
    }

    // ---- persist user message ----
    await supabase.from('messages').insert({
      session_id: sessionId,
      user_id: userId,
      role: 'user',
      channel: 'web',
      content: message,
    });

    // ---- load context (history + trades + persona, in parallel) ----
    const context = await loadChatContext(supabase, sessionId, userId);

    const systemPrompt = `${context.persona}

## What you've been doing
${formatRecentWorkForSystem(context.recentMarkets, context.recentThoughts)}

Active trade recommendations:
${formatTradesForSystem(context.trades)}

${CHAT_GROUND_RULES}

Recent conversation memory follows. Respond as ZER0 — knowledgeable about Polymarket, has personality, doesn't hedge, references specific markets when relevant.`;

    // ---- Groq streaming ----
    const groq = getGroq();
    const stream = await groq.chat.completions.create({
      model: GROQ_MODELS.CHAT,
      temperature: 0.4,
      max_tokens: 1500,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        ...context.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    });

    const encoder = new TextEncoder();
    // Capture in locals so the closure inside ReadableStream doesn't
    // reach back into mutable parent vars.
    const sessionIdFinal = sessionId;
    const userIdFinal = userId;

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let fullText = '';
        let tokensIn = 0;
        let tokensOut = 0;
        try {
          for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta?.content ?? '';
            if (delta) {
              fullText += delta;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`),
              );
            }
            // Groq sends `usage` on `x_groq` in the terminal chunk.
            const usage = chunk.x_groq?.usage;
            if (usage) {
              tokensIn = usage.prompt_tokens ?? tokensIn;
              tokensOut = usage.completion_tokens ?? tokensOut;
            }
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (err) {
          console.error('[chat] groq stream error', err);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: 'stream_failed' })}\n\n`,
            ),
          );
        } finally {
          controller.close();
          // Best-effort persistence + usage logging. We deliberately don't
          // await this from the caller — the response is already closed by
          // the time these run.
          try {
            if (fullText.length > 0) {
              await supabase.from('messages').insert({
                session_id: sessionIdFinal,
                user_id: userIdFinal,
                role: 'assistant',
                channel: 'web',
                content: fullText,
              });
            }
            await logUsage({
              provider: 'groq',
              model: GROQ_MODELS.CHAT,
              tokens_in: tokensIn,
              tokens_out: tokensOut,
              cost_usd: computeCost(GROQ_MODELS.CHAT, {
                tokens_in: tokensIn,
                tokens_out: tokensOut,
              }),
              step: 'chat',
            });
          } catch (err) {
            console.error('[chat] post-stream persistence failed', err);
          }
        }
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-zer0-session-id': sessionId,
        'set-cookie': setCookieHeader,
      },
    });
  } catch (err) {
    console.error('[chat]', err);
    return Response.json(
      { error: 'chat_failed', message: 'something went wrong' },
      { status: 500 },
    );
  }
}
