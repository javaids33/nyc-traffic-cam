/* GET /api/challenges/:hash — retrieve a stored challenge.
 *
 * KV provides native TTL expiration so a missing key past 24h is
 * indistinguishable from a never-existed key — both return 404, which
 * matches what the frontend already handles.
 */

interface Env {
  CHALLENGES: KVNamespace;
}

const HASH_RE = /^[A-Z0-9]{4,12}$/;

export const onRequestGet: PagesFunction<Env> = async ({ params, env }) => {
  const hash = String(params.hash || '');
  if (!HASH_RE.test(hash)) {
    return new Response(JSON.stringify({ detail: 'bad hash format' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const data = await env.CHALLENGES.get(`ch:${hash}`);
  if (!data) {
    return new Response(
      JSON.stringify({ detail: 'challenge not found or expired' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(data, { headers: { 'content-type': 'application/json' } });
};
