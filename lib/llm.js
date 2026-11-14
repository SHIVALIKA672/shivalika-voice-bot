// Provider layer. Every provider here speaks the OpenAI-compatible API, so one
// code path covers Groq (free), Google Gemini (free tier) and OpenAI (paid).
// Models get retired often, so each provider has an ordered list of models and
// we fall through to the next one on "model not found", rate limits or outages.

const PROVIDERS = {
  groq: {
    keyEnv: ['GROQ_API_KEY'],
    base: 'https://api.groq.com/openai/v1',
    chatModels: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
    sttModels: ['whisper-large-v3-turbo', 'whisper-large-v3'],
  },
  gemini: {
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // Lite models answer in ~1 s, which matters for voice.
    chatModels: ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-3.5-flash'],
    sttModels: [],
  },
  openai: {
    keyEnv: ['OPENAI_API_KEY'],
    base: 'https://api.openai.com/v1',
    chatModels: ['gpt-4.1-mini', 'gpt-4o-mini', 'gpt-5-mini'],
    sttModels: ['gpt-4o-mini-transcribe', 'whisper-1'],
  },
};
const ORDER = ['groq', 'gemini', 'openai'];

function keyFor(p) {
  for (const name of p.keyEnv) {
    const v = (process.env[name] || '').trim();
    if (v) return v;
  }
  return '';
}

function configured() {
  const preferred = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
  const order = preferred && PROVIDERS[preferred] ? [preferred, ...ORDER.filter((x) => x !== preferred)] : ORDER;
  return order
    .map((id) => ({ id, ...PROVIDERS[id], key: keyFor(PROVIDERS[id]) }))
    .filter((p) => p.key);
}

export function llmAvailable() {
  return configured().length > 0;
}
export function sttAvailable() {
  return configured().some((p) => p.sttModels.length > 0);
}

// Per-model request extras. Reasoning models get a low reasoning budget so the
// reply comes back fast enough for a voice conversation.
function extrasFor(providerId, model) {
  if (model.includes('gpt-oss')) {
    return { temperature: 0.7, max_completion_tokens: 1200, reasoning_effort: 'low', include_reasoning: false };
  }
  if (model.startsWith('qwen/')) {
    return { temperature: 0.7, max_completion_tokens: 600, reasoning_effort: 'none' };
  }
  if (providerId === 'openai' && /^(gpt-5|o\d)/.test(model)) {
    return { max_completion_tokens: 1500, reasoning_effort: 'minimal' };
  }
  if (providerId === 'gemini') {
    return { temperature: 0.7, max_tokens: 1500, reasoning_effort: 'low' };
  }
  return { temperature: 0.7, max_tokens: 450 };
}

async function postJson(url, key, body, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
  return { status: res.status, ok: res.ok, json, text };
}

function contentOf(json) {
  const msg = json?.choices?.[0]?.message;
  let c = msg?.content;
  if (Array.isArray(c)) c = c.map((part) => part?.text || '').join('');
  return typeof c === 'string' ? c.trim() : '';
}

let lastGood = null; // { id, model } that worked most recently on this instance

export async function chat(messages) {
  const providers = configured();
  if (!providers.length) throw new Error('No LLM API key configured');

  const attempts = [];
  for (const p of providers) {
    const forced = p.id === (process.env.LLM_PROVIDER || '').trim().toLowerCase() ? (process.env.LLM_MODEL || '').trim() : '';
    let models = forced ? [forced, ...p.chatModels.filter((m) => m !== forced)] : [...p.chatModels];
    if (lastGood?.id === p.id) models = [lastGood.model, ...models.filter((m) => m !== lastGood.model)];
    for (const model of models) attempts.push({ p, model });
  }

  const deadline = Date.now() + 25000;
  const errors = [];
  const deadProviders = new Set();

  for (const { p, model } of attempts) {
    if (deadProviders.has(p.id)) continue;
    const remaining = deadline - Date.now();
    if (remaining < 2000) break;
    const url = `${p.base}/chat/completions`;
    try {
      let r = await postJson(url, p.key, { model, messages, ...extrasFor(p.id, model) }, Math.min(15000, remaining));
      const modelGone = /does not exist|not found|decommissioned|deprecated|no longer (supported|available)|invalid model|model_not_found/i;
      if (r.status === 400 && !modelGone.test(r.text.slice(0, 400))) {
        // Some models reject optional params (reasoning_effort, temperature…). Retry bare.
        r = await postJson(url, p.key, { model, messages }, Math.min(15000, deadline - Date.now()));
      }
      if (r.ok) {
        const text = contentOf(r.json);
        if (text) {
          lastGood = { id: p.id, model };
          return { text, provider: p.id, model };
        }
        errors.push(`${p.id}/${model}: empty reply`);
        continue;
      }
      errors.push(`${p.id}/${model}: HTTP ${r.status} ${r.text.slice(0, 160)}`);
      if (r.status === 401) deadProviders.add(p.id); // bad key — skip this provider's other models
    } catch (err) {
      errors.push(`${p.id}/${model}: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`);
    }
  }
  throw new Error(`All LLM attempts failed → ${errors.join(' | ')}`);
}

// ── Natural-sounding speech ─────────────────────────────────────────────────
// 1. Groq Orpheus: fastest. Free, but the Groq account owner must accept the
//    model's terms once in the Groq console.
// 2. Gemini TTS: free tier, no extra setup, a little slower to start.
// If both are unavailable the page falls back to the browser's built-in voices.
export const NEURAL_VOICES = ['hannah', 'autumn', 'diana', 'austin', 'daniel', 'troy'];
const GEMINI_VOICE = { hannah: 'Leda', autumn: 'Aoede', diana: 'Kore', austin: 'Puck', daniel: 'Charon', troy: 'Fenrir' };
const GEMINI_TTS_MODELS = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts', 'gemini-2.5-flash-preview-tts'];
const blockedUntil = { groq: 0, gemini: 0 };

export function ttsAvailable() {
  const now = Date.now();
  return (!!keyFor(PROVIDERS.groq) && now >= blockedUntil.groq) || (!!keyFor(PROVIDERS.gemini) && now >= blockedUntil.gemini);
}

async function groqSpeech(key, text, voice) {
  const res = await fetch(`${PROVIDERS.groq.base}/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: (process.env.TTS_MODEL || 'canopylabs/orpheus-v1-english').trim(),
      voice,
      input: text,
      response_format: 'wav',
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = Object.assign(new Error(`groq TTS HTTP ${res.status} ${body.slice(0, 160)}`), { status: res.status });
    if (/terms/i.test(body)) { err.code = 'terms'; blockedUntil.groq = Date.now() + 2 * 60_000; }
    else if (res.status === 429) { err.code = 'rate'; blockedUntil.groq = Date.now() + 30_000; }
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

function pcmToWav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function geminiSpeech(key, text, voice) {
  let lastErr;
  for (const model of GEMINI_TTS_MODELS) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        // Plain text only: some TTS models read style instructions out loud.
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE[voice] || 'Leda' } } },
        },
      }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.text();
    if (!res.ok) {
      lastErr = Object.assign(new Error(`gemini TTS ${model} HTTP ${res.status} ${body.slice(0, 160)}`), { status: res.status });
      if (res.status === 429) { lastErr.code = 'rate'; continue; }
      if (res.status === 401 || res.status === 403) break;
      continue;
    }
    let part;
    try { part = JSON.parse(body).candidates?.[0]?.content?.parts?.find((p) => p.inlineData); } catch { part = null; }
    if (!part) { lastErr = new Error(`gemini TTS ${model}: no audio`); continue; }
    const bytes = Buffer.from(part.inlineData.data, 'base64');
    const mime = String(part.inlineData.mimeType || '');
    if (/wav/i.test(mime)) return bytes;
    const rate = Number((mime.match(/rate=(\d+)/) || [])[1]) || 24000;
    return pcmToWav(bytes, rate);
  }
  if (lastErr?.code === 'rate') blockedUntil.gemini = Date.now() + 60_000;
  throw lastErr || new Error('gemini TTS failed');
}

export async function synthesize(text, voice) {
  const now = Date.now();
  const errors = [];
  const groqKey = keyFor(PROVIDERS.groq);
  if (groqKey && now >= blockedUntil.groq) {
    try { return { wav: await groqSpeech(groqKey, text, voice), provider: 'groq' }; } catch (err) { errors.push(err); }
  }
  const gemKey = keyFor(PROVIDERS.gemini);
  if (gemKey && now >= blockedUntil.gemini) {
    try { return { wav: await geminiSpeech(gemKey, text, voice), provider: 'gemini' }; } catch (err) { errors.push(err); }
  }
  const err = new Error(errors.map((e) => e.message).join(' | ') || 'No natural voice configured');
  err.status = errors.some((e) => e.code === 'rate') ? 429 : errors.length ? 502 : 501;
  err.code = errors.some((e) => e.code === 'rate') ? 'rate' : errors.length ? 'error' : 'none';
  throw err;
}

const EXT = [
  ['webm', 'webm'], ['ogg', 'ogg'], ['mp4', 'mp4'], ['m4a', 'm4a'], ['aac', 'm4a'],
  ['mpeg', 'mp3'], ['mp3', 'mp3'], ['wav', 'wav'], ['flac', 'flac'],
];
function fileNameFor(mimeType) {
  const m = String(mimeType || '').toLowerCase();
  const hit = EXT.find(([needle]) => m.includes(needle));
  return `speech.${hit ? hit[1] : 'webm'}`;
}

// Whisper sometimes "hears" these stock phrases in silence or noise.
const HALLUCINATIONS = /^(thank you( (so much|very much))?|thanks( for watching)?|you|bye|okay|subtitles by.*|\.+)[.!?]*$/i;

export async function transcribe(audioBuffer, mimeType, hint = '') {
  const providers = configured().filter((p) => p.sttModels.length);
  if (!providers.length) throw new Error('No speech-to-text provider configured');
  const language = process.env.STT_LANGUAGE === undefined ? 'en' : process.env.STT_LANGUAGE.trim();
  const errors = [];

  for (const p of providers) {
    const forced = (process.env.STT_MODEL || '').trim();
    const models = forced ? [forced, ...p.sttModels.filter((m) => m !== forced)] : p.sttModels;
    for (const model of models) {
      const form = new FormData();
      form.append('file', new Blob([audioBuffer], { type: mimeType || 'audio/webm' }), fileNameFor(mimeType));
      form.append('model', model);
      form.append('response_format', 'json');
      form.append('temperature', '0');
      if (language) form.append('language', language);
      if (hint) form.append('prompt', hint);
      try {
        const res = await fetch(`${p.base}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${p.key}` },
          body: form,
          signal: AbortSignal.timeout(20000),
        });
        const text = await res.text();
        if (!res.ok) {
          errors.push(`${p.id}/${model}: HTTP ${res.status} ${text.slice(0, 160)}`);
          if (res.status === 401) break;
          continue;
        }
        let out = '';
        try { out = String(JSON.parse(text).text || ''); } catch { out = text; }
        out = out.trim();
        return HALLUCINATIONS.test(out) ? '' : out;
      } catch (err) {
        errors.push(`${p.id}/${model}: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`);
      }
    }
  }
  throw new Error(`All transcription attempts failed → ${errors.join(' | ')}`);
}
