// Проверка того, что происходит с драфтом, когда игрок пропал со связи.
//
// Путь этот в браузере не проверить: там никто не отключается посреди теста, а в снимке движка
// (npm run check) комнат нет вовсе. Поэтому RoomManager гоняется здесь напрямую.
//
//   node tools/room-abandon-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../shared/analysis.js';
import { RoomManager } from '../shared/room.js';
import { currentTurn } from '../shared/draft.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const heroes = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/heroes.json'), 'utf8'));
const stats = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/stats.json'), 'utf8'));
const engine = createEngine(heroes.heroes, stats);

let problems = 0;
const check = (ok, text) => {
  console.log((ok ? '  ок   ' : '  ПЛОХО') + ' ' + text);
  if (!ok) problems++;
};

// Отправленные сообщения запоминаем: по ним проверяется, что комната чинит отставший экран.
const sent = [];
const manager = new RoomManager({
  engine,
  cmHeroes: heroes.heroes.filter(h => h.cm).map(h => h.id),
  send: (client, msg) => sent.push({ client, msg }),
});
// Собственный таймер менеджера здесь не нужен: время в проверке задаётся вручную.
clearInterval(manager.timer);

const connect = (name, token) => {
  const c = manager.createClient();
  manager.handle(c, { t: 'hello', name, token });
  return c;
};

const a = connect('Первый', 'token-a');
manager.handle(a, { t: 'create', mode: 'pvp', order: 'radiant', timers: false });
const room = a.room;
const b = connect('Второй', 'token-b');
manager.handle(b, { t: 'join', code: room.code });
manager.handle(a, { t: 'start' });

check(room.phase === 'draft', 'драфт начался');
const turn = currentTurn(room.draft);
const away = turn.team === 'radiant' ? a : b;
const awayTeam = turn.team;   // leave() обнуляет client.team, поэтому сторону запоминаем заранее
check(!!room.seats[turn.team] && !room.seats[turn.team].bot, 'ход за живым игроком');

const t0 = Date.now();
const steps = () => room.draft.history.length;

// 1. Игрок на связи — никто за него не ходит, сколько бы времени ни прошло.
manager.coverAbandonedTurn(room, t0);
manager.coverAbandonedTurn(room, t0 + 10 * 60_000);
check(steps() === 0, 'пока игрок на связи, за него не ходят');

// 2. Игрок пропал: отсчёт пошёл, но сразу за него не ходят.
manager.leave(away);
manager.coverAbandonedTurn(room, t0 + 1000);
check(steps() === 0, 'сразу после обрыва ход не делается');
manager.coverAbandonedTurn(room, t0 + 60_000);
check(steps() === 0, 'через минуту ход всё ещё не делается');

// 3. Полторы минуты прошло — партия продолжается без него.
manager.coverAbandonedTurn(room, t0 + 95_000);
check(steps() === 1, 'через полторы минуты ход делается автоматически');

// 4. Игрок вернулся — и снова отвалился на том же ходу. Отсчёт обязан начаться заново.
//    Именно здесь пряталась ошибка: метка времени обнулялась при возврате, а номер хода
//    оставался прежним, поэтому повторный обрыв сравнивал время с нулём и ход делался мгновенно.
const back = connect('Первый', 'token-a');
manager.handle(back, { t: 'join', code: room.code });
check(back.team === awayTeam, 'вернувшийся получил своё место обратно');

const turn2 = currentTurn(room.draft);
const away2 = turn2.team === back.team ? back : b;
const t1 = t0 + 100_000;
manager.coverAbandonedTurn(room, t1);            // оба на связи
manager.leave(away2);
manager.coverAbandonedTurn(room, t1 + 1000);     // первый обрыв: отсчёт пошёл
const reconnected = connect('Вернулся', away2 === back ? 'token-a' : 'token-b');
manager.handle(reconnected, { t: 'join', code: room.code });
manager.coverAbandonedTurn(room, t1 + 20_000);   // вернулся: отсчёт сброшен
manager.leave(reconnected);                       // и снова пропал, ход тот же самый
const before = steps();
manager.coverAbandonedTurn(room, t1 + 21_000);
check(steps() === before, 'после возврата и повторного обрыва ход не делается мгновенно');
manager.coverAbandonedTurn(room, t1 + 60_000);
check(steps() === before, 'отсчёт идёт от повторного обрыва, а не от первого');
manager.coverAbandonedTurn(room, t1 + 115_000);
check(steps() === before + 1, 'через полторы минуты после повторного обрыва ход делается');

// Сверка состояния по сердцебиению. Ради неё всё и затевалось: если сообщение об изменении не
// доехало, у игрока на экране висит чужой ход и кнопка не нажимается — сам он это не починит.
const spec = connect('Зритель', 'token-s');
manager.handle(spec, { t: 'join', code: room.code });
const pings = (step, phase) => { sent.length = 0; manager.handle(spec, { t: 'ping', at: 1, step, phase }); return sent.filter(x => x.client === spec && x.msg.t === 'room').length; };
check(pings(Math.max(0, room.draft.step - 2), 'draft') === 1, 'отставшему экрану досылается состояние');
check(pings(room.draft.step, 'draft') === 0, 'совпадающему экрану ничего лишнего не шлётся');
check(pings(room.draft.step, 'lobby') === 1, 'разошедшийся этап комнаты тоже чинится');
sent.length = 0;
manager.handle(spec, { t: 'ping', at: 1 });
check(sent.some(x => x.client === spec && x.msg.t === 'pong'), 'на пинг без состояния приходит ответ о задержке');
check(!sent.some(x => x.msg.t === 'room'), 'пинг без состояния состояние не запрашивает');

console.log(problems ? `\nПРОБЛЕМ: ${problems}` : '\nпроверки пройдены');
process.exit(problems ? 1 : 0);
