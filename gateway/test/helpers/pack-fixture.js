// Synthetic explainer for the context-pack tests and scripts/dump-instructions.mjs (no real content).
const TOPICS = ['Alphabetrieb', 'Zahlungsfluss', 'Risikoprüfung', 'Berichtswesen', 'Datenquellen', 'Abnahme'];

export function makeTimeline({ sceneChars = 900 } = {}) {
  const scenes = [];
  const words = [];
  let t = 0;
  TOPICS.forEach((topic, i) => {
    const text = `${topic}: ${'Dieser Schritt erklärt ' + topic.toLowerCase() + ' mit konkreten Zahlen und Beispielen. '.repeat(Math.ceil(sceneChars / 70))}`.slice(0, sceneChars);
    const toks = text.split(/\s+/);
    const start = t;
    toks.forEach((w) => { words.push({ w, s: t, e: t + 0.3 }); t += 0.3; });
    scenes.push({ id: `scene${i + 1}`, start, end: t, text });
  });
  const cues = {};
  scenes.forEach((s, i) => { cues[`el${i + 1}a`] = s.start + 0.5; cues[`el${i + 1}b`] = s.start + 1.5; });
  return { title: 'Demo-Erklärer', scenes, words, cues };
}

export function makePoints(timeline = makeTimeline()) {
  const points = {};
  timeline.scenes.forEach((s, i) => {
    points[s.id] = { title: TOPICS[i], short: `Überblick ${TOPICS[i]}` };
    points[`el${i + 1}a`] = { title: `${TOPICS[i]} Detail A`, short: `Kurz zu ${TOPICS[i]} A`, more: `Mehr zu ${TOPICS[i]} A: genau 42 Einheiten pro Lauf.` };
    points[`el${i + 1}b`] = { title: `${TOPICS[i]} Detail B`, short: `Kurz zu ${TOPICS[i]} B`, more: `Mehr zu ${TOPICS[i]} B.` };
  });
  points.orphan = { title: 'Ohne Cue', short: 'Gruppe ohne Zeitmarke' };
  return { page: { title: 'Demo-Erklärer', context: 'Fakten: '.repeat(400) }, points };
}

export function makeDeepdive({ sections = 12, chars = 1500 } = {}) {
  const out = ['Einleitung zum Hintergrund.'];
  for (let i = 0; i < sections; i += 1) {
    const topic = TOPICS[i % TOPICS.length];
    out.push(`## Vertiefung ${i + 1}: ${topic}`, `${topic} im Detail. `.repeat(1) + `Die Zahl ${100 + i} stammt aus Quelle ${i + 1}. `.repeat(Math.ceil(chars / 40)).slice(0, chars));
  }
  out.push('## Herkunft', 'Job /home/flori/jobs/demo-job, Board #12345');
  return out.join('\n\n');
}

export function makeContextJson(timeline = makeTimeline(), points = makePoints(timeline)) {
  return {
    v: 1, slug: 'demo-slug', title: 'Demo-Erklärer', lang: 'de', duration: timeline.scenes.at(-1).end,
    scenes: timeline.scenes.map((s, i) => ({ id: s.id, start: s.start, end: s.end, title: TOPICS[i], text: s.text, points: [s.id, `el${i + 1}a`, `el${i + 1}b`] })),
    elements: Object.fromEntries(Object.entries(points.points).filter(([id]) => id !== 'orphan').map(([id, p]) => {
      const sc = timeline.scenes.find((s) => s.id === id) ?? timeline.scenes[Number(id[2]) - 1];
      return [id, { scene: sc.id, t: timeline.cues[id] ?? sc.start, title: p.title, short: p.short }];
    })),
    deepdive: { chars: 0, sections: [] }, sources: [{ label: 'Quelle', ref: 'Demo' }],
  };
}
