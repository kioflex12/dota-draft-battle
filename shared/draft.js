export const RESERVE_TIME = 130;

const P = (type, who, time, phase) => ({ type, who, time, phase });

// Captains Mode order since 7.34 (Liquipedia): A = first pick team, B = second.
export const SEQUENCE = [
  P('ban', 'A', 15, 0), P('ban', 'A', 15, 0), P('ban', 'B', 15, 0), P('ban', 'B', 15, 0),
  P('ban', 'A', 15, 0), P('ban', 'B', 15, 0), P('ban', 'B', 15, 0),
  P('pick', 'A', 30, 1), P('pick', 'B', 30, 1),
  P('ban', 'A', 30, 2), P('ban', 'A', 30, 2), P('ban', 'B', 30, 2),
  P('pick', 'B', 30, 3), P('pick', 'A', 30, 3), P('pick', 'A', 30, 3),
  P('pick', 'B', 30, 3), P('pick', 'B', 30, 3), P('pick', 'A', 30, 3),
  P('ban', 'A', 30, 4), P('ban', 'B', 30, 4), P('ban', 'A', 30, 4), P('ban', 'B', 30, 4),
  P('pick', 'A', 30, 5), P('pick', 'B', 30, 5),
];

export const PHASES = ['Баны · I', 'Пики · I', 'Баны · II', 'Пики · II', 'Баны · III', 'Пики · III'];
export const TEAMS = ['radiant', 'dire'];
export const TEAM_NAME = { radiant: 'Силы Света', dire: 'Силы Тьмы' };
export const other = t => (t === 'radiant' ? 'dire' : 'radiant');

export function createDraft({ firstTeam = 'radiant', timers = true, firstBanTime = 15, turnTime = 30, reserve = RESERVE_TIME } = {}) {
  return {
    firstTeam,
    timers,
    times: { firstBan: firstBanTime, turn: turnTime },
    step: 0,
    picks: { radiant: [], dire: [] },
    bans: { radiant: [], dire: [] },
    history: [],
    reserve: { radiant: reserve, dire: reserve },
    turnStartedAt: Date.now(),
    done: false,
  };
}

export function currentTurn(d) {
  if (d.done || d.step >= SEQUENCE.length) return null;
  const s = SEQUENCE[d.step];
  const team = s.who === 'A' ? d.firstTeam : other(d.firstTeam);
  const time = d.times ? (s.phase === 0 ? d.times.firstBan : d.times.turn) : s.time;
  return { ...s, time, team, index: d.step };
}

export function teamOfStep(d, i) {
  return SEQUENCE[i].who === 'A' ? d.firstTeam : other(d.firstTeam);
}

export function usedHeroes(d) {
  return new Set([...d.picks.radiant, ...d.picks.dire, ...d.bans.radiant, ...d.bans.dire]);
}

export function isAvailable(d, heroId) {
  return !usedHeroes(d).has(heroId);
}

// Returns remaining seconds of the turn (positive) or reserve (negative part consumed).
export function clock(d, now = Date.now()) {
  const t = currentTurn(d);
  if (!t || !d.timers) return null;
  const elapsed = (now - d.turnStartedAt) / 1000;
  const main = Math.max(0, t.time - elapsed);
  const reserveUsed = Math.max(0, elapsed - t.time);
  const reserve = Math.max(0, d.reserve[t.team] - reserveUsed);
  return { main, reserve, expired: main <= 0 && reserve <= 0, team: t.team };
}

export function applyAction(d, team, heroId, { auto = false, now = Date.now() } = {}) {
  const t = currentTurn(d);
  if (!t) return { ok: false, error: 'Драфт завершён' };
  if (t.team !== team) return { ok: false, error: 'Сейчас не ваш ход' };
  if (heroId != null && !isAvailable(d, heroId)) return { ok: false, error: 'Герой недоступен' };
  if (heroId == null && t.type === 'pick') return { ok: false, error: 'Нужно выбрать героя' };

  if (d.timers) {
    const elapsed = (now - d.turnStartedAt) / 1000;
    const reserveUsed = Math.max(0, elapsed - t.time);
    d.reserve[team] = Math.max(0, Math.round((d.reserve[team] - reserveUsed) * 10) / 10);
  }
  if (heroId != null) (t.type === 'pick' ? d.picks : d.bans)[team].push(heroId);
  d.history.push({ step: t.index, team, type: t.type, hero: heroId, auto });
  d.step++;
  d.turnStartedAt = now;
  if (d.step >= SEQUENCE.length) d.done = true;
  return { ok: true };
}

export function stepSlots(d) {
  // Per step, which slot (index within that team's picks/bans) the action fills.
  const counters = { radiant: { pick: 0, ban: 0 }, dire: { pick: 0, ban: 0 } };
  return SEQUENCE.map((s, i) => {
    const team = teamOfStep(d, i);
    const slot = counters[team][s.type]++;
    return { ...s, team, slot, index: i };
  });
}
