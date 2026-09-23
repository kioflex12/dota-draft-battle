// Снимок работы движка оценки на фиксированном наборе драфтов.
//
// Нужен затем, что у правок в shared/analysis.js нет другого способа проверки: изменённая формула
// почти всегда выдаёт правдоподобные числа, в том числе с перепутанным знаком. Сравнение снимка
// до и после правки показывает, что именно сдвинулось.
//
//   node tools/analysis-baseline.mjs > before.txt
//   ...правка движка...
//   node tools/analysis-baseline.mjs > after.txt   &&   diff before.txt after.txt
//
// Составы и порядок ходов заданы жёстко, случайности нет — расхождение снимков означает правку
// движка, а не другой прогон.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../shared/analysis.js';
import { createDraft, applyAction, currentTurn, SEQUENCE } from '../shared/draft.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const heroes = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/heroes.json'), 'utf8'));
const stats = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/stats.json'), 'utf8'));
const engine = createEngine(heroes.heroes, stats);

const cm = heroes.heroes.filter(h => h.cm).map(h => h.id).sort((a, b) => a - b);
const nm = id => engine.H.get(id).name;
const f2 = x => x.toFixed(2);
const f3 = x => x.toFixed(3);

// Двадцать пар составов, набранных разными шагами по списку героев: так в выборку попадают и
// сильные, и проходные герои, а состав остаётся одним и тем же от запуска к запуску.
const DRAFTS = [];
for (let k = 0; k < 20; k++) {
  const step = 3 + (k % 7);
  const start = k * 5;
  const take = n => Array.from({ length: 5 }, (_, i) => cm[(start + n + i * step) % cm.length]);
  const rad = take(0);
  const dire = take(1).map((id, i) => (rad.includes(id) ? cm[(cm.indexOf(id) + 1 + i) % cm.length] : id));
  if (new Set([...rad, ...dire]).size === 10) DRAFTS.push([rad, dire]);
}

let problems = 0;
const warn = msg => { problems++; console.log('  !! ' + msg); };

console.log(`патч ${stats.meta.patch} · про-матчей ${stats.meta.proMatches} · паб-матчей ${stats.meta.pubMatches}`);
console.log(`составов в выборке: ${DRAFTS.length}`);

for (const [i, [rad, dire]] of DRAFTS.entries()) {
  const A = engine.analyze(rad, dire);
  console.log(`\n--- драфт ${i + 1}`);
  console.log('  свет: ' + rad.map(nm).join(', '));
  console.log('  тьма: ' + dire.map(nm).join(', '));
  console.log('  шанс победы света: ' + f3(A.prob));
  console.log('  слагаемые: ' + Object.entries(A.components).map(([k, v]) => `${k} ${f3(v)}`).join(' · '));
  console.log('  стадии: ранняя ' + f3(A.phases.early) + ' · мид ' + f3(A.phases.mid) + ' · лейт ' + f3(A.phases.late));
  console.log('  кривая: ' + A.curve.win.map(f2).join(' '));
  console.log('  линии: ' + A.lanes.map(l => `${l.key} ${l.total > 0 ? '+' : ''}${l.total}`).join(' · '));
  console.log('  позиции света: ' + A.positions.radiant.map(p => `${nm(p.hero)}=${p.pos + 1}`).join(' '));

  // Калибровка: CAL существует ровно затем, чтобы драфт не обещал больше ~75/25.
  if (A.prob < 0.2 || A.prob > 0.8) warn(`оценка вне полосы 20–80%: ${f3(A.prob)}`);
  for (const w of A.curve.win) if (w < 0.15 || w > 0.85) warn(`точка кривой вне полосы 15–85%: ${f2(w)}`);
  for (const [k, v] of Object.entries(A.components)) if (!Number.isFinite(v)) warn(`слагаемое ${k} не число`);
  if (A.curve.win.length !== A.curve.minutes.length) warn('длина кривой не совпадает с числом отметок');
}

// Ручная раскладка позиций должна менять разбор и не должна ломать его.
{
  const [rad, dire] = DRAFTS[0];
  const auto = engine.analyze(rad, dire);
  const swapped = auto.positions.radiant.map(p => p.pos);
  [swapped[0], swapped[4]] = [swapped[4], swapped[0]];
  const manual = engine.analyze(rad, dire, { posRadiant: swapped });
  console.log('\n--- ручная раскладка (1 и 5 поменяны местами)');
  console.log('  авто:   ' + f3(auto.prob) + ' · линии ' + auto.lanes.map(l => l.total).join('/'));
  console.log('  вручную:' + f3(manual.prob) + ' · линии ' + manual.lanes.map(l => l.total).join('/'));
  if (auto.prob === manual.prob) warn('ручная раскладка не изменила оценку');
  const bad = engine.analyze(rad, dire, { posRadiant: [0, 0, 1, 2, 3] });
  if (bad.prob !== auto.prob) warn('негодная раскладка не должна приниматься');
}

// Контрпик обязан быть симметричным: на этом держится оценка риска ответного пика.
{
  let worst = 0;
  for (let i = 0; i < 12; i++) {
    const a = cm[i * 7 % cm.length], b = cm[(i * 11 + 3) % cm.length];
    if (a === b) continue;
    worst = Math.max(worst, Math.abs(engine.ctr(a, b) + engine.ctr(b, a)));
  }
  console.log('\n--- симметрия контрпиков');
  console.log('  наибольшее расхождение ctr(a,b) + ctr(b,a): ' + worst.toExponential(2));
  if (worst > 1e-9) warn('контрпик несимметричен — оценка риска на этом не построится');
}

// Полный драфт по правилам Captains Mode: 24 хода ботом, затем разбор.
{
  const d = createDraft({ firstTeam: 'radiant', timers: false });
  let guard = 0;
  while (currentTurn(d) && guard++ < 50) {
    const t = currentTurn(d);
    const pool = engine.suggest({ picks: d.picks, bans: d.bans, step: d.step }, t.team, t.type, 1);
    applyAction(d, t.team, pool[0]?.hero ?? null, { now: 0 });
  }
  console.log('\n--- полный драфт Captains Mode');
  console.log('  ходов сделано: ' + d.history.length + ' из ' + SEQUENCE.length);
  console.log('  свет: ' + d.picks.radiant.map(nm).join(', '));
  console.log('  тьма: ' + d.picks.dire.map(nm).join(', '));
  if (d.history.length !== SEQUENCE.length) warn('драфт не доигран до конца');
  if (d.picks.radiant.length !== 5 || d.picks.dire.length !== 5) warn('в командах не по пять героев');
  const A = engine.analyze(d.picks.radiant, d.picks.dire);
  console.log('  шанс победы света: ' + f3(A.prob));
  const alts = engine.alternatives(d);
  const withOptions = alts.picks.radiant.filter(p => p.options.length).length;
  console.log('  альтернатив предложено на пиках света: ' + withOptions + ' из ' + alts.picks.radiant.length);
  console.log('  стоило забанить (свет): ' + alts.shouldBan.radiant.map(x => nm(x.hero)).join(', '));
  if (!withOptions) warn('ни к одному пику не подобрано альтернатив');
}

console.log(problems ? `\nПРОБЛЕМ: ${problems}` : '\nпроверки пройдены');
process.exit(problems ? 1 : 0);
