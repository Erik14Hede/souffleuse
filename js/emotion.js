// Souffleuse – Emotionen erkennen und für die Stimm-Engines übersetzen

const TABLE = [
  { key: 'angry', label: 'wütend', en: 'angry', piper: 'angry', prosody: { rate: 1.08, pitch: 1.05, volume: 1 },
    de: ['wütend', 'wut', 'zornig', 'zorn', 'aufgebracht', 'gereizt', 'sauer', 'empört', 'schreit', 'schreiend', 'brüllt', 'brüllend', 'scharf', 'drohend', 'aggressiv', 'böse', 'verärgert', 'genervt', 'ungeduldig', 'barsch', 'heftig', 'faucht', 'zischt', 'tobt', 'rasend', 'wütet', 'erbost', 'kalt'],
    enw: ['angry', 'furious', 'annoyed', 'irritated', 'shout', 'yell', 'harsh', 'threat', 'rage', 'cold', 'snap', 'hiss'] },
  { key: 'sad', label: 'traurig', en: 'sad', piper: 'neutral', prosody: { rate: 0.9, pitch: 0.93, volume: 0.9 }, lengthScale: 1.12,
    de: ['traurig', 'weint', 'weinend', 'schluchzt', 'verletzt', 'enttäuscht', 'resigniert', 'bedrückt', 'niedergeschlagen', 'verzweifelt', 'kläglich', 'wehmütig', 'melancholisch', 'betrübt', 'trauernd', 'tränen', 'gebrochen', 'leidend', 'hoffnungslos', 'einsam', 'sehnsüchtig'],
    enw: ['sad', 'tearful', 'hurt', 'cry', 'sob', 'grief', 'despair', 'melanchol', 'longing', 'wistful', 'broken'] },
  { key: 'whisper', label: 'flüsternd', en: 'whispering', piper: 'whisper', prosody: { rate: 0.92, pitch: 1, volume: 0.55 },
    de: ['flüstert', 'flüsternd', 'geflüstert', 'flüster', 'heimlich', 'verschwörerisch', 'raunt', 'tuschelt', 'wispert', 'hauchend', 'haucht'],
    enw: ['whisper', 'hush', 'secret', 'conspirator', 'breath'] },
  { key: 'happy', label: 'fröhlich', en: 'happy', piper: 'amused', prosody: { rate: 1.07, pitch: 1.1, volume: 1 },
    de: ['fröhlich', 'lacht', 'lachend', 'amüsiert', 'belustigt', 'heiter', 'vergnügt', 'glücklich', 'begeistert', 'freudig', 'strahlend', 'verschmitzt', 'neckisch', 'kichert', 'kichernd', 'gut gelaunt', 'übermütig', 'ausgelassen', 'jubelt', 'jubelnd', 'erleichtert', 'stolz', 'gerührt', 'herzlich', 'lächelnd', 'lächelt'],
    enw: ['happy', 'amused', 'cheerful', 'laugh', 'joy', 'delight', 'playful', 'giggl', 'excited', 'relieved', 'proud', 'smil', 'warm'] },
  { key: 'surprised', label: 'überrascht', en: 'surprised', piper: 'surprised', prosody: { rate: 1.05, pitch: 1.15, volume: 1 },
    de: ['überrascht', 'erstaunt', 'verblüfft', 'ungläubig', 'erschrocken', 'entsetzt', 'schockiert', 'fassungslos', 'perplex', 'staunend', 'aufgeregt', 'atemlos', 'außer atem'],
    enw: ['surprised', 'shocked', 'astonish', 'amazed', 'incredulous', 'disbelie', 'stunned', 'startled', 'breathless', 'out of breath'] },
  { key: 'fearful', label: 'ängstlich', en: 'fearful', piper: 'neutral', prosody: { rate: 1.03, pitch: 1.07, volume: 0.85 },
    de: ['ängstlich', 'angst', 'nervös', 'zögernd', 'zögerlich', 'zögert', 'unsicher', 'verängstigt', 'panisch', 'zitternd', 'zittert', 'stockend', 'stotternd', 'verlegen', 'schüchtern', 'beklommen', 'besorgt'],
    enw: ['scared', 'afraid', 'fear', 'nervous', 'hesitant', 'anxious', 'unsure', 'trembl', 'panic', 'shy', 'embarrass', 'worried'] },
  { key: 'tired', label: 'müde', en: 'tired', piper: 'sleepy', prosody: { rate: 0.85, pitch: 0.92, volume: 0.85 }, lengthScale: 1.15,
    de: ['müde', 'verschlafen', 'gähnt', 'gähnend', 'erschöpft', 'schläfrig', 'matt', 'kraftlos', 'gelangweilt', 'lustlos'],
    enw: ['tired', 'sleepy', 'exhausted', 'yawn', 'bored', 'weary'] },
  { key: 'disgusted', label: 'verächtlich', en: 'contemptuous', piper: 'disgusted', prosody: { rate: 0.96, pitch: 0.96, volume: 1 },
    de: ['angewidert', 'ekel', 'verächtlich', 'abfällig', 'höhnisch', 'spöttisch', 'spottend', 'herablassend', 'abschätzig', 'sarkastisch', 'zynisch', 'ironisch'],
    enw: ['disgust', 'contempt', 'sneer', 'mock', 'sarcas', 'scorn', 'condescend', 'ironic', 'dry'] },
  { key: 'drunk', label: 'betrunken', en: 'drunk', piper: 'drunk', prosody: { rate: 0.85, pitch: 0.95, volume: 1 },
    de: ['betrunken', 'angetrunken', 'lallt', 'lallend', 'beschwipst', 'besoffen'],
    enw: ['drunk', 'tipsy', 'slurr'] },
  { key: 'tender', label: 'zärtlich', en: 'tender', piper: 'neutral', prosody: { rate: 0.93, pitch: 1.0, volume: 0.85 }, lengthScale: 1.06,
    de: ['zärtlich', 'liebevoll', 'sanft', 'warm', 'beruhigend', 'tröstend', 'behutsam', 'innig', 'verliebt', 'weich', 'leise', 'gedämpft', 'nachdenklich', 'versonnen', 'verträumt', 'träumerisch'],
    enw: ['tender', 'gentle', 'soft', 'loving', 'sooth', 'comfort', 'quiet', 'thoughtful', 'dreamy', 'calm'] },
  { key: 'loud', label: 'laut', en: 'loud, projecting', piper: 'neutral', prosody: { rate: 1.04, pitch: 1.04, volume: 1 },
    de: ['laut', 'ruft', 'rufend', 'energisch', 'resolut', 'bestimmt', 'befehlend', 'feierlich', 'pathetisch', 'kraftvoll', 'triumphierend', 'trotzig', 'entschlossen'],
    enw: ['loud', 'call', 'project', 'firm', 'command', 'solemn', 'triumph', 'defiant', 'determined', 'brisk', 'announc'] },
];

const NEUTRAL = { key: 'neutral', label: 'neutral', en: '', piper: 'neutral', prosody: { rate: 1, pitch: 1, volume: 1 } };

export function classifyEmotion(emotion = '', delivery = '') {
  const de = ' ' + String(emotion).toLowerCase() + ' ';
  const en = ' ' + String(delivery).toLowerCase() + ' ';
  if (!de.trim() && !en.trim()) return NEUTRAL;
  let best = null, bestPos = Infinity;
  // erstes passendes Wort in der deutschen Angabe gewinnt, dann Englisch
  for (const row of TABLE) {
    for (const w of row.de) {
      const p = de.indexOf(w);
      if (p >= 0 && p < bestPos) { best = row; bestPos = p; }
    }
  }
  if (best) return best;
  bestPos = Infinity;
  for (const row of TABLE) {
    for (const w of row.enw) {
      const p = en.indexOf(w);
      if (p >= 0 && p < bestPos) { best = row; bestPos = p; }
    }
  }
  return best || NEUTRAL;
}

// Stil-Anweisung für Gemini (kurz, englisch empfohlen)
export function styleFor(line) {
  if (!line) return '';
  if (line.delivery) return line.delivery;
  if (line.emotion) {
    const e = classifyEmotion(line.emotion);
    return e.en ? `${e.en} (${line.emotion})` : line.emotion;
  }
  return '';
}

export function prosodyFor(line) {
  return classifyEmotion(line && line.emotion, line && line.delivery).prosody;
}

export function piperParamsFor(line) {
  const e = classifyEmotion(line && line.emotion, line && line.delivery);
  return { emotional: e.piper || 'neutral', lengthScale: e.lengthScale || (e.key === 'angry' || e.key === 'happy' ? 0.95 : 1) };
}

export const EMOTION_LIST = [NEUTRAL, ...TABLE];
