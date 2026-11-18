// Souffleuse – Skriptformat, Parser und automatische Erkennung
//
// Das „Souffleuse-Format“ (eine Zeile = ein Element):
//   @ ANNA: weiblich, Mitte 20, verträumt     → Figur (Beschreibung optional)
//   # 1. Akt                                  → Akt
//   ## Szene 1: Am Bahnhof                    → Szene
//   (Anna sitzt am Fenster.)                  → Regieanweisung
//   ANNA [traurig | sad, quiet]: Du gehst?    → Replik (Emotion optional)
//   ♪ ANNA [sehnsüchtig]: Ich hab gewartet …  → gesungene Zeile
//   ANNA & MAX: Niemals!                      → gemeinsam gesprochen
//   // Kommentar                              → wird ignoriert
// Zeilen ohne Muster werden an die vorherige Replik angehängt.

const SONG_MARK = /^\s*[♪♫]\s*/u;
const HEADING_ACT = /^\s*#(?!#)\s*(.*)$/u;
const HEADING_SCENE = /^\s*##+\s*(.*)$/u;
const CHAR_DEF = /^\s*@\s*([^:]{1,60}?)\s*(?::\s*(.*))?$/u;
// Name, optionale Emotion in [ ] oder ( ), Doppelpunkt (oder Punkt bei GROSSBUCHSTABEN), Text
const SPEECH = /^\s*([\p{L}\p{M}][\p{L}\p{M}\p{N} .'’\-&/+]{0,44}?)\s*(?:\[([^\]]{0,240})\]|\(([^)]{0,160})\))?\s*([:.])\s*(.*)$/u;
const GROUP_SPLIT = /\s*(?:&|\+|\/|,|\bund\b|\bUND\b)\s*/u;
const ENSEMBLE_KEYS = ['ALLE', 'CHOR', 'ENSEMBLE', 'TUTTI', 'BEIDE', 'ALLE ZUSAMMEN', 'GEMEINSAM'];
const NAME_STOPWORDS = new Set(['HINWEIS', 'ACHTUNG', 'ANMERKUNG', 'NOTIZ', 'ORT', 'ZEIT', 'PERSONEN', 'BESETZUNG', 'INHALT', 'SEITE', 'TEIL', 'AKT', 'SZENE', 'BILD', 'MUSIK', 'LICHT', 'TON', 'VORHANG', 'ENDE', 'PAUSE', 'NR', 'NUMMER', 'SONG', 'LIED', 'REPRISE', 'FINALE', 'PROLOG', 'EPILOG', 'COPYRIGHT', 'TEXT', 'BUCH', 'REGIE', 'MAN']);
const LOWER_PARTICLES = new Set(['von', 'van', 'de', 'der', 'den', 'zu', 'zum', 'und', 'la', 'le', 'du', 'di', 'da']);

export const ENSEMBLE = ENSEMBLE_KEYS;

export function normalizeKey(name) {
  return String(name || '').replace(/[♪♫]/gu, '').replace(/\s+/g, ' ').trim().toUpperCase();
}

function hasLower(s) { return /\p{Ll}/u.test(String(s).replace(/ß/g, '')); }
function letterCount(s) { return (String(s).match(/\p{L}/gu) || []).length; }

export function displayName(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return s;
  if (hasLower(s)) return s; // bereits gemischte Schreibweise → so lassen
  return s.toLowerCase().split(' ').map((w, i) => {
    if (i > 0 && LOWER_PARTICLES.has(w)) return w;
    return w.replace(/(^|[-'’])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
  }).join(' ');
}

const FEMALE_HINT = /\b(weiblich|frau|mädchen|maedchen|mutter|tochter|schwester|tante|oma|großmutter|grossmutter|königin|koenigin|prinzessin|hexe|fee|braut|witwe|nonne|dame|lady|female|woman|girl|she)\b/iu;
const MALE_HINT = /\b(männlich|maennlich|mann|junge|vater|sohn|bruder|onkel|opa|großvater|grossvater|könig|koenig|prinz|zauberer|bräutigam|braeutigam|mönch|moench|herr|sir|lord|male|man|boy|he)\b/iu;
const FEMALE_NAMES = new Set('ANNA ANNE ANJA ANDREA ANGELA ANTJE BARBARA BEATE BIRGIT BRIGITTE CAROLIN CAROLINE CHARLOTTE CHRISTINA CHRISTINE CLAUDIA CLARA DANIELA DIANA DORIS DOROTHEA ELENA ELISABETH ELKE ELLA ELSA EMILIA EMMA ERIKA EVA FRANZISKA FRIEDA FRIEDERIKE GABI GABRIELE GERDA GRETA GRETCHEN HANNA HANNAH HEIDI HELENA HELENE HELGA HILDE INES INGA INGE IRIS ISABEL JANA JANINA JASMIN JENNIFER JESSICA JOHANNA JOSEFINE JUDITH JULIA JULIANE JULIE KAREN KARIN KATHARINA KATJA KATRIN KERSTIN KIM KLARA LAURA LEA LENA LENI LILLI LILLY LINA LISA LOTTE LUISA LUISE MAJA MARGARETE MARIA MARIE MARINA MARION MARLENE MARTHA MARTINA MATHILDA MELANIE MIA MICHAELA MONIKA NADINE NATALIE NICOLE NINA NORA PAULA PETRA RENATE RITA ROSA ROSWITHA RUTH SABINE SANDRA SARA SARAH SILKE SIMONE SOFIA SOPHIA SOPHIE STEFANIE SUSANNE SVENJA TANJA THERESA TINA UTE VALENTINA VANESSA VERA VERONIKA VIKTORIA WILMA YVONNE ZOE DOROTHY WENDY MARY ELIZA CHRISTINE CHRISTINA ELPHABA GLINDA NESSAROSE SANDY RIZZO VELMA ROXIE SALLY'.split(' '));
const MALE_NAMES = new Set('ADAM ALBERT ALEXANDER ANDREAS ANTON ARNE AXEL BEN BENEDIKT BENJAMIN BERND BERNHARD BORIS CARL CHRISTIAN CHRISTOPH DANIEL DAVID DENNIS DIETER DIRK DOMINIK EMIL ERIK ERIC ERNST FABIAN FELIX FINN FLORIAN FRANZ FRANK FRIEDRICH FRITZ GEORG GERHARD GÜNTER GUSTAV HANS HARALD HEINZ HEINRICH HELMUT HENRY HERBERT HERMANN HORST HUGO JAKOB JAN JENS JOACHIM JOHANN JOHANNES JONAS JÖRG JOSEF JULIAN JÜRGEN KAI KARL KARSTEN KLAUS KONRAD KURT LARS LEON LEONARD LUCA LUDWIG LUKAS MANFRED MARCEL MARCO MARIO MARKUS MARTIN MATHIAS MATTHIAS MAX MAXIMILIAN MICHAEL MORITZ NICO NIKLAS NILS OLIVER OSKAR OTTO PATRICK PAUL PETER PHILIPP RAINER RALF REINHARD RICHARD ROBERT ROLAND RUDOLF SEBASTIAN SIMON STEFAN STEPHAN SVEN THEO THOMAS TIM TOBIAS TOM TORSTEN UDO ULRICH UWE VOLKER WALTER WERNER WILHELM WOLFGANG YANNICK FIYERO DANNY KENICKIE BILLY AMOS JUD CURLY TONY RIFF BERNARDO'.split(' '));

export function guessGender(key, description = '') {
  if (description) {
    const d = ' ' + description + ' ';
    const f = FEMALE_HINT.test(d), m = MALE_HINT.test(d);
    if (/\bdivers\b/i.test(d)) return 'd';
    if (f && !m) return 'f';
    if (m && !f) return 'm';
  }
  const words = normalizeKey(key).split(' ');
  for (const w of words) {
    if (FEMALE_NAMES.has(w)) return 'f';
    if (MALE_NAMES.has(w)) return 'm';
  }
  const k = ' ' + normalizeKey(key).toLowerCase() + ' ';
  if (FEMALE_HINT.test(k)) return 'f';
  if (MALE_HINT.test(k)) return 'm';
  // Berufsbezeichnungen auf -in (Lehrerin, Wirtin …)
  const last = words[words.length - 1] || '';
  if (/[A-ZÄÖÜ]{3,}(ERIN|TIN|NIN|LIN|KIN|DIN|GIN|RIN)$/u.test(last) && !MALE_NAMES.has(last)) return 'f';
  return '?';
}

// Entfernt Inline-Regieanweisungen „(zögert)“ aus dem Sprechtext
export function splitInlineDirections(text) {
  const notes = [];
  let spoken = String(text || '').replace(/\(([^()]{1,200})\)/gu, (m, inner) => {
    notes.push(inner.trim());
    return /^(kurze\s+|lange\s+)?pause$/iu.test(inner.trim()) ? ' ⏸ ' : ' ';
  });
  spoken = spoken.replace(/\[[^\]]{0,200}\]/gu, ' ');
  spoken = spoken.replace(/\s+([,.!?;:])/gu, '$1').replace(/\s{2,}/g, ' ').trim();
  spoken = spoken.replace(/^(⏸\s*)+/u, '').replace(/(\s*⏸)+$/u, '').replace(/(⏸\s*){2,}/gu, '⏸ ').trim();
  return { spoken, notes };
}

// Reicht die Klammer am Zeilenanfang über die ganze Zeile?
// true = ganze Zeile, false = danach folgt noch Text, null = schließt nicht in dieser Zeile
function leadingParen(t) {
  const open = t[0], close = open === '[' ? ']' : ')';
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === open) depth++;
    else if (t[i] === close && --depth === 0) return t.slice(i + 1).trim() === '';
  }
  return null;
}
// Zeilenanfang einer Replik in GROSSBUCHSTABEN („ANNA:“, „♪ MAX [froh]:“) – beendet mehrzeilige Klammern
const SPEECH_START = /^\s*[♪♫]?\s*\p{Lu}[\p{Lu}\p{M}\p{N} .'’\-&/+]{0,44}\s*(?:\[[^\]]*\])?\s*:/u;

export const PARSER_VERSION = 2;

function parseEmotion(raw) {
  if (!raw) return { emotion: '', delivery: '' };
  const parts = String(raw).split('|');
  return { emotion: (parts[0] || '').trim(), delivery: parts.slice(1).join('|').trim() };
}

function looksLikeHeading(line) {
  const s = line.trim();
  if (!s || s.length > 90) return null;
  const ORD = '(?:erste[rs]?|zweite[rs]?|dritte[rs]?|vierte[rs]?|fünfte[rs]?|fuenfte[rs]?|sechste[rs]?|siebte[rs]?|achte[rs]?|neunte[rs]?|zehnte[rs]?|letzte[rs]?)';
  const NUM = '(?:\\d{1,3}|[IVXLC]{1,6})';
  const actRe = new RegExp(`^(?:${NUM}\\.?\\s*|${ORD}\\s+)?(?:akt|aufzug|teil|act)\\b(?:\\s*${NUM}\\.?)?\\s*[:.–—-]?\\s*(.{0,70})$`, 'iu');
  const sceneRe = new RegExp(`^(?:${NUM}\\.?\\s*|${ORD}\\s+)?(?:szene|bild|auftritt|scene|sc\\.)\\b(?:\\s*${NUM}[a-z]?\\.?)?\\s*[:.–—-]?\\s*(.{0,70})$`, 'iu');
  const specialRe = /^(prolog|epilog|ouvertüre|ouverture|vorspiel|nachspiel|finale|entr'?acte|zwischenspiel|pause)\b\s*[:.–—-]?\s*(.{0,60})$/iu;
  if (actRe.test(s)) return { kind: 'act', title: s };
  if (sceneRe.test(s)) return { kind: 'scene', title: s };
  const sp = s.match(specialRe);
  if (sp && (s.length < 40 || !hasLower(s.slice(0, 1)))) return { kind: 'scene', title: s };
  return null;
}

function isLikelyName(cand) {
  const s = cand.trim();
  if (!s || s.length > 45) return false;
  if (letterCount(s) < 2) return false;
  const words = s.split(/\s+/);
  if (words.length > 5) return false;
  if (/[!?;"„“”«»]/u.test(s)) return false;
  const key = normalizeKey(s);
  if (NAME_STOPWORDS.has(key)) return false;
  return true;
}

// ------------------------------------------------------------------
// Parser für das Souffleuse-Format
// ------------------------------------------------------------------
export function parseScript(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const characters = new Map(); // key → {key,name,description,gender,count,order}
  const warnings = [];
  const scenes = [];
  let actTitle = '';
  let scene = null;
  let current = null; // offene Replik für Fortsetzungszeilen
  let order = 0;

  // Vorab: Figurenliste und wiederholte Namen sammeln (für gemischte Schreibweise „Anna:“)
  const candidateCounts = new Map();
  for (const raw of lines) {
    const def = raw.match(CHAR_DEF);
    if (def) {
      const key = normalizeKey(def[1]);
      if (key && !characters.has(key)) {
        const description = (def[2] || '').trim();
        characters.set(key, { key, name: displayName(def[1]), description, gender: guessGender(key, description), count: 0, order: order++ });
      }
      continue;
    }
    const m = raw.replace(SONG_MARK, '').match(SPEECH);
    if (m && m[4] === ':' && isLikelyName(m[1])) {
      const k = normalizeKey(m[1]);
      candidateCounts.set(k, (candidateCounts.get(k) || 0) + 1);
    }
  }

  const ensureScene = (title) => {
    if (!scene) {
      scene = { id: 's' + scenes.length, title: title || actTitle || 'Szene ' + (scenes.length + 1), actTitle, lines: [] };
      scenes.push(scene);
    }
    return scene;
  };
  const addCharacter = (key, raw) => {
    if (!characters.has(key)) {
      characters.set(key, { key, name: displayName(raw), description: '', gender: guessGender(key), count: 0, order: order++ });
    }
    return characters.get(key);
  };
  const pushLine = (line) => {
    const sc = ensureScene();
    line.id = sc.id + '-' + sc.lines.length;
    line.index = sc.lines.length;
    sc.lines.push(line);
    return line;
  };

  const acceptSpeaker = (cand, punct, hasEmotion) => {
    if (!isLikelyName(cand)) return false;
    const key = normalizeKey(cand);
    if (characters.has(key)) return true;
    const upper = !hasLower(cand);
    if (punct === '.') return upper && letterCount(cand) >= 2; // „ANNA. Text“ nur bei Großbuchstaben
    if (upper) return true;
    if (hasEmotion) return true;
    // gemischte Schreibweise: mind. zweimal als Sprecher verwendet, max. 3 Wörter, jedes groß
    const words = cand.trim().split(/\s+/);
    return (candidateCounts.get(key) || 0) >= 2 && words.length <= 3 && words.every(w => /^\p{Lu}/u.test(w));
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) { current = null; continue; }
    if (t.startsWith('//')) continue;
    if (CHAR_DEF.test(t)) { current = null; continue; }

    let m;
    if ((m = t.match(HEADING_SCENE))) {
      scene = null; current = null;
      ensureScene(m[1].trim() || 'Szene ' + (scenes.length + 1));
      continue;
    }
    if ((m = t.match(HEADING_ACT))) {
      const title = m[1].trim();
      current = null;
      // derselbe Akt noch einmal (z. B. am Anfang von „Teil 2“) → laufende Szene geht weiter
      if (title === actTitle && scene) continue;
      actTitle = title; scene = null;
      continue;
    }

    // Regieanweisung: Zeile beginnt mit einer Klammer.
    // „(zögert) und dann …“ mitten in einer Replik bleibt Fortsetzung der Replik.
    const paren = /^[([]/u.test(t) ? leadingParen(t) : undefined;
    if (paren === true || paren === null || (paren === false && !current)) {
      let body = t;
      if (paren === null) {
        // mehrzeilige Klammer zusammensammeln, bis sie sich schließt (höchstens 12 Zeilen)
        let j = i + 1;
        while (j < lines.length && j - i < 12 && leadingParen(body) === null) {
          const next = lines[j].trim();
          if (!next || HEADING_ACT.test(next) || HEADING_SCENE.test(next) || CHAR_DEF.test(next) || SPEECH_START.test(next)) break;
          body += ' ' + next; j++;
        }
        i = j - 1;
      }
      const inner = leadingParen(body) === false ? body : body.replace(/^[([]\s*/u, '').replace(/\s*[)\]]\s*$/u, '').trim();
      pushLine({ kind: 'direction', text: inner, spoken: inner, speakers: [], speakerKey: null, song: SONG_MARK.test(inner) });
      current = null;
      continue;
    }

    const song = SONG_MARK.test(t);
    const body = t.replace(SONG_MARK, '');
    m = body.match(SPEECH);
    if (m && acceptSpeaker(m[1], m[4], !!(m[2] || m[3]))) {
      const rawName = m[1].trim();
      const key = normalizeKey(rawName);
      const { emotion, delivery } = parseEmotion(m[2] != null ? m[2] : m[3]);
      // Gruppen („ANNA & MAX“) auflösen, wenn alle Teile bekannte Figuren sind
      let speakers = [key];
      const parts = key.split(GROUP_SPLIT).map(s => s.trim()).filter(Boolean);
      if (parts.length > 1 && parts.every(p => characters.has(p) || (candidateCounts.get(p) || 0) >= 1)) {
        speakers = parts;
        parts.forEach(p => addCharacter(p, p));
      } else {
        addCharacter(key, rawName);
      }
      speakers.forEach(k => { const c = characters.get(k); if (c) c.count++; });
      const textPart = m[5] || '';
      const { spoken, notes } = splitInlineDirections(textPart);
      current = pushLine({ kind: 'speech', speakerKey: key, speakers, text: textPart.trim(), spoken, notes, emotion, delivery, song });
      continue;
    }

    // Fortsetzungszeile
    if (current) {
      const joiner = /-$/u.test(current.text) && /^\p{Ll}/u.test(t) ? '' : ' ';
      current.text = (joiner ? current.text : current.text.replace(/-$/u, '')) + joiner + t;
      const { spoken, notes } = splitInlineDirections(current.text);
      current.spoken = spoken; current.notes = notes;
      continue;
    }
    // freier Text ohne Sprecher → als Regie behandeln
    pushLine({ kind: 'direction', text: t, spoken: t, speakers: [], speakerKey: null, song });
  }

  // Leere Repliken (nur Inline-Regie) in Regie umwandeln
  for (const sc of scenes) {
    for (const ln of sc.lines) {
      if (ln.kind === 'speech' && !ln.spoken) {
        ln.kind = 'direction'; ln.text = ln.notes && ln.notes.length ? ln.notes.join(' ') : ln.text; ln.spoken = ln.text;
      }
    }
  }
  const nonEmpty = scenes.filter(s => s.lines.some(l => l.kind === 'speech'));
  nonEmpty.forEach((s, i) => { s.id = 's' + i; s.lines.forEach((l, j) => { l.id = s.id + '-' + j; l.index = j; }); });

  const chars = [...characters.values()].sort((a, b) => a.order - b.order);
  const speeches = nonEmpty.reduce((n, s) => n + s.lines.filter(l => l.kind === 'speech').length, 0);
  if (!speeches) {
    warnings.push(characters.size
      ? 'Bisher sind nur Figuren drin, aber noch keine Repliken. Wenn du das Skript abschnittsweise aufbereitest: Füge auch die Antworten für die Akte ein (Menü ⋯ → Neu aufbereiten – deine bisherigen Antworten bleiben erhalten).'
      : 'Keine Repliken erkannt. Prüfe, ob Zeilen das Muster „NAME: Text“ haben.');
  }
  return {
    characters: chars.filter(c => c.count > 0 || c.description),
    scenes: nonEmpty,
    warnings,
    stats: {
      speeches,
      directions: nonEmpty.reduce((n, s) => n + s.lines.filter(l => l.kind === 'direction').length, 0),
      songs: nonEmpty.reduce((n, s) => n + s.lines.filter(l => l.song).length, 0),
      scenes: nonEmpty.length,
    },
  };
}

// ------------------------------------------------------------------
// Rohtext (aus PDF/Word) → Souffleuse-Format (ohne KI)
// ------------------------------------------------------------------
export function cleanRawText(raw) {
  const normalized = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/­/g, '')
    .replace(/[   ]/g, ' ')
    .replace(/\t/g, ' ')
    .replace(/[ ]{2,}/g, ' ');
  const isPageNo = (l) => /^(?:seite\s*)?[-–—]?\s*\d{1,4}\s*[-–—]?$/iu.test(l) || /^\d{1,4}\s*\/\s*\d{1,4}$/u.test(l) || /^seite\s+\d+\s+(von|\/)\s+\d+$/iu.test(l);
  let pages = normalized.split('\f').map(p => p.split('\n').map(l => l.trim()));
  // Kopf-/Fußzeilen: nur die ersten/letzten Zeilen jeder Seite, die auf vielen Seiten gleich sind
  if (pages.length >= 3) {
    const norm = (l) => l.replace(/\d+/g, '#').toLowerCase();
    const counts = new Map();
    const edges = (p) => {
      const idx = p.map((l, i) => l ? i : -1).filter(i => i >= 0);
      return [...idx.slice(0, 2), ...idx.slice(-2)];
    };
    pages.forEach(p => { new Set(edges(p).map(i => norm(p[i]))).forEach(k => counts.set(k, (counts.get(k) || 0) + 1)); });
    const limit = Math.max(3, Math.ceil(pages.length * 0.3));
    pages = pages.map(p => {
      const kill = new Set(edges(p).filter(i => (counts.get(norm(p[i])) || 0) >= limit && p[i].length < 90 && !looksLikeHeading(p[i])));
      return p.filter((l, i) => !kill.has(i));
    });
  }
  // Leerzeilen an Seitenrändern entfernen, damit Seitenwechsel keine Repliken zerreißen
  pages = pages.map(p => {
    const q = p.filter(l => !isPageNo(l));
    while (q.length && !q[0]) q.shift();
    while (q.length && !q[q.length - 1]) q.pop();
    return q;
  });
  let lines = pages.flat();
  // Silbentrennung am Zeilenende zusammenführen
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    while (/\p{Ll}-$/u.test(l) && i + 1 < lines.length && /^\p{Ll}/u.test(lines[i + 1])) {
      l = l.slice(0, -1) + lines[i + 1];
      i++;
    }
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function rawToScript(raw) {
  const text = cleanRawText(raw);
  const lines = text.split('\n');
  const out = [];
  const speakerCounts = new Map();
  const RE_INLINE = /^([\p{L}\p{M}][\p{L}\p{M}\p{N} .'’\-&/+]{0,44}?)\s*(?:\(([^)]{0,160})\)|\[([^\]]{0,160})\])?\s*([:.])\s+(\S.*)$/u;
  const RE_ALONE = /^([\p{Lu}\p{M}][\p{Lu}\p{M}\p{N} .'’\-&/+]{0,44}?)\s*(?:\(([^)]{0,160})\)|\[([^\]]{0,160})\])?\s*[:.]?$/u;

  // Vorab zählen, welche Kandidaten wiederholt als Sprecher auftauchen
  for (const l of lines) {
    const m = l.match(RE_INLINE);
    if (m && isLikelyName(m[1]) && (m[4] === ':' || !hasLower(m[1]))) {
      const k = normalizeKey(m[1]); speakerCounts.set(k, (speakerCounts.get(k) || 0) + 1);
    } else {
      const a = l.match(RE_ALONE);
      if (a && isLikelyName(a[1]) && !hasLower(a[1]) && letterCount(a[1]) >= 2) {
        const k = normalizeKey(a[1]); speakerCounts.set(k, (speakerCounts.get(k) || 0) + 1);
      }
    }
  }
  const isSpeaker = (cand, punct) => {
    if (!isLikelyName(cand)) return false;
    const k = normalizeKey(cand);
    const n = speakerCounts.get(k) || 0;
    if (!hasLower(cand)) {
      if (letterCount(cand) < 2) return false;
      if (punct === ':') return true;
      return n >= 2 || letterCount(cand) >= 3;
    }
    if (punct !== ':') return false;
    const words = cand.trim().split(/\s+/);
    return n >= 2 && words.length <= 3 && words.every(w => /^\p{Lu}/u.test(w));
  };

  const chars = new Map();
  let cur = null;            // offene Replik {key, emo, text}
  let prevBlank = true;
  let dirBuf = null;         // mehrzeilige Klammer
  const emit = () => {
    if (!cur) return;
    const t = cur.text.replace(/\s{2,}/g, ' ').trim();
    if (t) out.push(`${cur.key}${cur.emo ? ' [' + cur.emo + ']' : ''}: ${t}`);
    else if (cur.emo) out.push(`(${cur.emo})`);
    cur = null;
  };
  const handleDirection = (inner) => {
    inner = inner.replace(/^[([]\s*|\s*[)\]]$/gu, '').trim();
    if (!inner) return;
    if (cur && !cur.text && !prevBlank && inner.length <= 60) { cur.emo = cur.emo ? cur.emo + ', ' + inner : inner; return; }
    if (cur && cur.text && !prevBlank) { cur.text += ' (' + inner + ')'; return; }
    emit();
    out.push('(' + inner + ')');
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (dirBuf != null) {
      dirBuf += ' ' + l;
      if (!l || /[)\]]$/u.test(l)) { handleDirection(dirBuf); dirBuf = null; prevBlank = !l; }
      continue;
    }
    if (!l) {
      // Sprecher ohne Text bleibt offen (Text folgt evtl. nach Leerzeile/Seitenwechsel)
      if (cur && !cur.text) { prevBlank = true; continue; }
      emit(); prevBlank = true; out.push(''); continue;
    }
    const h = looksLikeHeading(l);
    if (h) { emit(); out.push(''); out.push((h.kind === 'act' ? '# ' : '## ') + h.title); out.push(''); prevBlank = true; continue; }
    if (/^(nr\.?|nummer|no\.|song|lied|musiknummer)\s*\d+/iu.test(l) && l.length < 80) { emit(); out.push('(♪ ' + l + ')'); prevBlank = false; continue; }
    if (/^[([]/u.test(l)) {
      if (/[)\]]$/u.test(l)) handleDirection(l); else dirBuf = l;
      prevBlank = false;
      continue;
    }
    const song = /^[♪♫]/u.test(l);
    const body = l.replace(/^[♪♫]\s*/u, '');
    let m = body.match(RE_INLINE);
    if (m && isSpeaker(m[1], m[4])) {
      emit();
      const key = normalizeKey(m[1]); if (!chars.has(key)) chars.set(key, m[1].trim());
      cur = { key: (song ? '♪ ' : '') + key, emo: (m[2] || m[3] || '').trim(), text: m[5].trim() };
      prevBlank = false;
      continue;
    }
    const a = body.match(RE_ALONE);
    if (a && !hasLower(a[1]) && isSpeaker(a[1], ':')) {
      emit();
      const key = normalizeKey(a[1]); if (!chars.has(key)) chars.set(key, a[1].trim());
      cur = { key: (song ? '♪ ' : '') + key, emo: (a[2] || a[3] || '').trim(), text: '' };
      prevBlank = false;
      continue;
    }
    if (cur) {
      if (/-$/u.test(cur.text) && /^\p{Ll}/u.test(l)) cur.text = cur.text.slice(0, -1) + l;
      else cur.text += (cur.text ? ' ' : '') + l;
    } else {
      out.push('(' + l.replace(/[()]/g, '') + ')');
    }
    prevBlank = false;
  }
  if (dirBuf != null) handleDirection(dirBuf);
  emit();

  const cleaned = out;
  const header = [...chars.keys()].map(k => `@ ${k}:`);
  const body = cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const result = (header.length ? header.join('\n') + '\n\n' : '') + body + '\n';
  const parsed = parseScript(result);
  return { text: result, parsed };
}

// ------------------------------------------------------------------
// Rohtext in Abschnitte (Akte) für die KI-Aufbereitung teilen
// ------------------------------------------------------------------
export function segmentRaw(raw, maxChars = 14000) {
  const text = cleanRawText(raw);
  const lines = text.split('\n');
  const heads = [];
  lines.forEach((l, i) => { const h = looksLikeHeading(l); if (h && h.kind === 'act') heads.push({ i, title: l.trim() }); });
  let parts = [];
  if (heads.length >= 1) {
    if (heads[0].i > 0) {
      const pre = lines.slice(0, heads[0].i).join('\n').trim();
      if (pre) parts.push({ title: 'Vorspann', text: pre });
    }
    heads.forEach((h, k) => {
      const end = k + 1 < heads.length ? heads[k + 1].i : lines.length;
      parts.push({ title: h.title, text: lines.slice(h.i, end).join('\n').trim() });
    });
  } else {
    parts.push({ title: 'Gesamter Text', text });
  }
  // zu lange Teile an Szenen-/Absatzgrenzen weiter teilen
  const result = [];
  for (const p of parts) {
    if (p.text.length <= maxChars) { result.push(p); continue; }
    const pl = p.text.split('\n');
    let buf = [], len = 0, n = 1;
    const flush = () => {
      if (!buf.length) return;
      result.push({ title: `${p.title} (Teil ${n++})`, text: buf.join('\n').trim() });
      buf = []; len = 0;
    };
    for (let i = 0; i < pl.length; i++) {
      const l = pl[i];
      const isScene = !!(looksLikeHeading(l));
      const breakHere = len > maxChars * 0.6 && (isScene || (!l.trim() && len > maxChars * 0.85));
      if (breakHere || len + l.length > maxChars) flush();
      buf.push(l); len += l.length + 1;
    }
    flush();
  }
  return result.filter(p => p.text.trim()).map((p, i) => ({ ...p, index: i }));
}

// Übersicht der Figuren für Prompts
export function characterSummary(parsed) {
  return (parsed && parsed.characters || []).map(c => `@ ${c.key}${c.description ? ': ' + c.description : ''}`).join('\n');
}

export function isEnsembleKey(key) { return ENSEMBLE_KEYS.includes(normalizeKey(key)); }

// Zeilen einer Szene, die „mir“ gehören
export function isMine(line, myRoles, includeEnsemble) {
  if (!line || line.kind !== 'speech') return false;
  const set = new Set((myRoles || []).map(normalizeKey));
  if (line.speakers.some(k => set.has(k))) return true;
  if (includeEnsemble && line.speakers.some(isEnsembleKey)) return true;
  return false;
}
