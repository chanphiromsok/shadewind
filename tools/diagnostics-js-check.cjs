// Runtime check of src/diagnostics.ts: compiles the real file with TypeScript and runs it against a fake native log and console.
// Run: node tools/diagnostics-js-check.cjs   (needs `yarn install` for the typescript package)
const path = require('path');
const root = path.join(__dirname, '..');
const ts = require(path.join(root, 'node_modules', 'typescript'));
const fs = require('fs');
const Module = require('module');
const assert = require('assert');

// `available`: whether the fake native build has the recorder compiled in (a Debug build)
const setup = (dev, available = true) => {
  const state = { flags: [], queue: [], lines: [], timers: [], cleared: [] };
  const stubs = {
    './internal': {
      ShadewindEngine: {
        setDiagnostics: (f) => { state.flags.push(f); return available; },
        drainDiagnostics: () => state.queue.shift() ?? { dropped: 0, events: [] },
        labelOf: (id) => (id === 7 ? 'className: "flex-1 bg-card"' : undefined),
      },
    },
  };
  const line = (kind) => (...a) => state.lines.push([kind, a.join(' ')]);
  const src = fs.readFileSync(path.join(root, 'src', 'diagnostics.ts'), 'utf8');
  const out = ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText;
  const m = new Module('diagnostics'); m.paths = [];
  m.require = (n) => { if (n in stubs) return stubs[n]; throw new Error('unexpected import ' + n); };
  m.env = {
    __DEV__: dev,
    console: { log: line('log'), warn: line('warn'), groupCollapsed: line('group'), groupEnd: () => state.lines.push(['end', '']) },
    setInterval: (fn, ms) => { state.timers.push({ fn, ms }); return state.timers.length; },
    clearInterval: (id) => state.cleared.push(id),
  };
  const sandbox = 'const { __DEV__, console, setInterval, clearInterval } = module.env;\n';
  m._compile(sandbox + out.replace(/require\(/g, 'module.require('), 'diagnostics.js');
  return { api: m.exports, state };
};

let n = 0; const ok = (name, fn) => { fn(); n++; console.log('PASS', name); };

{
  const { api, state } = setup(true);

  ok('enable sets the flags (1 mounts, 2 unmounts, 4 updates) and starts one poll', () => {
    api.enableDiagnostics({ reportMounts: true, reportUpdates: true });
    assert.deepStrictEqual(state.flags, [5]);
    assert.strictEqual(state.timers.length, 1);
    assert.strictEqual(state.timers[0].ms, 250);
    assert.deepStrictEqual(state.lines, [['log', 'Shadewind: 🛠️ Diagnostics enabled!']]);
  });
  ok('enabling again replaces the flags without a second poll or banner', () => {
    api.enableDiagnostics({ reportMounts: true, reportUnmounts: true, reportUpdates: true });
    assert.deepStrictEqual(state.flags, [5, 7]);
    assert.strictEqual(state.timers.length, 1);
    assert.strictEqual(state.lines.length, 1);
  });
  ok('mount, unmount and unbind lines carry the live count, tag, component and label', () => {
    state.lines.length = 0;
    state.queue.push({ dropped: 0, events: [
      { kind: 'registered', live: 5, tag: 42, component: 'View', styleId: 7 },
      { kind: 'registered', live: 6, tag: 43, component: 'Paragraph', styleId: 8 },
      { kind: 'unregistered', live: 5, tag: 42, component: 'View', styleId: 7 },
      { kind: 'unbound', live: 4, tag: 43, component: 'Paragraph', styleId: 8 },
    ] });
    state.timers[0].fn();
    assert.deepStrictEqual(state.lines.map((l) => l[1]), [
      'Shadewind (5): 🟢 ShadowNodeRegistered for tag 42 (View) and className: "flex-1 bg-card"',
      'Shadewind (6): 🟢 ShadowNodeRegistered for tag 43 (Paragraph)',
      'Shadewind (5): 🟡 ShadowNodeUnregistered for tag 42',
      'Shadewind (4): 🟠 ShadowNodeUnbound for tag 43 (mounted, left to React)',
    ]);
  });
  ok('a commit is a collapsed group: header, C++ section with the views, summary', () => {
    state.lines.length = 0;
    const updates = [
      { tag: 42, component: 'View', styleId: 7, props: { backgroundColor: 0xff1c1c1e, borderColor: -2147483648 }, themeChange: true, textWithoutLayout: false },
      { tag: 43, component: 'Paragraph', styleId: 8, props: { color: -1 }, themeChange: true, textWithoutLayout: true },
      { tag: 44, component: 'View', styleId: 9, props: { opacity: 0.5, colors: [0xffff0000, 'red'] }, themeChange: false, textWithoutLayout: false },
    ];
    state.queue.push({ dropped: 0, events: [{ kind: 'commit', live: 3, theme: 'dark', themeChanged: true, reused: 2, skipped: 1, hidden: 0, ms: 1.234, updates }] });
    api.flushDiagnostics();
    assert.deepStrictEqual(state.lines, [
      ['group', "Shadewind 🌳 Performed shadow tree update for 3 nodes (theme 'dark', 1.23 ms)"],
      ['group', '🔥 C++ updates (3):'],
      ['log', 'View (42) { backgroundColor: "#1C1C1E", borderColor: "#00000080" }'],
      ['log', 'Paragraph (43) { color: "#FFFFFF" } · text without layout'],
      ['log', 'View (44) { opacity: 0.5, colors: ["#FF0000", "red"] } · React replaced its props'],
      ['end', ''],
      ['log', 'props reused from cache: 2, unchanged subtrees skipped: 1, hidden subtrees left for when they show: 0'],
      ['end', ''],
    ]);
  });
  ok('long commits list 20 views and count the rest', () => {
    state.lines.length = 0;
    const updates = Array.from({ length: 25 }, (_, i) => ({ tag: i, component: 'View', styleId: 1, props: { backgroundColor: 0xffffffff }, themeChange: false, textWithoutLayout: false }));
    state.queue.push({ dropped: 0, events: [{ kind: 'commit', live: 25, theme: 'light', themeChanged: false, reused: 0, skipped: 0, hidden: 2, ms: 0.5, updates }] });
    api.flushDiagnostics();
    assert.strictEqual(state.lines[0][1], 'Shadewind 🌳 Performed shadow tree update for 25 nodes (React replaced props of themed views, 0.50 ms)');
    assert.strictEqual(state.lines.filter((l) => l[0] === 'log' && l[1].startsWith('View (')).length, 20);
    assert.ok(state.lines.some((l) => l[1] === '// ... and 5 more nodes'));
  });
  ok('dropped events are warned about', () => {
    state.lines.length = 0;
    state.queue.push({ dropped: 12, events: [] });
    api.flushDiagnostics();
    assert.strictEqual(state.lines.length, 1);
    assert.strictEqual(state.lines[0][0], 'warn');
    assert.ok(state.lines[0][1].includes('12 diagnostic events dropped'));
  });
  ok('formatColor: unsigned (iOS) and signed (Android) ARGB give the same text', () => {
    assert.strictEqual(api.formatColor(0xff336699), '#336699');
    assert.strictEqual(api.formatColor(0xff336699 | 0), '#336699');
    assert.strictEqual(api.formatColor(0x80336699), '#33669980');
    assert.strictEqual(api.formatColor(0), '#00000000');
  });
  ok('disable stops the poll and turns native recording off', () => {
    api.disableDiagnostics();
    assert.deepStrictEqual(state.cleared, [1]);
    assert.strictEqual(state.flags[state.flags.length - 1], 0);
    const before = state.queue.length;
    state.queue.push({ dropped: 0, events: [{ kind: 'registered', live: 1, tag: 1, component: 'View', styleId: 1 }] });
    api.flushDiagnostics(); // off: nothing is read
    assert.strictEqual(state.queue.length, before + 1);
  });
  ok('all options false is the same as disable', () => {
    api.enableDiagnostics({ reportMounts: true });
    api.enableDiagnostics({});
    assert.strictEqual(state.flags[state.flags.length - 1], 0);
    assert.strictEqual(state.cleared.length, 2);
  });
}

{
  const { api, state } = setup(false);

  ok('outside __DEV__ nothing runs', () => {
    api.enableDiagnostics({ reportMounts: true, reportUnmounts: true, reportUpdates: true });
    api.flushDiagnostics();
    api.disableDiagnostics();
    assert.deepStrictEqual(state.flags, []);
    assert.deepStrictEqual(state.timers, []);
    assert.deepStrictEqual(state.lines, []);
  });
}

{
  const { api, state } = setup(true, false);

  ok('a native build without the recorder (release) warns once and starts no poll', () => {
    api.enableDiagnostics({ reportUpdates: true });
    assert.strictEqual(state.timers.length, 0);
    assert.strictEqual(state.lines.length, 1);
    assert.strictEqual(state.lines[0][0], 'warn');
    assert.ok(state.lines[0][1].includes('Debug builds only'));
  });
}

console.log(n + ' checks passed');
