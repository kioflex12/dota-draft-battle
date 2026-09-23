const CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2';

export const heroImg = key => `${CDN}/images/dota_react/heroes/${key}.png`;
// Vertical portrait (235x272), framed on the hero's face. Fits portrait-shaped slots without the
// stretching you get from cropping the 256x144 landscape card into them. A handful of the newer
// heroes (Dawnbreaker, Marci, Muerta, Primal Beast) have no such asset, hence the fallbacks below.
export const heroVert = key => `${CDN}/images/heroes/${key}_vert.jpg`;
// Inline onerror: swap to the landscape card for heroes without a vertical portrait.
export const vertFallback = key => `onerror="this.onerror=null;this.src='${heroImg(key)}'"`;
// CSS paints the first background it can load, so the card acts as the fallback layer.
export const heroVertBg = key => `url(${heroVert(key)}), url(${heroImg(key)})`;
export const heroIcon = key => `${CDN}/images/dota_react/heroes/icons/${key}.png`;
export const heroRender = key => `${CDN}/videos/dota_react/heroes/renders/${key}.webm`;
export const heroRenderPng = key => `${CDN}/videos/dota_react/heroes/renders/${key}.png`;
export const abilityImg = key => `${CDN}/images/dota_react/abilities/${key}.png`;
export const INNATE_ICON = `${CDN}/images/dota_react/icons/innate_icon.png`;
export const ATTR_ICON = ['hero_strength', 'hero_agility', 'hero_intelligence', 'hero_universal'].map(n => `${CDN}/images/dota_react/icons/${n}.png`);
export const ATTR_NAME = ['Сила', 'Ловкость', 'Интеллект', 'Универсальный'];

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const fmtPct = (x, digits = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(digits)}`;
export const signCls = (x, eps = 0.05) => (x > eps ? 'pos' : x < -eps ? 'neg' : '');

let toastTimer;
export function toast(text, ok = false) {
  const t = $('#toast');
  t.textContent = text;
  t.className = 'toast' + (ok ? ' ok' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

const tip = () => $('#tooltip');
export function bindTooltip(root) {
  root.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    tip().innerHTML = el.dataset.tip;
    tip().classList.remove('hidden');
  });
  root.addEventListener('mousemove', e => {
    if (tip().classList.contains('hidden')) return;
    const t = tip();
    const x = Math.min(e.clientX + 16, window.innerWidth - t.offsetWidth - 8);
    const y = e.clientY + 18 + t.offsetHeight > window.innerHeight ? e.clientY - t.offsetHeight - 10 : e.clientY + 18;
    t.style.left = x + 'px';
    t.style.top = y + 'px';
  });
  root.addEventListener('mouseout', e => {
    if (e.target.closest('[data-tip]') && !e.relatedTarget?.closest?.('[data-tip]')) tip().classList.add('hidden');
  });
  // На тач-экране наведения не бывает, поэтому подписи к слотам банов и полосе очерёдности были
  // недоступны вовсе. Тап по такому элементу показывает подпись на пару секунд. Карточки героев
  // исключены: по ним тап выбирает героя, а сведения и так открываются в панели.
  let touchTimer;
  root.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    const el = e.target.closest('[data-tip]');
    if (!el || el.closest('.hcell')) return;
    const t = tip();
    t.innerHTML = el.dataset.tip;
    t.classList.remove('hidden');
    const r = el.getBoundingClientRect();
    t.style.left = Math.max(8, Math.min(r.left, window.innerWidth - t.offsetWidth - 8)) + 'px';
    t.style.top = (r.top > t.offsetHeight + 12 ? r.top - t.offsetHeight - 8 : r.bottom + 8) + 'px';
    clearTimeout(touchTimer);
    touchTimer = setTimeout(() => t.classList.add('hidden'), 2600);
  }, { passive: true });

  // Прокрутка уводит страницу из-под подсказки, а курсор остаётся на месте: mouseout не наступает,
  // и подсказка висит над чужим содержимым до следующего наведения.
  const hide = () => tip().classList.add('hidden');
  addEventListener('scroll', hide, { capture: true, passive: true });
  addEventListener('wheel', hide, { passive: true });
  addEventListener('blur', hide);
}

let audio;
export function beep(freq = 660, dur = 0.08, vol = 0.05) {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = freq;
    o.type = 'triangle';
    g.gain.value = vol;
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + dur);
  } catch {}
}

// A background tab shows nothing when the turn changes, and the sound may be muted or missed.
// Flashing the tab title is the one signal that survives both.
let titleTimer, baseTitle;
export function flashTitle(text) {
  baseTitle ??= document.title;
  if (!text) {
    clearInterval(titleTimer);
    titleTimer = null;
    document.title = baseTitle;
    return;
  }
  if (titleTimer) return;
  let on = false;
  document.title = text;
  titleTimer = setInterval(() => { on = !on; document.title = on ? baseTitle : text; }, 1000);
}

export function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {}
  return null;
}
