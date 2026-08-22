/**
 * Every localStorage read/write in this app goes through these — guarded
 * because storage can be unavailable or blocked (private browsing, quota,
 * disabled by the user), in which case a preference just doesn't stick
 * rather than crashing the app.
 */
export function readLocalStorage(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocalStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable/blocked — the choice just won't stick,
    // which isn't worth interrupting the user for.
  }
}
