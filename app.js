'use strict';

// The Apps Script URL is set in config.js.

const SILENCE_MS = 1500;     // stop listening after this much silence
const NO_SPEECH_MS = 8000;   // stop if nothing is said
const MAX_RECORD_MS = 45000; // longest single answer
const MAX_TRIES = 2;         // automatic re-asks before suggesting tapping or typing

const $ = (id) => document.getElementById(id);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  survey: null,
  answers: {},     // id → { value, evidence, inferred }
  skipped: [],     // optional items the user skipped
  askedGroups: [],
  step: null,      // { title, prompt, items, group, done:Set, keyboardOnly, manual }
  tries: 0,
  busy: false,     // waiting for the AI
  starting: false, // microphone is being opened
  preferTyping: false,
  preface: '',
  responseId: '',
};

// ---------------------------------------------------------------- backend

async function readJson(res) {
  try {
    return await res.json();
  } catch (e) {
    // Apps Script answers with an HTML page when it is not deployed or not open to "Anyone"
    throw new Error('後端沒有正確回應，請確認 Apps Script 已部署，且存取權為「任何人」');
  }
}

async function getSurvey() {
  const res = await fetch(BACKEND_URL + '?action=survey');
  const data = await readJson(res);
  if (!data.ok) throw new Error(data.error || '無法載入問卷');
  return data.survey;
}

async function post(action, payload) {
  const res = await fetch(BACKEND_URL, {
    method: 'POST',
    // text/plain avoids a CORS preflight, which Apps Script does not answer
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action }, payload)),
  });
  const data = await readJson(res);
  if (!data.ok) {
    const err = new Error(data.error || '伺服器錯誤');
    err.data = data;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------- speaking

const tts = { ok: 'speechSynthesis' in window, voice: null, hasVoices: false };

function pickVoice() {
  if (!tts.ok) return;
  const voices = speechSynthesis.getVoices();
  const lang = (v) => (v.lang || '').toLowerCase().replace('_', '-');
  tts.hasVoices = voices.length > 0;
  tts.voice =
    voices.find((v) => lang(v) === 'zh-tw') ||
    voices.find((v) => /hant|tw/.test(lang(v))) ||
    voices.find((v) => lang(v).startsWith('zh')) ||
    null;
}
if (tts.ok) {
  pickVoice();
  speechSynthesis.addEventListener && speechSynthesis.addEventListener('voiceschanged', pickVoice);
}

function speak(text) {
  return new Promise((resolve) => {
    if (!tts.ok || !text) return resolve();
    pickVoice();
    if (!tts.hasVoices) return resolve(); // no voice installed: the text is on screen anyway
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-TW';
    if (tts.voice) u.voice = tts.voice;
    let started = false;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(t1);
      clearTimeout(t2);
      resolve();
    };
    u.onstart = () => { started = true; };
    u.onend = finish;
    u.onerror = finish;
    const t1 = setTimeout(() => { if (!started) finish(); }, 3000);   // never started
    const t2 = setTimeout(finish, 4000 + text.length * 350);          // end event lost
    speechSynthesis.speak(u);
  });
}

function stopSpeaking() {
  if (tts.ok) speechSynthesis.cancel();
}

// ---------------------------------------------------------------- recording

let audioCtx = null;
let recording = null; // { stop(reason) } while the microphone is open

function unlockAudio() {
  // Must run inside a tap: iPhone only allows sound and speech after a user gesture.
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (tts.ok) {
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  }
}

async function record(onLevel, onOpen) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  const source = audioCtx.createMediaStreamSource(stream);
  const proc = audioCtx.createScriptProcessor(4096, 1, 1);
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  const chunks = [];
  const t0 = performance.now();
  let lastVoice = t0;
  let heard = false;
  let floor = 0;
  let frames = 0;

  return new Promise((resolve) => {
    let ended = false;
    const stop = (reason) => {
      if (ended) return;
      ended = true;
      proc.onaudioprocess = null;
      try { source.disconnect(); proc.disconnect(); mute.disconnect(); } catch (e) { /* ignore */ }
      stream.getTracks().forEach((t) => t.stop());
      recording = null;
      resolve({ reason, heard, rate: audioCtx.sampleRate, samples: concat(chunks) });
    };
    recording = { stop };
    proc.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(data));
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      frames++;
      if (frames <= 3) floor = Math.max(floor, Math.min(rms, 0.05)); // background noise
      const threshold = Math.max(0.02, floor * 2.5);
      const now = performance.now();
      if (onLevel) onLevel(Math.min(1, rms / 0.15));
      if (frames > 3 && rms > threshold) { heard = true; lastVoice = now; }
      if (heard && now - lastVoice > SILENCE_MS) stop('silence');
      else if (!heard && now - t0 > NO_SPEECH_MS) stop('no_speech');
      else if (now - t0 > MAX_RECORD_MS) stop('max');
    };
    source.connect(proc);
    proc.connect(mute);
    mute.connect(audioCtx.destination);
    // last, so a stop() from onOpen also disconnects everything wired above
    if (onOpen) onOpen();
  });
}

function concat(chunks) {
  let n = 0;
  chunks.forEach((c) => { n += c.length; });
  const out = new Float32Array(n);
  let o = 0;
  chunks.forEach((c) => { out.set(c, o); o += c.length; });
  return out;
}

/** 16 kHz mono 16-bit WAV: small, and accepted by Gemini as audio/wav. */
function wav16k(samples, rate) {
  const target = 16000;
  const ratio = rate / target;
  const n = Math.floor(samples.length / ratio);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.min(samples.length, Math.floor((i + 1) * ratio)));
    let s = 0;
    for (let j = start; j < end; j++) s += samples[j];
    const v = Math.max(-1, Math.min(1, s / (end - start)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, target, true); dv.setUint32(28, target * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return buf;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------------------------------------------------------- answers

function recordAnswer(id, value, evidence, inferred) {
  const item = surveyItem(state.survey, id);
  if (!item) return false;
  const n = surveyNormalize(item, value);
  if (n.error) return false;
  state.answers[id] = { value: n.value, evidence: evidence || '', inferred: !!inferred };
  state.skipped = state.skipped.filter((x) => x !== id);
  state.answers = surveyClean(state.survey, state.answers);
  if (state.step) state.step.done.add(id);
  return true;
}

function stepRemaining() {
  const step = state.step;
  return step.items.filter((it) => !step.done.has(it.id) && surveyApplies(it, state.answers));
}

function label(item) {
  return item.group ? item.question : (item.column || item.question).replace(/\(.*\)$/, '');
}

// ---------------------------------------------------------------- screens

function show(name) {
  ['start', 'ask', 'review', 'done'].forEach((s) => { $('screen-' + s).hidden = s !== name; });
  window.scrollTo(0, 0);
}

function setStatus(text, warn) {
  $('status').textContent = text || '';
  $('status').classList.toggle('warn', !!warn);
}

function setMic(mode) {
  const mic = $('mic');
  mic.classList.toggle('listening', mode === 'listening');
  mic.classList.toggle('thinking', mode === 'thinking');
  if (mode !== 'listening') mic.style.setProperty('--level', 0);
}

function progress() {
  const S = state.survey;
  const applicable = S.items.filter((it) => surveyApplies(it, state.answers));
  const done = applicable.filter((it) => state.answers[it.id] || state.skipped.includes(it.id)).length;
  $('progress-bar').style.width = Math.round((100 * done) / applicable.length) + '%';
}

function chip(text, pressed, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = text;
  b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  b.onclick = onClick;
  return b;
}

function renderStep(step) {
  $('q-title').textContent = step.title;
  const body = $('q-body');
  body.innerHTML = '';
  const hints = step.items.map((it) => it.hint).filter(Boolean);
  $('q-hint').hidden = !hints.length;
  $('q-hint').textContent = hints.join(' ');

  if (step.group) {
    step.items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'group-item';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = it.question;
      const chips = document.createElement('div');
      chips.className = 'chips';
      it.options.forEach((o) => {
        const c = chip(o, state.answers[it.id] && state.answers[it.id].value === o, () => onGroupChip(it, o, chips, c));
        if (o.indexOf('非常') === 0) {
          // break 「非常不滿意」 as 非常 / 不滿意 on narrow screens
          c.textContent = '非常';
          c.appendChild(document.createElement('wbr'));
          c.appendChild(document.createTextNode(o.slice(2)));
        }
        chips.appendChild(c);
      });
      row.append(name, chips);
      body.appendChild(row);
    });
  } else {
    const it = step.items[0];
    if (it.options) {
      const chips = document.createElement('div');
      chips.className = 'chips';
      const current = state.answers[it.id] ? state.answers[it.id].value.split('、') : [];
      it.options.forEach((o) => {
        const c = chip(o, current.includes(o), () => onChip(it, o, c));
        chips.appendChild(c);
      });
      body.appendChild(chips);
    }
  }

  const allOptional = step.items.every((it) => !it.required);
  $('btn-skip').hidden = !allOptional;
  $('btn-next').hidden = true;
  $('dock').hidden = !!step.keyboardOnly;
  $('alt').open = !!step.keyboardOnly || state.preferTyping || step.items.some((it) => it.prefer_typing);
  $('typed').value = '';
  $('typed').placeholder = step.keyboardOnly ? '請輸入' : '輸入你的回答';
  $('say').textContent = step.prompt || '';
  $('heard').textContent = '';
  $('recorded').innerHTML = '';
  setStatus('');
  setMic('idle');
}

function showRecorded(ids) {
  const list = $('recorded');
  ids.forEach((id) => {
    const it = surveyItem(state.survey, id);
    const a = state.answers[id];
    if (!it || !a) return;
    const li = document.createElement('li');
    const left = document.createElement('span');
    left.textContent = '✓ ' + label(it) + '：' + a.value;
    li.appendChild(left);
    if (a.inferred) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'AI 推斷';
      li.appendChild(tag);
    }
    list.appendChild(li);
  });
}

// ---------------------------------------------------------------- flow

function buildStep(item, single) {
  const S = state.survey;
  if (!single && item.group && !state.askedGroups.includes(item.group)) {
    const g = S.groups[item.group];
    const items = S.items.filter((it) => it.group === item.group && !state.answers[it.id] && surveyApplies(it, state.answers));
    return { title: g.title, prompt: g.speak || g.title, items, group: item.group, done: new Set() };
  }
  const prefix = item.group ? S.groups[item.group].title + '：' : '';
  const prompt = item.speak || (item.group ? '那「' + item.question + '」呢？從非常不滿意到非常滿意，你覺得如何？' : item.question);
  return {
    title: prefix + item.question,
    prompt: item.input === 'keyboard' ? '' : prompt,
    items: [item],
    done: new Set(),
    keyboardOnly: item.input === 'keyboard',
  };
}

async function nextStep() {
  state.answers = surveyClean(state.survey, state.answers);
  const item = surveyNext(state.survey, state.answers, state.skipped);
  if (!item) return showReview();
  return askStep(buildStep(item, false));
}

async function askStep(step) {
  cancelListening();
  if (step.group) state.askedGroups.push(step.group);
  state.step = step;
  state.tries = 0;
  renderStep(step);
  show('ask');
  progress();
  if (step.keyboardOnly) { $('typed').focus(); return; }
  const text = (state.preface ? state.preface + ' ' : '') + step.prompt;
  state.preface = '';
  await speak(text);
  if (state.step === step && !step.manual) listen();
  else if (state.step === step) setStatus('');
}

async function listen() {
  if (state.busy || recording || state.starting) return;
  const step = state.step;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('這個瀏覽器不能用麥克風，請點選或打字回答', true);
    $('alt').open = true;
    return;
  }
  stopSpeaking();
  state.starting = true;
  setMic('listening');
  setStatus('🎙️ 請說…（說完停一下就好）');
  let rec;
  try {
    rec = await record(
      (lvl) => $('mic').style.setProperty('--level', lvl.toFixed(2)),
      () => {
        state.starting = false;
        // the user moved on (tapped an option, typed) while the microphone was opening
        if (state.step !== step || step.manual) recording.stop('cancel');
      }
    );
  } catch (e) {
    state.starting = false;
    setMic('idle');
    setStatus('無法使用麥克風。請允許麥克風權限，或改用點選、打字回答。', true);
    $('alt').open = true;
    return;
  }
  setMic('idle');
  if (state.step !== step || rec.reason === 'cancel') return;
  setStatus('');
  if (!rec.heard) {
    setStatus('沒有聽到聲音，按麥克風再說一次', true);
    return;
  }
  await interpret({ audio: toBase64(wav16k(rec.samples, rec.rate)) });
}

function cancelListening() {
  if (recording) recording.stop('cancel');
  stopSpeaking();
}

async function interpret(input) {
  const step = state.step;
  state.busy = true;
  setMic('thinking');
  setStatus('理解中…');
  let res;
  try {
    res = await post('interpret', { input, current: step.items.map((i) => i.id), answers: state.answers });
  } catch (e) {
    state.busy = false;
    setMic('idle');
    setStatus('連線有問題，請按麥克風再試一次（' + e.message + '）', true);
    return;
  }
  state.busy = false;
  setMic('idle');
  if (state.step !== step) return;

  $('heard').textContent = res.transcript ? '你說：「' + res.transcript + '」' : '';
  const ids = [];
  res.answers
    .slice()
    .sort((a, b) => surveyIndex(state.survey, a.item_id) - surveyIndex(state.survey, b.item_id))
    .forEach((a) => { if (recordAnswer(a.item_id, a.value, a.evidence, a.inferred)) ids.push(a.item_id); });
  if (res.skip_current) {
    step.items.forEach((it) => {
      if (!it.required && !step.done.has(it.id)) { state.skipped.push(it.id); step.done.add(it.id); }
    });
  }
  showRecorded(ids);
  progress();

  const left = stepRemaining();
  if (!left.length) {
    setStatus('好的，收到！');
    await pause(1200);
    if (state.step === step) nextStep();
    return;
  }
  if (step.group && left.length < step.items.length) {
    // part of the group was answered: ask the rest one by one
    await pause(1000);
    if (state.step === step) nextStep();
    return;
  }

  state.tries++;
  if (state.tries > MAX_TRIES) {
    setStatus('可以直接點選上面的選項，或改用打字回答', true);
    $('alt').open = true;
    return;
  }
  const first = left[0];
  const ask = res.follow_up ||
    ('不好意思，我沒聽清楚。' + (first.options && first.options.length <= 5
      ? '可以從' + first.options.join('、') + '裡選一個嗎？'
      : '可以再說一次嗎？'));
  $('say').textContent = ask;
  setStatus('');
  await speak(ask);
  if (state.step === step && !step.manual) listen();
}

// ---------------------------------------------------------------- taps & typing

async function onChip(item, option, el) {
  const step = state.step;
  step.manual = true;
  cancelListening();
  if (item.type === 'multi') {
    el.setAttribute('aria-pressed', el.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    const picked = [...$('q-body').querySelectorAll('.chip[aria-pressed=true]')].map((c) => c.textContent);
    // keep any 「其他：…」 the user said earlier: it has no chip to tap
    const others = state.answers[item.id] ? state.answers[item.id].value.split('、').filter((v) => v.indexOf('其他：') === 0) : [];
    const all = picked.concat(others);
    $('btn-next').hidden = !all.length;
    $('btn-next').textContent = '確定';
    $('btn-next').onclick = () => {
      recordAnswer(item.id, all.join('、'), '點選', false);
      nextStep();
    };
    return;
  }
  [...el.parentElement.children].forEach((c) => c.setAttribute('aria-pressed', c === el ? 'true' : 'false'));
  if (recordAnswer(item.id, option, '點選', false)) {
    showRecorded([item.id]);
    await pause(500);
    if (state.step === step) nextStep();
  }
}

async function onGroupChip(item, option, row, el) {
  const step = state.step;
  step.manual = true;
  cancelListening();
  [...row.children].forEach((c) => c.setAttribute('aria-pressed', c === el ? 'true' : 'false'));
  recordAnswer(item.id, option, '點選', false);
  progress();
  if (!stepRemaining().length) {
    await pause(500);
    if (state.step === step) nextStep();
  }
}

async function onTyped() {
  const text = $('typed').value.trim();
  if (!text || state.busy) return;
  const step = state.step;
  step.manual = true;
  state.preferTyping = true; // keep the typing box open on the next questions
  cancelListening();
  $('typed').value = '';
  if (step.items.length === 1 && step.items[0].type === 'text') {
    // free text (e.g. version numbers): keep exactly what was typed
    recordAnswer(step.items[0].id, text, '打字輸入', false);
    showRecorded([step.items[0].id]);
    await pause(600);
    if (state.step === step) nextStep();
    return;
  }
  await interpret({ text });
}

function onSkip() {
  const step = state.step;
  cancelListening();
  step.items.forEach((it) => {
    if (!it.required && !state.answers[it.id] && !state.skipped.includes(it.id)) state.skipped.push(it.id);
  });
  nextStep();
}

// ---------------------------------------------------------------- review & submit

function showReview() {
  cancelListening();
  state.step = null;
  const S = state.survey;
  const list = $('review');
  list.innerHTML = '';
  surveyOrdered(S).forEach((it) => {
    if (!surveyApplies(it, state.answers)) return;
    const a = state.answers[it.id];
    if (!a && !state.skipped.includes(it.id)) return;
    const li = document.createElement('li');
    const q = document.createElement('div');
    q.className = 'q';
    q.textContent = it.group ? S.groups[it.group].title.replace(/^請針對以下 /, '').replace(/進行評分$/, '') + '：' + it.question : it.question;
    const v = document.createElement('div');
    v.className = 'v';
    v.textContent = a ? a.value : '（略過）';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '修改';
    b.onclick = () => askStep(buildStep(it, true));
    li.append(q, v, b);
    list.appendChild(li);
  });
  $('btn-submit').disabled = false;
  $('submit-error').textContent = '';
  show('review');
  speak('都問完了，請看一下畫面上的回答，沒問題就按送出。');
}

async function submit() {
  $('btn-submit').disabled = true;
  $('submit-error').textContent = '';
  stopSpeaking();
  try {
    const res = await post('submit', { response_id: state.responseId, answers: state.answers });
    $('done-id').textContent = res.response_id;
    show('done');
    speak('謝謝你的回饋！');
  } catch (e) {
    const missing = e.data && e.data.missing ? '還沒回答：' + e.data.missing.join('、') : e.message;
    $('submit-error').textContent = '送出失敗：' + missing;
    $('btn-submit').disabled = false;
  }
}

// ---------------------------------------------------------------- start

function detectOS() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  return null;
}

function makeId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function start() {
  const emp = $('emp').value.trim();
  if (!emp) {
    $('start-error').textContent = '請先輸入工號';
    $('emp').focus();
    return;
  }
  unlockAudio(); // inside the tap, so iPhone allows sound
  state.responseId = makeId();
  state.answers = {};
  state.skipped = [];
  state.askedGroups = [];
  recordAnswer('employee_id', emp, '手動輸入', false);
  const os = detectOS();
  if (os) recordAnswer('os', os, '瀏覽器自動偵測', false);
  state.preface = state.survey.greeting || '';
  nextStep();
}

async function init() {
  $('btn-start').onclick = start;
  $('mic').onclick = () => {
    if (state.busy) return;
    if (recording) { recording.stop('manual'); return; }
    if (state.step) state.step.manual = false;
    listen();
  };
  $('btn-typed').onclick = onTyped;
  $('typed').addEventListener('keydown', (e) => { if (e.key === 'Enter') onTyped(); });
  $('typed').addEventListener('focus', () => {
    // the user is typing: stop listening so their keyboard taps are not sent as an answer
    if (state.step) state.step.manual = true;
    cancelListening();
    if (!state.busy) setStatus('');
  });
  $('btn-skip').onclick = onSkip;
  $('btn-submit').onclick = submit;

  if (BACKEND_URL.indexOf('PASTE_') === 0) {
    $('start-error').textContent = '尚未設定後端網址：請在 config.js 填入 Apps Script 網址。';
    $('btn-start').textContent = '無法開始';
    return;
  }
  try {
    state.survey = await getSurvey();
  } catch (e) {
    $('start-error').textContent = '無法載入問卷：' + e.message;
    $('btn-start').textContent = '無法開始';
    return;
  }
  $('title').textContent = state.survey.title;
  $('intro').textContent = state.survey.intro || '';
  document.title = state.survey.title;
  $('btn-start').disabled = false;
  $('btn-start').textContent = '開始';
}

init();
