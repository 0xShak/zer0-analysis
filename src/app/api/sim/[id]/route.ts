import { createAdminClient } from '@/lib/supabase/admin';

// GET /api/sim/[id] — poll a sim's status. `id` is the pending_sim id (what the
// POST route returns). Resolves the simulations row by pending_sim_id so the
// result view can render the share card / watch link / summary once it lands.
//
// Uses the service-role admin client (both pending_sims + simulations are
// RLS-locked to service_role), so this server route is the only read path the
// browser has into a sim's progress.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = createAdminClient();

  const { data: pending, error: pErr } = await supabase
    .from('pending_sims')
    .select('id, state, scenario')
    .eq('id', id)
    .maybeSingle();
  if (pErr) {
    console.error('[sim/status]', pErr);
    return Response.json({ error: 'lookup_failed' }, { status: 500 });
  }
  if (!pending) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  const { data: sim } = await supabase
    .from('simulations')
    .select(
      'status, scenario, watch_url, share_card_url, summary, error, completed_at',
    )
    .eq('pending_sim_id', id)
    .maybeSingle();

  return Response.json({
    state: pending.state,
    needs_payment: pending.state === 'AWAITING_PAYMENT',
    scenario: pending.scenario,
    simulation: sim
      ? {
          status: sim.status,
          watch_url: sim.watch_url,
          share_card_url: sim.share_card_url,
          summary: sim.summary,
          error: sim.error,
          completed_at: sim.completed_at,
        }
      : null,
  });
}
