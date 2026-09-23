import { RoomManager, randomCode } from '../shared/room.js';

const PEER_PREFIX = 'ddb-';
const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:openrelay.metered.ca:80' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

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
    if (forceP2P || location.protocol === 'file:' || location.hostname.endsWith('github.io')) this.startP2P();
    else this.connectWs(true);
  }

  connectWs(first) {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    let opened = false;
    ws.onopen = () => { opened = true; this.mode = 'ws'; this.ws = ws; this.onOpen(); };
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

  send(msg) {
    if (this.mode === 'ws') { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg)); return; }
    if (msg.t === 'hello') this.hello = msg;
    if (this.role === 'host') { this.manager.handle(this.local, msg); return; }
    if (this.role === 'guest') { if (msg.t === 'leave') this.teardown(true); else this.conn.send(msg); return; }
    if (msg.t === 'hello') this.onMessage({ t: 'hello', id: 0 });
    else if (msg.t === 'create') this.becomeHost(msg).catch(e => this.fail(e.message));
    else if (msg.t === 'join') this.connectGuest(String(msg.code || '').toUpperCase()).catch(e => this.fail(e.message));
    else if (msg.t === 'leave') this.onMessage({ t: 'left' });
  }

  fail(text) {
    this.teardown(false);
    this.onMessage({ t: 'error', error: text });
  }

  teardown(emitLeft) {
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
          if (!this.peer) { rej(new Error('Не удалось создать комнату: ' + (e.type || e.message))); return; }
          if (e.type !== 'peer-unavailable') this.onMessage({ t: 'error', error: 'Ошибка сети: ' + (e.type || e.message) });
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
    this.peer.on('connection', conn => {
      const client = this.manager.createClient();
      client.conn = conn;
      conn.on('data', d => { try { this.manager.handle(client, d); } catch (e) { console.error(e); } });
      conn.on('close', () => this.manager?.leave(client));
      conn.on('error', () => this.manager?.leave(client));
    });
    this.peer.on('disconnected', () => { try { this.peer?.reconnect(); } catch {} });
  }

  async connectGuest(code) {
    const Peer = await loadPeerJs();
    this.teardown(false);
    if (code.length !== 5) throw new Error('Комната не найдена');
    await new Promise((res, rej) => {
      const peer = new Peer({ config: ICE });
      this.peer = peer;
      const timeout = setTimeout(() => rej(new Error('Хост не отвечает')), 15000);
      peer.on('open', () => {
        const conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
        conn.on('open', () => {
          clearTimeout(timeout);
          this.conn = conn;
          this.role = 'guest';
          conn.send(this.hello);
          conn.send({ t: 'join', code });
          res();
        });
        conn.on('data', d => this.onMessage(d));
        conn.on('close', () => { if (this.role === 'guest') { this.onMessage({ t: 'error', error: 'Хост отключился' }); this.teardown(true); } });
      });
      peer.on('error', e => {
        clearTimeout(timeout);
        if (e.type === 'peer-unavailable') rej(new Error('Комната не найдена'));
        else rej(new Error('Ошибка сети: ' + (e.type || e.message)));
      });
    });
  }
}
