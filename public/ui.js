// UI layer on top of app.js: tabs (Chat, Code, Terminal, Voice timeline), toasts, a live code view,
// and Bug Bash, a small game that wakes up while the agent writes code.
// It hooks the same events app.js already gets, so the live app and the replay site both drive it.
(() => {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const quiet = () => replaying; // true while app.js re-renders a saved session in one go
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // ---------- Tabs ----------
  const panes = [...document.querySelectorAll('main .pane')];
  const tabs = [...document.querySelectorAll('#main-tabs button')];
  let pane = 'chat';
  function showPane(name) {
    pane = name;
    for (const t of tabs) {
      t.classList.toggle('active', t.dataset.pane === name);
      if (t.dataset.pane === name) t.classList.remove('ping');
    }
    for (const p of panes) p.hidden = p.dataset.pane !== name;
    document.body.dataset.pane = name;
    if (name === 'code') renderCode();
  }
  for (const t of tabs) t.onclick = () => showPane(t.dataset.pane);
  const ping = (name) => {
    if (pane !== name && !quiet()) tabs.find((t) => t.dataset.pane === name)?.classList.add('ping');
  };
  const setCount = (id, n) => ($(id).textContent = n);

  const sideTabs = [...document.querySelectorAll('#side-tabs button')];
  function showSide(name) {
    for (const t of sideTabs) t.classList.toggle('active', t.dataset.side === name);
    for (const s of document.querySelectorAll('.side-sec')) s.hidden = s.dataset.side !== name;
  }
  for (const t of sideTabs) t.onclick = () => showSide(t.dataset.side);

  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const name = ['chat', 'code', 'term', 'timeline'][Number(e.key) - 1];
    if (name) {
      e.preventDefault();
      showPane(name);
    }
    if (e.key.toLowerCase() === 'g') {
      e.preventDefault();
      toggleArcade();
    }
  });

  // ---------- Toasts ----------
  function toast(text, kind = '', onClick) {
    if (quiet()) return;
    const t = el('div', `toast ${kind}`, text);
    if (onClick) {
      t.classList.add('click');
      t.onclick = () => {
        onClick();
        t.remove();
      };
    }
    $('toasts').appendChild(t);
    while ($('toasts').childElementCount > 4) $('toasts').firstChild.remove();
    setTimeout(() => t.classList.add('out'), 3600);
    setTimeout(() => t.remove(), 4000);
  }

  // ---------- Code view ----------
  const files = new Map(); // path -> { diff, created, adds, dels, edits, t }
  let selected = null;
  let typer = null;
  const TOKENS = /(\/\/.*$|\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|if|else|for|while|import|export|from|async|await|new|class|throw|try|catch|finally|of|in|default|switch|case|break|continue|typeof|extends)\b|\b(true|false|null|undefined|this)\b|\b(\d+(?:\.\d+)?)\b|([A-Za-z_$][\w$]*)(?=\s*\()/g;
  function highlight(parent, text) {
    let last = 0;
    for (const m of text.matchAll(TOKENS)) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'k' : m[4] ? 'b' : m[5] ? 'n' : 'f';
      parent.appendChild(el('span', `t-${cls}`, m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function diffRows(diff) {
    const rows = [];
    let n = 0;
    for (const line of diff.split('\n')) {
      const sign = line[0] === '+' ? '+' : line[0] === '-' ? '-' : ' ';
      const body = sign === ' ' && line[0] !== ' ' ? line : line.slice(1);
      if (sign !== '-') n++;
      const row = el('div', `row ${sign === '+' ? 'add' : sign === '-' ? 'del' : ''}`);
      row.append(el('span', 'ln', sign === '-' ? '' : String(n)), el('span', 'sg', sign === ' ' ? '' : sign));
      const code = el('span', 'cd');
      highlight(code, body);
      row.appendChild(code);
      rows.push(row);
    }
    return rows;
  }

  function renderFiles() {
    const list = $('code-files');
    list.replaceChildren();
    const sorted = [...files.entries()].sort((a, b) => b[1].t - a[1].t);
    for (const [path, f] of sorted) {
      const li = el('li', path === selected ? 'active' : '');
      const name = el('span', 'fname');
      const slash = path.lastIndexOf('/');
      name.append(el('small', '', slash >= 0 ? path.slice(0, slash + 1) : ''), document.createTextNode(path.slice(slash + 1)));
      const stats = el('span', 'fstats');
      stats.append(el('b', 'a', `+${f.adds}`), el('b', 'd', `−${f.dels}`));
      if (f.created) stats.prepend(el('em', '', 'new'));
      li.append(name, stats);
      li.onclick = () => {
        selected = path;
        $('code-follow').checked = false;
        renderFiles();
        renderCode();
      };
      list.appendChild(li);
    }
  }

  function renderCode(animate = false) {
    clearInterval(typer);
    const body = $('code-body');
    const f = selected && files.get(selected);
    if (!f) return;
    $('code-path').textContent = selected;
    $('code-stats').textContent = `${f.created ? 'new file' : `edit #${f.edits}`} · +${f.adds} −${f.dels} · ${clock(f.t)}`;
    body.replaceChildren();
    const rows = diffRows(f.diff);
    if (!animate) {
      body.append(...rows);
      return;
    }
    // Write the file in line by line, the way it's being "typed", with a cursor at the end.
    const cursor = el('span', 'cursor');
    let i = 0;
    const per = Math.max(1, Math.ceil(rows.length / 120));
    body.classList.add('typing');
    typer = setInterval(() => {
      for (let k = 0; k < per && i < rows.length; k++, i++) body.appendChild(rows[i]);
      rows[i - 1]?.querySelector('.cd')?.appendChild(cursor);
      const firstChange = rows.findIndex((r) => r.classList.contains('add'));
      if (i - 1 >= firstChange) body.scrollTop = body.scrollHeight;
      if (i >= rows.length) {
        clearInterval(typer);
        body.classList.remove('typing');
        setTimeout(() => cursor.remove(), 1500);
        // Land the view on the first changed line.
        rows[firstChange]?.scrollIntoView({ block: 'center' });
      }
    }, 22);
  }

  function onFile(e) {
    const prev = files.get(e.path);
    const lines = e.diff.split('\n');
    files.set(e.path, {
      diff: e.diff,
      created: e.created || prev?.created,
      adds: lines.filter((l) => l.startsWith('+')).length,
      dels: lines.filter((l) => l.startsWith('-')).length,
      edits: (prev?.edits ?? 0) + 1,
      t: e.t ?? Date.now(),
    });
    setCount('n-code', files.size);
    ping('code');
    if ($('code-follow').checked || !selected) selected = e.path;
    renderFiles();
    if (selected === e.path) renderCode(!quiet());
    game.codeLines(lines);
    if (!quiet()) {
      toast(`✎ ${e.created ? 'Created' : 'Edited'} ${e.path}`, 'ok', () => showPane('code'));
      game.wave(e.path);
    }
  }
  $('code-follow').onchange = () => {
    if (!$('code-follow').checked) return;
    const newest = [...files.entries()].sort((a, b) => b[1].t - a[1].t)[0];
    if (newest) {
      selected = newest[0];
      renderFiles();
      renderCode();
    }
  };

  // ---------- Terminal ----------
  let runs = 0;
  let pendingRun = null;
  function onCommand(e) {
    if ($('term-body').querySelector('.pane-empty')) $('term-body').replaceChildren();
    const block = el('div', 'term-run');
    const head = el('div', 'term-cmd');
    head.append(el('span', 'prompt', '❯'), el('span', 'cmdtext', e.args.command), el('span', 'badge', 'running…'));
    const out = el('pre', 'term-out');
    block.append(head, out);
    $('term-body').appendChild(block);
    $('term-body').scrollTop = $('term-body').scrollHeight;
    pendingRun = { head, out, block };
    setCount('n-term', ++runs);
    ping('term');
  }
  function onCommandResult(e) {
    if (!pendingRun) return;
    const code = /^Exit code (\S+)/.exec(e.preview)?.[1];
    const pass = e.ok && code === '0';
    const badge = pendingRun.head.querySelector('.badge');
    badge.textContent = e.ok ? (code ? `exit ${code}` : 'cancelled') : 'error';
    badge.className = `badge ${pass ? 'pass' : 'fail'}`;
    pendingRun.block.classList.add(pass ? 'pass' : 'fail');
    pendingRun.out.textContent = e.preview.replace(/^Exit code \S+\n?/, '');
    $('term-body').scrollTop = $('term-body').scrollHeight;
    const cmd = pendingRun.head.querySelector('.cmdtext').textContent;
    pendingRun = null;
    if (quiet()) return;
    if (pass) {
      toast(`✓ ${cmd} passed`, 'ok', () => showPane('term'));
      game.reward();
    } else {
      toast(`✗ ${cmd} failed`, 'bad', () => showPane('term'));
      game.swarm();
    }
  }

  // ---------- Voice timeline ----------
  let moments = 0;
  let firstT = null;
  function moment(icon, kind, title, text, t = Date.now()) {
    const list = $('timeline');
    if (list.querySelector('.pane-empty')) list.replaceChildren();
    firstT ??= t;
    const li = el('li', `tl ${kind}`);
    const dot = el('span', 'tl-dot', icon);
    const card = el('div', 'tl-card');
    const top = el('div', 'tl-top');
    top.append(el('b', '', title), el('span', 'tl-time', `${clock(t)} · +${Math.round((t - firstT) / 1000)}s`));
    card.appendChild(top);
    if (text) card.appendChild(el('p', '', text));
    li.append(dot, card);
    list.appendChild(li);
    list.parentElement.scrollTop = list.parentElement.scrollHeight;
    setCount('n-time', ++moments);
    ping('timeline');
  }

  // ---------- Plan meter and meeting badge ----------
  function onPlan(p) {
    const liveSteps = p.steps.filter((s) => s.status !== 'dropped');
    const done = liveSteps.filter((s) => s.status === 'done').length;
    $('plan-bar').style.width = `${liveSteps.length ? (100 * done) / liveSteps.length : 0}%`;
    if (!quiet()) showSide('plan');
  }

  // ---------- Hook app.js ----------
  const baseDispatch = dispatch;
  dispatch = (e) => {
    baseDispatch(e);
    const t = e.t ?? Date.now();
    switch (e.type) {
      case 'user':
        moment(e.interrupt ? '⚡' : '🎙', e.interrupt ? 'barge' : 'say', e.interrupt ? 'Barge-in' : 'Instruction', e.text, t);
        break;
      case 'interrupted':
        game.say('Barge-in! Agent is re-planning…');
        break;
      case 'plan':
        onPlan(e.plan);
        if (e.plan.replanned) {
          moment('↻', 'replan', `Re-planned to v${e.plan.version}`, e.plan.reason ? `After “${e.plan.reason}”` : '', t);
          toast(`↻ Plan v${e.plan.version}: re-planned`, 'warn');
        }
        break;
      case 'tool':
        if (e.name === 'run_command') onCommand(e);
        break;
      case 'tool_result':
        if (e.name === 'run_command') onCommandResult(e);
        break;
      case 'file_changed':
        onFile(e);
        break;
      case 'done':
        moment('✓', 'done', 'Done', e.text.split('\n')[0].slice(0, 180), t);
        if (!quiet()) game.finished();
        break;
      case 'pull_request':
        moment('🚀', 'pr', 'Pull request', e.title, t);
        toast(`🚀 ${e.title}`, 'ok');
        break;
      case 'meeting':
        setCount('n-meet', e.tasks.length);
        if (e.tasks.length) {
          moment('📋', 'meet', `Meeting: ${e.name || 'transcript'}`, `${e.tasks.length} action item${e.tasks.length === 1 ? '' : 's'} found`, t);
          if (!quiet()) showSide('meeting');
        }
        break;
      case 'stopped':
        moment('■', 'stop', 'Stopped', '', t);
        break;
      case 'error':
        moment('!', 'err', 'Error', e.message, t);
        break;
    }
  };

  const baseClear = clearView;
  clearView = () => {
    baseClear();
    files.clear();
    selected = null;
    clearInterval(typer);
    $('code-files').replaceChildren();
    $('code-path').textContent = 'No changes yet';
    $('code-stats').textContent = '';
    $('code-body').replaceChildren(el('p', 'pane-empty', 'Files the agent writes show up here, line by line, as it writes them.'));
    $('term-body').replaceChildren(el('p', 'pane-empty', 'Commands the agent runs, like your tests, show up here with their output.'));
    $('timeline').replaceChildren(el('li', 'pane-empty', 'Every instruction you dictate, every barge-in and every re-plan, in order.'));
    runs = moments = 0;
    firstT = null;
    pendingRun = null;
    for (const id of ['n-code', 'n-term', 'n-time', 'n-meet']) setCount(id, 0);
    $('plan-bar').style.width = '0';
    for (const t of tabs) t.classList.remove('ping');
  };

  const baseRunning = setRunning;
  setRunning = (running) => {
    baseRunning(running);
    $('live-tag').hidden = !running;
    document.body.classList.toggle('agent-busy', running);
    if (running) game.agentStarted();
  };

  // Count-up flash on the metric tiles.
  new MutationObserver((list) => {
    for (const m of list) {
      const b = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (!b?.matches?.('.metrics b')) continue;
      b.classList.remove('bump');
      void b.offsetWidth;
      b.classList.add('bump');
    }
  }).observe(document.querySelector('.metrics'), { subtree: true, childList: true, characterData: true });

  // Dictation wave: Wispr Flow drops a phrase in at once, so the bars light up when it lands.
  let waveTimer;
  input.addEventListener('input', (e) => {
    if (!((e.data && e.data.length > 2) || e.inputType === 'insertFromPaste')) return;
    $('wave').classList.add('on');
    clearTimeout(waveTimer);
    waveTimer = setTimeout(() => $('wave').classList.remove('on'), 1400);
  });

  // ---------- Bug Bash ----------
  const AUTO_KEY = 'flow-agent-arcade-auto';
  const BEST_KEY = 'flow-agent-arcade-best';
  let dismissed = false;
  function toggleArcade(force) {
    const open = force ?? $('arcade').hidden;
    $('arcade').hidden = !open;
    $('toggle-arcade').classList.toggle('on', open);
    if (open) game.open();
    else {
      dismissed = true;
      game.close();
    }
  }
  $('toggle-arcade').onclick = () => toggleArcade();
  $('arcade-min').onclick = () => toggleArcade(false);
  let sound = false;
  $('toggle-sound').onclick = () => {
    sound = !sound;
    $('toggle-sound').textContent = sound ? '🔊' : '🔇';
    $('toggle-sound').setAttribute('aria-pressed', String(sound));
  };

  const game = (() => {
    const canvas = $('game');
    const ctx = canvas.getContext('2d');
    const PROD = 34;
    let W = 640, H = 300, dpr = 1;
    let bugs = [], parts = [], floats = [];
    let score = 0, lives = 3, combo = 0, lastHit = 0, best = Number(localStorage.getItem(BEST_KEY) || 0);
    let state = 'idle'; // idle | play | over
    let raf = 0, last = 0, spawnIn = 0, elapsed = 0, shake = 0, flash = 0;
    let codeText = [
      'export function addTodo(title, now = Date.now()) {',
      "  if (!title?.trim()) throw new Error('title is required');",
      '  const todo = { id: nextId++, title, done: false };',
      '  todos.push(todo);',
      '  return todo;',
      '}',
      '',
      'test("sorts soonest first", () => {',
      '  assert.deepEqual(listTodos().map((t) => t.id), [2, 1]);',
      '});',
    ];
    let scroll = 0;
    let message = '';
    let messageUntil = 0;
    let audio = null;

    $('g-best').textContent = best;
    drawLives();

    function beep(freq, dur = 0.07, type = 'square', vol = 0.04) {
      if (!sound) return;
      try {
        audio ??= new AudioContext();
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.type = type;
        o.frequency.value = freq;
        g.gain.setValueAtTime(vol, audio.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
        o.connect(g).connect(audio.destination);
        o.start();
        o.stop(audio.currentTime + dur);
      } catch {}
    }

    function drawLives() {
      $('g-lives').textContent = '♥'.repeat(Math.max(0, lives)) + '♡'.repeat(Math.max(0, 3 - lives));
    }

    function size() {
      dpr = window.devicePixelRatio || 1;
      const r = canvas.getBoundingClientRect();
      W = Math.max(280, r.width);
      H = Math.max(160, r.height);
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    new ResizeObserver(() => !$('arcade').hidden && size()).observe(canvas);

    function spawn(opts = {}) {
      const r = Math.random();
      const kind = opts.kind ?? (r < 0.07 ? 'gold' : r < 0.27 ? 'fast' : r < 0.4 ? 'tank' : 'bug');
      const speedUp = 1 + Math.min(elapsed / 60, 1.5);
      const base = { bug: 34, fast: 62, tank: 22, gold: 48 }[kind];
      bugs.push({
        kind,
        x: W + 20 + Math.random() * 40,
        y: 26 + Math.random() * (H - 52),
        vx: -(base + Math.random() * 14) * speedUp,
        wob: Math.random() * 6.28,
        r: { bug: 11, fast: 8, tank: 14, gold: 10 }[kind],
        hp: kind === 'tank' ? 2 : 1,
        label: opts.label,
      });
    }

    function burst(x, y, color, n = 14) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.28, s = 40 + Math.random() * 160;
        parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.5 + Math.random() * 0.3, color });
      }
    }

    function hit(px, py) {
      if (state !== 'play') {
        reset();
        state = 'play';
        beep(660, 0.1, 'triangle');
        return;
      }
      let best = null, bd = Infinity;
      for (const b of bugs) {
        const d = Math.hypot(b.x - px, b.y - py);
        if (d < b.r + 14 && d < bd) (best = b), (bd = d);
      }
      if (!best) {
        combo = 0;
        floats.push({ x: px, y: py, text: 'miss', life: 0.6, color: '#7d8791' });
        return;
      }
      best.hp--;
      if (best.hp > 0) {
        burst(best.x, best.y, '#8fb3ff', 6);
        beep(300, 0.05);
        return;
      }
      const now = performance.now();
      combo = now - lastHit < 1300 ? combo + 1 : 1;
      lastHit = now;
      const pts = ({ bug: 10, fast: 20, tank: 30, gold: 50 }[best.kind]) * Math.min(combo, 8);
      score += pts;
      $('g-score').textContent = score;
      burst(best.x, best.y, best.kind === 'gold' ? '#ffd166' : '#22e06b', best.kind === 'gold' ? 26 : 14);
      floats.push({ x: best.x, y: best.y - 10, text: `+${pts}${combo > 1 ? ` ×${Math.min(combo, 8)}` : ''}`, life: 0.9, color: best.kind === 'gold' ? '#ffd166' : '#22e06b' });
      bugs.splice(bugs.indexOf(best), 1);
      beep(520 + Math.min(combo, 8) * 70, 0.06);
    }

    function reset() {
      bugs = [];
      parts = [];
      floats = [];
      score = 0;
      lives = 3;
      combo = 0;
      elapsed = 0;
      spawnIn = 0.4;
      $('g-score').textContent = 0;
      drawLives();
    }

    function lose(b) {
      lives--;
      shake = 0.35;
      flash = 0.4;
      combo = 0;
      drawLives();
      floats.push({ x: PROD + 30, y: b.y, text: 'shipped to prod!', life: 1, color: '#ff5d5d' });
      beep(140, 0.25, 'sawtooth', 0.05);
      if (lives <= 0) {
        state = 'over';
        bugs = [];
        if (score > best) {
          best = score;
          localStorage.setItem(BEST_KEY, String(best));
          $('g-best').textContent = best;
        }
      }
    }

    function update(dt) {
      scroll += dt * 14;
      if (state === 'play') {
        elapsed += dt;
        spawnIn -= dt;
        if (spawnIn <= 0) {
          spawn();
          spawnIn = Math.max(0.35, 1.5 - elapsed / 40) * (0.6 + Math.random() * 0.8);
        }
      } else if (bugs.length < 4 && Math.random() < dt * 0.8) spawn({ kind: 'bug' });
      for (const b of [...bugs]) {
        b.wob += dt * (b.kind === 'fast' ? 22 : 12);
        b.x += b.vx * dt;
        b.y += Math.sin(b.wob * 0.35) * dt * 18;
        b.y = Math.min(H - 16, Math.max(16, b.y));
        if (b.x < PROD) {
          bugs.splice(bugs.indexOf(b), 1);
          if (state === 'play') lose(b);
        }
      }
      for (const p of [...parts]) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.92;
        p.vy *= 0.92;
        if ((p.life -= dt) <= 0) parts.splice(parts.indexOf(p), 1);
      }
      for (const f of [...floats]) {
        f.y -= dt * 30;
        if ((f.life -= dt) <= 0) floats.splice(floats.indexOf(f), 1);
      }
      shake = Math.max(0, shake - dt);
      flash = Math.max(0, flash - dt);
    }

    function drawBug(b) {
      const colors = { bug: '#ff6b4a', fast: '#ffb547', tank: '#6f8cff', gold: '#ffd166' };
      const c = colors[b.kind];
      ctx.save();
      ctx.translate(b.x, b.y);
      const leg = Math.sin(b.wob) * 3;
      ctx.strokeStyle = c;
      ctx.lineWidth = 1.6;
      for (const side of [-1, 1]) {
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath();
          ctx.moveTo(i * b.r * 0.5, 0);
          ctx.lineTo(i * b.r * 0.6 + (i === 0 ? leg : -leg) * side, side * (b.r + 4));
          ctx.stroke();
        }
      }
      // antennae point at prod, the way it walks
      ctx.beginPath();
      ctx.moveTo(-b.r * 0.8, -2);
      ctx.lineTo(-b.r - 6, -7 + leg * 0.5);
      ctx.moveTo(-b.r * 0.8, 2);
      ctx.lineTo(-b.r - 6, 7 - leg * 0.5);
      ctx.stroke();
      ctx.fillStyle = c;
      if (b.kind === 'gold') {
        ctx.shadowColor = c;
        ctx.shadowBlur = 14;
      }
      ctx.beginPath();
      ctx.ellipse(0, 0, b.r, b.r * 0.72, 0, 0, 6.28);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(-0.7, -b.r * 0.7, 1.4, b.r * 1.4);
      ctx.beginPath();
      ctx.arc(-b.r * 0.85, 0, b.r * 0.42, 0, 6.28);
      ctx.fillStyle = '#1a0f0a';
      ctx.fill();
      if (b.kind === 'tank' && b.hp === 1) {
        ctx.strokeStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(-3, -5);
        ctx.lineTo(2, 1);
        ctx.lineTo(-1, 5);
        ctx.stroke();
      }
      ctx.restore();
      if (b.label) {
        ctx.font = '600 10px "JetBrains Mono", monospace';
        ctx.fillStyle = 'rgba(232,235,238,0.75)';
        ctx.fillText(b.label, b.x - ctx.measureText(b.label).width / 2, b.y - b.r - 8);
      }
    }

    function draw() {
      ctx.save();
      if (shake) ctx.translate((Math.random() - 0.5) * 8 * shake, (Math.random() - 0.5) * 8 * shake);
      ctx.fillStyle = '#060809';
      ctx.fillRect(-10, -10, W + 20, H + 20);
      // The code being written scrolls behind the bugs.
      ctx.font = '12px "JetBrains Mono", monospace';
      const lh = 17;
      const off = scroll % (codeText.length * lh || 1);
      for (let i = -1; i < H / lh + 2; i++) {
        const idx = ((Math.floor(off / lh) + i) % codeText.length + codeText.length) % codeText.length;
        const line = codeText[idx] ?? '';
        const y = i * lh - (off % lh) + 14;
        ctx.fillStyle = line.startsWith('+') ? 'rgba(34,224,107,0.22)' : line.startsWith('-') ? 'rgba(255,93,93,0.16)' : 'rgba(125,135,145,0.16)';
        ctx.fillText(line.slice(0, 90), PROD + 12, y);
      }
      // prod line
      ctx.strokeStyle = 'rgba(255,93,93,0.7)';
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(PROD, 0);
      ctx.lineTo(PROD, H);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.save();
      ctx.translate(14, H / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = 'rgba(255,93,93,0.85)';
      ctx.font = '700 10px "JetBrains Mono", monospace';
      ctx.fillText('PROD', -14, 4);
      ctx.restore();

      for (const b of bugs) drawBug(b);
      for (const p of parts) {
        ctx.globalAlpha = Math.max(0, p.life * 1.8);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
      }
      ctx.globalAlpha = 1;
      ctx.font = '700 12px "JetBrains Mono", monospace';
      for (const f of floats) {
        ctx.globalAlpha = Math.min(1, f.life * 2);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, f.y);
      }
      ctx.globalAlpha = 1;
      if (combo > 2 && state === 'play') {
        ctx.fillStyle = '#22e06b';
        ctx.font = '800 14px "JetBrains Mono", monospace';
        ctx.fillText(`COMBO ×${Math.min(combo, 8)}`, W - 110, 22);
      }
      if (flash) {
        ctx.fillStyle = `rgba(255,93,93,${flash * 0.35})`;
        ctx.fillRect(0, 0, W, H);
      }
      if (performance.now() < messageUntil) {
        ctx.font = '600 12px "JetBrains Mono", monospace';
        const w = ctx.measureText(message).width + 20;
        ctx.fillStyle = 'rgba(5,6,7,0.85)';
        ctx.fillRect(W / 2 - w / 2, H - 34, w, 24);
        ctx.strokeStyle = 'rgba(34,224,107,0.6)';
        ctx.strokeRect(W / 2 - w / 2 + 0.5, H - 33.5, w - 1, 23);
        ctx.fillStyle = '#22e06b';
        ctx.fillText(message, W / 2 - w / 2 + 10, H - 18);
      }
      if (state !== 'play') {
        ctx.fillStyle = 'rgba(5,6,7,0.62)';
        ctx.fillRect(0, 0, W, H);
        ctx.textAlign = 'center';
        ctx.fillStyle = state === 'over' ? '#ff5d5d' : '#22e06b';
        ctx.font = '800 22px "JetBrains Mono", monospace';
        ctx.fillText(state === 'over' ? 'BUGS SHIPPED TO PROD' : 'BUG BASH', W / 2, H / 2 - 18);
        ctx.fillStyle = '#e8ebee';
        ctx.font = '500 13px "IBM Plex Sans", sans-serif';
        ctx.fillText(state === 'over' ? `Score ${score} · best ${best} · click to go again` : 'Click bugs before they reach prod. Click to start.', W / 2, H / 2 + 8);
        ctx.fillStyle = '#7d8791';
        ctx.font = '500 11px "JetBrains Mono", monospace';
        ctx.fillText('red 10 · fast 20 · blue 2 hits 30 · gold 50 · chain for combos', W / 2, H / 2 + 32);
        ctx.textAlign = 'left';
      }
      ctx.restore();
    }

    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000 || 0);
      last = now;
      if (!document.hidden) {
        update(dt);
        draw();
      }
      raf = requestAnimationFrame(frame);
    }

    canvas.addEventListener('pointerdown', (e) => {
      const r = canvas.getBoundingClientRect();
      hit(e.clientX - r.left, e.clientY - r.top);
    });

    return {
      open() {
        size();
        cancelAnimationFrame(raf);
        last = performance.now();
        raf = requestAnimationFrame(frame);
      },
      close() {
        cancelAnimationFrame(raf);
        if (state === 'play') state = 'idle';
      },
      say(text, ms = 2600) {
        message = text;
        messageUntil = performance.now() + ms;
        $('arcade-sub').textContent = text;
      },
      codeLines(lines) {
        const useful = lines.filter((l) => l.trim().length > 1).slice(0, 80);
        if (useful.length > 3) codeText = useful;
      },
      wave(label) {
        const name = label.split('/').pop();
        this.say(`${name} changed: new bugs incoming`);
        if (state === 'play') for (let i = 0; i < 3; i++) setTimeout(() => spawn({ label: i === 0 ? name : undefined }), i * 350);
      },
      reward() {
        this.say('Tests passed: +1 life');
        if (state === 'play' && lives < 5) {
          lives++;
          drawLives();
          beep(880, 0.15, 'triangle');
        }
      },
      swarm() {
        this.say('Tests failed: swarm!');
        if (state === 'play') for (let i = 0; i < 4; i++) setTimeout(() => spawn({ kind: i ? 'fast' : 'tank' }), i * 250);
      },
      agentStarted() {
        $('arcade-banner').hidden = true;
        if (quiet() || viewing) return;
        if (!dismissed && localStorage.getItem(AUTO_KEY) !== 'off' && $('arcade').hidden) toggleArcade(true);
        this.say('Agent is writing code. Squash bugs meanwhile.', 3200);
      },
      finished() {
        if ($('arcade').hidden) return;
        const banner = $('arcade-banner');
        banner.replaceChildren();
        const text = el('span', '', `✓ Agent finished${state === 'play' ? ` · you're at ${score}` : ''}. Your code is ready.`);
        const see = el('button', 'small', 'See the code');
        see.onclick = () => {
          banner.hidden = true;
          showPane(files.size ? 'code' : 'chat');
        };
        const keep = el('button', 'secondary small', 'Keep playing');
        keep.onclick = () => (banner.hidden = true);
        banner.append(text, see, keep);
        banner.hidden = false;
        beep(990, 0.2, 'triangle');
      },
    };
  })();

  showPane('chat');
})();
