// Per-view JS of a mount's registration, a model of src/internal.tsx (register, registerNative, styleIdOf) and
// src/uniwind/useShadewindStyle.ts (makeHolder, renderThemeFor), logic copied, the native module and React stubbed. Keep in step
// with them when they change. Run: <hermes build>/bin/hermes -O cpp/harness/hermes/register-path.js
var N = 2003, MOUNTS = 40;
var now = function () { return Date.now(); }; // the Hermes CLI has no performance.now(): 40 mounts are timed together

// --- shared state (internal.tsx)
var registeredWith = new WeakMap(), nativeByStyles = new WeakMap(), styleIds = new WeakMap(), nextStyleId = 1;
var pendingNodes = [], pendingProps = [], pendingIds = [], pendingThemes = [];
var attachedNodes = new WeakSet(), renderThemeOf = new WeakMap();
var flushScheduled = false;
var styleIdOf = function (n) { var id = styleIds.get(n); if (id === undefined) { id = nextStyleId++; styleIds.set(n, id); } return id; };
var getShadowNode = function (ref) { return ref.__node; };
var registerNative = function (ref, native, renderTheme) {
  if (registeredWith.get(ref) === native) return true;
  var node = getShadowNode(ref);
  if (!node) return false;
  pendingNodes.push(node); pendingProps.push(native); pendingIds.push(styleIdOf(native)); pendingThemes.push(renderTheme);
  registeredWith.set(ref, native);
  flushScheduled = true;
  return true;
};
var register = function (ref, styles, renderTheme) {
  var native = nativeByStyles.get(styles);
  if (!native) { native = styles; nativeByStyles.set(styles, native); }
  return registerNative(ref, native, renderTheme);
};
var renderThemeFor = function (node, themed) {
  if (typeof node !== 'object' || node === null || attachedNodes.has(node)) return undefined;
  attachedNodes.add(node);
  return renderThemeOf.get(themed);
};
// --- holder (useShadewindStyle.ts)
var makeHolder = function (themed, user) {
  var registered = null, attached = null;
  var holder = { themed: themed, user: user, superseded: false, ref: null };
  var ref = function (node) {
    attached = node;
    if (node) {
      if (registered && registered !== node) registered = null;
      if (register(node, themed, renderThemeFor(node, themed))) registered = node;
    }
  };
  holder.ref = Object.assign(ref, {
    pause: function () { if (registered) { registered = null; } },
    resume: function () { if (attached && !registered) registered = attached; }
  });
  return holder;
};
var makeHolderPlain = function (themed, user) {
  var registered = null;
  var holder = { themed: themed, user: user, superseded: false, ref: null };
  holder.ref = function (node) {
    if (node) {
      if (registered && registered !== node) registered = null;
      if (register(node, themed, renderThemeFor(node, themed))) registered = node;
    }
  };
  return holder;
};

var styles = [{ light: { backgroundColor: 1 }, dark: { backgroundColor: 2 } }, { light: { color: 1 }, dark: { color: 2 } }];
renderThemeOf.set(styles[0], 'light'); renderThemeOf.set(styles[1], 'light');

function run(label, mk, doRegister) {
  var results = [];
  for (var rep = 0; rep < 5; rep++) {
    var all = [];
    for (var m = 0; m < MOUNTS; m++) { var refs = new Array(N); for (var i = 0; i < N; i++) refs[i] = { __node: { tag: i } }; all.push(refs); }
    var t0 = now();
    for (var m = 0; m < MOUNTS; m++) {
      var refs = all[m];
      var holders = new Array(N);
      for (var i = 0; i < N; i++) holders[i] = mk(styles[i & 1], undefined);
      if (doRegister) for (var i = 0; i < N; i++) holders[i].ref(refs[i]);
      pendingNodes.length = 0; pendingProps.length = 0; pendingIds.length = 0; pendingThemes.length = 0;
    }
    results.push((now() - t0) / MOUNTS);
  }
  results.sort(function (a, b) { return a - b; });
  print(label + ': ' + results.map(function (r) { return r.toFixed(2); }).join(' ') + ' ms per mount of ' + N + ' (5 reps, sorted)');
}
run('holders, pause/resume on every ref (before)', makeHolder, false);
run('holders, plain ref (a view now)', makeHolderPlain, false);
run('holders + register, pause/resume on every ref (before)', makeHolder, true);
run('holders + register, plain ref (a view now)', makeHolderPlain, true);
