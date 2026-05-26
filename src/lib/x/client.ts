import crypto from 'node:crypto';
import { env } from '../env';

// Minimal X (Twitter) API v2 client for posting tweets as @atzer0_BOT.
//
// We sign with OAuth 1.0a user context rather than pull in a dependency: the
// only call we make is POST /2/tweets, and the signing is ~40 lines of Node
// crypto. Credentials (see env.ts):
//   X_API_KEY / X_API_SECRET            — @0xAhrii's app consumer credentials
//   X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET — @atzer0_BOT's per-user tokens
// The user tokens decide which account the tweet appears under — they MUST be
// the persona's, not the app owner's.

const TWEETS_ENDPOINT = 'https://api.twitter.com/2/tweets';

// RFC 3986 percent-encoding. encodeURIComponent already leaves the unreserved
// set (A-Za-z0-9-_.~) alone but does NOT escape ! * ' ( ) — OAuth requires
// those escaped, so we finish the job.
export function rfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

// Pure OAuth 1.0a HMAC-SHA1 signature over the given params. Exported so the
// algorithm can be tested against X's published signature vector — a wrong
// signature only surfaces as a runtime 401. `params` is the full set being
// signed (oauth_* plus any query/form params); for our JSON-body POST it's
// just the oauth_* params, since a JSON body contributes nothing to the base
// string — the well-known v2 POST /tweets gotcha.
export function oauthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): string {
  const paramString = Object.keys(params)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k])}`)
    .join('&');
  const baseString = [
    method.toUpperCase(),
    rfc3986(url),
    rfc3986(paramString),
  ].join('&');
  const signingKey = `${rfc3986(consumerSecret)}&${rfc3986(tokenSecret)}`;
  return crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
}

function authHeader(method: string, url: string): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  const signature = oauthSignature(
    method,
    url,
    oauth,
    env.X_API_SECRET,
    env.X_ACCESS_TOKEN_SECRET,
  );
  const header: Record<string, string> = { ...oauth, oauth_signature: signature };
  return (
    'OAuth ' +
    Object.keys(header)
      .sort()
      .map((k) => `${rfc3986(k)}="${rfc3986(header[k])}"`)
      .join(', ')
  );
}

export type PostTweetResult =
  | { ok: true; id: string }
  | { ok: false; status: number; error: string };

// Posts a single tweet. Never throws — callers run inside Inngest steps and a
// thrown error would retry the whole step; we'd rather surface a structured
// failure so the caller can release its idempotency claim and move on.
export async function postTweet(text: string): Promise<PostTweetResult> {
  try {
    const resp = await fetch(TWEETS_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: authHeader('POST', TWEETS_ENDPOINT),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, status: resp.status, error: body.slice(0, 500) };
    }
    const json = (await resp.json()) as { data?: { id?: string } };
    const id = json.data?.id;
    if (!id) return { ok: false, status: resp.status, error: 'no tweet id in X response' };
    return { ok: true, id };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
