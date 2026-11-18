// Souffleuse – Dateien einlesen (PDF, Word, Text)

const base = new URL('../', import.meta.url);

let pdfjsPromise = null;
async function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(new URL('vendor/pdfjs/pdf.min.mjs', base).href).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', base).href;
      return lib;
    });
  }
  return pdfjsPromise;
}

let mammothPromise = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Konnte ' + src + ' nicht laden'));
    document.head.appendChild(s);
  });
}
async function loadMammoth() {
  if (!mammothPromise) mammothPromise = loadScript(new URL('vendor/mammoth/mammoth.browser.min.js', base).href).then(() => window.mammoth);
  return mammothPromise;
}

// PDF → Text mit Zeilenumbrüchen, Absätzen und Seitenwechseln (\f)
export async function pdfToText(arrayBuffer, onProgress) {
  const pdfjs = await loadPdfJs();
  // Kopie übergeben: pdf.js überträgt den Puffer an seinen Worker (danach wäre er leer)
  const doc = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer.slice(0)), isEvalSupported: false, useSystemFonts: true }).promise;
  const pages = [];
  let textChars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items.filter(it => typeof it.str === 'string').map(it => {
      const [a, b, c, d, e, f] = it.transform;
      const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 10;
      return { str: it.str, x: e, y: f, w: it.width || 0, size, eol: it.hasEOL };
    }).filter(it => it.str.length);
    // nach Zeilen gruppieren (y absteigend), dann x aufsteigend
    items.sort((A, B) => (B.y - A.y) || (A.x - B.x));
    const lines = [];
    for (const it of items) {
      const line = lines.length ? lines[lines.length - 1] : null;
      if (line && Math.abs(line.y - it.y) <= Math.max(2, Math.min(line.size, it.size) * 0.45)) {
        line.items.push(it);
      } else {
        lines.push({ y: it.y, size: it.size, items: [it] });
      }
    }
    const out = [];
    let prevY = null, prevSize = null;
    for (const line of lines) {
      line.items.sort((A, B) => A.x - B.x);
      let s = '';
      let lastEnd = null;
      for (const it of line.items) {
        if (lastEnd != null) {
          const gap = it.x - lastEnd;
          if (gap > it.size * 0.18 && !/\s$/.test(s) && !/^\s/.test(it.str)) s += ' ';
        }
        s += it.str;
        lastEnd = it.x + it.w;
      }
      s = s.replace(/\s+/g, ' ').trim();
      if (!s) continue;
      if (prevY != null) {
        const gap = prevY - line.y;
        const lh = Math.max(prevSize || line.size, line.size) * 1.2;
        if (gap > lh * 1.55) out.push('');
      }
      out.push(s);
      textChars += s.length;
      prevY = line.y; prevSize = line.size;
    }
    pages.push(out.join('\n'));
    if (onProgress) onProgress(p / doc.numPages);
    page.cleanup && page.cleanup();
  }
  const pageCount = doc.numPages;
  try { await doc.destroy(); } catch (e) { /* egal */ }
  return { text: pages.join('\n\f'), pages: pageCount, scanned: textChars < pageCount * 40 };
}

export async function docxToText(arrayBuffer) {
  const mammoth = await loadMammoth();
  const res = await mammoth.extractRawText({ arrayBuffer });
  return { text: res.value.replace(/\n{3,}/g, '\n\n'), pages: null, scanned: false };
}

export function bytesToText(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const bad = (text.match(/�/g) || []).length;
  if (bad > 3) {
    try { text = new TextDecoder('windows-1252').decode(bytes); } catch (e) { /* bleibt */ }
  }
  return text.replace(/^﻿/, '');
}

export async function fileToText(file, onProgress) {
  const name = (file.name || '').toLowerCase();
  const buf = await file.arrayBuffer();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    const r = await pdfToText(buf, onProgress);
    return { ...r, kind: 'pdf', bytes: buf };
  }
  if (name.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return { ...(await docxToText(buf)), kind: 'docx' };
  }
  if (name.endsWith('.doc')) {
    throw new Error('Alte .doc-Dateien kann ich nicht lesen. Bitte in Word/Pages als .docx oder PDF speichern.');
  }
  if (name.endsWith('.odt') || name.endsWith('.pages') || name.endsWith('.rtf')) {
    throw new Error('Dieses Format kann ich nicht direkt lesen. Bitte als PDF oder .docx exportieren.');
  }
  return { text: bytesToText(buf), pages: null, scanned: false, kind: 'txt' };
}
