/* Souffleuse – Piper-Sprachsynthese im Hintergrund-Thread (klassischer Worker) */
/* global importScripts, ort, createPiperPhonemize */

var phonemizer = null;
var phonOut = [];
var sessions = new Map(); // key -> { session, config, used }
var MAX_SESSIONS = 3;

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

async function init(msg) {
  if (phonemizer) return;
  importScripts(msg.ortScript);
  importScripts(msg.phonemizeScript);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.wasmPaths = msg.ortBase;
  phonemizer = await createPiperPhonemize({
    print: function (d) { phonOut.push(d); },
    printErr: function (m) { if (m && !/^warning/i.test(m)) console.warn('[piper-phonemize]', m); },
    locateFile: function (u) { return msg.phonemizeBase + u; },
  });
}

async function load(msg) {
  if (sessions.has(msg.key)) { sessions.get(msg.key).used = Date.now(); return; }
  if (sessions.size >= MAX_SESSIONS) {
    var oldest = null;
    sessions.forEach(function (v, k) { if (!oldest || v.used < sessions.get(oldest).used) oldest = k; });
    try { await sessions.get(oldest).session.release(); } catch (e) { /* egal */ }
    sessions.delete(oldest);
  }
  var session = await ort.InferenceSession.create(new Uint8Array(msg.model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  sessions.set(msg.key, { session: session, config: msg.config, used: Date.now() });
}

function phonemize(text, voice) {
  phonOut = [];
  phonemizer.callMain(['-l', voice, '--input', JSON.stringify([{ text: text }]), '--espeak_data', '/espeak-ng-data']);
  if (!phonOut.length) return [];
  var res = JSON.parse(phonOut[phonOut.length - 1]);
  return res.phonemes || [];
}

function toIdSentences(phonemes, idMap) {
  var PAD = (idMap['_'] || [0])[0];
  var BOS = idMap['^'] || [1];
  var EOS = idMap['$'] || [2];
  var sentences = [], cur = [];
  for (var i = 0; i < phonemes.length; i++) {
    var p = phonemes[i];
    cur.push(p);
    if (p === '.' || p === '?' || p === '!') { sentences.push(cur); cur = []; }
  }
  if (cur.some(function (p) { return p.trim(); })) sentences.push(cur);
  return sentences.map(function (sent) {
    var ids = BOS.concat([PAD]);
    for (var j = 0; j < sent.length; j++) {
      var m = idMap[sent[j]];
      if (!m) continue;
      for (var k = 0; k < m.length; k++) ids.push(m[k]);
      ids.push(PAD);
    }
    return ids.concat(EOS);
  }).filter(function (ids) { return ids.length > 4; });
}

async function synth(msg) {
  var entry = sessions.get(msg.key);
  if (!entry) throw new Error('Stimme nicht geladen: ' + msg.key);
  entry.used = Date.now();
  var cfg = entry.config;
  var rate = (cfg.audio && cfg.audio.sample_rate) || 22050;
  var inf = cfg.inference || {};
  var noise = msg.noiseScale != null ? msg.noiseScale : (inf.noise_scale != null ? inf.noise_scale : 0.667);
  var length = (inf.length_scale != null ? inf.length_scale : 1) * (msg.lengthScale || 1);
  var noiseW = msg.noiseW != null ? msg.noiseW : (inf.noise_w != null ? inf.noise_w : 0.8);
  var voice = (cfg.espeak && cfg.espeak.voice) || 'de';
  var phonemes = phonemize(msg.text, voice);
  var sentences = toIdSentences(phonemes, cfg.phoneme_id_map);
  var multi = (cfg.num_speakers || 1) > 1;
  var silence = Math.round(rate * (msg.sentenceSilence != null ? msg.sentenceSilence : 0.2));
  var parts = [], total = 0;
  for (var i = 0; i < sentences.length; i++) {
    var ids = sentences[i];
    var feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids.map(function (x) { return BigInt(x); })), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor('float32', Float32Array.from([noise, length, noiseW]), [3]),
    };
    if (multi) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(msg.speaker || 0)]), [1]);
    var out = await entry.session.run(feeds);
    var pcm = new Float32Array(out.output.data);
    parts.push(pcm); total += pcm.length;
    if (i < sentences.length - 1) { parts.push(new Float32Array(silence)); total += silence; }
  }
  var merged = new Float32Array(total), o = 0;
  for (var p = 0; p < parts.length; p++) { merged.set(parts[p], o); o += parts[p].length; }
  return { pcm: merged, sampleRate: rate };
}

self.onmessage = async function (e) {
  var msg = e.data;
  try {
    if (msg.type === 'init') { await init(msg); post({ id: msg.id, ok: true }); }
    else if (msg.type === 'load') { await load(msg); post({ id: msg.id, ok: true }); }
    else if (msg.type === 'has') { post({ id: msg.id, ok: sessions.has(msg.key) }); }
    else if (msg.type === 'synth') {
      var r = await synth(msg);
      post({ id: msg.id, ok: true, pcm: r.pcm, sampleRate: r.sampleRate }, [r.pcm.buffer]);
    } else if (msg.type === 'unload') {
      var s = sessions.get(msg.key); if (s) { try { await s.session.release(); } catch (er) { /* */ } sessions.delete(msg.key); }
      post({ id: msg.id, ok: true });
    }
  } catch (err) {
    post({ id: msg.id, error: String((err && err.message) || err) });
  }
};
