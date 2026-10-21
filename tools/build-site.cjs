// Builds the GitHub Pages site: site/index.template.html + site/benchmark.json -> site/dist/index.html.
//
// Run: node tools/build-site.cjs
//
// The benchmark numbers on the page live in site/benchmark.json only. The build fails when a number there is not in
// docs/BENCHMARK.md, so the page cannot drift from the document the numbers come from: change BENCHMARK.md first, then the JSON.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const site = path.join(root, 'site');
const data = JSON.parse(fs.readFileSync(path.join(site, 'benchmark.json'), 'utf8'));
const doc = fs.readFileSync(path.join(root, 'docs', 'BENCHMARK.md'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

// every number the page shows, as the text a document would print it
const numbers = [
  ...Object.values(data.facts),
  ...Object.values(data.mount).flatMap((platform) => platform.lanes.filter((l) => !l.label).map((l) => String(l.ms))),
  ...data.switch.lanes.map((l) => String(l.ms)),
  ...data.memory.series.flatMap((s) => [String(s.a), String(s.b)]),
];
const missing = [...new Set(numbers)].filter((n) => !doc.includes(n) && !readme.includes(n));

if (missing.length > 0) {
  console.error(`site/benchmark.json has numbers that docs/BENCHMARK.md and README.md do not: ${missing.join(', ')}`);
  process.exit(1);
}

const { memory } = data;
const worst = memory.series.reduce((a, b) => (b.b > a.b ? b : a));
const best = memory.series.filter((s) => s.us).reduce((a, b) => (b.b < a.b ? b : a));
const tokens = {
  ...data.facts,
  memoryTo: memory.to.toLocaleString('en-US'),
  memoryAria: `Memory footprint from ${memory.from.toLocaleString('en-US')} to ${memory.to.toLocaleString('en-US')} distinct classNames: ${memory.series
    .map((s) => `${s.n} ${s.a} to ${s.b} MB`)
    .join('; ')}.`,
};
const unknown = [];
let html = fs
  .readFileSync(path.join(site, 'index.template.html'), 'utf8')
  .replace('/*BENCHMARK_DATA*/null', () => JSON.stringify({ mount: data.mount, switch: data.switch, memory }))
  .replace(/\{\{(\w+)\}\}/g, (_, name) => (name in tokens ? tokens[name] : (unknown.push(name), '')));

if (unknown.length > 0) {
  console.error(`index.template.html uses tokens benchmark.json does not define: ${unknown.join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(path.join(site, 'dist'), { recursive: true });
fs.writeFileSync(path.join(site, 'dist', 'index.html'), html);
fs.writeFileSync(path.join(site, 'dist', '.nojekyll'), '');
console.log(`site/dist/index.html (${html.length} bytes; ${numbers.length} numbers checked against the docs; memory ${worst.n} ${worst.b} MB vs ${best.n} ${best.b} MB)`);
