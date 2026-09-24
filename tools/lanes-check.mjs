// Проверка расстановки линий между драфтом и разбором.
//
// Смысл этапа: обе команды заявляют, кто на какой позиции, до того как увидят оценку. Поэтому
// проверяется не только «сохранилось ли», но и что чужую раскладку не поставить, свою после
// показа не переиграть, а зависший капитан не держит комнату вечно.
//
//   node tools/lanes-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../shared/analysis.js';
import { RoomManager } from '../shared/room.js';
import { currentTurn, isAvailable, applyAction } from '../shared/draft.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const heroes = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/heroes.json'), 'utf8'));
const stats = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/stats.json'), 'utf8'));
const stratz = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data/stratz.json'), 'utf8')); } catch { return null; } })();
const engine = createEngine(heroes.heroes, stats, stratz);
const cmHeroes = heroes.heroes.filter(h => h.cm).map(h => h.id);

let problems = 0;
const check = (ok, text) => {
  console.log((ok ? '  ок   ' : '  ПЛОХО') + ' ' + text);
  if (!ok) problems++;
};

const sent = [];
const manager = new RoomManager({ engine, cmHeroes, send: (client, msg) => sent.push({ client, msg }) });
clearInterval(manager.timer);

const connect = (name, token) => {
  const c = manager.createClient();
  manager.handle(c, { t: 'hello', name, token });
  return c;
};

// Драфт целиком: ходы делаются вручную, таймеры выключены.
function playDraft() {
  const a = connect('Первый', 'tok-a');
  manager.handle(a, { t: 'create', mode: 'pvp', order: 'radiant', timers: false });
  const room = a.room;
  const b = connect('Второй', 'tok-b');
  manager.handle(b, { t: 'join', code: room.code });
  manager.handle(a, { t: 'start' });
  while (currentTurn(room.draft)) {
    const t = currentTurn(room.draft);
    const who = t.team === a.team ? a : b;
    const hero = cmHeroes.find(id => isAvailable(room.draft, id));
    manager.handle(who, { t: 'action', hero });
  }
  return { room, a, b };
}

const { room, a, b } = playDraft();
check(room.phase === 'lanes', 'после драфта идёт расстановка линий, а не сразу разбор');
check(room.lanesReady.length === 0, 'пока никто не готов');
check(room.lanesDeadline > Date.now(), 'на расстановку дан срок');

const pub = () => manager.publicRoom(room);
check(pub().layout.radiant === null && pub().layout.dire === null, 'чужая раскладка до разбора не видна никому');

sent.length = 0;
manager.handle(a, { t: 'lanes', pos: [0, 1, 2, 3, 3] });
check(sent.some(x => x.client === a && x.msg.t === 'error'), 'раскладка с повтором позиции отклонена');
check(room.layout[a.team] === null, 'и ничего не сохранила');

const mine = [4, 3, 2, 1, 0];
manager.handle(a, { t: 'lanes', team: b.team, pos: mine });
check(JSON.stringify(room.layout[a.team]) === JSON.stringify(mine), 'капитан ставит раскладку своей команде');
check(room.layout[b.team] === null, 'чужую раскладку через team не подменить');
check(room.phase === 'lanes', 'одной команды мало — ждём вторую');

sent.length = 0;
manager.broadcast(room);
const toA = sent.find(x => x.client === a && x.msg.t === 'room');
check(JSON.stringify(toA.msg.you.layout[a.team]) === JSON.stringify(mine), 'свою раскладку игрок видит и после переподключения');
check(toA.msg.you.layout[b.team] === undefined, 'чужую — нет');

manager.handle(b, { t: 'lanes', pos: [0, 1, 2, 3, 4] });
check(room.phase === 'done', 'обе команды готовы — открывается разбор');
check(pub().layout.radiant && pub().layout.dire, 'в разборе видны обе раскладки');

manager.handle(a, { t: 'lanes', pos: [1, 0, 2, 3, 4] });
check(JSON.stringify(room.layout[a.team]) === JSON.stringify(mine), 'после разбора раскладку не переиграть');

// Бот раскладку ставит сам, ждать его не надо.
const c = connect('Одиночка', 'tok-c');
manager.handle(c, { t: 'create', mode: 'bot', difficulty: 'normal', side: 'radiant', timers: false });
const botRoom = c.room;
clearTimeout(botRoom.botTimer);
while (currentTurn(botRoom.draft)) {
  const t = currentTurn(botRoom.draft);
  const hero = cmHeroes.find(id => isAvailable(botRoom.draft, id));
  // За бота здесь ходим сами: его собственный ход отложен таймером, а проверке ждать нечего.
  if (t.team === c.team) manager.handle(c, { t: 'action', hero });
  else { applyAction(botRoom.draft, t.team, hero); manager.afterAction(botRoom); }
  clearTimeout(botRoom.botTimer);
}
check(botRoom.phase === 'lanes', 'в игре с ботом этап линий тоже есть, а не сразу разбор');
check(botRoom.lanesReady.includes(c.team === 'radiant' ? 'dire' : 'radiant'), 'бот расставил линии сам');

// Ушедший капитан не держит комнату: по истечении срока раскладка ставится по про-статистике.
const { room: room2, a: a2 } = playDraft();
manager.handle(a2, { t: 'lanes', pos: [0, 1, 2, 3, 4] });
room2.lanesDeadline = Date.now() - 1;
manager.tick();
check(room2.phase === 'done', 'по истечении срока разбор открывается без второго капитана');
const auto = manager.autoLayout(room2, a2.team === 'radiant' ? 'dire' : 'radiant');
check(JSON.stringify(room2.layout[a2.team === 'radiant' ? 'dire' : 'radiant']) === JSON.stringify(auto), 'за него расставлено по про-статистике');

// Реванш начинает с чистой раскладки.
manager.startMatch(room2);
check(room2.layout.radiant === null && room2.lanesReady.length === 0, 'реванш сбрасывает раскладку');

console.log(problems ? `\nПРОБЛЕМ: ${problems}` : '\nпроверки пройдены');
process.exit(problems ? 1 : 0);
