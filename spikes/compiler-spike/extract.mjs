import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
const require = createRequire(path.join(root, 'package.json'));
const lightning = require('lightningcss');
const culori = require('culori');
const t0 = performance.now();
const code = fs.readFileSync(new URL('./out.css', import.meta.url));
const themes = {}; // theme -> { token -> value }
lightning.transform({
  filename: 'out.css', code,
  visitor: {
    Rule: {
      style(rule) {
        // :root:where(.light, .light *)
        const sel = JSON.stringify(rule.value.selectors);
        const m = /"name":"(light|dark|[a-z0-9-]+)"/.exec(sel);
        const isRootWhere = sel.includes('"where"') || sel.includes(':where');
        if (!m || !sel.includes('root')) return;
        const name = m[1];
        const decls = rule.value.declarations?.declarations ?? [];
        for (const d of decls) {
          if (d.property === 'custom' && d.value.name.startsWith('--color-')) {
            (themes[name] ??= {})[d.value.name] = d.value.value;
          }
        }
      }
    }
  }
});
const t1 = performance.now();
const summary = {};
for (const [name, toks] of Object.entries(themes)) summary[name] = Object.keys(toks).length;
// one token through culori (oklch -> sRGB -> ARGB uint32) to prove the colour path
const sample = themes.light?.['--color-brand'];
const first = sample && JSON.stringify(sample).slice(0, 200);
console.log(JSON.stringify({ parseExtractMs: +(t1 - t0).toFixed(1), tokensPerTheme: summary, sampleToken: first }));
const rgb = culori.converter('rgb');
const c = rgb(culori.parse('oklch(0.6486 0.1749 150.71)'));
const argb = ((255 << 24) | (Math.round(c.r * 255) << 16) | (Math.round(c.g * 255) << 8) | Math.round(c.b * 255)) >>> 0;
console.log('oklch(0.6486 0.1749 150.71) ->', argb.toString(16));
