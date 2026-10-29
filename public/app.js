const $ = (id) => document.getElementById(id);
const log = $('log');
const input = $('input');

let ws;
let isRunning = false;
let lastMetrics = null;
// Keys pressed in the command box (dictation excluded): the number a voice-only session keeps at zero.
let keysTyped = 0;
function countKey() {
  $('m-keys').textContent = ++keysTyped;
}
let autoSendTimer = null;
let dictatedSinceSend = false;

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (m) => handle(JSON.parse(m.data));
  ws.onclose = () => {
    $('model').textContent = 'disconnected, retrying…';
    setTimeout(connect, 1500);
  };
}

function add(cls, text) {
  const el = document.createElement('div');
  el.className = `ev ${cls}`;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

// Models write a little markdown (**bold**, `code`). Show it as formatting, built from DOM nodes, never innerHTML.
function addRich(cls, text) {
  const el = add(cls, '');
  const lines = text.split('\n');
  let prose = [];
  const flush = () => {
    if (prose.length) appendInline(el, prose.join('\n'));
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const isRow = (l) => /^\s*\|.*\|\s*$/.test(l ?? '');
    // A markdown table: a row of cells, a |---| separator, then more rows.
    if (isRow(lines[i]) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? '') && lines[i + 1].includes('-')) {
      flush();
      const rows = [lines[i]];
      i += 2;
      while (isRow(lines[i])) rows.push(lines[i++]);
      i--;
      el.appendChild(table(rows));
    } else prose.push(lines[i]);
  }
  flush();
  return el;
}

function table(rows) {
  const t = document.createElement('table');
  rows.forEach((row, r) => {
    const tr = document.createElement('tr');
    for (const cell of row.trim().replace(/^\||\|$/g, '').split('|')) {
      const td = document.createElement(r === 0 ? 'th' : 'td');
      appendInline(td, cell.trim());
      tr.appendChild(td);
    }
    t.appendChild(tr);
  });
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  wrap.appendChild(t);
  return wrap;
}

// Models write a little markdown (**bold**, `code`). Show it as formatting, built from DOM nodes, never innerHTML.
function appendInline(parent, text) {
  for (const part of text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/)) {
    if (!part) continue;
    const bold = /^\*\*(.+)\*\*$/.exec(part);
    const code = /^`(.+)`$/.exec(part);
    const node = bold ? document.createElement('strong') : code ? document.createElement('code') : document.createTextNode(part);
    if (bold || code) node.textContent = (bold ?? code)[1];
    parent.appendChild(node);
  }
}

let pendingCommand = null;

function addDetails(title, status, open = false) {
  const el = document.createElement('details');
  el.className = 'ev';
  el.open = open;
  const summary = document.createElement('summary');
  summary.textContent = title;
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = status;
  summary.appendChild(badge);
  const pre = document.createElement('pre');
  el.append(summary, pre);
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return { el, badge, pre };
}

// The default browser voice sounds robotic; prefer the neural voices most systems ship.
let voice = null;
function pickVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
  const rank = (v) =>
    /natural|neural/i.test(v.name) ? 0 : /online/i.test(v.name) ? 1 : /google/i.test(v.name) ? 2 : /aria|jenny|guy|samantha|daniel/i.test(v.name) ? 3 : 9;
  voice = voices.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

function speak(text) {
  if (replaying || !$('narrate').checked || !('speechSynthesis' in window) || !text) return;
  // Speak only the prose, not trailing code or paths.
  // Tables and code are for reading, not listening.
  const prose = text.split('\n').filter((l) => !/^\s*\|/.test(l)).join('\n');
  const spoken = prose.split(/\n\s*\n|```/)[0].replace(/[*_`#]/g, '').slice(0, 400);
  const u = new SpeechSynthesisUtterance(spoken);
  if (voice) u.voice = voice;
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

function shush() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

function handle(e) {
  if (e.type === 'session') return startSession(e.session);
  if (RECORDED.has(e.type)) record(e);
  // A live event while a past session is on screen: it's saved, and shown on "Back to live".
  if (viewing && RECORDED.has(e.type)) return;
  // Any real progress means the model answered, so the busy chip goes away.
  if (['say', 'tool', 'done', 'stopped', 'error', 'plan'].includes(e.type)) $('model-status').hidden = true;
  const working = thinking.isConnected;
  dispatch(e);
  if (working && thinking.isConnected && e.type !== 'status') showThinking();
}

function dispatch(e) {
  switch (e.type) {
    case 'hello':
      $('model').textContent = e.model;
      $('workspace').textContent = e.workspace;
      if (!live || live.serverId !== e.session) startSession(e.session);
      else if (!log.childElementCount && !viewing) renderSession(live);
      setRunning(e.running);
      break;
    case 'metrics':
      lastMetrics = e;
      $('m-words').textContent = e.wordsDictated;
      $('m-instr').textContent = e.instructions;
      $('m-interrupts').textContent = e.interruptions;
      $('m-files').textContent = e.filesChanged;
      $('m-tests').textContent = e.testRuns;
      $('m-replans').textContent = e.replans ?? 0;
      $('m-prs').textContent = e.prsOpened ?? 0;
      if (e.model) $('model').textContent = e.model;
      break;
    case 'status':
      setRunning(e.running);
      break;
    case 'user':
      add(e.interrupt ? 'user interrupt' : 'user', e.text);
      // A fresh instruction starts a new task, so the re-plan banner belongs to the old one.
      if (!e.interrupt) newTask();
      break;
    case 'interrupted':
      add('notice', 'Cancelling the current step and re-planning…');
      break;
    case 'say':
      addRich('say', e.text);
      speak(e.text);
      break;
    case 'tool':
      if (e.name === 'run_command') pendingCommand = addDetails(`$ ${e.args.command}`, 'running…');
      else if (e.name !== 'edit_file' && e.name !== 'write_file') add('tool', `→ ${e.name}(${JSON.stringify(e.args)})`);
      break;
    case 'tool_result':
      if (e.name === 'run_command' && pendingCommand) {
        const code = /^Exit code (\S+)/.exec(e.preview)?.[1];
        const pass = e.ok && code === '0';
        pendingCommand.badge.textContent = e.ok ? (code ? `exit ${code}` : 'cancelled') : 'error';
        pendingCommand.badge.className = `badge ${pass ? 'pass' : 'fail'}`;
        pendingCommand.pre.textContent = e.preview;
        pendingCommand = null;
      } else if (!e.ok) add('tool fail', `✗ ${e.name}: ${e.preview}`);
      break;
    case 'file_changed': {
      const d = addDetails(e.path, e.created ? 'new file' : 'edited', true);
      d.pre.className = 'diff';
      for (const line of e.diff.split('\n')) {
        const span = document.createElement('span');
        span.className = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
        span.textContent = line + '\n';
        d.pre.appendChild(span);
      }
      break;
    }
    case 'done':
      addRich('done', e.text);
      speak(e.text);
      break;
    case 'plan':
      renderPlan(e.plan);
      break;
    case 'pull_request': {
      const el = add('pr', e.created ? '🚀 Pull request opened: ' : '🚀 Branch pushed. Open the pull request: ');
      const a = document.createElement('a');
      a.href = e.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = e.title;
      el.appendChild(a);
      break;
    }
    case 'meeting':
      renderMeeting(e);
      break;
    case 'notice':
      add('notice', e.text);
      break;
    case 'model_status':
      $('model-status').hidden = false;
      $('model-status').textContent = e.text.replace(/\.\.\.|…$/, '');
      break;
    case 'stopped':
      add('notice', 'Stopped. Waiting for your next instruction.');
      break;
    case 'error':
      add('error', e.message);
      break;
  }
}

let currentPlan = null;
// Steps dropped by a re-plan stay visible, struck through, until the next task starts.
let ghosts = [];
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function stepItem(step, extra = '') {
  const li = document.createElement('li');
  li.className = `${step.status} ${extra}`.trim();
  li.textContent = step.text;
  return li;
}

function renderPlan(plan) {
  const prev = currentPlan;
  currentPlan = plan;
  const replan = plan.replanned && prev;
  const before = new Set((prev?.steps ?? []).map((s) => norm(s.text)));
  const now = new Set(plan.steps.map((s) => norm(s.text)));
  let added = 0;
  if (replan) {
    for (const old of prev.steps) {
      if (!now.has(norm(old.text)) && old.status !== 'done' && !ghosts.some((g) => norm(g) === norm(old.text))) ghosts.push(old.text);
    }
  }
  const list = $('plan-steps');
  list.replaceChildren();
  for (const step of plan.steps) {
    const isNew = replan && !before.has(norm(step.text));
    if (isNew) added++;
    list.appendChild(stepItem(step, isNew ? 'new' : ''));
  }
  for (const text of ghosts) {
    if (!now.has(norm(text))) list.appendChild(stepItem({ text, status: 'dropped' }));
  }
  const live = plan.steps.filter((s) => s.status !== 'dropped');
  $('plan-progress').textContent = `${live.filter((s) => s.status === 'done').length}/${live.length} done`;
  $('plan-title').textContent = plan.version > 1 ? `Plan v${plan.version}` : 'Plan';
  if (plan.replanned) {
    const banner = $('plan-banner');
    banner.hidden = false;
    banner.textContent = `⚡ Re-planned after “${plan.reason}”`;
    // Restart the flash animation.
    banner.style.animation = 'none';
    void banner.offsetWidth;
    banner.style.animation = '';
    if (replan) {
      const dropped = plan.steps.filter((s) => s.status === 'dropped' && before.has(norm(s.text))).length +
        prev.steps.filter((s) => !now.has(norm(s.text)) && s.status !== 'done').length;
      add('notice', `Re-planned: ${dropped} step${dropped === 1 ? '' : 's'} dropped, ${added} added.`);
    }
  }
}

function renderMeeting(m) {
  // A cleared board (new session) goes back to the hint, not "no action items".
  if (!m.tasks.length && !m.name) {
    $('meeting-tasks').innerHTML = EMPTY.meeting;
    $('meeting-title').textContent = 'Meeting tasks';
    $('run-all').hidden = true;
    return;
  }
  const list = $('meeting-tasks');
  list.replaceChildren();
  $('meeting-title').textContent = m.name ? `Tasks from ${m.name}` : 'Meeting tasks';
  $('run-all').hidden = !m.tasks.some((t) => t.kind === 'code' && t.status === 'todo');
  if (!m.tasks.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No action items found in that meeting.';
    list.appendChild(li);
    return;
  }
  for (const t of m.tasks) {
    const li = document.createElement('li');
    li.className = `${t.kind} ${t.status}`;
    li.title = t.detail;
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = t.id;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = t.title;
    const action = document.createElement('span');
    if (t.kind === 'code' && t.status === 'todo') {
      const btn = document.createElement('button');
      btn.className = 'secondary small';
      btn.textContent = 'Run';
      btn.onclick = () => ws.send(JSON.stringify({ type: 'run_task', id: t.id }));
      action.appendChild(btn);
    } else {
      action.className = 'badge';
      action.textContent = t.status === 'running' ? 'running' : t.status === 'done' ? 'done' : 'not code';
    }
    const meta = document.createElement('span');
    meta.className = 'tmeta';
    meta.textContent = [t.owner, t.kind === 'code' ? 'code' : 'for people'].filter(Boolean).join(' · ');
    li.append(num, title, action, meta);
    list.appendChild(li);
  }
}

function sendTranscript(name, text) {
  if (!text.trim() || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'transcript', name, text }));
}

function newTask() {
  $('plan-banner').hidden = true;
  ghosts = [];
  currentPlan = null;
}

const thinking = document.createElement('div');
thinking.className = 'ev thinking';
thinking.textContent = 'Thinking';

function setRunning(running) {
  isRunning = running;
  $('status-dot').classList.toggle('running', running);
  if (viewing) return;
  if (running) showThinking();
  else thinking.remove();
}

// Keep the "Thinking…" row at the bottom of the log while the agent works.
function showThinking() {
  log.appendChild(thinking);
  log.scrollTop = log.scrollHeight;
}

function send() {
  clearTimeout(autoSendTimer);
  dictatedSinceSend = false;
  const text = input.value.trim();
  if (!text || ws.readyState !== WebSocket.OPEN) return;
  input.value = '';
  if (viewing) backToLive();
  shush();
  // A bare spoken "stop" halts the agent; anything longer is a new instruction or a barge-in.
  if (/^((ok(ay)?|hey|please|no)[,.]?\s+)?(stop|halt|cancel)((\s+(it|that|now|please|everything))|([,.!]?\s*(stop|halt)))*[.!]?$/i.test(text)) ws.send(JSON.stringify({ type: 'stop' }));
  else if (/^(recap|wrap( it)? up|show (me )?(my )?(stats|recap))[.!]?$/i.test(text)) showRecap();
  else ws.send(JSON.stringify({ type: 'command', text }));
}

input.addEventListener('input', (e) => {
  // The moment the user starts talking, the agent stops talking.
  shush();
  // Wispr Flow inserts a whole phrase at once; normal typing inserts one character.
  if ((e.data && e.data.length > 2) || e.inputType === 'insertFromPaste') dictatedSinceSend = true;
  else countKey();
  clearTimeout(autoSendTimer);
  if ($('autosend').checked && dictatedSinceSend) autoSendTimer = setTimeout(send, 1200);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    countKey();
    send();
  }
});

$('send').onclick = send;
$('stop').onclick = () => {
  shush();
  ws.send(JSON.stringify({ type: 'stop' }));
};

connect();
input.focus();

// Meeting transcripts: the Meeting button, or drop a file anywhere.
$('meeting').onclick = () => $('meeting-dialog').showModal();
$('run-all').onclick = () => ws.send(JSON.stringify({ type: 'run_task', all: true }));
$('meeting-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('meeting-text').value = await file.text();
  if (!$('meeting-name').value) $('meeting-name').value = file.name.replace(/\.[^.]+$/, '');
};
$('meeting-dialog').addEventListener('close', () => {
  if ($('meeting-dialog').returnValue === 'ok') sendTranscript($('meeting-name').value.trim(), $('meeting-text').value);
  $('meeting-text').value = '';
  $('meeting-name').value = '';
  $('meeting-file').value = '';
  input.focus();
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  $('drop-hint').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) $('drop-hint').hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-hint').hidden = true;
  const file = e.dataTransfer.files[0];
  if (file) sendTranscript(file.name.replace(/\.[^.]+$/, ''), await file.text());
});

// Session recap: a shareable card of what was done by voice.
$('recap').onclick = showRecap;
$('recap-save').onclick = () => {
  const a = document.createElement('a');
  a.download = 'flow-agent-recap.png';
  a.href = $('recap-card').toDataURL('image/png');
  a.click();
};

function showRecap() {
  const m = lastMetrics ?? {};
  const minutes = m.startedAt ? Math.max(1, Math.round((Date.now() - m.startedAt) / 60000)) : 0;
  const tiles = [
    ['words dictated', m.wordsDictated ?? 0],
    ['keys typed', keysTyped],
    ['instructions', m.instructions ?? 0],
    ['barge-ins', m.interruptions ?? 0],
    ['re-plans', m.replans ?? 0],
    ['files changed', m.filesChanged ?? 0],
    ['commands run', m.testRuns ?? 0],
    ['PRs opened', m.prsOpened ?? 0],
  ];
  drawRecap($('recap-card'), tiles, minutes);
  $('recap-dialog').showModal();
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  speak(
    `In ${plural(minutes, 'minute')} you dictated ${plural(m.wordsDictated ?? 0, 'word')}, ` +
      `interrupted me ${plural(m.interruptions ?? 0, 'time')}, changed ${plural(m.filesChanged ?? 0, 'file')} ` +
      `and opened ${plural(m.prsOpened ?? 0, 'pull request')}` +
      (keysTyped === 0 ? ', without typing a single key.' : '.'),
  );
}

function drawRecap(canvas, tiles, minutes) {
  const c = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const bg = c.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#071a0e');
  bg.addColorStop(1, '#050607');
  c.fillStyle = bg;
  c.fillRect(0, 0, W, H);
  const font = (size, weight = 400) => `${weight} ${size}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;

  c.fillStyle = '#e7e9ee';
  c.font = font(44, 700);
  c.fillText('Flow Agent session', 60, 95);
  c.fillStyle = '#8a90a0';
  c.font = font(24);
  c.fillText(`Coded by voice with Wispr Flow · ${minutes} min · ${new Date().toLocaleDateString()}`, 60, 135);

  const cols = 4, gap = 20, tw = (W - 120 - gap * (cols - 1)) / cols, th = 170;
  tiles.forEach(([label, value], i) => {
    const x = 60 + (i % cols) * (tw + gap), y = 185 + Math.floor(i / cols) * (th + gap);
    const star = label === 'keys typed' ? value === 0 : label === 'barge-ins' && value > 0;
    c.fillStyle = star ? 'rgba(34, 224, 107, 0.16)' : 'rgba(255, 255, 255, 0.05)';
    c.strokeStyle = star ? '#22e06b' : '#262a35';
    c.lineWidth = 2;
    c.beginPath();
    c.roundRect(x, y, tw, th, 16);
    c.fill();
    c.stroke();
    c.fillStyle = '#e7e9ee';
    c.font = font(72, 700);
    c.fillText(String(value), x + 26, y + 98);
    c.fillStyle = '#8a90a0';
    c.font = font(24);
    c.fillText(label, x + 26, y + 140);
  });

  c.fillStyle = '#8a90a0';
  c.font = font(20);
  c.fillText('github.com/AryanMashalkar/flow-agent  ·  #NoHandsChallenge', 60, H - 40);
}

// History: every session's conversation is kept in this browser, like a chat history.
const RECORDED = new Set(['user', 'say', 'tool', 'tool_result', 'file_changed', 'done', 'plan', 'pull_request', 'meeting', 'notice', 'stopped', 'error', 'interrupted']);
const STORE = 'flow-agent-history-v1';
const MAX_SESSIONS = 30;
const MAX_EVENTS = 500;
const EMPTY = { plan: $('plan-steps').innerHTML, meeting: $('meeting-tasks').innerHTML };
let sessions = loadSessions();
let live = null;
let viewing = null;
let replaying = false;
let saveTimer = null;

function loadSessions() {
  try {
    const data = JSON.parse(localStorage.getItem(STORE) || '[]');
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(sessions));
    } catch {
      // Storage full or blocked: drop the oldest sessions and keep going.
      sessions = sessions.slice(0, Math.max(1, Math.floor(sessions.length / 2)));
    }
  }, 300);
}

// Reopening the page continues the session the server is still running.
live = sessions[0] ?? null;

function startSession(serverId) {
  live = { id: `${serverId}-${Math.random().toString(36).slice(2, 7)}`, serverId, started: Date.now(), title: '', events: [] };
  sessions.unshift(live);
  sessions = sessions.slice(0, MAX_SESSIONS);
  viewing = null;
  $('viewing').hidden = true;
  clearView();
  saveSoon();
  renderSessions();
}

function record(e) {
  if (!live || (e.type === 'meeting' && !e.tasks.length && !e.name)) return;
  const last = live.events.findLast((x) => x.type === e.type);
  // The server re-sends the current plan and meeting on reconnect; don't store them twice.
  if ((e.type === 'plan' || e.type === 'meeting') && last && JSON.stringify(last) === JSON.stringify(e)) return;
  const copy = e.type === 'file_changed' && e.diff.length > 4000 ? { ...e, diff: `${e.diff.slice(0, 4000)}\n…` } : e;
  live.events.push(copy);
  if (live.events.length > MAX_EVENTS) live.events.shift();
  if (e.type === 'user' && !e.interrupt) {
    live.instructions = (live.instructions ?? 0) + 1;
    if (!live.title) live.title = e.text;
    renderSessions();
  }
  saveSoon();
}

function clearView() {
  log.replaceChildren();
  newTask();
  pendingCommand = null;
  $('plan-steps').innerHTML = EMPTY.plan;
  $('plan-progress').textContent = '';
  $('plan-title').textContent = 'Plan';
  $('meeting-tasks').innerHTML = EMPTY.meeting;
  $('meeting-title').textContent = 'Meeting tasks';
  $('run-all').hidden = true;
}

function renderSession(s) {
  replaying = true;
  clearView();
  for (const e of s.events) dispatch(e);
  replaying = false;
  thinking.remove();
  log.scrollTop = log.scrollHeight;
}

function viewSession(s) {
  if (s === live) return backToLive();
  viewing = s;
  $('viewing').hidden = false;
  renderSession(s);
  renderSessions();
  document.body.classList.remove('show-history');
}

function backToLive() {
  viewing = null;
  $('viewing').hidden = true;
  if (live) renderSession(live);
  setRunning(isRunning);
  renderSessions();
}

function renderSessions() {
  const list = $('sessions');
  list.replaceChildren();
  const day = (t) => new Date(t).toDateString();
  const today = day(Date.now());
  const yesterday = day(Date.now() - 86_400_000);
  let group = '';
  for (const s of sessions) {
    const g = day(s.started) === today ? 'Today' : day(s.started) === yesterday ? 'Yesterday' : 'Earlier';
    if (g !== group) {
      group = g;
      const li = document.createElement('li');
      li.className = 'group';
      li.textContent = g;
      list.appendChild(li);
    }
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = `session${s === (viewing ?? live) ? ' active' : ''}`;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = s.title || 'New session';
    title.title = s.title || '';
    const when = document.createElement('span');
    when.className = 'when';
    const n = s.instructions ?? 0;
    when.textContent = `${new Date(s.started).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${n} instruction${n === 1 ? '' : 's'}`;
    if (s === live) {
      const tag = document.createElement('span');
      tag.className = 'live';
      tag.textContent = ' · LIVE';
      when.appendChild(tag);
    }
    btn.append(title, when);
    btn.onclick = () => viewSession(s);
    li.appendChild(btn);
    list.appendChild(li);
  }
  if (!sessions.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Your sessions show up here.';
    list.appendChild(li);
  }
}

$('new-session').onclick = () => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'new_session' }));
$('back-live').onclick = backToLive;
$('clear-history').onclick = () => {
  sessions = live ? [live] : [];
  if (viewing) backToLive();
  saveSoon();
  renderSessions();
};
$('toggle-history').onclick = () => {
  if (window.matchMedia('(max-width: 1180px)').matches) document.body.classList.toggle('show-history');
  else document.body.classList.toggle('no-history');
};
renderSessions();

// The welcome screen shows until the conversation has something in it.
new MutationObserver(() => ($('welcome').hidden = log.childElementCount > 0)).observe(log, { childList: true });
for (const b of document.querySelectorAll('button.example')) {
  b.onclick = () => {
    input.value = b.textContent;
    send();
  };
}
