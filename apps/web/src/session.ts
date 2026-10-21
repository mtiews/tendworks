/*
 * Where the signed-in token lives (ADR 0018): in sessionStorage, which the browser forgets
 * with the tab, or in localStorage when the operator chose to stay signed in on this device.
 * Never in a URL.
 */

const KEY = "tendworks.token";

export function storedToken(): string | undefined {
  return read(window.sessionStorage) ?? read(window.localStorage);
}

export function storeToken(token: string, { remember }: { remember: boolean }): void {
  forgetToken();
  (remember ? window.localStorage : window.sessionStorage).setItem(KEY, token);
}

export function forgetToken(): void {
  window.sessionStorage.removeItem(KEY);
  window.localStorage.removeItem(KEY);
}

function read(storage: Storage): string | undefined {
  return storage.getItem(KEY) ?? undefined;
}
