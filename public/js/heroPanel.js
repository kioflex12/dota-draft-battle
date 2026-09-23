import { esc, heroImg, heroVertBg, heroRender, heroRenderPng, abilityImg, INNATE_ICON, ATTR_ICON, ATTR_NAME, fmtPct, signCls } from './util.js';
import { ROLE_KEYS, ROLE_NAMES, POS_NAMES, CURVE_MINUTES, toPct } from '../shared/analysis.js';

const TALENT_LEVELS = [25, 20, 15, 10];

export function renderHeroPanel(root, hero, ctx) {
  const { engine, action } = ctx;
  let tab = ctx.tab || 'abilities';
  let abilIdx = hero.abilities.findIndex(a => !a.innate);
  if (abilIdx < 0) abilIdx = 0;

  // The hero's model and the tab bar are built once. Switching a tab or an ability redraws only the
  // content below them — rebuilding the whole panel restarted the <video> on every such click.
  const drawShell = () => {
    root.innerHTML = `
      <div class="hp-hero">
        <span class="hp-bg" style="background-image:${heroVertBg(hero.key)}"></span>
        <video autoplay muted loop playsinline poster="${heroRenderPng(hero.key)}" src="${heroRender(hero.key)}"></video>
        <div class="hp-title">
          <div class="nm">${esc(hero.name)}</div>
          <div class="sub">
            <img src="${ATTR_ICON[hero.attr]}" alt="">${ATTR_NAME[hero.attr]} · ${hero.ranged ? 'Дальний бой' : 'Ближний бой'}
            · <span class="complexity" title="Сложность">${[1, 2, 3].map(i => `<i class="${i <= hero.complexity ? 'on' : ''}"></i>`).join('')}</span>
          </div>
        </div>
      </div>
      ${action ? `<div class="lock-bar">${action}</div>` : ''}
      <div class="hp-tabs">
        ${[['abilities', 'Способности'], ['stats', 'Характеристики'], ['meta', 'Статистика']].map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join('')}
      </div>
      <div class="hp-content"></div>`;
  };

  const drawContent = () => {
    root.querySelector('.hp-content').innerHTML = tab === 'abilities' ? abilitiesTab() : tab === 'stats' ? statsTab() : metaTab();
    for (const b of root.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
  };

  const abilitiesTab = () => {
    const a = hero.abilities[abilIdx];
    const roles = ROLE_KEYS.map((k, i) => [k, hero.roleLevels?.[i] || 0]).filter(([, v]) => v > 0);
    return `
      <div class="hype">${hero.hype}</div>
      <div class="roles-line">${roles.map(([k, v]) => `<span>${ROLE_NAMES[k]}<b>${'●'.repeat(v)}</b></span>`).join('')}</div>
      <div class="abil-row">
        ${hero.abilities.map((ab, i) => `
          <div class="abil ${ab.innate ? 'innate' : ''} ${ab.ult ? 'ult' : ''} ${i === abilIdx ? 'on' : ''}" data-abil="${i}" data-tip="<div class='tt-h'>${esc(ab.name)}</div>${esc(ab.innate ? 'Врождённая способность' : ab.ult ? 'Ультимейт' : ab.byScepter ? 'От Aghanim\'s Scepter' : ab.byShard ? 'От Aghanim\'s Shard' : '')}">
            <img src="${ab.innate ? INNATE_ICON : abilityImg(ab.key)}" onerror="this.onerror=null;this.src='${INNATE_ICON}'" alt="">
            ${ab.byScepter ? '<span class="tag">АГАНИМ</span>' : ab.byShard ? '<span class="tag">ШАРД</span>' : ''}
          </div>`).join('')}
      </div>
      ${a ? abilityDetail(a) : ''}
      <div>
        <div class="sec-title">Таланты</div>
        <div class="talents">
          ${TALENT_LEVELS.map((lvl, i) => {
            const idx = (3 - i) * 2;
            return `<div class="talent-row"><div>${hero.talents[idx + 1] || ''}</div><div class="lvl">${lvl}</div><div>${hero.talents[idx] || ''}</div></div>`;
          }).join('')}
        </div>
      </div>`;
  };

  const abilityDetail = a => {
    const meta = [];
    if (a.behavior.length) meta.push(['Применение', a.behavior.join(', ')]);
    if (a.damage) meta.push(['Тип урона', a.damage]);
    if (a.pierce) meta.push(['Сквозь иммунитет к магии', a.pierce]);
    if (a.dispel) meta.push(['Развеиваемость', a.dispel]);
    return `
      <div class="abil-detail">
        <div class="ad-head">
          <img src="${a.innate ? INNATE_ICON : abilityImg(a.key)}" onerror="this.onerror=null;this.src='${INNATE_ICON}'" alt="">
          <div><div class="t">${esc(a.name)}</div><div class="muted small">${a.innate ? 'Врождённая' : a.ult ? 'Ультимейт' : 'Способность'}</div></div>
        </div>
        <div class="ad-body">
          ${meta.length ? `<div class="ad-meta">${meta.map(([k, v]) => `<span>${k}:</span><b>${esc(v)}</b>`).join('')}</div>` : ''}
          <div>${a.desc}</div>
          ${a.attribs.length ? `<div class="ad-attrs">${a.attribs.map(x => `<div>${esc(x.h)}: <b>${esc(x.v)}</b></div>`).join('')}</div>` : ''}
          ${a.cd || a.mana || a.hp ? `<div class="ad-cdmana">${a.cd ? `<span class="cd">${a.cd}</span>` : ''}${a.mana ? `<span class="mana">${a.mana}</span>` : ''}${a.hp ? `<span class="hpc">${a.hp}</span>` : ''}</div>` : ''}
          ${a.scepter ? `<div class="ad-upg"><div class="h">Aghanim's Scepter</div>${a.scepter}</div>` : ''}
          ${a.shard ? `<div class="ad-upg shard"><div class="h">Aghanim's Shard</div>${a.shard}</div>` : ''}
          ${a.notes.length ? `<ul class="ad-notes">${a.notes.map(n => `<li>${n}</li>`).join('')}</ul>` : ''}
          ${a.lore ? `<div class="ad-lore">${a.lore}</div>` : ''}
        </div>
      </div>`;
  };

  const statsTab = () => {
    const s = hero.stats;
    const attrs = [['Сила', s.str, s.strGain, 0], ['Ловкость', s.agi, s.agiGain, 1], ['Интеллект', s.int, s.intGain, 2]];
    const rows = [
      ['Урон', `${s.dmgMin}–${s.dmgMax}`], ['Интервал атаки', s.bat],
      ['Дальность атаки', s.range], ['Скорость снаряда', s.proj || '—'],
      ['Броня', Math.round(s.armor * 10) / 10], ['Сопр. магии', s.mr + '%'],
      ['Скорость', s.ms], ['Скорость поворота', s.turn],
      ['Обзор', `${s.visionDay} / ${s.visionNight}`], ['Здоровье', s.hp],
      ['Реген здоровья', Math.round(s.hpRegen * 100) / 100], ['Мана', s.mana],
      ['Реген маны', Math.round(s.manaRegen * 100) / 100],
    ];
    return `
      <div class="attr-line">${attrs.map(([n, v, g, i]) => `<div class="${hero.attr === i || hero.attr === 3 ? 'prim' : ''}"><img src="${ATTR_ICON[i]}" width="18" alt=""><div class="v">${v}</div><div class="g">+${g} · ${n}</div></div>`).join('')}</div>
      <div class="muted small">Значения на 1-м уровне.</div>
      <div class="stat-table">${rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>
      <div><div class="sec-title">История</div><div class="hype" style="max-height:220px;overflow:auto">${hero.bio}</div></div>`;
  };

  const metaTab = () => {
    const info = engine.heroInfo(hero.id);
    const mini = list => list.map(x => {
      const h = engine.H.get(x.hero);
      const v = toPct(x.v);
      return `<span class="mini-hero" data-open="${h.id}"><img src="${heroImg(h.key)}" alt="">${esc(h.name)} <b class="${signCls(v)}">${fmtPct(v)}</b></span>`;
    }).join('');
    const phaseMin = Math.min(...info.phase), phaseMax = Math.max(...info.phase);
    const span = Math.max(0.15, Math.abs(phaseMin), Math.abs(phaseMax));
    return `
      <div class="kv">
        <div><div class="k">Победы Divine+</div><div class="v">${(info.wr * 100).toFixed(1)}%</div><div class="muted small">${info.pubG.toLocaleString('ru')} игр</div></div>
        <div><div class="k">Про: пики/баны</div><div class="v">${Math.round(info.contest * 100)}%</div><div class="muted small">${Math.round(info.pickRate * 100)}% / ${Math.round(info.banRate * 100)}%</div></div>
        <div><div class="k">Про: победы</div><div class="v">${info.proWr == null ? '—' : (info.proWr * 100).toFixed(1) + '%'}</div><div class="muted small">${info.proG} игр</div></div>
      </div>
      <div>
        <div class="sec-title">Позиции</div>
        <div class="bars">${info.posProb.map((p, i) => `<div class="bar-row" data-tip="${info.posN[i]} про-игр на позиции${info.posN[i] ? `, ${Math.round(info.posW[i] / info.posN[i] * 100)}% побед` : ''}"><span>${i + 1} · ${POS_NAMES[i]}</span><div class="track"><i style="width:${Math.round(p * 100)}%"></i></div><span class="val">${Math.round(p * 100)}%${info.posN[i] >= 6 ? ` · ${Math.round(info.posW[i] / info.posN[i] * 100)}%` : ''}</span></div>`).join('')}</div>
        <div class="muted small">Доля про-игр на позиции · винрейт там (если игр ≥ 6).</div>
      </div>
      <div>
        <div class="sec-title">Сила по времени игры</div>
        <div class="bars">${CURVE_MINUTES.filter((_, i) => i % 2 === 0).map(m => {
          const v = info.phase[CURVE_MINUTES.indexOf(m)];
          const w = Math.abs(v) / span * 50;
          return `<div class="bar-row"><span>${m} мин</span><div class="track" style="position:relative"><i style="position:absolute;${v >= 0 ? 'left:50%' : 'right:50%'};width:${w}%;background:${v >= 0 ? 'var(--good)' : 'var(--bad)'}"></i></div><span class="val ${signCls(toPct(v))}">${fmtPct(toPct(v))}</span></div>`;
        }).join('')}</div>
      </div>
      <div><div class="sec-title">Лучшие союзники</div><div class="mini-list">${mini(info.synergy)}</div></div>
      <div><div class="sec-title">Хорош против</div><div class="mini-list">${mini(info.counters)}</div></div>
      <div><div class="sec-title">Слаб против</div><div class="mini-list">${mini(info.counteredBy)}</div></div>
      <div class="muted small">Проценты — изменение шанса на победу относительно ожидаемого (публичные матчи Divine+ патча ${engine.meta.patch}).</div>`;
  };

  root.onclick = e => {
    const t = e.target.closest('[data-tab]');
    if (t) { tab = t.dataset.tab; ctx.tab = tab; drawContent(); return; }
    const ab = e.target.closest('[data-abil]');
    if (ab) { abilIdx = Number(ab.dataset.abil); drawContent(); return; }
    const op = e.target.closest('[data-open]');
    if (op && ctx.onOpen) { ctx.onOpen(Number(op.dataset.open)); return; }
    if (e.target.closest('[data-act]') && ctx.onAct) ctx.onAct();
  };
  drawShell();
  drawContent();
}
