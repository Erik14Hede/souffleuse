// Souffleuse – Ablaufplan, Audio-Erzeugung, Wiedergabe und MP3-Export
import { isMine } from './format.js';
import { deviceEngine } from './engines/device.js';
import { piperEngine } from './engines/piper.js';
import { geminiEngine } from './engines/gemini.js';
import { prosodyFor, styleFor, classifyEmotion } from './emotion.js';
import { assignment, speakerForLine, NARRATOR } from './cast.js';
import { clips } from './store.js';
import { MASTER_RATE, prepareClip, packClip, unpackClip, concat, silence, beep, wavBlob, encodeMp3, hashString } from './audio.js';

export const ENGINES = { device: deviceEngine, piper: piperEngine, gemini: geminiEngine };

export const MODES = {
  all: { label: 'Alle Rollen', hint: 'Alles wird vorgelesen, auch deine Rolle.' },
  pause: { label: 'Pause für mich', hint: 'Deine Zeilen bleiben stumm – sprich sie in die Pause.' },
  reveal: { label: 'Pause + Auflösung', hint: 'Erst Pause zum Selbersprechen, dann hörst du deinen Satz zur Kontrolle.' },
  tap: { label: 'Warten bis ich tippe', hint: 'Die App wartet bei deinen Zeilen, bis du auf „Weiter“ tippst.' },
};

export const DEFAULT_PLAY = { mode: 'pause', cuesOnly: false, hideMine: false, directions: false, songs: 'speak', includeEnsemble: true, pauseFactor: 1.3, speed: 1, beep: true, revealAfterTap: false, autoNext: false };

// ---------------- Ablaufplan ----------------
export function pauseSeconds(line, factor = 1.3) {
  const len = (line && line.spoken ? line.spoken.replace(/⏸/g, '').length : 20);
  const pauses = (line && line.spoken ? (line.spoken.match(/⏸/g) || []).length : 0);
  return Math.max(1.6, (len / 14 + 0.9 + pauses * 0.7) * factor);
}

export function buildPlan(scene, project, play, engineId, bundle = false) {
  const my = project.myRoles || [];
  const steps = [];
  for (const ln of scene.lines) {
    if (ln.kind === 'direction') {
      if (play.directions && ln.spoken && /\p{L}/u.test(ln.spoken)) steps.push({ type: 'say', lines: [ln], speaker: NARRATOR, narrator: true });
      else steps.push({ type: 'show', lines: [ln] });
      continue;
    }
    if (ln.song && play.songs === 'skip') { steps.push({ type: 'show', lines: [ln], skipped: true }); continue; }
    const mine = isMine(ln, my, play.includeEnsemble);
    if (mine && play.mode !== 'all' && my.length) steps.push({ type: 'mine', lines: [ln], speaker: speakerForLine(ln) });
    else steps.push({ type: 'say', lines: [ln], speaker: speakerForLine(ln), mine });
  }
  let out = steps;
  if (play.cuesOnly && my.length) {
    out = [];
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].type !== 'mine') continue;
      let j = i - 1;
      while (j >= 0 && steps[j].type === 'show') j--;
      const prevMine = out.length && out[out.length - 1].type === 'mine' && out[out.length - 1].lines[0] === (steps[j] && steps[j].lines[0]);
      if (j >= 0 && steps[j].type === 'say' && !prevMine) {
        if (out.length) out.push({ type: 'gap', lines: [] });
        out.push(steps[j]);
      } else if (out.length && !(j >= 0 && steps[j].type === 'mine')) {
        out.push({ type: 'gap', lines: [] });
      }
      out.push(steps[i]);
    }
  }
  // Gemini: aufeinanderfolgende Repliken (max. 2 Stimmen) bündeln → weniger Anfragen
  if (bundle && engineId === 'gemini') {
    const merged = [];
    for (const st of out) {
      const last = merged[merged.length - 1];
      if (st.type === 'say' && !st.narrator && last && last.type === 'say' && !last.narrator && !last.mine && !st.mine) {
        const speakers = new Set([...last.lines.map(speakerForLine), speakerForLine(st.lines[0])]);
        const chars = last.lines.reduce((n, l) => n + l.spoken.length, 0) + st.lines[0].spoken.length;
        if (speakers.size <= 2 && chars <= 1400 && last.lines.length < 8) { last.lines = [...last.lines, ...st.lines]; continue; }
      }
      merged.push(st.type === 'say' ? { ...st, lines: [...st.lines] } : st);
    }
    out = merged;
  }
  return out;
}

// ---------------- Audio-Clips ----------------
const memo = new Map();
const MEMO_MAX = 80;
function remember(key, value) {
  memo.set(key, value);
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
}

function clipDescriptor(step, project, engineId, settings) {
  if (engineId === 'piper') {
    const ln = step.lines[0];
    const a = assignment(project, 'piper', step.speaker);
    const emo = step.narrator ? 'neutral' : classifyEmotion(ln.emotion, ln.delivery).key;
    return { engineId, key: 'p|' + hashString([a.voiceId, emo, ln.spoken].join('|')), voiceId: a.voiceId };
  }
  if (engineId === 'gemini') {
    const model = settings.geminiTtsModel;
    const parts = step.lines.map(l => {
      const sp = step.narrator ? NARRATOR : speakerForLine(l);
      const a = assignment(project, 'gemini', sp);
      return [sp, a.voiceId, step.narrator ? 'calm narrator' : styleFor(l), l.spoken].join('~');
    });
    return { engineId, key: 'g|' + hashString(model + '|' + parts.join('||')) };
  }
  return null;
}

export class ClipProvider {
  constructor(project, engineId, settings) {
    this.project = project; this.engineId = engineId; this.settings = settings;
    this.inflight = new Map();
  }
  descriptor(step) { return clipDescriptor(step, this.project, this.engineId, this.settings); }
  async has(step) {
    const d = this.descriptor(step); if (!d) return false;
    return memo.has(d.key) || clips.has(d.key);
  }
  async get(step, onProgress) {
    const d = this.descriptor(step);
    if (!d) throw new Error('Kein Clip für diese Engine');
    if (memo.has(d.key)) return memo.get(d.key);
    if (this.inflight.has(d.key)) return this.inflight.get(d.key);
    const p = (async () => {
      const saved = await clips.get(d.key);
      if (saved && saved.pcm) {
        const v = { pcm: unpackClip(saved.pcm), fromCache: true, key: d.key, weights: saved.weights };
        remember(d.key, v); return v;
      }
      const res = await this.synthesize(step, onProgress);
      const pcm = prepareClip(res.pcm, res.sampleRate);
      const weights = step.lines.map(l => Math.max(1, l.spoken.length));
      const v = { pcm, fromCache: false, key: d.key, weights };
      remember(d.key, v);
      try { await clips.put(d.key, { pcm: packClip(pcm), engine: this.engineId, at: Date.now(), weights }); } catch (e) { console.warn('Clip nicht gespeichert', e); }
      return v;
    })();
    this.inflight.set(d.key, p);
    try { return await p; } finally { this.inflight.delete(d.key); }
  }
  async synthesize(step, onProgress) {
    const s = this.settings;
    if (this.engineId === 'piper') {
      const ln = step.lines[0];
      const a = assignment(this.project, 'piper', step.speaker);
      return piperEngine.synthesize({ text: ln.spoken, voiceId: a.voiceId, line: step.narrator ? null : ln, onProgress });
    }
    if (this.engineId === 'gemini') {
      const common = { apiKey: s.geminiKey, model: s.geminiTtsModel, minIntervalMs: s.geminiMinIntervalMs };
      if (step.lines.length === 1) {
        const ln = step.lines[0];
        const sp = step.narrator ? NARRATOR : speakerForLine(ln);
        const a = assignment(this.project, 'gemini', sp);
        return geminiEngine.synthesize({ ...common, text: ln.spoken, voiceId: a.voiceId || 'Kore', style: step.narrator ? 'calm, neutral narrator' : styleFor(ln) });
      }
      const nameOf = (key) => (this.project.parsed.characters.find(c => c.key === key) || { name: key }).name.replace(/[^\p{L}\p{N} ]/gu, '').trim() || 'Sprecher';
      const voices = {};
      const turns = step.lines.map(l => {
        const key = speakerForLine(l); const name = nameOf(key);
        voices[name] = assignment(this.project, 'gemini', key).voiceId || 'Kore';
        return { speaker: name, text: l.spoken, style: styleFor(l) };
      });
      // gleiche Stimme für beide? → Gemini braucht 2 verschiedene Sprecher-Namen, das passt trotzdem
      return geminiEngine.synthesizeDialog({ ...common, turns, voices });
    }
    throw new Error('Unbekannte Engine');
  }
}

// ---------------- Wiedergabe ----------------
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
let audioEl = null;
export function getAudioEl() {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = 'auto';
    audioEl.setAttribute('playsinline', '');
  }
  return audioEl;
}
// synchron im Tipp-Handler aufrufen (iOS/Android Autoplay-Regeln)
export function unlockAudio() {
  const a = getAudioEl();
  try { a.src = SILENT_WAV; const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* */ }
  deviceEngine.unlock();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class Player {
  constructor({ project, scene, settings, play, engineId, on = {} }) {
    this.project = project; this.scene = scene; this.settings = settings; this.play = { ...DEFAULT_PLAY, ...play };
    this.engineId = engineId; this.on = on;
    this.plan = buildPlan(scene, project, this.play, engineId, settings.geminiBundle);
    this.provider = ENGINES[engineId].renders ? new ClipProvider(project, engineId, settings) : null;
    this.i = 0; this.token = 0; this.state = 'idle';
    this._tapResolve = null; this._objectUrl = null;
  }

  emit(name, ...args) { try { this.on[name] && this.on[name](...args); } catch (e) { console.error(e); } }
  setState(s, extra) { this.state = s; this.emit('state', s, extra); }

  stepIndexForLine(lineId) {
    const idx = this.plan.findIndex(st => st.lines.some(l => l.id === lineId));
    return idx < 0 ? 0 : idx;
  }

  start(fromIndex = this.i) {
    this.stopAudio();
    this.i = Math.max(0, Math.min(fromIndex, this.plan.length - 1));
    const token = ++this.token;
    this.setState('playing');
    this.run(token).catch((e) => {
      if (token !== this.token) return;
      console.error(e);
      this.setState('error', e);
      this.emit('error', e);
    });
  }

  pause() { this.token++; this.stopAudio(); this.setState('paused'); }
  stop() { this.token++; this.stopAudio(); this.setState('idle'); }
  next() { const n = Math.min(this.plan.length - 1, this.i + 1); this.start(n); }
  prev() {
    let n = this.i - 1;
    while (n > 0 && (this.plan[n].type === 'show' || this.plan[n].type === 'gap')) n--;
    this.start(Math.max(0, n));
  }
  tap() { if (this._tapResolve) { const r = this._tapResolve; this._tapResolve = null; r(); } }

  stopAudio() {
    deviceEngine.cancel();
    const a = getAudioEl();
    try { a.pause(); } catch (e) { /* */ }
    a.onended = null; a.ontimeupdate = null; a.onerror = null;
    if (this._objectUrl) { URL.revokeObjectURL(this._objectUrl); this._objectUrl = null; }
    if (this._tapResolve) { const r = this._tapResolve; this._tapResolve = null; r('cancel'); }
  }

  prefetch(from) {
    if (!this.provider) return;
    let n = 0;
    const ahead = this.engineId === 'gemini' ? 2 : 4; // Gemini-Kontingent schonen
    for (let k = from; k < this.plan.length && n < ahead; k++) {
      const st = this.plan[k];
      const needs = st.type === 'say' || (st.type === 'mine' && (this.play.mode === 'reveal' || (this.play.mode === 'tap' && this.play.revealAfterTap)));
      if (!needs) continue;
      n++;
      this.provider.get(st).catch(() => {});
    }
  }

  async run(token) {
    while (this.i < this.plan.length) {
      if (token !== this.token) return;
      const st = this.plan[this.i];
      this.emit('step', st, this.i);
      if (st.type === 'show') { this.i++; continue; }
      this.prefetch(this.i + 1);
      if (st.type === 'say') {
        this.emit('line', st.lines[0], 'say');
        await this.playStep(st, token);
      } else if (st.type === 'mine') {
        await this.playMine(st, token);
      } else if (st.type === 'gap') {
        await sleep(900 / this.play.speed);
      }
      if (token !== this.token) return;
      await sleep((this.settings.gapMs || 350) / this.play.speed);
      if (token !== this.token) return;
      this.i++;
    }
    this.setState('done');
    this.emit('done');
  }

  async playMine(st, token) {
    const ln = st.lines[0];
    this.emit('line', ln, 'mine');
    const mode = this.play.mode;
    if (mode === 'tap') {
      this.setState('waiting');
      const r = await new Promise((resolve) => { this._tapResolve = resolve; });
      if (token !== this.token || r === 'cancel') return;
      this.setState('playing');
      this.emit('reveal', ln);
      if (this.play.revealAfterTap) await this.playStep({ ...st, type: 'say' }, token, true);
      return;
    }
    // Pause zum Selbersprechen
    if (this.play.beep) await this.playPcm(beep(), token);
    if (token !== this.token) return;
    const secs = pauseSeconds(ln, this.play.pauseFactor) / this.play.speed;
    this.setState('mine', { seconds: secs, line: ln });
    const t0 = Date.now();
    while (Date.now() - t0 < secs * 1000) {
      if (token !== this.token) return;
      if (this._skipPause) { this._skipPause = false; break; }
      await sleep(80);
    }
    this.setState('playing');
    this.emit('reveal', ln);
    if (mode === 'reveal') await this.playStep({ ...st, type: 'say' }, token, true);
  }

  skipPause() { this._skipPause = true; }

  async playStep(st, token, isReveal = false) {
    if (this.engineId === 'device') {
      for (const ln of st.lines) {
        if (token !== this.token) return;
        const speaker = st.narrator ? NARRATOR : speakerForLine(ln);
        const a = assignment(this.project, 'device', speaker);
        const pr = st.narrator ? { rate: 1, pitch: 1, volume: 1 } : prosodyFor(ln);
        this.emit('line', ln, isReveal ? 'reveal' : 'say');
        await deviceEngine.speak({
          text: ln.spoken, voiceId: a.voiceId,
          rate: (a.rate || 1) * pr.rate * this.play.speed,
          pitch: (a.pitch || 1) * pr.pitch,
          volume: pr.volume * (isReveal ? 0.9 : 1),
        });
      }
      return;
    }
    // Render-Engines: Clip holen (ggf. erzeugen) und abspielen
    let clip;
    const cached = await this.provider.has(st);
    if (!cached) this.setState('loading', { line: st.lines[0] });
    try {
      clip = await this.provider.get(st, (p) => this.emit('download', p));
    } catch (e) {
      if (token !== this.token) return;
      throw e;
    }
    if (token !== this.token) return;
    this.setState('playing');
    // Zeilen-Markierung innerhalb gebündelter Clips
    const total = clip.pcm.length / MASTER_RATE;
    const w = clip.weights && clip.weights.length === st.lines.length ? clip.weights : st.lines.map(l => l.spoken.length || 1);
    const sum = w.reduce((a, b) => a + b, 0);
    let acc = 0;
    const bounds = w.map(x => { const s = acc; acc += x; return { start: (s / sum) * total, end: (acc / sum) * total }; });
    await this.playPcm(clip.pcm, token, (t) => {
      const k = bounds.findIndex(b => t >= b.start && t < b.end);
      if (k >= 0) this.emit('line', st.lines[k], isReveal ? 'reveal' : 'say');
    });
  }

  playPcm(pcm, token, onTime) {
    return new Promise((resolve) => {
      if (token !== this.token) return resolve();
      const a = getAudioEl();
      if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = URL.createObjectURL(wavBlob(pcm, MASTER_RATE));
      a.onended = () => { a.onended = null; resolve(); };
      a.onerror = () => { a.onerror = null; resolve(); };
      a.ontimeupdate = onTime ? () => onTime(a.currentTime) : null;
      a.src = this._objectUrl;
      try { a.preservesPitch = true; a.webkitPreservesPitch = true; } catch (e) { /* */ }
      a.playbackRate = this.play.speed;
      const p = a.play();
      if (p && p.catch) p.catch((e) => { console.warn('Wiedergabe blockiert', e); this.emit('blocked', e); resolve(); });
      const guard = setInterval(() => { if (token !== this.token) { clearInterval(guard); resolve(); } }, 200);
      const done = () => clearInterval(guard);
      a.addEventListener('ended', done, { once: true });
    });
  }
}

// ---------------- Szene als Audiodatei ----------------
export async function renderScene({ project, scene, settings, play, engineId, format = 'mp3', onProgress }) {
  const p = { ...DEFAULT_PLAY, ...play };
  if (p.mode === 'tap') p.mode = 'reveal';
  const plan = buildPlan(scene, project, p, engineId, settings.geminiBundle);
  const provider = new ClipProvider(project, engineId, settings);
  const needed = plan.filter(st => st.type === 'say' || (st.type === 'mine' && p.mode === 'reveal'));
  let done = 0;
  const parts = [];
  const timeline = [];
  let t = 0;
  const push = (pcm) => { parts.push(pcm); t += pcm.length / MASTER_RATE; };
  push(silence(0.4));
  for (const st of plan) {
    if (st.type === 'show') continue;
    if (st.type === 'gap') { push(silence(1.0)); continue; }
    if (st.type === 'say') {
      const clip = await provider.get(st);
      timeline.push({ start: t, lines: st.lines.map(l => l.id) });
      push(clip.pcm);
      done++; onProgress && onProgress(done / Math.max(1, needed.length), st.lines[0]);
    } else if (st.type === 'mine') {
      if (p.beep) push(beep());
      timeline.push({ start: t, lines: st.lines.map(l => l.id), mine: true });
      push(silence(pauseSeconds(st.lines[0], p.pauseFactor)));
      if (p.mode === 'reveal') {
        const clip = await provider.get({ ...st, type: 'say' });
        push(clip.pcm);
        done++; onProgress && onProgress(done / Math.max(1, needed.length), st.lines[0]);
      }
    }
    push(silence((settings.gapMs || 350) / 1000));
  }
  push(silence(0.6));
  const pcm = concat(parts);
  onProgress && onProgress(1, null, 'encode');
  const blob = format === 'wav' ? wavBlob(pcm, MASTER_RATE) : await encodeMp3(pcm, MASTER_RATE, 64);
  return { blob, seconds: pcm.length / MASTER_RATE, timeline };
}

// Wie viele Clips fehlen noch (z. B. für Gemini-Kontingent)?
export async function missingClips({ project, scene, settings, play, engineId }) {
  if (!ENGINES[engineId].renders) return { total: 0, missing: 0 };
  const p = { ...DEFAULT_PLAY, ...play };
  const plan = buildPlan(scene, project, p, engineId, settings.geminiBundle);
  const provider = new ClipProvider(project, engineId, settings);
  let total = 0, missing = 0;
  for (const st of plan) {
    const needs = st.type === 'say' || (st.type === 'mine' && (p.mode === 'reveal' || (p.mode === 'tap' && p.revealAfterTap)));
    if (!needs) continue;
    total++;
    const s = st.type === 'mine' ? { ...st, type: 'say' } : st;
    if (!(await provider.has(s))) missing++;
  }
  return { total, missing };
}
