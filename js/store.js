// Souffleuse – Speicher (IndexedDB für Stücke und Audio, localStorage für Einstellungen)

const DB_NAME = 'souffleuse';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('clips')) db.createObjectStore('clips');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Datenbank blockiert – bitte andere Tabs der App schließen.'));
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; }).catch(reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaktion abgebrochen'));
  }));
}
const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const projects = {
  async all() {
    const list = await tx('projects', 'readonly', s => req2p(s.getAll()));
    return (list || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },
  get(id) { return tx('projects', 'readonly', s => req2p(s.get(id))); },
  put(p) { p.updatedAt = Date.now(); return tx('projects', 'readwrite', s => req2p(s.put(p))); },
  remove(id) { return tx('projects', 'readwrite', s => req2p(s.delete(id))); },
};

export const clips = {
  get(key) { return tx('clips', 'readonly', s => req2p(s.get(key))); },
  put(key, value) { return tx('clips', 'readwrite', s => req2p(s.put(value, key))); },
  async has(key) { return (await tx('clips', 'readonly', s => req2p(s.count(key)))) > 0; },
  async count() { return tx('clips', 'readonly', s => req2p(s.count())); },
  clear() { return tx('clips', 'readwrite', s => req2p(s.clear())); },
  async sizeEstimate() {
    let bytes = 0, n = 0;
    await tx('clips', 'readonly', s => new Promise((resolve, reject) => {
      const r = s.openCursor();
      r.onsuccess = () => { const c = r.result; if (!c) return resolve(); n++; const v = c.value; bytes += (v && v.pcm && v.pcm.byteLength) || 0; c.continue(); };
      r.onerror = () => reject(r.error);
    }));
    return { bytes, n };
  },
};

export const kv = {
  get(key) { return tx('kv', 'readonly', s => req2p(s.get(key))); },
  set(key, value) { return tx('kv', 'readwrite', s => req2p(s.put(value, key))); },
};

// ---------- Einstellungen ----------
const SETTINGS_KEY = 'souffleuse.settings.v1';
export const DEFAULT_SETTINGS = {
  geminiKey: '',
  geminiTtsModel: 'gemini-3.8-flash-tts',
  geminiTextModel: 'gemini-flash-latest',
  geminiMinIntervalMs: 2500,
  geminiBundle: true,
  piperBaseUrl: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/',
  defaultEngine: 'device',
  pauseFactor: 1.3,
  gapMs: 350,
  speed: 1,
};

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { ...DEFAULT_SETTINGS, ...s };
  } catch (e) { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* voll */ }
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if (!already) return await navigator.storage.persist();
      return true;
    }
  } catch (e) { /* egal */ }
  return false;
}

export async function storageEstimate() {
  try { if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate(); } catch (e) { /* */ }
  return null;
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
