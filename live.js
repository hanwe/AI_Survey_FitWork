'use strict';

// The Apps Script URL is set in config.js.

// Turn this on if, on phones without headphones, the AI keeps hearing its own voice and
// stopping mid-sentence. The user then cannot interrupt the AI while it is talking.
const MUTE_MIC_WHILE_AI_SPEAKS = false;
const MAX_RECONNECTS = 3;

const $ = (id) => document.getElementById(id);

const state = {
  survey: null,
  answers: {},      // id → { value, evidence, inferred }
  skipped: [],
  responseId: '',
  token: '',
  wsUrl: '',
  setup: null,
  ws: null,
  ready: false,     // setup finished, audio can flow
  started: false,   // first greeting requested
  resumed: false,   // a fresh conversation that continues an earlier one
  resumeHandle: null,
  reconnects: 0,
  moveSoon: false,  // Google asked us to move to a new connection
  wakeLock: null,
  ended: false,
  muted: false,
  aiSpeaking: false,
  reviewing: false,
};

// ---------------------------------------------------------------- backend (Apps Script)

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
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids a CORS preflight
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

// ---------------------------------------------------------------- microphone → Gemini (16 kHz PCM)

let ctx = null;
let mic = null;
let rsPos = 0; // resampler position carried between chunks

function unlockAudio() {
  // must run inside a tap: iPhone only allows sound after a user gesture
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
}

async function startMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  if (ctx.state === 'suspended') await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  proc.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const level = Math.min(1, Math.sqrt(sum / data.length) / 0.12);
    if (!state.muted) $('mic').style.setProperty('--level', level.toFixed(2));
    if (state.muted || !state.ready || (MUTE_MIC_WHILE_AI_SPEAKS && state.aiSpeaking)) {
      rsPos = 0;
      return;
    }
    const pcm = to16k(data, ctx.sampleRate);
    if (pcm.length) send({ realtimeInput: { audio: { data: toBase64(pcm.buffer), mimeType: 'audio/pcm;rate=16000' } } });
  };
  source.connect(proc);
  proc.connect(sink);
  sink.connect(ctx.destination);
  mic = { stream, source, proc, sink };
}

function stopMic() {
  if (!mic) return;
  mic.proc.onaudioprocess = null;
  try { mic.source.disconnect(); mic.proc.disconnect(); mic.sink.disconnect(); } catch (e) { /* ignore */ }
  mic.stream.getTracks().forEach((t) => t.stop());
  mic = null;
}

function to16k(input, rate) {
  const ratio = rate / 16000;
  const out = [];
  while (rsPos < input.length) {
    const a = Math.floor(rsPos);
    const b = Math.min(input.length, Math.max(a + 1, Math.floor(rsPos + ratio)));
    let s = 0;
    for (let j = a; j < b; j++) s += input[j];
    out.push(s / (b - a));
    rsPos += ratio;
  }
  rsPos -= input.length;
  const pcm = new Int16Array(out.length);
  for (let i = 0; i < out.length; i++) {
    const v = Math.max(-1, Math.min(1, out[i]));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return pcm;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------------------------------------------------------- Gemini voice → speaker (24 kHz PCM)

let playHead = 0;
const playing = new Set();

function playChunk(b64, rate) {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const f32 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 0x8000) v -= 0x10000;
    f32[i] = v / 32768;
  }
  if (!n) return;
  const buf = ctx.createBuffer(1, n, rate);
  buf.getChannelData(0).set(f32);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const t = Math.max(ctx.currentTime + 0.05, playHead);
  src.start(t);
  playHead = t + buf.duration;
  playing.add(src);
  src.onended = () => {
    playing.delete(src);
    if (!playing.size) setAiSpeaking(false);
  };
  setAiSpeaking(true);
}

function stopPlayback() {
  playing.forEach((s) => { try { s.onended = null; s.stop(); } catch (e) { /* ignore */ } });
  playing.clear();
  playHead = 0;
  setAiSpeaking(false);
}

function rateOf(mime) {
  const m = /rate=(\d+)/.exec(mime || '');
  return m ? Number(m[1]) : 24000;
}

// ---------------------------------------------------------------- live connection

function send(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

const decoder = new TextDecoder();

function connect(handle) {
  state.ready = false;
  $('btn-reconnect').hidden = true;
  const ws = new WebSocket(state.wsUrl + '?access_token=' + encodeURIComponent(state.token));
  // ArrayBuffer (not Blob) so messages are read in order: voice chunks must play in sequence
  ws.binaryType = 'arraybuffer';
  state.ws = ws;
  ws.onopen = () => {
    const setup = JSON.parse(JSON.stringify(state.setup));
    if (handle) setup.sessionResumption = { handle };
    ws.send(JSON.stringify({ setup }));
  };
  ws.onmessage = (ev) => {
    if (ws !== state.ws) return;
    const text = typeof ev.data === 'string' ? ev.data : decoder.decode(ev.data);
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    onServer(msg);
  };
  ws.onclose = (ev) => {
    if (ws !== state.ws) return;
    state.ready = false;
    if (state.ended) return;
    stopPlayback();
    if (state.resumeHandle && state.reconnects < MAX_RECONNECTS) {
      state.reconnects++;
      setStatus('重新連線中…');
      setTimeout(() => { if (!state.ended && state.ws === ws) connect(state.resumeHandle); }, 600);
      return;
    }
    setStatus('連線中斷' + (ev.reason ? '：' + ev.reason : ''), true);
    notice('連線中斷了。已記錄的回答都還在，按「重新連線」可以接著回答。');
    $('btn-reconnect').hidden = false;
  };
}

/** Move to a new connection and continue the same conversation (Google renews connections). */
function moveConnection() {
  if (!state.moveSoon || state.ended || !state.resumeHandle) return;
  state.moveSoon = false;
  const old = state.ws;
  state.ws = null; // so the old connection's close is ignored
  try { old.close(); } catch (e) { /* ignore */ }
  connect(state.resumeHandle);
}

function seconds(duration) {
  const m = /^([\d.]+)s$/.exec(String(duration || ''));
  return m ? Number(m[1]) : 5;
}

/** A brand-new conversation that continues from the answers already on this phone. */
async function restart() {
  const btn = $('btn-reconnect');
  btn.disabled = true;
  setStatus('重新連線中…');
  try {
    const t = await post('live_token', {});
    state.token = t.token;
    state.wsUrl = t.ws_url;
    state.setup = t.setup;
    state.started = false;
    state.resumed = true;
    state.resumeHandle = null;
    state.reconnects = 0;
    connect(null);
  } catch (e) {
    setStatus('無法連線：' + e.message, true);
  }
  btn.disabled = false;
}

function onServer(msg) {
  if (msg.setupComplete) {
    state.ready = true;
    state.reconnects = 0;
    if (!state.started) {
      state.started = true;
      const text = state.resumed
        ? '（系統訊息：連線重新開始了，使用者已經回答了一部分題目。請呼叫 get_remaining_items，簡短說明我們接著問，然後問下一題。）'
        : '（系統訊息：使用者已準備好，工號已填寫。請先呼叫 get_remaining_items，再打招呼並開始問第一題。）';
      send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
    } else {
      notice('已重新連線');
    }
    updateStatus();
  }

  if (msg.sessionResumptionUpdate) {
    const u = msg.sessionResumptionUpdate;
    if (u.newHandle && u.resumable !== false) state.resumeHandle = u.newHandle;
  }

  if (msg.goAway && !state.ended) {
    // Google will close this connection soon. Move when the AI finishes its turn,
    // or just before the deadline, so we don't cut a sentence or an answer in half.
    state.moveSoon = true;
    const ms = seconds(msg.goAway.timeLeft) * 1000;
    setTimeout(moveConnection, Math.max(0, ms - 1500));
    if (!state.aiSpeaking && ms <= 3000) moveConnection();
  }

  const sc = msg.serverContent;
  if (sc) {
    if (sc.interrupted) {
      stopPlayback(); // the user started talking: stop the AI's voice right away
      aiBubble = null;
    }
    if (sc.inputTranscription && sc.inputTranscription.text) userSays(sc.inputTranscription.text);
    if (sc.outputTranscription && sc.outputTranscription.text) aiSays(sc.outputTranscription.text);
    const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
    parts.forEach((p) => {
      if (p.inlineData && p.inlineData.data && /^audio\/pcm/.test(p.inlineData.mimeType || 'audio/pcm')) {
        playChunk(p.inlineData.data, rateOf(p.inlineData.mimeType));
      }
    });
    if (sc.turnComplete) aiBubble = null;
  }

  if (msg.toolCall) {
    const responses = (msg.toolCall.functionCalls || []).map((fc) => {
      let result;
      try { result = runTool(fc.name, fc.args || {}); } catch (e) { result = { ok: false, error: String(e.message || e) }; }
      return { id: fc.id, name: fc.name, response: result };
    });
    send({ toolResponse: { functionResponses: responses } });
  }

  if (sc && sc.turnComplete && state.moveSoon) moveConnection();
}

// ---------------------------------------------------------------- tools the AI calls (run here, on the phone)

function runTool(name, args) {
  if (name === 'get_remaining_items') return remaining();
  if (name === 'record_answer') return toolRecord(args);
  if (name === 'skip_item') return toolSkip(args);
  if (name === 'show_review') return toolReview();
  return { ok: false, error: 'unknown tool: ' + name };
}

function publicItem(it) {
  const out = { id: it.id, question: it.question, type: it.type, required: !!it.required };
  if (it.options) out.options = it.options;
  if (it.allow_other) out.allow_other = true;
  if (it.hint) out.hint = it.hint;
  if (it.speak) out.suggested_wording = it.speak;
  return out;
}

function remaining() {
  const S = state.survey;
  const next = surveyNext(S, state.answers, state.skipped);
  const res = { next: null, required_left: surveyMissingRequired(S, state.answers).map((i) => i.id) };
  if (next) {
    res.next = publicItem(next);
    if (next.group) {
      const g = S.groups[next.group];
      res.next.group = {
        title: g.title,
        suggested_wording: g.speak,
        unanswered_item_ids: S.items
          .filter((i) => i.group === next.group && !state.answers[i.id] && !state.skipped.includes(i.id))
          .map((i) => i.id),
      };
    }
  }
  return res;
}

function toolRecord(a) {
  const S = state.survey;
  const item = surveyItem(S, a.item_id);
  if (!item || item.input === 'keyboard') return { ok: false, error: 'unknown item_id: ' + a.item_id };
  if (!surveyApplies(item, state.answers)) {
    return { ok: false, error: 'this item only applies when ' + item.show_if.item + ' is 「' + item.show_if.equals + '」' };
  }
  const n = surveyNormalize(item, a.value);
  if (n.error) {
    const r = { ok: false, error: n.error };
    if (item.options) r.options = item.options;
    return r;
  }
  state.answers[item.id] = { value: n.value, evidence: String(a.evidence || ''), inferred: !!a.inferred };
  state.skipped = state.skipped.filter((x) => x !== item.id);
  state.answers = surveyClean(S, state.answers);
  savedChip(item, n.value, !!a.inferred);
  progress();
  if (state.reviewing) renderReview();
  const r = { ok: true, saved: { item: item.question, value: n.value } };
  if (n.other) r.note = 'Saved as 其他. If what the user said matches one of the options, record that option instead.';
  if (a.inferred) r.next_step = 'You inferred this value: confirm it with the user in one short sentence.';
  return r;
}

function toolSkip(a) {
  const item = surveyItem(state.survey, a.item_id);
  if (!item) return { ok: false, error: 'unknown item_id: ' + a.item_id };
  if (item.required) return { ok: false, error: 'required items cannot be skipped: ask again in a simpler way' };
  if (!state.skipped.includes(item.id)) state.skipped.push(item.id);
  progress();
  return { ok: true };
}

function toolReview() {
  const missing = surveyMissingRequired(state.survey, state.answers);
  if (missing.length) return { ok: false, error: 'required items are still missing', missing: missing.map((i) => i.id) };
  showReview();
  return { ok: true, shown_on_screen: true };
}

// ---------------------------------------------------------------- screen

function show(name) {
  ['start', 'talk', 'review', 'done'].forEach((s) => { $('screen-' + s).hidden = s !== name; });
  window.scrollTo(0, name === 'talk' ? document.body.scrollHeight : 0);
}

function setStatus(text, warn) {
  $('status').textContent = text || '';
  $('status').classList.toggle('warn', !!warn);
}

function setAiSpeaking(v) {
  if (state.aiSpeaking === v) return;
  state.aiSpeaking = v;
  updateStatus();
}

function updateStatus() {
  const m = $('mic');
  m.classList.toggle('muted', state.muted);
  m.classList.toggle('ai', !state.muted && state.aiSpeaking);
  m.classList.toggle('on', !state.muted && !state.aiSpeaking);
  if (state.muted) m.style.setProperty('--level', 0);
  if (!state.ready || state.ended) return;
  if (state.muted) setStatus('麥克風已關閉，點一下打開');
  else if (state.aiSpeaking) setStatus(MUTE_MIC_WHILE_AI_SPEAKS ? 'AI 說話中…' : 'AI 說話中（可以直接插話）');
  else setStatus('正在聽你說…');
}

function progress() {
  const S = state.survey;
  const applicable = S.items.filter((it) => surveyApplies(it, state.answers));
  const done = applicable.filter((it) => state.answers[it.id] || state.skipped.includes(it.id)).length;
  $('progress-bar').style.width = Math.round((100 * done) / applicable.length) + '%';
  $('progress-text').textContent = '查看回答 ' + done + ' / ' + applicable.length;
}

let userBubble = null;
let aiBubble = null;

function scrollDown() {
  if (!$('screen-talk').hidden) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

function bubble(cls) {
  const d = document.createElement('div');
  d.className = 'bubble ' + cls;
  $('chat').appendChild(d);
  return d;
}

function userSays(text) {
  aiBubble = null;
  if (!userBubble) userBubble = bubble('user');
  userBubble.textContent += text;
  scrollDown();
}

function aiSays(text) {
  userBubble = null;
  if (!aiBubble) aiBubble = bubble('ai');
  aiBubble.textContent += text;
  scrollDown();
}

function notice(text) {
  const d = document.createElement('div');
  d.className = 'notice';
  d.textContent = text;
  $('chat').appendChild(d);
  aiBubble = null;
  userBubble = null;
  scrollDown();
}

function label(item) {
  return item.group ? item.question : (item.column || item.question).replace(/\(.*\)$/, '');
}

function savedChip(item, value, inferred) {
  const d = document.createElement('div');
  d.className = 'saved';
  const s = document.createElement('span');
  s.textContent = '✓ ' + label(item) + '：' + value;
  d.appendChild(s);
  if (inferred) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.textContent = 'AI 推斷';
    d.appendChild(t);
  }
  $('chat').appendChild(d);
  aiBubble = null;
  userBubble = null;
  scrollDown();
}

function renderReview() {
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
    q.textContent = it.group ? 'FitWork APP 使用體驗：' + it.question : it.question;
    const v = document.createElement('div');
    v.className = 'v';
    v.textContent = a ? a.value : '（略過）';
    li.append(q, v);
    list.appendChild(li);
  });
}

function showReview() {
  state.reviewing = true;
  renderReview();
  $('btn-submit').disabled = false;
  $('submit-error').textContent = '';
  show('review');
}

// ---------------------------------------------------------------- submit

async function submit() {
  const missing = surveyMissingRequired(state.survey, state.answers);
  if (missing.length) {
    $('submit-error').textContent = '還沒回答：' + missing.map((i) => i.question).join('、');
    return;
  }
  $('btn-submit').disabled = true;
  $('submit-error').textContent = '';
  try {
    const res = await post('submit', { response_id: state.responseId, answers: state.answers });
    endSession();
    $('done-id').textContent = res.response_id;
    show('done');
  } catch (e) {
    const m = e.data && e.data.missing ? '還沒回答：' + e.data.missing.join('、') : e.message;
    $('submit-error').textContent = '送出失敗：' + m;
    $('btn-submit').disabled = false;
  }
}

function endSession() {
  state.ended = true;
  stopMic();
  stopPlayback();
  if (state.ws) { try { state.ws.close(); } catch (e) { /* ignore */ } }
  if (state.wakeLock) state.wakeLock.release().catch(() => {});
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

async function start() {
  const emp = $('emp').value.trim();
  if (!emp) {
    $('start-error').textContent = '請先輸入工號';
    $('emp').focus();
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.WebSocket) {
    $('start-error').textContent = '這個瀏覽器不能用麥克風，請用 Safari 或 Chrome 開啟，或改用一題一題的版本。';
    return;
  }
  unlockAudio(); // inside the tap
  const btn = $('btn-start');
  btn.disabled = true;
  btn.textContent = '準備中…';
  $('start-error').textContent = '';

  state.responseId = makeId();
  state.answers = {};
  state.skipped = [];
  const emp_item = surveyItem(state.survey, 'employee_id');
  state.answers.employee_id = { value: surveyNormalize(emp_item, emp).value, evidence: '手動輸入', inferred: false };
  const os = detectOS();
  if (os) state.answers.os = { value: os, evidence: '瀏覽器自動偵測', inferred: false };

  try {
    await startMic(); // asks for microphone permission
  } catch (e) {
    $('start-error').textContent = '無法使用麥克風。請允許麥克風權限後再試一次。';
    btn.disabled = false;
    btn.textContent = '開始對話';
    return;
  }
  try {
    const t = await post('live_token', {});
    state.token = t.token;
    state.wsUrl = t.ws_url;
    state.setup = t.setup;
  } catch (e) {
    stopMic();
    $('start-error').textContent = '無法連線：' + e.message;
    btn.disabled = false;
    btn.textContent = '開始對話';
    return;
  }
  try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* not supported: fine */ }
  show('talk');
  progress();
  setStatus('連線中…');
  connect(null);
}

async function init() {
  $('btn-start').onclick = start;
  $('btn-submit').onclick = submit;
  $('btn-back').onclick = () => { state.reviewing = false; show('talk'); };
  $('progress-text').onclick = showReview;
  $('btn-reconnect').onclick = restart;
  $('mic').onclick = () => {
    if (!state.started || state.ended) return;
    state.muted = !state.muted;
    if (state.muted) send({ realtimeInput: { audioStreamEnd: true } });
    updateStatus();
  };

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
  $('btn-start').textContent = '開始對話';
}

init();
