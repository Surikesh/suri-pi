// Modern windows keep independent local safety buffers. Legacy preferences and
// original keys remain available for one-time migration, never erased on upgrade.
const scoped = (key: string) =>
  /^suri\.(draft\.|attachments\.|scroll\.|disclosure\.|outbox\.|restored\.|selected$)/.test(
    key,
  );
const modernKey = (key: string) =>
  window.suriUpdate ? `suri.window.${window.suriUpdate.client}.${key}` : key;
export const viewStorage = {
  keys() {
    const keys = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index),
    ).filter((key): key is string => key !== null);
    if (!window.suriUpdate) return keys;
    const prefix = `suri.window.${window.suriUpdate.client}.`;
    return keys
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  },
  getItem(key: string) {
    if (!scoped(key) || !window.suriUpdate) return localStorage.getItem(key);
    const own = localStorage.getItem(modernKey(key));
    if (own !== null) return own;
    if (key.startsWith("suri.outbox.")) return null;
    const inherited = localStorage.getItem(key);
    if (inherited !== null) localStorage.setItem(modernKey(key), inherited);
    return inherited;
  },
  setItem(key: string, value: string) {
    localStorage.setItem(scoped(key) ? modernKey(key) : key, value);
  },
  removeItem(key: string) {
    localStorage.removeItem(scoped(key) ? modernKey(key) : key);
  },
};
