/* POST /api/challenges — create a geoguessr challenge.
 *
 * Runs as a Cloudflare Pages Function at the same origin as the
 * static site. Storage is CF KV with native expirationTtl, so we
 * don't need to sweep expired entries — they vanish automatically.
 *
 * KV binding name: CHALLENGES (set in wrangler.jsonc / Pages settings)
 *
 * Behavior matches the Fly endpoint that this replaces:
 *   - Validates camera IDs as UUIDs
 *   - 24h TTL
 *   - 30-creates/IP/hour rate limit (also via KV, separate keyspace)
 *   - 6-char hash with no I/O/0/1 ambiguity
 */

interface Env {
  CHALLENGES: KVNamespace;
}

const HASH_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TTL_SECONDS = 24 * 60 * 60;
const RATE_WINDOW = 60 * 60;
const RATE_LIMIT = 30;

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

function makeHash(): string {
  // crypto.getRandomValues for proper entropy in the Workers runtime.
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
  // KV is eventually-consistent (10s typical), but for casual rate
  // limiting that's fine — the worst case is a small over-allowance.
  const key = `rl:${ip}`;
  const cur = parseInt((await env.CHALLENGES.get(key)) ?? '0', 10) || 0;
  if (cur >= RATE_LIMIT) return false;
  await env.CHALLENGES.put(key, String(cur + 1), { expirationTtl: RATE_WINDOW });
  return true;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const ip = clientIp(request);
  if (!(await checkRateLimit(env, ip))) {
    return new Response(
      JSON.stringify({ detail: 'rate limit exceeded — try again later' }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    );
  }

  let body: { cameras?: unknown; score?: unknown; grade?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ detail: 'invalid json' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const cameras = body.cameras;
  if (!Array.isArray(cameras) || cameras.length < 1 || cameras.length > 10) {
    return new Response(JSON.stringify({ detail: 'cameras must be 1-10 uuids' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  for (const cid of cameras) {
    if (typeof cid !== 'string' || !UUID_RE.test(cid)) {
      return new Response(JSON.stringify({ detail: `bad camera id: ${cid}` }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
  }

  const score =
    typeof body.score === 'number' && body.score >= 0 && body.score <= 100_000
      ? Math.floor(body.score)
      : null;
  const grade =
    typeof body.grade === 'string' && body.grade.length <= 64 ? body.grade : null;

  // Generate a hash, retry on the rare collision.
  for (let i = 0; i < 6; i++) {
    const hash = makeHash();
    const key = `ch:${hash}`;
    const existing = await env.CHALLENGES.get(key);
    if (existing) continue; // collision, try again
    const payload = {
      hash,
      cameras,
      score,
      grade,
      created_at: Math.floor(Date.now() / 1000),
      expires_at: Math.floor(Date.now() / 1000) + TTL_SECONDS,
    };
    await env.CHALLENGES.put(key, JSON.stringify(payload), { expirationTtl: TTL_SECONDS });
    return new Response(
      JSON.stringify({ hash, expires_in_seconds: TTL_SECONDS }),
      { headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(JSON.stringify({ detail: 'could not allocate hash' }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  });
};
