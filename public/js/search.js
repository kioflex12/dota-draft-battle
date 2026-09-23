const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

const ALIASES = {
  antimage: 'ам антимаг магина', axe: 'акс', bane: 'бейн', bloodseeker: 'бладсикер блуд бс', crystal_maiden: 'кристалка рылай см кристал',
  drow_ranger: 'дровка дроу тракса', earthshaker: 'шейкер ес ешка', juggernaut: 'джага джаггер югер', mirana: 'мирана потм',
  morphling: 'морф морфлинг', nevermore: 'сф шадоу финд невермор шф', phantom_lancer: 'пл лансер фантом лансер', puck: 'пак',
  pudge: 'пудж паджа мясник', razor: 'разор', sand_king: 'санд кинг ск крикс', storm_spirit: 'сторм', sven: 'свен', tiny: 'тини',
  vengefulspirit: 'венга венжефул', windrunner: 'вр виндрейнджер виндраннер лиралей', zuus: 'зевс зеус', kunkka: 'кунка',
  lina: 'лина', lion: 'лион', shadow_shaman: 'шаман рашта', slardar: 'слардар', tidehunter: 'тайд', witch_doctor: 'вд докер витч',
  lich: 'лич', riki: 'рики', enigma: 'энигма нигма', tinker: 'тинкер', sniper: 'снайпер', necrolyte: 'некрофос некр некро',
  warlock: 'варлок', beastmaster: 'бист бистмастер', queenofpain: 'квопа квоп акаша', venomancer: 'веник веномансер',
  faceless_void: 'войд фейслес', skeleton_king: 'вк врайт кинг скелет', death_prophet: 'дп дез профет кробелус',
  phantom_assassin: 'па фантомка мортра', pugna: 'пугна', templar_assassin: 'та темпларка ланая', viper: 'вайпер', luna: 'луна',
  dragon_knight: 'дк дракон найт', dazzle: 'дазл', rattletrap: 'клокверк клок кв', leshrac: 'лешрак леш',
  furion: 'фурион нп натур профет пророк', life_stealer: 'лайфстилер найкс лс naix', dark_seer: 'дарк сир дс', clinkz: 'клинкз клинз',
  omniknight: 'омник омни', enchantress: 'энча энчантресс', huskar: 'хускар', night_stalker: 'найтсталкер нс балланар',
  broodmother: 'бруда брудмазер', bounty_hunter: 'баунти бх гондар', weaver: 'вивер', jakiro: 'джакиро', batrider: 'батрайдер бэт',
  chen: 'чен', spectre: 'спектра', ancient_apparition: 'аа аппаришн', doom_bringer: 'дум', ursa: 'урса',
  spirit_breaker: 'сб спирит брейкер бара', gyrocopter: 'гиро гирокоптер', alchemist: 'алхимик алхим', invoker: 'инвокер вокер инвок',
  silencer: 'сайленсер сайлер', obsidian_destroyer: 'од обсидиан аутворлд', lycan: 'ликан', brewmaster: 'брюмастер панда брю',
  shadow_demon: 'шд шадоу демон', lone_druid: 'лд лон друид', chaos_knight: 'ск чаос найт цк', meepo: 'мипо', treant: 'трент',
  ogre_magi: 'огр огр маги', undying: 'андаинг андай', rubick: 'рубик', disruptor: 'дизраптор дизра', nyx_assassin: 'никс',
  naga_siren: 'нага', keeper_of_the_light: 'котл кипер', wisp: 'ио висп', visage: 'визаж', slark: 'сларк', medusa: 'медуза',
  troll_warlord: 'тролль тролл', centaur: 'центавр кентавр', magnataur: 'магнус', shredder: 'тимбер тимберсо', bristleback: 'бристл брист',
  tusk: 'таск', skywrath_mage: 'скай скаймаг', abaddon: 'абаддон', elder_titan: 'эт элдер титан', legion_commander: 'лк легионка легион',
  techies: 'течис минеры', ember_spirit: 'эмбер', earth_spirit: 'ерс ерф спирит', abyssal_underlord: 'андерлорд', terrorblade: 'тб террорблейд',
  phoenix: 'феникс', oracle: 'оракл', winter_wyvern: 'виверна вв', arc_warden: 'арк арк варден', monkey_king: 'мк манки',
  dark_willow: 'виллоу дарк виллоу', pangolier: 'панго пангольер', grimstroke: 'гримстроук грим', hoodwink: 'худвинк белка',
  void_spirit: 'войд спирит вс', snapfire: 'снапфаер бабка', mars: 'марс', dawnbreaker: 'даун даунбрейкер', marci: 'марси',
  primal_beast: 'праймал зверь', muerta: 'муэрта', ringmaster: 'рингмастер', kez: 'кез', largo: 'ларго',
};

export function norm(s) {
  return String(s).toLowerCase().replace(/ё/g, 'е').replace(/[а-я]/g, c => CYR[c] ?? c).replace(/[^a-z0-9]/g, '');
}

export function buildIndex(heroes) {
  const idx = new Map();
  for (const h of heroes) {
    const words = h.name.split(/[\s\-']+/).filter(Boolean);
    const tokens = new Set([norm(h.name), ...words.map(norm), norm(h.key.replace(/_/g, ''))]);
    if (words.length > 1) {
      tokens.add(words.map(w => w[0]).join('').toLowerCase());
      tokens.add(words.filter(w => !['of', 'the'].includes(w.toLowerCase())).map(w => w[0]).join('').toLowerCase());
    }
    for (const a of (ALIASES[h.key] || '').split(' ')) if (a) tokens.add(norm(a));
    const abilities = h.abilities.map(a => norm(a.name)).filter(Boolean);
    idx.set(h.id, { tokens: [...tokens].filter(Boolean), abilities });
  }
  return idx;
}

// 0 = no match; higher is better (exact > prefix > ability > substring).
export function score(entry, q) {
  if (!q) return 1;
  let best = 0;
  for (const t of entry.tokens) {
    if (t === q) return 4;
    if (t.startsWith(q)) best = Math.max(best, 3);
    else if (q.length >= 3 && t.includes(q)) best = Math.max(best, 1);
  }
  if (q.length >= 3) for (const a of entry.abilities) if (a.startsWith(q) || (q.length >= 4 && a.includes(q))) best = Math.max(best, 2);
  return best;
}
