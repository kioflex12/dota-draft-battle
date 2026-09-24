import { esc, heroImg, fmtPct, signCls } from './util.js';
import { toPct, marginRank, POS_NAMES, ROLE_KEYS, ROLE_NAMES } from '../shared/analysis.js';
import { SEQUENCE, TEAM_NAME } from '../shared/draft.js';

// Короткие формы для узкого элемента выбора: «Оффлейнер» в него не помещается.
const POS_SHORT_ROLE = ['Керри', 'Мид', 'Оффлейн', 'Роумер', 'Саппорт'];

const TABS = [
  ['summary', 'Итог'], ['lanes', 'Линии'], ['matchups', 'Матчапы'], ['phases', 'Стадии игры'],
  ['comp', 'Состав'], ['alts', 'Альтернативы'], ['order', 'Ход драфта'],
];

export function renderResult(root, { engine, room, you, onRematch, onMenu, onOpenHero }) {
  const d = room.draft;
  const rad = d.picks.radiant, dire = d.picks.dire;
  const H = id => engine.H.get(id);
  const img = id => heroImg(H(id).key);
  const myTeam = you.team && room.mode !== 'local' ? you.team : null;
  let tab = 'summary';

  // Раскладку линий команды заявили до разбора, обе сразу и вслепую (экран «Расставьте линии»).
  // Здесь она уже только показывается: менять её, увидев ответ, — значит подгонять план под
  // оценку, а не играть по плану.
  const layout = { radiant: room.layout?.radiant || null, dire: room.layout?.dire || null };
  let A, alts, pR, pD, favored, margin, rank, verdict, youLine, scaleNote;
  const recalc = () => {
    A = engine.analyze(rad, dire, { posRadiant: layout.radiant, posDire: layout.dire });
    alts = engine.alternatives(d, { posRadiant: layout.radiant, posDire: layout.dire });
    pR = A.prob * 100;
    pD = 100 - pR;
    favored = A.draftProb >= 0.5 ? 'radiant' : 'dire';
    // Вердикт — о драфте, поэтому перевес стороны из него вычтен: он к составам отношения не
    // имеет. В самом шансе победы он остаётся, там ему и место.
    margin = Math.abs(A.draftProb * 100 - 50);
    // Шанс победы переведён по замеру на реальных матчах, поэтому сами числа небольшие: драфт
    // решает исход куда слабее, чем кажется. Чтобы «перевес 6%» читался, рядом идёт мерка —
    // какая доля живых драфтов слабее этого.
    rank = marginRank(margin);
    verdict = margin < 1.2 ? 'Драфты равные'
      : rank < 0.5 ? `Небольшой перевес: ${TEAM_NAME[favored]}`
        : rank < 0.85 ? `Драфт лучше у: ${TEAM_NAME[favored]}`
          : rank < 0.95 ? `Крупный перевес: ${TEAM_NAME[favored]}`
            : `Разгромный драфт: ${TEAM_NAME[favored]}`;
    scaleNote = margin < 1.2
      ? 'Такой ровный расклад — примерно у четверти драфтов.'
      : `Перевес крупнее, чем у ${Math.round(rank * 100)}% реальных драфтов.`;
    // Сторона может перевесить драфт: шанс выше у одних, а составы лучше у других. Без
    // объяснения это читается как противоречие между полоской и заголовком.
    if ((A.draftProb - 0.5) * (A.prob - 0.5) < 0) {
      scaleNote += ` Шанс победы при этом выше у ${TEAM_NAME[pR > 50 ? 'radiant' : 'dire']}: сторона Света сама по себе выигрывает чаще, и драфт этого не перебивает.`;
    }
    youLine = myTeam ? (favored === myTeam && margin >= 1.2 ? 'Ваш драфт сильнее' : margin < 1.2 ? 'Шансы примерно равны' : 'Драфт соперника сильнее') : '';
  };
  recalc();

  const name = t => room.seats[t]?.name || TEAM_NAME[t];

  const teamBlock = side => {
    const pos = A.positions[side];
    const order = pos.map((p, i) => ({ ...p, idx: i })).sort((a, b) => a.pos - b.pos);
    return `
      <div class="res-team ${side}">
        <div class="th"><b>${TEAM_NAME[side]}</b><span class="muted">${esc(name(side))}</span></div>
        <div class="team-heroes">
          ${order.map(p => `
            <div class="th-hero">
              <img src="${img(p.hero)}" data-open="${p.hero}" alt="">
              <div class="nm" data-open="${p.hero}">${esc(H(p.hero).name)}</div>
              <div class="posn static ${p.pen < 0 ? 'off' : p.pen > 0.01 ? 'flex' : ''}">${p.pos + 1} · ${POS_SHORT_ROLE[p.pos]}</div>
            </div>`).join('')}
        </div>
        <div class="pos-hint muted small">${layout[side] ? 'Раскладку заявила сама команда перед разбором.' : 'Раскладка по про-статистике: команда не успела заявить свою.'}</div>
      </div>`;
  };

  // Строки отсортированы по величине: сверху то, что решило исход, а не то, что раньше в списке.
  const contribution = () => {
    const rows = [
      ['lanes', 'Линии'], ['counters', 'Контрпики'], ['synergy', 'Синергия'],
      ['heroes', 'Сила героев в патче'], ['positions', 'Позиции'], ['composition', 'Состав команды'],
      ['side', 'Сторона Света (не драфт)'],
    ].map(([k, l]) => ({ k, l, v: toPct(A.components[k]) })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    const max = Math.max(4, ...rows.map(r => Math.abs(r.v)));
    const big = rows.filter(r => Math.abs(r.v) >= 1);
    const lead = big.length
      ? `Исход решают прежде всего: ${big.slice(0, 2).map(r => `${r.l.toLowerCase()} (${r.v > 0 ? 'в пользу Сил Света' : 'в пользу Сил Тьмы'})`).join(' и ')}.`
      : 'Ни одна часть драфта не даёт заметного перевеса — составы равные.';
    return `<div class="contrib-lead">${lead}</div>
    <div class="contrib">${rows.map(({ l, v }) => {
      const w = Math.abs(v) / max * 50;
      return `<div class="contrib-row"><span class="lbl">${l}</span><div class="ct"><i style="${v >= 0 ? 'left:50%' : `left:${50 - w}%`};width:${w}%;background:${v >= 0 ? 'var(--radiant)' : 'var(--dire)'}"></i></div><span class="num ${signCls(v)}">${fmtPct(v)}%</span></div>`;
    }).join('')}</div>
    <div class="muted small" style="margin-top:8px">Полоска вправо — в пользу Сил Света, влево — в пользу Сил Тьмы. Число — на сколько процентов эта часть драфта сдвигает шанс победы.
    «Сторона Света» — не про драфт: Свет выигрывает чаще при одинаковых составах, это свойство карты. В вердикте о драфтах это слагаемое не участвует.</div>`;
  };

  const insights = () => `<div class="insights">${A.insights.map(i => `
    <div class="insight ${i.team}"><div><div class="who">${TEAM_NAME[i.team]}</div>${esc(i.text)}</div></div>`).join('')}</div>`;

  // Разбор по частям не отвечает на вопрос «как этим играть» — план сводит части воедино.
  const planBlock = side => {
    const p = A.plan[side];
    return `<div class="plan ${side}">
      <div class="who">${TEAM_NAME[side]}</div>
      <div class="p-style">${esc(p.style)}</div>
      <div class="p-window">${esc(p.window)}</div>
      ${p.notes.length ? `<ul class="p-notes">${p.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    </div>`;
  };

  const summaryTab = () => `
    <div class="panel"><h4>Как это играется</h4>
      <div class="two-col">${planBlock('radiant')}${planBlock('dire')}</div>
    </div>
    <div class="two-col">
      <div class="panel"><h4>Из чего складывается оценка</h4>${contribution()}</div>
      <div class="panel"><h4>Ключевые выводы</h4>${insights()}</div>
    </div>
    <div class="panel"><h4>Линии коротко</h4>${lanesTable()}</div>
    <div class="two-col">
      <div class="panel"><h4>Самый ценный герой</h4>${mvp('radiant')}${mvp('dire')}</div>
      <div class="panel"><h4>Позиции</h4>${positionsNote()}</div>
    </div>
    <div class="muted small">Основа оценки — ${engine.meta.proMatches.toLocaleString('ru')} про-матчей патча 7.41 (сила героев, позиции, линии, про-матчапы); ${engine.meta.pubMatches.toLocaleString('ru')} матчей Divine+ на ${engine.meta.patch} уточняют матчапы и кривые по времени.</div>`;

  const mvp = side => {
    const top = A.impact[side][0], low = A.impact[side][4];
    return `<div class="insight ${side}"><div><div class="who">${TEAM_NAME[side]}</div>
      Лучший пик: <b>${esc(H(top.hero).name)}</b> (${fmtPct(toPct(top.v))}%) · Слабее всего: <b>${esc(H(low.hero).name)}</b> (${fmtPct(toPct(low.v))}%)</div></div>`;
  };

  const positionsNote = () => {
    const notes = [...A.positions.radiant.map(p => ({ ...p, side: 'radiant' })), ...A.positions.dire.map(p => ({ ...p, side: 'dire' }))].filter(p => p.text);
    if (!notes.length) return '<div class="muted">Все герои обеих команд на своих привычных позициях — штрафов нет.</div>';
    return `<div class="insights">${notes.map(p => `<div class="insight ${p.side}"><div>${esc(p.text)}</div></div>`).join('')}</div>
      <div class="muted small" style="margin-top:8px">Штраф за нестандартную позицию назначается только если про-данные не подтверждают такой флекс.</div>`;
  };

  const lanesTable = () => `
    <table class="matrix" style="width:100%;border-spacing:0 4px">
      <tr><th class="muted small" style="text-align:left">ЛИНИЯ</th><th class="muted small">СИЛЫ СВЕТА</th><th></th><th class="muted small">СИЛЫ ТЬМЫ</th><th class="muted small" style="text-align:right">ПЕРЕВЕС</th></tr>
      ${A.lanes.map(l => `<tr>
        <td style="text-align:left;background:none;color:var(--text);font-family:var(--body)">${l.name}</td>
        <td style="background:none"><div class="lane-side" style="justify-content:center">${l.radiant.map(h => `<img src="${img(h)}" style="width:44px;height:25px" alt="">`).join('')}</div></td>
        <td style="background:none;color:var(--dim)">vs</td>
        <td style="background:none"><div class="lane-side" style="justify-content:center">${l.dire.map(h => `<img src="${img(h)}" style="width:44px;height:25px" alt="">`).join('')}</div></td>
        <td style="background:none;text-align:right" class="${signCls(l.total, 120)}">${l.total > 0 ? '+' : ''}${l.total}</td>
      </tr>`).join('')}
    </table>
    <div class="muted small">Перевес — ожидаемая разница золота+опыта к 10-й минуте на героя (плюс — в пользу Сил Света).</div>`;

  const laneVerdict = t => {
    const a = Math.abs(t);
    const who = t > 0 ? 'Силы Света' : 'Силы Тьмы';
    if (a < 150) return 'Ровная линия';
    if (a < 450) return `Небольшой перевес: ${who}`;
    if (a < 900) return `Выигрывают: ${who}`;
    return `Разгром: ${who}`;
  };

  const lanesTab = () => A.lanes.map(l => `
    <div class="lane-card">
      <div class="lane-top">
        <div class="lane-side"><span class="rl">${l.radiantRole}</span>${l.radiant.map(h => `<img src="${img(h)}" data-open="${h}" alt="">`).join('')}</div>
        <div class="lane-mid">
          <div class="ln">${l.name}</div>
          <div class="lv ${signCls(l.total, 120)}">${l.total > 0 ? '+' : ''}${l.total}</div>
          <div class="lw">${laneVerdict(l.total)} · ${Math.round(l.prob * 100)}% / ${Math.round((1 - l.prob) * 100)}%</div>
        </div>
        <div class="lane-side d">${l.dire.map(h => `<img src="${img(h)}" data-open="${h}" alt="">`).join('')}<span class="rl">${l.direRole}</span></div>
      </div>
      <div class="lane-bar"><i style="width:${l.prob * 100}%"></i></div>
      <ul class="lane-reasons">${l.reasons.length ? l.reasons.map(r => `<li class="${r.side}">${esc(r.text)}</li>`).join('') : '<li>Нет ярко выраженных факторов — исход линии решит игра игроков.</li>'}</ul>
      <div class="lane-parts">
        <span>Сила героев на линии: ${l.parts.strength > 0 ? '+' : ''}${l.parts.strength}</span>
        ${l.parts.duo ? `<span>Связка на линии: ${l.parts.duo > 0 ? '+' : ''}${l.parts.duo}</span>` : ''}
        <span>Личные встречи: ${l.parts.pairs > 0 ? '+' : ''}${l.parts.pairs}</span>
        <span>Контрпики: ${l.parts.counters > 0 ? '+' : ''}${l.parts.counters}</span>
        <span>Дальность атаки/контроль: ${l.parts.heur > 0 ? '+' : ''}${l.parts.heur}</span>
      </div>
    </div>`).join('') + `<div class="muted small">Расклад на линиях считается по про-матчам текущего патча, контрпики — по публичным матчам высоких рангов.</div>`;

  const pairSrc = (p, first) => {
    const parts = [];
    if (p.pro?.g) parts.push(`про: ${p.pro.g} игр, ${p.pro.w} побед${first ? ' ' + esc(first) : ''}`);
    if (p.pub?.g) parts.push(`Divine+: ${p.pub.g.toLocaleString('ru')} игр`);
    return parts.join(' · ') || 'нет данных';
  };

  const cellColor = v => {
    const a = Math.min(1, Math.abs(v) / 4);
    if (Math.abs(v) < 0.35) return 'background:#0f131a;color:var(--muted)';
    return v > 0 ? `background:rgba(95,208,122,${0.08 + a * 0.28});color:#b7f5c4` : `background:rgba(239,100,80,${0.08 + a * 0.28});color:#ffc2b8`;
  };

  // Матрица чисел отвечала на вопрос «сколько», но не показывала главного — кто кого и насколько
  // это важно. Поэтому сначала идут сами противостояния портретами со стрелкой, а таблица
  // остаётся вторым видом для тех, кому нужны все пары разом.
  let mxTable = false;

  const duelRow = c => {
    const v = toPct(c.v);
    const radiantWins = v >= 0;
    const [win, lose] = radiantWins ? [c.a, c.b] : [c.b, c.a];
    const mag = Math.min(1, Math.abs(v) / 6);
    return `<div class="duel ${radiantWins ? 'r' : 'd'}" data-tip="<div class='tt-h'>${esc(H(win).name)} против ${esc(H(lose).name)}</div>${esc(H(win).name)} получает ${Math.abs(v).toFixed(1)}% к шансу победы в этой паре<br><span class='muted'>${pairSrc(c, H(c.a).name)}</span>">
      <div class="side win" data-open="${win}"><img class="hero" src="${img(win)}" alt=""><span class="nm">${esc(H(win).name)}</span></div>
      <div class="link">
        <span class="val">${Math.abs(v).toFixed(1)}%</span>
        <span class="bar" style="--w:${(0.2 + mag * 0.8).toFixed(2)}"></span>
      </div>
      <div class="side lose" data-open="${lose}"><img class="hero" src="${img(lose)}" alt=""><span class="nm">${esc(H(lose).name)}</span></div>
    </div>`;
  };

  const bondRow = (s2, side) => {
    const v = toPct(s2.v);
    // Цвет говорит о пользе связки, а не о команде: команда и так понятна по колонке.
    return `<div class="bond ${v < 0 ? 'bad' : 'good'}" data-tip="<div class='tt-h'>${esc(H(s2.a).name)} и ${esc(H(s2.b).name)}</div>${fmtPct(v)}% к шансу победы вместе<br><span class='muted'>${pairSrc(s2)}</span>">
      <div class="side" data-open="${s2.a}"><img class="hero" src="${img(s2.a)}" alt=""><span class="nm">${esc(H(s2.a).name)}</span></div>
      <span class="tie"><b>${fmtPct(v)}%</b></span>
      <div class="side" data-open="${s2.b}"><img class="hero" src="${img(s2.b)}" alt=""><span class="nm">${esc(H(s2.b).name)}</span></div>
    </div>`;
  };

  const counterMatrix = () => {
    const ctrMap = new Map(A.counters.map(c => [c.a + '-' + c.b, c]));
    return `<div class="matrix-wrap"><table class="matrix">
      <tr><th></th>${dire.map(h => `<th><img src="${img(h)}" data-tip="${esc(H(h).name)}" alt=""></th>`).join('')}</tr>
      ${rad.map(a => `<tr><th class="rowh"><img src="${img(a)}" data-tip="${esc(H(a).name)}" alt=""></th>${dire.map(b => {
        const c = ctrMap.get(a + '-' + b);
        const v = toPct(c.v);
        return `<td style="${cellColor(v)}" data-tip="<div class='tt-h'>${esc(H(a).name)} vs ${esc(H(b).name)}</div>${v >= 0 ? esc(H(a).name) : esc(H(b).name)} получает ${Math.abs(v).toFixed(1)}% к шансу победы<br><span class='muted'>${pairSrc(c, H(a).name)}</span>">${fmtPct(v)}</td>`;
      }).join('')}</tr>`).join('')}
    </table></div>
    <div class="matrix-legend">Строки — Силы Света, столбцы — Силы Тьмы. Зелёный — выигрывает герой Сил Света, красный — героя Сил Тьмы.</div>`;
  };

  // Разбор по каждому герою: с кем ему хорошо, с кем плохо и на чём это основано. Матрица
  // показывает всю картину разом, но не отвечает на вопрос «а что с этим героем».
  const heroDigest = (hero, side) => {
    const enemy = side === 'radiant' ? dire : rad;
    const mates = (side === 'radiant' ? rad : dire).filter(x => x !== hero);
    const duels = enemy.map(e => {
      const c = A.counters.find(x => (x.a === hero && x.b === e) || (x.a === e && x.b === hero));
      const v = toPct(c.v) * (c.a === hero ? 1 : -1);
      return { hero: e, v, src: pairSrc(c) };
    }).sort((a, b) => b.v - a.v);
    const bonds = mates.map(m => {
      const b = A.synergy[side].find(x => (x.a === hero && x.b === m) || (x.a === m && x.b === hero));
      return { hero: m, v: toPct(b.v), src: pairSrc(b) };
    }).sort((a, b) => b.v - a.v);
    const chip = (x, positive) => `<span class="chip ${positive ? 'good' : 'bad'}" data-open="${x.hero}" data-tip="${esc(H(x.hero).name)}: ${fmtPct(x.v)}%<br><span class='muted'>${x.src}</span>"><img src="${img(x.hero)}" alt="">${esc(H(x.hero).name)} <b>${fmtPct(x.v)}</b></span>`;
    const best = duels.filter(d => d.v > 0.3).slice(0, 3);
    const worst = duels.filter(d => d.v < -0.3).slice(-3).reverse();
    return `<div class="digest ${side}">
      <div class="dh"><img src="${img(hero)}" data-open="${hero}" alt=""><b>${esc(H(hero).name)}</b></div>
      <div class="drow"><span class="lbl">переигрывает</span><span class="chips">${best.length ? best.map(x => chip(x, true)).join('') : '<span class="muted small">никого заметно</span>'}</span></div>
      <div class="drow"><span class="lbl">уступает</span><span class="chips">${worst.length ? worst.map(x => chip(x, false)).join('') : '<span class="muted small">никому заметно</span>'}</span></div>
      <div class="drow"><span class="lbl">в связке</span><span class="chips">${bonds.length ? chip(bonds[0], bonds[0].v >= 0) + (bonds[bonds.length - 1].v < -0.3 ? chip(bonds[bonds.length - 1], false) : '') : ''}</span></div>
    </div>`;
  };

  const matchupsTab = () => {
    const duels = A.counters.slice().sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    const strong = duels.filter(c => Math.abs(toPct(c.v)) >= 1).slice(0, 10);
    const shown = strong.length ? strong : duels.slice(0, 6);
    const synR = A.synergy.radiant.slice().sort((a, b) => b.v - a.v);
    const synD = A.synergy.dire.slice().sort((a, b) => b.v - a.v);
    const bonds = (list, side) => {
      const best = list.slice(0, 3);
      const worst = list[list.length - 1];
      return best.map(x => bondRow(x, side)).join('') + (worst && toPct(worst.v) < -0.5 && !best.includes(worst) ? bondRow(worst, side) : '');
    };
    return `
      <div class="panel">
        <h4>Матрица контрпиков <button class="mx-toggle" data-mx>${mxTable ? 'к матрице' : 'самые весомые пары'}</button></h4>
        ${mxTable ? `<div class="duels">${shown.map(duelRow).join('')}</div>
        <div class="muted small">Стрелка ведёт от того, кто выигрывает пару, к тому, кого переигрывают; толщина — насколько сильно.</div>` : counterMatrix()}
      </div>
      <div class="panel">
        <h4>Разбор по героям</h4>
        <div class="digests">${rad.map(h => heroDigest(h, 'radiant')).join('')}${dire.map(h => heroDigest(h, 'dire')).join('')}</div>
        <div class="muted small">Для каждого героя — кого он переигрывает и кому уступает из состава соперника, плюс его лучшая и худшая связка. Наведите на плашку, чтобы увидеть, на чём основана оценка.</div>
      </div>
      <div class="panel">
        <h4>Связки внутри команд</h4>
        <div class="two-col">
          <div><div class="sec-title" style="color:var(--radiant-2)">Силы Света</div><div class="bonds">${bonds(synR, 'radiant')}</div></div>
          <div><div class="sec-title" style="color:var(--dire-2)">Силы Тьмы</div><div class="bonds">${bonds(synD, 'dire')}</div></div>
        </div>
        <div class="muted small">Насколько пара героев играет вместе лучше, чем поодиночке. Красная связка — мешают друг другу.</div>
      </div>`;
  };

  // График вероятности победы сделан по образцу того, что рисует Dota Plus: сглаженная кривая,
  // залитые области по обе стороны от середины и чистая ось. Ломаная с точками и частой сеткой
  // читалась как технический график, а не как «чья игра».
  const chart = () => {
    const W = 760, Hh = 300, pl = 92, pr = 18, pt = 26, pb = 34;
    const xs = A.curve.minutes, ys = A.curve.win.map(p => p * 100);
    const span = Math.max(12, ...ys.map(y => Math.abs(y - 50)));
    const minY = 50 - span * 1.15, maxY = 50 + span * 1.15;
    const X = m => pl + (m - xs[0]) / (xs[xs.length - 1] - xs[0]) * (W - pl - pr);
    const Y = v => pt + (maxY - v) / (maxY - minY) * (Hh - pt - pb);
    const pts = ys.map((y, i) => [X(xs[i]), Y(y)]);

    // Сглаживание по Катмуллу-Рому: кривая идёт через все точки, без выбросов между ними.
    const smooth = p => {
      let d = `M${p[0][0].toFixed(1)},${p[0][1].toFixed(1)}`;
      for (let i = 0; i < p.length - 1; i++) {
        const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p[i + 1];
        const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
        const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
        d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
      }
      return d;
    };
    const line = smooth(pts);
    const mid = Y(50);
    const area = `${line} L${X(xs[xs.length - 1]).toFixed(1)},${mid.toFixed(1)} L${X(xs[0]).toFixed(1)},${mid.toFixed(1)} Z`;

    const ticks = [];
    for (let k = -1; k <= 1; k++) {
      const v = 50 + k * Math.round(span * 0.8);
      if (k === 0 || v <= maxY && v >= minY) ticks.push(v);
    }
    const axis = ticks.map(v => `<line x1="${pl}" x2="${W - pr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="${v === 50 ? '#ffffff55' : '#ffffff10'}" stroke-width="${v === 50 ? 1.5 : 1}"/>
      <text x="${pl - 10}" y="${(Y(v) + 4).toFixed(1)}" fill="${v === 50 ? '#8b95a2' : v > 50 ? '#9be15d' : '#ff7a5c'}" font-size="12" text-anchor="end">${v === 50 ? 'поровну' : (v > 50 ? Math.round(v) + '% Света' : Math.round(100 - v) + '% Тьмы')}</text>`).join('');

    // Прозрачные полосы под курсор: подсказка показывает обе стороны на этой минуте.
    const hit = xs.map((m, i) => {
      const w = (W - pl - pr) / (xs.length - 1);
      return `<rect x="${(X(m) - w / 2).toFixed(1)}" y="${pt}" width="${w.toFixed(1)}" height="${(Hh - pt - pb).toFixed(1)}" fill="transparent"
        data-tip="<div class='tt-h'>${m}-я минута</div>Силы Света ${ys[i].toFixed(1)}% · Силы Тьмы ${(100 - ys[i]).toFixed(1)}%"/>`;
    }).join('');

    return `<svg viewBox="0 0 ${W} ${Hh}" class="winchart" role="img" aria-label="Вероятность победы обеих команд по ходу матча">
      <defs>
        <linearGradient id="wcR" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#6fbf3f" stop-opacity=".5"/><stop offset="1" stop-color="#6fbf3f" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="wcD" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stop-color="#d6503a" stop-opacity=".5"/><stop offset="1" stop-color="#d6503a" stop-opacity="0"/>
        </linearGradient>
        <clipPath id="wcAbove"><rect x="0" y="0" width="${W}" height="${mid.toFixed(1)}"/></clipPath>
        <clipPath id="wcBelow"><rect x="0" y="${mid.toFixed(1)}" width="${W}" height="${(Hh - mid).toFixed(1)}"/></clipPath>
      </defs>
      ${axis}
      <path d="${area}" fill="url(#wcR)" clip-path="url(#wcAbove)"/>
      <path d="${area}" fill="url(#wcD)" clip-path="url(#wcBelow)"/>
      <path d="${line}" fill="none" stroke="#eaf1f8" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${pts[pts.length - 1][0].toFixed(1)}" cy="${pts[pts.length - 1][1].toFixed(1)}" r="5" fill="#eaf1f8"/>
      ${xs.filter((_, i) => i % 2 === 0).map((m, i, arr) => `<text x="${X(m).toFixed(1)}" y="${Hh - 12}" fill="#6b7480" font-size="12" text-anchor="middle">${m}${m === arr[arr.length - 1] ? ' мин' : ''}</text>`).join('')}
      <text x="${W - pr}" y="${pt - 9}" font-size="13" text-anchor="end" font-weight="600"><tspan fill="#9be15d">↑ ведут Силы Света</tspan><tspan fill="#5c6572">   ·   </tspan><tspan fill="#ff7a5c">↓ ведут Силы Тьмы</tspan></text>
      ${hit}
    </svg>`;
  };

  const phasesTab = () => {
    const card = (label, range, p) => {
      const r = Math.round(p * 100);
      const lead = r >= 50 ? 'radiant' : 'dire';
      return `<div class="phase-card"><div class="pn">${label}</div>
        <div class="pv"><span class="r ${lead === 'radiant' ? 'lead' : ''}">${r}%</span><span class="sep">:</span><span class="d ${lead === 'dire' ? 'lead' : ''}">${100 - r}%</span></div>
        <div class="pt">${range} · Свет : Тьма</div></div>`;
    };
    const spikes = side => {
      const list = A.spikes[side];
      const max = Math.max(0.1, ...list.flatMap(s => [Math.abs(s.early), Math.abs(s.late)]));
      const bar = v => {
        const w = Math.abs(v) / max * 50;
        return `<div class="spike-bar"><i style="${v >= 0 ? 'left:50%' : `left:${50 - w}%`};width:${w}%;background:${v >= 0 ? 'var(--good)' : 'var(--bad)'}"></i></div>`;
      };
      return `<div class="spikes"><div class="spike-row muted small"><span></span><span>Ранняя игра</span><span>Поздняя игра</span></div>${list.map(s => `<div class="spike-row"><img src="${img(s.hero)}" data-tip="${esc(H(s.hero).name)}: ${fmtPct(toPct(s.early))}% в начале, ${fmtPct(toPct(s.late))}% в конце" alt="">${bar(s.early)}${bar(s.late)}</div>`).join('')}</div>`;
    };
    return `
      <div class="phase-cards">
        ${card('Ранняя игра', '0–25 мин', A.phases.early)}
        ${card('Мидгейм', '25–40 мин', A.phases.mid)}
        ${card('Лейтгейм', '40+ мин', A.phases.late)}
      </div>
      <div class="panel chart"><h4>Чья игра по длительности матча</h4>${chart()}</div>
      <div class="two-col">
        <div class="panel"><h4>Пики силы · Силы Света</h4>${spikes('radiant')}</div>
        <div class="panel"><h4>Пики силы · Силы Тьмы</h4>${spikes('dire')}</div>
      </div>
      <div class="muted small">Выше средней линии игра идёт в пользу Сил Света, ниже — в пользу Сил Тьмы. Кривая показывает, чей состав лучше себя чувствует, если матч затягивается.</div>`;
  };

  const compTab = () => {
    const cr = A.composition.radiant, cd = A.composition.dire;
    const keys = ['carry', 'nuker', 'disabler', 'initiator', 'durable', 'escape', 'pusher', 'support'];
    const max = Math.max(6, ...keys.flatMap(k => [cr.roles[k], cd.roles[k]]));
    const dmg = c => `<div class="dmg-bar"><i style="width:${c.dmg.phys * 100}%;background:#e8a25a">${Math.round(c.dmg.phys * 100)}%</i><i style="width:${c.dmg.mag * 100}%;background:#6aa8ff">${Math.round(c.dmg.mag * 100)}%</i><i style="width:${c.dmg.pure * 100}%;background:#f2e6a0">${c.dmg.pure > 0.08 ? Math.round(c.dmg.pure * 100) + '%' : ''}</i></div>`;
    const flags = c => `<ul class="flags">${c.flags.map(f => `<li class="${f.bad ? 'bad' : 'good'}">${esc(f.text)}</li>`).join('')}</ul>`;
    return `
      <div class="panel">
        <h4><span style="color:var(--radiant-2)">Силы Света</span><span>Чего в команде много, а чего не хватает</span><span style="color:var(--dire-2)">Силы Тьмы</span></h4>
        <div class="muted small" style="margin:-4px 0 10px">Каждому герою Valve проставляет, насколько он подходит под роль — от нуля до трёх. Здесь эти оценки сложены по всей пятёрке: число слева от двоеточия — у Сил Света, справа — у Сил Тьмы.</div>
        <div class="comp-grid">${keys.map(k => `<div class="comp-row"><div class="l"><i style="width:${cr.roles[k] / max * 100}%"></i></div><div class="lbl">${ROLE_NAMES[k]} <span class="muted">${cr.roles[k]}:${cd.roles[k]}</span></div><div class="r"><i style="width:${cd.roles[k] / max * 100}%"></i></div></div>`).join('')}</div>
      </div>
      <div class="two-col">
        <div class="panel"><h4>Силы Света</h4>
          <div class="sec-title">Тип урона</div>${dmg(cr)}
          <div class="dmg-legend"><span style="--c:#e8a25a">Физический</span><span style="--c:#6aa8ff">Магический</span><span style="--c:#f2e6a0">Чистый</span></div>
          <div class="muted small" style="margin:8px 0">Дальний бой: ${cr.ranged}/5 · Способностей сквозь иммунитет к магии: ${cr.pierce}</div>
          ${flags(cr)}
        </div>
        <div class="panel"><h4>Силы Тьмы</h4>
          <div class="sec-title">Тип урона</div>${dmg(cd)}
          <div class="dmg-legend"><span style="--c:#e8a25a">Физический</span><span style="--c:#6aa8ff">Магический</span><span style="--c:#f2e6a0">Чистый</span></div>
          <div class="muted small" style="margin:8px 0">Дальний бой: ${cd.ranged}/5 · Способностей сквозь иммунитет к магии: ${cd.pierce}</div>
          ${flags(cd)}
        </div>
      </div>`;
  };

  const altsTab = () => {
    const altRows = side => alts.picks[side].map(p => {
      const step = SEQUENCE[p.step];
      const knownCount = p.known.mine.length + p.known.enemy.length;
      const known = knownCount
        ? `Известно на тот момент: ${p.known.mine.map(h => esc(H(h).name)).join(', ') || '—'} против ${p.known.enemy.map(h => esc(H(h).name)).join(', ') || '—'}`
        : 'Первый пик драфта — соперник ещё ничего не показал';
      const pct = v => `<span class="${v > 0.002 ? 'pos' : v < -0.002 ? 'neg' : 'muted'}">${fmtPct(v * 100)}%</span>`;
      return `<div class="alt-row">
        <div class="orig"><img src="${img(p.hero)}" data-open="${p.hero}" alt=""><div><b>${esc(H(p.hero).name)}</b><div class="st">Пик #${p.step + 1} · фаза ${step.phase < 2 ? 'I' : step.phase < 4 ? 'II' : 'III'} · позиция ${p.pos + 1}</div><div class="st" data-tip="${known}">${knownCount ? `на столе уже ${knownCount} ${knownCount === 1 ? 'герой' : knownCount < 5 ? 'героя' : 'героев'}` : 'первый пик драфта'}</div></div></div>
        <div class="alt-opts">${p.options.length ? p.options.map(o => `<div class="alt-opt"><img src="${img(o.hero)}" data-open="${o.hero}" alt=""><div><div>${esc(H(o.hero).name)}</div><div class="d">${pct(o.then)} <span class="muted small">тогда</span> · ${pct(o.full)} <span class="muted small">по итогу</span></div></div><div class="why">${esc(o.reasons.join(' · ') || '—')}</div></div>`).join('') : '<div class="muted small">Подходящих героев на эту позицию в пуле не осталось</div>'}</div>
      </div>`;
    }).join('');
    const heroList = (list, fmt) => `<div class="mini-list">${list.map(x => `<span class="mini-hero" data-open="${x.hero}" data-tip="${esc(x.reasons?.join(' · ') || '')}"><img src="${img(x.hero)}" alt="">${esc(H(x.hero).name)} ${fmt(x)}</span>`).join('')}</div>`;
    const order = myTeam ? [myTeam, myTeam === 'radiant' ? 'dire' : 'radiant'] : ['radiant', 'dire'];
    return order.map(side => `
      <div class="panel">
        <h4>${TEAM_NAME[side]} · что можно было взять вместо каждого пика</h4>
        <div class="alt-list">${altRows(side)}</div>
        <div class="two-col" style="margin-top:14px">
          <div><div class="sec-title">Стоило забанить (самые сильные пики соперника)</div>${heroList(alts.shouldBan[side], x => `<b class="pos">${fmtPct(toPct(x.v))}%</b>`)}</div>
          <div><div class="sec-title">Остались в пуле и подошли бы этому драфту</div>${heroList(alts.pool[side], x => `<b class="pos">${fmtPct(toPct(x.v))}%</b>`)}</div>
        </div>
      </div>`).join('') + `<div class="muted small">Альтернатива подбирается на ту же позицию и только из героев, свободных в тот момент. «Тогда» — как пик выглядел по тому, что уже стояло на столе; «по итогу» — как он сказался бы на финальных составах.</div>`;
  };

  const orderTab = () => `
    <div class="panel"><h4>Ход драфта</h4>
      <div class="timeline">${SEQUENCE.map((s, i) => {
        const h = d.history.find(x => x.step === i);
        const team = h?.team;
        return `<div class="tl-step ${s.type} ${team || ''}">${h?.hero != null ? `<img src="${img(h.hero)}" data-open="${h.hero}" data-tip="${esc(H(h.hero).name)}" alt="">` : '<div class="empty">пропуск</div>'}<div class="c"><span>#${i + 1} ${s.type === 'ban' ? 'бан' : 'пик'}</span><span class="${team === 'radiant' ? 'pos' : 'neg'}">${team === 'radiant' ? 'Свет' : 'Тьма'}</span></div></div>`;
      }).join('')}</div>
    </div>`;

  const humans = ['radiant', 'dire'].filter(t => room.seats[t] && !room.seats[t].bot);
  const rematchNote = () => {
    if (room.mode !== 'pvp') return '';
    if (!room.rematch.length) return '';
    const waiting = humans.filter(t => !room.rematch.includes(t));
    return waiting.length ? `<div class="rematch-note">Ждём ответа: ${waiting.map(t => esc(name(t))).join(', ')}</div>` : '';
  };

  const draw = () => {
    root.innerHTML = `
      <div class="res-head">
        <div class="muted small">${room.mode === 'bot' ? 'Против бота — ' : room.mode === 'local' ? 'Игра на одном экране — ' : 'Товарищеский матч — '}рейтинг не изменится</div>
        <h2>${verdict}</h2>
        ${youLine ? `<div class="sub">${youLine}</div>` : ''}
        <div class="muted small">${scaleNote} Проценты — замеренные: движок сверен с матчами, которых не видел.</div>
      </div>
      <div class="prob-bar">
        <div class="pct r"><small>СИЛЫ СВЕТА</small>${pR.toFixed(1)}%</div>
        <div class="prob-track"><i style="width:50%"></i></div>
        <div class="pct d"><small>СИЛЫ ТЬМЫ</small>${pD.toFixed(1)}%</div>
      </div>
      <div class="res-teams">${teamBlock('radiant')}${teamBlock('dire')}</div>
      <div class="tabs">${TABS.map(([k, l]) => `<button data-rtab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="panel-grid" id="res-body">${body()}</div>
      ${rematchNote()}
      <div class="res-actions">
        <button class="btn primary" data-act="rematch" ${room.rematch.includes(you.team) ? 'disabled' : ''}>${room.rematch.includes(you.team) ? 'Ждём соперника…' : 'Ещё раз'}</button>
        <button class="btn" data-act="menu">В меню</button>
      </div>`;
    requestAnimationFrame(() => {
      const bar = root.querySelector('.prob-track i');
      if (bar) bar.style.width = pR + '%';
    });
  };

  const body = () => ({ summary: summaryTab, lanes: lanesTab, matchups: matchupsTab, phases: phasesTab, comp: compTab, alts: altsTab, order: orderTab })[tab]();

  root.onclick = e => {
    const t = e.target.closest('[data-rtab]');
    if (t) {
      tab = t.dataset.rtab;
      root.querySelectorAll('[data-rtab]').forEach(b => b.classList.toggle('on', b === t));
      root.querySelector('#res-body').innerHTML = body();
      return;
    }
    const mx = e.target.closest('[data-mx]');
    if (mx) { mxTable = !mxTable; root.querySelector('#res-body').innerHTML = body(); return; }
    const o = e.target.closest('[data-open]');
    if (o) { onOpenHero(Number(o.dataset.open)); return; }
    const a = e.target.closest('[data-act]');
    if (a?.dataset.act === 'rematch') onRematch();
    if (a?.dataset.act === 'menu') onMenu();
  };
  draw();
  return {
    update(newRoom) {
      room = newRoom;
      // Раскладка приходит вместе с комнатой; пересчитываем только если она и вправду сменилась —
      // полный пересчёт с альтернативами занимает пятую долю секунды.
      const next = { radiant: newRoom.layout?.radiant || null, dire: newRoom.layout?.dire || null };
      if (JSON.stringify(next) !== JSON.stringify(layout)) { Object.assign(layout, next); recalc(); }
      draw();
    },
  };
}
