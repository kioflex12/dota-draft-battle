import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createEngine } from '../shared/analysis.js';
import { RoomManager } from '../shared/room.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;

const heroesData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/heroes.json'), 'utf8'));
const statsData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/stats.json'), 'utf8'));
const engine = createEngine(heroesData.heroes, statsData);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const STATIC = [['/shared/', path.join(ROOT, 'shared')], ['/data/', path.join(ROOT, 'data')], ['/', path.join(ROOT, 'public')]];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  for (const [prefix, dir] of STATIC) {
    if (!p.startsWith(prefix)) continue;
    const file = path.join(dir, p.slice(prefix.length));
    if (!file.startsWith(dir)) break;
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': prefix === '/data/' ? 'public, max-age=3600' : 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
    return;
  }
  res.writeHead(404); res.end('Not found');
});

const manager = new RoomManager({
  engine,
  cmHeroes: heroesData.heroes.filter(h => h.cm).map(h => h.id),
  send: (client, msg) => { if (client.ws?.readyState === 1) client.ws.send(JSON.stringify(msg)); },
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  const client = manager.createClient();
  client.ws = ws;
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { manager.handle(client, msg); } catch (e) { console.error(e); manager.send(client, { t: 'error', error: 'Ошибка сервера' }); }
  });
  ws.on('close', () => manager.leave(client));
});

server.listen(PORT, () => {
  console.log(`Dota Draft Battle: http://localhost:${PORT}  (patch ${heroesData.patch}, ${statsData.meta.pubMatches} pub + ${statsData.meta.proMatches} pro matches)`);
});
