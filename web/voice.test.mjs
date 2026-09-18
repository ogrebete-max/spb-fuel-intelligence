// Голос за рулём (18.09.2026): что приложение понимает без всякой модели.
//
// The owner asked to be able to say «Где мне сейчас заправиться рядом?» and to
// mark a station from the car window, and asked that rules do the work wherever
// they can. These are the phrases the rules must get right; the file under test
// is the one the browser loads, read here as text and run in a bare scope.
//   node web/voice.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./voice.js', import.meta.url), 'utf8');
const scope = {};
new Function('window', source)(scope);
const { parse } = scope.Voice;

// Asking where to go.
for (const [said, grade] of [
  ['Где мне сейчас заправиться рядом?', null],
  ['Где заправиться 95-м', 'AI95'],
  ['Где заправиться девяносто пятым', 'AI95'],
  ['Где есть 95', 'AI95'],
  ['Ближайшая с дизелем', 'DT'],
  ['Покажи, где 92', 'AI92'],
  ['Надо заправиться, сотый', 'AI100'],
  ['Куда заехать за 98-м', 'AI98'],
]) {
  const said_ = parse(said);
  assert.equal(said_.kind, 'find', said);
  assert.equal(said_.grade, grade, said);
}

// Marking a station while standing at it.
const marks = [
  ['95 есть', { grade: 'AI95', seen: true, queue: null }],
  ['Девяносто пятого нет', { grade: 'AI95', seen: false, queue: null }],
  ['Залил 92', { grade: 'AI92', seen: true, queue: null }],
  ['Дизеля нет', { grade: 'DT', seen: false, queue: null }],
  ['Солярка есть', { grade: 'DT', seen: true, queue: null }],
  ['Есть', { grade: null, seen: true, queue: null }],
  ['Нету', { grade: null, seen: false, queue: null }],
  ['Не работает', { grade: null, seen: false, queue: null }],
  ['98 есть, очередь пять машин', { grade: 'AI98', seen: true, queue: 5 }],
  ['95 есть, очередь 12 машин', { grade: 'AI95', seen: true, queue: 12 }],
  ['95 есть, большая очередь', { grade: 'AI95', seen: true, queue: 20 }],
  ['95 есть, очереди нет', { grade: 'AI95', seen: true, queue: 0 }],
  ['95 есть, без очереди', { grade: 'AI95', seen: true, queue: 0 }],
  ['92 нет, очередь', { grade: 'AI92', seen: false, queue: 5 }],
];
for (const [said, want] of marks) {
  const got = parse(said);
  assert.equal(got.kind, 'mark', said);
  assert.equal(got.grade, want.grade, said);
  assert.equal(got.seen, want.seen, said);
  assert.equal(got.queue, want.queue, said);
}

// «Очереди нет» said alone reports the queue and nothing else: the app then
// asks which grade, instead of writing down a «нет» nobody said.
const queueOnly = parse('Очереди нет');
assert.equal(queueOnly.kind, 'mark');
assert.equal(queueOnly.seen, null);
assert.equal(queueOnly.queue, 0);

// A phrase about anything else must not become a mark: a wrong «нет» costs a
// driver a stop at a station that has fuel.
for (const said of ['Привет, как дела', 'Позвони Ирине', '', '   ', 'Включи музыку']) {
  assert.equal(parse(said).kind, 'unknown', said);
}

// Whatever the recogniser sends back — capitals, a question mark, «ё» — the
// same phrase is read the same way, and the driver's own words are kept.
const loud = parse('ДИЗЕЛЬ ЕСТЬ!');
assert.equal(loud.kind, 'mark');
assert.equal(loud.grade, 'DT');
assert.equal(loud.heard, 'ДИЗЕЛЬ ЕСТЬ!');

console.log(`voice: ${marks.length + 8} phrases read by rules`);
