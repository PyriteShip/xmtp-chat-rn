// In-memory stub for `react-native-mmkv` used in unit tests. Mirrors the
// subset of the v4 (Nitro) `createMMKV` API the codebase actually calls:
// `getString`, `getNumber`, `set`, `remove`. One Map per id keeps tests on different
// stores isolated within a process.

const stores = new Map();

function createMMKV({ id }) {
  if (!stores.has(id)) stores.set(id, new Map());
  const store = stores.get(id);
  return {
    getString(key) {
      const v = store.get(key);
      return typeof v === 'string' ? v : undefined;
    },
    getNumber(key) {
      const v = store.get(key);
      return typeof v === 'number' ? v : undefined;
    },
    set(key, value) {
      store.set(key, value);
    },
    remove(key) {
      store.delete(key);
    },
    getAllKeys() {
      return [...store.keys()];
    },
  };
}

// Test-only escape hatch: wipe everything between test files / cases.
// Clears each store's contents (so module-scope singletons that captured
// a `storage` handle see a clean slate) AND the stores registry. Note: we clear data BEFORE
// clearing the registry so singleton closures that hold a reference to the
// same Map also see empty state on the next read.
function __resetMMKV() {
  stores.forEach(store => store.clear());
  // Keep store mappings in the registry so subsequent __resetMMKV calls can
  // still find them (the singleton reuses the same Map via closure).
}

module.exports = { createMMKV, __resetMMKV };
