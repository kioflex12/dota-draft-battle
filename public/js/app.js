import { $, $$, esc, heroImg, heroVert, heroVertBg, vertFallback, heroRender, ATTR_ICON, ATTR_NAME, toast, bindTooltip, beep, store, fmtPct, flashTitle } from './util.js';
import { renderHeroPanel } from './heroPanel.js';
import { renderResult } from './result.js';
import { Net } from './net.js';
import { buildIndex, score, norm } from './search.js';
import { createEngine, ROLE_KEYS, ROLE_NAMES, toPct } from '../shared/analysis.js';
import { SEQUENCE, PHASES, TEAM_NAME, currentTurn, stepSlots, teamOfStep, usedHeroes } from '../shared/draft.js';

const S = {
  engine: null, heroes: [], byId: new Map(), searchIdx: null,
  net: null, room: null, you: {}, clockOffset: 0,
  screen: null, selected: null, search: '', role: null,
  portraits: store('portraits') !== '0',
  resultView: null, lastStep: -1, lastTick: -1, pendingJoin: null, slotsKey: null,
  chatLast: null, chatUnread: 0, hoverHint: null,
  conn: { state: 'connecting', ms: null, lastPong: 0 }, lastJoin: null, version: null,
};

const token = store('token') || (() => { const t = Math.random().toString(36).slice(2) + Date.now().toString(36); store('token', t); return t; })();

const EMBLEM = {
  radiant: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="32" cy="32" r="11" fill="currentColor" fill-opacity=".25"/><circle cx="32" cy="32" r="16"/>${[0, 45, 90, 135, 180, 225, 270, 315].map(a => `<line x1="32" y1="6" x2="32" y2="12" transform="rotate(${a} 32 32)"/>`).join('')}<path d="M32 2v4M62 32h-4M32 62v-4M2 32h4" opacity=".6"/></svg>`,
  dire: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"><path d="M32 6c3 9 12 13 12 24 0 8-5 14-12 16-7-2-12-8-12-16 0-11 9-15 12-24z" fill="currentColor" fill-opacity=".25"/><path d="M32 22c1.5 5 6 7 6 13 0 4-2.5 7-6 8-3.5-1-6-4-6-8 0-6 4.5-8 6-13z" fill="currentColor" fill-opacity=".5"/><path d="M14 46l-6 10M50 46l6 10M22 54l-2 6M42 54l2 6" opacity=".6"/></svg>`,
};

// ---------------- boot ----------------

// Heroes and stats together weigh about two megabytes; on a phone that is seconds of silence
// under a spinner, so the loading screen reports how much has arrived.
async function loadJson(url, onMeta, onChunk) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${String(url).split('/').pop()}: ${res.status}`);
  onMeta(Number(res.headers.get('content-length')) || 0);
  if (!res.body) return res.json();
  const reader = res.body.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    onChunk(value.length);
  }
  return JSON.parse(await new Blob(parts).text());
}

async function boot() {
  // A response served from cache carries no length, and then there is nothing to take a percentage
  // of — in that case show how much has arrived instead.
  const progress = { got: 0, total: 0 };
  const note = $('#loading .load-note');
  const onMeta = t => { progress.total += t; };
  const onChunk = n => {
    progress.got += n;
    note.textContent = progress.total
      ? `${Math.min(99, Math.round(progress.got / progress.total * 100))}%`
      : `${(progress.got / 1048576).toFixed(1)} МБ`;
  };
  const [hd, st] = await Promise.all([
    loadJson(new URL('../data/heroes.json', import.meta.url), onMeta, onChunk),
    loadJson(new URL('../data/stats.json', import.meta.url), onMeta, onChunk),
  ]);
  S.heroes = hd.heroes;
  S.byId = new Map(S.heroes.map(h => [h.id, h]));
  S.engine = createEngine(S.heroes, st);
  S.searchIdx = buildIndex(S.heroes);
  $('#patch-label').textContent = hd.patch;
  $('#data-label').textContent = `${st.meta.proMatches.toLocaleString('ru')} про-матчей с ${st.meta.proSince} · ${st.meta.pubMatches.toLocaleString('ru')} матчей Divine+`;
  $('#name-input').value = store('name') || '';
  $('#portraits-toggle').checked = S.portraits;
  buildGrid();
  buildRoleFilters();
  bindMenu();
  bindDraft();
  bindTooltip(document.body);
  $('#loading').classList.add('hidden');
  const code = codeFromLocation();
  if (code && /^[A-Z0-9]{5}$/i.test(code)) S.pendingJoin = code.toUpperCase();
  connect();
  setConn('connecting');
  watchConnLiveness();
  watchVersion();
  show('menu');
  setInterval(tick, 200);
}

function show(name) {
  if (S.screen === name) return;
  S.screen = name;
  openHeroSheet(false);
  queueMicrotask(() => setConn());
  $$('.screen').forEach(s => s.classList.toggle('hidden', s.id !== 'screen-' + name));
  window.scrollTo(0, 0);
}

// ---------------- network ----------------

// Комнату открывают и как ?room=КОД, и как /room/КОД (второй адрес умеет только свой сервер —
// на GitHub Pages статика раздаётся без маршрутов).
const ROOM_PATH = /\/room\/([A-Za-z0-9]{5})\/?$/;
const basePath = location.pathname.replace(ROOM_PATH, '/');
const roomUrl = code => `${location.origin}${basePath}?room=${code}`;
const codeFromLocation = () => {
  const q = new URLSearchParams(location.search).get('room');
  if (q) return q;
  const m = location.pathname.match(ROOM_PATH);
  return m ? m[1] : null;
};

function connect() {
  S.net = new Net({
    engine: S.engine,
    cmHeroes: S.heroes.filter(h => h.cm).map(h => h.id),
    forceP2P: new URLSearchParams(location.search).has('p2p'),
    onMessage,
    onOpen: () => {
      $('#net-label').textContent = S.net.mode === 'p2p'
        ? 'Сеть: напрямую между браузерами (WebRTC). Комната живёт, пока открыта вкладка её создателя.'
        : 'Сеть: сервер комнат.';
      setConn('ok');
      send({ t: 'hello', name: myName(), token });
      const code = S.pendingJoin || S.room?.code;
      if (code) { S.lastJoin = code; send({ t: 'join', code }); S.pendingJoin = null; }
    },
  });
}

// Тот же список, что и у самой игры: проверка должна мерить ровно то, чем играют.
const ICE_TEST = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

const send = msg => S.net?.send(msg);
const joinRoom = code => {
  S.lastJoin = code;
  $('#join-fail').hidden = true;
  send({ t: 'hello', name: myName(), token });
  send({ t: 'join', code });
};
const myName = () => ($('#name-input').value.trim() || 'Капитан').slice(0, 20);

function onMessage(msg) {
  if (msg.t === 'room') {
    const prev = S.room;
    S.room = msg.room;
    S.you = msg.you;
    S.clockOffset = msg.room.serverNow - Date.now();
    if (codeFromLocation() !== S.room.code) history.replaceState(null, '', basePath + '?room=' + S.room.code);
    renderRoom(prev);
  } else if (msg.t === 'error') {
    toast(msg.error);
    // Тост живёт пару секунд, а неудачный вход надо увидеть и переспросить: оставляем панель
    // с причиной и кнопкой повтора, иначе человек остаётся в меню без всякого объяснения.
    if (/Комната не найдена|Связь с комнатой потеряна|не отвечает/.test(msg.error) && S.lastJoin) showJoinFail(msg.error);
    if (msg.error.startsWith('Комната не найдена')) history.replaceState(null, '', basePath);
  } else if (msg.t === 'left') {
    S.room = null;
    S.chatLast = null;
    S.resultView = null;
    history.replaceState(null, '', basePath);
    show('menu');
  } else if (msg.t === 'hover') {
    showHover(msg.team, msg.hero);
  } else if (msg.t === 'netPing') {
    S.conn.lastPong = Date.now();
    // Порог взят с запасом: до трети секунды драфт ощущается живым.
    setConn(msg.ms > 350 ? 'slow' : 'ok', msg.ms);
  } else if (msg.t === 'disconnected') {
    setConn('retry');
    if (S.room) toast('Соединение потеряно, переподключение…');
  } else if (msg.t === 'reconnected') {
    setConn('ok');
    toast('Соединение восстановлено', true);
    setBanner(null);
  } else if (msg.t === 'joinRetry') {
    toast(`Комната не отвечает, пробуем ещё раз (${msg.attempt} из 2)…`);
  } else if (msg.t === 'queued') {
    setConn('waiting');
    if (msg.kind === 'action') setBanner('Нет связи — ход отправится, как только она вернётся');
    else toast('Нет связи, отправим как только восстановится');
  } else if (msg.t === 'queueSent') {
    setConn('ok');
    setBanner(null);
    toast('Связь вернулась, ход отправлен', true);
  } else if (msg.t === 'queueLost') {
    setConn('lost');
    setBanner(null);
    toast('Связь не восстановилась — ход не отправлен, попробуйте ещё раз');
  } else if (msg.t === 'hostState') {
    // Комната живёт, пока хост зарегистрирован на сигнальном сервере. Если регистрация слетела,
    // друг увидит «комната не найдена» — хозяину комнаты надо об этом сказать, а не молчать.
    setConn(msg.online ? 'ok' : 'retry');
    setBanner(msg.online ? null : 'Связь с сервером комнат потеряна — друг сейчас не сможет войти. Восстанавливаем…');
  }
}

// Only spectators receive this: shared/room.js sends hover to teammates and watchers, never to the
// opposing captain, so it cannot leak what a captain is about to take.
function showHover(team, hero) {
  if (S.you.team || S.screen !== 'draft') return;
  if (S.hoverHint) S.hoverHint.el.classList.remove('hover-r', 'hover-d');
  const el = $(`.hcell[data-hero="${hero}"]`);
  if (!el) { S.hoverHint = null; return; }
  el.classList.add(team === 'dire' ? 'hover-d' : 'hover-r');
  S.hoverHint = { el };
}

// Индикатор связи виден на всех экранах: как соединены, жива ли связь и какая задержка. Раньше
// о состоянии сети можно было узнать только по строке в подвале меню и по всплывающим сообщениям.
const CONN_TEXT = {
  connecting: () => ['wait', 'Соединение…'],
  ok: () => {
    const how = S.net?.mode === 'p2p' ? (S.net?.role === 'host' ? 'Напрямую · вы держите комнату' : 'Напрямую') : 'Сервер комнат';
    return ['ok', S.conn.ms != null ? `${how} · ${S.conn.ms} мс` : how];
  },
  slow: () => ['warn', `Связь медленная · ${S.conn.ms} мс`],
  retry: () => ['warn', 'Связь потеряна, восстанавливаем…'],
  waiting: () => ['warn', 'Нет связи — ход ждёт отправки'],
  lost: () => ['bad', 'Связи нет'],
};

function setConn(state, ms) {
  if (ms != null) S.conn.ms = ms;
  if (state) S.conn.state = state;
  const el = $('#conn');
  const [cls, text] = (CONN_TEXT[S.conn.state] || CONN_TEXT.connecting)();
  el.hidden = false;
  // На экране драфта место в углу занято блоком команды, поэтому в спокойном состоянии индикатор
  // сворачивается в точку, а текст возвращается, когда со связью что-то не так.
  const compact = S.screen === 'draft' && (S.conn.state === 'ok' || S.conn.state === 'connecting');
  el.className = 'conn ' + cls + (compact ? ' compact' : '');
  el.querySelector('.txt').textContent = text;
  el.dataset.tip = S.net?.mode === 'p2p'
    ? 'Игроки соединены напрямую через браузеры. Комната живёт, пока открыта вкладка её создателя.'
    : 'Игра идёт через сервер комнат — так надёжнее, чем напрямую.';
}

// Пропавший интернет не закрывает сокет сразу: страница может минуту считать, что всё хорошо.
// Поэтому связь считается живой, только пока приходят ответы на пинг.
function watchConnLiveness() {
  const expectsPong = () => S.net && (S.net.mode === 'ws' || (S.net.mode === 'p2p' && S.net.role === 'guest'));
  setInterval(() => {
    if (!expectsPong() || !S.conn.lastPong) return;
    const quiet = Date.now() - S.conn.lastPong;
    if (quiet > 25000 && S.conn.state !== 'retry' && S.conn.state !== 'lost' && S.conn.state !== 'waiting') setConn('retry');
  }, 2000);
}

// Проверка связи: показывает, что именно доступно с этой машины. Без неё разговор об обрывах
// упирается в догадки — «у меня не работает» против «а у меня работает».
async function runNetTest() {
  const box = $('#nettest');
  box.hidden = false;
  const lines = [];
  const draw = () => { box.innerHTML = lines.map(l => `<div class="nt ${l.k}">${l.t}</div>`).join(''); };
  const put = (k, t) => { lines.push({ k, t }); draw(); };
  lines.length = 0;
  put('wait', 'Проверяем…');

  // 1. Сервер комнат, если он настроен
  const server = S.net?.serverUrl;
  lines.length = 0;
  if (server) put(S.net.mode === 'ws' ? 'ok' : 'bad', `Сервер комнат: ${S.net.mode === 'ws' ? 'подключён' : 'не отвечает'}`);
  else put('warn', 'Сервер комнат не настроен — игра связывает браузеры напрямую');

  // 2. Сервер, который сводит игроков
  put('wait', 'Сервер поиска игроков: проверяем…');
  let Peer = null;
  try { Peer = await S.net.peerLib(); } catch {}
  const sig = await new Promise(res => {
    try {
      if (!Peer) return res('не удалось загрузить библиотеку соединения');
      const p = new Peer();
      const done = t => { try { p.destroy(); } catch {} res(t); };
      const timer = setTimeout(() => done('не ответил за 12 секунд'), 12000);
      p.on('open', () => { clearTimeout(timer); done('ok'); });
      p.on('error', e => { clearTimeout(timer); done(e.type || e.message); });
    } catch (e) { res(e.message); }
  });
  lines.pop();
  put(sig === 'ok' ? 'ok' : 'bad', `Сервер поиска игроков: ${sig === 'ok' ? 'доступен' : 'недоступен (' + sig + ')'}`);

  // 3. Виден ли внешний адрес и есть ли ретранслятор
  put('wait', 'Обход NAT: проверяем…');
  const ice = await new Promise(res => {
    const kinds = {};
    const pc = new RTCPeerConnection({ iceServers: ICE_TEST });
    pc.onicecandidate = e => {
      if (!e.candidate) return;
      const m = /(?: typ )(\w+)/.exec(e.candidate.candidate);
      if (m) kinds[m[1]] = (kinds[m[1]] || 0) + 1;
    };
    pc.createDataChannel('t');
    pc.createOffer().then(o => pc.setLocalDescription(o));
    setTimeout(() => { try { pc.close(); } catch {} res(kinds); }, 9000);
  });
  lines.pop();
  put(ice.srflx ? 'ok' : 'bad', `Внешний адрес виден: ${ice.srflx ? 'да' : 'нет'}`);
  put(ice.relay ? 'ok' : 'warn', ice.relay
    ? 'Ретранслятор доступен — соединение встанет даже через строгий NAT'
    : 'Ретранслятора нет. Если прямое соединение между вашими сетями не проходит, игра не соединится — нужен свой сервер комнат');
  draw();
}

function showJoinFail(reason) {
  const el = $('#join-fail');
  el.querySelector('.jf-text').innerHTML = `Не удалось войти в комнату <b>${esc(S.lastJoin)}</b>. ${esc(reason)}.<br>
    Комнату держит вкладка того, кто её создал: попросите его обновить страницу и прислать ссылку заново.`;
  el.hidden = false;
}

// Открытая вкладка не перечитывает файлы сама, поэтому у человека, который не перезагружал
// страницу, может работать давняя версия — со старыми ошибками. Сборка кладёт рядом отпечаток
// версии, а страница время от времени сверяется с ним.
async function watchVersion() {
  const read = async () => {
    try {
      const r = await fetch(new URL('../version.json', import.meta.url), { cache: 'no-store' });
      return r.ok ? (await r.json()).sha : null;
    } catch { return null; }
  };
  S.version = await read();
  if (!S.version) return;
  setInterval(async () => {
    const now = await read();
    if (now && S.version && now !== S.version) {
      setBanner('Вышла новая версия игры — обновите страницу, иначе будут старые ошибки');
      $('#banner').style.cursor = 'pointer';
      $('#banner').onclick = () => location.reload();
    }
  }, 180000);
}

function setBanner(text) {
  const el = $('#banner');
  el.textContent = text || '';
  el.hidden = !text;
}

function renderRoom(prev) {
  const r = S.room;
  // Роль в режиме «напрямую» становится известна уже после подключения, а задержка — после
  // первого обмена. Перерисовываем индикатор вместе с комнатой, чтобы текст не оставался старым.
  setConn();
  renderChat();
  if (r.phase === 'lobby') { renderLobby(); show('lobby'); return; }
  if (r.phase === 'coin') { renderCoin(prev); show('coin'); return; }
  if (r.phase === 'draft') {
    S.resultView = null;
    if (!prev || prev.phase !== 'draft') { S.selected = null; S.lastStep = -1; clearSearch(); renderHeroPanelFor(null); }
    renderDraft();
    show('draft');
    return;
  }
  if (r.phase === 'done') {
    if (S.screen === 'draft' && prev?.phase === 'draft') {
      renderDraft();
      beep(520, 0.25, 0.06);
      setTimeout(() => showResult(), 1400);
    } else if (S.resultView && S.screen === 'result') {
      S.resultView.update(r);
    } else showResult();
  }
}

function showResult() {
  if (S.room?.phase !== 'done') return;
  S.resultView = renderResult($('#result'), {
    engine: S.engine, room: S.room, you: S.you,
    onRematch: () => send({ t: 'rematch' }),
    onMenu: () => send({ t: 'leave' }),
    onOpenHero: openHeroModal,
  });
  show('result');
}

// ---------------- menu & lobby ----------------

const PRESETS = {
  dota: { order: 'coin', timers: true, firstBanTime: 15, turnTime: 30, reserve: 130, randomBan: false },
  fast: { timers: true, firstBanTime: 10, turnTime: 15, reserve: 60 },
  notimers: { timers: false },
};

function bindMenu() {
  $('#name-input').addEventListener('change', () => { store('name', myName()); send({ t: 'hello', name: myName(), token }); });
  $('#btn-create').onclick = () => {
    send({ t: 'hello', name: myName(), token });
    send({ t: 'create', mode: 'pvp', order: $('#pvp-order').value, timers: $('#pvp-timers').checked });
  };
  $('#btn-join').onclick = () => {
    const code = $('#join-code').value.trim().toUpperCase();
    if (code.length !== 5) { toast('Введите код из 5 символов'); return; }
    joinRoom(code);
  };
  $('#jf-retry').onclick = () => { $('#join-fail').hidden = true; if (S.lastJoin) joinRoom(S.lastJoin); };
  $('#jf-close').onclick = () => { $('#join-fail').hidden = true; };
  $('#btn-nettest').onclick = e => { e.target.disabled = true; runNetTest().finally(() => { e.target.disabled = false; }); };
  $('#join-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-join').click(); });
  $('#btn-bot').onclick = () => {
    const side = $('#bot-side').value;
    const o = $('#bot-order').value;
    const order = o === 'random' || o === 'coin' ? o : o === 'me' ? side : (side === 'radiant' ? 'dire' : 'radiant');
    send({ t: 'hello', name: myName(), token });
    send({ t: 'create', mode: 'bot', difficulty: $('#bot-diff').value, side, order, timers: $('#bot-timers').checked });
  };
  $('#btn-local').onclick = () => {
    send({ t: 'hello', name: myName(), token });
    send({ t: 'create', mode: 'local', order: $('#local-order').value, timers: $('#local-timers').checked });
  };

  $('#btn-copy').onclick = async () => {
    const field = $('#lobby-link');
    try {
      await navigator.clipboard.writeText(field.value);
      toast('Ссылка скопирована', true);
      return;
    } catch {}
    // navigator.clipboard exists only in a secure context, and a room shared over the local
    // network is plain http. Fall back to selecting the text so it can be copied by hand.
    field.classList.remove('visually-hidden');
    field.removeAttribute('tabindex');
    field.focus();
    field.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch {}
    toast(copied ? 'Ссылка скопирована' : 'Скопируйте ссылку из поля выше', copied);
  };
  $('#btn-swap').onclick = () => send({ t: 'swap' });
  $('#btn-start').onclick = () => send({ t: 'start' });
  $('#btn-lobby-leave').onclick = () => send({ t: 'leave' });
  $$('[data-set]').forEach(el => el.addEventListener('change', () => {
    const raw = el.type === 'checkbox' ? el.checked : el.value;
    send({ t: 'settings', [el.dataset.set]: raw === 'true' ? true : raw === 'false' ? false : raw });
  }));
  $('.presets').addEventListener('click', e => {
    const b = e.target.closest('[data-preset]');
    if (b) send({ t: 'settings', ...PRESETS[b.dataset.preset] });
  });
  $('.seats').addEventListener('click', e => {
    const b = e.target.closest('[data-sit]');
    if (b) send({ t: 'sit', team: b.dataset.sit });
  });
  $('#coin-opts').addEventListener('click', e => {
    const b = e.target.closest('[data-coin]');
    if (b) send({ t: 'coin', choice: b.dataset.coin });
  });

  $$('[data-chat]').forEach(box => {
    box.innerHTML = '<div class="chat-log"></div><input placeholder="Сообщение… (Enter)" maxlength="200">';
    box.addEventListener('click', clearChatUnread);
    box.querySelector('input').addEventListener('focus', clearChatUnread);
    box.querySelector('input').addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const v = e.target.value.trim();
      if (v) send({ t: 'chat', text: v });
      e.target.value = '';
    });
  });
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#modal').classList.add('hidden'); });
}

function presetMatch(st) {
  for (const [k, p] of Object.entries(PRESETS)) if (Object.entries(p).every(([f, v]) => st[f] === v)) return k;
  return null;
}

function renderLobby() {
  const r = S.room, st = r.settings;
  const iAmCaptain = !!S.you.team;
  $('#lobby-code').textContent = r.code;
  $('#lobby-link').value = roomUrl(r.code);
  $('#lobby-link-text').textContent = roomUrl(r.code);
  for (const t of ['radiant', 'dire']) {
    const s = r.seats[t];
    const el = $('#seat-' + t);
    el.classList.toggle('empty', !s);
    el.innerHTML = `
      <div class="emblem">${EMBLEM[t]}</div>
      <div class="side-title">${TEAM_NAME[t]}</div>
      <div class="who">${s ? esc(s.name) + (S.you.team === t ? '<span class="you-badge">ВЫ</span>' : '') : 'Свободное место'}</div>
      ${s
        ? `<div class="status"><span class="dot ${s.online ? 'on' : ''}"></span>${s.bot ? 'Бот' : s.online ? 'В сети' : 'Не в сети'}</div>`
        : iAmCaptain ? '<div class="status">Ждём второго капитана…</div>' : `<button class="btn sit" data-sit="${t}">Занять место</button>`}`;
  }
  $$('[data-set]').forEach(el => {
    const v = st[el.dataset.set];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
    el.disabled = !iAmCaptain;
  });
  $$('[data-needs-timers]').forEach(row => row.classList.toggle('off', !st.timers));
  const preset = presetMatch(st);
  $$('.presets button').forEach(b => { b.classList.toggle('on', b.dataset.preset === preset); b.disabled = !iAmCaptain; });
  $('#settings-note').textContent = {
    coin: 'Жребий: победитель выбирает первый/второй пик или сторону, проигравший решает оставшееся.',
    random: 'Первый пик достанется случайной команде.',
    radiant: 'Первый пик у Сил Света; при реванше очередь переходит сопернику.',
    dire: 'Первый пик у Сил Тьмы; при реванше очередь переходит сопернику.',
  }[st.order] + (st.timers
    ? ` Таймеры: баны I фазы ${st.firstBanTime} с, остальные ходы ${st.turnTime} с, резерв ${fmtTime(st.reserve)}. Просроченный пик — случайный герой, просроченный бан — ${st.randomBan ? 'случайный герой' : 'пропуск'}.`
    : ' Без ограничения времени.');
  const both = r.seats.radiant && r.seats.dire;
  $('#btn-start').disabled = !both || !iAmCaptain;
  const hint = $('#start-hint');
  hint.textContent = !iAmCaptain ? 'Вы зритель — начать могут только капитаны' : both ? 'Оба капитана на месте' : 'Ждём второго капитана — отправьте ссылку';
  hint.classList.toggle('ready', !!both && iAmCaptain);
  $('#btn-swap').disabled = !iAmCaptain || !!r.seats[S.you.team === 'radiant' ? 'dire' : 'radiant'];
  $('#lobby-spect').textContent = r.spectators.length ? 'Зрители: ' + r.spectators.join(', ') : '';
}

const COIN_TEXT = {
  first: ['Первый пик', 'Забираете героя первыми, но и банов в первой фазе у вас на один меньше'],
  second: ['Второй пик', 'Отвечаете на чужой пик и делаете последний выбор в драфте'],
  radiant: ['Играть за Силы Света', 'Нижняя линия лёгкая, верхняя сложная'],
  dire: ['Играть за Силы Тьмы', 'Верхняя линия лёгкая, нижняя сложная'],
};

function renderCoin(prev) {
  const r = S.room, c = r.coin;
  const chooser = c.stage === 'winner' ? c.winner : (c.winner === 'radiant' ? 'dire' : 'radiant');
  const mine = r.mode === 'local' ? !!S.you.team : S.you.team === chooser;
  const anim = $('#coin-anim');
  if (prev?.phase !== 'coin') {
    anim.className = 'coin' + (c.winner === 'dire' ? ' to-d' : '');
    void anim.offsetWidth;
  }
  const winnerName = esc(r.seats[c.winner]?.name || TEAM_NAME[c.winner]);
  const chooserName = esc(r.seats[chooser]?.name || TEAM_NAME[chooser]);
  const winnerColor = c.winner === 'radiant' ? 'var(--radiant-2)' : 'var(--dire-2)';
  const opts = c.stage === 'winner' ? ['first', 'second', 'radiant', 'dire'] : (['first', 'second'].includes(c.winnerChoice) ? ['radiant', 'dire'] : ['first', 'second']);
  const aboutOrder = ['first', 'second'].includes(opts[0]);

  $('#coin-title').innerHTML = mine && c.stage === 'winner'
    ? 'Вы выиграли жребий'
    : `Жребий выиграл <span style="color:${winnerColor}">${winnerName}</span>`;

  // Сначала одним предложением — что вообще происходит, потом отдельной строкой — что нажать.
  $('#coin-sub').innerHTML = c.stage === 'winner'
    ? 'Победитель жребия решает что-то одно: кто ходит в драфте первым или за какую сторону карты играет. Оставшееся выбирает проигравший.'
    : `Победитель жребия выбрал: <b>${COIN_TEXT[c.winnerChoice][0]}</b>. Остался второй вопрос — ${aboutOrder ? 'очередь пика' : 'сторона карты'}, и его решает проигравший жребий.`;

  const ask = $('#coin-ask');
  ask.textContent = mine
    ? (c.stage === 'winner' ? 'Выберите один из четырёх вариантов' : aboutOrder ? 'Выберите очередь пика' : 'Выберите сторону')
    : `Выбирает ${chooserName} — ждём`;
  ask.classList.toggle('waiting', !mine);

  // Стороны красим в их собственный цвет, очередь пика оставляем нейтральной: подсветка одного
  // из равноправных вариантов читалась как совет «бери вот это».
  $('#coin-opts').innerHTML = opts.map(o => `<button class="btn ${o === 'radiant' ? 'coin-r' : o === 'dire' ? 'coin-d' : ''}" data-coin="${o}" ${mine ? '' : 'disabled'}>${COIN_TEXT[o][0]}<small>${COIN_TEXT[o][1]}</small></button>`).join('');
}

const chatLine = m => (m.sys
  ? `<div class="sys">${esc(m.text)}</div>`
  : `<div><span class="n-${m.team || 'spec'}">${esc(m.name)}:</span> ${esc(m.text)}</div>`);

// Only new lines are appended: rebuilding the log on every pick threw away the reader's selection
// and the scroll position mid-sentence.
function renderChat() {
  const r = S.room;
  let from = 0;
  if (S.chatLast) {
    const i = r.chat.findLastIndex(m => m.at === S.chatLast.at && m.text === S.chatLast.text);
    from = i < 0 ? -1 : i + 1;
  }
  const fresh = from < 0 ? r.chat : r.chat.slice(from);
  if (!fresh.length && from >= 0) return;
  S.chatLast = r.chat.length ? { at: r.chat[r.chat.length - 1].at, text: r.chat[r.chat.length - 1].text } : null;
  for (const log of $$('[data-chat] .chat-log')) {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
    if (from < 0) log.innerHTML = r.chat.map(chatLine).join('');
    else log.insertAdjacentHTML('beforeend', fresh.map(chatLine).join(''));
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  const theirs = fresh.filter(m => !m.sys && m.name !== myName());
  if (S.screen === 'draft' && theirs.length) markChatUnread(theirs.length);
}

// The chat sits under the hero panel during a draft, so a new line is easy to miss.
function markChatUnread(n) {
  const box = $('.draft-chat');
  if (!box || document.activeElement === box.querySelector('input')) return;
  S.chatUnread += n;
  box.dataset.unread = S.chatUnread;
}

function clearChatUnread() {
  S.chatUnread = 0;
  const box = $('.draft-chat');
  if (box) delete box.dataset.unread;
}

// ---------------- draft: grid, search ----------------

function buildGrid() {
  const grid = $('#hero-grid');
  const groups = [0, 1, 2, 3].map(a => S.heroes.filter(h => h.attr === a).sort((x, y) => x.name.localeCompare(y.name)));
  grid.innerHTML = groups.map((list, a) => `
    <div class="attr-block">
      <div class="attr-head a${a}"><img src="${ATTR_ICON[a]}" alt="">${ATTR_NAME[a]}</div>
      <div class="attr-cells">${list.map(h => `<div class="hcell ${h.cm ? '' : 'disabled-cm'}" data-hero="${h.id}" data-tip="<div class='tt-h'>${esc(h.name)}</div>${ROLE_KEYS.filter((k, i) => (h.roleLevels?.[i] || 0) > 0).map(k => ROLE_NAMES[k]).join(' · ')}"><img loading="lazy" src="${heroVert(h.key)}" ${vertFallback(h.key)} alt="${esc(h.name)}"><span class="hname">${esc(h.name)}</span></div>`).join('')}</div>
    </div>`).join('');
}

function buildRoleFilters() {
  const keys = ['carry', 'support', 'nuker', 'disabler', 'durable', 'escape', 'pusher', 'initiator'];
  $('#role-filters').innerHTML = keys.map(k => `<button data-role="${k}" aria-pressed="false">${ROLE_NAMES[k]}</button>`).join('');
}

function bindDraft() {
  const search = $('#hero-search');
  $('#hero-grid').addEventListener('click', e => {
    const c = e.target.closest('[data-hero]');
    if (c) selectHero(Number(c.dataset.hero));
  });
  search.addEventListener('input', e => { S.search = e.target.value; applyGridFilter(); });
  search.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const best = $('.hcell.best') || $$('.hcell:not(.dim):not(.used)')[0];
      if (best) selectHero(Number(best.dataset.hero));
      if (best && e.ctrlKey && canAct()) lockIn(Number(best.dataset.hero));
    } else if (e.key === 'Escape') { clearSearch(); search.blur(); }
  });
  // Dota-style: start typing anywhere on the draft screen to search.
  document.addEventListener('keydown', e => {
    if (S.screen !== 'draft' || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    const inSearch = document.activeElement === search;
    // While typing, left/right still move the caret; up/down walk the matches.
    if (e.key.startsWith('Arrow') && (!tag || tag === 'BODY' || (inSearch && (e.key === 'ArrowUp' || e.key === 'ArrowDown')))) {
      e.preventDefault();
      moveSelection(e.key);
      return;
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key.length === 1 && /[\p{L}\p{N} '-]/u.test(e.key)) { search.focus(); return; }
    if (e.key === 'Backspace') { search.focus(); e.preventDefault(); search.value = search.value.slice(0, -1); S.search = search.value; applyGridFilter(); }
    if (e.key === 'Escape') clearSearch();
  });
  $('#role-filters').addEventListener('click', e => {
    const b = e.target.closest('[data-role]');
    if (!b) return;
    S.role = S.role === b.dataset.role ? null : b.dataset.role;
    $$('#role-filters button').forEach(x => {
      const on = x.dataset.role === S.role;
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', String(on));
    });
    applyGridFilter();
  });
  $('#touch-bar').addEventListener('click', e => { if (e.target.closest('[data-act]') && S.selected != null) lockIn(S.selected); });
  $('#panel-close').addEventListener('click', () => openHeroSheet(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') openHeroSheet(false); });
  // В режиме без сервера комнату держит вкладка её создателя: закрыл — игра у всех оборвалась.
  addEventListener('beforeunload', e => {
    const r = S.room;
    if (S.net?.mode !== 'p2p' || S.net?.role !== 'host' || !r) return;
    const others = (r.seats.radiant && r.seats.dire && !r.seats.dire.bot) || r.spectators.length;
    if (!others) return;
    e.preventDefault();
    e.returnValue = '';
  });
  document.addEventListener('visibilitychange', updateTitleFlash);
  $('#portraits-toggle').addEventListener('change', e => {
    S.portraits = e.target.checked;
    store('portraits', S.portraits ? '1' : '0');
    $$('.pick-slot').forEach(s => { s.dataset.hero = ''; });
    if (S.room?.draft) renderDraft();
  });
}

// На телефоне боковой панели нет: карточка героя открывается поверх всего экрана. Иначе сведения
// о герое лежали бы под всей сеткой, и до них надо было прокручивать.
const isNarrow = () => matchMedia('(max-width: 860px)').matches;
function openHeroSheet(on) {
  document.body.classList.toggle('hero-sheet', !!on && isNarrow());
}

function moveSelection(dir) {
  const cells = $$('.hcell:not(.dim)');
  if (!cells.length) return;
  const cur = S.selected != null ? cells.find(c => Number(c.dataset.hero) === S.selected) : null;
  if (!cur) { selectHero(Number(cells[0].dataset.hero)); cells[0].scrollIntoView({ block: 'nearest' }); return; }
  const a = cur.getBoundingClientRect();
  const horizontal = dir === 'ArrowLeft' || dir === 'ArrowRight';
  const sign = dir === 'ArrowLeft' || dir === 'ArrowUp' ? -1 : 1;
  let best = null, bestCost = Infinity;
  for (const c of cells) {
    if (c === cur) continue;
    const b = c.getBoundingClientRect();
    const dx = b.left - a.left, dy = b.top - a.top;
    const along = horizontal ? dx : dy, across = horizontal ? dy : dx;
    if (along * sign <= 2) continue;
    // Prefer the nearest cell ahead in the requested direction, penalising sideways drift so the
    // walk stays in the same row or column.
    const cost = Math.abs(along) + Math.abs(across) * 3;
    if (cost < bestCost) { bestCost = cost; best = c; }
  }
  if (!best) return;
  selectHero(Number(best.dataset.hero));
  best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function clearSearch() {
  S.search = '';
  $('#hero-search').value = '';
  applyGridFilter();
}

function applyGridFilter() {
  const q = norm(S.search);
  const roleIdx = S.role ? ROLE_KEYS.indexOf(S.role) : -1;
  const used = S.room?.draft ? usedHeroes(S.room.draft) : new Set();
  let best = null, bestScore = 0, count = 0;
  for (const c of $$('.hcell')) {
    const id = Number(c.dataset.hero);
    const h = S.byId.get(id);
    const sc = q ? score(S.searchIdx.get(id), q) : 1;
    const on = sc > 0 && (roleIdx < 0 || (h.roleLevels?.[roleIdx] || 0) > 0);
    c.classList.toggle('dim', !on);
    c.classList.toggle('match', on && !!q);
    c.classList.remove('best');
    if (!on) continue;
    count++;
    if (q && !used.has(id) && h.cm && sc > bestScore) { best = c; bestScore = sc; }
  }
  if (best) best.classList.add('best');
  $('#search-count').textContent = q ? (count ? `${count}` : 'нет') : '';
}

// ---------------- draft: state ----------------

function myTurn() {
  const t = S.room?.draft && currentTurn(S.room.draft);
  if (!t) return null;
  if (S.room.mode === 'local' && S.you.team) return t;
  return t.team === S.you.team ? t : null;
}
const canAct = () => !!myTurn();

function selectHero(id) {
  S.selected = id;
  $$('.hcell.sel').forEach(c => c.classList.remove('sel'));
  $(`.hcell[data-hero="${id}"]`)?.classList.add('sel');
  renderHeroPanelFor(id);
  renderTouchBar();
  openHeroSheet(true);
  send({ t: 'hover', hero: id });
}

const panelCtx = { tab: 'abilities' };
function renderHeroPanelFor(id) {
  const root = $('#hero-panel');
  if (id == null) { root.innerHTML = '<div class="empty-panel">Выберите героя в сетке или начните печатать его имя. Подтвердить ход — кнопкой в этой панели или Ctrl+Enter.</div>'; return; }
  const hero = S.byId.get(id);
  panelCtx.engine = S.engine;
  panelCtx.action = lockButtonHtml(id);
  panelCtx.onAct = () => lockIn(id);
  panelCtx.onOpen = selectHero;
  renderHeroPanel(root, hero, panelCtx);
}

function updateLockBar() {
  renderTouchBar();
  if (S.selected == null) return;
  const bar = $('#hero-panel .lock-bar');
  if (bar) bar.innerHTML = lockButtonHtml(S.selected);
}

// On a phone the action button lives in the side panel, and that panel sits below the whole hero
// grid — confirming a pick meant scrolling past every hero. This bar stays pinned to the bottom.
function renderTouchBar() {
  const bar = $('#touch-bar');
  const id = S.selected;
  if (id == null || S.room?.phase !== 'draft') { bar.hidden = true; return; }
  const hero = S.byId.get(id);
  bar.hidden = false;
  bar.innerHTML = `<img src="${heroVert(hero.key)}" ${vertFallback(hero.key)} alt=""><div class="tb-name">${esc(hero.name)}</div>${lockButtonHtml(id)}`;
}

function lockButtonHtml(id) {
  const d = S.room?.draft;
  if (!d || S.room.phase !== 'draft') return '';
  const t = myTurn();
  const used = usedHeroes(d).has(id);
  const hero = S.byId.get(id);
  if (!t) return `<button class="btn" disabled>${used ? 'Недоступен' : 'Ход соперника'}</button>`;
  if (used || !hero.cm) return `<button class="btn" disabled>Недоступен</button>`;
  return t.type === 'ban'
    ? `<button class="btn danger" data-act="1">Забанить</button>`
    : `<button class="btn primary" data-act="1">Выбрать</button>`;
}

function lockIn(id) {
  const t = myTurn();
  if (!t) return;
  openHeroSheet(false);
  if (usedHeroes(S.room.draft).has(id)) { toast('Герой уже недоступен'); return; }
  // Номер шага защищает от хода, доехавшего с опозданием: к тому времени очередь уже другая.
  send({ t: 'action', hero: id, step: t.index });
}

// The animated render has a transparent background, so it needs something behind it: the hero's own
// portrait, blurred, both fills the slot and hides the light fringe along the model's alpha edge.
const portraitHtml = hero => S.portraits
  ? `<span class="slot-bg" style="background-image:${heroVertBg(hero.key)}"></span><video autoplay muted loop playsinline src="${heroRender(hero.key)}"></video>`
  : `<img src="${heroVert(hero.key)}" ${vertFallback(hero.key)} alt="">`;

// Slot elements are created once per draft; later updates only touch the slot whose content changed,
// so portraits never reload on every pick.
function ensureDraftSlots() {
  const r = S.room, d = r.draft;
  const key = `${r.code}|${d.firstTeam}`;
  if (S.slotsKey === key) return;
  S.slotsKey = key;
  const slots = stepSlots(d);
  for (const team of ['radiant', 'dire']) {
    const picks = slots.filter(s => s.team === team && s.type === 'pick');
    const bans = slots.filter(s => s.team === team && s.type === 'ban');
    if (team === 'dire') { picks.reverse(); bans.reverse(); }
    $(`[data-picks="${team}"]`).innerHTML = picks.map(s => `<div class="pick-slot" data-step="${s.index}" data-hero=""><span class="slot-order">${s.index + 1}</span></div>`).join('');
    $(`[data-bans="${team}"]`).innerHTML = bans.map(s => `<div class="ban-slot" data-step="${s.index}" data-hero=""></div>`).join('');
  }
  // Order strip: what is coming, whose turn it is. Who was actually taken is already shown by the
  // pick and ban rows, so the strip carries no portraits — that is what made it unreadable before.
  const groups = [];
  for (const s of slots) {
    if (!groups.length || groups[groups.length - 1].phase !== s.phase) groups.push({ phase: s.phase, steps: [] });
    groups[groups.length - 1].steps.push(s);
  }
  $('#order-strip').innerHTML = groups.map(g => `<div class="og ${SEQUENCE[g.steps[0].index].type}">${g.steps.map(s =>
    `<i class="ostep ${s.team} ${s.type}" data-step="${s.index}"></i>`).join('')}</div>`).join('');
}

function renderDraft() {
  const r = S.room, d = r.draft;
  ensureDraftSlots();
  const byStep = new Map(d.history.map(h => [h.step, h]));
  const turn = currentTurn(d);
  const justStep = d.history.length ? d.history[d.history.length - 1].step : -1;
  const isNewStep = justStep !== S.lastStep;
  for (const team of ['radiant', 'dire']) $(`[data-captain="${team}"]`).textContent = r.seats[team]?.name || '';

  for (const el of $$('.pick-slot')) {
    const step = Number(el.dataset.step);
    const h = byStep.get(step);
    const hero = h?.hero != null ? S.byId.get(h.hero) : null;
    const want = hero ? String(hero.id) : '';
    if (el.dataset.hero !== want) {
      el.dataset.hero = want;
      el.innerHTML = hero ? `${portraitHtml(hero)}<div class="slot-name">${esc(hero.name)}</div>` : `<span class="slot-order">${step + 1}</span>`;
      el.classList.toggle('filled', !!hero);
      if (hero && isNewStep && step === justStep) { el.classList.remove('just'); void el.offsetWidth; el.classList.add('just'); }
    }
    el.classList.toggle('current', turn?.index === step);
  }
  for (const el of $$('.ban-slot')) {
    const step = Number(el.dataset.step);
    const h = byStep.get(step);
    const hero = h?.hero != null ? S.byId.get(h.hero) : null;
    const want = hero ? String(hero.id) : h ? 'skip' : '';
    if (el.dataset.hero !== want) {
      el.dataset.hero = want;
      el.innerHTML = hero ? `<img src="${heroVert(hero.key)}" ${vertFallback(hero.key)} alt="">` : '';
      el.classList.toggle('filled', !!hero);
      el.classList.toggle('skipped', want === 'skip');
      if (hero) el.dataset.tip = `Бан: ${esc(hero.name)}`; else delete el.dataset.tip;
    }
    el.classList.toggle('current', turn?.index === step);
  }
  for (const el of $$('.ostep')) {
    const step = Number(el.dataset.step);
    const s = SEQUENCE[step];
    const h = byStep.get(step);
    const hero = h?.hero != null ? S.byId.get(h.hero) : null;
    el.classList.toggle('done', !!h);
    el.classList.toggle('current', turn?.index === step);
    el.dataset.tip = `#${step + 1} · ${TEAM_NAME[teamOfStep(d, step)]} · ${s.type === 'ban' ? 'бан' : 'пик'}${hero ? ': ' + esc(hero.name) : h ? ': пропущен' : ''}`;
  }
  renderOrderNote(d, turn);

  const used = usedHeroes(d);
  for (const c of $$('.hcell')) {
    const id = Number(c.dataset.hero);
    c.classList.toggle('used', used.has(id));
    c.classList.toggle('banned', d.bans.radiant.includes(id) || d.bans.dire.includes(id));
    c.classList.toggle('picked-r', d.picks.radiant.includes(id));
    c.classList.toggle('picked-d', d.picks.dire.includes(id));
  }

  $('#phase-name').textContent = turn ? PHASES[turn.phase] : 'Драфт завершён';
  const tl = $('#turn-label');
  if (turn) {
    const mine = myTurn();
    // Чей ход и что он делает — самое важное на экране, поэтому сказано словом, а не только
    // подсветкой слота: «ВАШ БАН» или «БАНЯТ СИЛЫ ТЬМЫ».
    const act = turn.type === 'ban' ? 'БАН' : 'ПИК';
    const html = mine
      ? `<span class="yours">ВАШ ${act}</span>`
      : `${turn.type === 'ban' ? 'БАНЯТ' : 'ПИКАЮТ'}<br>${TEAM_NAME[turn.team].toUpperCase()}`;
    if (tl.dataset.html !== html) { tl.dataset.html = html; tl.innerHTML = html; }
    tl.className = 'turn-label ' + turn.team + (mine ? ' mine' : '');
  } else { tl.className = 'turn-label'; tl.textContent = ''; tl.dataset.html = ''; }

  // Вся сторона, чей ход, подсвечивается целиком: ряд пиков, ряд банов и имя команды.
  for (const team of ['radiant', 'dire']) {
    $(`.team-side.${team}`).classList.toggle('acting', turn?.team === team);
  }
  const screen = $('#screen-draft');
  screen.classList.toggle('turn-radiant', turn?.team === 'radiant');
  screen.classList.toggle('turn-dire', turn?.team === 'dire');
  screen.classList.toggle('turn-mine', !!myTurn());

  if (isNewStep) {
    S.lastStep = justStep;
    if (myTurn()) beep(880, 0.12, 0.05);
    if (S.search) applyGridFilter();
  }
  updateTitleFlash();
  updateLockBar();
}

// Who has first pick and how much is left in this phase. The draft screen said neither, so counting
// bans by eye ("first pick banned four times") looked like a broken order when the order was right:
// since 7.34 the first-pick team bans 3-2-2 and the second-pick team 4-1-2.
function renderOrderNote(d, turn) {
  for (const team of ['radiant', 'dire']) $(`[data-fp="${team}"]`).hidden = d.firstTeam !== team;
  const note = $('#order-note');
  if (!turn) { note.textContent = 'Драфт завершён'; return; }
  const left = { radiant: 0, dire: 0 };
  for (let i = turn.index; i < SEQUENCE.length && SEQUENCE[i].phase === turn.phase; i++) left[teamOfStep(d, i)]++;
  note.innerHTML = `Осталось ${turn.type === 'ban' ? 'банов' : 'пиков'} в фазе: <b class="r">${left.radiant}</b> · <b class="d">${left.dire}</b>`;
}

const updateTitleFlash = () => flashTitle(document.hidden && S.room?.phase === 'draft' && myTurn() ? '● ВАШ ХОД — Битва драфтов' : null);

function tick() {
  const r = S.room;
  if (!r || r.phase !== 'draft' || S.screen !== 'draft') return;
  const d = r.draft, t = currentTurn(d);
  if (!t) return;
  const timer = $('#big-timer');
  for (const team of ['radiant', 'dire']) $(`[data-reserve="${team}"]`).classList.remove('active');
  if (!d.timers) {
    timer.textContent = '∞';
    timer.className = 'big-timer';
    for (const team of ['radiant', 'dire']) $(`[data-reserve="${team}"]`).textContent = '—';
    return;
  }
  const now = Date.now() + S.clockOffset;
  const elapsed = (now - d.turnStartedAt) / 1000;
  const main = Math.max(0, t.time - elapsed);
  const resUsed = Math.max(0, elapsed - t.time);
  for (const team of ['radiant', 'dire']) {
    const v = team === t.team ? Math.max(0, d.reserve[team] - resUsed) : d.reserve[team];
    $(`[data-reserve="${team}"]`).textContent = fmtTime(v);
  }
  if (main > 0) {
    timer.textContent = Math.ceil(main);
    timer.className = 'big-timer' + (main <= 5 ? ' low' : '');
  } else {
    timer.textContent = fmtTime(Math.max(0, d.reserve[t.team] - resUsed));
    timer.className = 'big-timer reserve-mode';
    $(`[data-reserve="${t.team}"]`).classList.add('active');
  }
  const sec = Math.ceil(main);
  if (myTurn() && main > 0 && sec <= 5 && sec !== S.lastTick) { S.lastTick = sec; beep(1200, 0.04, 0.03); }
}

const fmtTime = s => {
  s = Math.ceil(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function openHeroModal(id) {
  const body = $('#modal-body');
  renderHeroPanel(body, S.byId.get(id), { engine: S.engine, onOpen: openHeroModal });
  $('#modal').classList.remove('hidden');
}

boot().catch(e => {
  console.error(e);
  $('#loading').innerHTML = `<div>Не удалось загрузить данные: ${esc(e.message)}</div><div class="muted small">Запустите <code>npm run build-data</code>, затем обновите страницу.</div>`;
});
