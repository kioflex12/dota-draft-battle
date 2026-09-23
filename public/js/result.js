import { esc, heroImg, fmtPct, signCls } from './util.js';
import { toPct, POS_NAMES, ROLE_KEYS, ROLE_NAMES } from '../shared/analysis.js';
import { SEQUENCE, TEAM_NAME } from '../shared/draft.js';

const TABS = [
  ['summary', 'Итог'], ['lanes', 'Линии'], ['matchups', 'Матчапы'], ['phases', 'Стадии игры'],
  ['comp', 'Состав'], ['alts', 'Альтернативы'], ['order', 'Ход драфта'],
];

export function renderResult(root, { engine, room, you, onRematch, onMenu, onOpenHero }) {
  const d = room.draft;
  const rad = d.picks.radiant, dire = d.picks.dire;
  const A = engine.analyze(rad, dire);
  const alts = engine.alternatives(d);
  const H = id => engine.H.get(id);
  const img = id => heroImg(H(id).key);
  const myTeam = you.team && room.mode !== 'local' ? you.team : null;
  const pR = A.prob * 100, pD = 100 - pR;
  let tab = 'summary';
  let synSide = myTeam || 'radiant';

  const name = t => room.seats[t]?.name || TEAM_NAME[t];
  const favored = pR >= 50 ? 'radiant' : 'dire';
  const margin = Math.abs(pR - 50);
  const verdict = margin < 2.5 ? 'Равные драфты' : margin < 6 ? `Небольшой перевес: ${TEAM_NAME[favored]}` : margin < 12 ? `Драфт лучше у: ${TEAM_NAME[favored]}` : `Разгромный драфт: ${TEAM_NAME[favored]}`;
  const youLine = myTeam ? (favored === myTeam && margin >= 2.5 ? 'Ваш драфт сильнее' : margin < 2.5 ? 'Шансы примерно равны' : 'Драфт соперника сильнее') : '';

  const teamBlock = side => {
    const pos = A.positions[side];
    return `
      <div class="res-team ${side}">
        <div class="th"><b>${TEAM_NAME[side]}</b><span class="muted">${esc(name(side))}</span></div>
        <div class="team-heroes">
          ${pos.slice().sort((a, b) => a.pos - b.pos).map(p => `
            <div class="th-hero" data-open="${p.hero}" data-tip="<div class='tt-h'>${esc(H(p.hero).name)}</div>Позиция ${p.pos + 1} (${POS_NAMES[p.pos]}) — ${Math.round(p.prob * 100)}% игр героя на этой роли">
              <img src="${img(p.hero)}" alt="">
              <span class="posn ${p.pen < 0 ? 'off' : ''}">${p.pos + 1}</span>
              <div class="nm">${esc(H(p.hero).name)}</div>
            </div>`).join('')}
        </div>
      </div>`;
  };

  const contribution = () => {
    const rows = [
      ['lanes', 'Линии'], ['counters', 'Контрпики'], ['synergy', 'Синергия'],
      ['heroes', 'Сила героев в патче'], ['positions', 'Позиции'], ['composition', 'Состав команды'],
    ];
    const vals = rows.map(([k]) => toPct(A.components[k]));
    const max = Math.max(4, ...vals.map(Math.abs));
    return `<div class="contrib">${rows.map(([k, l], i) => {
      const v = vals[i];
      const w = Math.abs(v) / max * 50;
      return `<div class="contrib-row"><span class="lbl">${l}</span><div class="ct"><i style="${v >= 0 ? 'left:50%' : `left:${50 - w}%`};width:${w}%;background:${v >= 0 ? 'var(--radiant)' : 'var(--dire)'}"></i></div><span class="num ${signCls(v)}">${fmtPct(v)}%</span></div>`;
    }).join('')}</div>
    <div class="muted small" style="margin-top:8px">Плюс — в пользу Сил Света, минус — в пользу Сил Тьмы. Проценты — вклад в шанс победы.</div>`;
  };

  const insights = () => `<div class="insights">${A.insights.map(i => `
    <div class="insight ${i.team}"><div><div class="who">${TEAM_NAME[i.team]}</div>${esc(i.text)}</div></div>`).join('')}</div>`;

  const summaryTab = () => `
    <div class="two-col">
      <div class="panel"><h4>Из чего складывается оценка</h4>${contribution()}</div>
      <div class="panel"><h4>Ключевые выводы</h4>${insights()}</div>
    </div>
    <div class="panel"><h4>Линии коротко</h4>${lanesTable()}</div>
    <div class="two-col">
      <div class="panel"><h4>Самый ценный герой</h4>${mvp('radiant')}${mvp('dire')}</div>
      <div class="panel"><h4>Позиции</h4>${positionsNote()}</div>
    </div>`;

  const mvp = side => {
    const top = A.impact[side][0], low = A.impact[side][4];
    return `<div class="insight ${side}"><div><div class="who">${TEAM_NAME[side]}</div>
      Лучший пик: <b>${esc(H(top.hero).name)}</b> (${fmtPct(toPct(top.v))}%) · Слабее всего: <b>${esc(H(low.hero).name)}</b> (${fmtPct(toPct(low.v))}%)</div></div>`;
  };

  const positionsNote = () => {
    const off = [...A.positions.radiant.map(p => ({ ...p, side: 'radiant' })), ...A.positions.dire.map(p => ({ ...p, side: 'dire' }))].filter(p => p.pen < 0);
    if (!off.length) return '<div class="muted">Все герои обеих команд встают на свои привычные позиции — штрафов нет.</div>';
    return `<div class="insights">${off.map(p => `<div class="insight ${p.side}"><div>${esc(H(p.hero).name)} на позиции ${p.pos + 1} (${POS_NAMES[p.pos]}) — редкая роль, только ${Math.round(p.prob * 100)}% игр. Штраф ${fmtPct(toPct(p.pen))}%.</div></div>`).join('')}</div>`;
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
        <span>Личные встречи: ${l.parts.pairs > 0 ? '+' : ''}${l.parts.pairs}</span>
        <span>Контрпики: ${l.parts.counters > 0 ? '+' : ''}${l.parts.counters}</span>
        <span>Дальность атаки/контроль: ${l.parts.heur > 0 ? '+' : ''}${l.parts.heur}</span>
      </div>
    </div>`).join('') + `<div class="muted small">Сила героев на линии и личные встречи — по ${engine.meta.proMatches.toLocaleString('ru')} про-матчам с ${engine.meta.proSince}; контрпики — по ${engine.meta.pubMatches.toLocaleString('ru')} публичным матчам Divine+ патча ${engine.meta.patch}.</div>`;

  const cellColor = v => {
    const a = Math.min(1, Math.abs(v) / 4);
    if (Math.abs(v) < 0.35) return 'background:#0f131a;color:var(--muted)';
    return v > 0 ? `background:rgba(95,208,122,${0.08 + a * 0.28});color:#b7f5c4` : `background:rgba(239,100,80,${0.08 + a * 0.28});color:#ffc2b8`;
  };

  const matchupsTab = () => {
    const ctrMap = new Map(A.counters.map(c => [c.a + '-' + c.b, c]));
    const synList = A.synergy[synSide];
    const team = synSide === 'radiant' ? rad : dire;
    const synMap = new Map(synList.flatMap(s => [[s.a + '-' + s.b, s], [s.b + '-' + s.a, s]]));
    return `
      <div class="panel">
        <h4>Матрица контрпиков <span class="muted small" style="letter-spacing:0">строки — Силы Света, столбцы — Силы Тьмы</span></h4>
        <div class="matrix-wrap"><table class="matrix">
          <tr><th></th>${dire.map(h => `<th><img src="${img(h)}" data-tip="${esc(H(h).name)}" alt=""></th>`).join('')}</tr>
          ${rad.map(a => `<tr><th class="rowh"><img src="${img(a)}" data-tip="${esc(H(a).name)}" alt=""></th>${dire.map(b => {
            const c = ctrMap.get(a + '-' + b);
            const v = toPct(c.v);
            return `<td style="${cellColor(v)}" data-tip="<div class='tt-h'>${esc(H(a).name)} vs ${esc(H(b).name)}</div>${v >= 0 ? esc(H(a).name) : esc(H(b).name)} получает ${Math.abs(v).toFixed(1)}% к шансу победы в этой паре<br><span class='muted'>${c.n.toLocaleString('ru')} игр друг против друга (Divine+)</span>">${fmtPct(v)}</td>`;
          }).join('')}</tr>`).join('')}
        </table></div>
        <div class="matrix-legend">Зелёный — герой Сил Света переигрывает героя Сил Тьмы, красный — наоборот.</div>
      </div>
      <div class="panel">
        <h4>Матрица синергий <span class="seg" id="syn-seg"><button data-syn="radiant" class="${synSide === 'radiant' ? 'on' : ''}">Силы Света</button><button data-syn="dire" class="${synSide === 'dire' ? 'on' : ''}">Силы Тьмы</button></span></h4>
        <div class="matrix-wrap"><table class="matrix">
          <tr><th></th>${team.map(h => `<th><img src="${img(h)}" data-tip="${esc(H(h).name)}" alt=""></th>`).join('')}</tr>
          ${team.map(a => `<tr><th class="rowh"><img src="${img(a)}" data-tip="${esc(H(a).name)}" alt=""></th>${team.map(b => {
            if (a === b) return '<td class="self"></td>';
            const s = synMap.get(a + '-' + b);
            const v = toPct(s.v);
            return `<td style="${cellColor(v)}" data-tip="<div class='tt-h'>${esc(H(a).name)} + ${esc(H(b).name)}</div>${fmtPct(v)}% к шансу победы вместе<br><span class='muted'>${s.n.toLocaleString('ru')} совместных игр (Divine+)</span>">${fmtPct(v)}</td>`;
          }).join('')}</tr>`).join('')}
        </table></div>
      </div>`;
  };

  const chart = () => {
    const W = 760, Hh = 260, pl = 44, pr = 16, pt = 16, pb = 30;
    const xs = A.curve.minutes, ys = A.curve.win.map(p => p * 100);
    const minY = Math.min(35, ...ys.map(y => Math.floor(y / 5) * 5)), maxY = Math.max(65, ...ys.map(y => Math.ceil(y / 5) * 5));
    const X = m => pl + (m - xs[0]) / (xs[xs.length - 1] - xs[0]) * (W - pl - pr);
    const Y = v => pt + (maxY - v) / (maxY - minY) * (Hh - pt - pb);
    const path = ys.map((y, i) => `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(y).toFixed(1)}`).join('');
    const area = (above) => {
      const pts = ys.map((y, i) => `${X(xs[i]).toFixed(1)},${Y(above ? Math.max(y, 50) : Math.min(y, 50)).toFixed(1)}`);
      return `M${X(xs[0])},${Y(50)} L${pts.join(' L')} L${X(xs[xs.length - 1])},${Y(50)} Z`;
    };
    const grid = [];
    for (let v = minY; v <= maxY; v += 5) grid.push(`<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 50 ? '#fff6' : '#ffffff12'}" ${v === 50 ? 'stroke-dasharray="4 4"' : ''}/><text x="${pl - 8}" y="${Y(v) + 4}" fill="#8b95a2" font-size="11" text-anchor="end">${v}%</text>`);
    return `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Шанс победы Сил Света по минутам">
      ${grid.join('')}
      ${xs.map(m => `<text x="${X(m)}" y="${Hh - 10}" fill="#8b95a2" font-size="11" text-anchor="middle">${m}'</text>`).join('')}
      <path d="${area(true)}" fill="rgba(111,191,63,.18)"/>
      <path d="${area(false)}" fill="rgba(214,80,58,.18)"/>
      <path d="${path}" fill="none" stroke="#e3b45c" stroke-width="2.5"/>
      ${ys.map((y, i) => `<circle cx="${X(xs[i])}" cy="${Y(y)}" r="3.5" fill="#e3b45c"><title>${xs[i]} мин: ${y.toFixed(1)}% Силы Света</title></circle>`).join('')}
      <text x="${W - pr}" y="${pt + 10}" fill="#9be15d" font-size="12" text-anchor="end">↑ Силы Света</text>
      <text x="${W - pr}" y="${Hh - pb - 6}" fill="#ff7a5c" font-size="12" text-anchor="end">↓ Силы Тьмы</text>
    </svg>`;
  };

  const phasesTab = () => {
    const card = (label, range, p) => {
      const r = p * 100;
      const side = r >= 50 ? 'radiant' : 'dire';
      return `<div class="phase-card"><div class="pn">${label}</div><div class="pv" style="color:${side === 'radiant' ? 'var(--radiant-2)' : 'var(--dire-2)'}">${Math.round(Math.max(r, 100 - r))}%</div><div class="pt">${range} · ${TEAM_NAME[side]}</div></div>`;
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
      <div class="panel chart"><h4>Шанс победы Сил Света в зависимости от длительности игры</h4>${chart()}</div>
      <div class="two-col">
        <div class="panel"><h4>Пики силы · Силы Света</h4>${spikes('radiant')}</div>
        <div class="panel"><h4>Пики силы · Силы Тьмы</h4>${spikes('dire')}</div>
      </div>
      <div class="muted small">Кривая строится по винрейту героев в зависимости от длительности матча (Divine+, патч ${engine.meta.patch}).</div>`;
  };

  const compTab = () => {
    const cr = A.composition.radiant, cd = A.composition.dire;
    const keys = ['carry', 'nuker', 'disabler', 'initiator', 'durable', 'escape', 'pusher', 'support'];
    const max = Math.max(6, ...keys.flatMap(k => [cr.roles[k], cd.roles[k]]));
    const dmg = c => `<div class="dmg-bar"><i style="width:${c.dmg.phys * 100}%;background:#e8a25a">${Math.round(c.dmg.phys * 100)}%</i><i style="width:${c.dmg.mag * 100}%;background:#6aa8ff">${Math.round(c.dmg.mag * 100)}%</i><i style="width:${c.dmg.pure * 100}%;background:#f2e6a0">${c.dmg.pure > 0.08 ? Math.round(c.dmg.pure * 100) + '%' : ''}</i></div>`;
    const flags = c => `<ul class="flags">${c.flags.map(f => `<li class="${f.bad ? 'bad' : 'good'}">${esc(f.text)}</li>`).join('')}</ul>`;
    return `
      <div class="panel">
        <h4><span style="color:var(--radiant-2)">Силы Света</span><span>Роли (сумма уровней Valve)</span><span style="color:var(--dire-2)">Силы Тьмы</span></h4>
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
      return `<div class="alt-row">
        <div class="orig"><img src="${img(p.hero)}" data-open="${p.hero}" alt=""><div><b>${esc(H(p.hero).name)}</b><div class="st">Пик #${p.step + 1} · фаза ${step.phase < 2 ? 'I' : step.phase < 4 ? 'II' : 'III'}</div></div></div>
        <div class="alt-opts">${p.options.map(o => `<div class="alt-opt"><img src="${img(o.hero)}" data-open="${o.hero}" alt=""><div><div>${esc(H(o.hero).name)}</div><div class="d ${o.delta > 0.002 ? 'pos' : 'muted'}">${o.delta > 0.002 ? '+' + (o.delta * 100).toFixed(1) + '%' : 'не лучше'}</div></div><div class="why">${esc(o.reasons.join(' · ') || '—')}</div></div>`).join('')}</div>
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
      </div>`).join('') + `<div class="muted small">Альтернативы — герои, доступные в момент пика и не взятые позже; процент — насколько изменился бы итоговый шанс на победу при замене (с учётом позиций, линий и матчапов).</div>`;
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
    const s = e.target.closest('[data-syn]');
    if (s) { synSide = s.dataset.syn; root.querySelector('#res-body').innerHTML = body(); return; }
    const o = e.target.closest('[data-open]');
    if (o) { onOpenHero(Number(o.dataset.open)); return; }
    const a = e.target.closest('[data-act]');
    if (a?.dataset.act === 'rematch') onRematch();
    if (a?.dataset.act === 'menu') onMenu();
  };
  draw();
  return { update(newRoom) { room = newRoom; draw(); } };
}
