const $ = (id) => document.getElementById(id);
const log = $('log');
const input = $('input');

let ws;
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

function speak(text) {
  if (!$('narrate').checked || !('speechSynthesis' in window) || !text) return;
  // Speak only the prose, not trailing code or paths.
  const spoken = text.split(/\n\s*\n|```/)[0].slice(0, 400);
  const u = new SpeechSynthesisUtterance(spoken);
  u.rate = 1.08;
  speechSynthesis.speak(u);
}

function shush() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

function handle(e) {
  const working = thinking.isConnected;
  dispatch(e);
  if (working && thinking.isConnected && e.type !== 'status') showThinking();
}

function dispatch(e) {
  switch (e.type) {
    case 'hello':
      $('model').textContent = e.model;
      $('workspace').textContent = e.workspace;
      setRunning(e.running);
      break;
    case 'metrics':
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
      add('say', e.text);
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
      add('done', e.text);
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
  $('status-dot').classList.toggle('running', running);
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
  shush();
  // A bare spoken "stop" halts the agent; anything longer is a new instruction or a barge-in.
  if (/^(stop|halt|cancel)[.!]?$/i.test(text)) ws.send(JSON.stringify({ type: 'stop' }));
  else ws.send(JSON.stringify({ type: 'command', text }));
}

input.addEventListener('input', (e) => {
  // The moment the user starts talking, the agent stops talking.
  shush();
  // Wispr Flow inserts a whole phrase at once; normal typing inserts one character.
  if ((e.data && e.data.length > 2) || e.inputType === 'insertFromPaste') dictatedSinceSend = true;
  clearTimeout(autoSendTimer);
  if ($('autosend').checked && dictatedSinceSend) autoSendTimer = setTimeout(send, 1200);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
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
