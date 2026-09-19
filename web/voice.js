// Что сказал водитель — правилами, без модели.
//
// The owner asked for two things by voice: «Где мне сейчас заправиться рядом?»
// and a mark made from the car window while passing a station. He also asked
// that nothing be sent to a model where rules will do — «если где-то можно
// обойтись без ЛЛМ, делать без». So the phone's own recogniser turns speech
// into text (free, and built into the browser), and the meaning is taken here,
// from the two dozen words a driver actually says at a pump: a grade, «есть»
// or «нет», and the queue.
//
// Nothing here touches the page: `parse` is a pure function, and the checks in
// `web/voice.test.mjs` read this file and try the phrases on it.
(function (root) {
  'use strict';

  // Speech comes in as one line of words; everything else — commas, hyphens,
  // question marks — is turned into spaces, so a rule can look for « нет »
  // rather than for a word boundary. JavaScript's own \b and \w know only
  // the Latin alphabet and would never see a Russian word at all.
  function tidy(said) {
    return ` ${String(said || '').toLowerCase().replace(/ё/g, 'е').replace(/[^а-я0-9a-z]+/g, ' ').trim()} `;
  }

  // Diesel first: «дизель» carries no number, and a phrase may name both a
  // number and the word («солярка, 92 нет»). A number may come back glued to
  // its ending — «95м» — so only what stands in front of it is required.
  const GRADE_RULES = [
    ['DT', / (дизел|дизтоплив|соляр|дт )/],
    ['AI100', / (100(?!\d)|сотым|сотый|сотое|сотого|сто )/],
    ['AI98', / (98(?!\d)|девяност[а-я]* восьм|девяност[а-я]* восем)/],
    ['AI95', / (95(?!\d)|девяност[а-я]* пят)/],
    ['AI92', / (92(?!\d)|девяност[а-я]* втор|девяност[а-я]* два)/],
  ];

  // «Поехали» / «проложи маршрут»: выбрать заправку и сразу вести. Проверяется
  // раньше вопроса, потому что говорят «поехали к ближайшей с 95».
  const ROUTE = / (поехали|поехать|погнали|проложи|маршрут|веди меня|веди в|навигатор|едем)/;

  // A question about where to go. These words decide even when «есть» is in
  // the phrase too: «Где есть 95?» asks, it does not report.
  const ASKING = / (где|куда|ближайш|найди|найти|поищи|ищу|покажи|подскажи|посоветуй)/;
  // The same question without a question word: «Надо заправиться 95-м».
  const ASKING_SOFTLY = / (заправиться|заправится|заправлюсь|заправимся|залить|заехать|нужен|нужна|нужно|надо|хочу)/;

  const SAYS_YES = / (есть|был|была|было|залил|залили|заправился|заправились|дают|наливают|работает|появил|привезли|наличи)/;
  const SAYS_NO = / (нет|нету|пусто|пустая|кончил|закончил|закрыт|закрыли|отключил|убрали)/;
  const NOT_WORKING = / не (работает|дают|наливают|качают)/;

  // «Очередь» on its own is the modest one the app offers first; the words for
  // a big one, and a counted one, move it.
  // «Нет очереди» in the genitive, as it is said; «92 нет, очередь» is a grade
  // that is out and a queue that is there, and must not read as «no queue».
  const NO_QUEUE = / (без очеред(и|ей)|очеред(ь|и) нет|нет очеред(и|ей)|пуст[а-я]* очеред[а-я]*)/;
  const BIG_QUEUE = / (больш[а-я]*|огромн[а-я]*|дикая|жуткая|километровая) очеред[а-я]*| очеред[а-я]* (больш[а-я]*|огромн[а-я]*)/;
  const SOME_QUEUE = / очеред[а-я]*/;
  const QUEUE_COUNT = / (\d{1,3}) (машин|авто|тачек)/;
  // A driver says the count in words as often as in figures.
  const COUNTED = {
    одна: 1, одну: 1, две: 2, двух: 2, три: 3, трех: 3, четыре: 4, четырех: 4, пять: 5, пяти: 5,
    шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, десятка: 10, пятнадцать: 15, двадцать: 20,
  };

  function gradeIn(text) {
    for (const [grade, rule] of GRADE_RULES) if (rule.test(text)) return grade;
    return null;
  }

  function countIn(text) {
    const figures = QUEUE_COUNT.exec(text);
    if (figures) return { cars: Math.min(999, Number(figures[1])), cut: figures[0] };
    for (const [word, cars] of Object.entries(COUNTED)) {
      const spoken = new RegExp(` ${word} (машин[а-я]*|авто|тачек)`).exec(text);
      if (spoken) return { cars, cut: spoken[0] };
    }
    return null;
  }

  // The queue is read first and cut out of the phrase, so that the «нет» of
  // «очереди нет» is not read as «бензина нет».
  function queueIn(text) {
    const counted = countIn(text);
    if (counted && SOME_QUEUE.test(text)) {
      return { queue: counted.cars, rest: text.replace(SOME_QUEUE, ' ').replace(counted.cut, ' ') };
    }
    if (NO_QUEUE.test(text)) return { queue: 0, rest: text.replace(NO_QUEUE, ' ') };
    if (BIG_QUEUE.test(text)) return { queue: 20, rest: text.replace(BIG_QUEUE, ' ') };
    if (SOME_QUEUE.test(text)) return { queue: 5, rest: text.replace(SOME_QUEUE, ' ') };
    return { queue: null, rest: text };
  }

  // What the driver said, as the app can act on it:
  //   kind   — 'find' (where to go), 'route' (take me there), 'mark' (what is
  //            at this station), 'unknown'
  //   grade  — AI92…DT, or null: then the app takes the driver's own grade
  //   seen   — true / false for a mark, null when only the queue was said
  //   queue  — cars in the queue, 0 for «без очереди», null when not said
  function parse(said) {
    const heard = String(said || '').trim();
    const text = tidy(heard);
    if (!text.trim()) return { kind: 'unknown', grade: null, seen: null, queue: null, heard };
    const grade = gradeIn(text);
    if (ROUTE.test(text)) return { kind: 'route', grade, seen: null, queue: null, heard };
    if (ASKING.test(text)) return { kind: 'find', grade, seen: null, queue: null, heard };
    const { queue, rest } = queueIn(text);
    const no = NOT_WORKING.test(rest) || SAYS_NO.test(rest);
    const yes = !no && SAYS_YES.test(rest);
    if (no || yes) return { kind: 'mark', grade, seen: yes, queue, heard };
    if (queue != null) return { kind: 'mark', grade, seen: null, queue, heard };
    if (ASKING_SOFTLY.test(text)) return { kind: 'find', grade, seen: null, queue: null, heard };
    return { kind: 'unknown', grade, seen: null, queue: null, heard };
  }

  // The phone's own recogniser. Chrome on Android and Safari on an iPhone both
  // have it behind the webkit name; a browser without it never sees the button.
  function engine() {
    return root.SpeechRecognition || root.webkitSpeechRecognition || null;
  }

  function supported() {
    return !!engine();
  }

  // How long to wait for the recogniser to say anything at all. On an iPhone it
  // sometimes never answers — neither a result, nor an end, nor an error — and
  // the button stayed lit with «Слушаю…» until the app was closed and opened
  // again (18 Sep 2026, the owner). After this it is stopped and said so.
  const PATIENCE_MS = 12000;
  // Распознаватель создаётся один раз и живёт, пока открыто приложение.
  let kept = null;
  let running = false;

  // One phrase, then it stops by itself. `onHeard` gets the text, `onDone` the
  // reason it ended — 'ok', 'silent', 'denied', 'broken' — so the app can say
  // something useful instead of leaving a button lit.
  function listen({ onHeard, onDone } = {}) {
    const Engine = engine();
    if (!Engine) {
      onDone?.('broken');
      return () => {};
    }
    // Один и тот же распознаватель на всё время работы приложения: iPhone
    // спрашивает разрешение на микрофон у каждого нового (19.09.2026, владелец
    // — «каждый раз просит разрешение»).
    if (!kept) {
      try {
        kept = new Engine();
      } catch (error) {
        onDone?.('broken');
        return () => {};
      }
    }
    const ears = kept;
    // Прерывать перед стартом нельзя: на iPhone это гасит и только что начатую
    // сессию. Останавливаем только то, что и правда слушает.
    if (running) {
      try { ears.abort(); } catch (error) { /* уже остановлен */ }
    }
    running = true;
    ears.lang = 'ru-RU';
    ears.interimResults = false;
    ears.maxAlternatives = 3;
    ears.continuous = false;
    let said = false;
    let ended = false;
    const stop = () => { try { ears.abort(); } catch (error) { /* already stopped */ } };
    const patience = setTimeout(() => {
      // Nothing at all came back: stop it and let the app say so.
      stop();
      done(said ? 'ok' : 'stuck');
    }, Math.max(1000, Number(root.Voice?.patience) || PATIENCE_MS));
    const done = (reason) => {
      if (ended) return;
      ended = true;
      running = false;
      clearTimeout(patience);
      onDone?.(reason);
    };
    ears.onresult = (event) => {
      const guesses = [...(event.results?.[0] || [])].map((item) => item.transcript).filter(Boolean);
      // The first guess the rules understand wins; the recogniser's own order
      // decides among equals.
      const understood = guesses.find((text) => parse(text).kind !== 'unknown');
      const text = understood || guesses[0] || '';
      if (!text) return;
      said = true;
      onHeard?.(text);
    };
    ears.onerror = (event) => {
      const code = event?.error === 'not-allowed' || event?.error === 'service-not-allowed' ? 'denied'
        : event?.error === 'no-speech' ? 'silent' : 'broken';
      done(code);
      stop();
    };
    ears.onend = () => done(said ? 'ok' : 'silent');
    try {
      ears.start();
    } catch (error) {
      done('broken');
    }
    // Stopped from the outside: the app is told at once, because an aborted
    // recogniser on an iPhone does not always call back.
    return () => { stop(); done('stopped'); };
  }

  // Said aloud, because at the wheel the answer cannot be read.
  function say(words) {
    const speaker = root.speechSynthesis;
    if (!speaker || !root.SpeechSynthesisUtterance || !words) return false;
    try {
      speaker.cancel();
      const line = new root.SpeechSynthesisUtterance(String(words));
      line.lang = 'ru-RU';
      line.rate = 1.05;
      speaker.speak(line);
      return true;
    } catch (error) {
      return false;
    }
  }

  root.Voice = { parse, listen, say, supported, patience: PATIENCE_MS };
})(typeof window !== 'undefined' ? window : globalThis);
