import persona from '../persona.js';
import { chat } from '../lib/llm.js';
import { buildSystemPrompt, cleanForSpeech, fallbackAnswer } from '../lib/prompt.js';
import { readJson, rateLimited, sendJson } from '../lib/http.js';

const MAX_QUESTION = 600;
const MAX_TURNS = 6;

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });
  if (rateLimited(req, 'chat', 30, 60_000)) {
    return sendJson(res, 429, { reply: "You're asking faster than I can think! Give me a few seconds and try again." });
  }

  let body;
  try { body = await readJson(req); } catch { return sendJson(res, 413, { error: 'Request too large' }); }
  const question = String(body.message || '').trim().slice(0, MAX_QUESTION);
  if (!question) return sendJson(res, 400, { error: 'Empty question' });

  const history = sanitizeHistory(body.history);
  // Rank follow-up answers against this question plus the previous one, so
  // short follow-ups ("why?", "tell me more") still pull the right context.
  const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content || '';
  const messages = [
    { role: 'system', content: buildSystemPrompt(persona, `${question} ${lastUser}`) },
    ...history,
    { role: 'user', content: question },
  ];

  try {
    const r = await chat(messages);
    const reply = cleanForSpeech(r.text) || fallbackAnswer(persona, question);
    return sendJson(res, 200, { reply, source: 'llm', model: `${r.provider}/${r.model}` });
  } catch (err) {
    console.error('[chat]', err.message);
    return sendJson(res, 200, { reply: fallbackAnswer(persona, question), source: 'fallback' });
  }
}
