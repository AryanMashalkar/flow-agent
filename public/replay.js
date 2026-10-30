// Replay mode: a recorded session plays back in the real UI, with no server, no install and no API key.
// The recordings are real runs; only the waits for the model are shortened.
(() => {
  if (REPLAY === null) return;
  document.body.classList.add('replay');
  $('replay-bar').hidden = false;
  input.disabled = true;
  input.placeholder = 'This is a recorded replay. Run Flow Agent locally to drive it with your own voice.';

  const MAX_GAP = 2500;
  const MIN_GAP = 200;
  const SPEEDS = [1, 2, 4];
  let rec = null;
  let idx = 0;
  let speed = 1;
  let playing = false;
  let timer = null;
  let counts = null;
  let manifest = [];

  function resetCounters() {
    counts = { words: 0, instr: 0, interrupts: 0, files: new Set(), tests: 0, replans: 0, prs: 0 };
    showCounters();
  }

  // The same numbers the server counts live, rebuilt from the recording.
  function count(e) {
    if (e.type === 'user') {
      counts.instr++;
      counts.words += e.text.split(/\s+/).length;
      if (e.interrupt) counts.interrupts++;
    } else if (e.type === 'tool' && e.name === 'run_command') counts.tests++;
    else if (e.type === 'file_changed') counts.files.add(e.path);
    else if (e.type === 'plan' && e.plan.replanned) counts.replans++;
    else if (e.type === 'pull_request') counts.prs++;
    showCounters();
  }

  function showCounters() {
    $('m-words').textContent = counts.words;
    $('m-instr').textContent = counts.instr;
    $('m-interrupts').textContent = counts.interrupts;
    $('m-files').textContent = counts.files.size;
    $('m-tests').textContent = counts.tests;
    $('m-replans').textContent = counts.replans;
    $('m-prs').textContent = counts.prs;
    $('m-keys').textContent = rec?.keysTyped ?? '–';
  }

  function apply(e) {
    count(e);
    dispatch(e);
    if (e.type === 'user') setRunning(true);
    if (e.type === 'done' || e.type === 'stopped' || e.type === 'error') setRunning(false);
    if (e.type === 'status') return;
    if (thinking.isConnected) showThinking();
  }

  function progress() {
    $('replay-progress').textContent = rec ? `${Math.min(idx, rec.events.length)} / ${rec.events.length}` : '';
    $('replay-play').textContent = playing ? '❚❚ Pause' : idx >= (rec?.events.length ?? 0) ? '↺ Replay' : '▶ Play';
  }

  // Wait for the spoken line to finish, so the narration keeps up with the screen.
  function afterSpeech(fn) {
    const started = Date.now();
    const check = () => {
      if (!playing) return;
      if (!$('narrate').checked || !speechSynthesis.speaking || Date.now() - started > 9000) fn();
      else timer = setTimeout(check, 150);
    };
    timer = setTimeout(check, 150);
  }

  function step() {
    if (!playing) return;
    if (idx >= rec.events.length) {
      playing = false;
      setRunning(false);
      return progress();
    }
    const e = rec.events[idx];
    if (e.type === 'user' && input.value !== e.text) {
      // Show the words land in the box the way Wispr Flow inserts them, then send.
      shush();
      input.value = e.text;
      timer = setTimeout(step, 1100 / speed);
      return;
    }
    if (e.type === 'user') input.value = '';
    idx++;
    apply(e);
    progress();
    const next = rec.events[idx];
    const gap = next && e.t && next.t ? Math.min(Math.max(next.t - e.t, MIN_GAP), MAX_GAP) : 600;
    const wait = () => (timer = setTimeout(step, gap / speed));
    if ((e.type === 'say' || e.type === 'done') && speed === 1) afterSpeech(wait);
    else wait();
  }

  function play() {
    if (!rec) return;
    if (idx >= rec.events.length) restart();
    playing = true;
    progress();
    step();
  }

  function pause() {
    playing = false;
    clearTimeout(timer);
    shush();
    progress();
  }

  function restart() {
    pause();
    idx = 0;
    input.value = '';
    clearView();
    resetCounters();
    setRunning(false);
    progress();
  }

  async function load(url) {
    restart();
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      rec = await res.json();
    } catch (err) {
      add('error', `Could not load the replay ${url}: ${err.message}`);
      return;
    }
    $('model').textContent = rec.model ?? 'recorded session';
    $('workspace').textContent = rec.workspace ?? '';
    $('replay-title').textContent = rec.title ?? 'Replay';
    $('replay-note').textContent = rec.note ?? `Recorded ${new Date(rec.recorded).toLocaleString()}.`;
    showCounters();
    progress();
    renderList(url);
  }

  function renderList(current) {
    const list = $('sessions');
    list.replaceChildren();
    const head = document.createElement('li');
    head.className = 'group';
    head.textContent = 'Recorded sessions';
    list.appendChild(head);
    for (const r of manifest) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      const url = new URL(r.file, new URL('replays/', location.href)).href;
      btn.className = `session${url === current ? ' active' : ''}`;
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = r.title;
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = r.subtitle ?? '';
      btn.append(title, when);
      btn.onclick = () => load(url).then(play);
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  $('replay-play').onclick = () => (playing ? pause() : play());
  $('replay-end').onclick = () => {
    if (!rec) return;
    pause();
    while (idx < rec.events.length) apply(rec.events[idx++]);
    setRunning(false);
    progress();
  };
  $('replay-speed').onclick = () => {
    speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    $('replay-speed').textContent = `${speed}×`;
  };

  resetCounters();
  (async () => {
    try {
      manifest = await (await fetch('replays/index.json', { cache: 'no-cache' })).json();
    } catch {
      manifest = [];
    }
    const first = REPLAY || (manifest[0] && new URL(manifest[0].file, new URL('replays/', location.href)).href);
    if (first) await load(new URL(first, location.href).href);
    else add('error', 'No replay to show.');
  })();
})();
