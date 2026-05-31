// Whole-word containment for grounding. Substring matching caused a recurring
// class of false positives — "shot" (from "give it a shot") matched "MoonSHOT",
// "even" matched "sEVEN", "soon" matched "SOON-heon" — letting hype/idiom tweets
// ground on coincidental substrings. Word boundaries kill that class.
//
// Tradeoff: misses some plural/stem variants (e.g. token "election" won't match
// "elections"). Acceptable — grounding deliberately biases toward silence over a
// wrong public reply, and genuine questions usually share several topic words.

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

export function containsWord(haystackLower: string, wordLower: string): boolean {
  if (!wordLower) return false;
  return new RegExp(`\\b${wordLower.replace(REGEX_SPECIAL, '\\$&')}\\b`).test(haystackLower);
}
