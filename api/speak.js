import persona from '../persona.js';
import { NEURAL_VOICES, synthesize } from '../lib/llm.js';
import { readJson, rateLimited, sendJson } from '../lib/http.js';

// Text → natural speech (WAV). The page sends one sentence-sized chunk at a
// time (the model takes at most 200 characters per request).
export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });
  if (rateLimited(req, 'tts', 90, 60_000)) return sendJson(res, 429, { error: 'Too many requests', code: 'rate' });

  let body;
  try { body = await readJson(req); } catch { return sendJson(res, 413, { error: 'Too large' }); }
  const text = String(body.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return sendJson(res, 400, { error: 'No text' });
  if (text.length > 200) return sendJson(res, 400, { error: 'Text too long (max 200 characters)' });

  const fallback = String(persona.voice?.neural || 'hannah').toLowerCase();
  const asked = String(body.voice || '').toLowerCase();
  const voice = NEURAL_VOICES.includes(asked) ? asked : fallback;

  try {
    const { wav, provider } = await synthesize(text, voice);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Voice-Provider', provider);
    res.end(wav);
  } catch (err) {
    console.error('[speak]', err.message);
    const status = err.code === 'rate' ? 429 : err.code === 'none' ? 501 : 502;
    return sendJson(res, status, { error: 'Natural voice unavailable', code: err.code || 'error' });
  }
}
