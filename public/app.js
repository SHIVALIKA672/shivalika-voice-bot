// Voice bot front end. No build step, no libraries.
// Listen:  server Whisper (MediaRecorder → /api/transcribe), or the browser's
//          own speech recognition when the server has no speech-to-text key.
// Think:   /api/chat answers in the owner's voice.
// Speak:   natural AI voice (/api/speak, Groq Orpheus) when available,
//          otherwise the browser's built-in voices. Sentence by sentence,
//          with the sentence being spoken highlighted on screen.

const $ = (id) => document.getElementById(id);
const els = {
  log: $('log'), mic: $('mic'), status: $('status'), form: $('form'), input: $('input'), chips: $('chips'),
  name: $('name'), headline: $('headline'), avatar: $('avatar'), banner: $('banner'), badges: $('badges'),
  credit: $('credit'), handsFree: $('handsFree'),
  settings: $('settings'), settingsBtn: $('settingsBtn'), voiceSelect: $('voiceSelect'), voiceNote: $('voiceNote'),
  rate: $('rate'), rateOut: $('rateOut'), mute: $('mute'), testVoice: $('testVoice'),
};

const store = {
  get(k, d) { try { const v = localStorage.getItem('vb:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('vb:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const AC = window.AudioContext || window.webkitAudioContext;
const HAS_TTS = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
const SPEAKER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10v4h4l5 4V6L7 10H3Zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4Z"/></svg>';
const CHUNK = 160; // characters per spoken chunk (natural voice takes ≤ 200 after respelling)

// How common tech words should be said. persona.pronunciations adds to / overrides this.
const TECH_SAY = {
  'nudgecoshop.com': 'nudge co shop dot com',
  'shekl.ai': 'Shekl dot A I',
  'B.Tech': 'B Tech',
  'LLaMA': 'Llama',
  'PostgreSQL': 'Postgres',
  'MySQL': 'My S Q L',
  'SQLite': 'S Q Lite',
  'FastAPI': 'Fast A P I',
  'OpenRouter': 'Open Router',
  'OpenAI': 'Open A I',
  'LangChain': 'Lang Chain',
  'LangGraph': 'Lang Graph',
  'DeepSeek': 'Deep Seek',
  'GitHub': 'Git Hub',
  'Chronos-2': 'Kronos 2',
  'Chronos': 'Kronos',
  'Groq': 'Grok',
  'gpt-oss': 'G P T O S S',
  'LLMs': 'L L Ems',
  'LLM': 'L L M',
  'APIs': 'A P eyes',
  'API': 'A P I',
  'SOPs': 'S O Pees',
  'SOP': 'S O P',
  'MCP': 'M C P',
  'CGPI': 'C G P I',
  'CGPA': 'C G P A',
  'BM25': 'B M 25',
  'P10': 'P 10',
  'P90': 'P 90',
  'RAG': 'rag',
  'GLM': 'G L M',
  'ECS': 'E C S',
  'AWS': 'A W S',
  'CNN': 'C N N',
  'TTS': 'T T S',
  'STT': 'S T T',
  'NLP': 'N L P',
  'CSE': 'C S E',
  'CI/CD': 'C I C D',
  'SQL': 'sequel',
  'GenAI': 'Gen A I',
  'UI': 'U I',
  'UX': 'U X',
  'e.g.': 'for example',
  'i.e.': 'that is',
  'vs.': 'versus',
  'vs': 'versus',
  'etc.': 'etcetera',
};

const state = {
  phase: 'idle',
  config: { name: 'Me', headline: '', greeting: '', suggestedQuestions: [], voice: {}, sttAvailable: false, llmAvailable: true },
  history: [],
  sttMode: 'none',
  voices: [],
  voicePick: store.get('voicePick', null), // 'neural:hannah' | 'browser:<voiceURI>'
  rate: store.get('rate', null),
  muted: store.get('muted', false),
  handsFree: store.get('handsFree', false),
  sayList: [],
  turn: 0,          // bumps on every new question; stale async work checks it and bails
  speakToken: 0,
  speakResolve: null,
  speakTimer: 0,
  recorder: null,   // active listening session: { stop(reason) }
  interimEl: null,
  speakingEl: null,
  thinkingTimer: 0,
  unlocked: false,
};

const audio = { ctx: null, analyser: null, stop: null, abort: null, disabled: false, retryAt: 0, cache: new Map(), metering: false };

// ── UI state ────────────────────────────────────────────────────────────────
const STATUS = {
  idle: 'Tap the mic and ask a question',
  listening: "Listening… tap again when you're done",
  transcribing: 'Got it, one sec…',
  thinking: 'Thinking…',
  speaking: 'Speaking… tap the button to interrupt',
};
const MIC_LABEL = {
  idle: 'Start talking', listening: 'Stop and send', transcribing: 'Working', thinking: 'Working',
  speaking: 'Stop speaking and ask another question',
};
const busy = () => state.phase === 'thinking' || state.phase === 'transcribing';

function setPhase(phase, message, isError = false) {
  state.phase = phase;
  document.body.dataset.phase = phase;
  els.status.textContent = message || STATUS[phase];
  els.status.classList.toggle('error', !!isError);
  els.mic.setAttribute('aria-label', MIC_LABEL[phase]);
  if (phase !== 'listening' && phase !== 'speaking') els.mic.style.setProperty('--level', 0);
  if (phase !== 'thinking') clearInterval(state.thinkingTimer);
  if (phase !== 'speaking') document.body.classList.remove('breathe');
}

function startThinkingLines() {
  const lines = (state.config.thinkingLines || []).filter(Boolean);
  setPhase('thinking', lines[0]);
  if (lines.length < 2) return;
  let i = 0;
  state.thinkingTimer = setInterval(() => {
    if (state.phase !== 'thinking') return clearInterval(state.thinkingTimer);
    els.status.textContent = lines[++i % lines.length];
  }, 1700);
}

function scrollDown() { els.log.scrollTop = els.log.scrollHeight; }

// ── Text helpers ────────────────────────────────────────────────────────────
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildSayList() {
  const merged = { ...TECH_SAY, ...(state.config.pronunciations || {}) };
  state.sayList = Object.entries(merged)
    .filter(([word, spoken]) => word && spoken)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([word, spoken]) => [new RegExp(`(^|[^\\w])${escapeRe(word)}(?![\\w])`, 'gi'), spoken]);
}

// What the voice should actually say. Display text is never changed.
function forSpeech(text) {
  let out = String(text).replace(/[‐‑‒]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  for (const [re, spoken] of state.sayList) out = out.replace(re, (_, pre) => pre + spoken);
  return out
    .replace(/(\d)\s*%/g, '$1 percent')
    .replace(/\s&\s/g, ' and ')
    .replace(/(\w)\/(\w)/g, '$1 $2')
    .replace(/[*_#`~<>[\]{}|]/g, ' ')
    .replace(/\s{2,}/g, ' ');
}

// Split into sentences, but not at decimals ("3.1") or inside "B.Tech".
function sentencesOf(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if ('.!?…'.includes(text[i])) {
      let j = i + 1;
      while (j < text.length && '"\')]”’'.includes(text[j])) j++;
      if (j >= text.length || /\s/.test(text[j])) {
        while (j < text.length && /\s/.test(text[j])) j++;
        out.push(text.slice(start, j));
        start = j;
        i = j - 1;
      }
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

// Sentence-sized chunks, joined back they equal the original text exactly.
// The first chunk is kept short so the voice starts sooner; the rest are
// generated while it plays.
const FIRST_CHUNK = 90;
function splitLong(s, max) {
  const parts = [];
  let rest = s;
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf(', ', max), rest.lastIndexOf('; ', max), rest.lastIndexOf(': ', max), rest.lastIndexOf(' — ', max));
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) parts.push(rest);
  return parts;
}
function chunksFor(text, max = CHUNK) {
  const sentences = sentencesOf(String(text));
  const pieces = [];
  sentences.forEach((s, i) => pieces.push(...splitLong(s, i === 0 ? FIRST_CHUNK : max)));
  const out = [];
  let buf = '';
  for (const p of pieces) {
    const limit = out.length === 0 ? FIRST_CHUNK : max;
    if (buf && (buf + p).length > limit) { out.push(buf); buf = p; } else buf += p;
  }
  if (buf) out.push(buf);
  return out.length ? out : [String(text)];
}

// ── Messages ────────────────────────────────────────────────────────────────
function addMessage(who, text) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${who}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (who === 'bot') {
    wrap.segs = chunksFor(text).map((chunk) => {
      const span = document.createElement('span');
      span.className = 'seg';
      span.textContent = chunk;
      bubble.append(span);
      return span;
    });
  } else {
    bubble.textContent = text;
  }
  wrap.append(bubble);
  if (who === 'bot') {
    const meta = document.createElement('div');
    meta.className = 'meta';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'replay';
    btn.innerHTML = `${SPEAKER}<span>Play</span>`;
    btn.setAttribute('aria-label', 'Play this answer');
    btn.addEventListener('click', () => { unlockAudio(); replay(text, wrap); });
    meta.append(btn);
    wrap.append(meta);
  }
  els.log.append(wrap);
  scrollDown();
  return wrap;
}

function addTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'msg bot typing';
  wrap.innerHTML = '<div class="bubble" aria-label="Thinking"><span></span><span></span><span></span></div>';
  els.log.append(wrap);
  scrollDown();
  return wrap;
}

function setInterim(text) {
  if (!text) return;
  if (!state.interimEl) {
    state.interimEl = addMessage('you', text);
    state.interimEl.classList.add('interim');
  } else {
    state.interimEl.querySelector('.bubble').textContent = text;
  }
  scrollDown();
}
function clearInterim() { state.interimEl?.remove(); state.interimEl = null; }

function highlight(wrap, i) {
  if (!wrap?.segs) return;
  wrap.segs.forEach((s, k) => s.classList.toggle('now', k === i));
}
function clearHighlight() {
  state.speakingEl?.segs?.forEach((s) => s.classList.remove('now'));
  state.speakingEl = null;
}

// ── Audio unlock ────────────────────────────────────────────────────────────
function getCtx() {
  if (!audio.ctx && AC) { try { audio.ctx = new AC(); } catch { audio.ctx = null; } }
  return audio.ctx;
}

// Mobile browsers only allow sound that was started inside a tap, so the first
// tap anywhere wakes up both the audio engine and speech synthesis.
function unlockAudio() {
  const ctx = getCtx();
  if (ctx && ctx.state !== 'running') {
    try {
      ctx.resume();
      const b = ctx.createBuffer(1, 1, 22050);
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(ctx.destination);
      s.start(0);
    } catch { /* ignore */ }
  }
  if (state.unlocked || !HAS_TTS) return;
  state.unlocked = true;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch { /* ignore */ }
}

// ── Voice choice ────────────────────────────────────────────────────────────
function neuralOffered() {
  const n = state.config.neural;
  return !!(n && n.available && !audio.disabled && AC);
}

function currentPick() {
  const pick = state.voicePick;
  if (pick?.startsWith('neural:') && neuralOffered() && state.config.neural.choices.some((c) => `neural:${c.id}` === pick)) return pick;
  if (pick?.startsWith('browser:') && state.voices.some((v) => `browser:${v.voiceURI}` === pick)) return pick;
  if (neuralOffered()) return `neural:${state.config.neural.default}`;
  return state.voices[0] ? `browser:${state.voices[0].voiceURI}` : '';
}

function browserVoice() {
  const pick = currentPick();
  if (pick.startsWith('browser:')) return state.voices.find((v) => `browser:${v.voiceURI}` === pick) || state.voices[0] || null;
  return state.voices[0] || null;
}

const speechRate = () => Number(state.rate ?? state.config.voice?.rate ?? 1) || 1;

const NOVELTY = /compact|espeak|novelty|bad news|good news|bells|boing|bubbles|cellos|zarvox|trinoids|albert|jester|organ|superstar|wobble|whisper|junior|ralph|fred|kathy|grandma|grandpa|rocko|shelley|flo|eddy|reed|sandy/;

function loadVoices() {
  if (!HAS_TTS) { fillVoiceSelect(); return; }
  const all = speechSynthesis.getVoices();
  const cfg = state.config.voice || {};
  const lang = String(cfg.lang || 'en-US').toLowerCase();
  const base = lang.split('-')[0];
  const prefer = (cfg.prefer || []).map((p) => String(p).toLowerCase());
  const avoid = (cfg.avoid || []).map((a) => new RegExp(`\\b${escapeRe(a)}\\b`, 'i'));
  const score = (v) => {
    const n = v.name.toLowerCase();
    const l = v.lang.toLowerCase().replace('_', '-');
    let s = l === lang ? 30 : l.startsWith(base) ? 20 : -100;
    prefer.forEach((p, idx) => { if (n.includes(p)) s += Math.max(8, 40 - idx * 4); });
    if (avoid.some((re) => re.test(v.name))) s -= 50;
    if (/natural|neural/.test(n)) s += 15;
    if (/online/.test(n)) s += 5;
    if (/google/.test(n)) s += 8;
    if (/enhanced|premium/.test(n)) s += 10;
    if (NOVELTY.test(n)) s -= 60;
    return s;
  };
  state.voices = all.slice().sort((a, b) => score(b) - score(a));
  fillVoiceSelect();
}

function fillVoiceSelect() {
  const sel = els.voiceSelect;
  sel.innerHTML = '';
  if (neuralOffered()) {
    const g = document.createElement('optgroup');
    g.label = 'Natural AI voices';
    for (const c of state.config.neural.choices) {
      const o = document.createElement('option');
      o.value = `neural:${c.id}`;
      o.textContent = `${c.label} (natural)`;
      g.append(o);
    }
    sel.append(g);
  }
  const base = String(state.config.voice?.lang || 'en-US').toLowerCase().split('-')[0];
  const same = state.voices.filter((v) => v.lang.toLowerCase().startsWith(base));
  const list = same.length ? same : state.voices;
  if (list.length) {
    const g = document.createElement('optgroup');
    g.label = 'Browser voices';
    for (const v of list) {
      const o = document.createElement('option');
      o.value = `browser:${v.voiceURI}`;
      o.textContent = `${v.name} (${v.lang})`;
      g.append(o);
    }
    sel.append(g);
  }
  sel.value = currentPick();
  els.voiceNote.textContent = neuralOffered()
    ? 'Natural voices sound the most human. If one is busy, your browser’s voice takes over automatically.'
    : '';
}

// ── Speaking ────────────────────────────────────────────────────────────────
function stopSpeaking() {
  state.speakToken++;
  clearTimeout(state.speakTimer);
  if (HAS_TTS) speechSynthesis.cancel();
  audio.abort?.abort();
  audio.abort = null;
  audio.stop?.();
  clearHighlight();
  const resolve = state.speakResolve;
  state.speakResolve = null;
  resolve?.();
}

async function speak(text, wrap) {
  stopSpeaking();
  if (state.muted || !text) return;
  const my = state.speakToken;
  state.speakingEl = wrap || null;
  const onSeg = (i) => { if (my === state.speakToken) highlight(wrap, i); };
  const chunks = chunksFor(text);
  let from = 0;
  const pick = currentPick();
  if (pick.startsWith('neural:') && Date.now() >= audio.retryAt) {
    from = await speakNeural(chunks, my, onSeg, pick.slice(7));
    if (my !== state.speakToken) return;
  }
  if (from < chunks.length && HAS_TTS) {
    document.body.classList.add('breathe');
    await speakBrowser(chunks.slice(from), my, (i) => onSeg(i + from));
  }
  if (my === state.speakToken) clearHighlight();
}

function controllerAbort() { audio.abort?.abort(); audio.abort = null; }

async function fetchWav(text, voice, signal) {
  const key = `${voice}|${text}`;
  if (audio.cache.has(key)) return audio.cache.get(key);
  const r = await fetch('/api/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice }),
    signal,
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw Object.assign(new Error('tts'), { status: r.status, code: j.code });
  }
  const buf = await audio.ctx.decodeAudioData(await r.arrayBuffer());
  audio.cache.set(key, buf);
  if (audio.cache.size > 60) audio.cache.delete(audio.cache.keys().next().value);
  return buf;
}

function neuralFailed(err) {
  if (err?.name === 'AbortError') return;
  if ([400, 401, 403, 404, 501].includes(err?.status)) {
    audio.disabled = true; // natural voice not set up on the server: use browser voices
    fillVoiceSelect();
  } else if (err?.status === 504) {
    controllerAbort(); // too slow this time: browser voice for this answer only
  } else {
    audio.retryAt = Date.now() + 45_000; // busy or rate-limited: try again a bit later
  }
}

// Returns how many chunks it managed to speak; the caller speaks the rest with the browser voice.
async function speakNeural(chunks, my, onSeg, voice) {
  const ctx = getCtx();
  if (!ctx) return 0;
  try { if (ctx.state !== 'running') await ctx.resume(); } catch { /* ignore */ }
  if (ctx.state !== 'running') return 0;
  const controller = new AbortController();
  audio.abort = controller;
  const jobs = [];
  const job = (i) => {
    if (!jobs[i]) {
      const t = forSpeech(chunks[i]).trim();
      let p = t ? fetchWav(t, voice, controller.signal) : Promise.resolve(null);
      if (i === 0) {
        // Don't leave the listener in silence: if the natural voice is slow, use the browser voice this time.
        p = Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('slow'), { status: 504 })), 8000))]);
      }
      jobs[i] = p;
      jobs[i].catch(() => {});
    }
    return jobs[i];
  };
  job(0);
  for (let i = 0; i < chunks.length; i++) {
    let buf;
    try {
      buf = await job(i);
    } catch (err) {
      if (my !== state.speakToken) return chunks.length;
      neuralFailed(err);
      return i;
    }
    if (my !== state.speakToken) return chunks.length;
    if (i + 1 < chunks.length) job(i + 1); // fetch the next sentence while this one plays
    if (!buf) continue;
    onSeg(i);
    await playBuffer(buf);
    if (my !== state.speakToken) return chunks.length;
  }
  return chunks.length;
}

function playBuffer(buf) {
  return new Promise((resolve) => {
    const ctx = audio.ctx;
    if (!audio.analyser) {
      audio.analyser = ctx.createAnalyser();
      audio.analyser.fftSize = 512;
      audio.analyser.connect(ctx.destination);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.min(1.25, Math.max(0.8, speechRate()));
    src.connect(audio.analyser);
    let done = false;
    const finish = () => { if (!done) { done = true; audio.stop = null; resolve(); } };
    src.onended = finish;
    audio.stop = () => { try { src.stop(); } catch { /* already stopped */ } finish(); };
    src.start();
    meter();
  });
}

// Drive the glow around the button from the actual voice level.
function meter() {
  if (audio.metering || !audio.analyser) return;
  audio.metering = true;
  const data = new Uint8Array(audio.analyser.fftSize);
  const loop = () => {
    if (state.phase !== 'speaking' || !audio.stop) {
      audio.metering = false;
      return;
    }
    audio.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
    els.mic.style.setProperty('--level', Math.min(1, Math.sqrt(sum / data.length) * 5).toFixed(3));
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function speakBrowser(chunks, my, onSeg) {
  const cfg = state.config.voice || {};
  let i = 0;
  return new Promise((resolve) => {
    state.speakResolve = resolve;
    const finish = () => { if (state.speakResolve === resolve) state.speakResolve = null; resolve(); };
    const next = () => {
      clearTimeout(state.speakTimer);
      if (my !== state.speakToken || i >= chunks.length) return finish();
      const idx = i++;
      const spoken = forSpeech(chunks[idx]).trim();
      if (!spoken) return next();
      const u = new SpeechSynthesisUtterance(spoken);
      const v = browserVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = cfg.lang || 'en-US';
      u.rate = speechRate();
      u.pitch = Number(cfg.pitch ?? 1) || 1;
      let ended = false;
      const done = () => { if (!ended) { ended = true; next(); } };
      u.onend = done;
      u.onerror = done;
      (state.utterances ||= []).push(u); // keep a reference: Chrome can GC it and drop onend
      if (state.utterances.length > 40) state.utterances.splice(0, 20);
      const words = spoken.split(/\s+/).length;
      state.speakTimer = setTimeout(done, (words / 2.2) * 1000 / u.rate + 4000); // watchdog
      onSeg(idx);
      speechSynthesis.speak(u);
    };
    setTimeout(next, 60); // Chrome may drop an utterance queued in the same tick as cancel()
  });
}

async function say(text, turn, wrap) {
  if (state.muted || (!HAS_TTS && !AC)) { setPhase('idle'); afterAnswer(turn); return; }
  setPhase('speaking');
  await speak(text, wrap);
  if (turn === state.turn && state.phase === 'speaking') {
    setPhase('idle');
    afterAnswer(turn);
  }
}

// Hands-free: open the mic again once the answer has finished.
function afterAnswer(turn) {
  if (!state.handsFree || state.sttMode === 'none') return;
  setTimeout(() => {
    if (turn === state.turn && state.phase === 'idle') startListening();
  }, 400);
}

function replay(text, wrap) {
  if (busy()) return;
  if (state.phase === 'listening') state.recorder?.stop('cancel');
  const turn = ++state.turn;
  setPhase('speaking');
  speak(text, wrap).then(() => {
    if (turn === state.turn && state.phase === 'speaking') setPhase('idle');
  });
}

// ── Listening: server speech-to-text ────────────────────────────────────────
function micFailed(err) {
  const n = err?.name || '';
  let msg = "I couldn't use your microphone. You can type your question below.";
  if (n === 'NotAllowedError' || n === 'SecurityError') {
    msg = 'Microphone access is blocked. Allow it from the icon in the address bar and tap the mic again, or type below.';
  } else if (n === 'NotFoundError' || n === 'OverconstrainedError') {
    msg = 'No microphone found. You can type your question below.';
  }
  setPhase('idle', msg, true);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function startRecorder(turn) {
  // Create the AudioContext inside the tap, before any await (iOS requirement).
  let ctx = null;
  try { ctx = AC ? new AC() : null; } catch { ctx = null; }

  setPhase('listening', 'Allow the microphone if your browser asks…');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    try { ctx?.close(); } catch { /* ignore */ }
    if (turn === state.turn) micFailed(err);
    return;
  }
  if (turn !== state.turn) {
    stream.getTracks().forEach((t) => t.stop());
    try { ctx?.close(); } catch { /* ignore */ }
    return;
  }
  setPhase('listening');

  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
  const mimeType = types.find((t) => window.MediaRecorder.isTypeSupported?.(t)) || '';
  let rec;
  try { rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined); } catch { rec = new MediaRecorder(stream); }
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  // Voice-activity detection so the recording stops by itself after you finish.
  let analyser = null;
  let buf = null;
  if (ctx) {
    try { if (ctx.state === 'suspended') await ctx.resume(); } catch { /* ignore */ }
    try {
      const src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      buf = new Uint8Array(analyser.fftSize);
    } catch { analyser = null; }
  }
  const vad = !!analyser && ctx.state === 'running';

  const t0 = performance.now();
  let last = t0;
  let floor = 0.008;
  let speechMs = 0;
  let quietMs = 0;
  let heard = false;
  let stopping = false;
  let finished = false;
  let reason = '';

  const session = {
    stop(why) {
      if (stopping) return;
      stopping = true;
      reason = why;
      try { if (rec.state !== 'inactive') rec.stop(); else finish(); } catch { finish(); }
    },
  };
  state.recorder = session;

  function rms() {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / buf.length);
  }

  function tick() {
    if (stopping) return;
    const now = performance.now();
    const dt = now - last;
    last = now;
    const elapsed = now - t0;
    if (vad) {
      const level = rms();
      // Noise floor: drops instantly, rises slowly, so talking right away doesn't fool it.
      floor = level < floor ? level : floor + (level - floor) * 0.002;
      const threshold = Math.min(0.08, Math.max(0.018, floor * 3));
      if (level > threshold) { speechMs += dt; quietMs = 0; if (speechMs > 220) heard = true; } else quietMs += dt;
      els.mic.style.setProperty('--level', Math.min(1, level * 9).toFixed(3));
      if (heard && quietMs > 1500) return session.stop('auto');
      if (!heard && elapsed > 9000) return session.stop('silence');
    }
    if (elapsed > 30000) return session.stop('max');
    requestAnimationFrame(tick);
  }

  function finish() {
    if (finished) return;
    finished = true;
    stream.getTracks().forEach((t) => t.stop());
    try { ctx?.close(); } catch { /* ignore */ }
    if (state.recorder === session) state.recorder = null;
    if (turn !== state.turn || reason === 'cancel') return;
    if (vad && !heard && reason !== 'user') {
      setPhase('idle', state.handsFree
        ? "Hands-free is on, but I didn't hear anything. Tap the mic when you're ready."
        : "I didn't hear anything. Tap the mic and try again, or type below.");
      return;
    }
    const blob = new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' });
    sendAudio(blob, turn);
  }
  rec.onstop = finish;
  rec.start();
  requestAnimationFrame(tick);
}

async function sendAudio(blob, turn) {
  if (blob.size < 1200) {
    setPhase('idle', 'That was a bit short. Tap the mic and ask your question.');
    return;
  }
  setPhase('transcribing');
  try {
    const audioB64 = await blobToBase64(blob);
    const r = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: audioB64, mimeType: blob.type }),
    });
    const data = await r.json().catch(() => ({}));
    if (turn !== state.turn) return;
    if (!r.ok) throw new Error(data.error || 'Transcription failed');
    const text = String(data.text || '').trim();
    if (!text) {
      setPhase('idle', "Sorry, I didn't catch that. Tap the mic and try again.");
      return;
    }
    ask(text, turn);
  } catch {
    if (turn !== state.turn) return;
    if (SR && !navigator.brave) state.sttMode = 'browser'; // fall back to the browser's recogniser next time
    setPhase('idle', "I couldn't make that out. Please try again, or type your question below.", true);
  }
}

// ── Listening: browser speech recognition (fallback) ────────────────────────
function startRecognition(turn) {
  let rec;
  try { rec = new SR(); } catch { setPhase('idle', 'Voice input is not available here. Please type your question.', true); return; }
  rec.lang = state.config.voice?.lang || 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  let finalText = '';
  let interimText = '';
  let error = '';
  let stopped = '';
  const session = {
    stop(why) {
      stopped = why;
      try { why === 'cancel' ? rec.abort() : rec.stop(); } catch { /* ignore */ }
    },
  };
  state.recorder = session;

  rec.onresult = (e) => {
    interimText = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript + ' '; else interimText += r[0].transcript;
    }
    setInterim(`${finalText}${interimText}`.trim());
  };
  rec.onerror = (e) => { error = e.error || 'error'; };
  rec.onend = () => {
    if (state.recorder === session) state.recorder = null;
    clearInterim();
    if (turn !== state.turn || stopped === 'cancel') return;
    const text = `${finalText} ${interimText}`.trim();
    if (text) { ask(text, turn); return; }
    if (error === 'not-allowed' || error === 'service-not-allowed') { micFailed({ name: 'NotAllowedError' }); return; }
    if (error === 'network' || error === 'language-not-supported') {
      setPhase('idle', "Voice input isn't working in this browser right now. Please type your question below.", true);
      return;
    }
    setPhase('idle', "I didn't hear anything. Tap the mic and try again, or type below.");
  };

  try {
    rec.start();
    setPhase('listening');
  } catch {
    setPhase('idle', "Couldn't start the microphone. Please type your question below.", true);
  }
}

function startListening() {
  const turn = ++state.turn;
  stopSpeaking();
  if (state.sttMode === 'server') startRecorder(turn);
  else if (state.sttMode === 'browser') startRecognition(turn);
}

// ── Asking ──────────────────────────────────────────────────────────────────
async function ask(question, turn = ++state.turn) {
  question = String(question || '').trim();
  if (!question) return;
  stopSpeaking();
  addMessage('you', question);
  startThinkingLines();
  const typing = addTyping();
  let reply;
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: question, history: state.history.slice(-6) }),
    });
    const data = await r.json().catch(() => ({}));
    reply = data.reply || "Sorry, something went wrong on my side. Could you ask that again?";
  } catch {
    reply = "I can't reach the server right now. Please check your connection and try again.";
  }
  typing.remove();
  const wrap = addMessage('bot', reply);
  state.history.push({ role: 'user', content: question }, { role: 'assistant', content: reply });
  if (turn !== state.turn) return;
  await say(reply, turn, wrap);
}

function askFromUI(text) {
  if (busy()) return;
  unlockAudio();
  if (state.phase === 'listening') state.recorder?.stop('cancel');
  ask(text);
}

// ── Wiring ──────────────────────────────────────────────────────────────────
els.mic.addEventListener('click', () => {
  unlockAudio();
  if (state.phase === 'idle') startListening();
  else if (state.phase === 'listening') state.recorder ? state.recorder.stop('user') : setPhase('idle');
  else if (state.phase === 'speaking') startListening();
});

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = els.input.value.trim();
  if (!q || busy()) return;
  els.input.value = '';
  askFromUI(q);
});

document.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.closest('button, input, select, textarea, dialog, label')) return;
  if (e.code === 'Space' && !e.repeat) { e.preventDefault(); els.mic.click(); }
  if (e.key === 'Escape' && state.phase === 'speaking') { state.turn++; stopSpeaking(); setPhase('idle'); }
});

els.handsFree.addEventListener('change', () => {
  state.handsFree = els.handsFree.checked;
  store.set('handsFree', state.handsFree);
  unlockAudio();
  if (state.handsFree && state.phase === 'idle') startListening();
});

els.settingsBtn.addEventListener('click', () => {
  loadVoices();
  if (typeof els.settings.showModal === 'function') els.settings.showModal();
});
els.settings.addEventListener('click', (e) => { if (e.target === els.settings) els.settings.close(); });
els.voiceSelect.addEventListener('change', () => {
  state.voicePick = els.voiceSelect.value;
  store.set('voicePick', state.voicePick);
});
els.rate.addEventListener('input', () => {
  state.rate = Number(els.rate.value);
  els.rateOut.textContent = `${state.rate.toFixed(2).replace(/0$/, '')}×`;
  store.set('rate', state.rate);
});
els.mute.addEventListener('change', () => {
  state.muted = els.mute.checked;
  store.set('muted', state.muted);
  if (state.muted) { stopSpeaking(); if (state.phase === 'speaking') setPhase('idle'); }
});
els.testVoice.addEventListener('click', () => {
  unlockAudio();
  const wasMuted = state.muted;
  state.muted = false;
  const line = state.config.voiceTest || `Hi, I'm ${state.config.name.split(' ')[0]}. This is how I'll sound.`;
  speak(line).then(() => fillVoiceSelect());
  state.muted = wasMuted;
});

window.addEventListener('pagehide', () => { if (HAS_TTS) speechSynthesis.cancel(); });

// ── Boot ────────────────────────────────────────────────────────────────────
function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

async function boot() {
  if (HAS_TTS) speechSynthesis.cancel();
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    if (r.ok) Object.assign(state.config, await r.json());
  } catch { /* render with defaults */ }
  const c = state.config;
  buildSayList();

  els.name.textContent = c.name;
  document.title = `Talk to ${c.name}`;
  els.headline.textContent = c.headline || 'Ask me anything, out loud';
  if (c.photo) {
    els.avatar.style.backgroundImage = `url(${JSON.stringify(c.photo)})`;
    els.avatar.textContent = '';
  } else {
    els.avatar.textContent = initials(c.name);
  }
  for (const b of c.badges || []) {
    const span = document.createElement('span');
    span.className = 'badge';
    span.textContent = b;
    els.badges.append(span);
  }
  els.credit.textContent = c.footer || '';

  const notes = [];
  if (c.needsSetup) notes.push('Owner setup: this bot hasn’t been personalised yet. Fill in persona.js and redeploy.');
  if (!c.llmAvailable) notes.push('Owner setup: no AI key found, so the bot can only repeat prepared answers. Add GROQ_API_KEY in your hosting settings.');
  if (notes.length) {
    els.banner.textContent = notes.join(' ');
    els.banner.hidden = false;
  }

  for (const q of c.suggestedQuestions || []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = q;
    b.title = q;
    b.addEventListener('click', () => askFromUI(q));
    els.chips.append(b);
  }
  if (!(c.suggestedQuestions || []).length) els.chips.parentElement.hidden = true;

  if (c.greeting) addMessage('bot', c.greeting);

  const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  if (c.sttAvailable && canRecord) state.sttMode = 'server';
  else if (SR && !navigator.brave) state.sttMode = 'browser';
  else state.sttMode = 'none';

  els.handsFree.checked = !!state.handsFree && state.sttMode !== 'none';
  if (state.sttMode === 'none') {
    document.body.classList.add('no-mic');
    setPhase('idle', "Voice input isn't supported in this browser. Type a question below and I'll answer out loud.");
  } else {
    setPhase('idle');
  }
  if (matchMedia('(pointer: coarse)').matches) document.querySelector('.kbd-hint').style.visibility = 'hidden';

  const rate = state.rate ?? c.voice?.rate ?? 1;
  els.rate.value = rate;
  els.rateOut.textContent = `${Number(rate).toFixed(2).replace(/0$/, '')}×`;
  els.mute.checked = !!state.muted;

  loadVoices();
  if (HAS_TTS) {
    if (typeof speechSynthesis.addEventListener === 'function') speechSynthesis.addEventListener('voiceschanged', loadVoices);
    else speechSynthesis.onvoiceschanged = loadVoices;
  }
}

boot();
