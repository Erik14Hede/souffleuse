// Souffleuse – KI-Aufbereitung des Skripts (Gemini-Schlüssel oder beliebiger Chatbot)
import { GeminiError, quotaInfo } from './engines/gemini.js';

const API = 'https://generativelanguage.googleapis.com/v1beta/models/';

// „1. Akt (Teil 2)“ usw. – Fortsetzung eines geteilten Akts
function continues(part) {
  const m = String(part || '').match(/\(Teil (\d+)\)\s*$/u);
  return !!m && Number(m[1]) > 1;
}

export function buildPrompt({ text, knownCharacters = '', part = '', isPdf = false, pageHint = '' }) {
  return `Du bist Dramaturg:in und bereitest ein Theater- oder Musical-Skript für eine Vorlese-App auf, mit der eine Darstellerin ihren Text lernt.
Wandle ${isPdf ? 'die angehängte PDF' + (pageHint ? ' (nur ' + pageHint + ')' : '') : 'den Text unten'} in das „Souffleuse-Format“ um.

REGELN
1. Ganz oben jede Figur genau einmal:
   @ NAME: Geschlecht (weiblich/männlich/divers/unklar), Alter falls erkennbar, 3–6 Wörter Charakter
2. Akte als „# …“, Szenen als „## …“ (Originaltitel übernehmen).
3. Jede gesprochene Replik als GENAU EINE Zeile:
   NAME [Emotion auf Deutsch | short English delivery note]: Text
   – NAME in GROSSBUCHSTABEN und überall gleich geschrieben.
   – Emotion: 1–3 Wörter (z. B. „traurig, leise“). Delivery: kurze englische Regieanweisung für eine Sprachsynthese (z. B. „sad, quiet, holding back tears“).
   – Leite den Tonfall aus Regieanweisungen UND aus dem Zusammenhang ab (Figur, Situation, Beziehung, was gerade passiert ist).
   – Mehrere Absätze einer Replik in eine Zeile zusammenfassen.
   – Den gesprochenen Text WÖRTLICH übernehmen: nichts kürzen, umformulieren oder ergänzen. Nur Seitenzahlen, Kopfzeilen und Trennstriche entfernen.
4. Regieanweisungen als eigene Zeile in runden Klammern: (Anna geht zum Fenster.)
   Kurze Anweisungen mitten in einer Replik bleiben in Klammern im Text: Ja. (zögert) Vielleicht.
5. Lieder: Liedtexte NICHT abschreiben. Schreibe stattdessen pro Lied eine Regiezeile mit ♪, Titel und wer singt:
   (♪ SONG: „Titel“ – Anna und Chor)
   Gesprochene Sätze mitten im Lied ganz normal als Replik.
   Mehrere Figuren gleichzeitig: ANNA & MAX: …   Chor/alle: ALLE: …
6. Gib NUR das Ergebnis aus – keine Einleitung, keine Erklärungen, kein Markdown-Codeblock.
${knownCharacters ? `\nBEREITS BEKANNTE FIGUREN (genau diese Namen verwenden, nur neue Figuren mit @ ergänzen):\n${knownCharacters}\n` : ''}${part ? `\nABSCHNITT: ${part}\n` : ''}${continues(part) ? 'Dieser Teil setzt den vorherigen nahtlos fort: Beginne NICHT mit einer eigenen Akt- oder Szenenüberschrift, übernimm nur Überschriften, die im Text stehen.\n' : ''}
BEISPIEL
@ LENA: weiblich, Mitte 20, träumerisch und dickköpfig
@ JONAS: männlich, Ende 20, ihr Bruder, gutmütig
# 1. Akt
## Szene 1: Bahnsteig
(Regen. Lena sitzt auf ihrem Koffer.)
JONAS [erleichtert | relieved, out of breath]: Da bist du ja!
LENA [trotzig | defiant, a little cold]: Ich hab dir doch geschrieben.
${isPdf ? '' : `\nTEXT\n<<<\n${text}\n>>>`}`;
}

export function cleanModelOutput(s) {
  return String(s || '')
    .replace(/^\s*```[a-z]*\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .replace(/^\s*<<<\s*\n?|\n?>>>\s*$/g, '')
    .trim();
}

async function callText({ apiKey, model, parts, onWait }) {
  let res, json = null;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(API + encodeURIComponent(model) + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts }] }),
      });
    } catch (e) { throw new GeminiError('network', 'Keine Verbindung zu Gemini. Bist du online?'); }
    json = null; try { json = await res.json(); } catch (e) { /* */ }
    if (res.status === 429 && attempt < 3) {
      const q = quotaInfo(json);
      if (!q.perDay) {
        const secs = Math.min(70, Math.max(5, q.delay || 20 * (attempt + 1)));
        if (onWait) onWait(secs);
        await new Promise(r => setTimeout(r, secs * 1000 + 300));
        continue;
      }
    }
    if (res.status >= 500 && attempt < 2) { await new Promise(r => setTimeout(r, 3000 * (attempt + 1))); continue; }
    break;
  }
  if (!res.ok) {
    const msg = (json && json.error && json.error.message) || res.status;
    if (res.status === 429) throw new GeminiError('quota', quotaInfo(json).perDay ? 'Das Gemini-Tageskontingent ist aufgebraucht. Fertige Abschnitte bleiben gespeichert – morgen mit „Fortsetzen“ weitermachen.' : 'Gemini meldet zu viele Anfragen – bitte kurz warten und dann „Fortsetzen“.', 429);
    if (res.status === 404) throw new GeminiError('model', 'Textmodell nicht gefunden: ' + model, 404);
    if (res.status === 400 && /api key/i.test(String(msg))) throw new GeminiError('key', 'Der Gemini-Schlüssel ist ungültig.', 400);
    if (res.status === 401 || res.status === 403) throw new GeminiError('key', 'Zugriff verweigert – stimmt der Gemini-Schlüssel?', res.status);
    throw new GeminiError('other', 'Gemini-Fehler: ' + msg, res.status);
  }
  const cand = json && json.candidates && json.candidates[0];
  const text = cand && cand.content && cand.content.parts ? cand.content.parts.filter(p => p.text && !p.thought).map(p => p.text).join('') : '';
  if (!text) throw new GeminiError('empty', 'Gemini hat keinen Text geliefert' + (cand && cand.finishReason ? ' (' + cand.finishReason + ')' : '') + '.');
  return { text: cleanModelOutput(text), truncated: cand.finishReason === 'MAX_TOKENS' };
}

const FALLBACK_TEXT_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash'];

export async function structureWithGemini({ apiKey, model, text, knownCharacters, part, onWait }) {
  const prompt = buildPrompt({ text, knownCharacters, part });
  const tried = [];
  for (const m of [model, ...FALLBACK_TEXT_MODELS.filter(x => x !== model)]) {
    tried.push(m);
    try { return { ...(await callText({ apiKey, model: m, parts: [{ text: prompt }], onWait })), model: m }; }
    catch (e) { if (e.code !== 'model') throw e; }
  }
  throw new GeminiError('model', 'Kein passendes Gemini-Textmodell gefunden (' + tried.join(', ') + ').');
}

// Eingescannte PDF direkt an Gemini geben (bis ca. 18 MB)
export async function structurePdfWithGemini({ apiKey, model, pdfBytes, pageHint, knownCharacters }) {
  if (pdfBytes.byteLength > 18 * 1024 * 1024) throw new GeminiError('other', 'Die PDF ist zu groß für die direkte Übergabe (max. ca. 18 MB). Bitte in kleinere Teile aufteilen.');
  const b64 = await bytesToBase64(new Uint8Array(pdfBytes));
  const prompt = buildPrompt({ isPdf: true, pageHint, knownCharacters });
  const parts = [{ inlineData: { mimeType: 'application/pdf', data: b64 } }, { text: prompt }];
  for (const m of [model, ...FALLBACK_TEXT_MODELS.filter(x => x !== model)]) {
    try { return { ...(await callText({ apiKey, model: m, parts })), model: m }; }
    catch (e) { if (e.code !== 'model') throw e; }
  }
  throw new GeminiError('model', 'Kein passendes Gemini-Modell gefunden.');
}

function bytesToBase64(bytes) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(new Blob([bytes]));
  });
}
