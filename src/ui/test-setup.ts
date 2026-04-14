// Polyfill localStorage for Node v25+, which adds a minimal global localStorage
// without the full Storage interface (no setItem, getItem, removeItem, clear, etc.)
if (typeof globalThis.localStorage?.setItem !== 'function') {
  const store: Record<string, string> = {};
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  };
}

// Polyfill CSS.supports for jsdom (used by @primer/react at module scope)
if (typeof globalThis.CSS === 'undefined') {
  (globalThis as Record<string, unknown>).CSS = { supports: () => false };
} else if (typeof globalThis.CSS.supports !== 'function') {
  (globalThis.CSS as Record<string, unknown>).supports = () => false;
}
