import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
const require = createRequire(path.join(root, 'package.json'));
const { compile } = require('@tailwindcss/node');
const { Scanner } = require('@tailwindcss/oxide');
const lightning = require('lightningcss');

const t0 = performance.now();
const scanner = new Scanner({ sources: [{ base: path.join(root, 'src'), pattern: '**/*', negated: false }] });
const candidates = scanner.scan();
const t1 = performance.now();
const css = fs.readFileSync(path.join(root, 'global.css'), 'utf8');
let out, err;
try {
  const c = await compile(css, { base: root, onDependency: () => {} });
  out = c.build(candidates);
} catch (e) { err = e; }
const t2 = performance.now();
console.log(JSON.stringify({ candidates: candidates.length, scanMs: +(t1 - t0).toFixed(1), compileMs: +(t2 - t1).toFixed(1), error: err && String(err.message).slice(0, 300), cssBytes: out && out.length }));
if (out) {
  fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'out.css'), out);
  const seen = { customProps: 0, lightDark: 0, rules: 0 };
  lightning.transform({
    filename: 'out.css', code: Buffer.from(out),
    visitor: {
      Rule() { seen.rules++; },
      Declaration: { custom(d) { seen.customProps++; } },
      Color(c) { if (c.type === 'light-dark') seen.lightDark++; }
    }
  });
  console.log(JSON.stringify(seen));
}
