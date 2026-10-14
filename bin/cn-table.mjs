#!/usr/bin/env node
// shadewind-cn-table <srcDir> [-o table.tsv]
// Builds the native class-merge table for an app. tailwind-merge (a peer dependency of this tool only) is the oracle:
// class tokens are grouped by mutual override and the group-to-group overrides are read from it, so the native merge is
// equivalent to twMerge for every token in the table; unknown tokens make the runtime fall back to the JS reference.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const srcDir = args.find((a) => !a.startsWith('-') && a !== args[args.indexOf('-o') + 1]);
const outIndex = args.indexOf('-o');
const outFile = outIndex >= 0 ? args[outIndex + 1] : 'shadewind-cn-table.tsv';

if (!srcDir) {
  console.error('usage: shadewind-cn-table <srcDir> [-o table.tsv]');
  process.exit(1);
}

const require = createRequire(path.join(process.cwd(), 'package.json'));
const { twMerge } = require('tailwind-merge');

// 1. candidate tokens: every whitespace separated token of every string literal in the sources
const tokens = new Set();
const TOKEN = /^[!\w:\[\]\-./%#(),&>*=~'@+]{1,80}$/;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(tsx?|jsx?|mdx?)$/.test(entry.name)) scan(fs.readFileSync(full, 'utf8'));
  }
};
const scan = (text) => {
  for (const m of text.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
    for (const t of m[2].split(/\s+/)) if (t && TOKEN.test(t)) tokens.add(t);
  }
};
walk(path.resolve(srcDir));

// 2. base class of each token (strip modifiers and the important marker)
const splitMods = (t) => {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of t) {
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth--;
    if (ch === ':' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts;
};
const bases = new Set();
for (const t of tokens) {
  let b = splitMods(t).pop();
  if (b.startsWith('!')) b = b.slice(1);
  if (b.endsWith('!')) b = b.slice(0, -1);
  if (b) bases.add(b);
}

// 3. classify with the oracle
const list = [...bases];
const unknown = new Set(list.filter((b) => twMerge(`${b} ${b}`) === `${b} ${b}`));
const known = list.filter((b) => !unknown.has(b));
const reps = [];
const groupOf = new Map();
for (const b of known) {
  let found = -1;
  for (let g = 0; g < reps.length; g++) {
    if (twMerge(`${reps[g]} ${b}`) === b && twMerge(`${b} ${reps[g]}`) === reps[g]) { found = g; break; }
  }
  if (found < 0) { reps.push(b); found = reps.length - 1; }
  groupOf.set(b, found);
}
const kills = reps.map(() => []);
for (let g1 = 0; g1 < reps.length; g1++) {
  for (let g2 = 0; g2 < reps.length; g2++) if (twMerge(`${reps[g2]} ${reps[g1]}`) === reps[g1]) kills[g1].push(g2);
}
const lines = [`G\t${reps.length}`];
kills.forEach((k, g) => lines.push(`K\t${g}\t${k.join(',')}`));
for (const b of known) lines.push(`T\t${b}\t${groupOf.get(b)}`);
for (const b of unknown) lines.push(`U\t${b}`);
fs.writeFileSync(outFile, lines.join('\n') + '\n');
console.log(`${outFile}: ${known.length} tailwind tokens in ${reps.length} groups, ${unknown.size} other tokens (from ${tokens.size} candidates)`);
