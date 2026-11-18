// Souffleuse – Gerätestimmen über die Web Speech API

const FEMALE = /\b(anna|helena|petra|sandy|shelley|flo|grandma|katja|amala|louisa|maja|tanja|elke|klarissa|gisela|ingrid|seraphina|hedda|vicki|marlene|hannah|lea|julia|sabine|carla|deutsch(?!.*männ)|google deutsch|female|weiblich|frau)\b/i;
const MALE = /\b(martin|markus|yannick|viktor|grandpa|reed|rocko|eddy|conrad|killian|jonas|kasper|ralf|bernd|christoph|florian|stefan|klaus|hans|daniel|male|männlich|mann)\b/i;

export function voiceGender(name) {
  if (MALE.test(name)) return 'm';
  if (FEMALE.test(name)) return 'f';
  return '?';
}
function voiceQuality(v) {
  const n = v.name || '';
  if (/natural|neural|online|premium|enhanced|erweitert|siri|wavenet|studio/i.test(n)) return 2;
  if (/google/i.test(n) || !v.localService) return 1;
  return 0;
}

let cachedVoices = null;
function loadVoices(timeout = 2000) {
  if (!('speechSynthesis' in window)) return Promise.resolve([]);
  const now = speechSynthesis.getVoices();
  if (now && now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(speechSynthesis.getVoices() || []); };
    speechSynthesis.addEventListener && speechSynthesis.addEventListener('voiceschanged', finish, { once: true });
    setTimeout(finish, timeout);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function chunkText(text, max = 180) {
  const parts = String(text).match(/[^.!?…;:]+[.!?…;:]*\s*/g) || [text];
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > max && cur) { out.push(cur.trim()); cur = ''; }
    if (p.length > max) {
      const words = p.split(/\s+/); let w = '';
      for (const x of words) { if ((w + ' ' + x).length > max && w) { out.push(w.trim()); w = ''; } w += ' ' + x; }
      cur += w;
    } else cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

function cleanForSpeech(t) {
  return String(t || '')
    .replace(/[„“”"«»‚‘]/g, '')
    .replace(/\s*[–—]\s*/g, ', ')
    .replace(/\*/g, '')
    .replace(/&/g, ' und ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export const deviceEngine = {
  id: 'device',
  label: 'Gerätestimmen',
  renders: false,
  _token: 0,

  available() { return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'; },

  async voices({ allLanguages = false } = {}) {
    const all = await loadVoices();
    cachedVoices = all;
    let list = all.filter(v => /^de(\b|[-_])/i.test(v.lang || ''));
    if (!list.length || allLanguages) list = all;
    return list.map(v => ({
      id: v.voiceURI || v.name,
      label: v.name.replace(/\s*\(.*?\)\s*/g, ' ').replace(/Microsoft\s+/i, '').replace(/\s+Online/i, '').trim() + (voiceQuality(v) === 2 ? ' ✦' : ''),
      fullName: v.name,
      lang: v.lang,
      gender: voiceGender(v.name),
      quality: voiceQuality(v),
      local: v.localService,
    })).sort((a, b) => (b.quality - a.quality) || a.label.localeCompare(b.label));
  },

  _find(id) {
    const all = cachedVoices || speechSynthesis.getVoices();
    return all.find(v => (v.voiceURI || v.name) === id) || all.find(v => v.name === id) || null;
  },

  // Muss synchron in einem Tipp-Handler aufgerufen werden (iOS)
  unlock() {
    if (!this.available()) return;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0; u.rate = 2;
      speechSynthesis.speak(u);
    } catch (e) { /* egal */ }
  },

  cancel() {
    this._token++;
    if (this.available()) { try { speechSynthesis.cancel(); } catch (e) { /* */ } }
  },

  // spricht Text; löst auf, wenn fertig (oder abgebrochen → {cancelled:true})
  async speak({ text, voiceId, rate = 1, pitch = 1, volume = 1, lang = 'de-DE' }) {
    if (!this.available()) throw new Error('Dieser Browser kann nicht vorlesen (Web Speech API fehlt).');
    const token = ++this._token;
    const voice = voiceId ? this._find(voiceId) : null;
    const segments = String(text || '').split('⏸');
    for (let s = 0; s < segments.length; s++) {
      if (s > 0) { await sleep(650 / Math.max(0.5, rate)); if (token !== this._token) return { cancelled: true }; }
      const chunks = chunkText(cleanForSpeech(segments[s]));
      for (const chunk of chunks) {
        if (token !== this._token) return { cancelled: true };
        const res = await new Promise((resolve) => {
          const u = new SpeechSynthesisUtterance(chunk);
          u.lang = (voice && voice.lang) || lang;
          if (voice) u.voice = voice;
          u.rate = Math.max(0.5, Math.min(2, rate));
          u.pitch = Math.max(0.5, Math.min(1.6, pitch));
          u.volume = Math.max(0, Math.min(1, volume));
          let finished = false;
          const est = (chunk.length / 13) / u.rate * 1000;
          const watchdog = setTimeout(() => finish('timeout'), est * 2.5 + 4000);
          function finish(kind) {
            if (finished) return; finished = true; clearTimeout(watchdog); resolve(kind);
          }
          u.onend = () => finish('end');
          u.onerror = (e) => finish(e && (e.error === 'interrupted' || e.error === 'canceled') ? 'cancelled' : 'error');
          // Chrome-Eigenheit: speak() direkt nach cancel() geht manchmal verloren
          if (speechSynthesis.speaking || speechSynthesis.pending) { /* in Warteschlange */ }
          speechSynthesis.speak(u);
          // Chrome pausiert manchmal grundlos → wieder anstoßen
          setTimeout(() => { try { if (!finished && speechSynthesis.paused) speechSynthesis.resume(); } catch (e) { /* */ } }, 300);
        });
        if (res === 'cancelled' || token !== this._token) return { cancelled: true };
      }
    }
    return { cancelled: false };
  },
};
