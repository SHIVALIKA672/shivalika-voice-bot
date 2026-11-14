# Voice Interview Bot

**Live:** https://shivalika-voice-bot.vercel.app

A voice bot that answers interview-style questions ("What's your superpower?", "How do you push your limits?") the way its owner would. Open the link, tap the mic, ask a question, and hear the answer.

For people testing it, there's nothing to install and no key to enter. It works on desktop and phone. If talking isn't an option, you can tap a suggested question or type one instead.

## How it works

```
 Visitor's browser                         Server (/api, serverless)            Free AI provider
 ─────────────────                         ─────────────────────────            ────────────────
 Tap mic → record (stops on silence) ──►  /api/transcribe ─────────────────►  Whisper (speech → text)
 Show question, "Thinking…"          ──►  /api/chat + persona.js prompt ───►  LLM (answers as you)
 Speak the answer (browser voice)    ◄──  reply text
```

- **Speech → text:** Groq's free Whisper API. If no speech-to-text key is configured, the browser's own speech recognition is used instead (Chrome, Edge, Safari).
- **Answers:** an OpenAI-compatible chat API. Groq is the free default; Google Gemini (free tier) and OpenAI also work. If one model is retired or rate-limited, the next one in the list is tried automatically.
- **Text → speech:** a natural AI voice (Groq's Orpheus, free) when it's available, otherwise the browser's built-in voices. Visitors can switch voice and speed under the speaker icon.
- **Pronunciation:** names and tech terms are respelled before speaking ("empath" → "em path", "SOPs" → "S O Pees", "LangGraph" → "Lang Graph"). Each fix was checked by having a voice say it and running the audio back through Whisper. The screen always shows the normal spelling. Add your own in `persona.js → pronunciations`.
- **Extras:** the sentence being spoken is highlighted. A hands-free mode reopens the mic after each answer, and you can press Space to talk on a keyboard.
- **Never silent:** if every AI call fails, the bot still answers with your closest prepared answer.
- **API keys stay on the server.** Visitors never see or enter one.

## 1. Make it sound like you: edit `persona.js`

It's the only file you need to touch:

- `name`, `headline`, optional `photo`
- `profile`: background facts (bullet points are fine)
- `style`: how you talk
- `answers`: your own answers to the five reviewer questions, plus common follow-ups. The bot paraphrases them naturally and uses them to handle questions it hasn't seen.

Anything still marked `TODO` is ignored, and an "Owner setup" banner shows on the page until enough is filled in.

## 2. Get a free API key

Create a key at **https://console.groq.com/keys** (free, no card). One Groq key covers both answering and speech-to-text.

Alternatives: `GEMINI_API_KEY` from https://aistudio.google.com/apikey (answers only), or a paid `OPENAI_API_KEY`. If you set more than one, they act as fallbacks for each other.

**Natural voice (optional, free):** open https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english while signed in to Groq and accept the model's terms once. Until then, the bot uses the browser's voice.

**Recommended: also add a free `GEMINI_API_KEY` as a backup.** Groq's free tier caps tokens per minute and per day. Each question uses about 2–2.5K tokens, so a burst of rapid-fire questions can hit Groq's limit. With a Gemini key set, those questions go to Gemini instead.

## 3. Deploy (Vercel, free)

1. Push this folder to a GitHub repository.
2. Go to https://vercel.com/new, sign in with GitHub, and import the repository. No framework or build settings are needed.
3. Under **Environment Variables**, add `GROQ_API_KEY` = your key.
4. Click **Deploy**. Your link looks like `https://your-project.vercel.app`.

To change answers later, edit `persona.js` and push. Vercel redeploys on its own.

<details>
<summary>Other hosts (Render, Railway, Fly, any VPS)</summary>

It's a plain Node app with no dependencies: start command `npm start`, Node 18+. Set `GROQ_API_KEY` in the host's environment settings. Your host must serve it over HTTPS for the microphone to work.
</details>

## Run locally

```bash
cp .env.example .env      # then put your key in .env
npm start                 # → http://localhost:3000
```

Node 18+ is the only requirement. There's no `npm install`.

## Optional settings (environment variables)

| Name | Default | What it does |
| --- | --- | --- |
| `LLM_PROVIDER` | first provider with a key | `groq`, `gemini` or `openai`: which one to try first |
| `LLM_MODEL` | built-in list | Force a chat model for `LLM_PROVIDER` |
| `STT_MODEL` | `whisper-large-v3-turbo` | Force a speech-to-text model |
| `STT_LANGUAGE` | `en` | Language hint for speech-to-text (empty string = auto-detect) |

## Browser notes

- **Talking to the bot:** Chrome, Edge, Safari and Firefox (desktop and mobile) when a Groq or OpenAI key is set. The visitor allows microphone access once.
- **Hearing the bot:** every modern browser. The best voices are Edge's "Natural" voices, then Chrome's "Google" voices, then Safari's "Enhanced" voices.
- If the microphone is blocked, the page explains how to allow it, and typing still works.

## Project layout

```
persona.js          ← your story and answers (edit this)
api/chat.js         answers a question in your voice
api/transcribe.js   speech → text
api/speak.js        text → natural speech (Groq Orpheus)
api/config.js       public settings for the page
lib/llm.js          provider and model fallbacks (Groq / Gemini / OpenAI), speech
lib/prompt.js       system prompt, speech cleanup, offline fallback
public/             the web page (HTML, CSS, JS; no build step)
server.js           local or any-Node-host server (not used on Vercel)
```
