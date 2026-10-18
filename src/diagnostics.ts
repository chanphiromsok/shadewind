import {
  ShadewindEngine,
  type DiagnosticsEvent,
  type DiagnosticsUpdate,
} from './internal';

// `shadewind/diagnostics`: what the commit hook does, logged to the console. Development only: outside __DEV__ every function here
// does nothing. The hook records natively (cpp/Diagnostics.hpp); this module reads the record a few times a second and prints it.

export type DiagnosticsOptions = {
  /** Log every view bound to the engine: `Shadewind (5): 🟢 ShadowNodeRegistered for tag 42 (View) and className: "..."`. */
  reportMounts?: boolean;
  /**
   * Log every bound view that leaves: 🟡 when it was unmounted and released (reported at a later commit, once React Native and the
   * JS garbage collector let go of it), 🟠 when a mounted view was unbound and left to React (pressed, or its style no longer suits
   * the engine).
   */
  reportUnmounts?: boolean;
  /** Log every commit that themed views: which views, with which props. */
  reportUpdates?: boolean;
};

const MOUNTS = 1;
const UNMOUNTS = 2;
const UPDATES = 4;

const POLL_MS = 250;
/** Views listed per commit; the rest are counted. */
const LISTED = 20;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Logs what the engine does to the shadow tree. Calling it again replaces the options; all false turns diagnostics off.
 * Screens that stay mounted keep their views registered (inactive tabs, frozen screens, suspended content), so leaving a tab does
 * not lower the count.
 */
export function enableDiagnostics(options: DiagnosticsOptions = {}): void {
  if (!__DEV__) {
    return;
  }

  const flags =
    (options.reportMounts ? MOUNTS : 0) +
    (options.reportUnmounts ? UNMOUNTS : 0) +
    (options.reportUpdates ? UPDATES : 0);

  if (flags === 0) {
    disableDiagnostics();

    return;
  }

  if (!ShadewindEngine.setDiagnostics(flags)) {
    console.warn(
      'Shadewind: diagnostics are not compiled into this native build (Debug builds only: SHADEWIND_DIAGNOSTICS)'
    );

    return;
  }

  if (timer === null) {
    timer = setInterval(report, POLL_MS);
    console.log('Shadewind: 🛠️ Diagnostics enabled!');
  }
}

/** Stops logging. What was recorded and not printed yet is dropped. */
export function disableDiagnostics(): void {
  if (!__DEV__ || timer === null) {
    return;
  }

  clearInterval(timer);
  timer = null;
  ShadewindEngine.setDiagnostics(0);
}

/** Prints what was recorded since the last call (the poll does this on its own; useful right before a test assertion). */
export function flushDiagnostics(): void {
  if (__DEV__ && timer !== null) {
    report();
  }
}

function report(): void {
  const { dropped, events } = ShadewindEngine.drainDiagnostics();

  if (dropped > 0) {
    console.warn(
      `Shadewind: ⚠️ ${dropped} diagnostic events dropped (more were recorded between two reads than the native log keeps)`
    );
  }

  for (const event of events) {
    print(event);
  }
}

const describeStyle = (styleId: number) => {
  const label = ShadewindEngine.labelOf(styleId);

  return label === undefined ? '' : ` and ${label}`;
};

function print(event: DiagnosticsEvent): void {
  switch (event.kind) {
    case 'registered':
      console.log(
        `Shadewind (${event.live}): 🟢 ShadowNodeRegistered for tag ${event.tag} (${event.component})${describeStyle(event.styleId)}`
      );
      break;
    case 'unregistered':
      console.log(
        `Shadewind (${event.live}): 🟡 ShadowNodeUnregistered for tag ${event.tag}`
      );
      break;
    case 'unbound':
      console.log(
        `Shadewind (${event.live}): 🟠 ShadowNodeUnbound for tag ${event.tag} (mounted, left to React)`
      );
      break;
    case 'commit':
      printCommit(event);
      break;
  }
}

function printCommit(
  event: Extract<DiagnosticsEvent, { kind: 'commit' }>
): void {
  const cause = event.themeChanged
    ? `theme '${event.theme}'`
    : 'React replaced props of themed views';
  const open = groupOpener();

  open(
    `Shadewind 🌳 Performed shadow tree update for ${event.updates.length} nodes (${cause}, ${event.ms.toFixed(2)} ms)`
  );
  open(`🔥 C++ updates (${event.updates.length}):`);

  for (const update of event.updates.slice(0, LISTED)) {
    console.log(formatUpdate(update));
  }

  if (event.updates.length > LISTED) {
    console.log(`// ... and ${event.updates.length - LISTED} more nodes`);
  }

  closeGroup();
  console.log(
    `props reused from cache: ${event.reused}, unchanged subtrees skipped: ${event.skipped}, hidden subtrees left for when they show: ${event.hidden}`
  );
  closeGroup();
}

export function formatUpdate(update: DiagnosticsUpdate): string {
  const props = Object.entries(update.props)
    .map(([key, value]) => `${key}: ${formatValue(key, value)}`)
    .join(', ');
  const notes = [
    update.themeChange ? null : 'React replaced its props',
    update.textWithoutLayout ? 'text without layout' : null,
  ].filter(Boolean);

  return `${update.component} (${update.tag}) { ${props} }${notes.length > 0 ? ` · ${notes.join(', ')}` : ''}`;
}

const isColorKey = (key: string) => /colou?rs?$/i.test(key);

/** ARGB as processColor makes it (unsigned on iOS, signed on Android) -> `#RRGGBB`, or `#RRGGBBAA` when not opaque. */
export function formatColor(value: number): string {
  const argb = value < 0 ? value + 2 ** 32 : value;
  const alpha = Math.floor(argb / 2 ** 24);
  const rgb = (argb % 2 ** 24).toString(16).padStart(6, '0');

  return `#${rgb}${alpha === 0xff ? '' : alpha.toString(16).padStart(2, '0')}`.toUpperCase();
}

function formatValue(key: string, value: unknown): string {
  if (isColorKey(key)) {
    if (typeof value === 'number') {
      return `"${formatColor(value)}"`;
    }

    if (Array.isArray(value)) {
      return `[${value.map((item) => (typeof item === 'number' ? `"${formatColor(item)}"` : JSON.stringify(item))).join(', ')}]`;
    }
  }

  return JSON.stringify(value);
}

// console.groupCollapsed where the console has it (Chrome DevTools, React Native DevTools); plain lines elsewhere
const groupOpener = (): ((title: string) => void) =>
  typeof console.groupCollapsed === 'function'
    ? (title) => console.groupCollapsed(title)
    : (title) => console.log(title);

const closeGroup = () => {
  if (typeof console.groupEnd === 'function') {
    console.groupEnd();
  }
};
