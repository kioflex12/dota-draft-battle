const CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2';

export const heroImg = key => `${CDN}/images/dota_react/heroes/${key}.png`;
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
}

let audio;
export function beep(freq = 660, dur = 0.08, vol = 0.05) {
  try {
    audio ??= new AudioContext();
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

export function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {}
  return null;
}
