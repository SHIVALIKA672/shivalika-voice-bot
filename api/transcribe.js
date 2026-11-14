import persona from '../persona.js';
import { transcribe } from '../lib/llm.js';
import { displayName } from '../lib/prompt.js';
import { readJson, rateLimited, sendJson } from '../lib/http.js';

// Vercel caps request bodies at 4.5 MB; ~30 s of Opus audio is well under that.
const MAX_BASE64 = 4_000_000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });
  if (rateLimited(req, 'stt', 30, 60_000)) return sendJson(res, 429, { error: 'Too many requests, slow down a little.' });

  let body;
  try { body = await readJson(req); } catch { return sendJson(res, 413, { error: 'Recording too long' }); }
  const b64 = String(body.audio || '');
  if (!b64) return sendJson(res, 400, { error: 'No audio received' });
  if (b64.length > MAX_BASE64) return sendJson(res, 413, { error: 'Recording too long, keep questions under 30 seconds.' });

  const mimeType = String(body.mimeType || 'audio/webm').slice(0, 80);
  const audio = Buffer.from(b64, 'base64');
  if (audio.length < 800) return sendJson(res, 200, { text: '' });

  try {
    const hint = `A recruiter asks ${displayName(persona)} interview questions.`;
    const text = await transcribe(audio, mimeType, hint);
    return sendJson(res, 200, { text });
  } catch (err) {
    console.error('[transcribe]', err.message);
    return sendJson(res, 502, { error: "Couldn't transcribe that. Please try again, or type your question." });
  }
}
