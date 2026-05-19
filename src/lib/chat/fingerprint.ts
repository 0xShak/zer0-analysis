// Per zer0.md §6 / prompt1 §3: fingerprint = sha256(zer0_sid : ip : sha256(ua)).
// Re-exports the canonical implementation in src/lib/fingerprint.ts so we have
// a single source of truth, but lives under src/lib/chat/ for discoverability
// alongside the other chat helpers.
export { computeFingerprint as computeFingerprintRaw, clientIpFromHeaders } from '../fingerprint';
import { computeFingerprint as raw } from '../fingerprint';

export function computeFingerprint(zer0_sid: string, ip: string, ua: string): string {
  return raw({ sid: zer0_sid, ip, ua });
}
