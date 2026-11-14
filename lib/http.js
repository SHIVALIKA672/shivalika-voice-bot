// Tiny helpers shared by the API functions. Pure Node, so the same handlers
// run on Vercel (api/*.js) and on any Node host via server.js.

export function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

// Vercel pre-parses JSON into req.body; server.js does the same. Fall back to
// reading the stream ourselves in case neither did.
export async function readJson(req, limitBytes = 6 * 1024 * 1024) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body); } catch { return {}; }
    }
    if (Buffer.isBuffer(req.body)) {
      try { return JSON.parse(req.body.toString('utf8')); } catch { return {}; }
    }
    return req.body || {};
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

// Best-effort per-IP rate limit. On serverless each warm instance keeps its own
// counters, so this only blunts bursts — the provider's own limits are the backstop.
const buckets = new Map();
export function rateLimited(req, name, limit, windowMs) {
  const fwd = String(req.headers['x-forwarded-for'] || '');
  const ip = fwd.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  const key = `${name}:${ip}`;
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) buckets.clear();
  return hits.length > limit;
}
