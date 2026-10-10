/* Козир — client */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const R = window.Rules;

  const LEVEL = { easy: 'Легкий', medium: 'Середній', hard: 'Складний' };
  const VARIANT = { podkidnoy: 'Підкидний', perevodnoy: 'Переводний' };
  const THROW = { order: 'По черзі', free: 'Хто встиг' };
  const DEFAULTS = { variant: 'podkidnoy', throwMode: 'order', cheat: false, size: 2, botLevel: 'medium' };

  const S = {
    user: null, config: null, socket: null,
    room: null, code: null,
    sel: null, mark: null,
    seenEvent: 0,
    clockOffset: 0, setupKind: null, setupSettings: null,
    viewLobby: false, resultFor: null, leaving: false,
  };

  /* ---------------- utils ---------------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }
  const cardsWord = (n) => `${n} ${plural(n, 'карта', 'карти', 'карт')}`;
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function toast(text, kind = '') {
    const t = el('div', 'toast ' + kind, text);
    $('toasts').appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, kind === 'alarm' || kind === 'cheat' ? 5000 : 3000);
    while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  }
  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Помилка сервера');
    return data;
  }
  function avatar(p, extra = '') {
    const a = el('div', 'avatar ' + extra);
    if (p && p.avatar) {
      const img = document.createElement('img');
      img.src = p.avatar; img.alt = ''; img.referrerPolicy = 'no-referrer';
      a.appendChild(img);
    } else {
      a.textContent = ((p && p.name) || '?').trim().charAt(0).toUpperCase();
      if (p && p.kind === 'bot') a.classList.add('bot');
    }
    return a;
  }
  function show(id) {
    for (const s of ['scrLogin', 'scrHome', 'scrLobby', 'scrGame']) $(s).hidden = s !== id;
  }
  function setPath(p) { if (location.pathname !== p) history.replaceState(null, '', p); }

  /* ---------------- cards ---------------- */
  function cardEl(c, trump) {
    const face = c.r >= 11;
    const e = el('div', 'card' + (R.isRed(c.s) ? ' red' : '') + (face ? ' face' : '') + (c.s === trump ? ' is-trump' : ''));
    const lbl = R.rankLabel(c.r);
    e.setAttribute('aria-label', `${lbl} ${c.s}`);
    const corner = (cls) => { const d = el('div', cls); d.append(lbl); const i = el('i', null, c.s); d.append(i); return d; };
    e.append(corner('cr'));
    const pip = el('div', 'pip');
    if (face) pip.append(el('span', null, lbl)); else pip.textContent = c.s;
    e.append(pip, corner('cr b'));
    return e;
  }

  /* ---------------- boot & auth ---------------- */
  async function boot() {
    try {
      S.config = await api('/api/config');
      const me = await api('/api/me');
      if (me.user) { S.user = me.user; afterLogin(); } else showLogin();
    } catch (e) {
      showLogin();
      loginError('Не вдалося зв\'язатися з сервером. Оновіть сторінку.');
    }
  }

  function loginError(msg) { const e = $('loginError'); e.textContent = msg || ''; e.hidden = !msg; }

  function showLogin() {
    show('scrLogin');
    const cfg = S.config || {};
    $('guestForm').hidden = !cfg.allowGuests;
    if (cfg.googleClientId) {
      $('googleMissing').hidden = true;
      loadGoogle(cfg.googleClientId);
    } else {
      $('googleMissing').hidden = false;
    }
  }

  function loadGoogle(clientId) {
    const render = () => {
      window.google.accounts.id.initialize({ client_id: clientId, callback: onGoogle, ux_mode: 'popup' });
      $('googleBtn').innerHTML = '';
      window.google.accounts.id.renderButton($('googleBtn'), {
        theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', locale: 'uk',
        width: Math.min(320, $('googleBtn').clientWidth || 320),
      });
    };
    if (window.google && window.google.accounts) return render();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.onload = render;
    s.onerror = () => loginError('Не вдалося завантажити вхід через Google. Перевірте інтернет або блокувальник реклами.');
    document.head.appendChild(s);
  }

  async function onGoogle(resp) {
    loginError('');
    try {
      const { user } = await api('/api/auth/google', { credential: resp.credential });
      S.user = user; afterLogin();
    } catch (e) { loginError(e.message); }
  }

  $('guestForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError('');
    try {
      const { user } = await api('/api/auth/guest', { name: $('guestName').value });
      S.user = user; afterLogin();
    } catch (err) { loginError(err.message); }
  });

  $('logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', {}).catch(() => {});
    if (S.socket) { S.socket.disconnect(); S.socket = null; }
    S.user = null;
    if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect();
    setPath('/');
    showLogin();
  });

  function afterLogin() {
    const chip = $('meChip'); chip.innerHTML = '';
    chip.append(avatar(S.user), el('span', null, S.user.name));
    $('hello').textContent = `Привіт, ${S.user.name}!`;
    connect();
    const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{5})$/);
    if (m) { S.code = m[1].toUpperCase(); if (S.socket.connected) join(S.code); } else show('scrHome');
  }

  /* ---------------- socket ---------------- */
  function connect() {
    if (S.socket) return;
    const sock = window.io({ transports: ['websocket', 'polling'] });
    S.socket = sock;
    sock.on('connect', () => {
      $('conn').hidden = true;
      if (S.code && !S.leaving) sock.emit('join', { code: S.code }, (r) => { if (!r.ok) { toast(r.error, 'err'); toHome(); } else setPath('/r/' + r.code); });
    });
    sock.on('disconnect', () => { if (S.socket === sock) $('conn').hidden = false; });
    sock.on('connect_error', (err) => {
      if (err && err.message === 'unauthorized') { sock.disconnect(); S.socket = null; S.user = null; showLogin(); }
    });
    sock.on('room', onRoom);
    sock.on('kicked', () => { toast('Господар прибрав вас з кімнати'); toHome(); });
    sock.on('closed', () => { toast('Кімнату закрито'); toHome(); });
  }

  function emit(name, payload) {
    return new Promise((resolve) => {
      if (!S.socket || !S.socket.connected) { toast('Немає з\'єднання з сервером', 'err'); return resolve({ ok: false }); }
      S.socket.timeout(8000).emit(name, payload || {}, (err, r) => {
        if (err) { toast('Сервер не відповідає', 'err'); return resolve({ ok: false }); }
        if (!r.ok && r.error) toast(r.error, 'err');
        resolve(r);
      });
    });
  }

  async function join(code) {
    const r = await emit('join', { code });
    if (r.ok) { S.code = r.code; setPath('/r/' + r.code); } else toHome();
  }

  function toHome() {
    S.room = null; S.code = null; S.sel = S.mark = null; S.viewLobby = false; S.resultFor = null;
    $('result').hidden = true; $('confirm').hidden = true;
    setPath('/');
    show('scrHome');
  }

  async function leaveRoom() {
    S.leaving = true;
    await emit('leave');
    S.leaving = false;
    toHome();
  }

  /* ---------------- settings UI ---------------- */
  function seg(label, options, value, onPick, disabled, hint) {
    const f = el('div', 'field');
    f.append(el('div', 'label', label));
    const s = el('div', 'seg');
    for (const [v, text] of options) {
      const b = el('button', v === value ? 'on' : '', text);
      b.type = 'button'; b.disabled = !!disabled;
      b.setAttribute('aria-pressed', v === value);
      b.addEventListener('click', () => onPick(v));
      s.append(b);
    }
    f.append(s);
    if (hint) f.append(el('div', 'hint', hint));
    return f;
  }

  function renderSettings(box, st, { kind, editable, onChange }) {
    box.innerHTML = '';
    const set = (k) => (v) => onChange({ ...st, [k]: v });
    box.append(seg('Режим', [['podkidnoy', 'Підкидний'], ['perevodnoy', 'Переводний']], st.variant, set('variant'), !editable,
      st.variant === 'perevodnoy' ? 'Атаку можна перевести на наступного картою того самого номіналу' : 'Класика: відбивайся або бери'));
    box.append(seg(kind === 'bots' ? 'Гравців (разом з вами)' : 'Місць у кімнаті', [[2, '2'], [3, '3'], [4, '4']], st.size, set('size'), !editable));
    if (st.size > 2) {
      box.append(seg('Хто підкидає', [['order', 'По черзі'], ['free', 'Хто встиг']], st.throwMode, set('throwMode'), !editable,
        st.throwMode === 'order' ? 'Спершу той, хто ходив, далі інші за годинниковою стрілкою' : 'Підкидають усі одночасно: чия карта перша, та й лягає'));
    }
    if (kind === 'bots') {
      box.append(seg(kind === 'bots' ? 'Складність ботів' : 'Рівень ботів, яких додаєте', [['easy', 'Легкий'], ['medium', 'Середній'], ['hard', 'Складний']], st.botLevel, set('botLevel'), !editable));
    }
    const tg = el('label', 'toggle' + (editable ? '' : ' disabled'));
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!st.cheat; cb.disabled = !editable; cb.id = box.id + '-cheat';
    cb.addEventListener('change', () => onChange({ ...st, cheat: cb.checked }));
    const t = el('span', 't'); t.append(el('b', null, 'Махлювання'), el('span', null, 'Можна класти неправильні карти. Хто помітить і викриє — змусить шахрая забрати стіл.'));
    tg.append(cb, el('span', 'sw'), t);
    box.append(tg);
  }

  function openSetup(kind, preset) {
    S.setupKind = kind;
    S.setupSettings = { ...DEFAULTS, ...store.get('kz-settings-' + kind, {}), ...(preset || {}) };
    $('setupTitle').textContent = kind === 'bots' ? 'Гра з ботами' : 'Нова кімната';
    $('setupGo').textContent = kind === 'bots' ? 'Почати' : 'Створити кімнату';
    const draw = () => renderSettings($('setupFields'), S.setupSettings, {
      kind, editable: true, onChange: (st) => { S.setupSettings = st; draw(); },
    });
    draw();
    $('setup').hidden = false;
  }

  $('playBots').addEventListener('click', () => openSetup('bots'));
  $('playFriends').addEventListener('click', () => openSetup('friends'));
  $('setupCancel').addEventListener('click', () => { $('setup').hidden = true; });
  $('setupGo').addEventListener('click', async () => {
    const kind = S.setupKind; const st = S.setupSettings;
    store.set('kz-settings-' + kind, st);
    $('setupGo').disabled = true;
    if (S.code) { S.leaving = true; await emit('leave'); S.leaving = false; S.code = null; }
    const r = await emit('create', { settings: st, solo: kind === 'bots' });
    $('setupGo').disabled = false;
    if (r.ok) { $('setup').hidden = true; S.code = r.code; S.resultFor = null; setPath('/r/' + r.code); }
  });

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('joinCode').value.trim().toUpperCase();
    if (code.length !== 5) return toast('Код кімнати — 5 символів', 'err');
    join(code);
  });

  /* ---------------- room routing ---------------- */
  function onRoom(v) {
    const prevStatus = S.room && S.room.status;
    S.room = v; S.code = v.code;
    S.clockOffset = v.now - Date.now();
    if (v.status === 'playing') S.viewLobby = false;
    if (v.status === 'lobby' || (v.status === 'finished' && S.viewLobby)) {
      $('result').hidden = true;
      renderLobby(v); show('scrLobby');
      return;
    }
    if (v.game) {
      if (prevStatus !== 'playing' && v.status === 'playing') { S.seenEvent = 0; S.sel = S.mark = null; }
      show('scrGame'); renderGame(v);
      if (v.game.over && S.resultFor !== v.games) { S.resultFor = v.games; setTimeout(() => showResult(S.room), 700); }
      if (!v.game.over) $('result').hidden = true;
    }
  }

  /* ---------------- lobby ---------------- */
  let lobbySig = '';
  function renderLobby(v) {
    const sig = JSON.stringify([v.code, v.status, v.isHost, v.settings, v.seats]);
    if (sig === lobbySig && !$('scrLobby').hidden) return;
    lobbySig = sig;
    $('roomCode').textContent = v.code;
    $('linkField').value = `${location.origin}/r/${v.code}`;
    const box = $('seats'); box.innerHTML = '';
    v.seats.forEach((s, i) => {
      const row = el('div', 'seat' + (s ? '' : ' empty'));
      if (s) {
        row.append(avatar(s));
        const who = el('div', 'who');
        who.append(el('b', null, s.name + (s.you ? ' (ви)' : '')));
        who.append(el('span', null, s.kind === 'bot' ? `Бот · ${LEVEL[s.level]}` : (s.connected ? 'У кімнаті' : 'Не в мережі')));
        row.append(who);
        if (s.host) row.append(el('span', 'tag', 'господар'));
        if (s.kind === 'human') row.append(el('span', 'dot' + (s.connected ? '' : ' off')));
        if (v.isHost && !s.host) {
          const x = el('button', 'icon-btn', 'Прибрати'); x.type = 'button';
          x.addEventListener('click', () => emit('removeSeat', { seat: i }));
          row.append(x);
        }
      } else {
        const who = el('div', 'who');
        who.append(el('b', null, 'Вільне місце'), el('span', null, v.isHost ? 'Чекаємо друга або додайте бота' : 'Чекаємо гравця'));
        row.append(who);
        if (v.isHost) {
          const adders = el('div', 'bot-adders');
          for (const lv of ['easy', 'medium', 'hard']) {
            const b = el('button', 'btn ghost', '+ ' + LEVEL[lv]); b.type = 'button';
            b.title = `Додати бота (${LEVEL[lv].toLowerCase()})`;
            b.addEventListener('click', () => emit('addBot', { level: lv }));
            adders.append(b);
          }
          row.append(adders);
        }
      }
      box.append(row);
    });
    renderSettings($('lobbyFields'), v.settings, {
      kind: 'friends', editable: v.isHost, onChange: (st) => emit('settings', st),
    });
    const filled = v.seats.filter(Boolean).length;
    $('startBtn').hidden = !v.isHost;
    $('startBtn').disabled = filled < 2;
    $('startBtn').textContent = v.status === 'finished' ? 'Нова партія' : 'Почати гру';
    $('lobbyHint').textContent = v.isHost
      ? (filled < 2 ? 'Надішліть другу запрошення або додайте бота.' : `Гравців: ${filled}. Вільні місця не враховуються.`)
      : 'Чекаємо, поки господар кімнати почне гру.';
  }

  $('copyLink').addEventListener('click', async () => {
    const link = $('linkField').value;
    try { await navigator.clipboard.writeText(link); toast('Посилання скопійовано. Надішліть його друзям.'); } catch {
      $('linkField').select(); toast('Скопіюйте посилання з поля нижче');
    }
  });
  $('startBtn').addEventListener('click', () => emit('start'));
  $('lobbyLeave').addEventListener('click', leaveRoom);

  /* ---------------- game ---------------- */
  const nameOf = (g, k) => (k === g.me ? 'Ви' : (g.names[k] ? g.names[k].name : '?'));
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const EASE = 'cubic-bezier(.22,1,.36,1)';
  const MOVE_MS = 300;
  const TURN_MS = 30000;
  const RING_C = 2 * Math.PI * 18;

  // Card and seat elements live for the whole game and are moved, never re-created,
  // so every change can be animated from where the card really was (FLIP).
  const G = { key: null, cards: new Map(), pairs: new Map(), opps: [], built: false, actSig: '', statusSig: '', pileSig: '' };

  function resetBoard() {
    G.cards.clear(); G.pairs.clear(); G.opps = []; G.built = false; G.actSig = G.statusSig = G.pileSig = '';
    $('hand').innerHTML = ''; $('battle').innerHTML = ''; $('opponents').innerHTML = '';
  }

  function cardNode(c, trump) {
    let e = G.cards.get(c.id);
    if (!e) { e = cardEl(c, trump); e.dataset.card = c.id; e._fresh = true; G.cards.set(c.id, e); }
    return e;
  }
  const centerOf = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  const cssRot = (e) => { const r = getComputedStyle(e).rotate; return !r || r === 'none' ? '0deg' : r; };

  function snapshot() {
    const snap = new Map();
    for (const [id, e] of G.cards) {
      if (!e.isConnected) continue;
      snap.set(id, { c: centerOf(e.getBoundingClientRect()), w: e.offsetWidth, h: e.offsetHeight, rot: cssRot(e) });
    }
    return snap;
  }

  function syncChildren(parent, nodes) {
    nodes.forEach((node, i) => { if (parent.children[i] !== node) parent.insertBefore(node, parent.children[i] || null); });
    while (parent.children.length > nodes.length) parent.lastChild.remove();
  }

  function renderGame(v) {
    const g = v.game;
    const key = `${v.code}:${v.games}`;
    if (G.key !== key) { resetBoard(); G.key = key; }
    const snap = snapshot();
    const b = g.bout || { table: [], attacker: -1, defender: -1 };
    const a = g.actions || {};

    if (S.sel && (!g.hand.some((c) => c.id === S.sel) || !(a.defend || a.throw))) S.sel = null;
    if (S.mark && !b.table.some((p) => p.a.id === S.mark || (p.d && p.d.id === S.mark))) S.mark = null;

    const n = g.names.length;
    const bits = [VARIANT[g.variant], `${n} ${plural(n, 'гравець', 'гравці', 'гравців')}`];
    if (n > 2) bits.push(THROW[g.throwMode]);
    if (g.cheat) bits.push('махлювання');
    $('rulesChip').textContent = bits.join(' · ');

    renderOpponents(g);
    renderPile(g);
    renderTable(g, a, b);
    renderHand(g, a, b);
    renderStatus(g, a, b);
    renderActions(g, a, b);
    renderMe(g);
    animateCards(g, snap);

    for (const ev of g.events) {
      if (ev.id <= S.seenEvent) continue;
      S.seenEvent = ev.id;
      const msg = eventText(g, ev);
      if (msg) toast(msg.text, msg.kind);
    }
  }

  function renderOpponents(g) {
    const n = g.names.length; const me = g.me;
    if (!G.built) {
      const host = $('opponents'); host.innerHTML = '';
      for (let k = 1; k < n; k++) {
        const idx = me >= 0 ? (me + k) % n : k - 1;
        const box = el('div', 'opp');
        const fan = el('div', 'fan');
        const pill = el('div', 'seat-pill');
        const ring = el('div', 'ava-ring');
        ring.append(avatar(g.names[idx]));
        ring.insertAdjacentHTML('beforeend', `<svg class="tring" viewBox="0 0 40 40" aria-hidden="true"><circle class="bg" cx="20" cy="20" r="18"/><circle class="fg" cx="20" cy="20" r="18" stroke-dasharray="${RING_C}" stroke-dashoffset="0"/></svg>`);
        const txt = el('div', 'txt');
        const nm = el('span', 'nm'); const cnt = el('span', 'cnt');
        txt.append(nm, cnt); pill.append(ring, txt);
        const roleSlot = el('div', 'role-slot');
        const bubble = el('div', 'bubble', 'пас'); bubble.hidden = true;
        box.append(fan, pill, roleSlot, bubble);
        host.append(box);
        G.opps[idx] = { box, fan, ring, nm, cnt, roleSlot, bubble, roleKey: '', fg: ring.querySelector('.fg'), dl: 0, lowT: null };
      }
      G.built = true;
    }
    G.opps.forEach((o, idx) => {
      if (!o) return;
      const p = g.players[idx]; const info = g.names[idx];
      if (o.nm.textContent !== info.name) o.nm.textContent = info.name;
      const cnt = p.out ? (p.place === 1 ? 'вийшов першим' : `вийшов · ${p.place}`) : cardsWord(p.cards);
      if (o.cnt.textContent !== cnt) o.cnt.textContent = cnt;
      const shown = Math.min(p.cards, 8);
      while (o.fan.children.length < shown) { const bk = el('div', 'back enter'); o.fan.append(bk); }
      while (o.fan.children.length > shown) o.fan.lastElementChild.remove();
      const mid = (shown - 1) / 2;
      [...o.fan.children].forEach((bk, j) => {
        bk.style.rotate = `${((j - mid) * 7).toFixed(1)}deg`;
        bk.style.translate = `0 ${(Math.abs(j - mid) * 1.6).toFixed(1)}px`;
      });
      const role = roleOf(g, idx);
      const rk = role ? role.cls + role.text : '';
      if (o.roleKey !== rk) {
        o.roleKey = rk; o.roleSlot.innerHTML = '';
        if (role) o.roleSlot.append(el('span', 'role ' + role.cls, role.text));
      }
      const turn = g.required.includes(idx) && !g.over;
      o.box.classList.toggle('turn', turn);
      o.box.classList.toggle('away', !info.connected);
      runCountdown(o, turn && g.deadline ? g.deadline : 0);
      o.bubble.hidden = !(p.passed && !p.out && !g.over);
    });
  }

  function renderPile(g) {
    const sig = `${g.deck}|${g.trumpCard.id}`;
    if (G.pileSig !== sig) {
      G.pileSig = sig;
      const pile = $('pile'); pile.innerHTML = '';
      pile.append(el('span', 'trump-label', 'козир'));
      if (g.deck > 0) {
        const tc = cardEl(g.trumpCard, g.trump); tc.classList.add('trump'); pile.append(tc);
        if (g.deck > 1) pile.append(el('div', 'back top'));
        pile.append(el('span', 'count', String(g.deck)));
      } else {
        pile.append(el('div', 'suit-badge' + (R.isRed(g.trump) ? ' red' : ''), g.trump));
      }
    }
    const d = g.discard ? `Бито: ${g.discard}` : '';
    if ($('discard').textContent !== d) $('discard').textContent = d;
  }

  function clearHandStyles(e) {
    e.style.marginLeft = ''; e.style.rotate = ''; e.style.top = '';
    e.classList.remove('ok', 'no', 'sel');
    e.removeAttribute('tabindex'); e.removeAttribute('role');
  }

  function renderTable(g, a, b) {
    const me = g.me; const n = g.names.length;
    const selCard = S.sel ? g.hand.find((c) => c.id === S.sel) : null;
    const felt = document.querySelector('.felt');
    let tag = felt.querySelector('.taking-tag');
    if (b.taking && !g.over) {
      if (!tag) { tag = el('div', 'taking-tag'); felt.append(tag); }
      tag.textContent = b.defender === me ? 'Ви берете' : `${nameOf(g, b.defender)} бере`;
    } else if (tag) tag.remove();

    const nodes = [];
    if (!b.table.length) {
      let hint;
      if (g.over) hint = 'Партію завершено';
      else if (a.throw) hint = 'Ваш хід. Торкніться карти, щоб атакувати.';
      else hint = `${nameOf(g, b.attacker)} ${b.attacker === me ? 'ходите' : 'обирає карту'}…`;
      let h = $('battle').querySelector('.empty-hint');
      if (!h) h = el('div', 'empty-hint');
      if (h.textContent !== hint) h.textContent = hint;
      nodes.push(h);
    }
    b.table.forEach((p, i) => {
      let pair = G.pairs.get(p.a.id);
      if (!pair) { pair = el('div', 'pair'); G.pairs.set(p.a.id, pair); }
      const ac = cardNode(p.a, g.trump);
      clearHandStyles(ac); ac.classList.remove('def');
      ac.dataset.pair = i; ac.dataset.by = p.aBy;
      if (pair.firstElementChild !== ac) pair.prepend(ac);
      let dc = null;
      if (p.d) {
        dc = cardNode(p.d, g.trump);
        clearHandStyles(dc); dc.classList.add('def');
        dc.dataset.pair = i; dc.dataset.by = p.dBy;
        if (dc.parentElement !== pair) ac.after(dc);
      }
      let by = pair.querySelector('.by');
      if (n > 2) { if (!by) { by = el('span', 'by'); pair.append(by); } by.textContent = nameOf(g, p.aBy); } else if (by) by.remove();

      const canTarget = !!(selCard && a.defend && !p.d);
      const beatsIt = canTarget && R.beats(p.a, selCard, g.trump);
      pair.classList.toggle('target', canTarget && (beatsIt || g.cheat));
      pair.classList.toggle('cheaty', canTarget && !beatsIt && g.cheat);
      const accuse = g.cheat && a.accuse;
      ac.classList.toggle('accusable', !!accuse && p.aBy !== me);
      ac.classList.toggle('marked', S.mark === p.a.id);
      if (dc) { dc.classList.toggle('accusable', !!accuse && p.dBy !== me); dc.classList.toggle('marked', S.mark === p.d.id); }
      nodes.push(pair);
    });
    syncChildren($('battle'), nodes);
    for (const [id, pe] of G.pairs) if (!pe.isConnected) G.pairs.delete(id);
  }

  function renderHand(g, a, b) {
    const hand = $('hand'); const table = b.table;
    const active = !!(a.defend || a.throw);
    hand.classList.toggle('active', active);
    hand.classList.toggle('cheat', !!g.cheat);
    const unbeaten = table.filter((p) => !p.d);
    const nodes = g.hand.map((c) => {
      const e = cardNode(c, g.trump);
      e.classList.remove('def', 'accusable', 'marked');
      delete e.dataset.pair; delete e.dataset.by;
      e.tabIndex = 0; e.setAttribute('role', 'button');
      let ok = false;
      if (a.defend) ok = unbeaten.some((p) => R.beats(p.a, c, g.trump)) || (a.transfer && R.canTransferCard(table, c));
      else if (a.throw) ok = R.canThrowCard(table, c);
      e.classList.toggle('ok', active && ok);
      e.classList.toggle('no', active && !ok);
      e.classList.toggle('sel', S.sel === c.id);
      return e;
    });
    syncChildren(hand, nodes);
    layoutHand();
  }

  function layoutHand() {
    const h = $('hand'); const cards = [...h.children]; const n = cards.length;
    if (!n) return;
    const cw = cards[0].offsetWidth; const W = h.clientWidth - 8;
    const step = n > 1 ? Math.min(cw * 0.94, (W - cw) / (n - 1)) : 0;
    const mid = (n - 1) / 2;
    const spread = Math.min(3.5, 28 / n);
    cards.forEach((c, i) => {
      const d = i - mid;
      c.style.marginLeft = i ? `${step - cw}px` : '0';
      c.style.rotate = `${(d * spread).toFixed(2)}deg`;
      c.style.top = `${(d * d * spread * 0.22).toFixed(1)}px`;
    });
  }
  addEventListener('resize', () => { if (!$('scrGame').hidden) layoutHand(); });

  const degOf = (r) => { const v = parseFloat(r); return Number.isFinite(v) ? v : 0; };
  const baseTransform = (e) => { const t = getComputedStyle(e).transform; return !t || t === 'none' ? '' : t; };

  function animateCards(g, snap) {
    const handBox = $('hand').getBoundingClientRect();
    const anchor = (k) => {
      if (k === g.me) return centerOf(handBox);
      const o = G.opps[k];
      return o ? centerOf(o.ring.getBoundingClientRect()) : centerOf($('battle').getBoundingClientRect());
    };
    for (const e of G.cards.values()) if (e.isConnected) e.getAnimations().forEach((an) => an.cancel());
    const pileC = centerOf($('pile').getBoundingClientRect());
    let dealt = 0;
    for (const [id, e] of G.cards) {
      if (!e.isConnected) continue;
      const now = centerOf(e.getBoundingClientRect());
      const rot = cssRot(e);
      const base = baseTransform(e);
      const prev = snap.get(id);
      if (prev) {
        e._fresh = false;
        if (reduceMotion) continue;
        const dx = prev.c.x - now.x; const dy = prev.c.y - now.y;
        const dr = degOf(prev.rot) - degOf(rot);
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(dr) < 0.1) continue;
        e.animate([
          { transform: `translate(${dx}px, ${dy}px) rotate(${dr}deg) ${base}` },
          { transform: base || 'none' },
        ], { duration: MOVE_MS, easing: EASE });
      } else if (e._fresh) {
        e._fresh = false;
        if (reduceMotion) { e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 }); continue; }
        const inHand = !!e.closest('#hand');
        const from = inHand ? pileC : anchor(Number(e.dataset.by));
        const delay = inHand ? Math.min(dealt++, 8) * 55 : 0;
        e.animate([
          { transform: `translate(${from.x - now.x}px, ${from.y - now.y}px) scale(.55) ${base}`, opacity: 0, offset: 0 },
          { opacity: 1, offset: 0.3 },
          { transform: base || 'none', opacity: 1, offset: 1 },
        ], { duration: MOVE_MS + 40, easing: EASE, delay, fill: 'backwards' });
      }
    }
    // cards that left the table: beaten off, taken by an opponent, or swept up by a caught cheat
    const lb = g.lastBout;
    for (const [id, e] of [...G.cards]) {
      if (e.isConnected) continue;
      G.cards.delete(id);
      const prev = snap.get(id);
      if (!prev) continue;
      let dest;
      if (lb && lb.caught) dest = anchor(lb.caught.cheater);
      else if (lb && lb.taken) dest = anchor(lb.defender);
      else dest = centerOf($('discard').getBoundingClientRect());
      flyGhost(e, prev, dest);
    }
  }

  function flyGhost(e, prev, dest) {
    const gh = e.cloneNode(true);
    gh.classList.remove('sel', 'ok', 'no', 'marked', 'accusable', 'def');
    gh.classList.add('fly');
    gh.style.cssText = `left:${prev.c.x - prev.w / 2}px;top:${prev.c.y - prev.h / 2}px`;
    document.body.append(gh);
    const r = degOf(prev.rot);
    const frames = reduceMotion
      ? [{ opacity: 1, transform: `rotate(${r}deg)` }, { opacity: 0, transform: `rotate(${r}deg)` }]
      : [
        { transform: `translate(0px, 0px) rotate(${r}deg) scale(1)`, opacity: 1 },
        { transform: `translate(${dest.x - prev.c.x}px, ${dest.y - prev.c.y}px) rotate(${r}deg) scale(.4)`, opacity: 0 },
      ];
    const an = gh.animate(frames, { duration: reduceMotion ? 200 : 380, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' });
    const done = () => gh.remove();
    an.finished.then(done, done);
  }

  function roleOf(g, k) {
    const p = g.players[k]; const b = g.bout;
    if (p.out) return { cls: 'out', text: p.place === 1 ? 'вийшов першим' : `вийшов · ${p.place}` };
    if (g.over) return g.loser === k ? { cls: 'def', text: 'дурень' } : null;
    if (!b) return null;
    if (k === b.defender) return { cls: 'def', text: b.taking ? 'бере' : 'відбивається' };
    if (k === b.attacker) return { cls: 'att', text: 'ходить' };
    return null;
  }

  function passLabel(g, b) {
    if (b.taking) return 'Досить';
    return b.table.length && b.table.every((p) => p.d) ? 'Бито' : 'Пас';
  }

  function renderStatus(g, a, b) {
    let main = ''; let sub = '';
    const me = g.me;
    const others = g.required.filter((k) => k !== me);
    if (g.over) {
      main = g.loser === null ? 'Нічия' : (g.loser === me ? 'Ви — дурень' : `${nameOf(g, g.loser)} — дурень`);
    } else if (a.defend) {
      main = 'Відбивайтесь';
      sub = a.transfer ? 'Побийте карту або переведіть атаку картою того самого номіналу' : 'Оберіть карту, потім карту на столі. Або «Беру».';
      if (g.cheat) sub += ' Можна й схитрувати.';
    } else if (me === b.defender && b.taking) {
      main = 'Ви берете'; sub = 'Суперники ще можуть підкинути';
    } else if (a.throw && !b.table.length) {
      main = 'Ваш хід'; sub = 'Торкніться карти, щоб атакувати';
    } else if (a.throw) {
      main = b.taking ? 'Підкиньте вдогонку' : 'Можна підкинути';
      const ranks = [...R.tableRanks(b.table)].sort((x, y) => x - y).map(R.rankLabel).join(', ');
      sub = `Номінали на столі: ${ranks}. Або «${passLabel(g, b)}».`;
    } else if (g.required.includes(me)) {
      main = b.table.every((p) => p.d) && !b.taking ? 'Відбито' : 'Ваше рішення';
      sub = `Натисніть «${passLabel(g, b)}», коли будете готові`;
    } else if (others.length) {
      main = others.length === 1 ? `Чекаємо: ${nameOf(g, others[0])}` : 'Чекаємо на інших гравців';
      if (b.taking) sub = `${nameOf(g, b.defender)} бере карти`;
    }
    const sig = main + '|' + sub;
    if (G.statusSig === sig) return;
    G.statusSig = sig;
    const st = $('status');
    st.innerHTML = '';
    st.append(main);
    if (sub) st.append(el('small', null, sub));
    if (!reduceMotion) st.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: EASE });
  }

  function renderActions(g, a, b) {
    const list = [];
    const add = (text, cls, fn) => list.push({ text, cls, fn });
    const selCard = S.sel ? g.hand.find((c) => c.id === S.sel) : null;
    if (!g.over) {
      if (S.mark) {
        add('Скасувати', 'ghost', () => { S.mark = null; renderGame(S.room); });
        add('Викрити!', 'danger', () => act({ type: 'accuse', card: S.mark }));
      } else {
        if (selCard && a.transfer && (R.canTransferCard(b.table, selCard) || g.cheat)) {
          const honest = R.canTransferCard(b.table, selCard);
          add(honest ? 'Перевести' : 'Перевести (нечесно)', honest ? '' : 'cheat', () => act({ type: 'transfer', card: selCard.id }));
        }
        if (selCard && a.throw && !R.canThrowCard(b.table, selCard) && g.cheat) {
          add('Підкинути нечесно', 'cheat', () => act({ type: 'throw', card: selCard.id }));
        }
        if (a.take) add('Беру', 'ghost', () => act({ type: 'take' }));
        if (a.pass && (g.required.includes(g.me) || g.throwMode === 'free')) add(passLabel(g, b), '', () => act({ type: 'pass' }));
      }
    }
    const box = $('actions');
    const sig = list.map((x) => x.text + x.cls).join('|');
    if (sig !== G.actSig) {
      G.actSig = sig; box.innerHTML = '';
      for (const x of list) { const btn = el('button', 'btn ' + x.cls, x.text); btn.type = 'button'; box.append(btn); }
    }
    [...box.children].forEach((btn, i) => { btn.onclick = list[i] ? list[i].fn : null; });
  }

  function renderMe(g) {
    const me = g.me;
    const ml = $('meLine');
    const role = me >= 0 ? roleOf(g, me) : null;
    const sig = me >= 0 ? `${g.hand.length}|${role ? role.text : ''}` : '';
    if (ml.dataset.sig !== sig) {
      ml.dataset.sig = sig; ml.innerHTML = '';
      if (me >= 0) {
        ml.append(el('span', null, `Ви · ${cardsWord(g.hand.length)}`));
        if (role) ml.append(el('span', 'role ' + role.cls, role.text));
      }
    }
    const t = $('myTimer');
    const mine = g.required.includes(me) && !!g.deadline && !g.over;
    t.classList.toggle('on', mine);
    runBar(t, mine ? g.deadline : 0);
  }

  async function act(action) {
    const r = await emit('act', action);
    if (r.ok) { S.sel = null; S.mark = null; } else if (S.room) renderGame(S.room);
  }

  function onHandCard(id) {
    const v = S.room; if (!v || !v.game) return;
    const g = v.game; const a = g.actions || {}; const table = g.bout ? g.bout.table : [];
    const card = g.hand.find((c) => c.id === id); if (!card) return;
    S.mark = null;
    if (S.sel === id) { S.sel = null; return renderGame(v); }
    if (a.defend) {
      const unbeaten = table.map((p, i) => i).filter((i) => !table[i].d);
      const transferable = a.transfer && R.canTransferCard(table, card);
      const targets = unbeaten.filter((i) => R.beats(table[i].a, card, g.trump));
      if (!transferable && unbeaten.length === 1 && targets.length === 1) return act({ type: 'defend', card: id, target: targets[0] });
      if (!g.cheat && !transferable && !targets.length) return toast('Ця карта нічого не б\'є');
      S.sel = id; return renderGame(v);
    }
    if (a.throw) {
      if (R.canThrowCard(table, card)) return act({ type: 'throw', card: id });
      if (g.cheat) { S.sel = id; return renderGame(v); }
      return toast('Підкидати можна лише карти номіналів, що є на столі');
    }
    if (g.bout && g.bout.defender === g.me && g.bout.taking) return toast('Ви берете карти — чекаємо, поки суперники підкинуть');
  }

  function onTableCard(target) {
    const v = S.room; if (!v || !v.game) return;
    const g = v.game; const a = g.actions || {}; const table = g.bout.table;
    const pi = Number(target.dataset.pair); const pair = table[pi];
    const isAttack = !target.classList.contains('def');
    if (S.sel && a.defend && pair && !pair.d && isAttack) {
      const card = g.hand.find((c) => c.id === S.sel);
      const ok = card && R.beats(pair.a, card, g.trump);
      if (ok || g.cheat) return act({ type: 'defend', card: S.sel, target: pi });
      return toast('Ця карта не б\'є обрану');
    }
    if (g.cheat && a.accuse && Number(target.dataset.by) !== g.me) {
      S.sel = null;
      S.mark = S.mark === target.dataset.card ? null : target.dataset.card;
      renderGame(v);
    }
  }

  $('hand').addEventListener('click', (e) => { const c = e.target.closest('.card'); if (c) onHandCard(c.dataset.card); });
  $('hand').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset.card) { e.preventDefault(); onHandCard(e.target.dataset.card); }
  });
  $('battle').addEventListener('click', (e) => { const c = e.target.closest('.card'); if (c) onTableCard(c); });

  function eventText(g, ev) {
    const me = g.me; const nm = (k) => nameOf(g, k);
    switch (ev.type) {
      case 'start': return { text: `Козир ${ev.trump}. Першим ходить: ${nm(ev.by)}${ev.lowTrump ? ` (найменший козир ${R.rankLabel(ev.lowTrump)})` : ''}` };
      case 'transfer': return { text: ev.by === me ? `Ви переводите на ${nm(ev.to)}` : `${nm(ev.by)} переводить на ${ev.to === me ? 'вас' : nm(ev.to)}` };
      case 'took': return { text: ev.by === me ? `Ви забираєте ${cardsWord(ev.count)}` : `${nm(ev.by)} забирає ${cardsWord(ev.count)}` };
      case 'out': return { text: ev.by === me ? 'Ви вийшли з гри!' : `${nm(ev.by)} виходить з гри` };
      case 'caught':
        if (ev.by === me) return { text: `Викрито! ${nm(ev.cheater)} махлював(ла) і забирає ${cardsWord(ev.count)}`, kind: 'cheat' };
        if (ev.cheater === me) return { text: `${nm(ev.by)} вас викрив(ла)! Ви забираєте ${cardsWord(ev.count)}`, kind: 'alarm' };
        return { text: `${nm(ev.by)} викриває ${nm(ev.cheater)}! Шахрай забирає ${cardsWord(ev.count)}`, kind: 'cheat' };
      case 'falseAccuse':
        if (ev.by === me) return { text: `${nm(ev.accused)} грав(ла) чесно. ${ev.penalty ? 'Ви берете штрафну карту' : 'Штрафу немає — колода порожня'}`, kind: 'alarm' };
        return { text: `${nm(ev.by)} помилково звинувачує ${ev.accused === me ? 'вас' : nm(ev.accused)} і бере штрафну карту`, kind: 'cheat' };
      default: return null;
    }
  }

  /* turn timers: one CSS transition per turn, so the ring and bar drain at a steady 60 fps */
  function runCountdown(o, deadline) {
    if (o.dl === deadline) return;
    o.dl = deadline;
    clearTimeout(o.lowT); o.box.classList.remove('low');
    const fg = o.fg;
    fg.style.transition = 'none';
    if (!deadline) { fg.style.strokeDashoffset = '0'; return; }
    const left = Math.max(0, deadline - (Date.now() + S.clockOffset));
    fg.style.strokeDashoffset = String(RING_C * (1 - Math.min(1, left / TURN_MS)));
    fg.getBoundingClientRect();
    fg.style.transition = `stroke-dashoffset ${left}ms linear, stroke .3s`;
    fg.style.strokeDashoffset = String(RING_C);
    o.lowT = setTimeout(() => o.box.classList.add('low'), Math.max(0, left - 8000));
  }
  let barDl = 0; let barLowT = null;
  function runBar(t, deadline) {
    if (barDl === deadline) return;
    barDl = deadline;
    clearTimeout(barLowT); t.classList.remove('low');
    const bar = t.firstElementChild;
    bar.style.transition = 'none';
    if (!deadline) { bar.style.transform = 'scaleX(1)'; return; }
    const left = Math.max(0, deadline - (Date.now() + S.clockOffset));
    bar.style.transform = `scaleX(${Math.min(1, left / TURN_MS)})`;
    bar.getBoundingClientRect();
    bar.style.transition = `transform ${left}ms linear, background .3s`;
    bar.style.transform = 'scaleX(0)';
    barLowT = setTimeout(() => t.classList.add('low'), Math.max(0, left - 8000));
  }

  /* ---------------- result ---------------- */
  function showResult(v) {
    if (!v || !v.game || !v.game.over) return;
    const g = v.game; const me = g.me;
    const myPlace = me >= 0 ? g.players[me].place : null;
    let title; let suit = '♠';
    if (g.loser === null) { title = 'Нічия'; suit = '♦'; } else if (g.loser === me) { title = 'Ви — дурень'; } else if (myPlace === 1) { title = 'Перемога!'; suit = '♥'; } else { title = `${myPlace}-е місце. Не дурень!`; suit = '♣'; }
    $('resTitle').textContent = title;
    $('resSuit').textContent = suit;
    $('resSuit').style.color = R.isRed(suit) ? 'var(--red)' : 'var(--text)';
    const list = $('resPlaces'); list.innerHTML = '';
    const order = g.players.map((p, i) => ({ ...p, i })).sort((x, y) => (x.place || 99) - (y.place || 99));
    for (const p of order) {
      const li = el('li', p.i === g.loser ? 'durak' : '');
      const info = g.names[p.i];
      li.append(el('b', null, p.i === me ? `${info.name} (ви)` : info.name));
      li.append(` — ${p.i === g.loser ? 'дурень' : (p.place === 1 ? 'вийшов першим' : 'вийшов')}`);
      if (info.durak) li.append(` · дурнем ${info.durak} ${plural(info.durak, 'раз', 'рази', 'разів')}`);
      list.append(li);
    }
    $('resAgain').hidden = !v.isHost;
    $('resWait').hidden = v.isHost;
    $('resLeave').textContent = v.solo ? 'У меню' : 'До кімнати';
    $('result').hidden = false;
  }
  $('resAgain').addEventListener('click', () => { $('result').hidden = true; emit('start'); });
  $('resLeave').addEventListener('click', () => {
    $('result').hidden = true;
    if (S.room && !S.room.solo) { S.viewLobby = true; onRoom(S.room); } else leaveRoom();
  });

  /* ---------------- leave / rules ---------------- */
  $('gameLeave').addEventListener('click', () => {
    const v = S.room;
    if (v && v.game && v.game.over) { if (v.solo) return leaveRoom(); S.viewLobby = true; return onRoom(v); }
    $('confirmTitle').textContent = 'Вийти з гри?';
    $('confirmText').textContent = v && v.solo ? 'Поточна партія буде втрачена.' : 'Ваше місце до кінця партії займе бот.';
    $('confirm').hidden = false;
  });
  $('confirmNo').addEventListener('click', () => { $('confirm').hidden = true; });
  $('confirmYes').addEventListener('click', () => { $('confirm').hidden = true; leaveRoom(); });
  const openRules = () => { $('rules').hidden = false; };
  $('rulesBtn').addEventListener('click', openRules);
  $('gameRules').addEventListener('click', openRules);
  $('rulesClose').addEventListener('click', () => { $('rules').hidden = true; });
  for (const id of ['rules', 'setup', 'confirm']) $(id).addEventListener('click', (e) => { if (e.target.id === id) $(id).hidden = true; });

  boot();
})();
