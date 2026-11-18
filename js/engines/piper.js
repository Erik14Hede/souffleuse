// Souffleuse – Piper (neuronale Offline-Stimmen direkt im Browser)
import { piperParamsFor } from '../emotion.js';

const CACHE = 'souffleuse-piper-v1';
const appBase = new URL('../../', import.meta.url);

// Deutsche Piper-Stimmen (Größen in MB laut voices.json)
const CATALOG = [
  { key: 'de_DE-thorsten-medium', label: 'Thorsten', gender: 'm', quality: 'gut', size: 63, path: 'de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx', note: 'klar, natürlich' },
  { key: 'de_DE-thorsten_emotional-medium', label: 'Thorsten emotional', gender: 'm', quality: 'gut', size: 77, path: 'de/de_DE/thorsten_emotional/medium/de_DE-thorsten_emotional-medium.onnx', emotional: true, note: 'wechselt Gefühl je Zeile' },
  { key: 'de_DE-thorsten-high', label: 'Thorsten (beste Qualität)', gender: 'm', quality: 'sehr gut', size: 114, path: 'de/de_DE/thorsten/high/de_DE-thorsten-high.onnx', note: 'langsamer, großer Download' },
  { key: 'de_DE-kerstin-low', label: 'Kerstin', gender: 'f', quality: 'ok', size: 63, path: 'de/de_DE/kerstin/low/de_DE-kerstin-low.onnx', note: 'Frauenstimme' },
  { key: 'de_DE-ramona-low', label: 'Ramona', gender: 'f', quality: 'ok', size: 63, path: 'de/de_DE/ramona/low/de_DE-ramona-low.onnx', note: 'Frauenstimme' },
  { key: 'de_DE-eva_k-x_low', label: 'Eva', gender: 'f', quality: 'einfach', size: 21, path: 'de/de_DE/eva_k/x_low/de_DE-eva_k-x_low.onnx', note: 'klein, etwas blechern' },
  { key: 'de_DE-karlsson-low', label: 'Karlsson', gender: 'm', quality: 'ok', size: 63, path: 'de/de_DE/karlsson/low/de_DE-karlsson-low.onnx', note: 'tiefe Männerstimme' },
  { key: 'de_DE-pavoque-low', label: 'Pavoque', gender: 'm', quality: 'ok', size: 63, path: 'de/de_DE/pavoque/low/de_DE-pavoque-low.onnx', note: 'Männerstimme' },
  { key: 'de_DE-mls-medium', label: 'MLS (viele Sprecher:innen)', gender: '?', quality: 'gemischt', size: 77, path: 'de/de_DE/mls/medium/de_DE-mls-medium.onnx', multi: true, note: 'ein Download, viele Stimmen' },
];
// handverlesene MLS-Sprecher-IDs (Auswahl, Qualität schwankt)
const MLS_SPEAKERS = [0, 3, 7, 12, 20, 25, 33, 41, 50, 60, 75, 90, 110, 130, 150, 170, 190, 210, 230];

let baseUrl = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
let worker = null;
let initPromise = null;
let reqId = 0;
const pending = new Map();
const loadedInWorker = new Set();
const configs = new Map();
let queue = Promise.resolve();

export function setPiperBase(url) {
  if (url && url !== baseUrl) { baseUrl = url.endsWith('/') ? url : url + '/'; }
}

function call(type, payload = {}, transfer = []) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload }, transfer);
  });
}

function ensureWorker() {
  if (initPromise) return initPromise;
  worker = new Worker(new URL('./piper-worker.js', import.meta.url));
  worker.onmessage = (e) => {
    const m = e.data; const p = pending.get(m.id);
    if (!p) return; pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
  };
  worker.onerror = (e) => {
    const err = new Error('Piper-Worker-Fehler: ' + (e.message || 'unbekannt'));
    pending.forEach(p => p.reject(err)); pending.clear();
  };
  initPromise = call('init', {
    ortScript: new URL('vendor/ort/ort.wasm.min.js', appBase).href,
    ortBase: new URL('vendor/ort/', appBase).href,
    phonemizeScript: new URL('vendor/piper/piper_phonemize.js', appBase).href,
    phonemizeBase: new URL('vendor/piper/', appBase).href,
  }).catch((e) => { initPromise = null; try { worker.terminate(); } catch (x) { /* */ } worker = null; throw e; });
  return initPromise;
}

function entryFor(key) {
  return CATALOG.find(v => v.key === key) || dynamicVoices.find(v => v.key === key) || null;
}
function urlsFor(entry) {
  return { model: baseUrl + entry.path, config: baseUrl + entry.path + '.json' };
}

async function cacheOpen() {
  if (!('caches' in self)) throw new Error('Dieser Browser kann keine Offline-Stimmen speichern (Cache API fehlt).');
  return caches.open(CACHE);
}

async function fetchWithProgress(url, onProgress, expectedBytes) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status})`);
  const total = Number(res.headers.get('Content-Length')) || expectedBytes || 0;
  if (!res.body || !res.body.getReader) {
    const b = await res.blob(); onProgress && onProgress(1); return b;
  }
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (onProgress && total) onProgress(Math.min(1, got / total));
  }
  return new Blob(chunks);
}

let dynamicVoices = [];
let catalogLoaded = false;
async function loadDynamicCatalog() {
  if (catalogLoaded) return;
  catalogLoaded = true;
  try {
    const res = await fetch(baseUrl + 'voices.json', { mode: 'cors' });
    if (!res.ok) return;
    const all = await res.json();
    const known = new Set(CATALOG.map(v => v.key));
    dynamicVoices = Object.values(all)
      .filter(v => v && v.language && v.language.family === 'de' && !known.has(v.key))
      .map(v => {
        const onnx = Object.keys(v.files || {}).find(f => f.endsWith('.onnx'));
        if (!onnx) return null;
        const name = String(v.name || v.key).replace(/_/g, ' ');
        return {
          key: v.key, label: name.charAt(0).toUpperCase() + name.slice(1) + (v.language.region && v.language.region !== 'DE' ? ` (${v.language.region})` : ''),
          gender: '?', quality: v.quality, size: Math.round((v.files[onnx].size_bytes || 0) / 1e6), path: onnx,
          multi: (v.num_speakers || 1) > 1, note: 'neu im Katalog',
        };
      }).filter(Boolean);
  } catch (e) { /* offline – egal */ }
}

export const piperEngine = {
  id: 'piper',
  label: 'Piper (offline)',
  renders: true,

  available() { return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && typeof BigInt64Array !== 'undefined'; },

  catalog() { return [...CATALOG, ...dynamicVoices]; },

  async refreshCatalog() { await loadDynamicCatalog(); return this.catalog(); },

  async isDownloaded(key) {
    const e = entryFor(key); if (!e) return false;
    try { const c = await cacheOpen(); const u = urlsFor(e); return !!(await c.match(u.model)) && !!(await c.match(u.config)); } catch (x) { return false; }
  },

  async downloadedKeys() {
    const out = [];
    for (const v of this.catalog()) if (await this.isDownloaded(v.key)) out.push(v.key);
    return out;
  },

  async download(key, onProgress) {
    const e = entryFor(key); if (!e) throw new Error('Unbekannte Stimme ' + key);
    const c = await cacheOpen();
    const u = urlsFor(e);
    const store = async (url, blob, type) => {
      try { await c.put(url, new Response(blob, { headers: { 'Content-Type': type } })); }
      catch (err) {
        if (err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''))) {
          throw new Error(`Nicht genug Speicherplatz für die Stimme „${e.label}“ (${e.size} MB). Entferne nicht benötigte Stimmen unter Einstellungen → Offline-Stimmen oder gib Speicher auf dem Handy frei.`);
        }
        throw err;
      }
    };
    if (!(await c.match(u.config))) {
      const cfg = await fetchWithProgress(u.config);
      await store(u.config, cfg, 'application/json');
    }
    if (!(await c.match(u.model))) {
      const blob = await fetchWithProgress(u.model, onProgress, e.size * 1e6);
      await store(u.model, blob, 'application/octet-stream');
    }
    onProgress && onProgress(1);
  },

  async remove(key) {
    const e = entryFor(key); if (!e) return;
    const c = await cacheOpen(); const u = urlsFor(e);
    await c.delete(u.model); await c.delete(u.config);
    loadedInWorker.delete(key); configs.delete(key);
    if (worker) { try { await call('unload', { key }); } catch (x) { /* */ } }
  },

  async config(key) {
    if (configs.has(key)) return configs.get(key);
    const e = entryFor(key); const c = await cacheOpen(); const u = urlsFor(e);
    let r = await c.match(u.config);
    if (!r) { await this.download(key); r = await c.match(u.config); }
    const cfg = await r.json();
    configs.set(key, cfg);
    return cfg;
  },

  // Stimmauswahl für die Oberfläche (inkl. MLS-Sprecher)
  voiceOptions() {
    const out = [];
    for (const v of this.catalog()) {
      if (v.multi && v.key === 'de_DE-mls-medium') {
        MLS_SPEAKERS.forEach((s, i) => out.push({ id: `${v.key}#${s}`, label: `MLS Stimme ${i + 1}`, gender: '?', group: v.label, size: v.size, key: v.key }));
      } else {
        out.push({ id: v.key, label: v.label, gender: v.gender, group: v.quality, size: v.size, key: v.key, note: v.note });
      }
    }
    return out;
  },

  async ensureLoaded(key, onProgress) {
    await ensureWorker();
    if (loadedInWorker.has(key)) {
      const r = await call('has', { key });
      if (r.ok) return;
      loadedInWorker.delete(key); // vom Worker verdrängt → neu laden
    }
    if (!(await this.isDownloaded(key))) await this.download(key, onProgress);
    const e = entryFor(key); const c = await cacheOpen(); const u = urlsFor(e);
    const model = await (await c.match(u.model)).arrayBuffer();
    const config = await this.config(key);
    await call('load', { key, model, config }, [model]);
    loadedInWorker.add(key);
  },

  // → { pcm: Float32Array, sampleRate }
  async synthesize({ text, voiceId, line, onProgress }) {
    const [key, spk] = String(voiceId || CATALOG[0].key).split('#');
    const job = async () => {
      await this.ensureLoaded(key, onProgress);
      const cfg = await this.config(key);
      const params = piperParamsFor(line);
      let speaker = spk != null ? Number(spk) : 0;
      if (cfg.speaker_id_map && Object.keys(cfg.speaker_id_map).length && spk == null) {
        const map = cfg.speaker_id_map;
        speaker = map[params.emotional] != null ? map[params.emotional] : (map.neutral != null ? map.neutral : 0);
      }
      const segments = String(text || '').split('⏸').map(cleanForPiper).filter(s => /\p{L}/u.test(s));
      const out = []; let rate = 22050;
      for (let i = 0; i < segments.length; i++) {
        const r = await call('synth', { key, text: segments[i], speaker, lengthScale: params.lengthScale });
        rate = r.sampleRate; out.push(r.pcm);
        if (i < segments.length - 1) out.push(new Float32Array(Math.round(rate * 0.7)));
      }
      const total = out.reduce((n, p) => n + p.length, 0);
      const pcm = new Float32Array(total); let o = 0; for (const p of out) { pcm.set(p, o); o += p.length; }
      return { pcm, sampleRate: rate };
    };
    // nacheinander abarbeiten (ein Worker)
    const p = queue.then(job, job);
    queue = p.catch(() => {});
    return p;
  },
};

function cleanForPiper(t) {
  return String(t || '')
    .replace(/[„“”"«»‚‘’]/g, '')
    .replace(/\s*[–—]\s*/g, ', ')
    .replace(/…|\.\.\./g, ',')
    .replace(/&/g, ' und ')
    .replace(/\*/g, '')
    .replace(/([!?.])\1+/g, '$1')
    .replace(/\s*,\s*([.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
