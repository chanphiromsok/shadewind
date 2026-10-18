// Checks of register at switch (src/uniwind/atSwitch.ts, the bindHost family in src/internal.tsx, useRegistration in
// src/uniwind/useShadewindStyle.ts), run by theme-transition-js-check.cjs. The real files are compiled with TypeScript and run
// against a fake React fiber tree and a fake native module; nothing here ran in React Native (see docs/ARCHITECTURE.md section 22).
//
// The fake tree has the two things that make a fiber walk wrong in practice: React keeps two copies of every fiber (`current` and
// `alternate`, swapped by each commit) and a fiber's `return` can point at the alternate parent. The root view's ref hands out the
// alternate chain, whose copies hold stale `$sw` values and stale shadow nodes. A walk that starts from the wrong copy fails.
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Module = require('module');

module.exports = function registerAtSwitchChecks(ts, root, ok) {
  const compile = (file, stubs, mutate = (s) => s) => {
    const src = mutate(fs.readFileSync(path.join(root, file), 'utf8'));
    const out = ts.transpileModule(src, { fileName: file, compilerOptions: { module: 'commonjs', jsx: 'react', target: 'es2020' } }).outputText;
    const m = new Module(file);
    m.paths = [];
    m.require = (name) => {
      if (name in stubs) return stubs[name];
      throw new Error(`unexpected import ${name} in ${file}`);
    };
    m._compile(out.replace(/require\(/g, 'module.require('), file);
    return m.exports;
  };
  // a mutation that does not change the source tests nothing
  const replace = (from, to) => (s) => {
    assert.ok(s.includes(from), `mutant does not apply: ${from}`);
    return s.replace(from, to);
  };

  // ---- a fake React fiber tree ----
  let nextNode = 1;
  const fiber = (tag, extra = {}) => ({ tag, child: null, sibling: null, return: null, alternate: null, stateNode: null, memoizedProps: null, ...extra });
  const hostFiber = (name, sw, canonical = { name }) =>
    fiber(5, { stateNode: { node: { id: nextNode++, name }, canonical }, memoizedProps: sw ? { $sw: sw } : {} });
  const link = (parent, kids) => {
    kids.forEach((kid, i) => {
      kid.return = parent;
      kid.sibling = kids[i + 1] ?? null;
    });
    parent.child = kids[0] ?? null;
  };

  // One app root: HostRoot > wrapper view > Fn > { H1(A) > H2(B), Offscreen(hidden) > H3(A), H4 (no $sw), H5(C) }.
  // Every fiber has an alternate in the other tree with a stale `$sw` and a stale shadow node, the same `canonical`.
  const buildRoot = (themes) => {
    const { A, B, C, stale } = themes;
    const fiberRoot = { current: null };
    const make = (swOf, staleCopy) => {
      const f = {};
      const host = (name) => {
        const canonical = (shared[name] ??= { name });
        const node = fiber(5, { stateNode: { node: { id: nextNode++, name, stale: staleCopy }, canonical }, memoizedProps: swOf[name] ? { $sw: swOf[name] } : {} });
        return node;
      };
      f.root = fiber(3, { stateNode: fiberRoot });
      f.wrapper = host('wrapper');
      f.fn = fiber(0);
      f.h1 = host('h1');
      f.h2 = host('h2');
      f.offscreen = fiber(22, { memoizedProps: { mode: 'hidden' } });
      f.h3 = host('h3');
      f.h4 = host('h4');
      f.h5 = host('h5');
      link(f.root, [f.wrapper]);
      link(f.wrapper, [f.fn]);
      link(f.fn, [f.h1, f.offscreen, f.h4, f.h5]);
      link(f.h1, [f.h2]);
      link(f.offscreen, [f.h3]);
      return f;
    };
    const shared = {};
    const cur = make({ h1: A, h2: B, h3: A, h5: C }, false);
    const alt = make({ h1: stale, h2: stale, h3: stale, h5: stale, h4: stale }, true);

    for (const name of Object.keys(cur)) {
      cur[name].alternate = alt[name];
      alt[name].alternate = cur[name];
    }

    fiberRoot.current = cur.root;
    // the quirk: the current children of the wrapper point back at the alternate parent
    cur.fn.return = alt.wrapper;
    cur.h1.return = alt.fn;

    // what the wrapper's ref receives: a public instance whose handle is the ALTERNATE copy of the wrapper view
    return { fiberRoot, cur, alt, publicInstance: { __internalInstanceHandle: alt.wrapper } };
  };

  const A = { light: { backgroundColor: '#fff' }, dark: { backgroundColor: '#000' } };
  const B = { light: { color: '#000' }, dark: { color: '#fff' } };
  const C = { light: { borderColor: '#ccc' }, dark: { borderColor: '#333' } };
  const stale = { light: { backgroundColor: '#f00' }, dark: { backgroundColor: '#f00' } };
  const A2 = { light: { backgroundColor: '#eee' }, dark: { backgroundColor: '#111' } };

  // ---- the real engine and adapter files against a fake native module ----
  const makeWorld = ({ atSwitch: mutateAtSwitch, internal: mutateInternal, flagOn = true } = {}) => {
    global.__DEV__ = true;
    global.__SHADEWIND_REGISTER_AT_SWITCH__ = flagOn;

    const log = [];
    const sentProps = [];
    const native = {
      registerMany: (nodes, props, ids, themes) => {
        sentProps.push(props.slice());
        log.push(['registerMany', nodes.map((n) => n.id), ids.slice(), themes.slice()]);
      },
      unregister: (node) => log.push(['unregister', node.id]),
      setTheme: (name, strategy) => log.push(['setTheme', name, strategy]),
    };
    const internal = compile(
      'src/internal.tsx',
      {
        react: { useCallback: (f) => f, useMemo: (f) => f() },
        'react-native': { processColor: (c) => c },
        'react-native-nitro-modules': { NitroModules: { createHybridObject: () => native } },
        'react-native/Libraries/ReactNative/RendererProxy': { getNodeFromInternalInstanceHandle: (handle) => handle.stateNode.node },
      },
      mutateInternal
    );
    const appRegistry = { setWrapperComponentProvider(provider) { this.provider = provider; } };
    const atSwitch = compile(
      'src/uniwind/atSwitch.ts',
      {
        react: { createElement: (type, props, ...children) => ({ type, props, children }) },
        './native': { NativeView: 'NativeView' },
        'react-native': { AppRegistry: appRegistry },
      },
      mutateAtSwitch
    );
    const renderThemeOf = new WeakMap([[A, 'light'], [B, 'light'], [C, 'light'], [A2, 'light'], [stale, 'light']]);
    const engine = internal.ShadewindEngine;

    engine.setBeforeSwitch(() => atSwitch.bindCommitted(engine, renderThemeOf));

    // an app root as React Native renders it: the provider's component, its wrapper view's ref called with the public instance
    const mount = (tree) => {
      const Wrapper = appRegistry.provider({});
      const element = Wrapper({ children: 'app' });

      element.props.ref(tree.publicInstance);

      return { element, unmount: () => element.props.ref(null) };
    };

    return { log, sentProps, engine, atSwitch, appRegistry, renderThemeOf, mount };
  };

  const ids = (tree, ...names) => names.map((name) => tree.cur[name].stateNode.node.id);

  // the whole scenario; every assertion in it has to be able to fail, which the mutants below show
  const scenario = (options) => {
    const world = makeWorld(options);
    const { log, engine, atSwitch, mount } = world;

    assert.strictEqual(atSwitch.installRootTracking(), true);

    const tree = buildRoot({ A, B, C, stale });
    const app = mount(tree);

    // 1. first switch: the committed tree's views, in tree order, with their render theme; registerMany first, then the switch
    engine.setTheme('dark', 'hookDeferred');
    assert.deepStrictEqual(log, [
      ['registerMany', ids(tree, 'h1', 'h2', 'h3', 'h5'), [1, 2, 1, 3], ['light', 'light', 'light', 'light']],
      ['setTheme', 'dark', 'hookDeferred'],
    ]);

    // 2. a second switch binds nothing new
    log.length = 0;
    engine.setTheme('light', 'hookDeferred');
    assert.deepStrictEqual(log, [['setTheme', 'light', 'hookDeferred']]);

    // 3. a view whose styles changed is bound again, a view that lost its `$sw` is unbound
    log.length = 0;
    tree.cur.h1.memoizedProps = { $sw: A2 };
    tree.cur.h5.memoizedProps = {};
    engine.setTheme('dark', 'hookDeferred');
    // the queued rebind goes out before the unbind, as for any unregister: native sees the changes in the order they were made
    assert.deepStrictEqual(log, [
      ['registerMany', ids(tree, 'h1'), [4], ['light']],
      ['unregister', ids(tree, 'h5')[0]],
      ['setTheme', 'dark', 'hookDeferred'],
    ]);

    app.unmount();

    return world;
  };

  ok('register at switch: the walk binds the committed tree (not the alternate), once, before the switch; changes and lost $sw follow', () => {
    scenario();
  });

  // ---- mutants: each breaks one rule the scenario must hold ----
  const mutants = {
    'walks the alternate tree (root.current.alternate)': { atSwitch: replace('root.current.child', 'root.current.alternate.child') },
    'starts from the HostRoot fiber the handle reached, not FiberRoot.current': { atSwitch: replace('return node ? (node.stateNode as FiberRoot) : null;', 'return node ? ({ current: node } as FiberRoot) : null;') },
    'binds a view again at every switch (no dedupe)': { internal: replace('if (boundHosts.get(key) === native) {', 'if (false) {') },
    'never unbinds a view that lost its $sw': { atSwitch: replace('} else if (engine.isHostBound(key)) {', '} else if (false) {') },
    'drops the render theme': { atSwitch: replace('renderThemeOf.get(themed)', 'undefined') },
    'never walks before a switch': { internal: replace('if (beforeSwitch) {', 'if (false) {') },
    'sends the registrations after the switch, not before': { internal: replace('    flushRegistrations();\n\n    // no third argument', '    // (not flushed here)\n\n    // no third argument') },
    'skips a hidden subtree (Offscreen)': { atSwitch: replace('if (node.child) {', 'if (node.child && node.tag !== 22) {') },
    'forgets the sibling after a subtree': { atSwitch: replace('node = parent.sibling;', 'node = null;') },
  };

  for (const [name, mutation] of Object.entries(mutants)) {
    ok(`register at switch, mutant must fail: ${name}`, () => {
      let failure;

      try {
        scenario(mutation);
      } catch (error) {
        failure = error;
      }

      assert.ok(failure, `the mutant "${name}" passed the scenario`);
      // a mutant that crashed, or did not apply, proves nothing: the scenario's own assertion has to catch it
      assert.strictEqual(failure.code, 'ERR_ASSERTION', `the mutant "${name}" failed by crashing: ${failure.message}`);
      assert.ok(!/mutant does not apply/.test(failure.message), failure.message);
    });
  }

  ok('register at switch: two roots are both walked, an unmounted root is dropped, no root warns and binds nothing', () => {
    const world = makeWorld();
    const { log, engine, atSwitch, mount } = world;

    atSwitch.installRootTracking();

    const warn = console.warn;
    const warnings = [];

    console.warn = (...a) => warnings.push(a.join(' '));

    try {
      engine.setTheme('dark', 'hookDeferred');
      assert.strictEqual(warnings.length, 1);
      assert.deepStrictEqual(log, [['setTheme', 'dark', 'hookDeferred']]);

      const one = buildRoot({ A, B, C, stale });
      const two = buildRoot({ A, B, C, stale });
      const mountedOne = mount(one);

      mount(two);
      log.length = 0;
      engine.setTheme('light', 'hookDeferred');
      assert.deepStrictEqual(log[0][1], [...ids(one, 'h1', 'h2', 'h3', 'h5'), ...ids(two, 'h1', 'h2', 'h3', 'h5')]);

      mountedOne.unmount();
      one.cur.h2.memoizedProps = { $sw: A2 }; // would be rebound if root one were still walked
      log.length = 0;
      engine.setTheme('dark', 'hookDeferred');
      assert.deepStrictEqual(log, [['setTheme', 'dark', 'hookDeferred']]);
    } finally {
      console.warn = warn;
    }
  });

  ok('register at switch: the wrapper composes with an app provider set after it, and keeps the app inside', () => {
    const world = makeWorld();

    world.atSwitch.installRootTracking();
    world.appRegistry.setWrapperComponentProvider(() => function AppWrapper() {});

    const Wrapper = world.appRegistry.provider({});
    const element = Wrapper({ children: 'app' });

    assert.strictEqual(element.type, 'NativeView');
    assert.strictEqual(element.props.collapsable, false);
    assert.strictEqual(element.children[0].type.name, 'AppWrapper');
    assert.strictEqual(element.children[0].children[0], 'app');
  });

  ok('register at switch: a view the engine takes carries $sw, other views and a flag that is off carry nothing', () => {
    const on = makeWorld().atSwitch;

    assert.strictEqual(on.atSwitchEnabled(), true); // the flag is read once, before the next world changes it

    const off = makeWorld({ flagOn: false }).atSwitch;

    assert.deepStrictEqual(on.swProps(A), { $sw: A });
    assert.strictEqual(on.swProps(null), undefined);
    assert.strictEqual(off.swProps(A), undefined);
  });

  ok('register at switch: the walk only reads the host fibers it needs (explicit stack, no return pointers)', () => {
    const { atSwitch } = makeWorld();
    const tree = buildRoot({ A, B, C, stale });
    const seen = [];

    // every `return` pointer is wrong or missing: the walk must not depend on them
    for (const name of Object.keys(tree.cur)) tree.cur[name].return = null;

    atSwitch.walkCommitted(tree.fiberRoot, (f) => seen.push(f.stateNode.canonical.name));
    assert.deepStrictEqual(seen, ['wrapper', 'h1', 'h2', 'h3', 'h4', 'h5']);
  });

  // ---- the ref of a View or Text: nothing at mount, one rebind when the styles change ----
  const refWorld = (flagOn, mutate) => {
    const world = makeWorld({ flagOn });
    const slots = [];
    const legacy = [];
    const useShadewind = compile(
      'src/uniwind/useShadewindStyle.ts',
      {
        react: { useLayoutEffect() {}, useReducer: () => [0, () => {}], useRef: () => slots[slots.length - 1] },
        'react-native': { StyleSheet: { flatten: (s) => s } },
        './atSwitch': world.atSwitch,
        './install': { getInternals: () => ({}), installUniwind: () => ({ active: true }) },
        'uniwind-internal/core/context': { useUniwindContext: () => ({ scopedTheme: null }) },
        'shadewind/internal': {
          ShadewindEngine: { ...world.engine, register: (...a) => (legacy.push(['register', ...a]), true), unregister: (...a) => legacy.push(['unregister', ...a]), label() {} },
        },
      },
      mutate
    );
    // one view = one useRef slot, as React keeps it across that view's renders; `rendered` is the style the host gets
    const view = () => {
      const slot = { current: undefined };

      return (themed, user, rendered) => {
        slots.push(slot);

        return useShadewind.useRegistration(themed, user, undefined, rendered);
      };
    };

    return { world, view, legacy };
  };

  ok('register at switch: no ref at mount, none for the same styles, a ref only when the styles change', () => {
    const { view, legacy, world } = refWorld(true);
    const render = view();
    const user = () => {};

    assert.strictEqual(render(A, undefined, {}), undefined, 'first render: no ref, so no registration at mount');
    assert.strictEqual(render(A, undefined, {}), undefined);
    assert.strictEqual(render(A, user, {}), user, 'the user ref passes through untouched');
    assert.strictEqual(typeof render(A2, undefined, {}), 'function', 'other styles: a rebinding ref');
    assert.strictEqual(render(A2, undefined, {}), undefined, 'and not again once they are the same');
    assert.deepStrictEqual(legacy, []);
    assert.deepStrictEqual(world.log, []);
  });

  // React attaches this ref after the native commit, so a view that leaves the engine has been painted with its old styles by then
  // and unbinding would leave them: it is bound to what the render gave it, for every theme, instead.
  const refScenario = (mutate) => {
    const { view, world } = refWorld(true, mutate);
    const { log, sentProps, engine, atSwitch, mount } = world;

    atSwitch.installRootTracking();

    const tree = buildRoot({ A, B, C, stale });

    mount(tree);
    engine.setTheme('dark', 'hookDeferred'); // binds h1 (A), h2 (B), h3 (A), h5 (C)
    log.length = 0;
    sentProps.length = 0;

    const instanceOf = (name) => ({ __internalInstanceHandle: tree.cur[name] });
    const seen = [];
    const user = (node) => seen.push(node);

    // 1. other theme-dependent styles: rebound, no render theme (the next commit themes it), the user ref still told
    const render = view();

    render(A, undefined, { backgroundColor: '#fff' });
    tree.cur.h1.memoizedProps = { $sw: A2 }; // what React committed with the new styles
    render(A2, user, { backgroundColor: '#eee' })(instanceOf('h1'));
    engine.setTheme('light', 'hookDeferred');
    assert.deepStrictEqual(log.slice(0, 1).map((c) => c[0]), ['registerMany']);
    assert.deepStrictEqual(log[0][3], [undefined]);
    assert.strictEqual(seen.length, 1);

    // 2. no longer theme dependent (a static class): bound to this render's value in every theme, not unbound
    log.length = 0;
    sentProps.length = 0;
    tree.cur.h3.memoizedProps = {};

    const render3 = view();

    render3(A, undefined, { backgroundColor: '#fff' });
    render3(null, undefined, { backgroundColor: '#e11d48' })(instanceOf('h3'));
    engine.setTheme('dark', 'hookDeferred'); // flushes the rebinding; the walk then finds h3 without $sw and unbinds it
    assert.strictEqual(log[0][0], 'registerMany');
    assert.deepStrictEqual(log[0][1], ids(tree, 'h3'));
    assert.deepStrictEqual(sentProps[0][0], { light: { backgroundColor: '#e11d48' }, dark: { backgroundColor: '#e11d48' } });
    assert.deepStrictEqual(log[1], ['unregister', ids(tree, 'h3')[0]]);

    // an unset background is transparent
    log.length = 0;
    sentProps.length = 0;

    const render4 = view();

    render4(A, undefined, {});
    render4(null, undefined, {})(instanceOf('h1'));
    assert.deepStrictEqual(sentProps.length, 0, 'queued, not sent yet');
    engine.setTheme('light', 'hookDeferred');
    assert.deepStrictEqual(sentProps[0][0], { light: { backgroundColor: 'transparent' }, dark: { backgroundColor: 'transparent' } });

    // 3. a style that cannot be pinned (an unset text colour has platform defaults): unbound
    log.length = 0;

    const render2 = view();

    render2(B, undefined, {});
    render2(null, undefined, {})(instanceOf('h2'));
    assert.deepStrictEqual(log, [['unregister', ids(tree, 'h2')[0]]]);

    // 4. a host the walk never bound: nothing
    log.length = 0;

    const render5 = view();

    render5(A, undefined, {});
    render5(A2, undefined, {})(instanceOf('h4'));
    assert.deepStrictEqual(log, []);
  };

  ok('register at switch: the rebinding ref rebinds, pins a view that leaves the engine, unbinds what cannot be pinned, ignores unbound hosts', () => {
    refScenario();
  });

  const refMutants = {
    'unbinds a view that leaves the engine instead of pinning it': replace('const bind = themed ?? (before ? pinned(before, rendered) : null);', 'const bind = themed;'),
    'pins without the transparent background': replace("key === 'backgroundColor' ? 'transparent' : undefined", 'undefined'),
    'pins only the first theme': replace('for (const theme of Object.keys(before)) {\n    const pin', 'for (const theme of Object.keys(before).slice(0, 1)) {\n    const pin'),
  };

  for (const [name, mutation] of Object.entries(refMutants)) {
    ok(`register at switch, ref mutant must fail: ${name}`, () => {
      let failure;

      try {
        refScenario(mutation);
      } catch (error) {
        failure = error;
      }

      assert.ok(failure, `the mutant "${name}" passed the scenario`);
      assert.strictEqual(failure.code, 'ERR_ASSERTION', `the mutant "${name}" failed by crashing: ${failure.message}`);
      assert.ok(!/mutant does not apply/.test(failure.message), failure.message);
    });
  }

  ok('register at switch: flag off, a View keeps the engine ref that registers at mount', () => {
    const { view } = refWorld(false);
    const render = view();

    assert.strictEqual(typeof render(A, undefined, {}), 'function', 'useEngineRef');
  });

  // The walk's cost on a synthetic tree the size of the 2003-view benchmark (8,013 fibers). Node, not Hermes, not React: indicative.
  const big = (() => {
    const cells = [];
    const canonical = () => ({});
    const rootFiber = fiber(3);
    const list = fiber(0);
    const fiberRoot = { current: rootFiber };

    rootFiber.stateNode = fiberRoot;
    link(rootFiber, [list]);

    for (let i = 0; i < 1000; i++) {
      const view = hostFiber('v', A, canonical());
      const fn1 = fiber(0);
      const text = hostFiber('t', B, canonical());
      const fn2 = fiber(0);
      const raw = fiber(6);

      link(view, [fn1]);
      link(fn1, [text]);
      link(text, [fn2]);
      link(fn2, [raw]);
      cells.push(view);
    }

    link(list, cells);

    return fiberRoot;
  })();

  ok('register at switch: walk time on 1000 cells (printed, indicative only)', () => {
    const { atSwitch } = makeWorld();
    let count = 0;

    atSwitch.walkCommitted(big, () => count++);
    assert.strictEqual(count, 2000);

    const t0 = process.hrtime.bigint();

    for (let i = 0; i < 100; i++) atSwitch.walkCommitted(big, () => {});

    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 100;

    console.log(`     walk of the synthetic tree: ${ms.toFixed(3)} ms per walk (node ${process.version}, not Hermes)`);
  });
};
