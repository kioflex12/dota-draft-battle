import { RoomManager, randomCode } from '../shared/room.js';

const PEER_PREFIX = 'ddb-';
const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const ICE = {
  iceServers: [
    // Несколько STUN от разных операторов: если один недоступен из сети игрока, остальные всё
    // равно дадут внешний адрес и прямое соединение состоится без ретрансляции.
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'stun:openrelay.metered.ca:80' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

// «Ошибка сети: network» не говорит игроку ничего. Тип ошибки PeerJS довольно точно указывает,
// что именно не сложилось, — а починить можно только то, что названо.
const PEER_ERROR = {
  'browser-incompatible': 'Браузер не умеет связывать игроков напрямую (WebRTC). Откройте игру в свежем Chrome, Firefox или Safari.',
  'disconnected': 'Связь с сервером, который сводит игроков, потеряна. Проверьте интернет и попробуйте ещё раз.',
  'network': 'Не удалось достучаться до сервера, который сводит игроков. Так бывает из-за VPN, рабочей сети или блокировок — попробуйте другую сеть или мобильный интернет.',
  'server-error': 'Сервер, который сводит игроков, сейчас недоступен. Попробуйте через минуту.',
  'socket-error': 'Обрыв связи с сервером, который сводит игроков.',
  'socket-closed': 'Сервер, который сводит игроков, закрыл соединение. Попробуйте ещё раз.',
  'ssl-unavailable': 'Соединение заблокировано настройками безопасности сети.',
  'webrtc': 'Не удалось установить прямое соединение между браузерами — обычно мешает строгий NAT или файрвол.',
  'unavailable-id': 'Код комнаты уже занят — создайте комнату заново.',
};
const peerError = e => PEER_ERROR[e && e.type] || ('Ошибка сети: ' + ((e && (e.type || e.message)) || 'неизвестная'));

// Что имеет смысл придержать до восстановления связи, а что протухает мгновенно.
const QUEUED_KINDS = new Set(['action', 'chat', 'settings', 'start', 'swap', 'sit', 'coin', 'rematch']);

let peerLib;
function loadPeerJs() {
  peerLib ??= new Promise((res, rej) => {
    if (window.Peer) { res(window.Peer); return; }
    const s = document.createElement('script');
    s.src = PEERJS_URL;
    s.onload = () => res(window.Peer);
    s.onerror = () => rej(new Error('Не удалось загрузить PeerJS'));
    document.head.appendChild(s);
  });
  return peerLib;
}

// Same message protocol over two transports: WebSocket to the Node server, or WebRTC where the
// room host's browser runs RoomManager and guests connect to it by room code.
export class Net {
  constructor({ engine, cmHeroes, onMessage, onOpen, forceP2P }) {
    this.engine = engine;
    this.cmHeroes = cmHeroes;
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.mode = null;
    this.hello = { t: 'hello' };
    this.role = null;
    if (forceP2P || location.protocol === 'file:' || location.hostname.endsWith('github.io')) queueMicrotask(() => this.startP2P());
    else this.connectWs(true);
  }

  connectWs(first) {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    let opened = false;
    ws.onopen = () => { opened = true; this.mode = 'ws'; this.ws = ws; this.onOpen(); this.flush(); };
    ws.onmessage = e => this.onMessage(JSON.parse(e.data));
    ws.onerror = () => {};
    ws.onclose = () => {
      if (!opened && first) { this.startP2P(); return; }
      this.ws = null;
      this.onMessage({ t: 'disconnected' });
      setTimeout(() => this.connectWs(false), 1500);
    };
  }

  startP2P() {
    this.mode = 'p2p';
    this.onOpen();
  }

  // Пока связь моргает, отправлять некуда. Раньше сообщение в этот момент просто пропадало:
  // игрок жал «Забанить», и не происходило ничего — ни хода, ни объяснения. Теперь ход ждёт
  // восстановления связи, а если не дождался — об этом говорят вслух.
  queue(msg) {
    this.pending = (this.pending || []).filter(x => Date.now() - x.at < 20_000);
    this.pending.push({ msg, at: Date.now() });
    if (this.pending.length > 20) this.pending.shift();
    this.onMessage({ t: 'queued', kind: msg.t });
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      if (this.pending?.length) {
        this.pending = [];
        this.onMessage({ t: 'queueLost' });
      }
    }, 20_000);
  }

  flush() {
    const list = this.pending || [];
    this.pending = [];
    clearTimeout(this.pendingTimer);
    for (const { msg, at } of list) {
      // Ход, пролежавший дольше времени на один ход, отправлять бессмысленно: сервер его отклонит
      // по номеру шага, а игрок получит непонятную ошибку.
      if (msg.t === 'action' && Date.now() - at > 20_000) continue;
      this.send(msg);
    }
    if (list.length) this.onMessage({ t: 'queueSent', count: list.length });
  }

  canDeliver() {
    if (this.mode === 'ws') return this.ws?.readyState === 1;
    if (this.role === 'host') return true;
    if (this.role === 'guest') return !!(this.conn && this.conn.open);
    return true;
  }

  send(msg) {
    // Приветствие и выход осмысленны только сейчас, их копить незачем.
    if (QUEUED_KINDS.has(msg.t) && !this.canDeliver()) { this.queue(msg); return; }
    if (this.mode === 'ws') { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg)); return; }
    if (msg.t === 'hello') this.hello = msg;
    if (this.role === 'host') { this.manager.handle(this.local, msg); return; }
    if (this.role === 'guest') { if (msg.t === 'leave') { this.wantRoom = null; this.teardown(true); } else if (this.conn && this.conn.open) this.conn.send(msg); return; }
    if (msg.t === 'hello') this.onMessage({ t: 'hello', id: 0 });
    else if (msg.t === 'create') this.becomeHost(msg).catch(e => this.fail(e.message));
    else if (msg.t === 'join') {
      const code = String(msg.code || '').toUpperCase();
      this.wantJoin = code;
      this.joinWithRetry(code).catch(e => this.fail(e.message));
    }
    else if (msg.t === 'leave') this.onMessage({ t: 'left' });
  }

  // Хост мог на секунды потерять регистрацию на сигнальном сервере (уснувшая вкладка, моргнувший
  // интернет) — в этот момент его комната «не находится», хотя она есть. Поэтому пара попыток.
  async joinWithRetry(code, attempt = 0) {
    try {
      await this.connectGuest(code);
    } catch (e) {
      const recoverable = /не найдена|не отвечает/.test(e.message);
      if (recoverable && attempt < 2 && this.wantJoin === code) {
        this.onMessage({ t: 'joinRetry', attempt: attempt + 1 });
        await new Promise(r => setTimeout(r, 2500));
        return this.joinWithRetry(code, attempt + 1);
      }
      throw e;
    }
  }

  fail(text) {
    this.wantJoin = null;
    this.wantRoom = null;
    this.teardown(false);
    this.onMessage({ t: 'error', error: text });
  }

  teardown(emitLeft) {
    this.stopHostWatch();
    this.manager?.destroy();
    try { this.conn?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}
    this.manager = this.local = this.conn = this.peer = null;
    this.role = null;
    if (emitLeft) this.onMessage({ t: 'left' });
  }

  async becomeHost(createMsg) {
    this.teardown(false);
    const online = createMsg.mode === 'pvp';
    const Peer = online ? await loadPeerJs() : null;
    const code = !online ? randomCode() : await new Promise((res, rej) => {
      const tryCode = attempt => {
        const c = randomCode();
        const peer = new Peer(PEER_PREFIX + c, { config: ICE });
        peer.on('open', () => { this.peer = peer; res(c); });
        peer.on('error', e => {
          if (e.type === 'unavailable-id' && attempt < 5) { peer.destroy(); tryCode(attempt + 1); return; }
          if (!this.peer) { rej(new Error('Не удалось создать комнату. ' + peerError(e))); return; }
          if (e.type !== 'peer-unavailable') this.onMessage({ t: 'error', error: peerError(e) });
        });
      };
      tryCode(0);
    });
    this.manager = new RoomManager({
      engine: this.engine, cmHeroes: this.cmHeroes,
      send: (client, msg) => { if (client.local) this.onMessage(msg); else if (client.conn?.open) client.conn.send(msg); },
    });
    this.local = this.manager.createClient();
    this.local.local = true;
    this.role = 'host';
    this.manager.handle(this.local, this.hello);
    this.manager.handle(this.local, { ...createMsg, code });
    if (!this.peer) return;
    this.watchHost();
    this.peer.on('connection', conn => {
      const client = this.manager.createClient();
      client.conn = conn;
      conn.on('data', d => { try { this.manager.handle(client, d); } catch (e) { console.error(e); } });
      conn.on('close', () => this.manager?.leave(client));
      conn.on('error', () => this.manager?.leave(client));
    });
    this.peer.on('disconnected', () => this.checkHost());
    this.peer.on('open', () => this.reportHost(true));
  }

  // Одной попытки reconnect мало: она сама может не дойти, пока вкладка спит. Поэтому состояние
  // проверяется по таймеру, при возвращении к вкладке и при восстановлении интернета.
  watchHost() {
    this.stopHostWatch();
    this.hostOnline = true;
    this.hostTimer = setInterval(() => this.checkHost(), 10000);
    this.hostWake = () => this.checkHost();
    document.addEventListener('visibilitychange', this.hostWake);
    addEventListener('online', this.hostWake);
    addEventListener('focus', this.hostWake);
  }

  stopHostWatch() {
    clearInterval(this.hostTimer);
    this.hostTimer = null;
    if (this.hostWake) {
      document.removeEventListener('visibilitychange', this.hostWake);
      removeEventListener('online', this.hostWake);
      removeEventListener('focus', this.hostWake);
      this.hostWake = null;
    }
  }

  checkHost() {
    const peer = this.peer;
    if (this.role !== 'host' || !peer || peer.destroyed) return;
    if (peer.disconnected) {
      this.reportHost(false);
      try { peer.reconnect(); } catch {}
    } else {
      this.reportHost(true);
    }
  }

  reportHost(online) {
    if (this.hostOnline === online) return;
    this.hostOnline = online;
    this.onMessage({ t: 'hostState', online });
  }

  async connectGuest(code, reconnecting = false) {
    const Peer = await loadPeerJs();
    this.teardown(false);
    if (code.length !== 5) throw new Error('Комната не найдена');
    this.wantRoom = code;
    await new Promise((res, rej) => {
      const peer = new Peer({ config: ICE });
      this.peer = peer;
      const timeout = setTimeout(() => rej(new Error('Комната есть, но её создатель не отвечает — возможно, у него закрыта вкладка')), 15000);
      peer.on('open', () => {
        const conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
        conn.on('open', () => {
          clearTimeout(timeout);
          this.conn = conn;
          this.role = 'guest';
          conn.send(this.hello);
          conn.send({ t: 'join', code });
          if (reconnecting) this.onMessage({ t: 'reconnected' });
          this.flush();
          res();
        });
        conn.on('data', d => this.onMessage(d));
        // Обрыв не означает, что хост ушёл насовсем: у него могло моргнуть подключение. Сначала
        // пробуем вернуться в ту же комнату и только потом сдаёмся — иначе партия теряется зря.
        conn.on('close', () => { if (this.role === 'guest') this.retryGuest(code, 0); });
      });
      // Сигнальный сервер может отвалиться и после входа — тогда переподключаемся молча.
      peer.on('disconnected', () => { if (this.role === 'guest' && this.wantRoom === code) { try { peer.reconnect(); } catch {} } });
      peer.on('error', e => {
        clearTimeout(timeout);
        if (e.type === 'peer-unavailable') rej(new Error('Комната не найдена: возможно, её создатель закрыл вкладку'));
        else rej(new Error(peerError(e)));
      });
    });
  }

  retryGuest(code, attempt) {
    if (this.wantRoom !== code) return;
    if (attempt === 0) this.onMessage({ t: 'disconnected' });
    if (attempt >= 4) {
      this.wantRoom = null;
      this.onMessage({ t: 'error', error: 'Связь с комнатой потеряна: её создатель закрыл вкладку или пропал из сети' });
      this.teardown(true);
      return;
    }
    setTimeout(() => {
      if (this.wantRoom !== code) return;
      this.connectGuest(code, true).catch(() => this.retryGuest(code, attempt + 1));
    }, 900 * (attempt + 1));
  }
}
