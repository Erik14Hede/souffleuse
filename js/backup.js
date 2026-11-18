// Souffleuse – Sicherung: Stücke (JSON) und optional gespeicherte Gemini-Audios
//
// Ohne Audios: normale JSON-Datei {app, version: 1, projects}.
// Mit Audios: Binärdatei
//   "SOUFFLEUSE-BACKUP2\n" | uint32 (LE) Länge Kopf | Kopf als JSON (UTF-8) | Audiodaten hintereinander
//   Kopf: {app, version: 2, projects, clips: [{key, engine, at, weights, bytes}]}
import { projects, clips } from './store.js';

const MAGIC = 'SOUFFLEUSE-BACKUP2\n';

function stripProject(p) {
  const { parsed, ...rest } = p;
  return rest;
}

export async function buildBackup({ withAudio = false } = {}) {
  const all = (await projects.all()).map(stripProject);
  const day = new Date().toISOString().slice(0, 10);
  if (!withAudio) {
    return {
      blob: new Blob([JSON.stringify({ app: 'souffleuse', version: 1, projects: all })], { type: 'application/json' }),
      name: `souffleuse-sicherung-${day}.json`, clips: 0,
    };
  }
  const entries = await clips.allWithPrefix('g|');
  const meta = [], parts = [];
  for (const [key, v] of entries) {
    if (!v || !v.pcm || !v.pcm.byteLength) continue;
    meta.push({ key, engine: v.engine || 'gemini', at: v.at || 0, weights: v.weights || null, bytes: v.pcm.byteLength });
    parts.push(v.pcm);
  }
  const head = new TextEncoder().encode(JSON.stringify({ app: 'souffleuse', version: 2, projects: all, clips: meta }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, head.byteLength, true);
  return {
    blob: new Blob([MAGIC, len, head, ...parts], { type: 'application/octet-stream' }),
    name: `souffleuse-sicherung-mit-audio-${day}.souffleuse`, clips: meta.length,
  };
}

// liest beide Formate; onProgress(0…1) für die Audios
export async function readBackup(file, onProgress = () => {}) {
  const start = new Uint8Array(await file.slice(0, MAGIC.length).arrayBuffer());
  const isBinary = new TextDecoder().decode(start) === MAGIC;
  let data = null, clipMeta = [], offset = 0;
  if (isBinary) {
    const lenBuf = await file.slice(MAGIC.length, MAGIC.length + 4).arrayBuffer();
    const headLen = new DataView(lenBuf).getUint32(0, true);
    const headStart = MAGIC.length + 4;
    try { data = JSON.parse(await file.slice(headStart, headStart + headLen).text()); } catch (e) { data = null; }
    clipMeta = (data && data.clips) || [];
    offset = headStart + headLen;
  } else {
    try { data = JSON.parse(await file.text()); } catch (e) { data = null; }
  }
  if (!data || data.app !== 'souffleuse' || !Array.isArray(data.projects)) throw new Error('Das ist keine Souffleuse-Sicherung.');

  // Audios in Paketen speichern (schont den Speicher bei großen Dateien)
  let saved = 0, batch = [], batchBytes = 0, failed = null;
  const flush = async () => {
    if (!batch.length) return;
    try { await clips.putMany(batch); saved += batch.length; } catch (e) { failed = e; }
    batch = []; batchBytes = 0;
  };
  for (let i = 0; i < clipMeta.length && !failed; i++) {
    const c = clipMeta[i];
    const pcm = await file.slice(offset, offset + c.bytes).arrayBuffer();
    offset += c.bytes;
    batch.push([c.key, { pcm, engine: c.engine, at: c.at, weights: c.weights || undefined }]);
    batchBytes += c.bytes;
    if (batch.length >= 40 || batchBytes > 8e6) { await flush(); onProgress((i + 1) / clipMeta.length); }
  }
  await flush();
  onProgress(1);
  return { projects: data.projects, clipsSaved: saved, clipsTotal: clipMeta.length, error: failed };
}
