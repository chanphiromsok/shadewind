// Initial load: performance.now() at the first time the feed's content was measured (JS runtime start is about 0).
const perf = () => (globalThis as unknown as { performance: { now(): number } }).performance.now();

export const startup: { firstLayoutMs: number | string } = { firstLayoutMs: 'n/a' };

export const markFirstLayout = () => {
  if (typeof startup.firstLayoutMs !== 'number') {
    startup.firstLayoutMs = Math.round(perf());
  }
};
