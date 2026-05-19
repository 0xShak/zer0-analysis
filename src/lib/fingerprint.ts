import { createHash } from 'node:crypto';

// Composite identifier: cookie + ip + ua (§6 in zer0.md).
// Get ~80% legit/abuse separation without privacy-invasive tracking.
export function computeFingerprint(args: { sid: string; ip: string; ua: string }): string {
  const uaHash = createHash('sha256').update(args.ua).digest('hex').slice(0, 16);
  return createHash('sha256')
    .update(`${args.sid}:${args.ip}:${uaHash}`)
    .digest('hex');
}

export function clientIpFromHeaders(h: Headers): string {
  return (
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    h.get('x-real-ip') ??
    h.get('cf-connecting-ip') ??
    '0.0.0.0'
  );
}
