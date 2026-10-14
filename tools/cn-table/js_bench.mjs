import fs from 'node:fs';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { cn as fast } from 'cnfast';
const { cases } = JSON.parse(fs.readFileSync('corpus.json', 'utf8'));
const ref = (args) => twMerge(clsx(args));
// correctness: cnfast vs tailwind-merge reference
let mismatch = 0; const examples = [];
for (const c of cases) {
  const a = ref(c), b = fast(...c);
  if (a !== b) { mismatch++; if (examples.length < 3) examples.push({ c, a, b }); }
}
console.log(JSON.stringify({ cases: cases.length, cnfastMismatches: mismatch, examples }));
fs.writeFileSync('expected.json', JSON.stringify(cases.map((c) => ref(c))));
// timing, cold cache (fresh process) and warm (second pass: both libs cache)
function time(label, fn) {
  const t0 = process.hrtime.bigint();
  let sink = 0;
  for (const c of cases) sink += fn(c).length;
  const ns = Number(process.hrtime.bigint() - t0);
  return { label, nsPerCall: +(ns / cases.length).toFixed(0), sink };
}
const out = [];
for (const [label, fn] of [['clsx+twMerge', (c) => ref(c)], ['cnfast', (c) => fast(...c)]]) {
  out.push({ ...time(label + ' cold', fn) });
  out.push({ ...time(label + ' warm', fn) });
}
console.table(out.map(({ label, nsPerCall }) => ({ label, nsPerCall })));
