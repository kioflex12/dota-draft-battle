const logit = p => Math.log(p / (1 - p));
const sig = x => 1 / (1 + Math.exp(-x));
export const toPct = x => (sig(x) - 0.5) * 100;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sum = arr => arr.reduce((s, x) => s + x, 0);

export const ROLE_KEYS = ['carry', 'support', 'nuker', 'disabler', 'jungler', 'durable', 'escape', 'pusher', 'initiator'];
export const ROLE_NAMES = {
  carry: 'Керри', support: 'Поддержка', nuker: 'Нюкер', disabler: 'Контроль', jungler: 'Лесник',
  durable: 'Живучесть', escape: 'Мобильность', pusher: 'Пуш', initiator: 'Инициация',
};
export const POS_NAMES = ['Керри', 'Мидер', 'Оффлейнер', 'Роумер', 'Саппорт'];
export const POS_SHORT = ['1', '2', '3', '4', '5'];

const K_PUB = 200;
const K_PRO = 60;
const K_PAIR_PUB = 250;
const K_PAIR_PRO = 20;
const K_PHASE_PUB = 150;
const K_PHASE_PRO = 25;
const K_LANE = 20;
const K_LANE_PAIR = 12;
const LANE_TO_LOGIT = 0.00006;
const PHASE_WEIGHT = 0.45;
// Перевес на линии — это золото и опыт к 10-й минуте: к сороковой он либо уже превращён в
// объекты, либо отыгран фармом. Поэтому в кривой по минутам он затухает, а не стоит плоско.
const LANE_DECAY_MIN = 0.35;
const LANE_DECAY_SPAN = 1.45;
const LANE_DECAY_TAU = 18;
// Drafts rarely decide more than ~75/25 in real Dota; the raw sum of signals is overconfident.
const CAL = 0.7;
// Насколько сильно риск ответного пика опускает кандидата. Подобрано так, чтобы он разводил
// близких по силе героев, но не перевешивал реальную выгоду от пика.
const RISK_WEIGHT = 0.8;
const PHASE_CENTERS = [16, 22.5, 27.5, 32.5, 37.5, 42.5, 47.5, 55, 65];
export const CURVE_MINUTES = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];

// Вес перевеса линий на минуте m. Нормирован так, чтобы в среднем по кривой он равнялся единице:
// иначе кривая в целом уезжала бы относительно общей оценки драфта.
const laneRaw = m => LANE_DECAY_MIN + LANE_DECAY_SPAN * Math.exp(-(m - CURVE_MINUTES[0]) / LANE_DECAY_TAU);
const LANE_NORM = CURVE_MINUTES.reduce((s, m) => s + laneRaw(m), 0) / CURVE_MINUTES.length;
export const laneWeightAt = m => laneRaw(m) / LANE_NORM;

function permutations(n) {
  const res = [];
  const rec = (arr, used) => {
    if (arr.length === n) { res.push(arr.slice()); return; }
    for (let i = 0; i < 5; i++) if (!used[i]) { used[i] = true; arr.push(i); rec(arr, used); arr.pop(); used[i] = false; }
  };
  rec([], []);
  return res;
}
const PERMS = [0, 1, 2, 3, 4, 5].map(permutations);

const EMPTY = { pubG: 0, pubW: 0, proG: 0, proW: 0, pick: 0, ban: 0, pos: [0, 0, 0, 0, 0], posW: [0, 0, 0, 0, 0], lane: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]], dur: [], proDur: [] };

export function createEngine(heroList, stats) {
  const H = new Map(heroList.map(h => [h.id, h]));
  const ids = heroList.map(h => h.id);
  const S = id => stats.heroes[id] || EMPTY;
  const proDrafts = Math.max(1, stats.meta.proDrafts || 1);
  const key = (a, b) => a * 1000 + b;

  // ---------- hero strength: pro scene first, pubs refine ----------
  const pubBase = {}, proBase = {}, base = {}, wr = {}, proWr = {}, contest = {}, pickRate = {}, banRate = {};
  let contestSum = 0;
  for (const id of ids) {
    const s = S(id);
    pickRate[id] = s.pick / proDrafts;
    banRate[id] = s.ban / proDrafts;
    contest[id] = (s.pick + s.ban) / proDrafts;
    contestSum += contest[id];
  }
  const avgContest = contestSum / ids.length;
  const metaTerm = {};
  for (const id of ids) {
    const s = S(id);
    wr[id] = s.pubG ? s.pubW / s.pubG : 0.5;
    proWr[id] = s.proG ? s.proW / s.proG : null;
    pubBase[id] = logit((s.pubW + K_PUB * 0.5) / (s.pubG + K_PUB));
    proBase[id] = logit((s.proW + K_PRO * 0.5) / (s.proG + K_PRO));
    metaTerm[id] = clamp(0.5 * Math.log((contest[id] + 0.04) / (avgContest + 0.04)), -0.12, 0.2);
    base[id] = 0.35 * pubBase[id] + 0.45 * proBase[id] + metaTerm[id];
  }

  // ---------- pairs ----------
  const pubSyn = new Map(), pubVs = new Map(), proSyn = new Map(), proVs = new Map();
  const pairAdv = (g, w, p0, K, lim) => clamp(logit((w + K * p0) / (g + K)) - logit(p0), -lim, lim);
  for (const [a, b, g, w] of stats.syn) {
    const adv = pairAdv(g, w, sig(pubBase[a] + pubBase[b]), K_PAIR_PUB, 0.35);
    pubSyn.set(key(a, b), { g, w, adv }); pubSyn.set(key(b, a), { g, w, adv });
  }
  for (const [a, b, g, w] of stats.vs) {
    const adv = pairAdv(g, w, sig(pubBase[a] - pubBase[b]), K_PAIR_PUB, 0.35);
    pubVs.set(key(a, b), { g, w, adv }); pubVs.set(key(b, a), { g, w: g - w, adv: -adv });
  }
  for (const [a, b, g, w] of stats.proSyn || []) {
    const adv = pairAdv(g, w, sig(proBase[a] + proBase[b]), K_PAIR_PRO, 0.4);
    proSyn.set(key(a, b), { g, w, adv }); proSyn.set(key(b, a), { g, w, adv });
  }
  for (const [a, b, g, w] of stats.proVs || []) {
    const adv = pairAdv(g, w, sig(proBase[a] - proBase[b]), K_PAIR_PRO, 0.4);
    proVs.set(key(a, b), { g, w, adv }); proVs.set(key(b, a), { g, w: g - w, adv: -adv });
  }
  // Pro evidence outweighs pubs as its sample grows; the blend never exceeds the stronger of the two signals.
  const blend = (pub, pro) => {
    const wp = pub ? 0.6 : 0, wr = pro ? 1.4 * pro.g / (pro.g + 20) : 0;
    return wp + wr ? ((pub?.adv || 0) * wp + (pro?.adv || 0) * wr) / (wp + wr) * 0.85 : 0;
  };
  const syn = (a, b) => blend(pubSyn.get(key(a, b)), proSyn.get(key(a, b)));
  const ctr = (a, b) => blend(pubVs.get(key(a, b)), proVs.get(key(a, b)));
  const pairInfo = (a, b, kind) => {
    const pub = (kind === 'syn' ? pubSyn : pubVs).get(key(a, b));
    const pro = (kind === 'syn' ? proSyn : proVs).get(key(a, b));
    return { v: kind === 'syn' ? syn(a, b) : ctr(a, b), pub, pro };
  };

  // ---------- positions ----------
  const posProb = {};
  for (const id of ids) {
    const h = H.get(id), s = S(id);
    const r = Object.fromEntries(ROLE_KEYS.map((k, i) => [k, h.roleLevels?.[i] || 0]));
    const prior = [
      r.carry * 1.2 + 0.1,
      r.carry * 0.5 + r.nuker * 0.5 + r.escape * 0.3 + 0.1,
      r.durable * 0.6 + r.initiator * 0.6 + r.carry * 0.2 + 0.1,
      r.support * 0.5 + r.disabler * 0.4 + r.initiator * 0.3 + r.nuker * 0.2 + 0.1,
      r.support * 0.9 + r.disabler * 0.3 + 0.1,
    ];
    const ps = sum(prior);
    const total = sum(s.pos);
    posProb[id] = s.pos.map((c, i) => (c + 10 * prior[i] / ps) / (total + 10));
  }

  // Penalty for an unusual role is justified by pro results on that role, not by popularity alone.
  function posDetail(id, pos) {
    const s = S(id);
    const n = s.pos[pos], w = s.posW[pos];
    const p = posProb[id][pos];
    const heroWr = (s.proW + 10 * 0.5) / (s.proG + 20);
    const freqPen = p >= 0.15 ? 0 : p >= 0.07 ? -0.07 : p >= 0.03 ? -0.16 : -0.3;
    let pen = freqPen, wrPos = null;
    if (p >= 0.35) return { prob: p, n, w, wrPos: n ? w / n : null, pen: 0 };
    if (n >= 12) {
      // Редкая роль не может доказать преимущество малой выборкой: десяток удачных игр на
      // непривычной позиции — это удача конкретных матчей, а не свойство героя. Поэтому данные
      // способны только смягчить штраф за редкость, но не поднять оценку выше нуля, и снимают
      // штраф тем сильнее, чем больше игр. Раньше 6–15 игр давали доверие и даже бонус, и
      // экзотический флекс получал плюс на всех стадиях игры.
      wrPos = (w + 10 * heroWr) / (n + 10);
      const data = clamp((logit(wrPos) - logit(heroWr)) * (n / (n + 40)), -0.25, 0);
      const conf = n / (n + 30);
      pen = data + freqPen * (1 - conf);
    }
    return { prob: p, n, w, wrPos, pen: Math.min(pen, 0) };
  }
  const posAdj = (id, pos) => posDetail(id, pos).pen;

  // Позиции обычно угадываются по про-данным, но капитан знает настоящий план: передайте
  // { posRadiant, posDire } — перестановку 0..4 по индексам команды — и разбор будет построен
  // на ней, а не на догадке. Негодная раскладка молча игнорируется.
  const validPos = (p, team) => Array.isArray(p) && p.length === team.length && new Set(p).size === team.length && p.every(v => Number.isInteger(v) && v >= 0 && v < 5);

  function assign(team) {
    const n = team.length;
    if (!n) return { pos: [], score: 0 };
    let best = null, bestScore = -Infinity;
    for (const perm of PERMS[n]) {
      let sc = 0;
      for (let i = 0; i < n; i++) sc += Math.log(posProb[team[i]][perm[i]]);
      if (sc > bestScore) { bestScore = sc; best = perm; }
    }
    return { pos: best, score: bestScore };
  }

  // ---------- lanes ----------
  const laneStr = {}, laneAvg = {};
  for (const id of ids) {
    const s = S(id);
    laneStr[id] = s.lane.map(([n, m]) => (n / (n + K_LANE)) * m);
    const tn = sum(s.lane.map(l => l[0]));
    laneAvg[id] = tn ? sum(s.lane.map(([n, m]) => n * m)) / tn * (tn / (tn + K_LANE)) : 0;
  }
  const laneVsMap = new Map();
  for (const [a, b, n, m] of stats.laneVs) laneVsMap.set(key(a, b), [n, m]);
  // Как пара союзников стоит линию вместе. Одиночные показатели этого не передают: два героя,
  // каждый из которых сам по себе стоит линию средне, вдвоём могут её выигрывать — и наоборот.
  // Данных может не быть (старый файл статистики) — тогда слагаемое просто равно нулю.
  const laneWithMap = new Map();
  for (const [a, b, n, m] of stats.laneWith || []) laneWithMap.set(key(Math.min(a, b), Math.max(a, b)), [n, m]);
  const laneDuo = (a, b) => {
    const lw = laneWithMap.get(key(Math.min(a, b), Math.max(a, b)));
    if (!lw) return { v: 0, n: 0, raw: 0 };
    const [n, m] = lw;
    // Ожидание — сумма одиночных показателей пары; разница с ней и есть парный эффект.
    const expected = laneAvg[a] + laneAvg[b];
    return { v: (n / (n + K_LANE_PAIR)) * (m - expected), n, raw: m };
  };
  const laneResidual = (a, b) => {
    const lv = laneVsMap.get(key(a, b));
    if (!lv) return { v: 0, n: 0 };
    const [n, m] = lv;
    return { v: (n / (n + K_LANE_PAIR)) * (m - (laneAvg[a] - laneAvg[b])), n, raw: m };
  };

  // ---------- game phases ----------
  const phase = {};
  for (const id of ids) {
    const s = S(id);
    const pubP = wr[id] || 0.5;
    const proP = proWr[id] ?? 0.5;
    const pub = (s.dur || []).map(([g, w]) => logit((w + K_PHASE_PUB * pubP) / (g + K_PHASE_PUB)) - logit(pubP));
    const pro = (s.proDur || []).map(([g, w]) => logit((w + K_PHASE_PRO * proP) / (g + K_PHASE_PRO)) - logit(proP));
    phase[id] = PHASE_CENTERS.map((_, i) => (pub[i] || 0) * 0.5 + (pro[i] || 0) * 0.7);
  }
  const phaseAt = (id, minute) => {
    const c = phase[id];
    if (minute <= PHASE_CENTERS[0]) return c[0];
    for (let i = 1; i < PHASE_CENTERS.length; i++) {
      if (minute <= PHASE_CENTERS[i]) {
        const t = (minute - PHASE_CENTERS[i - 1]) / (PHASE_CENTERS[i] - PHASE_CENTERS[i - 1]);
        return c[i - 1] * (1 - t) + c[i] * t;
      }
    }
    return c[c.length - 1];
  };

  // ---------- damage profile & tags ----------
  const profile = {};
  for (const id of ids) {
    const h = H.get(id);
    const r = Object.fromEntries(ROLE_KEYS.map((k, i) => [k, h.roleLevels?.[i] || 0]));
    let phys = r.carry * 1.5 + (h.attr === 1 ? 1 : 0) + 0.5, mag = 0, pure = 0, pierce = 0;
    for (const a of h.abilities) {
      const w = a.ult ? 1.5 : 1;
      if (a.damage === 'Магический') mag += w;
      else if (a.damage === 'Чистый') pure += w;
      else if (a.damage === 'Физический') phys += w * 0.7;
      if (a.pierce === 'Да' && !a.behavior.includes('Пассивная')) pierce++;
    }
    const t = phys + mag + pure || 1;
    profile[id] = { phys: phys / t, mag: mag / t, pure: pure / t, pierce, r };
  }

  function partialRaw(A, B) {
    let v = sum(A.map(a => base[a])) - sum(B.map(b => base[b]));
    for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) v += syn(A[i], A[j]);
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) v -= syn(B[i], B[j]);
    for (const a of A) for (const b of B) v += ctr(a, b);
    const pa = assign(A), pb = assign(B);
    A.forEach((a, i) => { v += posAdj(a, pa.pos[i]); });
    B.forEach((b, i) => { v -= posAdj(b, pb.pos[i]); });
    return v;
  }
  const partial = (A, B) => partialRaw(A, B) * CAL;

  function laneMatch(Aheroes, Bheroes, label) {
    const reasons = [];
    const meanStr = side => sum(side.map(([h, p]) => laneStr[h][p])) / side.length;
    const duo = Aheroes.length > 1 ? 1.4 : 1;
    const strength = (meanStr(Aheroes) - meanStr(Bheroes)) * duo;
    for (const [h, p] of Aheroes) {
      const v = laneStr[h][p];
      if (Math.abs(v) > 150) reasons.push({ side: 'A', text: `${H.get(h).name} на позиции ${p + 1} в про-матчах ${v > 0 ? 'выигрывает' : 'проигрывает'} линию в среднем на ${Math.abs(Math.round(v))} (золото+опыт к 10 мин)`, v });
    }
    for (const [h, p] of Bheroes) {
      const v = laneStr[h][p];
      if (Math.abs(v) > 150) reasons.push({ side: 'B', text: `${H.get(h).name} на позиции ${p + 1} в про-матчах ${v > 0 ? 'выигрывает' : 'проигрывает'} линию в среднем на ${Math.abs(Math.round(v))}`, v: -v });
    }
    // Пара против пары: сначала собственный эффект каждой связки, потом встречи героев.
    let duoTerm = 0;
    for (const [side, sign] of [[Aheroes, 1], [Bheroes, -1]]) {
      if (side.length !== 2) continue;
      const d = laneDuo(side[0][0], side[1][0]);
      if (!d.n) continue;
      duoTerm += sign * d.v * 0.7;
      if (d.n >= 5 && Math.abs(d.v) > 150) {
        const [x, y] = [H.get(side[0][0]).name, H.get(side[1][0]).name];
        reasons.push({
          side: (sign > 0) === (d.v > 0) ? 'A' : 'B',
          text: `${x} и ${y} вместе стоят линию ${d.v > 0 ? 'лучше' : 'хуже'}, чем каждый по отдельности (${d.raw > 0 ? '+' : ''}${Math.round(d.raw)} в ${d.n} про-играх)`,
          v: sign * d.v,
        });
      }
    }

    let pairTerm = 0, ctrTerm = 0, pairs = 0;
    for (const [a] of Aheroes) for (const [b] of Bheroes) {
      const lr = laneResidual(a, b);
      pairTerm += lr.v; pairs++;
      if (lr.n >= 4 && Math.abs(lr.raw) > 300) reasons.push({ side: lr.raw > 0 ? 'A' : 'B', text: `${H.get(a).name} против ${H.get(b).name}: ${lr.raw > 0 ? '+' : ''}${Math.round(lr.raw)} на линии в ${lr.n} про-встречах`, v: lr.v });
      const c = ctr(a, b);
      ctrTerm += c * 2500;
      if (Math.abs(c) > 0.06) {
        const pro = proVs.get(key(a, b));
        const src = pro && pro.g >= 5 ? `${pro.g} про-встреч` : 'Divine+';
        reasons.push({ side: c > 0 ? 'A' : 'B', text: `${c > 0 ? H.get(a).name : H.get(b).name} контрит ${c > 0 ? H.get(b).name : H.get(a).name} (${toPct(Math.abs(c)).toFixed(1)}% к победе, ${src})`, v: c * 2500 });
      }
    }
    pairTerm = pairs ? pairTerm / pairs * 0.8 : 0;

    let heur = 0;
    const rangedA = Aheroes.filter(([h]) => H.get(h).ranged).length;
    const rangedB = Bheroes.filter(([h]) => H.get(h).ranged).length;
    if (Aheroes.length === 1) {
      if (rangedA && !rangedB) { heur += 150; reasons.push({ side: 'A', text: 'Дальнобойный мидер против ближнего боя: проще харасить и добивать', v: 150 }); }
      if (!rangedA && rangedB) { heur -= 150; reasons.push({ side: 'B', text: 'Дальнобойный мидер против ближнего боя: проще харасить и добивать', v: -150 }); }
    } else {
      if (rangedB === 2 && rangedA === 0) { heur -= 200; reasons.push({ side: 'B', text: 'Двое дальнобойных против двух героев ближнего боя: постоянный харас', v: -200 }); }
      if (rangedA === 2 && rangedB === 0) { heur += 200; reasons.push({ side: 'A', text: 'Двое дальнобойных против двух героев ближнего боя: постоянный харас', v: 200 }); }
      const killA = sum(Aheroes.map(([h]) => profile[h].r.disabler + profile[h].r.nuker));
      const killB = sum(Bheroes.map(([h]) => profile[h].r.disabler + profile[h].r.nuker));
      if (killA - killB >= 3) { heur += 120; reasons.push({ side: 'A', text: 'Больше контроля и урона на линии: высокий потенциал убийств', v: 120 }); }
      if (killB - killA >= 3) { heur -= 120; reasons.push({ side: 'B', text: 'Больше контроля и урона на линии: высокий потенциал убийств', v: -120 }); }
    }
    const total = strength + duoTerm + pairTerm + ctrTerm + heur;
    reasons.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    return {
      label, total: Math.round(total), prob: sig(total / 700),
      parts: { strength: Math.round(strength), duo: Math.round(duoTerm), pairs: Math.round(pairTerm), counters: Math.round(ctrTerm), heur: Math.round(heur) },
      reasons: reasons.slice(0, 6),
    };
  }

  function composition(team, pos) {
    const r = Object.fromEntries(ROLE_KEYS.map(k => [k, 0]));
    let phys = 0, mag = 0, pure = 0, pierce = 0, ranged = 0, wsum = 0;
    team.forEach((h, i) => {
      const pr = profile[h];
      for (const k of ROLE_KEYS) r[k] += pr.r[k];
      const w = pos && pos[i] <= 2 ? 1.3 : 0.8;
      phys += pr.phys * w; mag += pr.mag * w; pure += pr.pure * w; wsum += w;
      pierce += pr.pierce;
      if (H.get(h).ranged) ranged++;
    });
    const dmg = { phys: phys / wsum, mag: mag / wsum, pure: pure / wsum };
    const flags = [];
    let adj = 0;
    if (r.disabler < 4) { adj -= 0.06; flags.push({ bad: true, text: 'Мало контроля — сложно ловить и добивать цели' }); }
    else if (r.disabler >= 8) flags.push({ bad: false, text: 'Много контроля — сильные драки и ганги' });
    if (r.initiator < 2) { adj -= 0.05; flags.push({ bad: true, text: 'Нет явного инициатора — трудно начинать драки' }); }
    else if (r.initiator >= 5) flags.push({ bad: false, text: 'Несколько инициаторов — можно навязывать драки' });
    if (r.carry < 3) { adj -= 0.04; flags.push({ bad: true, text: 'Слабый керри-потенциал — поздняя игра под вопросом' }); }
    if (r.durable < 2) { adj -= 0.03; flags.push({ bad: true, text: 'Хрупкий состав — нет героев, способных впитывать урон' }); }
    else if (r.durable >= 6) flags.push({ bad: false, text: 'Очень живучий состав' });
    if (Math.max(dmg.phys, dmg.mag) > 0.75) { adj -= 0.04; flags.push({ bad: true, text: `Почти весь урон ${dmg.phys > dmg.mag ? 'физический' : 'магический'} — соперник легко закроется предметами` }); }
    else flags.push({ bad: false, text: 'Сбалансированный тип урона' });
    if (r.pusher >= 5) flags.push({ bad: false, text: 'Сильный пуш — быстрые вышки и давление на карту' });
    if (r.escape >= 6) flags.push({ bad: false, text: 'Мобильный состав — хорошие ротации и отступления' });
    if (ranged <= 1) flags.push({ bad: true, text: 'Почти все герои ближнего боя — сложно осаждать хай-граунд' });
    return { roles: r, dmg, pierce, ranged, adj, flags };
  }

  const curve = team => CURVE_MINUTES.map(m => sum(team.map(h => phaseAt(h, m))));

  function positionInfo(team, asg) {
    return team.map((h, i) => {
      const pos = asg.pos[i];
      const d = posDetail(h, pos);
      const name = H.get(h).name;
      let text = null;
      if (d.n >= 6 && d.prob < 0.35) {
        text = d.pen >= -0.01
          ? `${name} на позиции ${pos + 1} (${POS_NAMES[pos]}): ${Math.round(d.prob * 100)}% про-игр, но винрейт там ${Math.round(d.wrPos * 100)}% в ${d.n} играх — флекс оправдан, штрафа нет.`
          : `${name} на позиции ${pos + 1} (${POS_NAMES[pos]}): ${Math.round(d.prob * 100)}% про-игр, винрейт ${Math.round(d.wrPos * 100)}% в ${d.n} играх — на этой роли герой играет хуже обычного. Штраф ${toPct(d.pen).toFixed(1)}%.`;
      } else if (d.pen < -0.01) {
        text = `${name} на позиции ${pos + 1} (${POS_NAMES[pos]}): в про-матчах на этой роли ${d.n ? `всего ${d.n} игр` : 'не встречается'} — нет данных, что такой флекс работает. Штраф ${toPct(d.pen).toFixed(1)}%.`;
      }
      return { hero: h, pos, prob: d.prob, n: d.n, wrPos: d.wrPos, pen: d.pen, text };
    });
  }

  function analyze(rad, dire, { posRadiant, posDire } = {}) {
    const ra = validPos(posRadiant, rad) ? { pos: posRadiant, score: 0 } : assign(rad);
    const da = validPos(posDire, dire) ? { pos: posDire, score: 0 } : assign(dire);
    const posOf = (team, asg) => {
      const map = {};
      team.forEach((h, i) => { map[asg.pos[i]] = h; });
      return map;
    };
    const rp = posOf(rad, ra), dp = posOf(dire, da);

    const heroBase = sum(rad.map(h => base[h])) - sum(dire.map(h => base[h]));
    let synR = 0, synD = 0;
    const synPairs = { radiant: [], dire: [] };
    for (const [team, arr, k] of [[rad, 'radiant', 1], [dire, 'dire', -1]]) {
      for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) {
        const info = pairInfo(team[i], team[j], 'syn');
        if (k > 0) synR += info.v; else synD += info.v;
        synPairs[arr].push({ a: team[i], b: team[j], ...info });
      }
    }
    let counters = 0;
    const ctrPairs = [];
    for (const a of rad) for (const b of dire) {
      const info = pairInfo(a, b, 'vs');
      counters += info.v;
      ctrPairs.push({ a, b, ...info });
    }

    const posR = positionInfo(rad, ra), posD = positionInfo(dire, da);
    // Сумму штрафов за непривычные роли ограничиваем: состав, где каждый не на своём месте,
    // играется плохо, но не «предрешённо плохо» — иначе одни только позиции решали бы драфт.
    const posSum = list => clamp(sum(list.map(p => p.pen)), -0.5, 0);
    const positions = posSum(posR) - posSum(posD);

    const lanes = [
      { key: 'bot', name: 'Нижняя линия', radiantRole: 'Лёгкая', direRole: 'Сложная', ...laneMatch([[rp[0], 0], [rp[4], 4]], [[dp[2], 2], [dp[3], 3]], 'bot'), radiant: [rp[0], rp[4]], dire: [dp[2], dp[3]] },
      { key: 'mid', name: 'Центральная линия', radiantRole: 'Центр', direRole: 'Центр', ...laneMatch([[rp[1], 1]], [[dp[1], 1]], 'mid'), radiant: [rp[1]], dire: [dp[1]] },
      { key: 'top', name: 'Верхняя линия', radiantRole: 'Сложная', direRole: 'Лёгкая', ...laneMatch([[rp[2], 2], [rp[3], 3]], [[dp[0], 0], [dp[4], 4]], 'top'), radiant: [rp[2], rp[3]], dire: [dp[0], dp[4]] },
    ];
    const laneLogit = sum(lanes.map(l => l.total)) * LANE_TO_LOGIT;

    const compR = composition(rad, ra.pos), compD = composition(dire, da.pos);
    const cr = curve(rad), cd = curve(dire);
    const components = Object.fromEntries(Object.entries({ heroes: heroBase, synergy: synR - synD, counters, lanes: laneLogit, positions, composition: compR.adj - compD.adj }).map(([k, v]) => [k, v * CAL]));
    const total = sum(Object.values(components));
    const phaseShift = diff => clamp(diff * PHASE_WEIGHT, -0.8, 0.8);
    // Линии тянут раннюю игру и почти не влияют на позднюю; берём уже откалиброванное слагаемое
    // (components.lanes), а не сырое, иначе часть перевеса осталась бы стоять плоско.
    const withoutLanes = total - components.lanes;
    // Кривая размахивает шире итоговой оценки — ранняя игра усилена перевесом линий. Предел
    // нужен, чтобы отдельная минута не обещала 95%: таких гарантий драфт не даёт.
    const at = (i) => sig(clamp(withoutLanes + components.lanes * laneWeightAt(CURVE_MINUTES[i]) + phaseShift(cr[i] - cd[i]), -1.7, 1.7));
    const winCurve = CURVE_MINUTES.map((_, i) => at(i));
    // Карточки стадий считаются по той же кривой, что нарисована рядом: иначе они с ней спорят.
    const avgWin = (i0, i1) => { let s = 0; for (let i = i0; i <= i1; i++) s += winCurve[i]; return s / (i1 - i0 + 1); };
    const phases = { early: avgWin(0, 3), mid: avgWin(4, 6), late: avgWin(7, 10) };

    const heroImpact = side => {
      const team = side === 'radiant' ? rad : dire, enemy = side === 'radiant' ? dire : rad;
      return team.map(h => ({ hero: h, v: base[h] + sum(team.filter(x => x !== h).map(m => syn(h, m))) + sum(enemy.map(e => ctr(h, e))) })).sort((a, b) => b.v - a.v);
    };
    const powerSpikes = side => (side === 'radiant' ? rad : dire).map(h => ({ hero: h, early: (phaseAt(h, 16) + phaseAt(h, 22.5)) / 2, late: (phaseAt(h, 47.5) + phaseAt(h, 55)) / 2 }));

    return {
      prob: sig(total), total, components,
      lanes, positions: { radiant: posR, dire: posD },
      synergy: synPairs, counters: ctrPairs,
      composition: { radiant: compR, dire: compD },
      curve: { minutes: CURVE_MINUTES, radiant: cr, dire: cd, win: winCurve },
      phases,
      impact: { radiant: heroImpact('radiant'), dire: heroImpact('dire') },
      spikes: { radiant: powerSpikes('radiant'), dire: powerSpikes('dire') },
      plan: {
        radiant: teamPlan('radiant', { comp: compR, lanes, phases }),
        dire: teamPlan('dire', { comp: compD, lanes, phases }),
      },
      insights: buildInsights({ lanes, compR, compD, winCurve, ctrPairs, synPairs, phases, total, posR, posD }),
    };
  }

  // Разбор по частям — линии, матчапы, роли — не отвечает на вопрос «а как этим играть».
  // Здесь части сводятся в план на игру: окно силы, за счёт чего побеждать, во что упирается.
  function teamPlan(side, { comp, lanes, phases }) {
    const r = comp.roles;
    const laneEdge = sum(lanes.map(l => l.total)) * (side === 'radiant' ? 1 : -1);
    const winChance = side === 'radiant' ? phases : { early: 1 - phases.early, mid: 1 - phases.mid, late: 1 - phases.late };

    let style;
    if (r.pusher >= 5 && comp.ranged >= 3) style = 'Состав про давление на карту: ломать вышки и забирать пространство, а не копить фарм.';
    else if (r.disabler >= 8 && r.initiator >= 4) style = 'Состав про драки: много контроля и есть кому начинать — выгодно навязывать бои, а не тянуть время.';
    else if (r.carry >= 5 && r.durable <= 3) style = 'Состав про фарм: сила приходит с предметами, лобовые ранние драки — не его.';
    else if (r.escape >= 6) style = 'Состав про подвижность: ротации, ловля по одному и размен карты, а не лобовые драки.';
    else style = 'Состав без выраженного перекоса: играется от ситуации, отдельного плана не навязывает.';

    // Совет по времени даётся по раскладу с этим соперником, а не по собственной кривой: состав
    // может сам по себе усиливаться к поздней игре, но у соперника это происходит быстрее.
    let window;
    if (winChance.late - winChance.early > 0.04) window = 'По раскладу с этим соперником: чем дольше игра, тем лучше — ранние минуты надо пережить.';
    else if (winChance.early - winChance.late > 0.04) window = 'По раскладу с этим соперником: затягивать невыгодно, забирать надо рано.';
    else window = 'По раскладу с этим соперником: ровно по стадиям, выраженного окна нет.';

    const notes = [];
    if (Math.abs(laneEdge) > 900) notes.push(laneEdge > 0
      ? 'Стадия линий за этой командой — перевес надо сразу переводить в вышки и карту.'
      : 'Линии складываются против: нужен план на трудный старт — размены, ротации, вторая линия.');
    const worst = comp.flags.filter(f => f.bad).slice(0, 2).map(f => f.text.replace(/ — .*/, ''));
    if (worst.length) notes.push('Слабые места состава: ' + worst.join('; ') + '.');

    return { style, window, notes };
  }

  function buildInsights({ lanes, compR, compD, winCurve, ctrPairs, synPairs, phases, total, posR, posD }) {
    const out = [];
    const nm = id => H.get(id).name;
    const fav = total >= 0 ? 'radiant' : 'dire';
    let cross = null;
    for (let i = 1; i < winCurve.length; i++) if ((winCurve[i] - 0.5) * (winCurve[i - 1] - 0.5) < 0) { cross = CURVE_MINUTES[i]; break; }
    const earlyTeam = phases.early >= 0.5 ? 'radiant' : 'dire';
    const lateTeam = phases.late >= 0.5 ? 'radiant' : 'dire';
    if (earlyTeam !== lateTeam) {
      out.push({ team: earlyTeam, kind: 'plan', text: `Сильнее в начале игры${cross ? ` (примерно до ${cross}-й минуты)` : ''}: нужно давить, брать вышки и заканчивать до того, как соперник выйдет на пик силы.` });
      out.push({ team: lateTeam, kind: 'plan', text: `Сильнее в поздней игре: избегать невыгодных драк, фармить и тянуть время — после ${cross || 35}-й минуты состав начинает переигрывать.` });
    } else {
      out.push({ team: earlyTeam, kind: 'plan', text: 'Преимущество на всех стадиях игры: можно играть от давления и не давать сопернику фармить.' });
    }
    const bestLane = lanes.reduce((a, b) => (Math.abs(b.total) > Math.abs(a.total) ? b : a));
    if (Math.abs(bestLane.total) > 250) {
      out.push({ team: bestLane.total > 0 ? 'radiant' : 'dire', kind: 'lane', text: `${bestLane.name} — главный перевес стадии линий (${bestLane.total > 0 ? '+' : ''}${bestLane.total}). Стоит помогать этой линии ротациями и рано ставить варды у соперника.` });
    }
    const topCtr = ctrPairs.slice().sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0];
    if (topCtr && Math.abs(topCtr.v) > 0.04) {
      const [w, l] = topCtr.v > 0 ? [topCtr.a, topCtr.b] : [topCtr.b, topCtr.a];
      out.push({ team: topCtr.v > 0 ? 'radiant' : 'dire', kind: 'counter', text: `Самый жёсткий контрпик драфта: ${nm(w)} против ${nm(l)} (+${toPct(Math.abs(topCtr.v)).toFixed(1)}% к победе).` });
    }
    for (const side of ['radiant', 'dire']) {
      const best = synPairs[side].slice().sort((a, b) => b.v - a.v)[0];
      if (best && best.v > 0.04) out.push({ team: side, kind: 'synergy', text: `Лучшая связка: ${nm(best.a)} + ${nm(best.b)} (+${toPct(best.v).toFixed(1)}%).` });
      const flex = (side === 'radiant' ? posR : posD).find(p => p.text && p.pen >= -0.01);
      if (flex) out.push({ team: side, kind: 'flex', text: flex.text });
      const comp = side === 'radiant' ? compR : compD;
      for (const f of comp.flags.filter(f => f.bad).slice(0, 2)) out.push({ team: side, kind: 'warn', text: f.text });
    }
    out.push({ team: fav, kind: 'verdict', text: Math.abs(toPct(total)) < 3 ? 'Драфты примерно равны: исход решит игра, а не пики.' : 'Драфт даёт этой стороне заметное преимущество.' });
    return out;
  }

  function evaluate(rad, dire) {
    if (rad.length === 5 && dire.length === 5) {
      const ra = assign(rad), da = assign(dire);
      let v = partialRaw(rad, dire);
      const rp = {}, dp = {};
      rad.forEach((h, i) => { rp[ra.pos[i]] = h; });
      dire.forEach((h, i) => { dp[da.pos[i]] = h; });
      const lt = laneMatch([[rp[0], 0], [rp[4], 4]], [[dp[2], 2], [dp[3], 3]]).total
        + laneMatch([[rp[1], 1]], [[dp[1], 1]]).total
        + laneMatch([[rp[2], 2], [rp[3], 3]], [[dp[0], 0], [dp[4], 4]]).total;
      v += lt * LANE_TO_LOGIT + composition(rad, ra.pos).adj - composition(dire, da.pos).adj;
      return v * CAL;
    }
    return partial(rad, dire);
  }

  // Насколько героя легко закрыть тем, что ещё не забанено и не взято. Простой матчап отвечает
  // на вопрос «как он играет против того, что уже стоит», а капитану важнее второе: чем ответят.
  // Забаненные контрпики сюда не попадают — потому бан и делает пик безопаснее.
  function counterRisk(hero, pool, enemySlots) {
    if (enemySlots <= 0) return { v: 0, by: null };
    const threats = [];
    for (const e of pool) {
      if (e === hero) continue;
      const c = ctr(e, hero);
      if (c <= 0) continue;
      // Вес — насколько правдоподобно, что соперник вообще возьмёт этого героя: редкий в про
      // контрпик угрожает меньше, чем тот, которого и так пикают в половине игр.
      threats.push({ hero: e, v: (sig(c) - 0.5) * (0.4 + contest[e]) });
    }
    if (!threats.length) return { v: 0, by: null };
    threats.sort((a, b) => b.v - a.v);
    const take = threats.slice(0, Math.min(enemySlots, 3));
    // Вес по остроте: главную угрозу соперник и возьмёт, поэтому бан именно её должен быть заметен
    // в оценке, а не растворяться в среднем по трём.
    const W = [0.6, 0.27, 0.13];
    const wsum = W.slice(0, take.length).reduce((a, b) => a + b, 0);
    return { v: sum(take.map((t, i) => t.v * W[i])) / wsum, by: take[0].hero };
  }

  function explainCandidate(h, mine, enemy) {
    const reasons = [];
    const nm = id => H.get(id).name;
    for (const e of enemy) {
      const c = ctr(h, e);
      if (c > 0.03) reasons.push({ v: c, text: `контрит ${nm(e)} (+${toPct(c).toFixed(1)}%)` });
      if (c < -0.04) reasons.push({ v: c, text: `слаб против ${nm(e)} (${toPct(c).toFixed(1)}%)` });
    }
    for (const m of mine) {
      const s = syn(h, m);
      if (s > 0.03) reasons.push({ v: s, text: `связка с ${nm(m)} (+${toPct(s).toFixed(1)}%)` });
    }
    if (proWr[h] != null && S(h).proG >= 15 && proWr[h] > 0.53) reasons.push({ v: 0.03, text: `${Math.round(proWr[h] * 100)}% побед в про (${S(h).proG} игр)` });
    if (contest[h] > 0.35) reasons.push({ v: 0.02, text: `мета про-сцены (${Math.round(contest[h] * 100)}% пиков/банов)` });
    else if (base[h] > 0.04) reasons.push({ v: base[h] * 0.5, text: `сильный герой патча (${(wr[h] * 100).toFixed(1)}% побед Divine+)` });
    reasons.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    return reasons.slice(0, 3).map(r => r.text);
  }

  function neededPositions(team) {
    if (!team.length) return [0, 1, 2, 3, 4];
    const a = assign(team);
    return [0, 1, 2, 3, 4].filter(p => !a.pos.includes(p));
  }

  // Насколько бот вообще понимает драфт. Раньше уровни отличались только случайностью выбора из
  // одного и того же списка, поэтому «средний» играл почти как «сложный». Теперь отличается сам
  // взгляд: слабый смотрит на силу героя в патче, сильный — на связки, контрпики и ответ соперника.
  const SKILL = { easy: 0.25, normal: 0.7, hard: 1 };

  function suggest(draft, team, type, limit = 6, skill = 1) {
    const enemyTeam = team === 'radiant' ? 'dire' : 'radiant';
    const used = new Set([...draft.picks.radiant, ...draft.picks.dire, ...draft.bans.radiant, ...draft.bans.dire]);
    const mine = draft.picks[team], enemy = draft.picks[enemyTeam];
    const avail = ids.filter(id => !used.has(id) && H.get(id).cm);
    const earlyBanPhase = draft.step < 7;
    const scored = [];
    if (type === 'pick') {
      const now = evaluate(mine, enemy);
      const enemySlots = 5 - enemy.length;
      for (const h of avail) {
        const v = evaluate([...mine, h], enemy) - now;
        // Слабый бот видит только «сильный ли герой сам по себе», сильный — весь расклад.
        const naive = base[h] * CAL;
        const seen = naive + (v - naive) * skill;
        const meta = contest[h] * 0.05 * (mine.length < 3 ? 1 : 0.3);
        const risk = counterRisk(h, avail, enemySlots);
        const reasons = explainCandidate(h, mine, enemy);
        if (risk.by && risk.v > 0.012) reasons.push(`в пуле остался ${H.get(risk.by).name}, который его закрывает`);
        scored.push({ hero: h, score: seen + meta - risk.v * RISK_WEIGHT * skill, gain: v, risk: risk.v, riskBy: risk.by, reasons: reasons.slice(0, 3) });
      }
    } else {
      const now = evaluate(enemy, mine);
      for (const h of avail) {
        const v = evaluate([...enemy, h], mine) - now;
        // Слабый бан идёт по популярности героя, сильный — по тому, чем герой опасен именно здесь.
        const naive = banRate[h] * 0.3 + base[h] * CAL * 0.5;
        const seen = naive + (v - naive) * skill;
        const meta = banRate[h] * (earlyBanPhase ? 0.12 : 0.05) + pickRate[h] * 0.03;
        scored.push({ hero: h, score: seen + meta, gain: v, reasons: explainCandidate(h, enemy, mine).map(r => 'соперникам: ' + r) });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // Возвращает и сам ход, и то, насколько выбор был неочевиден (0 — кандидат вне конкуренции,
  // 1 — несколько равных вариантов). Второе нужно, чтобы бот думал столько же, сколько думал бы
  // человек: над очевидным баном — секунду, над спорным пиком — почти весь ход.
  function botPlan(draft, team, type, difficulty = 'normal') {
    const skill = SKILL[difficulty] ?? SKILL.normal;
    const pool = suggest(draft, team, type, 30, skill);
    if (!pool.length) return { hero: null, closeness: 0 };
    const cfg = { easy: { top: 25, temp: 0.12 }, normal: { top: 8, temp: 0.04 }, hard: { top: 3, temp: 0.012 } }[difficulty] || { top: 8, temp: 0.04 };
    const cand = pool.slice(0, cfg.top);
    const mx = cand[0].score;
    const weights = cand.map(c => Math.exp((c.score - mx) / cfg.temp));
    let r = Math.random() * sum(weights);
    let hero = cand[0].hero;
    for (let i = 0; i < cand.length; i++) { r -= weights[i]; if (r <= 0) { hero = cand[i].hero; break; } }

    // Мера неочевидности — разрыв между первым и вторым кандидатом. Шкала взята из замера по
    // живым драфтам: медиана разрыва около 0.015, четверть ходов ниже 0.008, верхние — за 0.1.
    // Относительная мера (доля от разброса топ-10) здесь не годилась: она почти всегда выходила
    // около 0.8 и ходы между собой не различала.
    const second = pool[1] ? pool[1].score : mx;
    const closeness = Math.exp(-Math.max(0, mx - second) / 0.025);
    return { hero, closeness };
  }

  const botChoice = (draft, team, type, difficulty = 'normal') => botPlan(draft, team, type, difficulty).hero;

  // Alternatives are judged by what was known at the moment of the pick (earlier picks only) and
  // must fit the role the actual hero ended up playing; hindsight against the final draft is shown separately.
  // Раскладку можно задать руками (см. analyze): альтернатива подбирается на ту позицию, которую
  // герой занимает по заявленной раскладке, а не по догадке движка.
  function alternatives(draft, { posRadiant, posDire } = {}) {
    const res = { radiant: [], dire: [] };
    const finalR = draft.picks.radiant, finalD = draft.picks.dire;
    const baseProb = sig(evaluate(finalR, finalD));
    const finalPos = {};
    for (const [team, override] of [[finalR, posRadiant], [finalD, posDire]]) {
      const pos = validPos(override, team) ? override : assign(team).pos;
      team.forEach((h, i) => { finalPos[h] = pos[i]; });
    }
    const allPicked = new Set([...finalR, ...finalD]);
    const usedBefore = new Set();
    const pickedBefore = { radiant: [], dire: [] };
    for (const hEntry of draft.history) {
      if (hEntry.type === 'pick' && hEntry.hero != null) {
        const team = hEntry.team, enemyTeam = team === 'radiant' ? 'dire' : 'radiant';
        const mine = pickedBefore[team], enemy = pickedBefore[enemyTeam];
        const pos = finalPos[hEntry.hero];
        const thenActual = sig(partial([...mine, hEntry.hero], enemy));
        // Пул на момент хода: всё, что тогда не было забанено и не было взято. Герои, взятые
        // соперником позже, сюда входят намеренно — на тот момент он мог взять их в ответ.
        const poolThen = ids.filter(c => H.get(c).cm && !usedBefore.has(c));
        const enemySlots = 5 - enemy.length;
        const riskActual = counterRisk(hEntry.hero, poolThen, enemySlots).v;
        const cands = [];
        for (const c of ids) {
          if (!H.get(c).cm || usedBefore.has(c) || allPicked.has(c)) continue;
          const d = posDetail(c, pos);
          if (d.prob < 0.1 && !(d.n >= 6 && d.wrPos >= 0.48)) continue;
          const then = (sig(partial([...mine, c], enemy)) - thenActual) * 0.6;
          const r = finalR.map(x => (team === 'radiant' && x === hEntry.hero ? c : x));
          const dd = finalD.map(x => (team === 'dire' && x === hEntry.hero ? c : x));
          const full = (team === 'radiant' ? 1 : -1) * (sig(evaluate(r, dd)) - baseProb);
          const risk = counterRisk(c, poolThen, enemySlots);
          cands.push({ hero: c, then, full, risk: risk.v, riskBy: risk.by, safer: riskActual - risk.v, score: then * 0.65 + full * 0.35 - risk.v * RISK_WEIGHT });
        }
        cands.sort((a, b) => b.score - a.score);
        res[team].push({
          step: hEntry.step, hero: hEntry.hero, pos,
          known: { mine: mine.slice(), enemy: enemy.slice() },
          risk: riskActual,
          options: cands.slice(0, 3).map(c => ({
            ...c,
            reasons: [
              ...explainCandidate(c.hero, mine, enemy),
              ...(c.safer > 0.01 ? ['сложнее закрыть ответным пиком'] : c.riskBy && c.risk > 0.012 ? [`закрывается: ${H.get(c.riskBy).name}, он тогда был свободен`] : []),
            ].slice(0, 3),
          })),
        });
        pickedBefore[team].push(hEntry.hero);
      }
      if (hEntry.hero != null) usedBefore.add(hEntry.hero);
    }
    const threats = side => {
      const team = side === 'radiant' ? finalR : finalD;
      const enemy = side === 'radiant' ? finalD : finalR;
      return team.map(h => {
        const mates = team.filter(x => x !== h);
        return { hero: h, v: partial(team, enemy) - partial(mates, enemy), reasons: explainCandidate(h, mates, enemy) };
      }).sort((a, b) => b.v - a.v);
    };
    const leftovers = side => {
      const team = side === 'radiant' ? finalR : finalD;
      const enemy = side === 'radiant' ? finalD : finalR;
      const out = [];
      for (const c of ids) {
        if (!H.get(c).cm || usedBefore.has(c)) continue;
        const v = sum(enemy.map(e => ctr(c, e))) + sum(team.map(m => syn(c, m))) + base[c];
        out.push({ hero: c, v, reasons: explainCandidate(c, team, enemy) });
      }
      return out.sort((a, b) => b.v - a.v).slice(0, 5);
    };
    return {
      picks: res,
      shouldBan: { radiant: threats('dire').slice(0, 3), dire: threats('radiant').slice(0, 3) },
      pool: { radiant: leftovers('radiant'), dire: leftovers('dire') },
    };
  }

  function heroInfo(id) {
    const s = S(id);
    const topSyn = [], topCtr = [];
    for (const o of ids) {
      if (o === id) continue;
      topSyn.push({ hero: o, v: syn(id, o) });
      topCtr.push({ hero: o, v: ctr(id, o) });
    }
    topSyn.sort((a, b) => b.v - a.v);
    topCtr.sort((a, b) => b.v - a.v);
    return {
      wr: wr[id], pubG: s.pubG, proWr: proWr[id], proG: s.proG,
      pickRate: pickRate[id], banRate: banRate[id], contest: contest[id],
      posProb: posProb[id], posN: s.pos, posW: s.posW, lane: laneStr[id], phase: CURVE_MINUTES.map(m => phaseAt(id, m)),
      synergy: topSyn.slice(0, 5), counters: topCtr.slice(0, 5), counteredBy: topCtr.slice(-5).reverse(),
    };
  }

  return {
    ids, H, base, syn, ctr, pairInfo, posProb, posDetail, assign, analyze, evaluate, suggest, botChoice, botPlan, alternatives,
    heroInfo, neededPositions, prob: (r, d) => sig(evaluate(r, d)), meta: stats.meta,
  };
}
