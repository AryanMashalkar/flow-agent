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
      $('m-tools').textContent = e.toolCalls;
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
      add('tool', `→ ${e.name}(${JSON.stringify(e.args)})`);
      break;
    case 'tool_result':
      if (!e.ok) add('tool fail', `✗ ${e.name}: ${e.preview}`);
      break;
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
