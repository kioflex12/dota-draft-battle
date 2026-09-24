// Проверка калибровки: насколько обещанный шанс победы совпадает с тем, чем матчи кончаются
// на самом деле.
//
// Нужна затем, что спорить о числе «55% или 90%» бессмысленно без замера. Берутся матчи, которых
// движок не видел при сборке статистики, по каждому считается тот же шанс, что показывается
// человеку, и дальше сравниваются две вещи: средний обещанный шанс в корзине и доля реальных
// побед в ней. Если модель осторожничает, доля побед в крайних корзинах будет выше обещанной —
// и наклон подгонки окажется больше единицы.
//
//   node tools/calibration.mjs              # свежие паблики Divine+, которых не было в сборке
//   node tools/calibration.mjs --pro        # про-матчи прошлого патча (другой патч — оговорка ниже)
//   node tools/calibration.mjs --split      # честная проверка на про-матчах: статистика собрана
//                                           # по первым месяцам патча, проверка — по последним
//
// Для --split нужна урезанная сборка (сеть не нужна, всё берётся из .cache):
//   PRO_UNTIL=<секунды> STATS_OUT=.cache/stats_train.json node tools/build-data.mjs --offline
//
// Ответы OpenDota складываются в .cache, повторный прогон идёт с диска.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../shared/analysis.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const args = new Set(process.argv.slice(2));
const heroes = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/heroes.json'), 'utf8'));
const statsFile = args.has('--split') ? path.join(CACHE, 'stats_train.json') : path.join(ROOT, 'data/stats.json');
const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
const engine = createEngine(heroes.heroes, stats);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sql(query) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch('https://api.opendota.com/api/explorer?sql=' + encodeURIComponent(query), { headers: { 'User-Agent': 'dota-draft-battle/1.0' } });
    if (res.status === 429) { await sleep(5000 * (i + 1)); continue; }
    const json = await res.json();
    if (json.err) throw new Error(json.err);
    await sleep(1100);
    return json.rows;
  }
  throw new Error('rate limited');
}

async function cached(name, fn) {
  const file = path.join(CACHE, name + '.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const v = await fn();
  fs.writeFileSync(file, JSON.stringify(v));
  return v;
}

// Граница обучающей выборки: до какого матча статистика уже всё видела. Берём её из кэша сборки,
// чтобы проверка гарантированно шла по матчам, которых в статистике нет.
function trainedUpTo() {
  const ends = fs.readdirSync(CACHE).filter(f => f.startsWith('pub_') && f.endsWith('.json'))
    .map(f => Number(f.replace('.json', '').split('_')[2])).filter(Number.isFinite);
  return Math.max(...ends);
}

async function pubHoldout() {
  const from = trainedUpTo();
  const rows = await cached(`holdout_pub_${from}`, async () => {
    const r = await sql(`SELECT radiant_win r, radiant_team rt, dire_team dt FROM public_matches WHERE match_id > ${from} AND lobby_type = 7 AND avg_rank_tier >= 60 AND duration >= 720`);
    return r.map(x => [x.r ? 1 : 0, x.rt, x.dt]);
  });
  return { label: `паблики Divine+ после матча ${from} (в статистику не попали)`, rows };
}

// Про-матчи прошлого патча. Оговорка: патч другой, поэтому сила героев частью изменилась — это
// проверка «в худших условиях», занижающая точность, а не завышающая.
async function proHoldout() {
  const rows = await cached('holdout_pro_prev_patch', async () => {
    const picks = await sql(`SELECT pb.match_id m, pb.hero_id h, pb.team t FROM picks_bans pb JOIN matches mt USING(match_id) WHERE mt.start_time >= 1766000000 AND mt.start_time < 1774313459 AND pb.is_pick = true`);
    const res = await sql(`SELECT match_id m, radiant_win r FROM matches WHERE start_time >= 1766000000 AND start_time < 1774313459`);
    const byId = new Map(res.map(x => [String(x.m), x.r ? 1 : 0]));
    const teams = new Map();
    for (const p of picks) {
      const k = String(p.m);
      if (!teams.has(k)) teams.set(k, [[], []]);
      teams.get(k)[p.t === 0 ? 0 : 1].push(p.h);
    }
    const out = [];
    for (const [k, [rt, dt]] of teams) if (byId.has(k) && rt.length === 5 && dt.length === 5) out.push([byId.get(k), rt, dt]);
    return out;
  });
  return { label: 'про-матчи прошлого патча (сила героев уже другая — замер занижает точность)', rows };
}

// Честная проверка на том, ради чего движок и сделан: про-драфты текущего патча, но взятые
// позже той черты, по которую собрана статистика. Матчи лежат в .cache с прошлой сборки, сеть
// не нужна. Оговорка: паблик-часть статистики собрана по всему патчу, то есть общая расстановка
// сил в патче модели известна — как и живому игроку.
function proSplit() {
  const cut = new Date(stats.meta.proUntil + 'T00:00:00Z').getTime() / 1000;
  const rows = [];
  for (const f of fs.readdirSync(CACHE).filter(f => /^pro_\d+_\d+\.json$/.test(f))) {
    const [, a] = f.replace('.json', '').split('_').map(Number);
    if (a < cut) continue;
    const { players } = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8'));
    const by = new Map();
    for (const p of players) {
      const k = String(p.m);
      if (!by.has(k)) by.set(k, { r: p.r, rt: [], dt: [] });
      (p.s < 128 ? by.get(k).rt : by.get(k).dt).push(p.h);
    }
    for (const g of by.values()) if (g.rt.length === 5 && g.dt.length === 5) rows.push([g.r ? 1 : 0, g.rt, g.dt]);
  }
  return { label: `про-матчи после ${stats.meta.proUntil}; статистика собрана только по матчам до этой даты`, rows };
}

const { label, rows } = args.has('--split') ? proSplit() : args.has('--pro') ? await proHoldout() : await pubHoldout();
const known = new Set(heroes.heroes.map(h => h.id));
const games = rows.filter(([, rt, dt]) => rt?.length === 5 && dt?.length === 5
  && rt.every(h => known.has(h)) && dt.every(h => known.has(h))
  && new Set([...rt, ...dt]).size === 10);

const preds = games.map(([won, rt, dt]) => ({ p: engine.analyze(rt, dt).prob, won }));

const logit = p => Math.log(p / (1 - p));
const sig = x => 1 / (1 + Math.exp(-x));
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

const logLoss = mean(preds.map(({ p, won }) => -(won * Math.log(p) + (1 - won) * Math.log(1 - p))));
const brier = mean(preds.map(({ p, won }) => (p - won) ** 2));
const baseRate = mean(preds.map(p => p.won));
const baseLoss = -(baseRate * Math.log(baseRate) + (1 - baseRate) * Math.log(1 - baseRate));
const acc = mean(preds.map(({ p, won }) => ((p >= 0.5 ? 1 : 0) === won ? 1 : 0)));

// Подгонка: won ~ sig(a + b * logit(p)). Наклон b — главный ответ. b ≈ 1 значит «обещаем ровно
// столько, сколько выходит»; b > 1 — модель осторожничает, b < 1 — завышает уверенность.
// Свободный член a вбирает перевес стороны Света, чтобы он не путался с наклоном.
let a = 0, b = 1;
for (let it = 0; it < 60; it++) {
  let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
  for (const { p, won } of preds) {
    const x = logit(p), mu = sig(a + b * x), w = mu * (1 - mu), e = won - mu;
    g0 += e; g1 += e * x; h00 += w; h01 += w * x; h11 += w * x * x;
  }
  const det = h00 * h11 - h01 * h01;
  if (!det) break;
  const da = (h11 * g0 - h01 * g1) / det, db = (h00 * g1 - h01 * g0) / det;
  a += da; b += db;
  if (Math.abs(da) + Math.abs(db) < 1e-9) break;
}

const EDGES = [0, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 1];
console.log(`Выборка: ${label}`);
console.log(`Матчей: ${preds.length}\n`);
console.log('обещано      | матчей | обещано в среднем | побед на деле');
for (let i = 0; i < EDGES.length - 1; i++) {
  const inBin = preds.filter(({ p }) => p >= EDGES[i] && p < EDGES[i + 1]);
  if (!inBin.length) continue;
  const lo = (EDGES[i] * 100).toFixed(0), hi = (EDGES[i + 1] * 100).toFixed(0);
  console.log(`${(lo + '–' + hi + '%').padEnd(12)} | ${String(inBin.length).padStart(6)} | ${(mean(inBin.map(x => x.p)) * 100).toFixed(1).padStart(17)}% | ${(mean(inBin.map(x => x.won)) * 100).toFixed(1).padStart(13)}%`);
}

const spread = q => preds.filter(({ p }) => Math.abs(p - 0.5) >= q).length / preds.length * 100;
console.log(`\nНаклон подгонки: ${b.toFixed(3)} (1.00 — обещаем ровно столько, сколько выходит; больше — осторожничаем)`);
console.log(`Свободный член:  ${a.toFixed(3)} (перевес стороны Света сам по себе)`);
console.log(`Угадано сторон:  ${(acc * 100).toFixed(1)}% (монетка — 50%)`);
console.log(`Ошибка (log loss): ${logLoss.toFixed(4)} против ${baseLoss.toFixed(4)} у «всегда 50 на 50»`);
console.log(`Brier: ${brier.toFixed(4)}`);
console.log(`Оценок дальше 55/45: ${spread(0.05).toFixed(1)}%, дальше 60/40: ${spread(0.1).toFixed(1)}%, дальше 65/35: ${spread(0.15).toFixed(1)}%, дальше 75/25: ${spread(0.25).toFixed(1)}%`);
const hi = preds.filter(({ p }) => Math.abs(p - 0.5) >= 0.15);
if (hi.length) console.log(`В самых уверенных оценках (дальше 65/35) угадано: ${(mean(hi.map(({ p, won }) => ((p >= 0.5 ? 1 : 0) === won ? 1 : 0))) * 100).toFixed(1)}% при ${hi.length} матчах`);
