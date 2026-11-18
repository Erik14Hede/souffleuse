// Souffleuse – Audio-Hilfsfunktionen (WAV, Resampling, Zusammenfügen, MP3)

export const MASTER_RATE = 24000;

export function int16ToFloat32(i16) {
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
  return out;
}
export function float32ToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out[i] = v < 0 ? v * 32768 : v * 32767;
  }
  return out;
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function isWav(bytes) {
  return bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
}

// WAV (PCM 16/24/32 Bit oder Float) → mono Float32
export function decodeWav(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    let size = dv.getUint32(pos + 4, true);
    const start = pos + 8;
    if (id === 'fmt ') {
      fmt = { format: dv.getUint16(start, true), channels: dv.getUint16(start + 2, true), rate: dv.getUint32(start + 4, true), bits: dv.getUint16(start + 14, true) };
    } else if (id === 'data') {
      if (size === 0 || size === 0xFFFFFFFF || start + size > bytes.length) size = bytes.length - start; // Streaming-WAV
      data = { start, size };
      break;
    }
    pos = start + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('Ungültige WAV-Datei');
  const ch = fmt.channels || 1;
  const bps = fmt.bits / 8;
  const frames = Math.floor(data.size / (bps * ch));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < ch; c++) {
      const o = data.start + (i * ch + c) * bps;
      let v;
      if (fmt.format === 3 && bps === 4) v = dv.getFloat32(o, true);
      else if (bps === 2) v = dv.getInt16(o, true) / 32768;
      else if (bps === 3) { const b = (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)); v = ((b & 0x800000) ? b - 0x1000000 : b) / 8388608; }
      else if (bps === 4) v = dv.getInt32(o, true) / 2147483648;
      else v = (bytes[o] - 128) / 128;
      acc += v;
    }
    out[i] = acc / ch;
  }
  return { pcm: out, sampleRate: fmt.rate };
}

export function encodeWav(f32, sampleRate) {
  const n = f32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++, o += 2) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    dv.setInt16(o, v < 0 ? v * 32768 : v * 32767, true);
  }
  return buf;
}

// Resampling mit gefenstertem Sinc-Tiefpass (gut genug für Sprache)
export function resample(f32, from, to) {
  if (from === to) return f32;
  const ratio = to / from;
  const outLen = Math.max(1, Math.round(f32.length * ratio));
  const out = new Float32Array(outLen);
  const cutoff = Math.min(1, ratio) * 0.94; // relative Grenzfrequenz
  const half = 8; // Filterhalbbreite in Eingangs-Samples (skaliert)
  const scale = cutoff;
  const width = Math.ceil(half / scale);
  for (let i = 0; i < outLen; i++) {
    const center = i / ratio;
    const left = Math.max(0, Math.floor(center - width));
    const right = Math.min(f32.length - 1, Math.ceil(center + width));
    let acc = 0, norm = 0;
    for (let j = left; j <= right; j++) {
      const x = (j - center) * scale;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const t = (j - center) / (width + 1);
      const win = 0.5 + 0.5 * Math.cos(Math.PI * Math.max(-1, Math.min(1, t)));
      const k = sinc * win;
      acc += f32[j] * k; norm += k;
    }
    out[i] = norm ? acc / norm : 0;
  }
  return out;
}

export function silence(seconds, rate = MASTER_RATE) {
  return new Float32Array(Math.max(0, Math.round(seconds * rate)));
}

export function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Stille am Anfang/Ende kürzen (lässt kleinen Rand)
export function trimSilence(f32, rate, threshold = 0.008, keep = 0.06) {
  let s = 0, e = f32.length - 1;
  while (s < f32.length && Math.abs(f32[s]) < threshold) s++;
  while (e > s && Math.abs(f32[e]) < threshold) e--;
  const pad = Math.round(keep * rate);
  s = Math.max(0, s - pad); e = Math.min(f32.length - 1, e + pad);
  return e > s ? f32.subarray(s, e + 1) : f32;
}

// Lautheit angleichen (RMS-Ziel, Spitzen begrenzen)
export function normalize(f32, targetRms = 0.085, maxPeak = 0.95) {
  let sum = 0, peak = 0;
  for (let i = 0; i < f32.length; i++) { const v = f32[i]; sum += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
  const rms = Math.sqrt(sum / Math.max(1, f32.length));
  if (rms < 1e-5) return f32;
  let gain = targetRms / rms;
  if (peak * gain > maxPeak) gain = maxPeak / peak;
  gain = Math.min(gain, 6);
  const out = new Float32Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = f32[i] * gain;
  return out;
}

// Ein Clip in Master-Rate, gekürzt und normalisiert
export function prepareClip(pcm, rate) {
  let x = resample(pcm, rate, MASTER_RATE);
  x = trimSilence(x, MASTER_RATE);
  return normalize(x);
}

// kurzer, leiser Signalton (Hinweis „du bist dran“)
export function beep(rate = MASTER_RATE, freq = 880, dur = 0.12, vol = 0.12) {
  const n = Math.round(dur * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / (0.01 * rate)) * Math.min(1, (n - i) / (0.03 * rate));
    out[i] = Math.sin(2 * Math.PI * freq * i / rate) * vol * env;
  }
  return out;
}

// ---------- MP3 (lamejs) ----------
let lamePromise = null;
function loadLame() {
  if (typeof window === 'undefined') return Promise.reject(new Error('kein Browser'));
  if (window.lamejs) return Promise.resolve(window.lamejs);
  if (!lamePromise) {
    lamePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../vendor/lame/lame.min.js', import.meta.url).href;
      s.onload = () => resolve(window.lamejs);
      s.onerror = () => reject(new Error('MP3-Encoder konnte nicht geladen werden'));
      document.head.appendChild(s);
    });
  }
  return lamePromise;
}

export async function encodeMp3(f32, rate = MASTER_RATE, kbps = 64, onProgress) {
  const lamejs = await loadLame();
  const enc = new lamejs.Mp3Encoder(1, rate, kbps);
  const i16 = float32ToInt16(f32);
  const chunk = 1152 * 20;
  const parts = [];
  for (let i = 0; i < i16.length; i += chunk) {
    const buf = enc.encodeBuffer(i16.subarray(i, i + chunk));
    if (buf.length) parts.push(new Uint8Array(buf));
    if (onProgress && (i / chunk) % 20 === 0) { onProgress(i / i16.length); await new Promise(r => setTimeout(r, 0)); }
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  return new Blob(parts, { type: 'audio/mpeg' });
}

export function wavBlob(f32, rate = MASTER_RATE) {
  return new Blob([encodeWav(f32, rate)], { type: 'audio/wav' });
}

// Clip-Speicherformat: Int16-ArrayBuffer in Master-Rate
export function packClip(f32) { return float32ToInt16(f32).buffer; }
export function unpackClip(buf) { return int16ToFloat32(new Int16Array(buf)); }

// einfacher, stabiler Hash für Cache-Schlüssel
export function hashString(str) {
  let h1 = 0xdeadbeef ^ str.length, h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Zeilengrenzen in einem gebündelten Clip (mehrere Repliken in einer Aufnahme) finden:
// Startpunkt ist die Schätzung nach Textlänge, dann wird jede Grenze auf die passendste
// Sprechpause in ihrer Nähe verschoben. Ergebnis: [{start, end}] in Sekunden.
export function alignLineBounds(pcm, rate, weights) {
  const total = pcm.length / rate;
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  const est = weights.map(w => { acc += w; return (acc / sum) * total; }).slice(0, -1); // erwartete Grenzen
  if (!est.length) return [{ start: 0, end: total }];

  // Lautstärke in 20-ms-Fenstern
  const hop = Math.round(rate * 0.02);
  const rms = [];
  for (let i = 0; i + hop <= pcm.length; i += hop) {
    let s = 0; for (let j = i; j < i + hop; j++) s += pcm[j] * pcm[j];
    rms.push(Math.sqrt(s / hop));
  }
  const sorted = rms.slice().sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.9)] || 0;
  const thr = Math.max(0.004, loud * 0.08);
  // Pausen ≥ 160 ms sammeln
  const gaps = [];
  let runStart = -1;
  for (let k = 0; k <= rms.length; k++) {
    const quiet = k < rms.length && rms[k] < thr;
    if (quiet && runStart < 0) runStart = k;
    if (!quiet && runStart >= 0) {
      const dur = (k - runStart) * 0.02;
      if (dur >= 0.16 && runStart > 0 && k < rms.length) gaps.push({ mid: (runStart + k) / 2 * 0.02, dur });
      runStart = -1;
    }
  }
  // jede Grenze der Reihe nach auf die beste Pause in der Nähe legen
  const cuts = [];
  let prev = 0;
  const window = Math.max(1.5, total / (weights.length + 1));
  for (let i = 0; i < est.length; i++) {
    const remaining = est.length - i - 1;
    let best = null, bestScore = -Infinity;
    for (const g of gaps) {
      if (g.mid <= prev + 0.3) continue;
      // für die restlichen Grenzen muss noch Platz bleiben
      if (remaining && g.mid > total - remaining * 0.3) continue;
      const dist = Math.abs(g.mid - est[i]);
      if (dist > window) continue;
      const score = g.dur * 2 - dist / window;
      if (score > bestScore) { bestScore = score; best = g; }
    }
    const cut = best ? best.mid : Math.max(prev + 0.3, est[i]);
    cuts.push(cut); prev = cut;
  }
  const out = [];
  let s = 0;
  for (const c of cuts) { out.push({ start: s, end: c }); s = c; }
  out.push({ start: s, end: total });
  return out;
}
