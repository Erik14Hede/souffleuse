// Souffleuse – Google Gemini TTS (eigener, kostenloser API-Schlüssel)
import { base64ToBytes, isWav, decodeWav, int16ToFloat32 } from '../audio.js';

const API = 'https://generativelanguage.googleapis.com/v1beta/models/';

// 30 Gemini-Stimmen (Beschreibung aus der Google-Doku, deutsch übersetzt)
export const GEMINI_VOICES = [
  ['Kore', 'f', 'bestimmt'], ['Aoede', 'f', 'luftig, leicht'], ['Leda', 'f', 'jugendlich'], ['Zephyr', 'f', 'hell'],
  ['Callirrhoe', 'f', 'locker'], ['Autonoe', 'f', 'hell'], ['Despina', 'f', 'weich'], ['Erinome', 'f', 'klar'],
  ['Laomedeia', 'f', 'beschwingt'], ['Achernar', 'f', 'sanft'], ['Gacrux', 'f', 'reif, erwachsen'], ['Pulcherrima', 'f', 'direkt'],
  ['Vindemiatrix', 'f', 'behutsam'], ['Sulafat', 'f', 'warm'],
  ['Puck', 'm', 'beschwingt'], ['Charon', 'm', 'sachlich'], ['Fenrir', 'm', 'aufgeweckt'], ['Orus', 'm', 'bestimmt'],
  ['Enceladus', 'm', 'hauchig'], ['Iapetus', 'm', 'klar'], ['Umbriel', 'm', 'locker'], ['Algieba', 'm', 'geschmeidig'],
  ['Algenib', 'm', 'rau, kratzig'], ['Rasalgethi', 'm', 'sachlich'], ['Alnilam', 'm', 'bestimmt'], ['Schedar', 'm', 'ausgeglichen'],
  ['Achird', 'm', 'freundlich'], ['Zubenelgenubi', 'm', 'lässig'], ['Sadachbia', 'm', 'lebhaft'], ['Sadaltager', 'm', 'kundig'],
].map(([id, gender, desc]) => ({ id, label: `${id} – ${desc}`, gender, desc }));

export const GEMINI_TTS_MODELS = [
  { id: 'gemini-3.8-flash-tts', label: 'Gemini 3.8 Flash TTS (beste Schauspielqualität)' },
  { id: 'gemini-3.8-flash-lite-tts', label: 'Gemini 3.8 Flash-Lite TTS (sparsamer)' },
  { id: 'gemini-3.1-flash-tts-preview', label: 'Gemini 3.1 Flash TTS (Vorgänger)' },
  { id: 'gemini-2.5-flash-preview-tts', label: 'Gemini 2.5 Flash TTS (alt)' },
];

export class GeminiError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

// Jedes Modell hat ein eigenes Tageskontingent → ist eins leer, nimmt die App das nächste
const FREE_TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-3.1-flash-tts-preview'];
const EXHAUSTED_KEY = 'souffleuse.gemini.exhausted';
function pacificDay() { return new Date(Date.now() - 8 * 3600 * 1000).toISOString().slice(0, 10); } // Kontingente starten um Mitternacht (Pazifikzeit) neu
function exhaustedMap() { try { return JSON.parse(localStorage.getItem(EXHAUSTED_KEY) || '{}'); } catch (e) { return {}; } }
function markExhausted(model) { try { const m = exhaustedMap(); m[model] = pacificDay(); localStorage.setItem(EXHAUSTED_KEY, JSON.stringify(m)); } catch (e) { /* */ } }
function modelChain(model) {
  const today = pacificDay(); const ex = exhaustedMap();
  return [model, ...FREE_TTS_MODELS.filter(m => m !== model)].filter(m => ex[m] !== today);
}
async function withModelFallback(model, run) {
  let lastErr = null;
  for (const m of modelChain(model)) {
    try { return await run(m); }
    catch (e) {
      if (e.code === 'quota' && e.perDay) { markExhausted(m); lastErr = e; continue; }
      if (e.code === 'model' && m !== model) { lastErr = lastErr || e; continue; }
      if (e.code === 'model') { lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr || new GeminiError('quota', 'Das kostenlose Gemini-Tageskontingent ist für heute aufgebraucht. Bereits erzeugte Zeilen bleiben gespeichert – morgen geht es weiter (oder wechsle zu „Offline-KI“).', 429);
}

let lastCall = 0;
let chain = Promise.resolve();
const legacyModels = new Set(); // Modelle, die speech_metadata nicht kennen
export const geminiStats = { requests: 0, today: 0, day: new Date().toDateString() };

function countRequest() {
  const d = new Date().toDateString();
  try {
    const saved = JSON.parse(localStorage.getItem('souffleuse.gemini.count') || '{}');
    geminiStats.day = d;
    geminiStats.today = saved.day === d ? (saved.n || 0) + 1 : 1;
    localStorage.setItem('souffleuse.gemini.count', JSON.stringify({ day: d, n: geminiStats.today }));
  } catch (e) { geminiStats.today++; }
  geminiStats.requests++;
}
export function geminiRequestsToday() {
  try { const s = JSON.parse(localStorage.getItem('souffleuse.gemini.count') || '{}'); return s.day === new Date().toDateString() ? s.n || 0 : 0; } catch (e) { return 0; }
}

function throttle(minIntervalMs) {
  const run = async () => {
    const wait = Math.max(0, lastCall + minIntervalMs - Date.now());
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
  };
  const p = chain.then(run, run);
  chain = p;
  return p;
}

// 429 genauer auswerten: Minutenlimit (kurz warten) oder Tageslimit (morgen weiter)
export function quotaInfo(body) {
  const details = (body && body.error && body.error.details) || [];
  const txt = JSON.stringify(details) + ' ' + ((body && body.error && body.error.message) || '');
  const retry = details.find(d => d && String(d['@type'] || '').includes('RetryInfo'));
  const delay = retry && retry.retryDelay ? parseFloat(retry.retryDelay) : null;
  return { perDay: /PerDay|per day|daily/i.test(txt), delay };
}

function mapError(status, body) {
  const msg = (body && body.error && body.error.message) || '';
  if (status === 429) {
    const q = quotaInfo(body);
    const err = new GeminiError('quota', q.perDay
      ? 'Das kostenlose Gemini-Tageskontingent ist aufgebraucht. Bereits erzeugte Zeilen bleiben gespeichert – morgen geht es weiter (oder wechsle zu „Offline-KI“).'
      : 'Gemini meldet zu viele Anfragen. Bitte kurz warten und dann weitermachen – bereits erzeugte Zeilen bleiben gespeichert.', status);
    err.perDay = q.perDay;
    return err;
  }
  if (status === 400 && /api key/i.test(msg)) return new GeminiError('key', 'Der Gemini-Schlüssel ist ungültig. Bitte in den Einstellungen prüfen.', status);
  if (status === 401 || status === 403) return new GeminiError('key', 'Zugriff verweigert – stimmt der Gemini-Schlüssel? (' + (msg || status) + ')', status);
  if (status === 404) return new GeminiError('model', 'Dieses Gemini-Modell gibt es nicht (mehr). Bitte in den Einstellungen ein anderes wählen.', status);
  if (status === 400 && /(speech_metadata|speechMetadata|Unknown name|Invalid JSON payload)/i.test(msg)) return new GeminiError('format', msg, status);
  if (status >= 500) return new GeminiError('server', 'Gemini ist gerade überlastet. Bitte gleich nochmal versuchen.', status);
  return new GeminiError('other', 'Gemini-Fehler: ' + (msg || status), status);
}

async function post(model, apiKey, body) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(API + encodeURIComponent(model) + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new GeminiError('network', 'Keine Verbindung zu Gemini. Bist du online?');
    }
    countRequest();
    let json = null;
    try { json = await res.json(); } catch (e) { /* */ }
    if (res.ok) return json;
    // Minutenlimit: automatisch warten und erneut versuchen
    if (res.status === 429 && attempt < 3) {
      const q = quotaInfo(json);
      if (!q.perDay) {
        const secs = Math.min(70, Math.max(5, q.delay || 20 * (attempt + 1)));
        if (geminiEngine.onWait) try { geminiEngine.onWait(secs); } catch (e) { /* */ }
        await new Promise(r => setTimeout(r, secs * 1000 + 300));
        lastCall = Date.now();
        continue;
      }
    }
    if (res.status >= 500 && attempt < 2) { await new Promise(r => setTimeout(r, 2500 * (attempt + 1))); continue; }
    throw mapError(res.status, json);
  }
}

function extractAudio(json) {
  const parts = json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts || [];
  const inline = parts.map(p => p.inlineData || p.inline_data).find(Boolean);
  if (!inline || !inline.data) {
    const reason = json && json.candidates && json.candidates[0] && json.candidates[0].finishReason;
    const block = json && json.promptFeedback && json.promptFeedback.blockReason;
    throw new GeminiError('empty', 'Gemini hat kein Audio geliefert' + (reason || block ? ` (${reason || block})` : '') + '.');
  }
  const bytes = base64ToBytes(inline.data);
  if (isWav(bytes)) return decodeWav(bytes);
  const mime = inline.mimeType || inline.mime_type || '';
  const m = mime.match(/rate=(\d+)/);
  const rate = m ? Number(m[1]) : 24000;
  const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  return { pcm: int16ToFloat32(i16), sampleRate: rate };
}

function speechText(t) {
  // Pausenmarker → Gemini-Tag; Satzzeichen bleiben
  return String(t || '').replace(/\s*⏸\s*/g, ' <long pause> ').replace(/\s{2,}/g, ' ').trim();
}

function voiceConfig(id) { return { prebuiltVoiceConfig: { voiceName: id } }; }

export const geminiEngine = {
  id: 'gemini',
  label: 'Gemini (Google)',
  renders: true,

  available() { return true; },
  voices() { return GEMINI_VOICES; },

  // Einzelne Zeile → { pcm, sampleRate }
  async synthesize({ text, voiceId, style, apiKey, model, minIntervalMs = 2500 }) {
    if (!apiKey) throw new GeminiError('key', 'Für Gemini brauchst du einen (kostenlosen) API-Schlüssel – siehe Einstellungen.');
    const voice = voiceId || 'Kore';
    const transcript = speechText(text);
    const modern = {
      contents: [{ role: 'user', parts: [style ? { text: transcript, speech_metadata: { style } } : { text: transcript }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: voiceConfig(voice) } },
    };
    const legacy = {
      contents: [{ role: 'user', parts: [{ text: style ? `Say in this style (${style}): ${transcript}` : transcript }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: voiceConfig(voice) } },
    };
    return withModelFallback(model, async (m) => {
      await throttle(minIntervalMs);
      if (legacyModels.has(m) || !style) return extractAudio(await post(m, apiKey, style && legacyModels.has(m) ? legacy : modern));
      try {
        return extractAudio(await post(m, apiKey, modern));
      } catch (e) {
        if (e.code === 'format') { legacyModels.add(m); await throttle(minIntervalMs); return extractAudio(await post(m, apiKey, legacy)); }
        throw e;
      }
    });
  },

  // Dialog mit max. 2 Sprecher:innen in EINER Anfrage (spart Kontingent)
  // turns: [{ speaker: 'Lena', text, style }], voices: { Lena: 'Kore', Jonas: 'Puck' }
  async synthesizeDialog({ turns, voices, apiKey, model, minIntervalMs = 2500 }) {
    if (!apiKey) throw new GeminiError('key', 'Für Gemini brauchst du einen (kostenlosen) API-Schlüssel – siehe Einstellungen.');
    const names = [...new Set(turns.map(t => t.speaker))];
    if (names.length > 2) throw new GeminiError('other', 'Maximal zwei Stimmen pro Anfrage');
    const speechConfig = names.length === 2
      ? { multiSpeakerVoiceConfig: { speakerVoiceConfigs: names.map(n => ({ speaker: n, voiceConfig: voiceConfig(voices[n]) })) } }
      : { voiceConfig: voiceConfig(voices[names[0]]) };
    const modern = {
      contents: [{ role: 'user', parts: turns.map(t => {
        const md = {}; if (names.length === 2) md.speaker = t.speaker; if (t.style) md.style = t.style;
        return Object.keys(md).length ? { text: speechText(t.text), speech_metadata: md } : { text: speechText(t.text) };
      }) }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig },
    };
    const legacyText = (names.length === 2 ? `TTS the following conversation between ${names[0]} and ${names[1]}:\n` : '') +
      turns.map(t => `${names.length === 2 ? t.speaker + ': ' : ''}${t.style ? `(${t.style}) ` : ''}${speechText(t.text)}`).join('\n');
    const legacy = { contents: [{ role: 'user', parts: [{ text: legacyText }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig } };
    return withModelFallback(model, async (m) => {
      await throttle(minIntervalMs);
      if (legacyModels.has(m)) return extractAudio(await post(m, apiKey, legacy));
      try {
        return extractAudio(await post(m, apiKey, modern));
      } catch (e) {
        if (e.code === 'format') { legacyModels.add(m); await throttle(minIntervalMs); return extractAudio(await post(m, apiKey, legacy)); }
        throw e;
      }
    });
  },

  // Schlüssel testen (eine kurze Anfrage)
  async test({ apiKey, model }) {
    const r = await this.synthesize({ text: 'Hallo! Die Stimme funktioniert.', voiceId: 'Kore', style: 'friendly', apiKey, model, minIntervalMs: 0 });
    return r.pcm.length / r.sampleRate;
  },
};
