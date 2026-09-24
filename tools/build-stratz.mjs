// Третий источник статистики — STRATZ. Нужен ради того, чего нет ни в OpenDota-пабликах, ни в
// про-матчах: сколько игр герой провёл на каждой позиции и чем кончались его линии — по
// отдельности для каждой позиции и на большой выборке высокого рейтинга.
//
// До этого позиции брались только из про-матчей: у редкой роли набиралось полтора десятка игр, и
// «флекс работает или нет» решалось по случайности. Здесь тех же игр десятки тысяч.
//
// Ключ (бесплатный, stratz.com → Get Started With Our API) берётся из переменной окружения
// STRATZ_TOKEN или из .cache/stratz-token.txt. В репозиторий он не попадает.
//
//   node tools/build-stratz.mjs            # собрать data/stratz.json
//   node tools/build-stratz.mjs --pos      # только позиции, без линий
//
// Ограничения ключа: 20 запросов в секунду, 250 в минуту, 2000 в час — пауза ниже с запасом.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const CACHE = path.join(ROOT, '.cache');
const PATCH = '7.41f';
const PATCH_TS = 1789430400;
const BRACKET = 'DIVINE_IMMORTAL';
const args = new Set(process.argv.slice(2));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const token = process.env.STRATZ_TOKEN || (await fs.readFile(path.join(CACHE, 'stratz-token.txt'), 'utf8').catch(() => '')).trim();
if (!token) {
  console.error('Нет ключа. Положите его в .cache/stratz-token.txt или в переменную STRATZ_TOKEN.');
  process.exit(2);
}

async function gql(query, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch('https://api.stratz.com/graphql', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'STRATZ_API', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (res.status === 429) { await sleep(20_000); continue; }
    const json = await res.json().catch(() => null);
    if (json?.data) { await sleep(300); return json.data; }
    if (i === tries - 1) throw new Error('STRATZ: ' + (json ? JSON.stringify(json.errors).slice(0, 200) : res.status));
    await sleep(3000 * (i + 1));
  }
}

const POS = ['POSITION_1', 'POSITION_2', 'POSITION_3', 'POSITION_4', 'POSITION_5'];
const posIndex = name => POS.indexOf(name);

const heroes = JSON.parse(await fs.readFile(path.join(DATA, 'heroes.json'), 'utf8')).heroes;
const ids = heroes.map(h => h.id);

// ---------- позиции ----------
async function buildPositions() {
  const pos = {};
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const d = await gql(`{ heroStats { stats(heroIds: [${chunk}], bracketBasicIds: [${BRACKET}], groupByPosition: true, minTime: ${PATCH_TS}) { heroId position matchCount winCount } } }`);
    for (const r of d.heroStats.stats) {
      const p = posIndex(r.position);
      if (p < 0) continue;
      pos[r.heroId] = pos[r.heroId] || [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]];
      pos[r.heroId][p] = [r.matchCount, r.winCount];
    }
    console.log(`позиции ${Math.min(i + 20, ids.length)}/${ids.length}`);
  }
  return pos;
}

// ---------- линии ----------
// Исход линии, а не разница золота: STRATZ считает, выиграна ли линия, проиграна или ничья.
// Отдельно для союзников по линии (isWith) и для тех, кто стоял напротив.
async function buildLanes() {
  const withRows = [], vsRows = [];
  let i = 0;
  for (const id of ids) {
    const d = await gql(`{ heroStats {
      w: laneOutcome(heroId: ${id}, isWith: true, bracketBasicIds: [${BRACKET}]) { heroId1 heroId2 position matchCount winCount lossCount matchWinCount }
      v: laneOutcome(heroId: ${id}, isWith: false, bracketBasicIds: [${BRACKET}]) { heroId1 heroId2 position matchCount winCount lossCount matchWinCount }
    } }`);
    for (const [key, out] of [['w', withRows], ['v', vsRows]]) {
      for (const r of d.heroStats[key]) {
        const p = posIndex(r.position);
        if (p < 0 || r.matchCount < 8) continue;
        out.push([r.heroId1, r.heroId2, p, r.matchCount, r.winCount, r.lossCount, r.matchWinCount]);
      }
    }
    if (++i % 20 === 0) console.log(`линии ${i}/${ids.length}`);
  }
  return { withRows, vsRows };
}

const pos = await buildPositions();
const lanes = args.has('--pos') ? { withRows: [], vsRows: [] } : await buildLanes();
const out = {
  meta: { patch: PATCH, bracket: 'Divine+Immortal', source: 'STRATZ', generatedAt: new Date().toISOString(), since: new Date(PATCH_TS * 1000).toISOString().slice(0, 10) },
  pos,
  laneWith: lanes.withRows,
  laneVs: lanes.vsRows,
};
await fs.writeFile(path.join(DATA, 'stratz.json'), JSON.stringify(out));
const games = Object.values(pos).reduce((s, a) => s + a.reduce((x, [n]) => x + n, 0), 0);
console.log(`готово: позиций по ${Object.keys(pos).length} героям (${games} игр), пар на линии ${lanes.withRows.length} + ${lanes.vsRows.length}`);
