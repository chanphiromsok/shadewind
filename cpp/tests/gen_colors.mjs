// Generates "<css>\t<ARGB hex>" cases; expected values come from culori with the pipeline policy (clamp each channel, round).
// usage: node gen_colors.mjs <path-to-culori-resolver-root> > colors.tsv
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(path.join(process.argv[2], 'package.json'));
const culori = require('culori');
const rgb = culori.converter('rgb');
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const clamp = (x) => Math.min(255, Math.max(0, Math.round(x * 255)));
const pack = (c) => ((clamp(c.alpha ?? 1) << 24) | (clamp(c.r) << 16) | (clamp(c.g) << 8) | clamp(c.b)) >>> 0;
const out = [];
const add = (css) => { const c = culori.parse(css); if (!c) return; out.push(`${css}\t${pack(rgb(c)).toString(16).padStart(8, '0')}`); };
for (let i = 0; i < 400; i++) {
  const r = Math.floor(rnd() * 256), g = Math.floor(rnd() * 256), b = Math.floor(rnd() * 256), a = Math.round(rnd() * 100) / 100;
  add('#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join(''));
  add(`rgb(${r}, ${g}, ${b})`);
  add(`rgb(${r} ${g} ${b} / ${a})`);
  add(`rgba(${r},${g},${b},${a})`);
  add(`hsl(${Math.floor(rnd() * 360)}, ${Math.floor(rnd() * 101)}%, ${Math.floor(rnd() * 101)}%)`);
  add(`hsl(${Math.floor(rnd() * 360)} ${Math.floor(rnd() * 101)}% ${Math.floor(rnd() * 101)}% / ${a})`);
  add(`oklch(${(rnd()).toFixed(4)} ${(rnd() * 0.4).toFixed(4)} ${(rnd() * 360).toFixed(2)})`);        // may be out of sRGB gamut
  add(`oklch(${(rnd()).toFixed(3)} ${(rnd() * 0.15).toFixed(3)} ${(rnd() * 360).toFixed(1)} / ${a})`);
}
// tokens that appear in tovtam's global.css
for (const s of ['oklch(0.6486 0.1749 150.71)', 'oklch(0.8862 0.2131 97.14)', 'oklch(0.2178 0 0)', 'oklch(1 0 0)', 'rgb(4, 171, 82)', '#04ab52', '#fff', '#0008', 'transparent'])
  add(s);
console.log(out.join('\n'));
