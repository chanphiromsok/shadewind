// Initial load: performance.now() at the first time the feed's content was measured (JS runtime start is about 0).
const perf = () => (globalThis as unknown as { performance: { now(): number } }).performance.now();

// taken when this module is first evaluated (index.js imports it first): relative to the start of the app's JS
const t0 = perf();

export const startup: { firstLayoutMs: number | string } = { firstLayoutMs: 'n/a' };

export const markFirstLayout = () => {
  if (typeof startup.firstLayoutMs !== 'number') {
    startup.firstLayoutMs = Math.round(perf() - t0);
  }
};
