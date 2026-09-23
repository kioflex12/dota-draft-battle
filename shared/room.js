import { createDraft, currentTurn, applyAction, clock, other, isAvailable } from './draft.js';

const ORDERS = ['random', 'radiant', 'dire', 'coin'];
const DEFAULT_SETTINGS = { order: 'random', timers: true, hints: true, randomBan: false, firstBanTime: 15, turnTime: 30, reserve: 130 };
const COIN_LABEL = { first: 'первый пик', second: 'второй пик', radiant: 'Силы Света', dire: 'Силы Тьмы' };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const pickNum = (v, allowed, def) => (allowed.includes(Number(v)) ? Number(v) : def);

export const randomCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

export function sanitizeSettings(src = {}, base = {}) {
  const s = { ...DEFAULT_SETTINGS, ...base };
  if (ORDERS.includes(src.order)) s.order = src.order;
  if (typeof src.timers === 'boolean') s.timers = src.timers;
  if (typeof src.hints === 'boolean') s.hints = src.hints;
  if (typeof src.randomBan === 'boolean') s.randomBan = src.randomBan;
  if (src.firstBanTime != null) s.firstBanTime = pickNum(src.firstBanTime, [10, 15, 20, 30], s.firstBanTime);
  if (src.turnTime != null) s.turnTime = pickNum(src.turnTime, [15, 20, 30, 45, 60], s.turnTime);
  if (src.reserve != null) s.reserve = pickNum(src.reserve, [0, 60, 130, 200, 300], s.reserve);
  return s;
}

// Authoritative room logic shared by the Node server (WebSocket) and the browser host (WebRTC).
// `send(client, msg)` delivers a message to one client; a client is any object with id/name/token.
export class RoomManager {
  constructor({ engine, cmHeroes, send, onEmpty }) {
    this.engine = engine;
    this.cmHeroes = cmHeroes;
    this.send = send;
    this.onEmpty = onEmpty;
    this.rooms = new Map();
    this.nextId = 1;
    this.timer = setInterval(() => this.tick(), 250);
  }

  destroy() {
    clearInterval(this.timer);
    for (const room of this.rooms.values()) clearTimeout(room.botTimer);
    this.rooms.clear();
  }

  createClient() {
    return { id: this.nextId++, name: 'Игрок', token: '', room: null, team: null };
  }

  createRoom({ mode, difficulty, side, code, ...rest }) {
    let c = code;
    while (!c || this.rooms.has(c)) c = randomCode();
    const room = {
      code: c, mode, difficulty: difficulty || 'normal', settings: sanitizeSettings(rest), coin: null,
      phase: 'lobby', seats: { radiant: null, dire: null }, clients: new Set(), draft: null,
      chat: [], rematch: new Set(), createdAt: Date.now(), botTimer: null, lastActivity: Date.now(),
    };
    const botSide = side === 'dire' ? 'radiant' : 'dire';
    if (mode === 'bot') room.seats[botSide] = { bot: true, name: `Бот (${({ easy: 'лёгкий', normal: 'средний', hard: 'сложный' })[room.difficulty]})` };
    if (mode === 'local') room.seats[botSide] = { bot: true, local: true, name: 'Игрок 2' };
    this.rooms.set(room.code, room);
    return room;
  }

  publicRoom(room) {
    return {
      code: room.code, mode: room.mode, difficulty: room.difficulty, settings: room.settings, coin: room.coin, phase: room.phase,
      seats: Object.fromEntries(Object.entries(room.seats).map(([t, s]) => [t, s ? { name: s.name, bot: !!s.bot, online: s.bot || !!s.client } : null])),
      spectators: [...room.clients].filter(c => !c.team).map(c => c.name),
      draft: room.draft, chat: room.chat.slice(-50), rematch: [...room.rematch], serverNow: Date.now(),
    };
  }

  broadcast(room) {
    const state = this.publicRoom(room);
    for (const c of room.clients) this.send(c, { t: 'room', room: state, you: { team: c.team, id: c.id } });
  }

  sys(room, text) {
    room.chat.push({ sys: true, text, at: Date.now() });
  }

  startMatch(room) {
    room.rematch.clear();
    const o = room.settings.order;
    if (o === 'coin') {
      const winner = Math.random() < 0.5 ? 'radiant' : 'dire';
      room.coin = { winner, stage: 'winner', winnerChoice: null, loserChoice: null };
      room.phase = 'coin';
      this.sys(room, `Жребий выиграл капитан ${room.seats[winner].name} — он выбирает первым.`);
      this.scheduleBotCoin(room);
      this.broadcast(room);
      return;
    }
    this.startDraft(room, o === 'random' ? (Math.random() < 0.5 ? 'radiant' : 'dire') : o);
  }

  coinOptions(coin) {
    if (coin.stage === 'winner') return ['first', 'second', 'radiant', 'dire'];
    return ['first', 'second'].includes(coin.winnerChoice) ? ['radiant', 'dire'] : ['first', 'second'];
  }

  applyCoin(room, choice) {
    const coin = room.coin;
    if (!this.coinOptions(coin).includes(choice)) return false;
    const chooserName = room.seats[coin.stage === 'winner' ? coin.winner : other(coin.winner)].name;
    this.sys(room, `${chooserName} выбирает: ${COIN_LABEL[choice]}.`);
    if (coin.stage === 'winner') {
      coin.winnerChoice = choice;
      coin.stage = 'loser';
      this.scheduleBotCoin(room);
      return true;
    }
    coin.loserChoice = choice;
    const wc = coin.winnerChoice, lc = choice;
    const winnerSide = ['radiant', 'dire'].includes(wc) ? wc : other(lc);
    const winnerFirst = wc === 'first' || lc === 'second';
    if (winnerSide !== coin.winner) this.swapSeats(room);
    room.coin = null;
    this.startDraft(room, winnerFirst ? winnerSide : other(winnerSide));
    return true;
  }

  swapSeats(room) {
    [room.seats.radiant, room.seats.dire] = [room.seats.dire, room.seats.radiant];
    for (const c of room.clients) if (c.team) c.team = other(c.team);
  }

  scheduleBotCoin(room) {
    clearTimeout(room.botTimer);
    const coin = room.coin;
    const chooser = coin.stage === 'winner' ? coin.winner : other(coin.winner);
    const seat = room.seats[chooser];
    if (!seat?.bot || seat.local) return;
    room.botTimer = setTimeout(() => {
      if (room.phase !== 'coin' || room.coin !== coin) return;
      const opts = this.coinOptions(coin);
      this.applyCoin(room, opts[Math.floor(Math.random() * opts.length)]);
      this.broadcast(room);
    }, 1800);
  }

  startDraft(room, first) {
    const st = room.settings;
    room.draft = createDraft({ firstTeam: first, timers: st.timers, firstBanTime: st.firstBanTime, turnTime: st.turnTime, reserve: st.reserve });
    room.phase = 'draft';
    room.rematch.clear();
    this.sys(room, `Драфт начался. Первый пик у ${first === 'radiant' ? 'Сил Света' : 'Сил Тьмы'}.`);
    this.scheduleBot(room);
    this.broadcast(room);
  }

  afterAction(room) {
    room.lastActivity = Date.now();
    if (room.draft.done) {
      room.phase = 'done';
      this.sys(room, 'Драфт завершён.');
    } else this.scheduleBot(room);
    this.broadcast(room);
  }

  scheduleBot(room) {
    clearTimeout(room.botTimer);
    const t = currentTurn(room.draft);
    if (!t) return;
    const seat = room.seats[t.team];
    if (!seat?.bot || seat.local) return;
    const delay = 1200 + Math.random() * (room.difficulty === 'hard' ? 3500 : 2500);
    room.botTimer = setTimeout(() => {
      const cur = currentTurn(room.draft);
      if (!cur || cur.index !== t.index) return;
      const hero = this.engine.botChoice(room.draft, cur.team, cur.type, room.difficulty);
      applyAction(room.draft, cur.team, hero);
      this.afterAction(room);
    }, delay);
  }

  tick() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.phase === 'draft' && room.draft.timers) {
        const c = clock(room.draft, now);
        if (c && c.expired) {
          const t = currentTurn(room.draft);
          let hero = null;
          if (t.type === 'pick' || room.settings.randomBan) {
            const avail = this.cmHeroes.filter(id => isAvailable(room.draft, id));
            hero = avail[Math.floor(Math.random() * avail.length)];
          }
          applyAction(room.draft, t.team, hero, { auto: true, now });
          this.sys(room, t.type === 'pick' ? 'Время вышло — выбран случайный герой.' : hero != null ? 'Время вышло — забанен случайный герой.' : 'Время вышло — бан пропущен.');
          this.afterAction(room);
        }
      }
      const idle = now - room.lastActivity;
      if ((room.clients.size === 0 && idle > 10 * 60_000) || idle > 6 * 3600_000) {
        clearTimeout(room.botTimer);
        this.rooms.delete(room.code);
        this.onEmpty?.(room);
      }
    }
  }

  joinRoom(client, room, wantTeam) {
    this.leave(client);
    client.room = room;
    room.clients.add(client);
    let team = null;
    for (const t of ['radiant', 'dire']) {
      const s = room.seats[t];
      if (s && !s.bot && !s.client && s.token && s.token === client.token) { team = t; break; }
    }
    if (!team && room.phase === 'lobby') {
      team = wantTeam && !room.seats[wantTeam] ? wantTeam : (!room.seats.radiant ? 'radiant' : !room.seats.dire ? 'dire' : null);
    }
    if (team) {
      room.seats[team] = { name: client.name, client, token: client.token };
      client.team = team;
    }
    room.lastActivity = Date.now();
    this.sys(room, `${client.name} ${team ? 'присоединился' : 'смотрит как зритель'}.`);
    if (room.mode !== 'pvp' && room.phase === 'lobby' && client.team) this.startMatch(room);
    else this.broadcast(room);
  }

  leave(client) {
    const room = client.room;
    if (!room) return;
    room.clients.delete(client);
    if (client.team && room.seats[client.team]?.client === client) {
      room.seats[client.team].client = null;
      if (room.phase === 'lobby') room.seats[client.team] = null;
    }
    this.sys(room, `${client.name} вышел.`);
    client.room = null;
    client.team = null;
    this.broadcast(room);
  }

  handle(client, msg) {
    const room = client.room;
    switch (msg.t) {
      case 'hello':
        client.name = String(msg.name || 'Игрок').slice(0, 20) || 'Игрок';
        client.token = String(msg.token || '').slice(0, 64);
        this.send(client, { t: 'hello', id: client.id });
        break;
      case 'create': {
        const r = this.createRoom({ ...msg, mode: ['bot', 'local'].includes(msg.mode) ? msg.mode : 'pvp' });
        this.joinRoom(client, r, msg.side === 'dire' ? 'dire' : 'radiant');
        break;
      }
      case 'join': {
        const r = this.rooms.get(String(msg.code || '').toUpperCase());
        if (!r) { this.send(client, { t: 'error', error: 'Комната не найдена' }); return; }
        this.joinRoom(client, r, msg.team);
        break;
      }
      case 'leave':
        this.leave(client);
        this.send(client, { t: 'left' });
        break;
      case 'swap': {
        if (!room || room.phase !== 'lobby' || !client.team) return;
        const target = other(client.team);
        if (room.seats[target]) return;
        room.seats[target] = room.seats[client.team];
        room.seats[client.team] = null;
        client.team = target;
        this.broadcast(room);
        break;
      }
      case 'settings': {
        if (!room || room.phase !== 'lobby' || !client.team) return;
        room.settings = sanitizeSettings(msg, room.settings);
        this.broadcast(room);
        break;
      }
      case 'coin': {
        if (!room || room.phase !== 'coin' || !client.team) return;
        const chooser = room.coin.stage === 'winner' ? room.coin.winner : other(room.coin.winner);
        if (room.mode !== 'local' && client.team !== chooser) { this.send(client, { t: 'error', error: 'Сейчас выбирает соперник' }); return; }
        if (!this.applyCoin(room, msg.choice)) return;
        this.broadcast(room);
        break;
      }
      case 'start': {
        if (!room || room.phase !== 'lobby') return;
        if (!room.seats.radiant || !room.seats.dire) { this.send(client, { t: 'error', error: 'Нужны оба капитана' }); return; }
        this.startMatch(room);
        break;
      }
      case 'action': {
        if (!room || room.phase !== 'draft' || !client.team) return;
        const actingTeam = room.mode === 'local' ? currentTurn(room.draft)?.team : client.team;
        const r = applyAction(room.draft, actingTeam, msg.hero == null ? null : Number(msg.hero));
        if (!r.ok) { this.send(client, { t: 'error', error: r.error }); return; }
        this.afterAction(room);
        break;
      }
      case 'hover': {
        if (!room || room.phase !== 'draft' || !client.team) return;
        for (const c of room.clients) if (c !== client && (c.team === client.team || !c.team)) this.send(c, { t: 'hover', team: client.team, hero: msg.hero });
        break;
      }
      case 'chat': {
        if (!room) return;
        const text = String(msg.text || '').trim().slice(0, 200);
        if (!text) return;
        room.chat.push({ name: client.name, team: client.team, text, at: Date.now() });
        this.broadcast(room);
        break;
      }
      case 'rematch': {
        if (!room || room.phase !== 'done' || !client.team) return;
        room.rematch.add(client.team);
        const humans = ['radiant', 'dire'].filter(t => room.seats[t] && !room.seats[t].bot);
        if (humans.every(t => room.rematch.has(t))) {
          if (['radiant', 'dire'].includes(room.settings.order) && room.mode === 'pvp') room.settings.order = other(room.draft.firstTeam);
          this.startMatch(room);
        } else this.broadcast(room);
        break;
      }
    }
  }
}
