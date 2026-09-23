import { $, $$, esc, heroImg, heroRender, ATTR_ICON, ATTR_NAME, toast, bindTooltip, beep, store, fmtPct } from './util.js';
import { renderHeroPanel } from './heroPanel.js';
import { renderResult } from './result.js';
import { Net } from './net.js';
import { createEngine, ROLE_KEYS, ROLE_NAMES, toPct } from '../shared/analysis.js';
import { SEQUENCE, PHASES, TEAM_NAME, currentTurn, stepSlots, usedHeroes } from '../shared/draft.js';

const S = {
  engine: null, heroes: [], byId: new Map(),
  net: null, room: null, you: {}, clockOffset: 0,
  screen: null, selected: null, search: '', role: null,
  hints: store('hints') === '1', resultView: null, lastStep: -1, lastTick: -1,
  pendingJoin: null,
};

const token = store('token') || (() => { const t = Math.random().toString(36).slice(2) + Date.now().toString(36); store('token', t); return t; })();

// ---------------- boot ----------------

async function boot() {
  const [hd, st] = await Promise.all([fetch(new URL('../data/heroes.json', import.meta.url)).then(r => r.json()), fetch(new URL('../data/stats.json', import.meta.url)).then(r => r.json())]);
  S.heroes = hd.heroes;
  S.byId = new Map(S.heroes.map(h => [h.id, h]));
  S.engine = createEngine(S.heroes, st);
  $('#patch-label').textContent = hd.patch;
  $('#data-label').textContent = `${st.meta.pubMatches.toLocaleString('ru')} матчей Divine+ · ${st.meta.proMatches.toLocaleString('ru')} про-матчей`;
  $('#name-input').value = store('name') || '';
  $('#hints-toggle').checked = S.hints;
  buildGrid();
  buildRoleFilters();
  bindMenu();
  bindDraft();
  bindTooltip(document.body);
  $('#loading').classList.add('hidden');
  const code = new URLSearchParams(location.search).get('room');
  if (code && /^[A-Z0-9]{5}$/i.test(code)) S.pendingJoin = code.toUpperCase();
  connect();
  show('menu');
  setInterval(tick, 200);
}

function show(name) {
  if (S.screen === name) return;
  S.screen = name;
  $$('.screen').forEach(s => s.classList.toggle('hidden', s.id !== 'screen-' + name));
  window.scrollTo(0, 0);
}

// ---------------- network ----------------

const roomUrl = code => `${location.origin}${location.pathname}?room=${code}`;

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
      send({ t: 'hello', name: myName(), token });
      const code = S.pendingJoin || S.room?.code;
      if (code) { send({ t: 'join', code }); S.pendingJoin = null; }
    },
  });
}

const send = msg => S.net?.send(msg);
const myName = () => ($('#name-input').value.trim() || 'Капитан').slice(0, 20);

function onMessage(msg) {
  if (msg.t === 'room') {
    const prev = S.room;
    S.room = msg.room;
    S.you = msg.you;
    S.clockOffset = msg.room.serverNow - Date.now();
    if (new URLSearchParams(location.search).get('room') !== S.room.code) history.replaceState(null, '', '?room=' + S.room.code);
    renderRoom(prev);
  } else if (msg.t === 'error') {
    toast(msg.error);
    if (msg.error === 'Комната не найдена') history.replaceState(null, '', location.pathname);
  } else if (msg.t === 'left') {
    S.room = null;
    S.resultView = null;
    history.replaceState(null, '', location.pathname);
    show('menu');
  } else if (msg.t === 'disconnected') {
    if (S.room) toast('Соединение потеряно, переподключение…');
  }
}

function renderRoom(prev) {
  const r = S.room;
  renderChat();
  if (r.phase === 'lobby') { renderLobby(); show('lobby'); return; }
  if (r.phase === 'coin') { renderCoin(prev); show('coin'); return; }
  if (r.phase === 'draft') {
    S.resultView = null;
    if (!prev || prev.phase !== 'draft') { S.selected = null; S.lastStep = -1; renderHeroPanelFor(null); }
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

// ---------------- menu ----------------

function bindMenu() {
  $('#name-input').addEventListener('change', () => { store('name', myName()); send({ t: 'hello', name: myName(), token }); });
  $('#btn-create').onclick = () => {
    send({ t: 'hello', name: myName(), token });
    send({ t: 'create', mode: 'pvp', order: $('#pvp-order').value, timers: $('#pvp-timers').checked });
  };
  $('#btn-join').onclick = () => {
    const code = $('#join-code').value.trim().toUpperCase();
    if (code.length !== 5) { toast('Введите код из 5 символов'); return; }
    send({ t: 'hello', name: myName(), token });
    send({ t: 'join', code });
  };
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
    try { await navigator.clipboard.writeText($('#lobby-link').value); toast('Ссылка скопирована', true); }
    catch { $('#lobby-link').select(); }
  };
  $('#btn-swap').onclick = () => send({ t: 'swap' });
  $('#btn-start').onclick = () => send({ t: 'start' });
  $('#btn-lobby-leave').onclick = () => send({ t: 'leave' });
  $$('[data-set]').forEach(el => el.addEventListener('change', () => {
    send({ t: 'settings', [el.dataset.set]: el.type === 'checkbox' ? el.checked : el.value });
  }));
  $('#btn-dota-preset').onclick = () => send({ t: 'settings', order: 'coin', timers: true, firstBanTime: 15, turnTime: 30, reserve: 130 });
  $('#coin-opts').addEventListener('click', e => {
    const b = e.target.closest('[data-coin]');
    if (b) send({ t: 'coin', choice: b.dataset.coin });
  });

  $$('[data-chat]').forEach(box => {
    box.innerHTML = '<div class="chat-log"></div><input placeholder="Сообщение… (Enter)" maxlength="200">';
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

function renderLobby() {
  const r = S.room;
  $('#lobby-code').textContent = r.code;
  $('#lobby-link').value = roomUrl(r.code);
  for (const t of ['radiant', 'dire']) {
    const s = r.seats[t];
    $('#seat-' + t).innerHTML = `
      <div class="side-title">${TEAM_NAME[t]}</div>
      <div class="who ${s ? '' : 'empty'}">${s ? esc(s.name) + (S.you.team === t ? ' <span class="muted small">(вы)</span>' : '') : 'Ожидание капитана…'}</div>
      ${s && !s.online ? '<div class="muted small">не в сети</div>' : ''}`;
  }
  const st = r.settings;
  $$('[data-set]').forEach(el => {
    const v = st[el.dataset.set];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
    el.disabled = !S.you.team || (!st.timers && ['firstBanTime', 'turnTime', 'reserve'].includes(el.dataset.set));
  });
  $('#settings-note').textContent = {
    coin: 'Жребий: победитель выбирает первый/второй пик или сторону, проигравший решает оставшееся.',
    random: 'Первый пик достанется случайной команде.',
    radiant: 'Первый пик у Сил Света; при реванше очередь переходит сопернику.',
    dire: 'Первый пик у Сил Тьмы; при реванше очередь переходит сопернику.',
  }[st.order] + (st.timers ? ` Таймеры: баны I фазы ${st.firstBanTime} с, остальные ходы ${st.turnTime} с, резерв ${fmtTime(st.reserve)}.` : ' Без таймеров.');
  $('#btn-start').disabled = !(r.seats.radiant && r.seats.dire) || !S.you.team;
  $('#btn-swap').disabled = !S.you.team;
  $('#lobby-spect').textContent = r.spectators.length ? 'Зрители: ' + r.spectators.join(', ') : '';
}

const COIN_TEXT = {
  first: ['Первый пик', 'Начинаете драфт первыми'],
  second: ['Второй пик', 'Последнее слово в драфте'],
  radiant: ['Силы Света', 'Нижняя лёгкая линия'],
  dire: ['Силы Тьмы', 'Верхняя лёгкая линия'],
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
  $('#coin-title').innerHTML = `Жребий выиграл: <span style="color:${c.winner === 'radiant' ? 'var(--radiant-2)' : 'var(--dire-2)'}">${winnerName}</span>`;
  const opts = c.stage === 'winner' ? ['first', 'second', 'radiant', 'dire'] : (['first', 'second'].includes(c.winnerChoice) ? ['radiant', 'dire'] : ['first', 'second']);
  $('#coin-sub').innerHTML = c.stage === 'winner'
    ? `${mine ? 'Вы выбираете' : winnerName + ' выбирает'}: очередь пика или сторону карты.`
    : `Победитель жребия выбрал: <b>${COIN_TEXT[c.winnerChoice][0]}</b>. ${mine ? 'Теперь ваш выбор' : esc(r.seats[chooser]?.name || '') + ' выбирает'}: ${['first', 'second'].includes(c.winnerChoice) ? 'сторону' : 'очередь пика'}.`;
  $('#coin-opts').innerHTML = opts.map(o => `<button class="btn ${o === 'first' || o === 'radiant' ? 'primary' : ''}" data-coin="${o}" ${mine ? '' : 'disabled'}>${COIN_TEXT[o][0]}<small>${COIN_TEXT[o][1]}</small></button>`).join('');
}

function renderChat() {
  const r = S.room;
  $$('[data-chat] .chat-log').forEach(log => {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
    log.innerHTML = r.chat.map(m => m.sys
      ? `<div class="sys">${esc(m.text)}</div>`
      : `<div><span class="n-${m.team || 'spec'}">${esc(m.name)}:</span> ${esc(m.text)}</div>`).join('');
    if (atBottom) log.scrollTop = log.scrollHeight;
  });
}

// ---------------- draft ----------------

function buildGrid() {
  const grid = $('#hero-grid');
  const groups = [0, 1, 2, 3].map(a => S.heroes.filter(h => h.attr === a).sort((x, y) => x.name.localeCompare(y.name)));
  grid.innerHTML = groups.map((list, a) => `
    <div class="attr-block">
      <div class="attr-head a${a}"><img src="${ATTR_ICON[a]}" alt="">${ATTR_NAME[a]}</div>
      <div class="attr-cells">${list.map(h => `<div class="hcell ${h.cm ? '' : 'disabled-cm'}" data-hero="${h.id}" data-tip="<div class='tt-h'>${esc(h.name)}</div>${ROLE_KEYS.filter((k, i) => (h.roleLevels?.[i] || 0) > 0).map(k => ROLE_NAMES[k]).join(' · ')}"><img loading="lazy" src="${heroImg(h.key)}" alt="${esc(h.name)}"></div>`).join('')}</div>
    </div>`).join('');
}

function buildRoleFilters() {
  const keys = ['carry', 'support', 'nuker', 'disabler', 'durable', 'escape', 'pusher', 'initiator'];
  $('#role-filters').innerHTML = keys.map(k => `<button data-role="${k}">${ROLE_NAMES[k]}</button>`).join('');
}

function bindDraft() {
  $('#hero-grid').addEventListener('click', e => {
    const c = e.target.closest('[data-hero]');
    if (!c) return;
    selectHero(Number(c.dataset.hero));
  });
  $('#hero-grid').addEventListener('dblclick', e => {
    const c = e.target.closest('[data-hero]');
    if (c && canAct()) lockIn(Number(c.dataset.hero));
  });
  $('#hero-search').addEventListener('input', e => { S.search = e.target.value.trim().toLowerCase(); applyGridFilter(); });
  $('#hero-search').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const first = $$('.hcell:not(.dim):not(.used)')[0];
    if (first) selectHero(Number(first.dataset.hero));
  });
  $('#role-filters').addEventListener('click', e => {
    const b = e.target.closest('[data-role]');
    if (!b) return;
    S.role = S.role === b.dataset.role ? null : b.dataset.role;
    $$('#role-filters button').forEach(x => x.classList.toggle('on', x.dataset.role === S.role));
    applyGridFilter();
  });
  $('#hints-toggle').addEventListener('change', e => { S.hints = e.target.checked; store('hints', S.hints ? '1' : '0'); renderHints(); });
  $('#hints').addEventListener('click', e => {
    const h = e.target.closest('[data-hint]');
    if (h) selectHero(Number(h.dataset.hint));
  });
}

function applyGridFilter() {
  const roleIdx = S.role ? ROLE_KEYS.indexOf(S.role) : -1;
  $$('.hcell').forEach(c => {
    const h = S.byId.get(Number(c.dataset.hero));
    const matchSearch = !S.search || h.name.toLowerCase().includes(S.search) || h.key.includes(S.search);
    const matchRole = roleIdx < 0 || (h.roleLevels?.[roleIdx] || 0) > 0;
    c.classList.toggle('dim', !(matchSearch && matchRole));
  });
}

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
  send({ t: 'hover', hero: id });
}

const panelCtx = { tab: 'abilities' };
function renderHeroPanelFor(id) {
  const root = $('#hero-panel');
  if (id == null) { root.innerHTML = '<div class="empty-panel">Выберите героя в сетке, чтобы увидеть способности и статистику. Двойной клик — сразу выбрать.</div>'; return; }
  const hero = S.byId.get(id);
  panelCtx.engine = S.engine;
  panelCtx.action = lockButtonHtml(id);
  panelCtx.onAct = () => lockIn(id);
  panelCtx.onOpen = selectHero;
  renderHeroPanel(root, hero, panelCtx);
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
  if (usedHeroes(S.room.draft).has(id)) { toast('Герой уже недоступен'); return; }
  send({ t: 'action', hero: id });
}

function renderDraft() {
  const r = S.room, d = r.draft;
  const slots = stepSlots(d);
  const byStep = new Map(d.history.map(h => [h.step, h]));
  const turn = currentTurn(d);
  const justStep = d.history.length ? d.history[d.history.length - 1].step : -1;
  const isNewStep = justStep !== S.lastStep;

  for (const team of ['radiant', 'dire']) {
    $(`[data-captain="${team}"]`).textContent = r.seats[team]?.name || '';
    const pickSteps = slots.filter(s => s.team === team && s.type === 'pick');
    const picksEl = $(`[data-picks="${team}"]`);
    const ordered = team === 'dire' ? pickSteps.slice().reverse() : pickSteps;
    const html = ordered.map(s => {
      const h = byStep.get(s.index);
      const hero = h?.hero != null ? S.byId.get(h.hero) : null;
      const cls = ['pick-slot', hero ? 'filled' : '', turn?.index === s.index ? 'current' : '', isNewStep && s.index === justStep ? 'just' : ''].join(' ');
      return `<div class="${cls}" data-step="${s.index}">${hero ? `<video autoplay muted loop playsinline poster="${heroImg(hero.key)}" src="${heroRender(hero.key)}"></video><div class="slot-name">${esc(hero.name)}</div>` : `<span class="slot-order">${s.index + 1}</span>`}</div>`;
    }).join('');
    if (picksEl.dataset.sig !== sig(team, 'pick', byStep, turn)) { picksEl.innerHTML = html; picksEl.dataset.sig = sig(team, 'pick', byStep, turn); }

    const banSteps = slots.filter(s => s.team === team && s.type === 'ban');
    const bansEl = $(`[data-bans="${team}"]`);
    const bansHtml = (team === 'dire' ? banSteps.slice().reverse() : banSteps).map(s => {
      const h = byStep.get(s.index);
      const hero = h?.hero != null ? S.byId.get(h.hero) : null;
      const cls = ['ban-slot', hero ? 'filled' : '', h && h.hero == null ? 'skipped' : '', turn?.index === s.index ? 'current' : ''].join(' ');
      return `<div class="${cls}" ${hero ? `data-tip="Бан: ${esc(hero.name)}"` : ''}>${hero ? `<img src="${heroImg(hero.key)}" alt="">` : ''}</div>`;
    }).join('');
    bansEl.innerHTML = bansHtml;
  }

  $('#sequence').innerHTML = slots.map((s, i) => {
    const h = byStep.get(i);
    const hero = h?.hero != null ? S.byId.get(h.hero) : null;
    const gap = i > 0 && SEQUENCE[i - 1].phase !== s.phase ? '<div class="seq-gap"></div>' : '';
    return `${gap}<div class="seq-step ${s.team} ${s.type} ${h ? 'done' : ''} ${turn?.index === i ? 'current' : ''}" data-tip="#${i + 1} · ${TEAM_NAME[s.team]} · ${s.type === 'ban' ? 'бан' : 'пик'}${hero ? ': ' + esc(hero.name) : ''}">${hero ? `<img src="${heroImg(hero.key)}" alt="">` : (s.type === 'ban' ? 'Б' : 'П')}</div>`;
  }).join('');

  const used = usedHeroes(d);
  $$('.hcell').forEach(c => {
    const id = Number(c.dataset.hero);
    c.classList.toggle('used', used.has(id));
    c.classList.toggle('banned', d.bans.radiant.includes(id) || d.bans.dire.includes(id));
    c.classList.toggle('picked-r', d.picks.radiant.includes(id));
    c.classList.toggle('picked-d', d.picks.dire.includes(id));
  });

  $('#phase-name').textContent = turn ? PHASES[turn.phase] : 'Драфт завершён';
  const tl = $('#turn-label');
  if (turn) {
    const mine = myTurn();
    tl.className = 'turn-label ' + turn.team;
    tl.innerHTML = `${TEAM_NAME[turn.team]} · ${turn.type === 'ban' ? 'бан' : 'пик'}${mine ? '<span class="yours">ВАШ ХОД</span>' : ''}`;
  } else { tl.className = 'turn-label'; tl.textContent = ''; }

  const meter = $('#live-meter');
  const p = S.engine.prob(d.picks.radiant, d.picks.dire) * 100;
  meter.innerHTML = `<div class="fill" style="width:${p}%"></div><div class="mid"></div>`;
  meter.dataset.tip = `Оценка драфта сейчас: Силы Света ${p.toFixed(1)}% · Силы Тьмы ${(100 - p).toFixed(1)}%`;

  if (isNewStep) {
    S.lastStep = justStep;
    if (myTurn()) beep(880, 0.12, 0.05);
    if (S.selected != null && used.has(S.selected)) S.selected = null;
    renderHeroPanelFor(S.selected);
    renderHints();
  } else if (S.selected != null) {
    const bar = $('#hero-panel .lock-bar');
    if (bar) bar.innerHTML = lockButtonHtml(S.selected);
  }
}

const sig = (team, type, byStep, turn) => [...byStep.values()].filter(h => h.team === team && h.type === type).map(h => h.hero).join(',') + '|' + (turn?.index ?? -1);

const hintsAllowed = () => S.room?.mode !== 'pvp' || S.room.settings.hints;

function renderHints() {
  const box = $('#hints');
  const t = myTurn();
  $('#hints-toggle').closest('label').classList.toggle('hidden', !hintsAllowed());
  if (!S.hints || !hintsAllowed() || !t || S.room?.phase !== 'draft') { box.classList.add('hidden'); $$('.hint-badge').forEach(b => b.remove()); return; }
  const list = S.engine.suggest(S.room.draft, t.team, t.type, 6);
  box.classList.remove('hidden');
  box.innerHTML = `<div class="sec-title">Подсказка: ${t.type === 'ban' ? 'кого забанить' : 'кого взять'}</div>` + list.map((s, i) => {
    const h = S.byId.get(s.hero);
    const g = toPct(s.gain);
    return `<div class="hint" data-hint="${h.id}"><img src="${heroImg(h.key)}" alt=""><div><div class="nm">${i + 1}. ${esc(h.name)}</div><div class="why">${esc(s.reasons.join(' · ') || 'сильный герой в текущем драфте')}</div></div><div class="gain ${g >= 0 ? 'pos' : 'neg'}">${fmtPct(g)}%</div></div>`;
  }).join('');
  $$('.hint-badge').forEach(b => b.remove());
  list.forEach((s, i) => {
    const c = $(`.hcell[data-hero="${s.hero}"]`);
    if (c) c.insertAdjacentHTML('beforeend', `<span class="hint-badge">${i + 1}</span>`);
  });
}

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
