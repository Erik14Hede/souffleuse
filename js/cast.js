// Souffleuse – Stimmen den Rollen zuordnen
import { deviceEngine } from './engines/device.js';
import { piperEngine } from './engines/piper.js';
import { GEMINI_VOICES } from './engines/gemini.js';
import { normalizeKey, isEnsembleKey } from './format.js';

export const NARRATOR = '__NARRATOR__';
const PITCHES = [1, 0.88, 1.12, 0.8, 1.2, 0.94, 1.06, 0.84, 1.16];
// Bewusst nur je zwei Modelle pro Geschlecht, damit der Download überschaubar bleibt (~270 MB)
const PIPER_DEFAULTS = {
  f: ['de_DE-kerstin-low', 'de_DE-ramona-low'],
  m: ['de_DE-thorsten_emotional-medium', 'de_DE-karlsson-low'],
};

export async function voiceOptions(engineId) {
  if (engineId === 'device') return deviceEngine.voices();
  if (engineId === 'piper') { await piperEngine.refreshCatalog(); return piperEngine.voiceOptions(); }
  if (engineId === 'gemini') return GEMINI_VOICES;
  return [];
}

export function castKeys(project) {
  const keys = (project.parsed && project.parsed.characters || []).map(c => c.key);
  return [...keys, NARRATOR];
}

function genderOf(project, key) {
  if (key === NARRATOR) return '?';
  const c = (project.parsed && project.parsed.characters || []).find(x => x.key === key);
  return (c && c.gender) || '?';
}

// Rollen nach Anzahl der Repliken sortiert (wichtige Rollen bekommen die besten Stimmen)
function rankedKeys(project) {
  const chars = (project.parsed && project.parsed.characters || []).slice();
  chars.sort((a, b) => (b.count || 0) - (a.count || 0));
  return [...chars.map(c => c.key), NARRATOR];
}

export function autoAssign(project, engineId, options, { force = false } = {}) {
  project.cast = project.cast || {};
  const used = new Map(); // voiceId → count
  const pools = {
    f: options.filter(v => v.gender === 'f'),
    m: options.filter(v => v.gender === 'm'),
    any: options.slice(),
  };
  if (engineId === 'piper') {
    const byId = new Map(options.map(o => [o.id, o]));
    pools.f = PIPER_DEFAULTS.f.map(id => byId.get(id)).filter(Boolean);
    pools.m = PIPER_DEFAULTS.m.map(id => byId.get(id)).filter(Boolean);
    pools.any = [...pools.m, ...pools.f];
  }
  const counters = { f: 0, m: 0, any: 0 };
  for (const key of rankedKeys(project)) {
    const entry = project.cast[key] = project.cast[key] || {};
    if (entry[engineId] && entry[engineId].voiceId && !force && options.some(o => o.id === entry[engineId].voiceId)) {
      used.set(entry[engineId].voiceId, (used.get(entry[engineId].voiceId) || 0) + 1);
      continue;
    }
    let g = genderOf(project, key);
    if (key === NARRATOR) g = 'any';
    let pool = (g === 'f' || g === 'm') && pools[g].length ? pools[g] : pools.any;
    let poolName = pool === pools.f ? 'f' : pool === pools.m ? 'm' : 'any';
    if (!pool.length) { entry[engineId] = { voiceId: '' }; continue; }
    // Erzähler: möglichst eine Stimme, die sonst niemand hat
    let pick;
    if (key === NARRATOR) {
      pick = pool.find(v => !used.has(v.id)) || pool[pool.length - 1];
    } else {
      pick = pool[counters[poolName] % pool.length];
      counters[poolName]++;
    }
    const n = used.get(pick.id) || 0;
    used.set(pick.id, n + 1);
    entry[engineId] = { voiceId: pick.id };
    if (engineId === 'device') entry[engineId].pitch = PITCHES[n % PITCHES.length];
  }
  return project.cast;
}

export function assignment(project, engineId, speakerKey) {
  const key = normalizeKey(speakerKey) === normalizeKey(NARRATOR) ? NARRATOR : normalizeKey(speakerKey);
  const e = project.cast && project.cast[key] && project.cast[key][engineId];
  if (e && (e.voiceId || engineId === 'device')) return e;
  // Ensemble/unbekannt → Erzähler- oder erste Stimme
  const fallbackKey = isEnsembleKey(key) ? NARRATOR : NARRATOR;
  const f = project.cast && project.cast[fallbackKey] && project.cast[fallbackKey][engineId];
  return f || { voiceId: '' };
}

export function speakerForLine(line) {
  if (!line || line.kind !== 'speech') return NARRATOR;
  return line.speakers && line.speakers.length ? line.speakers[0] : line.speakerKey || NARRATOR;
}
