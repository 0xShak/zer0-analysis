// Shared, dependency-free builder for the message a web sim payer signs to
// prove they control the paying wallet. Imported by BOTH the browser pay flow
// and the server verify route, so the exact bytes match on each side — keep it
// free of viem / env / node imports so it bundles safely in the client too.
//
// Why this exists: /api/sim/verify used to accept any (pending_sim_id, tx_hash)
// pair and only checked that *some* transfer of the right amount reached the
// shared sink. Because transfers to the sink are public on Base, anyone could
// watch the chain and submit a victim's payment tx for their OWN sim — stealing
// the paid run (the victim's later verify then fails on the unique tx index).
// Requiring a signature from the payer's wallet, and binding the on-chain
// transfer's `from` to the recovered signer, closes that hijack.

export function simPaymentAuthMessage(pendingSimId: string): string {
  return `ZER0: authorize sim payment\nsim: ${pendingSimId.toLowerCase()}`;
}
