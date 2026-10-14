import { createRequire } from 'node:module'; import fs from 'node:fs';
const [,, ROOT, CSS, THEMES = 'light,dark'] = process.argv;
const require = createRequire(ROOT + '/package.json');
const L = require('lightningcss'); const culori = require('culori');
const THEME_NAMES = new Set(THEMES.split(','));            // from config, like uniwind's bundlerConfig.themes

// --- 1. selector classification on the lightningcss AST (shapes observed in out.css) ---
const isRoot = c => c.type === 'pseudo-class' && c.kind === 'root';
// [[class X]] , [[class X, descendant, universal]]  ->  X
function whereTheme(c) {
  if (c.type !== 'pseudo-class' || c.kind !== 'where') return null;
  const names = new Set();
  for (const s of c.selectors) {
    const ok = (s.length === 1 && s[0].type === 'class') ||
      (s.length === 3 && s[0].type === 'class' && s[1].type === 'combinator' && s[1].value === 'descendant' && s[2].type === 'universal');
    if (!ok) return null; names.add(s[0].name);
  }
  return names.size === 1 ? [...names][0] : null;
}
function classifySelector(sel) {
  if (sel.length === 1 && isRoot(sel[0])) return { kind: 'base' };   // ':host' alone also heads 'html, :host' (preflight)
  if (sel.length === 2 && isRoot(sel[0])) {
    const t = whereTheme(sel[1]); if (t) return THEME_NAMES.has(t) ? { kind: 'theme', theme: t } : { kind: 'unknown-theme', theme: t };
    if (sel[1].type === 'pseudo-class' && sel[1].kind === 'not') return { kind: 'system' }; // :root:not(:where(.light..,.dark..))
  }
  return null;
}
const schemeOf = q => q.mediaQueries.length === 1 && q.mediaQueries[0].condition?.type === 'feature' &&
  q.mediaQueries[0].condition.value.name === 'prefers-color-scheme' ? q.mediaQueries[0].condition.value.value.value : null;

// --- 2. walk with a context stack; cascade key = (layer rank, source order); specificity of all observed shapes is (0,1,0)
const layerRank = new Map(); const rankOf = n => { const k = n.join('.'); if (!layerRank.has(k)) layerRank.set(k, layerRank.size); return layerRank.get(k); };
const UNLAYERED = 1e9; let order = 0;
const writes = [];   // {target:'base'|theme, scheme, name, value, key:[layer,order]}
const issues = [];
function walk(rules, ctx) {
  for (const r of rules) {
    if (r.type === 'layer-statement') r.value.names.forEach(rankOf);
    else if (r.type === 'layer-block') walk(r.value.rules, { ...ctx, layer: rankOf(r.value.name ?? ['<anon>']) });
    else if (r.type === 'media') walk(r.value.rules, { ...ctx, scheme: schemeOf(r.value.query) ?? ctx.scheme, media: schemeOf(r.value.query) ? ctx.media : [...ctx.media, r.value.query] });
    else if (r.type === 'supports') walk(r.value.rules, ctx);       // later @supports branch wins, as in uniwind
    else if (r.type === 'style') {
      for (const sel of r.value.selectors) {
        const cls = classifySelector(sel);
        if (!cls) { if (!(sel.length === 1 && sel[0].kind === 'host') && (r.value.declarations?.declarations ?? []).some(d => d.property === 'custom' && d.value.name?.startsWith('--color-'))) issues.push(`unclassified token rule at line ${r.value.loc.line + 1}`); continue; }
        if (cls.kind === 'unknown-theme') { issues.push(`theme class .${cls.theme} not in config (line ${r.value.loc.line + 1})`); continue; }
        if (ctx.media.length) issues.push(`token block under non-theme @media at line ${r.value.loc.line + 1}`);
        emit(r.value.declarations, cls, ctx, r.value.loc.line + 1);
        walk(r.value.rules ?? [], { ...ctx, parent: cls });            // CSS nesting: :root { @supports (...) { --x: ... } }
      }
    } else if (r.type === 'nested-declarations' && ctx.parent) emit(r.value.declarations, ctx.parent, ctx, r.value.loc?.line + 1);
  }
}
function emit(block, cls, ctx, line) {
  for (const d of block?.declarations ?? []) {
    if (d.property !== 'custom' || !d.value.name.startsWith('--')) continue;   // preflight props also arrive as 'custom'
    writes.push({ target: cls.kind === 'base' ? 'base' : cls.kind === 'system' ? `system:${ctx.scheme}` : cls.theme,
      name: d.value.name, value: d.value.value, key: [ctx.layer ?? UNLAYERED, order++], line });
  }
}
L.transform({ filename: 'out.css', code: fs.readFileSync(CSS), visitor: { StyleSheet(ss) { walk(ss.rules, { media: [] }); } } });

// --- 3. cascade: sort by key; 'unset' placeholders never overwrite a real value
const isUnset = v => v.length === 1 && v[0].type === 'token' && v[0].value.type === 'ident' && v[0].value.value === 'unset';
writes.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1]);
const maps = {};
for (const w of writes) { const m = (maps[w.target] ??= {}); if (w.target === 'base' && isUnset(w.value) && m[w.name]) continue; m[w.name] = w; }

// --- 4. system twins must equal the explicit theme of the same scheme (Uniwind skips them; we assert)
for (const t of Object.keys(maps).filter(k => k.startsWith('system:'))) {
  const ex = maps[t.slice(7)] ?? {};
  for (const [n, w] of Object.entries(maps[t])) if (JSON.stringify(ex[n]?.value) !== JSON.stringify(w.value)) issues.push(`${t} ${n} differs from explicit theme`);
}

// --- 5. per-theme resolution: base <- theme, var() resolved, colour -> ARGB with clamp (matches uniwind formatHex)
const rgb = culori.converter('rgb');
const clamp = x => Math.min(255, Math.max(0, Math.round(x * 255)));
function toArgb(c) {                                 // lightningcss CssColor -> uint32
  if (c.type === 'light-dark') return { lightDark: [toArgb(c.light), toArgb(c.dark)] };
  if (c.type === 'currentcolor') return { currentColor: true };
  const mode = c.type === 'display-p3' ? 'p3' : c.type;
  const o = c.type === 'rgb' ? { r: c.r / 255, g: c.g / 255, b: c.b / 255, alpha: c.alpha } : rgb({ ...c, mode });
  return ((clamp(o.alpha ?? 1) << 24) | (clamp(o.r) << 16) | (clamp(o.g) << 8) | clamp(o.b)) >>> 0;
}
function resolve(value, scope, seen = new Set()) {   // returns ARGB, {raw}, or {unresolved}
  if (value.length === 1 && value[0].type === 'color') return toArgb(value[0].value);
  if (value.length === 1 && value[0].type === 'var') {
    const n = value[0].value.name.ident; if (seen.has(n)) return { cycle: n };
    const w = scope[n]; return w ? resolve(w.value, scope, new Set(seen).add(n)) : { unresolved: n };
  }
  if (value.length === 1 && value[0].type === 'function' && value[0].value.name === 'color-mix') return resolveMix(value, scope, seen);
  return { raw: true };                              // calc(), lengths, env(): separate evaluator / runtime
}
// color-mix(in oklab, var(--x) 30%, transparent): substitute vars per theme, let lightningcss fold the literal mix
const hex8 = n => '#' + ((n & 0xffffff) >>> 0).toString(16).padStart(6, '0') + ((n >>> 24) & 255).toString(16).padStart(2, '0');
function ser(tokens, scope, seen) {
  return tokens.map(t => {
    if (t.type === 'var') { const v = resolve([t], scope, seen); if (typeof v !== 'number') throw new Error('unresolved ' + t.value.name.ident); return ' ' + hex8(v) + ' '; }
    if (t.type === 'color') return ' ' + hex8(toArgb(t.value)) + ' ';
    if (t.type === 'function') return `${t.value.name}(${ser(t.value.arguments, scope, seen)})`;
    const v = t.value;
    switch (v.type) { case 'ident': return v.value; case 'white-space': return ' '; case 'comma': return ','; case 'percentage': return v.value * 100 + '%'; case 'number': return String(v.value); default: throw new Error('token ' + v.type); }
  }).join('');
}
function resolveMix(value, scope, seen) {
  let css; try { css = ser(value, scope, seen); } catch (e) { return { unresolved: e.message }; }
  // fold via lightningcss *lowering* (sRGB hex), not the visitor's oklab AST: on 1.30.2 the AST value of
  // color-mix(in oklab, #003355 50%, black) is #000b2a while the lowered output (and culori) give #000d1c
  const low = L.transform({ filename: 'mix.css', code: Buffer.from(`.x{color:${css}}`), targets: { chrome: 50 << 16 } }).code.toString();
  const m = /color:\s*([^;]+);/.exec(low); const p = m && culori.parse(m[1]);
  if (!p) return { unresolved: css };
  const o = rgb(p); return ((clamp(o.alpha ?? 1) << 24) | (clamp(o.r) << 16) | (clamp(o.g) << 8) | clamp(o.b)) >>> 0;
}
const out = {};
for (const theme of THEME_NAMES) {
  const scope = { ...maps.base, ...maps[theme] };
  out[theme] = {};
  for (const [n, w] of Object.entries(scope)) if (n.startsWith('--color-') && !isUnset(w.value)) out[theme][n] = resolve(w.value, scope);
}
const hex = v => typeof v === 'number' ? v.toString(16) : JSON.stringify(v);
console.log('layers', [...layerRank.keys()].join(','), 'writes', writes.length);
for (const t of THEME_NAMES) console.log(t, 'colour tokens', Object.keys(out[t]).length, 'primary', hex(out[t]['--color-primary']), 'card', hex(out[t]['--color-card']), 'yellow', hex(out[t]['--color-yellow']), 'red-500', hex(out[t]['--color-red-500']), 'mixed', hex(out[t]['--color-mixed']));
console.log('base non-colour tokens', Object.keys(maps.base).filter(n => !n.startsWith('--color-')).length);
console.log('issues', issues.length ? issues : 'none');
const all = new Set(THEME_NAMES.size ? [...THEME_NAMES].flatMap(t => Object.keys(maps[t] ?? {})) : []);
for (const t of THEME_NAMES) console.log('missing in', t, [...all].filter(n => !(maps[t] ?? {})[n]).length, 'of', all.size);
