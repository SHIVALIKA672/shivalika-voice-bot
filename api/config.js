import persona from '../persona.js';
import { llmAvailable, sttAvailable, ttsAvailable } from '../lib/llm.js';
import { displayName, personaIncomplete } from '../lib/prompt.js';
import { sendJson } from '../lib/http.js';

const todo = (s) => !s || /\bTODO\b/.test(String(s));
const NEURAL_LABELS = {
  hannah: 'Natural · warm & youthful', autumn: 'Natural · breezy', diana: 'Natural · confident',
  austin: 'Natural · male, upbeat', daniel: 'Natural · male, calm', troy: 'Natural · male, deep',
};

// Public, non-secret settings the page needs to render itself.
export default function handler(req, res) {
  const v = persona.voice || {};
  const neuralChoices = (v.neuralChoices || ['hannah', 'autumn', 'diana'])
    .filter((id) => NEURAL_LABELS[id])
    .map((id) => ({ id, label: NEURAL_LABELS[id] }));
  return sendJson(res, 200, {
    name: displayName(persona),
    headline: todo(persona.headline) ? '' : persona.headline,
    photo: persona.photo || '',
    greeting: persona.greeting || '',
    badges: (persona.badges || []).slice(0, 8),
    thinkingLines: persona.thinkingLines || [],
    footer: persona.footer || '',
    voiceTest: persona.voiceTest || '',
    suggestedQuestions: (persona.suggestedQuestions || []).slice(0, 8),
    voice: { prefer: v.prefer, avoid: v.avoid, lang: v.lang, rate: v.rate, pitch: v.pitch },
    neural: v.neural === false ? null : { available: ttsAvailable(), default: v.neural || 'hannah', choices: neuralChoices },
    pronunciations: persona.pronunciations || {},
    sttAvailable: sttAvailable(),
    llmAvailable: llmAvailable(),
    needsSetup: personaIncomplete(persona),
  });
}
