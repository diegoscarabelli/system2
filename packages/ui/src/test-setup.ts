// Polyfill CSS.supports for jsdom (used by @primer/react at module scope)
if (typeof globalThis.CSS === 'undefined') {
  (globalThis as Record<string, unknown>).CSS = { supports: () => false };
} else if (typeof globalThis.CSS.supports !== 'function') {
  (globalThis.CSS as Record<string, unknown>).supports = () => false;
}
