// Minimal browser globals for front-end modules under `node --test`.
const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.window === 'undefined') g.window = globalThis;
