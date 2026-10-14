// Builds the oracle-derived merge table for C++: token -> conflict group, group -> groups it overrides.
// tailwind-merge itself is the oracle, so the C++ result matches the React Native (JS) side by construction.
import fs from 'node:fs';
import { twMerge } from 'tailwind-merge';
const { cases } = JSON.parse(fs.readFileSync('corpus.json', 'utf8'));
const tokens = new Set();
const splitMods = (t) => { // top-level ':' split, ignoring [] and ()
  const parts = []; let depth = 0, cur = '';
  for (const ch of t) { if (ch === '[' || ch === '(') depth++; if (ch === ']' || ch === ')') depth--; if (ch === ':' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch; }
  parts.push(cur); return parts;
};
for (const c of cases) for (const s of c) for (const t of s.split(/\s+/).filter(Boolean)) {
  let base = splitMods(t).pop();
  if (base.startsWith('!')) base = base.slice(1); if (base.endsWith('!')) base = base.slice(0, -1);
  tokens.add(base);
}
const bases = [...tokens];
const unknown = new Set(bases.filter((b) => twMerge(`${b} ${b}`) === `${b} ${b}`)); // kept twice => not a tailwind class
const known = bases.filter((b) => !unknown.has(b));
// bucket by mutual override
const reps = []; const groupOf = new Map();
for (const b of known) {
  let found = -1;
  for (let g = 0; g < reps.length; g++) {
    const r = reps[g];
    if (twMerge(`${r} ${b}`) === b && twMerge(`${b} ${r}`) === r) { found = g; break; }
  }
  if (found < 0) { reps.push(b); found = reps.length - 1; }
  groupOf.set(b, found);
}
// asymmetric overrides between groups: later g1 removes earlier g2
const kills = reps.map(() => []);
for (let g1 = 0; g1 < reps.length; g1++) for (let g2 = 0; g2 < reps.length; g2++) {
  if (twMerge(`${reps[g2]} ${reps[g1]}`) === reps[g1]) kills[g1].push(g2);
}
const lines = [];
lines.push(`G\t${reps.length}`);
kills.forEach((k, g) => lines.push(`K\t${g}\t${k.join(',')}`));
for (const b of known) lines.push(`T\t${b}\t${groupOf.get(b)}`);
for (const b of unknown) lines.push(`U\t${b}`);
fs.writeFileSync('table.tsv', lines.join('\n') + '\n');
// C++ test data: one case per line, parts joined by \x1f; expected from the reference
const exp = JSON.parse(fs.readFileSync('expected.json', 'utf8'));
fs.writeFileSync('cases.txt', cases.map((c, i) => c.join('\x1f') + '\x1e' + exp[i]).join('\n') + '\n');
console.log(JSON.stringify({ bases: bases.length, known: known.length, unknown: unknown.size, groups: reps.length }));
