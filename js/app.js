// Souffleuse – Haupt-App: Ansichten, Navigation, Bedienung
import { projects, clips, loadSettings, saveSettings, requestPersistence, storageEstimate, uid, kv } from './store.js';
import { parseScript, rawToScript, segmentRaw, characterSummary, normalizeKey, isMine } from './format.js';
import { fileToText } from './importers.js';
import { buildPrompt, structureWithGemini, structurePdfWithGemini } from './ai.js';
import { deviceEngine } from './engines/device.js';
import { piperEngine, setPiperBase } from './engines/piper.js';
import { geminiEngine, GEMINI_TTS_MODELS, geminiRequestsToday } from './engines/gemini.js';
import { voiceOptions, autoAssign, assignment, NARRATOR } from './cast.js';
import { Player, MODES, DEFAULT_PLAY, renderScene, missingClips, unlockAudio, ClipProvider, getAudioEl } from './player.js';
import { DEMO_TITLE, DEMO_SCRIPT } from './demo.js';
import { MASTER_RATE, wavBlob } from './audio.js';
import { esc, icon, toast, sheet, closeSheet, fmtNumber, fmtBytes, fmtDuration, plural, download, safeFileName, copyText } from './ui.js';

const APP_VERSION = '1.0.1';
const $app = document.getElementById('app');
const S = { settings: loadSettings(), project: null, voiceCache: {}, importDraft: null };
setPiperBase(S.settings.piperBaseUrl);

const ENGINE_LABEL = { device: 'Handy-Stimmen', piper: 'Offline-KI', gemini: 'Gemini' };
const ENGINE_SHORT = { device: 'Handy', piper: 'Offline-KI', gemini: 'Gemini' };

// ------------------------------------------------------------------
// Mini-Framework: Ansicht = { render(), actions{}, inputs{}, changes{}, mounted(), destroy() }
// ------------------------------------------------------------------
let view = null;
function mount(v) {
  if (view && view.destroy) { try { view.destroy(); } catch (e) { console.error(e); } }
  closeSheet();
  view = v;
  paint();
  window.scrollTo(0, 0);
}
function paint() {
  if (!view) return;
  $app.innerHTML = view.render();
  if (view.mounted) view.mounted();
}
function dispatch(kind, e) {
  const attrName = { click: 'action', change: 'change', input: 'input' }[kind];
  const el = e.target.closest(`[data-${attrName}]`);
  if (!el || !view) return;
  const map = { click: view.actions, change: view.changes, input: view.inputs }[kind] || {};
  const fn = map[el.dataset[attrName]] || (kind === 'click' && globalActions[el.dataset.action]);
  if (!fn) return;
  if (kind === 'click' && el.tagName !== 'INPUT' && el.tagName !== 'LABEL') e.preventDefault();
  Promise.resolve(fn(el, e)).catch(err => { console.error(err); toast(err.message || String(err), { error: true }); });
}
['click', 'change', 'input'].forEach(k => document.addEventListener(k, (e) => {
  if (e.target.closest('.backdrop') && sheetActions) {
    const attrName = { click: 'action', change: 'change', input: 'input' }[k];
    const el = e.target.closest(`[data-${attrName}]`);
    if (el && sheetActions[k] && sheetActions[k][el.dataset[attrName]]) {
      if (k === 'click' && el.tagName !== 'INPUT' && el.tagName !== 'LABEL') e.preventDefault();
      Promise.resolve(sheetActions[k][el.dataset[attrName]](el, e)).catch(err => { console.error(err); toast(err.message || String(err), { error: true }); });
    }
    return;
  }
  if (e.target.closest('#app')) dispatch(k, e);
}));
let sheetActions = null;
function openSheet(html, handlers = {}, opts = {}) {
  sheetActions = { click: handlers.actions || {}, change: handlers.changes || {}, input: handlers.inputs || {} };
  return sheet(html, { onClose: () => { sheetActions = null; opts.onClose && opts.onClose(); } });
}
const globalActions = {
  back: (el) => history.length > 1 && !el.dataset.href ? history.back() : go(el.dataset.href || '#/'),
  nav: (el) => go(el.dataset.href),
};

function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

function topbar(title, { back = '#/', sub = '', right = '' } = {}) {
  return `<header class="topbar">
    <button class="icon-btn" data-action="nav" data-href="${esc(back)}" aria-label="Zurück">${icon.back}</button>
    <h1>${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}</h1>${right}
  </header>`;
}

// ------------------------------------------------------------------
// Projekte laden/speichern
// ------------------------------------------------------------------
async function loadProject(id) {
  if (S.project && S.project.id === id) return S.project;
  const p = await projects.get(id);
  if (!p) throw new Error('Stück nicht gefunden.');
  if (!p.parsed && p.scriptText) p.parsed = parseScript(p.scriptText);
  p.play = { ...DEFAULT_PLAY, ...(p.play || {}) };
  p.engine = p.engine || S.settings.defaultEngine || 'device';
  p.myRoles = p.myRoles || [];
  S.project = p;
  return p;
}
async function saveProject(p) { await projects.put(p); S.project = p; }

function applyScript(p, text) {
  p.scriptText = text;
  p.parsed = parseScript(text);
  const keys = new Set(p.parsed.characters.map(c => c.key));
  p.myRoles = (p.myRoles || []).filter(k => keys.has(k));
  return p.parsed;
}

function roleNames(p) {
  const chars = p.parsed ? p.parsed.characters : [];
  return (p.myRoles || []).map(k => (chars.find(c => c.key === k) || { name: k }).name);
}

function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  return names.slice(0, -1).join(', ') + ' und ' + names[names.length - 1];
}

// ------------------------------------------------------------------
// Startseite
// ------------------------------------------------------------------
async function showHome() {
  const list = await projects.all();
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  mount({
    render: () => `
      <header class="home-head">
        <button class="icon-btn" data-action="nav" data-href="#/einstellungen" aria-label="Einstellungen">${icon.gear}</button>
        <h1 class="wordmark">Souffleuse</h1>
        <p class="tagline">Deine Szenenpartner lesen vor. Du sprichst deinen Text in die Pausen.</p>
      </header>
      <div class="home-actions">
        <button class="btn" data-action="nav" data-href="#/neu">${icon.plus} Stück hinzufügen</button>
        ${list.some(p => p.demo) ? '' : '<button class="btn secondary" data-action="demo">Demo ausprobieren</button>'}
      </div>
      <div class="page">
        ${list.length ? `<h2>Deine Stücke</h2>
        <ul class="list">${list.map(p => {
          const roles = (p.myRoles || []).map(k => ((p.parsed && p.parsed.characters || []).find(c => c.key === k) || { name: k }).name);
          const nScenes = p.parsed ? p.parsed.scenes.length : 0;
          const sub = p.parsed ? `${roles.length ? 'Du spielst ' + joinNames(roles) + '. ' : 'Noch keine Rolle gewählt. '}${plural(nScenes, 'Szene', 'Szenen')}.` : 'Noch nicht aufbereitet.';
          const href = p.parsed ? `#/s/${p.id}` : `#/s/${p.id}/aufbereiten`;
          return `<li><button class="row" data-action="nav" data-href="${href}"><span class="main"><span class="title">${esc(p.title)}</span><span class="sub">${esc(sub)}</span></span>${icon.chev}</button></li>`;
        }).join('')}</ul>` : `<div class="empty"><p>Noch keine Stücke. Füg dein Skript als PDF, Word-Datei oder Text hinzu – oder probier erst die Demo.</p></div>`}
        <p class="hint">Alles bleibt auf diesem Gerät gespeichert.</p>
        ${standalone ? '' : `<p class="hint"><b>Tipp:</b> Leg die App auf deinen Homescreen. iPhone: in Safari auf „Teilen“ und „Zum Home-Bildschirm“. Android: im Chrome-Menü „App installieren“.</p>`}
        <p class="hint"><button class="btn quiet" data-action="nav" data-href="#/hilfe">${icon.help} So funktioniert’s</button></p>
      </div>`,
    actions: {
      demo: async () => {
        const p = { id: uid(), title: DEMO_TITLE, createdAt: Date.now(), demo: true, myRoles: ['LENA'], engine: S.settings.defaultEngine || 'device', play: { ...DEFAULT_PLAY } };
        applyScript(p, DEMO_SCRIPT);
        await saveProject(p);
        requestPersistence();
        go(`#/s/${p.id}`);
      },
    },
  });
}

// ------------------------------------------------------------------
// Import
// ------------------------------------------------------------------
function showImport() {
  const d = S.importDraft = { title: '', text: '', info: null, pdfBytes: null, busy: false, progress: 0 };
  const v = {
    render: () => `
      ${topbar('Stück hinzufügen', { back: '#/' })}
      <div class="page">
        <label class="field"><span>Titel</span><input type="text" id="title" value="${esc(d.title)}" placeholder="z. B. Der Zauberer von Oz" data-input="title" autocomplete="off"></label>
        <div class="section">
          <label class="dropzone" id="drop">
            ${icon.file.replace('<svg', '<svg width="34" height="34"')}
            <strong>Skript auswählen</strong>
            <span class="meta">PDF, Word (.docx) oder Textdatei</span>
            <input type="file" accept=".pdf,.docx,.txt,.text,.md,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document" data-change="file">
          </label>
          <div id="readstate">${readState()}</div>
        </div>
        <details class="section" ${d.info && d.info.kind === 'paste' ? 'open' : ''}>
          <summary>Oder Text einfügen</summary>
          <textarea id="paste" placeholder="Skripttext hier einfügen …" data-input="paste">${esc(d.info && d.info.kind === 'paste' ? d.text : '')}</textarea>
        </details>
        <div class="btn-row"><button class="btn block" data-action="next" ${canGo() ? '' : 'disabled'} id="next">Weiter</button></div>
      </div>`,
    mounted() {
      const drop = document.getElementById('drop');
      ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
      ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
      drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) readFile(f); });
    },
    inputs: {
      title: (el) => { d.title = el.value; },
      paste: (el) => { d.text = el.value; d.info = { kind: 'paste', chars: el.value.length }; d.pdfBytes = null; updateNext(); },
    },
    changes: { file: (el) => { const f = el.files && el.files[0]; if (f) readFile(f); } },
    actions: {
      next: async () => {
        if (!canGo()) return;
        const title = (document.getElementById('title').value || '').trim() || (d.info && d.info.name ? d.info.name.replace(/\.[^.]+$/, '') : 'Mein Stück');
        const p = { id: uid(), title, createdAt: Date.now(), rawText: d.text, source: d.info, myRoles: [], engine: S.settings.defaultEngine || 'device', play: { ...DEFAULT_PLAY } };
        if (d.pdfBytes && d.info && d.info.scanned) { await kv.set('pdf:' + p.id, d.pdfBytes); p.hasPdf = true; }
        await saveProject(p);
        requestPersistence();
        go(`#/s/${p.id}/aufbereiten`);
      },
    },
  };
  function readState() {
    if (d.busy) return `<p class="hint">Lese Datei … ${Math.round(d.progress * 100)} %</p><div class="progress"><i style="width:${Math.round(d.progress * 100)}%"></i></div>`;
    if (!d.info || d.info.kind === 'paste') return '';
    const i = d.info;
    return `<div class="notice ${i.scanned ? 'warn' : ''}"><b>${esc(i.name)}</b><br>${i.pages ? plural(i.pages, 'Seite', 'Seiten') + ', ' : ''}${fmtNumber(i.chars)} Zeichen gelesen.${i.scanned ? '<br>Die PDF enthält kaum Text – vermutlich eingescannt. Im nächsten Schritt kann Gemini sie direkt lesen.' : ''}</div>`;
  }
  function canGo() { return !!(d.text.trim() || (d.pdfBytes && d.info && d.info.scanned)); }
  function updateNext() { const b = document.getElementById('next'); if (b) b.disabled = !canGo(); }
  async function readFile(f) {
    d.busy = true; d.progress = 0;
    document.getElementById('readstate').innerHTML = readState();
    try {
      const r = await fileToText(f, (p) => { d.progress = p; const rs = document.getElementById('readstate'); if (rs) rs.innerHTML = readState(); });
      d.text = r.text; d.pdfBytes = r.kind === 'pdf' ? r.bytes : null;
      d.info = { kind: r.kind, name: f.name, pages: r.pages, chars: r.text.replace(/\s/g, '').length, scanned: r.scanned };
      const t = document.getElementById('title');
      if (t && !t.value.trim()) { t.value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '); d.title = t.value; }
    } catch (e) {
      toast(e.message || 'Datei konnte nicht gelesen werden.', { error: true });
    } finally {
      d.busy = false;
      const rs = document.getElementById('readstate'); if (rs) rs.innerHTML = readState();
      updateNext();
    }
  }
  mount(v);
}

// ------------------------------------------------------------------
// Aufbereiten (automatisch / Gemini / Chatbot)
// ------------------------------------------------------------------
async function showPrepare(id) {
  const p = await loadProject(id);
  const raw = p.rawText || p.scriptText || '';
  const scannedOnly = !!(p.hasPdf && p.source && p.source.scanned && !raw.replace(/\s/g, '').length);
  const st = p.prep = p.prep || { method: S.settings.geminiKey || scannedOnly ? 'gemini' : 'auto', results: {} };
  if (scannedOnly) st.method = 'gemini';
  let segments = segmentRaw(raw, st.method === 'gemini' ? 28000 : 12000);
  let running = false, stopFlag = false;
  const scanned = !!(p.source && p.source.scanned && p.hasPdf);

  const segList = () => `<ul class="segments">${segments.map((s, i) => {
    const r = st.results[keyOf(s)];
    const status = r ? `<span class="state-done">${icon.check.replace('<svg', '<svg width="18" height="18" style="vertical-align:-3px"')} fertig</span>` : (s._err ? `<span class="state-err">${esc(s._err)}</span>` : `${fmtNumber(s.text.length)} Zeichen`);
    if (st.method === 'chat') {
      return `<li><span class="s-title">${esc(s.title)}</span><span class="s-meta">${status}</span>
        <span class="s-act"><button class="btn secondary" data-action="copyPrompt" data-i="${i}">${icon.copy} Prompt</button></span>
        <textarea placeholder="Antwort des Chatbots hier einfügen …" data-input="answer" data-i="${i}">${esc(r || '')}</textarea></li>`;
    }
    return `<li><span class="s-title">${esc(s.title)}</span><span class="s-meta">${status}</span></li>`;
  }).join('')}</ul>`;

  const panel = () => {
    if (st.method === 'auto') return `
      <p class="hint">Funktioniert gut, wenn im Skript Namen am Zeilenanfang stehen, z. B. <span class="kbd">ANNA: Text</span> oder ein Name allein über dem Text. Gefühle werden nur übernommen, wenn sie in Klammern hinter dem Namen stehen.</p>
      <div class="btn-row"><button class="btn block" data-action="auto">Rollen erkennen</button></div>`;
    if (scannedOnly) return `
      <div class="notice">Diese PDF ist eingescannt und enthält keinen lesbaren Text. Gemini kann sie trotzdem lesen – am besten aktweise, z. B. Seite 1–30.</div>
      ${S.settings.geminiKey ? '' : `<div class="notice">Dafür brauchst du einen kostenlosen Gemini-Schlüssel. <a href="#/einstellungen">In den Einstellungen eintragen</a></div>
        <p class="hint">Ohne Schlüssel: Auf dem iPhone und vielen Android-Handys kannst du Text aus Scans markieren und kopieren (iPhone: „Live Text“, Android: „Google Lens“) und dann als Text einfügen.</p>`}
      ${Object.keys(st.results).length ? segList() : ''}
      <div id="gstate"></div>
      <div class="btn-row">
        <button class="btn block" data-action="pdfGemini" ${S.settings.geminiKey ? '' : 'disabled'}>Seiten mit Gemini lesen</button>
        ${Object.keys(st.results).length ? '<button class="btn secondary block" data-action="combine">Ergebnis prüfen</button>' : ''}
      </div>`;
    if (st.method === 'gemini') return `
      ${S.settings.geminiKey ? '' : `<div class="notice">Dafür brauchst du einen kostenlosen Gemini-Schlüssel. <a href="#/einstellungen">In den Einstellungen eintragen</a></div>`}
      <p class="hint">Gemini liest das Skript abschnittsweise, erkennt Figuren, Szenen, Lieder und den Tonfall jeder Replik. ${segments.length > 1 ? `Dein Skript wird in ${segments.length} Abschnitte geteilt.` : ''}</p>
      ${segList()}
      <div id="gstate"></div>
      <div class="btn-row">
        <button class="btn block" data-action="gemini" ${S.settings.geminiKey ? '' : 'disabled'}>${Object.keys(st.results).length ? 'Fortsetzen' : 'Mit Gemini aufbereiten'}</button>
        ${Object.keys(st.results).length ? '<button class="btn quiet" data-action="resetResults">Ergebnisse verwerfen und neu beginnen</button>' : ''}
        ${scanned ? `<button class="btn secondary block" data-action="pdfGemini" ${S.settings.geminiKey ? '' : 'disabled'}>Eingescannte PDF direkt lesen lassen</button>` : ''}
      </div>`;
    return `
      <ol class="steps">
        <li>Tippe bei einem Abschnitt auf <b>Prompt</b> – er wird kopiert.</li>
        <li>Füge ihn in Claude, ChatGPT oder die Gemini-App ein.</li>
        <li>Kopiere die komplette Antwort und füge sie hier im Feld darunter ein.</li>
      </ol>
      ${segList()}
      <div class="btn-row"><button class="btn block" data-action="combine">Ergebnis prüfen</button>
      ${Object.keys(st.results).length ? '<button class="btn quiet" data-action="resetResults">Antworten verwerfen</button>' : ''}</div>`;
  };

  function keyOf(s) { return s.title + '|' + s.text.length + '|' + s.text.slice(0, 40); }
  function combine() {
    const texts = segments.map(s => st.results[keyOf(s)]).filter(Boolean);
    const defs = new Map(); const body = [];
    for (const t of texts) {
      for (const line of t.split('\n')) {
        const m = line.match(/^\s*@\s*([^:]+)(?::(.*))?$/);
        if (m) { const k = normalizeKey(m[1]); if (!defs.has(k) || (!defs.get(k).includes(':') && m[2])) defs.set(k, line.trim()); }
        else body.push(line);
      }
      body.push('');
    }
    return [...defs.values()].join('\n') + '\n\n' + body.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }
  async function finish(text) {
    applyScript(p, text);
    await saveProject(p);
    go(`#/s/${p.id}/text`);
  }

  mount({
    render: () => `
      ${topbar('Skript aufbereiten', { back: p.parsed ? `#/s/${p.id}` : '#/', sub: p.title })}
      <div class="page">
        <p class="lede">Die App muss wissen, wer wann was sagt. Wähle, wie das Skript aufbereitet wird – danach kannst du alles prüfen und korrigieren.</p>
        <div class="choices" role="radiogroup" ${scannedOnly ? 'hidden' : ''}>
          ${[['auto', 'Automatisch erkennen', 'Sofort und ohne KI. Gut bei klar formatierten Skripten.'],
             ['gemini', 'Mit Gemini', 'Erkennt Rollen, Szenen, Lieder und Gefühle. Braucht einen kostenlosen Schlüssel.'],
             ['chat', 'Mit einem Chatbot', 'Ohne Schlüssel: Prompt kopieren, in Claude oder ChatGPT einfügen, Antwort zurückkopieren.']]
             .map(([k, t, dsc]) => `<label class="choice"><input type="radio" name="m" value="${k}" ${st.method === k ? 'checked' : ''} data-change="method"><span class="t">${t}</span><span class="d">${dsc}</span></label>`).join('')}
        </div>
        <div class="section" id="panel">${panel()}</div>
      </div>`,
    changes: {
      method: async (el) => {
        st.method = el.value;
        segments = segmentRaw(raw, st.method === 'gemini' ? 28000 : 12000);
        await saveProject(p);
        document.getElementById('panel').innerHTML = panel();
      },
    },
    inputs: {
      answer: async (el) => {
        const s = segments[Number(el.dataset.i)];
        const v = el.value.trim();
        if (v) st.results[keyOf(s)] = v.replace(/^```[a-z]*\n?|```$/g, '').trim(); else delete st.results[keyOf(s)];
        clearTimeout(el._t); el._t = setTimeout(() => saveProject(p), 600);
      },
    },
    actions: {
      auto: async () => {
        const r = rawToScript(raw);
        if (!r.parsed.stats.speeches) {
          toast('Ich habe keine Repliken gefunden. Probier Gemini oder den Chatbot-Weg.', { error: true, ms: 6000 });
        }
        await finish(r.text);
      },
      copyPrompt: async (el) => {
        const i = Number(el.dataset.i);
        const known = Object.keys(st.results).length ? characterSummary(parseScript(combine())) : '';
        const ok = await copyText(buildPrompt({ text: segments[i].text, knownCharacters: known, part: segments[i].title }));
        toast(ok ? 'Prompt kopiert. Jetzt im Chatbot einfügen.' : 'Kopieren hat nicht geklappt.', { error: !ok });
      },
      resetResults: async () => {
        if (!confirm('Bisherige Ergebnisse verwerfen?')) return;
        st.results = {}; segments.forEach(x => { x._err = null; }); await saveProject(p);
        document.getElementById('panel').innerHTML = panel();
      },
      combine: async () => {
        if (!Object.keys(st.results).length) return toast('Füge zuerst mindestens eine Antwort ein.', { error: true });
        await finish(combine());
      },
      gemini: async (btn) => {
        if (running) { stopFlag = true; return; }
        running = true; stopFlag = false; btn.textContent = 'Anhalten';
        const gs = document.getElementById('gstate');
        try {
          for (let i = 0; i < segments.length; i++) {
            const s = segments[i];
            if (st.results[keyOf(s)]) continue;
            if (stopFlag) break;
            gs.innerHTML = `<p class="hint">Gemini liest „${esc(s.title)}“ … (${i + 1} von ${segments.length})</p><div class="progress"><i style="width:${Math.round(i / segments.length * 100)}%"></i></div>`;
            const known = Object.keys(st.results).length ? characterSummary(parseScript(combine())) : '';
            try {
              const r = await structureWithGemini({ apiKey: S.settings.geminiKey, model: S.settings.geminiTextModel, text: s.text, knownCharacters: known, part: s.title,
                onWait: (secs) => { gs.innerHTML = `<p class="hint">Gemini-Minutenlimit erreicht – es geht in ${Math.round(secs)} s automatisch weiter …</p>`; } });
              st.results[keyOf(s)] = r.text; s._err = null;
              if (r.truncated) toast(`„${s.title}“ wurde evtl. nicht vollständig verarbeitet – bitte am Ende prüfen.`, { ms: 6000 });
              await saveProject(p);
            } catch (e) {
              s._err = e.code === 'quota' ? 'Kontingent erreicht' : 'Fehler';
              document.getElementById('panel').innerHTML = panel();
              throw e;
            }
            document.getElementById('panel').innerHTML = panel();
          }
          if (!stopFlag && segments.every(s => st.results[keyOf(s)])) await finish(combine());
        } finally {
          running = false;
          const b = document.querySelector('[data-action="gemini"]'); if (b) b.textContent = 'Fortsetzen';
        }
      },
      pdfGemini: async () => {
        const pdf = await kv.get('pdf:' + p.id);
        if (!pdf) return toast('Die PDF ist nicht mehr gespeichert. Bitte das Stück neu hinzufügen.', { error: true });
        const pages = p.source && p.source.pages || 0;
        const range = prompt(`Welche Seiten soll Gemini lesen? (z. B. 1-30)${pages ? ` – die PDF hat ${pages} Seiten.` : ''}\nBei langen Skripten am besten aktweise.`, pages && pages <= 40 ? `1-${pages}` : '1-30');
        if (!range) return;
        const gs = document.getElementById('gstate');
        gs.innerHTML = `<p class="hint">Gemini liest die Seiten ${esc(range)} … das kann eine Minute dauern.</p><div class="progress"><i style="width:35%"></i></div>`;
        const known = Object.keys(st.results).length ? characterSummary(parseScript(combine())) : '';
        const r = await structurePdfWithGemini({ apiKey: S.settings.geminiKey, model: S.settings.geminiTextModel, pdfBytes: pdf, pageHint: 'Seiten ' + range, knownCharacters: known });
        const seg = { title: 'PDF Seiten ' + range, text: 'pdf:' + range };
        segments.push(seg);
        st.results[keyOf(seg)] = r.text;
        await saveProject(p);
        gs.innerHTML = '';
        if (confirm('Fertig. Noch weitere Seiten lesen lassen? (Abbrechen = Ergebnis prüfen)')) { document.getElementById('panel').innerHTML = panel(); return; }
        await finish(combine());
      },
    },
  });
}

// ------------------------------------------------------------------
// Stück: Szenen / Rollen & Stimmen / Skript
// ------------------------------------------------------------------
async function showProject(id, tab) {
  const p = await loadProject(id);
  if (!p.parsed) return go(`#/s/${id}/aufbereiten`);
  const engine = () => p.engine || 'device';

  const tabs = () => `<div class="tabs"><div class="seg" role="tablist">
    ${[['szenen', 'Szenen'], ['rollen', 'Rollen'], ['text', 'Skript']].map(([k, l]) =>
      `<button role="tab" aria-pressed="${tab === k}" data-action="nav" data-href="#/s/${p.id}${k === 'szenen' ? '' : '/' + k}">${l}</button>`).join('')}
  </div></div>`;

  const right = `<button class="icon-btn" data-action="menu" aria-label="Mehr">${icon.more}</button>`;
  const subFn = () => { const roles = roleNames(p); return roles.length ? `Du spielst ${joinNames(roles)}` : 'Noch keine Rolle gewählt'; };

  let bodyFn = () => '';
  const actions = {
    menu: () => projectMenu(p),
  };
  const changes = {}; const inputs = {};
  let mounted = null;

  if (tab === 'szenen') bodyFn = () => {
    const my = p.myRoles;
    const groups = [];
    for (const sc of p.parsed.scenes) {
      const last = groups[groups.length - 1];
      if (!last || last.act !== (sc.actTitle || '')) groups.push({ act: sc.actTitle || '', scenes: [sc] });
      else last.scenes.push(sc);
    }
    const sceneRow = (sc) => {
      const speeches = sc.lines.filter(l => l.kind === 'speech');
      const mine = speeches.filter(l => isMine(l, my, p.play.includeEnsemble));
      const n = sc.lines.length || 1;
      const ticks = sc.lines.map((l, i) => isMine(l, my, p.play.includeEnsemble) ? `<i style="left:${(i / n * 100).toFixed(2)}%;width:${Math.max(0.8, 100 / n).toFixed(2)}%"></i>` : '').join('');
      return `<li><button class="row" data-action="nav" data-href="#/s/${p.id}/szene/${sc.id}">
        <span class="main"><span class="title">${esc(sc.title)}</span>
        <span class="sub">${plural(speeches.length, 'Replik', 'Repliken')}${my.length ? `, ${mine.length ? fmtNumber(mine.length) + ' davon deine' : 'du hast hier nichts zu sagen'}` : ''}</span>
        ${my.length && mine.length ? `<span class="scene-map" aria-hidden="true">${ticks}</span>` : ''}</span>${icon.chev}</button></li>`;
    };
    const rows = groups.map(g => `${g.act ? `<h3 class="act-title">${esc(g.act)}</h3>` : ''}<ul class="list">${g.scenes.map(sceneRow).join('')}</ul>`).join('');
    return `<div class="page">
      ${my.length ? '' : `<div class="notice">Wähle zuerst deine Rolle, damit die App weiß, wo sie Pausen für dich lassen soll. <a href="#/s/${p.id}/rollen">Rolle wählen</a></div>`}
      <p class="meta" style="margin:${my.length ? 0 : 14}px 0 12px">Stimmen: ${ENGINE_LABEL[engine()]}. <a href="#/s/${p.id}/rollen">Ändern</a></p>
      ${rows}
      ${p.parsed.scenes.length ? '' : '<div class="empty"><p>Keine Szenen gefunden. Prüfe das Skript.</p></div>'}
    </div>`;
  };

  if (tab === 'rollen') {
    const getChars = () => p.parsed.characters.slice().sort((a, b) => (b.count || 0) - (a.count || 0));
    let opts = S.voiceCache[engine()] || [];
    bodyFn = () => { const chars = getChars(); const eng = engine(); return `<div class="page">
      <section class="section">
        <h2>Welche Rolle spielst du?</h2>
        <p class="lede">Deine Zeilen werden markiert – beim Proben bleiben sie stumm.</p>
        <div class="list" style="border-top:1px solid var(--rule)">
          ${chars.map(c => `<div class="role"><span class="name">${p.myRoles.includes(c.key) ? `<span class="marked">${esc(c.name)}</span>` : esc(c.name)}</span>
            <span class="desc">${esc([c.description, plural(c.count || 0, 'Replik', 'Repliken')].filter(Boolean).join(' – '))}</span>
            <button class="pill pick" aria-pressed="${p.myRoles.includes(c.key)}" data-action="toggleRole" data-key="${esc(c.key)}">${p.myRoles.includes(c.key) ? 'Meine Rolle' : 'Das bin ich'}</button></div>`).join('')}
        </div>
        <label class="switch"><span class="label">Ensemble-Zeilen gehören auch mir<small>Zeilen von ALLE, CHOR oder ENSEMBLE</small></span><input type="checkbox" ${p.play.includeEnsemble ? 'checked' : ''} data-change="ensemble"></label>
      </section>
      <section class="section">
        <h2>Stimmen</h2>
        <div class="seg" role="radiogroup" aria-label="Stimmen-Quelle">
          ${['device', 'piper', 'gemini'].map(k => `<button aria-pressed="${eng === k}" data-action="engine" data-engine="${k}">${ENGINE_SHORT[k]}</button>`).join('')}
        </div>
        <p class="hint" id="engineHint">${engineHint(eng)}</p>
        <div id="voices"><p class="hint">Stimmen werden geladen …</p></div>
        <div class="btn-row"><button class="btn quiet" data-action="reassign">Stimmen neu verteilen</button></div>
      </section>
    </div>`; };
    actions.toggleRole = async (el) => {
      const k = el.dataset.key;
      p.myRoles = p.myRoles.includes(k) ? p.myRoles.filter(x => x !== k) : [...p.myRoles, k];
      await saveProject(p); paint();
    };
    actions.engine = async (el) => {
      p.engine = el.dataset.engine; await saveProject(p);
      S.settings.defaultEngine = p.engine; saveSettings(S.settings);
      paint();
    };
    actions.reassign = async () => { autoAssign(p, engine(), opts, { force: true }); await saveProject(p); renderVoices(); toast('Stimmen neu verteilt.'); };
    actions.test = async (el) => {
      unlockAudio();
      const key = el.dataset.key;
      await previewVoice(p, engine(), key, el);
    };
    actions.loadPiper = async (el) => {
      const keys = neededPiperKeys(p);
      const label = el.textContent;
      el.disabled = true;
      requestPersistence();
      try {
        for (let i = 0; i < keys.length; i++) {
          if (await piperEngine.isDownloaded(keys[i])) continue;
          await piperEngine.download(keys[i], (f) => { el.textContent = `Lade Stimme ${i + 1} von ${keys.length}: ${Math.round(f * 100)} %`; });
        }
        el.textContent = 'Alle Stimmen sind offline verfügbar';
      } catch (e) {
        el.disabled = false; el.textContent = label;
        throw e;
      } finally {
        renderVoices();
      }
    };
    changes.ensemble = async (el) => { p.play.includeEnsemble = el.checked; await saveProject(p); };
    changes.voice = async (el) => {
      const key = el.dataset.key; const e = engine();
      p.cast = p.cast || {}; p.cast[key] = p.cast[key] || {};
      p.cast[key][e] = { ...(p.cast[key][e] || {}), voiceId: el.value };
      await saveProject(p);
      if (e === 'piper') renderVoices();
    };
    changes.pitch = async (el) => {
      const key = el.dataset.key;
      p.cast[key] = p.cast[key] || {}; p.cast[key].device = { ...(p.cast[key].device || {}), pitch: Number(el.value) };
      await saveProject(p);
    };
    async function renderVoices() {
      const box = document.getElementById('voices'); if (!box) return;
      const eng2 = engine();
      try {
        opts = S.voiceCache[eng2] = await voiceOptions(eng2);
      } catch (e) { box.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }
      if (eng2 === 'device' && !opts.length) {
        box.innerHTML = `<div class="notice warn">Dieser Browser bietet keine Vorlesestimmen an. Wähle „Offline-KI“ oder „Gemini“.</div>`; return;
      }
      autoAssign(p, eng2, opts);
      await saveProject(p);
      const downloaded = eng2 === 'piper' ? new Set(await piperEngine.downloadedKeys()) : null;
      const list = [...getChars().map(c => ({ key: c.key, name: c.name, mine: p.myRoles.includes(c.key) })), { key: NARRATOR, name: 'Erzähler:in', note: 'liest Regieanweisungen, falls eingeschaltet' }];
      const optHtml = (sel) => {
        if (eng2 === 'piper') {
          return opts.map(o => `<option value="${esc(o.id)}" ${o.id === sel ? 'selected' : ''}>${esc(o.label)}${downloaded.has(o.key) ? '' : ` (${o.size} MB laden)`}</option>`).join('');
        }
        return opts.map(o => `<option value="${esc(o.id)}" ${o.id === sel ? 'selected' : ''}>${esc(o.label)}${o.gender === 'f' ? ' ♀' : o.gender === 'm' ? ' ♂' : ''}</option>`).join('');
      };
      const missing = eng2 === 'piper' ? neededPiperKeys(p).filter(k => !downloaded.has(k)) : [];
      const missingMb = missing.reduce((n, k) => n + ((piperEngine.catalog().find(v => v.key === k) || {}).size || 0), 0);
      box.innerHTML = list.map(r => {
        const a = assignment(p, eng2, r.key);
        return `<div class="voice"><div class="who"><span>${r.mine ? `<span class="marked">${esc(r.name)}</span>` : esc(r.name)}</span><small>${esc(r.note || (r.mine ? 'deine Rolle' : ''))}</small></div>
          <div class="ctl"><select data-change="voice" data-key="${esc(r.key)}" aria-label="Stimme für ${esc(r.name)}">${optHtml(a.voiceId)}</select>
          ${eng2 === 'device' ? `<select class="pitch" data-change="pitch" data-key="${esc(r.key)}" aria-label="Tonhöhe">${[[0.8, 'tiefer'], [0.9, 'etwas tiefer'], [1, 'normal'], [1.12, 'etwas höher'], [1.25, 'höher']].map(([v, l]) => `<option value="${v}" ${Math.abs((a.pitch || 1) - v) < 0.05 ? 'selected' : ''}>${l}</option>`).join('')}${[0.8, 0.9, 1, 1.12, 1.25].some(v => Math.abs((a.pitch || 1) - v) < 0.05) ? '' : `<option value="${a.pitch}" selected>eigene</option>`}</select>` : ''}
          <button class="icon-btn" data-action="test" data-key="${esc(r.key)}" aria-label="Probehören">${icon.speaker}</button></div></div>`;
      }).join('') + (eng2 === 'piper' && missing.length ? `<div class="btn-row"><button class="btn secondary block" data-action="loadPiper">Stimmen für offline laden (${missingMb} MB)</button></div>` : '');
    }
    mounted = () => renderVoices();
  }

  if (tab === 'text') {
    const parsedInfo = () => {
      const s = p.parsed.stats;
      return `${plural(s.speeches, 'Replik', 'Repliken')} von ${plural(p.parsed.characters.length, 'Figur', 'Figuren')} in ${plural(s.scenes, 'Szene', 'Szenen')}${s.songs ? `, ${fmtNumber(s.songs)} gesungen` : ''}.`;
    };
    bodyFn = () => `<div class="page">
      <p class="lede">So liest die App dein Skript. Korrigiere Namen, Zeilen oder Gefühle direkt hier.</p>
      <textarea class="script-edit" id="scriptText" spellcheck="false" data-input="script">${esc(p.scriptText || '')}</textarea>
      <p class="hint" id="parseInfo">${parsedInfo()}</p>
      ${p.parsed.warnings.length ? `<div class="notice warn">${p.parsed.warnings.map(esc).join('<br>')}</div>` : ''}
      <div class="btn-row"><button class="btn block" data-action="saveScript">Übernehmen</button></div>
      <details class="section"><summary>So ist das Format aufgebaut</summary>
<pre class="format-ref">@ ANNA: weiblich, Mitte 20, verträumt
# 1. Akt
## Szene 1: Am Bahnhof
(Anna sitzt am Fenster.)
ANNA [traurig | sad, quiet]: Du gehst also?
MAX: Ja. (zögert) Vielleicht.
♪ ANNA [sehnsüchtig]: Eine gesungene Zeile
ANNA &amp; MAX: Gemeinsam gesprochen</pre>
        <p class="hint">In eckigen Klammern steht der Tonfall: erst Deutsch, nach dem Strich optional eine englische Regieanweisung für Gemini. Runde Klammern sind Regieanweisungen – sie werden nicht vorgelesen. Ein <span class="kbd">♪</span> am Anfang markiert Gesang.</p>
      </details>
      ${p.rawText ? `<div class="btn-row"><button class="btn quiet" data-action="nav" data-href="#/s/${p.id}/aufbereiten">Skript neu aufbereiten</button></div>` : ''}
    </div>`;
    inputs.script = (el) => {
      clearTimeout(el._t);
      el._t = setTimeout(() => {
        const parsed = parseScript(el.value);
        const s = parsed.stats;
        document.getElementById('parseInfo').textContent = `${plural(s.speeches, 'Replik', 'Repliken')} von ${plural(parsed.characters.length, 'Figur', 'Figuren')} in ${plural(s.scenes, 'Szene', 'Szenen')}${s.songs ? `, ${fmtNumber(s.songs)} gesungen` : ''}. Noch nicht übernommen.`;
      }, 400);
    };
    actions.saveScript = async () => {
      const text = document.getElementById('scriptText').value;
      applyScript(p, text);
      await saveProject(p);
      toast('Skript übernommen.');
      go(p.myRoles.length ? `#/s/${p.id}` : `#/s/${p.id}/rollen`);
    };
  }

  mount({
    render: () => `${topbar(p.title, { back: '#/', sub: subFn(), right })}${tabs()}${bodyFn()}`,
    actions, changes, inputs, mounted,
  });
}

const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
function engineHint(eng) {
  if (eng === 'device') return 'Sofort, kostenlos und unbegrenzt. Wie natürlich es klingt, hängt vom Handy ab. Gefühle werden über Tempo und Tonhöhe angedeutet.' + (IS_IOS ? ' Auf dem iPhone stehen im Browser nur einfache Stimmen zur Verfügung – „Offline-KI“ oder „Gemini“ klingen deutlich natürlicher.' : '');
  if (eng === 'piper') return 'Neuronale Stimmen, die direkt auf dem Handy laufen – nach dem einmaligen Download auch offline. Thorsten emotional wechselt je Zeile das Gefühl.';
  return S.settings.geminiKey
    ? `Am natürlichsten und mit echtem Schauspiel. Jede neue Zeile kostet eine Anfrage aus deinem kostenlosen Kontingent; einmal erzeugt, bleibt sie gespeichert. Tipp: Lass eine Szene einmal als MP3 erstellen – danach sind alle Zeilen da und die Probe läuft ohne Wartezeiten. Heute: ${fmtNumber(geminiRequestsToday())} Anfragen.`
    : 'Am natürlichsten und mit echtem Schauspiel. Dafür brauchst du einen kostenlosen Gemini-Schlüssel – <a href="#/einstellungen">jetzt eintragen</a>.';
}

function neededPiperKeys(p) {
  const keys = new Set();
  for (const k of [...(p.parsed.characters || []).map(c => c.key), NARRATOR]) {
    const a = assignment(p, 'piper', k);
    if (a && a.voiceId) keys.add(String(a.voiceId).split('#')[0]);
  }
  return [...keys];
}

async function previewVoice(p, eng, key, btn) {
  const line = (() => {
    for (const sc of p.parsed.scenes) for (const l of sc.lines) if (l.kind === 'speech' && l.speakers.includes(key) && l.spoken.length > 12) return l;
    return null;
  })();
  const char = p.parsed.characters.find(c => c.key === key);
  const sample = line || { kind: 'speech', spoken: key === NARRATOR ? 'Regen. Lena sitzt auf ihrem Koffer.' : `Hallo, ich bin ${char ? char.name : 'eine Stimme'}.`, emotion: '', delivery: '', speakers: [key] };
  const a = assignment(p, eng, key);
  if (eng === 'device') {
    deviceEngine.cancel();
    await deviceEngine.speak({ text: sample.spoken, voiceId: a.voiceId, pitch: a.pitch || 1, rate: 1 });
    return;
  }
  if (eng === 'gemini' && !S.settings.geminiKey) { toast('Bitte zuerst einen Gemini-Schlüssel in den Einstellungen eintragen.', { error: true }); return; }
  const old = btn.innerHTML; btn.disabled = true;
  try {
    const provider = new ClipProvider(p, eng, S.settings);
    const step = { type: 'say', lines: [sample], speaker: key, narrator: key === NARRATOR };
    const clip = await provider.get(step, (f) => toast(`Stimme wird geladen: ${Math.round(f * 100)} %`, { ms: 1500 }));
    const a2 = getAudioEl();
    a2.onended = null; a2.ontimeupdate = null;
    a2.src = URL.createObjectURL(wavBlob(clip.pcm, MASTER_RATE));
    a2.playbackRate = 1;
    await a2.play();
  } catch (e) {
    toast(e.message, { error: true, ms: 6000 });
  } finally { btn.disabled = false; btn.innerHTML = old; }
}

function projectMenu(p) {
  const { close } = openSheet(`
    <h2>${esc(p.title)}</h2>
    <div class="list" style="margin-top:12px">
      <button class="row" data-action="rename"><span class="main"><span class="title">Umbenennen</span></span></button>
      ${p.rawText ? `<button class="row" data-action="prep"><span class="main"><span class="title">Neu aufbereiten</span><span class="sub">Rollen und Szenen nochmal erkennen lassen</span></span></button>` : ''}
      <button class="row" data-action="export"><span class="main"><span class="title">Als Datei sichern</span><span class="sub">Zum Übertragen auf ein anderes Gerät</span></span></button>
      <button class="row" data-action="del"><span class="main"><span class="title" style="color:var(--alert)">Stück löschen</span></span></button>
    </div>`, {
    actions: {
      rename: async () => {
        const t = prompt('Neuer Titel', p.title);
        if (t && t.trim()) { p.title = t.trim(); await saveProject(p); close(); paint(); }
      },
      prep: () => { close(); go(`#/s/${p.id}/aufbereiten`); },
      export: () => {
        const data = { app: 'souffleuse', version: 1, projects: [stripProject(p)] };
        download(new Blob([JSON.stringify(data)], { type: 'application/json' }), safeFileName(p.title) + '.souffleuse.json');
        close();
      },
      del: async () => {
        if (!confirm(`„${p.title}“ wirklich löschen?`)) return;
        await projects.remove(p.id); try { await kv.set('pdf:' + p.id, null); } catch (e) { /* */ }
        S.project = null; close(); go('#/');
      },
    },
  });
}

function stripProject(p) {
  const { parsed, ...rest } = p;
  return rest;
}

// ------------------------------------------------------------------
// Probe (Player)
// ------------------------------------------------------------------
async function showPlayer(id, sid) {
  const p = await loadProject(id);
  if (!p.parsed) return go(`#/s/${id}/aufbereiten`);
  const scene = p.parsed.scenes.find(s => s.id === sid);
  if (!scene) return go(`#/s/${id}`);
  const sceneIdx = p.parsed.scenes.indexOf(scene);
  let player = null;
  let wakeLock = null;
  let revealed = new Set();
  let lastLineEl = null;
  let countdown = null;

  async function prepareCast() {
    const eng = p.engine;
    if (!p.cast || p.parsed.characters.some(c => !(p.cast[c.key] && p.cast[c.key][eng]))) {
      const opts = S.voiceCache[eng] || (S.voiceCache[eng] = await voiceOptions(eng).catch(() => []));
      autoAssign(p, eng, opts);
      await saveProject(p);
    }
  }
  function makePlayer() {
    if (player) player.stop();
    player = new Player({
      project: p, scene, settings: S.settings, play: p.play, engineId: p.engine,
      on: {
        line: (ln, kind) => markLine(ln, kind),
        state: (s, extra) => setState(s, extra),
        reveal: (ln) => { revealed.add(ln.id); const el = lineEl(ln.id); if (el) el.classList.remove('covered'); },
        done: () => { releaseWake(); },
        error: (e) => { toast(e.message || String(e), { error: true, ms: 7000 }); releaseWake(); },
        download: (f) => setStatus(`Stimme wird geladen: <b>${Math.round(f * 100)} %</b>`),
        blocked: () => toast('Tippe auf ▶, um die Wiedergabe zu starten.'),
      },
    });
  }

  const lineHtml = (ln) => {
    const cls = ['ln'];
    const mine = isMine(ln, p.myRoles, p.play.includeEnsemble);
    if (ln.kind === 'direction') cls.push('dir');
    if (mine) cls.push('mine');
    if (mine && p.play.hideMine && !revealed.has(ln.id)) cls.push('covered');
    if (ln.song) cls.push('song');
    if (ln.song && p.play.songs === 'skip') cls.push('skipped');
    const text = esc(ln.text).replace(/\(([^()]{1,200})\)/g, '<span class="note">($1)</span>');
    if (ln.kind === 'direction') return `<p class="${cls.join(' ')}" data-line="${ln.id}" data-action="line">${text}</p>`;
    const names = ln.speakers.map(k => (p.parsed.characters.find(c => c.key === k) || { name: k }).name);
    return `<p class="${cls.join(' ')}" data-line="${ln.id}" data-action="line"><span class="who">${esc(joinNames(names))}${ln.emotion ? `<span class="how">${esc(ln.emotion)}</span>` : ''}</span><span class="say">${text}</span></p>`;
  };
  const lineEl = (lineId) => document.querySelector(`.ln[data-line="${lineId}"]`);

  function markLine(ln, kind) {
    const el = lineEl(ln.id);
    if (!el || el === lastLineEl && kind !== 'mine') return;
    if (lastLineEl) lastLineEl.classList.remove('current');
    el.classList.add('current');
    lastLineEl = el;
    if (kind === 'mine') { el.classList.remove('turn'); void el.offsetWidth; el.classList.add('turn'); setTimeout(() => el.classList.remove('turn'), 700); }
    const r = el.getBoundingClientRect();
    const deckH = (document.querySelector('.deck') || { offsetHeight: 150 }).offsetHeight;
    if (r.top < 80 || r.bottom > window.innerHeight - deckH - 20) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function setStatus(html) { const s = document.getElementById('status'); if (s) s.innerHTML = html; }
  function setPlayButton(kind) {
    const b = document.getElementById('playBtn'); if (!b) return;
    b.classList.toggle('go', kind === 'go');
    b.innerHTML = kind === 'pause' ? icon.pause : kind === 'replay' ? icon.replay : kind === 'go' ? 'Weiter' : icon.play;
    b.setAttribute('aria-label', kind === 'pause' ? 'Pause' : kind === 'go' ? 'Weiter' : kind === 'replay' ? 'Nochmal' : 'Abspielen');
    b.dataset.action = kind === 'pause' ? 'pause' : kind === 'go' ? 'go' : 'play';
  }
  function setState(s, extra) {
    const script = document.querySelector('.script');
    clearInterval(countdown);
    if (script) script.classList.toggle('running', s === 'playing' || s === 'mine' || s === 'waiting' || s === 'loading');
    if (s === 'playing') { setPlayButton('pause'); setStatus(statusIdle(true)); }
    if (s === 'loading') { setPlayButton('pause'); setStatus(p.engine === 'gemini' ? 'Gemini spricht die Zeile ein …' : 'Stimme wird erzeugt …'); }
    if (s === 'mine') {
      setPlayButton('pause');
      const t0 = Date.now(); const total = extra.seconds * 1000;
      setStatus(`<b>Du bist dran</b><span class="bar"><i id="cdBar" style="width:0%"></i></span><button class="btn quiet" data-action="skipPause" style="min-height:32px">Weiter</button>`);
      const bar = document.getElementById('cdBar');
      countdown = setInterval(() => { if (bar) bar.style.width = (Math.min(1, (Date.now() - t0) / total) * 100).toFixed(1) + '%'; }, 100);
    }
    if (s === 'waiting') { setPlayButton('go'); setStatus('<b>Du bist dran.</b> Sprich deinen Text und tippe dann auf „Weiter“.'); }
    if (s === 'paused' || s === 'idle') { setPlayButton('play'); setStatus(statusIdle(false)); releaseWake(); }
    if (s === 'done') { setPlayButton('replay'); setStatus('Szene zu Ende. ' + (sceneIdx < p.parsed.scenes.length - 1 ? `<a href="#/s/${p.id}/szene/${p.parsed.scenes[sceneIdx + 1].id}">Nächste Szene</a>` : '')); }
    if (s === 'error') { setPlayButton('play'); }
    updateMediaSession(s);
  }
  function statusIdle(running) {
    const m = MODES[p.play.mode];
    if (!p.myRoles.length) return 'Keine eigene Rolle gewählt – alles wird vorgelesen.';
    return running ? `${esc(m.label)}${p.play.cuesOnly ? ', nur Stichworte' : ''}` : `${esc(m.hint)}`;
  }

  async function requestWake() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { /* egal */ }
  }
  function releaseWake() { try { wakeLock && wakeLock.release(); } catch (e) { /* */ } wakeLock = null; }

  function updateMediaSession(s) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: scene.title, artist: p.title, album: 'Souffleuse' });
      navigator.mediaSession.playbackState = (s === 'playing' || s === 'mine' || s === 'loading') ? 'playing' : 'paused';
      navigator.mediaSession.setActionHandler('play', () => startFrom());
      navigator.mediaSession.setActionHandler('pause', () => player && player.pause());
      navigator.mediaSession.setActionHandler('nexttrack', () => player && player.next());
      navigator.mediaSession.setActionHandler('previoustrack', () => player && player.prev());
    } catch (e) { /* */ }
  }

  function startFrom(index) {
    unlockAudio();
    requestWake();
    if (player.state === 'done' && index == null) index = 0;
    player.start(index == null ? player.i : index);
  }

  const modeLabel = () => MODES[p.play.mode].label + (p.play.cuesOnly ? ', nur Stichworte' : '');
  const speedLabel = () => `${String(p.play.speed).replace('.', ',')}×`;

  await prepareCast();
  makePlayer();
  geminiEngine.onWait = (secs) => { if (view && document.getElementById('status')) setStatus(`Gemini-Minutenlimit erreicht – es geht in ${Math.round(secs)} s automatisch weiter …`); };

  mount({
    render: () => `
      ${topbar(scene.title, { back: `#/s/${p.id}`, sub: scene.actTitle || p.title, right: `<button class="icon-btn" data-action="settingsSheet" aria-label="Lernmodus einstellen">${icon.sliders}</button>` })}
      <article class="script" aria-live="off">
        ${scene.lines.map(lineHtml).join('')}
        <p class="script-end">Ende der Szene</p>
      </article>
      <div class="deck"><div class="deck-inner">
        <div class="status" id="status" aria-live="polite">${statusIdle(false)}</div>
        <div class="chips">
          <button class="chip" data-action="settingsSheet" id="modeChip">${esc(modeLabel())}</button>
          <button class="chip" data-action="speed" id="speedChip" aria-label="Tempo">${speedLabel()}</button>
          <button class="chip" data-action="exportSheet" aria-label="Szene als Audiodatei">MP3</button>
        </div>
        <div class="transport">
          <button class="icon-btn" data-action="prev" aria-label="Vorherige Zeile">${icon.prev}</button>
          <button class="play" id="playBtn" data-action="play" aria-label="Abspielen">${icon.play}</button>
          <button class="icon-btn" data-action="next" aria-label="Nächste Zeile">${icon.next}</button>
        </div>
      </div></div>`,
    mounted() {
      document.documentElement.style.setProperty('--deck-h', (document.querySelector('.deck').offsetHeight) + 'px');
      updateMediaSession('idle');
    },
    destroy() { if (player) player.stop(); releaseWake(); clearInterval(countdown); },
    actions: {
      play: () => startFrom(),
      pause: () => player.pause(),
      go: () => { player.tap(); },
      next: () => { unlockAudio(); if (player.state === 'waiting') return player.tap(); player.next(); },
      prev: () => { unlockAudio(); player.prev(); },
      skipPause: () => player.skipPause(),
      line: (el) => {
        const id = el.dataset.line;
        if (el.classList.contains('covered')) { el.classList.remove('covered'); revealed.add(id); return; }
        const idx = player.stepIndexForLine(id);
        startFrom(idx);
      },
      speed: () => {
        const steps = [0.8, 0.9, 1, 1.1, 1.25];
        const i = steps.findIndex(x => Math.abs(x - p.play.speed) < 0.01);
        p.play.speed = steps[(i + 1) % steps.length];
        saveProject(p);
        document.getElementById('speedChip').textContent = speedLabel();
        const running = player.state === 'playing';
        player.play.speed = p.play.speed;
        try { getAudioEl().playbackRate = p.play.speed; } catch (e) { /* */ }
        if (running && p.engine === 'device') player.start(player.i);
      },
      settingsSheet: () => playSettingsSheet(),
      exportSheet: () => exportSheet(),
    },
  });

  function rebuild() {
    const wasAt = player ? player.i : 0;
    const lineId = player && player.plan[wasAt] && player.plan[wasAt].lines[0] && player.plan[wasAt].lines[0].id;
    makePlayer();
    document.querySelector('.script').innerHTML = scene.lines.map(lineHtml).join('') + '<p class="script-end">Ende der Szene</p>';
    lastLineEl = null;
    if (lineId) player.i = player.stepIndexForLine(lineId);
    document.getElementById('modeChip').textContent = modeLabel();
    setState('idle');
  }

  function playSettingsSheet() {
    if (player) player.pause();
    const pl = p.play;
    const html = () => `
      <h2>Lernmodus</h2>
      <div class="choices" style="margin-top:10px">
        ${Object.entries(MODES).map(([k, m]) => `<label class="choice"><input type="radio" name="mode" value="${k}" ${pl.mode === k ? 'checked' : ''} data-change="mode"><span class="t">${m.label}</span><span class="d">${m.hint}</span></label>`).join('')}
      </div>
      <label class="switch"><span class="label">Nur meine Stichworte<small>Spielt nur die Zeile direkt vor deinem Einsatz.</small></span><input type="checkbox" data-change="cuesOnly" ${pl.cuesOnly ? 'checked' : ''}></label>
      <label class="switch"><span class="label">Meinen Text verdecken<small>Zum Abfragen. Tippe auf eine Zeile, um zu spicken.</small></span><input type="checkbox" data-change="hideMine" ${pl.hideMine ? 'checked' : ''}></label>
      ${pl.mode === 'pause' || pl.mode === 'reveal' ? `<label class="switch"><span class="label">Kurzer Ton vor meinem Einsatz</span><input type="checkbox" data-change="beep" ${pl.beep ? 'checked' : ''}></label>` : ''}
      ${pl.mode === 'tap' ? `<label class="switch"><span class="label">Nach „Weiter“ meinen Satz vorlesen</span><input type="checkbox" data-change="revealAfterTap" ${pl.revealAfterTap ? 'checked' : ''}></label>` : ''}
      <label class="switch"><span class="label">Regieanweisungen vorlesen</span><input type="checkbox" data-change="directions" ${pl.directions ? 'checked' : ''}></label>
      <label class="switch"><span class="label">Lieder überspringen<small>Gesungene Zeilen werden weder vorgelesen noch abgefragt.</small></span><input type="checkbox" data-change="songsSkip" ${pl.songs === 'skip' ? 'checked' : ''}></label>
      ${pl.mode === 'pause' || pl.mode === 'reveal' ? `<div class="field"><span>Länge meiner Pausen</span><div class="range-row"><input type="range" min="0.8" max="2.5" step="0.1" value="${pl.pauseFactor}" data-input="pauseFactor"><output id="pfOut">${String(pl.pauseFactor).replace('.', ',')}×</output></div></div>` : ''}
      <div class="field"><span>Stimmen</span><div class="seg">${['device', 'piper', 'gemini'].map(k => `<button aria-pressed="${p.engine === k}" data-action="engine" data-engine="${k}">${ENGINE_SHORT[k]}</button>`).join('')}</div></div>
      <div class="btn-row"><button class="btn block" data-action="done">Fertig</button></div>`;
    const redraw = () => { const sh = document.querySelector('.sheet'); if (sh) sh.innerHTML = '<div class="grip"></div>' + html(); };
    const save = async () => { await saveProject(p); rebuild(); };
    openSheet(html(), {
      changes: {
        mode: async (el) => { pl.mode = el.value; await save(); redraw(); },
        cuesOnly: async (el) => { pl.cuesOnly = el.checked; await save(); },
        hideMine: async (el) => { pl.hideMine = el.checked; revealed = new Set(); await save(); },
        beep: async (el) => { pl.beep = el.checked; await save(); },
        revealAfterTap: async (el) => { pl.revealAfterTap = el.checked; await save(); },
        directions: async (el) => { pl.directions = el.checked; await save(); },
        songsSkip: async (el) => { pl.songs = el.checked ? 'skip' : 'speak'; await save(); },
      },
      inputs: {
        pauseFactor: (el) => { pl.pauseFactor = Number(el.value); document.getElementById('pfOut').textContent = String(pl.pauseFactor).replace('.', ',') + '×'; clearTimeout(el._t); el._t = setTimeout(save, 300); },
      },
      actions: {
        engine: async (el) => {
          const e = el.dataset.engine;
          if (e === 'gemini' && !S.settings.geminiKey) { toast('Für Gemini zuerst einen Schlüssel in den Einstellungen eintragen.', { error: true }); return; }
          p.engine = e; S.settings.defaultEngine = e; saveSettings(S.settings);
          await prepareCast(); await save(); redraw();
        },
        done: () => closeSheet(),
      },
    });
  }

  async function exportSheet() {
    if (player) player.pause();
    const eng = p.engine;
    let info = '';
    if (eng === 'device') {
      info = `<div class="notice">Mit Handy-Stimmen kann der Browser leider keine Audiodatei aufnehmen. Wechsle unter <b>Lernmodus → Stimmen</b> zu „Offline-KI“ oder „Gemini“.</div>`;
    } else {
      const m = await missingClips({ project: p, scene, settings: S.settings, play: p.play, engineId: eng });
      info = eng === 'gemini' && m.missing ? `<p class="hint">Dafür sind noch etwa ${plural(m.missing, 'Gemini-Anfrage', 'Gemini-Anfragen')} nötig. Bereits erzeugte Zeilen werden wiederverwendet.</p>` : (m.missing ? `<p class="hint">${plural(m.missing, 'Zeile wird', 'Zeilen werden')} noch erzeugt – das dauert einen Moment.</p>` : '');
    }
    const mode = p.play.mode === 'tap' ? 'reveal' : p.play.mode;
    const { el, close } = openSheet(`
      <h2>Szene als Audiodatei</h2>
      <p class="lede">Zum Hören unterwegs, auch bei gesperrtem Bildschirm. Enthalten: ${esc(MODES[mode].label)}${p.play.cuesOnly ? ', nur Stichworte' : ''}${p.play.mode === 'tap' ? ' (statt „Warten bis ich tippe“)' : ''}.</p>
      ${info}
      <div id="expState"></div>
      <div class="btn-row"><button class="btn block" data-action="make" ${eng === 'device' ? 'disabled' : ''}>Audiodatei erstellen</button></div>`, {
      actions: {
        make: async (btn) => {
          btn.disabled = true;
          const box = document.getElementById('expState');
          try {
            const r = await renderScene({
              project: p, scene, settings: S.settings, play: p.play, engineId: eng,
              onProgress: (f, ln, phase) => { box.innerHTML = `<p class="hint">${phase === 'encode' ? 'MP3 wird erstellt …' : `Zeilen werden erzeugt: ${Math.round(f * 100)} %`}</p><div class="progress"><i style="width:${Math.round(f * 100)}%"></i></div>`; },
            });
            const name = safeFileName(`${p.title} – ${scene.title}`) + '.mp3';
            const file = new File([r.blob], name, { type: 'audio/mpeg' });
            const url = URL.createObjectURL(r.blob);
            const canShare = navigator.canShare && navigator.canShare({ files: [file] });
            box.innerHTML = `<div class="audio-out"><p class="hint">${esc(name)}, ${fmtDuration(r.seconds)}, ${fmtBytes(r.blob.size)}</p><audio controls src="${url}"></audio></div>`;
            btn.outerHTML = `<button class="btn block" data-action="save">${icon.download} Herunterladen</button>${canShare ? `<button class="btn secondary block" data-action="share">${icon.share} Teilen</button>` : ''}`;
            sheetActions.click.save = () => download(r.blob, name);
            sheetActions.click.share = async () => { try { await navigator.share({ files: [file], title: name }); } catch (e) { /* abgebrochen */ } };
          } catch (e) {
            box.innerHTML = `<div class="notice warn">${esc(e.message || String(e))}</div>`;
            btn.disabled = false;
          }
        },
      },
    });
    return { el, close };
  }
}

// ------------------------------------------------------------------
// Einstellungen
// ------------------------------------------------------------------
async function showSettings() {
  const s = S.settings;
  const est = await storageEstimate();
  const clipInfo = await clips.sizeEstimate().catch(() => ({ bytes: 0, n: 0 }));
  const piperVoices = piperEngine.catalog();
  const downloaded = new Set(await piperEngine.downloadedKeys().catch(() => []));
  mount({
    render: () => `
      ${topbar('Einstellungen', { back: '#/' })}
      <div class="page">
        <section class="section">
          <h2>Gemini</h2>
          <p class="lede">Für die natürlichsten Stimmen und die automatische Rollenerkennung. Der Schlüssel ist kostenlos und bleibt nur auf diesem Gerät.</p>
          <details><summary>So bekommst du einen Schlüssel</summary>
            <ol class="steps">
              <li>Öffne <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> und melde dich mit einem Google-Konto an.</li>
              <li>Tippe auf „API-Schlüssel erstellen“ und kopiere ihn.</li>
              <li>Füge ihn hier ein. Eine Kreditkarte brauchst du dafür nicht.</li>
            </ol>
            <p class="hint">Das kostenlose Kontingent erlaubt nur wenige Anfragen pro Minute und pro Tag. Die App wartet bei Bedarf automatisch, speichert jede erzeugte Zeile und weicht auf ein anderes Gemini-Sprachmodell aus, wenn das Tageskontingent eines Modells aufgebraucht ist. Laut Google gelten in der EU auch im kostenlosen Kontingent die Datenschutzregeln des Bezahltarifs – außerhalb der EU darf Google kostenlose Anfragen zur Verbesserung seiner Dienste nutzen.</p>
          </details>
          <label class="field"><span>API-Schlüssel</span><input type="password" id="gkey" value="${esc(s.geminiKey)}" placeholder="AIza…" autocomplete="off" data-change="gkey"></label>
          <div class="btn-row"><button class="btn secondary" data-action="testKey">Schlüssel testen</button><button class="btn quiet" data-action="showKey">Anzeigen</button></div>
          <label class="field"><span>Sprachmodell für Stimmen</span><select data-change="ttsModel">${GEMINI_TTS_MODELS.map(m => `<option value="${m.id}" ${m.id === s.geminiTtsModel ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}${GEMINI_TTS_MODELS.some(m => m.id === s.geminiTtsModel) ? '' : `<option selected value="${esc(s.geminiTtsModel)}">${esc(s.geminiTtsModel)}</option>`}</select></label>
          <label class="field"><span>Modell für die Skript-Aufbereitung</span><input type="text" value="${esc(s.geminiTextModel)}" data-change="textModel" autocomplete="off"><small>Standard: gemini-flash-latest</small></label>
          <label class="switch"><span class="label">Anfragen sparen<small>Bündelt aufeinanderfolgende Repliken von bis zu zwei Figuren in einer Anfrage.</small></span><input type="checkbox" ${s.geminiBundle ? 'checked' : ''} data-change="bundle"></label>
          <p class="hint">Heute gestellte Anfragen: ${fmtNumber(geminiRequestsToday())}</p>
        </section>

        <section class="section">
          <h2>Offline-Stimmen</h2>
          <p class="lede">Piper-Stimmen werden einmal geladen und laufen danach ohne Internet.</p>
          <ul class="list">${piperVoices.map(v => `<li><div class="row" style="cursor:default"><span class="main"><span class="title">${esc(v.label)}</span><span class="sub">${esc(v.note || '')}${v.note ? ', ' : ''}${v.size} MB</span></span>
            ${downloaded.has(v.key) ? `<button class="btn quiet" data-action="rmVoice" data-key="${v.key}">Entfernen</button>` : `<button class="btn quiet" data-action="getVoice" data-key="${v.key}">Laden</button>`}</div></li>`).join('')}</ul>
          <details class="section"><summary>Erweitert</summary>
            <label class="field"><span>Adresse der Stimmen-Dateien</span><input type="url" value="${esc(s.piperBaseUrl)}" data-change="piperBase"><small>Nur ändern, wenn du die Stimmen selbst hostest.</small></label>
          </details>
        </section>

        <section class="section">
          <h2>Proben</h2>
          <div class="field"><span>Abstand zwischen den Zeilen</span><div class="range-row"><input type="range" min="100" max="1200" step="50" value="${s.gapMs}" data-input="gap"><output id="gapOut">${(s.gapMs / 1000).toFixed(2).replace('.', ',')} s</output></div></div>
        </section>

        <section class="section">
          <h2>Speicher</h2>
          <p class="hint">${est ? `Belegt: ${fmtBytes(est.usage)}${est.quota ? ` von ${fmtBytes(est.quota)}` : ''}.` : ''} Gespeicherte Zeilen-Audios: ${fmtNumber(clipInfo.n)} (${fmtBytes(clipInfo.bytes)}).</p>
          <div class="btn-row">
            <button class="btn secondary" data-action="clearClips">Zeilen-Audios löschen</button>
          </div>
          <div class="btn-row">
            <button class="btn secondary" data-action="exportAll">${icon.download} Alle Stücke sichern</button>
            <label class="btn secondary" style="position:relative">Sicherung laden<input type="file" accept=".json,application/json" data-change="importAll" style="position:absolute;inset:0;opacity:0"></label>
          </div>
        </section>

        <section class="section">
          <p class="hint">Souffleuse ${APP_VERSION}. Stimmen: Piper (MIT), Thorsten-Voice (CC0), Google Gemini. Schrift: Literata (OFL).</p>
        </section>
      </div>`,
    changes: {
      gkey: (el) => { s.geminiKey = el.value.trim(); saveSettings(s); toast('Schlüssel gespeichert.'); },
      ttsModel: (el) => { s.geminiTtsModel = el.value; saveSettings(s); },
      textModel: (el) => { s.geminiTextModel = el.value.trim() || 'gemini-flash-latest'; saveSettings(s); },
      bundle: (el) => { s.geminiBundle = el.checked; saveSettings(s); },
      piperBase: (el) => { s.piperBaseUrl = el.value.trim() || 'https://huggingface.co/rhasspy/piper-voices/resolve/main/'; setPiperBase(s.piperBaseUrl); saveSettings(s); },
      importAll: async (el) => {
        const f = el.files && el.files[0]; if (!f) return;
        const data = JSON.parse(await f.text());
        if (!data || data.app !== 'souffleuse' || !Array.isArray(data.projects)) throw new Error('Das ist keine Souffleuse-Sicherung.');
        for (const pr of data.projects) {
          if (pr.scriptText) pr.parsed = parseScript(pr.scriptText);
          await projects.put(pr);
        }
        toast(`${plural(data.projects.length, 'Stück', 'Stücke')} geladen.`);
        go('#/');
      },
    },
    inputs: {
      gap: (el) => { s.gapMs = Number(el.value); document.getElementById('gapOut').textContent = (s.gapMs / 1000).toFixed(2).replace('.', ',') + ' s'; saveSettings(s); },
    },
    actions: {
      showKey: (el) => { const i = document.getElementById('gkey'); i.type = i.type === 'password' ? 'text' : 'password'; el.textContent = i.type === 'password' ? 'Anzeigen' : 'Verbergen'; },
      testKey: async (el) => {
        s.geminiKey = document.getElementById('gkey').value.trim(); saveSettings(s);
        if (!s.geminiKey) return toast('Bitte zuerst einen Schlüssel eintragen.', { error: true });
        unlockAudio();
        el.disabled = true; el.textContent = 'Teste …';
        try {
          const r = await geminiEngine.synthesize({ text: 'Hallo! Die Stimme funktioniert.', voiceId: 'Kore', style: 'friendly, warm', apiKey: s.geminiKey, model: s.geminiTtsModel, minIntervalMs: 0 });
          const a = getAudioEl(); a.onended = null; a.ontimeupdate = null; a.src = URL.createObjectURL(wavBlob(r.pcm, r.sampleRate)); a.playbackRate = 1; a.play().catch(() => {});
          toast('Funktioniert.');
        } finally { el.disabled = false; el.textContent = 'Schlüssel testen'; }
      },
      getVoice: async (el) => {
        el.disabled = true;
        requestPersistence();
        try {
          await piperEngine.download(el.dataset.key, (f) => { el.textContent = Math.round(f * 100) + ' %'; });
          showSettings();
        } catch (e) { el.disabled = false; el.textContent = 'Laden'; throw e; }
      },
      rmVoice: async (el) => { await piperEngine.remove(el.dataset.key); showSettings(); },
      clearClips: async () => {
        if (!confirm('Alle gespeicherten Zeilen-Audios löschen? Gemini-Zeilen müssten dann neu angefragt werden.')) return;
        await clips.clear(); toast('Gelöscht.'); showSettings();
      },
      exportAll: async () => {
        const all = await projects.all();
        download(new Blob([JSON.stringify({ app: 'souffleuse', version: 1, projects: all.map(stripProject) })], { type: 'application/json' }), 'souffleuse-sicherung.json');
      },
    },
  });
}

// ------------------------------------------------------------------
// Hilfe
// ------------------------------------------------------------------
function showHelp() {
  mount({
    render: () => `
      ${topbar('So funktioniert’s', { back: '#/' })}
      <div class="page">
        <section class="section"><h2>1. Skript hinzufügen</h2>
          <p class="lede">PDF, Word-Datei oder Text. Danach erkennt die App, wer wann spricht – automatisch, mit Gemini oder mit einem Chatbot deiner Wahl. Lange Skripte werden dabei aktweise verarbeitet.</p></section>
        <section class="section"><h2>2. Rolle wählen</h2>
          <p class="lede">Markiere unter „Rollen“ deine Rolle. Ihre Zeilen erscheinen wie mit Textmarker angestrichen.</p></section>
        <section class="section"><h2>3. Stimmen aussuchen</h2>
          <p class="lede"><b>Handy</b> geht sofort. <b>Offline-KI</b> klingt natürlicher und braucht einmalig einen Download. <b>Gemini</b> spielt am lebendigsten und braucht einen kostenlosen Schlüssel.</p></section>
        <section class="section"><h2>4. Proben</h2>
          <p class="lede">Öffne eine Szene und tippe auf ▶. Bei deinen Zeilen macht die App Pause – oder wartet, bis du „Weiter“ tippst. Über das Regler-Symbol stellst du Lernmodus, Pausenlänge und Stichwort-Training ein. Tippe auf eine Zeile, um dort einzusteigen.</p></section>
        <section class="section"><h2>Unterwegs hören</h2>
          <p class="lede">Mit Offline-KI oder Gemini kannst du eine Szene als MP3 speichern. Die läuft auch bei gesperrtem Bildschirm – in jeder Musik- oder Podcast-App.</p></section>
        <section class="section"><h2>Tipps</h2>
          <p class="lede">Erkennt die App Namen nicht richtig? Unter „Skript“ kannst du alles korrigieren: eine Zeile pro Replik im Muster <span class="kbd">NAME: Text</span>. Auf dem iPhone klingen die Offline-KI- oder Gemini-Stimmen deutlich natürlicher als die eingebauten.</p></section>
      </div>`,
  });
}

// ------------------------------------------------------------------
// Router & Start
// ------------------------------------------------------------------
async function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (!parts.length) return await showHome();
    if (parts[0] === 'neu') return showImport();
    if (parts[0] === 'einstellungen') return await showSettings();
    if (parts[0] === 'hilfe') return showHelp();
    if (parts[0] === 's' && parts[1]) {
      const id = parts[1]; const sub = parts[2] || 'szenen';
      if (S.project && S.project.id !== id) S.project = null;
      if (sub === 'szene' && parts[3]) return await showPlayer(id, parts[3]);
      if (sub === 'aufbereiten') return await showPrepare(id);
      if (sub === 'rollen' || sub === 'text') return await showProject(id, sub);
      return await showProject(id, 'szenen');
    }
    await showHome();
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), { error: true });
    if (parts.length) setTimeout(() => go('#/'), 50);
  }
}

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
// Stimmenliste früh anstoßen (Chrome lädt sie asynchron)
try { if (deviceEngine.available()) speechSynthesis.getVoices(); } catch (e) { /* */ }
window.__souffleuse = { S, route };
