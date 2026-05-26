/* POST /api/challenges — mint a BOROUGH BLITZ challenge.
 *
 * Cloudflare Pages Function, same origin as the static site. Storage is
 * CF KV with native expirationTtl, so expired entries vanish on their own
 * (no sweep). Two players opening the same `?h=<hash>` link play the exact
 * same 5 cameras even if the upstream camera pool changes.
 *
 * KV binding: CHALLENGES (see wrangler.jsonc / Pages project settings).
 *   - camera IDs validated as UUIDs
 *   - 24h TTL
 *   - 30 creates / IP / hour
 *   - 6-char hash, no I/O/0/1 ambiguity
 *   - optional difficulty + modifiers ride along so the banner reads right
 */

interface Env {
  CHALLENGES: KVNamespace;
}

const HASH_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TTL_SECONDS = 24 * 60 * 60;
const RATE_WINDOW = 60 * 60;
const RATE_LIMIT = 30;

const UUID_RE = /^[0-9a-fA-F-]{36}$/;
const DIFFICULTIES = new Set(['easy', 'medium', 'hard', 'daily']);

function makeHash(): string {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    out += HASH_ALPHABET[buf[i] % HASH_ALPHABET.length];
  }
  return out;
}

function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',', 1)[0]?.trim() ||
    'unknown'
  );
}

async function checkRateLimit(env: Env, ip: string): Promise<boolean> {
  const key = `rl:${ip}`;
  const cur = parseInt((await env.CHALLENGES.get(key)) ?? '0', 10) || 0;
  if (cur >= RATE_LIMIT) return false;
  await env.CHALLENGES.put(key, String(cur + 1), { expirationTtl: RATE_WINDOW });
  return true;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const ip = clientIp(request);
  if (!(await checkRateLimit(env, ip))) {
    return json({ detail: 'rate limit exceeded — try again later' }, 429);
  }

  let body: { cameras?: unknown; score?: unknown; grade?: unknown; difficulty?: unknown; modifiers?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ detail: 'invalid json' }, 400);
  }

  const cameras = body.cameras;
  if (!Array.isArray(cameras) || cameras.length < 1 || cameras.length > 10) {
    return json({ detail: 'cameras must be 1-10 uuids' }, 400);
  }
  for (const cid of cameras) {
    if (typeof cid !== 'string' || !UUID_RE.test(cid)) {
      return json({ detail: `bad camera id: ${cid}` }, 400);
    }
  }

  const score =
    typeof body.score === 'number' && body.score >= 0 && body.score <= 100_000
      ? Math.floor(body.score)
      : null;
  const grade =
    typeof body.grade === 'string' && body.grade.length <= 64 ? body.grade : null;
  const difficulty =
    typeof body.difficulty === 'string' && DIFFICULTIES.has(body.difficulty)
      ? body.difficulty
      : null;
  // modifiers is a tiny opaque record (grayscale/timer/noZoom). Cap its
  // serialized size so we never store something silly.
  let modifiers: unknown = null;
  if (body.modifiers && typeof body.modifiers === 'object') {
    const s = JSON.stringify(body.modifiers);
    if (s.length <= 200) modifiers = body.modifiers;
  }

  for (let i = 0; i < 6; i++) {
    const hash = makeHash();
    const key = `ch:${hash}`;
    if (await env.CHALLENGES.get(key)) continue; // collision, retry
    const payload = {
      hash,
      cameras,
      score,
      grade,
      difficulty,
      modifiers,
      created_at: Math.floor(Date.now() / 1000),
      expires_at: Math.floor(Date.now() / 1000) + TTL_SECONDS,
    };
    await env.CHALLENGES.put(key, JSON.stringify(payload), { expirationTtl: TTL_SECONDS });
    return json({ hash, expires_in_seconds: TTL_SECONDS });
  }
  return json({ detail: 'could not allocate hash' }, 500);
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
