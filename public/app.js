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
      if (e.model) $('model').textContent = e.model;
      break;
    case 'status':
      setRunning(e.running);
      break;
    case 'user':
      add(e.interrupt ? 'user interrupt' : 'user', e.text);
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
    case 'stopped':
      add('notice', 'Stopped. Waiting for your next instruction.');
      break;
    case 'error':
      add('error', e.message);
      break;
  }
}

function setRunning(running) {
  $('status-dot').classList.toggle('running', running);
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
