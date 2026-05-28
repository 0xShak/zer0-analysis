// Strip content that would turn ZER0's public surfaces (the trade board, the X
// feed) into an attacker's vector: clickable links and @mentions. The market
// question/description/resolutionSource that feed the deep-analyzer and the
// tweet composer are attacker-controllable — anyone can create a Polymarket
// market — so a prompt injection could try to plant a link or a ping in the
// model's output (audit2.md M-A). The prompts also forbid these, but prompts
// are not a guarantee; this is the enforced last line of defence applied at the
// points where model text becomes public.
export function stripLinksAndHandles(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, '') // explicit URLs
    .replace(/\bwww\.\S+/gi, '') // www.* URLs without a scheme
    .replace(/\b(?:t\.me|bit\.ly|tinyurl\.com|discord\.gg)\/\S*/gi, '') // shorteners / invites
    .replace(/(^|[^\w@])@\w{1,30}/g, '$1') // @handles (keep the char before the @)
    .replace(/\s+/g, ' ')
    .trim();
}
