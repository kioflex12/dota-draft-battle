import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const CACHE = path.join(ROOT, '.cache');

const PATCH = '7.41f';
const PATCH_TS = 1789455600;
const PRO_SINCE = 1774313459;
const PUB_MIN_RANK = 60;
const PUB_CHUNK = 100000;
const N = 160;
const DUR_BINS = [0, 20, 25, 30, 35, 40, 45, 50, 60];

const args = new Set(process.argv.slice(2));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'dota-draft-battle/1.0' } });
      if (res.status === 429) { await sleep(5000 * (i + 1)); continue; }
      const json = await res.json();
      return json;
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(2000 * (i + 1));
    }
  }
  throw new Error('rate limited: ' + url);
}

async function cached(name, fn) {
  const file = path.join(CACHE, name + '.json');
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
  const value = await fn();
  await fs.writeFile(file, JSON.stringify(value));
  return value;
}

async function sql(query) {
  const url = 'https://api.opendota.com/api/explorer?sql=' + encodeURIComponent(query);
  const res = await getJson(url);
  await sleep(1100);
  if (res.err) throw new Error(res.err);
  return res.rows;
}

// ---------- heroes (Valve datafeed, russian) ----------

const BEHAVIOR = [
  [2n, 'Пассивная'], [4n, 'Без цели'], [8n, 'На цель'], [16n, 'На точку'],
  [32n, 'По области'], [128n, 'Поддерживаемая'], [512n, 'Переключаемая'], [4096n, 'Автоприменение'],
];
const DAMAGE = { 1: 'Физический', 2: 'Магический', 4: 'Чистый' };
const IMMUNITY = { 1: 'Да', 2: 'Нет', 3: 'Да', 4: 'Нет' };
const DISPEL = { 1: 'Только сильным развеиванием', 2: 'Да', 3: 'Нет' };

const fmtNum = v => {
  const r = Math.round(v * 100) / 100;
  return String(r);
};

function joinValues(values) {
  if (!values || !values.length) return '';
  if (values.every(v => v === values[0])) return fmtNum(values[0]);
  return values.map(fmtNum).join(' / ');
}

function cleanHtml(s) {
  return (s || '')
    .replace(/<font color='?"?(#[0-9a-fA-F]{6})'?"?>/g, '<span style="color:$1">')
    .replace(/<\/font>/g, '</span>')
    .replace(/<br\s*\/?>/g, '<br>')
    .replace(/\n/g, '<br>')
    .replace(/<(?!\/?(b|br|span|i)\b)[^>]*>/g, '');
}

function renderTemplate(text, ability, mode) {
  if (!text) return '';
  const byName = new Map();
  for (const sv of ability.special_values || []) byName.set(sv.name.toLowerCase(), sv);
  const extra = {
    abilityduration: ability.durations, abilitydamage: ability.damages,
    abilitycooldown: ability.cooldowns, abilitymanacost: ability.mana_costs,
    abilitycastrange: ability.cast_ranges, abilitychanneltime: ability.channel_times,
  };
  const out = text.replace(/%([a-zA-Z0-9_]+)%/g, (m, key) => {
    const sv = byName.get(key.toLowerCase());
    let vals;
    if (sv) {
      if (mode === 'shard' && sv.values_shard?.length) vals = sv.values_shard;
      else if (mode === 'scepter' && sv.values_scepter?.length) vals = sv.values_scepter;
      else vals = sv.values_float;
    } else vals = extra[key.toLowerCase()];
    const str = joinValues(vals);
    if (!str) return '';
    return '<b class="v">' + str + (sv?.is_percentage ? '%' : '') + '</b>';
  }).replace(/%%/g, '%').replace(/%<\/b>%/g, '%</b>').replace(/<\/b>%/g, '%</b>').replace(/%%<\/b>/g, '%</b>');
  return cleanHtml(out);
}

function renderTalent(talent, abilities) {
  const own = new Map((talent.special_values || []).map(sv => [sv.name.toLowerCase(), sv]));
  return cleanHtml((talent.name_loc || '').replace(/\{s:([a-zA-Z0-9_]+)\}/g, (m, key) => {
    const k = key.toLowerCase();
    if (own.has(k)) return joinValues(own.get(k).values_float);
    const stripped = k.replace(/^bonus_/, '');
    let fallback = null;
    for (const a of abilities) {
      for (const sv of a.special_values || []) {
        for (const b of sv.bonuses || []) {
          if (b.name !== talent.name) continue;
          if (sv.name.toLowerCase() === stripped || sv.name.toLowerCase() === k) return fmtNum(Math.abs(b.value));
          fallback ??= Math.abs(b.value);
        }
      }
    }
    return fallback == null ? '?' : fmtNum(fallback);
  }));
}

function decodeBehavior(str) {
  let b;
  try { b = BigInt(str); } catch { return []; }
  return BEHAVIOR.filter(([bit]) => (b & bit) !== 0n).map(([, l]) => l);
}

function convertAbility(a, all) {
  const attribs = [];
  for (const sv of a.special_values || []) {
    if (!sv.heading_loc) continue;
    const v = joinValues(sv.values_float);
    if (!v || v === '0') continue;
    attribs.push({ h: sv.heading_loc.replace(/:$/, ''), v: v + (sv.is_percentage ? '%' : '') });
  }
  const behavior = decodeBehavior(a.behavior);
  const cd = a.cooldowns?.some(x => x) ? joinValues(a.cooldowns) : '';
  const mana = a.mana_costs?.some(x => x) ? joinValues(a.mana_costs) : '';
  const hp = a.health_costs?.some(x => x) ? joinValues(a.health_costs) : '';
  return {
    key: a.name,
    name: a.name_loc,
    desc: renderTemplate(a.desc_loc, a),
    lore: cleanHtml(a.lore_loc),
    notes: (a.notes_loc || []).filter(Boolean).map(n => renderTemplate(n, a)),
    shard: a.ability_has_shard ? renderTemplate(a.shard_loc, a, 'shard') : '',
    scepter: a.ability_has_scepter ? renderTemplate(a.scepter_loc, a, 'scepter') : '',
    ult: a.type === 1,
    innate: !!a.ability_is_innate,
    byShard: !!a.ability_is_granted_by_shard,
    byScepter: !!a.ability_is_granted_by_scepter,
    behavior,
    damage: DAMAGE[a.damage] || '',
    pierce: IMMUNITY[a.immunity] || '',
    dispel: DISPEL[a.dispellable] || '',
    cd, mana, hp,
    attribs,
  };
}

async function buildHeroes() {
  const list = await cached('herolist', () => getJson('https://www.dota2.com/datafeed/herolist?language=russian'));
  const consts = await cached('dc_heroes', () => getJson('https://raw.githubusercontent.com/odota/dotaconstants/master/build/heroes.json'));
  const heroes = [];
  for (const h of list.result.data.heroes) {
    const raw = await cached('hero_' + h.id, async () => {
      const r = await getJson(`https://www.dota2.com/datafeed/herodata?language=russian&hero_id=${h.id}`);
      await sleep(250);
      return r;
    });
    const d = raw.result.data.heroes[0];
    const c = consts[h.id] || {};
    const key = d.name.replace('npc_dota_hero_', '');
    const visible = d.abilities.filter(a => a.name_loc && !a.name.startsWith('generic_hidden'));
    const talents = d.talents.map(t => renderTalent(t, d.abilities));
    heroes.push({
      id: d.id,
      key,
      name: d.name_loc,
      attr: d.primary_attr,
      complexity: d.complexity,
      ranged: d.attack_capability === 2,
      roleLevels: d.role_levels,
      roles: c.roles || [],
      cm: c.cm_enabled !== false,
      hype: cleanHtml(d.hype_loc),
      bio: cleanHtml(d.bio_loc),
      stats: {
        str: d.str_base, strGain: d.str_gain, agi: d.agi_base, agiGain: d.agi_gain,
        int: d.int_base, intGain: d.int_gain, dmgMin: d.damage_min, dmgMax: d.damage_max,
        bat: d.attack_rate, range: d.attack_range, proj: d.projectile_speed, armor: d.armor,
        mr: d.magic_resistance, ms: d.movement_speed, turn: d.turn_rate,
        visionDay: d.sight_range_day, visionNight: d.sight_range_night,
        hp: d.max_health, hpRegen: d.health_regen, mana: d.max_mana, manaRegen: d.mana_regen,
      },
      abilities: visible.map(a => convertAbility(a, d.abilities)),
      talents,
    });
  }
  heroes.sort((a, b) => a.name.localeCompare(b.name));
  return heroes;
}

// ---------- public matches (Divine+, current patch) ----------

async function findMatchIdAt(ts, lo, hi) {
  while (hi - lo > 20000) {
    const mid = Math.floor((lo + hi) / 2);
    const rows = await sql(`SELECT min(start_time) t FROM public_matches WHERE match_id BETWEEN ${mid} AND ${mid + 2000}`);
    const t = Number(rows[0]?.t);
    if (!t || t < ts) lo = mid; else hi = mid;
  }
  return lo;
}

function mat() { return { g: new Int32Array(N * N), w: new Int32Array(N * N) }; }
function durBin(sec) {
  const m = sec / 60;
  let b = 0;
  for (let i = 0; i < DUR_BINS.length; i++) if (m >= DUR_BINS[i]) b = i;
  return b;
}

async function buildPub() {
  const maxRow = await sql('SELECT max(match_id) m FROM public_matches');
  const maxId = Number(maxRow[0].m);
  const startId = await cached('pub_start_' + PATCH_TS, () => findMatchIdAt(PATCH_TS, maxId - 40_000_000, maxId));
  console.log(`pub range ${startId}..${maxId}`);

  const hero = { g: new Int32Array(N), w: new Int32Array(N) };
  const dur = { g: new Int32Array(N * DUR_BINS.length), w: new Int32Array(N * DUR_BINS.length) };
  const syn = mat();
  const vs = mat();
  let matches = 0;


  const chunks = [];
  for (let a = startId; a < maxId; a += PUB_CHUNK) chunks.push([a, Math.min(a + PUB_CHUNK, maxId)]);

  async function fetchChunk(a, b) {
    return cached(`pub_${a}_${b}`, async () => {
      try {
        const rows = await sql(`SELECT radiant_win r, duration d, radiant_team rt, dire_team dt FROM public_matches WHERE match_id >= ${a} AND match_id < ${b} AND lobby_type = 7 AND avg_rank_tier >= ${PUB_MIN_RANK} AND duration >= 720`);
        return rows.map(x => [x.r ? 1 : 0, x.d, x.rt, x.dt]);
      } catch (e) {
        if (b - a <= 12500) { console.warn('skip chunk', a, e.message); return []; }
        const m = Math.floor((a + b) / 2);
        return [...await fetchChunk(a, m), ...await fetchChunk(m, b)];
      }
    });
  }

  let i = 0;
  for (const [a, b] of chunks) {
    const rows = await fetchChunk(a, b);
    for (const [rw, d, rt, dt] of rows) {
      if (!rt || !dt || rt.length !== 5 || dt.length !== 5 || rt.includes(0) || dt.includes(0)) continue;
      matches++;
      const bin = durBin(d);
      for (const [team, won] of [[rt, rw], [dt, 1 - rw]]) {
        for (const h of team) {
          hero.g[h]++; hero.w[h] += won;
          dur.g[h * DUR_BINS.length + bin]++; dur.w[h * DUR_BINS.length + bin] += won;
        }
        for (let x = 0; x < 5; x++) for (let y = x + 1; y < 5; y++) {
          const p = Math.min(team[x], team[y]), q = Math.max(team[x], team[y]);
          syn.g[p * N + q]++; syn.w[p * N + q] += won;
        }
      }
      for (const r of rt) for (const e of dt) {
        const p = Math.min(r, e), q = Math.max(r, e);
        vs.g[p * N + q]++;
        vs.w[p * N + q] += (p === r ? rw : 1 - rw);
      }
    }
    if (++i % 10 === 0) console.log(`pub chunk ${i}/${chunks.length}, matches ${matches}`);
  }
  return { hero, dur, syn, vs, matches };
}

// ---------- pro matches ----------

async function buildPro() {
  const now = Math.floor(Date.now() / 1000);
  const step = 7 * 86400;
  const perMatch = new Map();
  const pb = [];
  for (let a = PRO_SINCE; a < now; a += step) {
    const b = Math.min(a + step, now);
    const fresh = b > now - step;
    const key = fresh ? null : `pro_${a}_${b}`;
    const load = async () => {
      const players = await sql(`SELECT pm.match_id m, m.radiant_win r, m.duration d, pm.hero_id h, pm.player_slot s, pm.lane_role lr, pm.gold_t[11] g, pm.xp_t[11] x, pm.lh_t[11] lh FROM player_matches pm JOIN matches m USING(match_id) WHERE m.start_time >= ${a} AND m.start_time < ${b}`);
      const bans = await sql(`SELECT pb.match_id m, pb.hero_id h, pb.is_pick p, pb.ord o FROM picks_bans pb JOIN matches m USING(match_id) WHERE m.start_time >= ${a} AND m.start_time < ${b}`);
      return { players, bans };
    };
    const { players, bans } = key ? await cached(key, load) : await load();
    for (const p of players) {
      if (!perMatch.has(p.m)) perMatch.set(p.m, []);
      perMatch.get(p.m).push(p);
    }
    pb.push(...bans);
    console.log(`pro week ${new Date(a * 1000).toISOString().slice(0, 10)}: ${players.length / 10 | 0} matches`);
  }

  const hero = Array.from({ length: N }, () => ({
    g: 0, w: 0, pick: 0, ban: 0, earlyBan: 0, firstPhasePick: 0,
    pos: [0, 0, 0, 0, 0], posW: [0, 0, 0, 0, 0],
    lane: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]],
  }));
  const laneVs = new Map();
  // Пара союзников на одной линии: по одиночным показателям героев не видно, как они стоят
  // линию вдвоём — а именно это и решает исход лёгкой и сложной линии.
  const laneWith = new Map();
  const syn = mat(), vs = mat();
  const dur = { g: new Int32Array(N * DUR_BINS.length), w: new Int32Array(N * DUR_BINS.length) };
  let matches = 0;

  const assign = team => {
    const safe = team.filter(p => p.lr === 1).sort((a, b) => (b.lh ?? 0) - (a.lh ?? 0));
    const mid = team.filter(p => p.lr === 2).sort((a, b) => (b.lh ?? 0) - (a.lh ?? 0));
    const off = team.filter(p => p.lr === 3).sort((a, b) => (b.lh ?? 0) - (a.lh ?? 0));
    if (safe.length !== 2 || mid.length !== 1 || off.length !== 2) return null;
    return { 1: safe[0], 2: mid[0], 3: off[0], 4: off[1], 5: safe[1] };
  };

  for (const rows of perMatch.values()) {
    if (rows.length !== 10) continue;
    matches++;
    const rw = rows[0].r ? 1 : 0;
    const rad = rows.filter(p => p.s < 128), dire = rows.filter(p => p.s >= 128);
    const bin = durBin(rows[0].d || 0);
    for (const p of rows) {
      const won = (p.s < 128) === !!rw ? 1 : 0;
      hero[p.h].g++; hero[p.h].w += won;
      dur.g[p.h * DUR_BINS.length + bin]++; dur.w[p.h * DUR_BINS.length + bin] += won;
    }
    for (const [team, won] of [[rad, rw], [dire, 1 - rw]]) {
      for (let x = 0; x < team.length; x++) for (let y = x + 1; y < team.length; y++) {
        const p = Math.min(team[x].h, team[y].h), q = Math.max(team[x].h, team[y].h);
        syn.g[p * N + q]++; syn.w[p * N + q] += won;
      }
    }
    for (const a of rad) for (const b of dire) {
      const p = Math.min(a.h, b.h), q = Math.max(a.h, b.h);
      vs.g[p * N + q]++;
      vs.w[p * N + q] += (p === a.h ? rw : 1 - rw);
    }
    const ra = assign(rad), da = assign(dire);
    for (const [asg, won] of [[ra, rw], [da, 1 - rw]]) {
      if (!asg) continue;
      for (let pos = 1; pos <= 5; pos++) {
        hero[asg[pos].h].pos[pos - 1]++;
        hero[asg[pos].h].posW[pos - 1] += won;
      }
    }
    if (!ra || !da || rows.some(p => p.g == null || p.x == null)) continue;
    const res = p => p.g + p.x;
    const lanes = [
      [[[ra[1], 0], [ra[5], 4]], [[da[3], 2], [da[4], 3]]],
      [[[ra[2], 1]], [[da[2], 1]]],
      [[[ra[3], 2], [ra[4], 3]], [[da[1], 0], [da[5], 4]]],
    ];
    const sum = side => side.reduce((s, [p]) => s + res(p), 0);
    for (const [A, B] of lanes) {
      const diff = (sum(A) - sum(B)) / A.length;
      for (const [side, other, sign] of [[A, B, 1], [B, A, -1]]) {
        if (side.length === 2) {
          const [x, y] = [side[0][0].h, side[1][0].h].sort((m, n) => m - n);
          const kw = x * N + y;
          const curW = laneWith.get(kw) || [0, 0];
          curW[0]++; curW[1] += sign * diff;
          laneWith.set(kw, curW);
        }
        for (const [p, pos] of side) {
          hero[p.h].lane[pos][0]++;
          hero[p.h].lane[pos][1] += sign * diff;
          for (const [e] of other) {
            const k = p.h * N + e.h;
            const cur = laneVs.get(k) || [0, 0];
            cur[0]++; cur[1] += sign * diff;
            laneVs.set(k, cur);
          }
        }
      }
    }
  }

  const pbMatches = new Set();
  for (const b of pb) {
    pbMatches.add(b.m);
    const h = hero[b.h];
    if (!h) continue;
    if (b.p) { h.pick++; if (b.o <= 8) h.firstPhasePick++; }
    else { h.ban++; if (b.o <= 6) h.earlyBan++; }
  }
  return { hero, laneVs, laneWith, syn, vs, dur, matches, draftMatches: pbMatches.size };
}

// ---------- assemble ----------

async function main() {
  await fs.mkdir(DATA, { recursive: true });
  await fs.mkdir(CACHE, { recursive: true });

  console.log('heroes...');
  const heroes = await buildHeroes();
  await fs.writeFile(path.join(DATA, 'heroes.json'), JSON.stringify({ patch: PATCH, heroes }));
  console.log(`heroes: ${heroes.length}`);
  if (args.has('--heroes-only')) return;

  console.log('pro matches...');
  const pro = await buildPro();
  console.log(`pro: ${pro.matches} matches, ${pro.draftMatches} drafts`);

  console.log('public matches...');
  const pub = await buildPub();
  console.log(`pub: ${pub.matches} matches`);

  const ids = heroes.map(h => h.id);
  const heroStats = {};
  for (const id of ids) {
    const p = pro.hero[id];
    heroStats[id] = {
      pubG: pub.hero.g[id], pubW: pub.hero.w[id],
      proG: p.g, proW: p.w, pick: p.pick, ban: p.ban, earlyBan: p.earlyBan, fpp: p.firstPhasePick,
      pos: p.pos, posW: p.posW,
      lane: p.lane.map(([n, s]) => [n, n ? Math.round(s / n) : 0]),
      dur: DUR_BINS.map((_, b) => [pub.dur.g[id * DUR_BINS.length + b], pub.dur.w[id * DUR_BINS.length + b]]),
      proDur: DUR_BINS.map((_, b) => [pro.dur.g[id * DUR_BINS.length + b], pro.dur.w[id * DUR_BINS.length + b]]),
    };
  }
  const syn = [], vs = [], laneVs = [], laneWith = [], proSyn = [], proVs = [];
  for (let x = 0; x < ids.length; x++) for (let y = 0; y < ids.length; y++) {
    const a = ids[x], b = ids[y];
    if (a < b) {
      const k = a * N + b;
      if (pub.syn.g[k]) syn.push([a, b, pub.syn.g[k], pub.syn.w[k]]);
      if (pub.vs.g[k]) vs.push([a, b, pub.vs.g[k], pub.vs.w[k]]);
      if (pro.syn.g[k]) proSyn.push([a, b, pro.syn.g[k], pro.syn.w[k]]);
      if (pro.vs.g[k]) proVs.push([a, b, pro.vs.g[k], pro.vs.w[k]]);
    }
    const lv = pro.laneVs.get(a * N + b);
    if (lv) laneVs.push([a, b, lv[0], Math.round(lv[1] / lv[0])]);
    const lw = pro.laneWith.get(a * N + b);
    if (lw) laneWith.push([a, b, lw[0], Math.round(lw[1] / lw[0])]);
  }
  const stats = {
    meta: {
      patch: PATCH, generatedAt: new Date().toISOString(),
      pubMatches: pub.matches, pubRank: 'Divine+', proMatches: pro.matches, proDrafts: pro.draftMatches,
      proSince: new Date(PRO_SINCE * 1000).toISOString().slice(0, 10),
      durBins: DUR_BINS,
    },
    heroes: heroStats, syn, vs, laneVs, laneWith, proSyn, proVs,
  };
  await fs.writeFile(path.join(DATA, 'stats.json'), JSON.stringify(stats));
  console.log('done');
}

main().catch(e => { console.error(e); process.exit(1); });
