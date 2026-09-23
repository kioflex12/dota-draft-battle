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

const K_BASE = 200;
const K_PAIR = 250;
const K_PHASE = 150;
const K_LANE = 20;
const K_LANE_PAIR = 12;
const LANE_TO_LOGIT = 0.00006;
const PHASE_WEIGHT = 0.45;
const PHASE_CENTERS = [16, 22.5, 27.5, 32.5, 37.5, 42.5, 47.5, 55, 65];
export const CURVE_MINUTES = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];

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

export function createEngine(heroList, stats) {
  const H = new Map(heroList.map(h => [h.id, h]));
  const ids = heroList.map(h => h.id);
  const S = id => stats.heroes[id] || { pubG: 0, pubW: 0, proG: 0, proW: 0, pick: 0, ban: 0, pos: [0, 0, 0, 0, 0], posW: [0, 0, 0, 0, 0], lane: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]], dur: [] };
  const proDrafts = Math.max(1, stats.meta.proDrafts || 1);

  const pubBase = {}, base = {}, wr = {}, proWr = {}, contest = {}, pickRate = {}, banRate = {};
  for (const id of ids) {
    const s = S(id);
    const p = (s.pubW + K_BASE * 0.5) / (s.pubG + K_BASE);
    const pp = (s.proW + 30 * 0.5) / (s.proG + 30);
    wr[id] = s.pubG ? s.pubW / s.pubG : 0.5;
    proWr[id] = s.proG ? s.proW / s.proG : null;
    pubBase[id] = logit(p);
    base[id] = logit(p) * 0.85 + logit(pp) * 0.15;
    pickRate[id] = s.pick / proDrafts;
    banRate[id] = s.ban / proDrafts;
    contest[id] = (s.pick + s.ban) / proDrafts;
  }

  const synMap = new Map(), synN = new Map(), ctrMap = new Map(), ctrN = new Map();
  const key = (a, b) => a * 1000 + b;
  for (const [a, b, g, w] of stats.syn) {
    const p0 = sig(pubBase[a] + pubBase[b]);
    const adv = clamp(logit((w + K_PAIR * p0) / (g + K_PAIR)) - logit(p0), -0.35, 0.35);
    synMap.set(key(a, b), adv); synMap.set(key(b, a), adv);
    synN.set(key(a, b), g); synN.set(key(b, a), g);
  }
  for (const [a, b, g, w] of stats.vs) {
    const p0 = sig(pubBase[a] - pubBase[b]);
    const adv = clamp(logit((w + K_PAIR * p0) / (g + K_PAIR)) - logit(p0), -0.35, 0.35);
    ctrMap.set(key(a, b), adv); ctrMap.set(key(b, a), -adv);
    ctrN.set(key(a, b), g); ctrN.set(key(b, a), g);
  }
  const syn = (a, b) => synMap.get(key(a, b)) || 0;
  const ctr = (a, b) => ctrMap.get(key(a, b)) || 0;

  // positions
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

  const laneStr = {}, laneAvg = {};
  for (const id of ids) {
    const s = S(id);
    laneStr[id] = s.lane.map(([n, m]) => (n / (n + K_LANE)) * m);
    const tn = sum(s.lane.map(l => l[0]));
    laneAvg[id] = tn ? sum(s.lane.map(([n, m]) => n * m)) / tn * (tn / (tn + K_LANE)) : 0;
  }
  const laneVsMap = new Map();
  for (const [a, b, n, m] of stats.laneVs) laneVsMap.set(key(a, b), [n, m]);
  const laneResidual = (a, b) => {
    const lv = laneVsMap.get(key(a, b));
    if (!lv) return { v: 0, n: 0 };
    const [n, m] = lv;
    return { v: (n / (n + K_LANE_PAIR)) * (m - (laneAvg[a] - laneAvg[b])), n, raw: m };
  };

  // phase curves
  const phase = {};
  for (const id of ids) {
    const s = S(id);
    const p = wr[id] || 0.5;
    phase[id] = (s.dur || []).map(([g, w]) => logit((w + K_PHASE * p) / (g + K_PHASE)) - logit(p));
    if (!phase[id].length) phase[id] = PHASE_CENTERS.map(() => 0);
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

  // damage profile & tags
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

  const posPenalty = p => (p >= 0.15 ? 0 : p >= 0.07 ? -0.08 : p >= 0.03 ? -0.22 : -0.45);

  function partial(A, B) {
    let v = sum(A.map(a => base[a])) - sum(B.map(b => base[b]));
    for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) v += syn(A[i], A[j]);
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) v -= syn(B[i], B[j]);
    for (const a of A) for (const b of B) v += ctr(a, b);
    const pa = assign(A), pb = assign(B);
    A.forEach((a, i) => { v += posPenalty(posProb[a][pa.pos[i]]); });
    B.forEach((b, i) => { v -= posPenalty(posProb[b][pb.pos[i]]); });
    return v;
  }

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
    let pairTerm = 0, ctrTerm = 0, pairs = 0;
    for (const [a] of Aheroes) for (const [b] of Bheroes) {
      const lr = laneResidual(a, b);
      pairTerm += lr.v; pairs++;
      if (lr.n >= 4 && Math.abs(lr.raw) > 300) reasons.push({ side: lr.raw > 0 ? 'A' : 'B', text: `${H.get(a).name} против ${H.get(b).name}: ${lr.raw > 0 ? '+' : ''}${Math.round(lr.raw)} на линии в ${lr.n} про-встречах`, v: lr.v });
      const c = ctr(a, b);
      ctrTerm += c * 2500;
      if (Math.abs(c) > 0.06) reasons.push({ side: c > 0 ? 'A' : 'B', text: `${c > 0 ? H.get(a).name : H.get(b).name} контрит ${c > 0 ? H.get(b).name : H.get(a).name} (${toPct(Math.abs(c)).toFixed(1)}% к победе в Divine+)`, v: c * 2500 });
    }
    pairTerm = pairs ? pairTerm / pairs * 0.8 : 0;

    let heur = 0;
    const rangedA = Aheroes.filter(([h]) => H.get(h).ranged).length;
    const rangedB = Bheroes.filter(([h]) => H.get(h).ranged).length;
    if (Aheroes.length === 1) {
      if (rangedA && !rangedB) { heur += 150; reasons.push({ side: 'A', text: `Дальнобойный мидер против ближнего боя: проще харасить и добивать`, v: 150 }); }
      if (!rangedA && rangedB) { heur -= 150; reasons.push({ side: 'B', text: `Дальнобойный мидер против ближнего боя: проще харасить и добивать`, v: -150 }); }
    } else {
      if (rangedB === 2 && rangedA === 0) { heur -= 200; reasons.push({ side: 'B', text: 'Двое дальнобойных против двух героев ближнего боя: постоянный харас', v: -200 }); }
      if (rangedA === 2 && rangedB === 0) { heur += 200; reasons.push({ side: 'A', text: 'Двое дальнобойных против двух героев ближнего боя: постоянный харас', v: 200 }); }
      const disA = sum(Aheroes.map(([h]) => profile[h].r.disabler)), disB = sum(Bheroes.map(([h]) => profile[h].r.disabler));
      const nukeA = sum(Aheroes.map(([h]) => profile[h].r.nuker)), nukeB = sum(Bheroes.map(([h]) => profile[h].r.nuker));
      const killA = disA + nukeA, killB = disB + nukeB;
      if (killA - killB >= 3) { heur += 120; reasons.push({ side: 'A', text: 'Больше контроля и урона на линии: высокий потенциал убийств', v: 120 }); }
      if (killB - killA >= 3) { heur -= 120; reasons.push({ side: 'B', text: 'Больше контроля и урона на линии: высокий потенциал убийств', v: -120 }); }
    }
    const total = strength + pairTerm + ctrTerm + heur;
    reasons.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    return {
      label, total: Math.round(total), prob: sig(total / 700),
      parts: { strength: Math.round(strength), pairs: Math.round(pairTerm), counters: Math.round(ctrTerm), heur: Math.round(heur) },
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

  function curve(team) {
    return CURVE_MINUTES.map(m => sum(team.map(h => phaseAt(h, m))));
  }

  function analyze(rad, dire) {
    const ra = assign(rad), da = assign(dire);
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
        const v = syn(team[i], team[j]);
        if (k > 0) synR += v; else synD += v;
        synPairs[arr].push({ a: team[i], b: team[j], v, n: synN.get(key(team[i], team[j])) || 0 });
      }
    }
    let counters = 0;
    const ctrPairs = [];
    for (const a of rad) for (const b of dire) {
      const v = ctr(a, b);
      counters += v;
      ctrPairs.push({ a, b, v, n: ctrN.get(key(a, b)) || 0 });
    }

    const posInfo = (team, asg) => team.map((h, i) => ({ hero: h, pos: asg.pos[i], prob: posProb[h][asg.pos[i]], pen: posPenalty(posProb[h][asg.pos[i]]) }));
    const posR = posInfo(rad, ra), posD = posInfo(dire, da);
    const positions = sum(posR.map(p => p.pen)) - sum(posD.map(p => p.pen));

    const lanes = [
      { key: 'bot', name: 'Нижняя линия', radiantRole: 'Лёгкая', direRole: 'Сложная', ...laneMatch([[rp[0], 0], [rp[4], 4]], [[dp[2], 2], [dp[3], 3]], 'bot'), radiant: [rp[0], rp[4]], dire: [dp[2], dp[3]] },
      { key: 'mid', name: 'Центральная линия', radiantRole: 'Центр', direRole: 'Центр', ...laneMatch([[rp[1], 1]], [[dp[1], 1]], 'mid'), radiant: [rp[1]], dire: [dp[1]] },
      { key: 'top', name: 'Верхняя линия', radiantRole: 'Сложная', direRole: 'Лёгкая', ...laneMatch([[rp[2], 2], [rp[3], 3]], [[dp[0], 0], [dp[4], 4]], 'top'), radiant: [rp[2], rp[3]], dire: [dp[0], dp[4]] },
    ];
    const laneTotal = sum(lanes.map(l => l.total));
    const laneLogit = laneTotal * LANE_TO_LOGIT;

    const compR = composition(rad, ra.pos), compD = composition(dire, da.pos);
    const comp = compR.adj - compD.adj;

    const cr = curve(rad), cd = curve(dire);
    const components = {
      heroes: heroBase, synergy: synR - synD, counters, lanes: laneLogit, positions, composition: comp,
    };
    const total = sum(Object.values(components));
    const phaseShift = diff => clamp(diff * PHASE_WEIGHT, -0.8, 0.8);
    const winCurve = CURVE_MINUTES.map((m, i) => sig(total + phaseShift(cr[i] - cd[i])));

    const phases = {
      early: sig(total + phaseShift(avgRange(cr, cd, 0, 3))),
      mid: sig(total + phaseShift(avgRange(cr, cd, 4, 6))),
      late: sig(total + phaseShift(avgRange(cr, cd, 7, 10))),
    };

    const heroImpact = side => {
      const team = side === 'radiant' ? rad : dire, enemy = side === 'radiant' ? dire : rad;
      return team.map(h => {
        const mates = team.filter(x => x !== h);
        const v = base[h] + sum(mates.map(m => syn(h, m))) + sum(enemy.map(e => ctr(h, e)));
        return { hero: h, v };
      }).sort((a, b) => b.v - a.v);
    };

    const powerSpikes = side => {
      const team = side === 'radiant' ? rad : dire;
      return team.map(h => {
        const early = (phaseAt(h, 16) + phaseAt(h, 22.5)) / 2;
        const late = (phaseAt(h, 47.5) + phaseAt(h, 55)) / 2;
        return { hero: h, early, late };
      });
    };

    return {
      prob: sig(total), total, components,
      lanes, positions: { radiant: posR, dire: posD },
      synergy: { radiant: synPairs.radiant, dire: synPairs.dire }, counters: ctrPairs,
      composition: { radiant: compR, dire: compD },
      curve: { minutes: CURVE_MINUTES, radiant: cr, dire: cd, win: winCurve },
      phases,
      impact: { radiant: heroImpact('radiant'), dire: heroImpact('dire') },
      spikes: { radiant: powerSpikes('radiant'), dire: powerSpikes('dire') },
      insights: buildInsights({ lanes, compR, compD, winCurve, ctrPairs, synPairs, phases, total }),
    };
  }

  function avgRange(cr, cd, i0, i1) {
    let s = 0;
    for (let i = i0; i <= i1; i++) s += cr[i] - cd[i];
    return s / (i1 - i0 + 1);
  }

  function buildInsights({ lanes, compR, compD, winCurve, ctrPairs, synPairs, phases, total }) {
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
      const comp = side === 'radiant' ? compR : compD;
      for (const f of comp.flags.filter(f => f.bad).slice(0, 2)) out.push({ team: side, kind: 'warn', text: f.text });
    }
    out.push({ team: fav, kind: 'verdict', text: Math.abs(toPct(total)) < 3 ? 'Драфты примерно равны: исход решит игра, а не пики.' : `Драфт даёт этой стороне заметное преимущество.` });
    return out;
  }

  function evaluate(rad, dire) {
    if (rad.length === 5 && dire.length === 5) {
      const ra = assign(rad), da = assign(dire);
      let v = partial(rad, dire);
      const rp = {}, dp = {};
      rad.forEach((h, i) => { rp[ra.pos[i]] = h; });
      dire.forEach((h, i) => { dp[da.pos[i]] = h; });
      const lt = laneMatch([[rp[0], 0], [rp[4], 4]], [[dp[2], 2], [dp[3], 3]]).total
        + laneMatch([[rp[1], 1]], [[dp[1], 1]]).total
        + laneMatch([[rp[2], 2], [rp[3], 3]], [[dp[0], 0], [dp[4], 4]]).total;
      v += lt * LANE_TO_LOGIT + composition(rad, ra.pos).adj - composition(dire, da.pos).adj;
      return v;
    }
    return partial(rad, dire);
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
    if (base[h] > 0.04) reasons.push({ v: base[h] * 0.5, text: `сильный герой патча (${(wr[h] * 100).toFixed(1)}% побед)` });
    if (contest[h] > 0.35) reasons.push({ v: 0.01, text: `мета про-сцены (${Math.round(contest[h] * 100)}% пиков/банов)` });
    reasons.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    return reasons.slice(0, 3).map(r => r.text);
  }

  function neededPositions(team) {
    if (!team.length) return [0, 1, 2, 3, 4];
    const a = assign(team);
    return [0, 1, 2, 3, 4].filter(p => !a.pos.includes(p));
  }

  function suggest(draft, team, type, limit = 6) {
    const enemyTeam = team === 'radiant' ? 'dire' : 'radiant';
    const used = new Set([...draft.picks.radiant, ...draft.picks.dire, ...draft.bans.radiant, ...draft.bans.dire]);
    const mine = draft.picks[team], enemy = draft.picks[enemyTeam];
    const avail = ids.filter(id => !used.has(id) && H.get(id).cm);
    const earlyBanPhase = draft.step < 7;
    const scored = [];
    if (type === 'pick') {
      const now = evaluate(mine, enemy);
      for (const h of avail) {
        const v = evaluate([...mine, h], enemy) - now;
        const meta = contest[h] * 0.05 * (mine.length < 3 ? 1 : 0.3);
        scored.push({ hero: h, score: v + meta, gain: v, reasons: explainCandidate(h, mine, enemy) });
      }
    } else {
      const now = evaluate(enemy, mine);
      for (const h of avail) {
        const v = evaluate([...enemy, h], mine) - now;
        const meta = banRate[h] * (earlyBanPhase ? 0.12 : 0.05) + pickRate[h] * 0.03;
        scored.push({ hero: h, score: v + meta, gain: v, reasons: explainCandidate(h, enemy, mine).map(r => 'соперникам: ' + r) });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  function botChoice(draft, team, type, difficulty = 'normal') {
    const pool = suggest(draft, team, type, 30);
    if (!pool.length) return null;
    const cfg = { easy: { top: 25, temp: 0.12 }, normal: { top: 8, temp: 0.04 }, hard: { top: 3, temp: 0.012 } }[difficulty] || { top: 8, temp: 0.04 };
    const cand = pool.slice(0, cfg.top);
    const mx = cand[0].score;
    const weights = cand.map(c => Math.exp((c.score - mx) / cfg.temp));
    let r = Math.random() * sum(weights);
    for (let i = 0; i < cand.length; i++) { r -= weights[i]; if (r <= 0) return cand[i].hero; }
    return cand[0].hero;
  }

  function alternatives(draft) {
    const res = { radiant: [], dire: [] };
    const finalR = draft.picks.radiant, finalD = draft.picks.dire;
    const baseProb = sig(evaluate(finalR, finalD));
    const allPicked = new Set([...finalR, ...finalD]);
    const usedBefore = new Set();
    for (const hEntry of draft.history) {
      if (hEntry.type === 'pick' && hEntry.hero != null) {
        const team = hEntry.team;
        const cands = [];
        for (const c of ids) {
          if (!H.get(c).cm || usedBefore.has(c) || allPicked.has(c)) continue;
          const r = finalR.map(x => (team === 'radiant' && x === hEntry.hero ? c : x));
          const d = finalD.map(x => (team === 'dire' && x === hEntry.hero ? c : x));
          const p = sig(evaluate(r, d));
          const delta = team === 'radiant' ? p - baseProb : baseProb - p;
          cands.push({ hero: c, delta });
        }
        cands.sort((a, b) => b.delta - a.delta);
        const mine = (team === 'radiant' ? finalR : finalD).filter(x => x !== hEntry.hero);
        const enemy = team === 'radiant' ? finalD : finalR;
        res[team].push({
          step: hEntry.step, hero: hEntry.hero,
          options: cands.slice(0, 3).map(c => ({ ...c, reasons: explainCandidate(c.hero, mine, enemy) })),
        });
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
    const topSyn = [], topCtr = [], weakVs = [];
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
      posProb: posProb[id], lane: laneStr[id], phase: CURVE_MINUTES.map(m => phaseAt(id, m)),
      synergy: topSyn.slice(0, 5), counters: topCtr.slice(0, 5), counteredBy: topCtr.slice(-5).reverse(),
    };
  }

  return {
    ids, H, base, syn, ctr, posProb, assign, analyze, evaluate, suggest, botChoice, alternatives,
    heroInfo, neededPositions, prob: (r, d) => sig(evaluate(r, d)), meta: stats.meta,
  };
}
