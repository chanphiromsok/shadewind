// Regenerate: node fixtures/classmerge/generate.mjs fixtures/classmerge && node ../../bin/cn-table.mjs fixtures/classmerge/src -o fixtures/classmerge/table.tsv
// Generates the class-merge golden fixture: random class strings, tailwind-merge's output for each, and the table built from them.
import fs from 'node:fs';
import { createRequire } from 'node:module';
// run from a directory where tailwind-merge resolves, e.g. example/: node ../cpp/harness/fixtures/classmerge/generate.mjs <out>
const require = createRequire(`${process.cwd()}/package.json`);
const { twMerge } = require('tailwind-merge');
const out = process.argv[2];
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const bases = ['p-1', 'p-2', 'px-2', 'py-3', 'm-1', 'mt-2', 'bg-red-500', 'bg-blue-500', 'text-red-500', 'text-lg', 'text-sm',
  'font-bold', 'font-normal', 'rounded', 'rounded-lg', 'flex', 'hidden', 'block', 'w-4', 'w-full', 'opacity-50', 'border', 'border-2'];
const mods = ['hover', 'focus', 'active', 'before', 'after', 'placeholder', 'dark', 'md', 'disabled', 'file', 'marker', '*', '[&>*]'];
const cases = [];
for (let i = 0; i < 3000; i++) {
  const n = 2 + Math.floor(rnd() * 5);
  const tokens = [];
  for (let k = 0; k < n; k++) {
    const depth = Math.floor(rnd() * 3);
    const ms = [];
    for (let d = 0; d < depth; d++) ms.push(pick(mods));
    let t = (ms.length ? ms.join(':') + ':' : '') + pick(bases);
    if (rnd() < 0.05) t = t.replace(/([^:]+)$/, '!$1');
    tokens.push(t);
  }
  cases.push(tokens.join(' '));
}
// every pair of modifiers in both orders on two conflicting classes: where the order matters to tailwind-merge
for (const a of mods) {
  for (const b of mods) {
    if (a !== b) {
      cases.push(`${a}:${b}:p-1 ${b}:${a}:p-2`, `${a}:${b}:bg-red-500 ${b}:${a}:bg-blue-500 ${a}:${b}:p-1`);
    }
  }
}
fs.mkdirSync(`${out}/src`, { recursive: true });
fs.writeFileSync(`${out}/src/cases.ts`, cases.map((c) => `'${c}';`).join('\n') + '\n');
fs.writeFileSync(`${out}/cases.tsv`, cases.map((c) => `${c}\t${twMerge(c)}`).join('\n') + '\n');
