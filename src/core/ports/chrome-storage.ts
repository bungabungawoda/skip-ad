import type { StorageAreaLike } from "./cache/store";

/**
 * Options / Popup / Service Worker 共用的 chrome.storage.local 适配器。
 * 内容脚本因为 TRUSTED_CONTEXTS 拿不到这个区域，不要在内容脚本里用。
 */
export function chromeStorageArea(): StorageAreaLike {
  return {
    get: (keys) => chrome.storage.local.get(keys) as Promise<Record<string, unknown>>,
    set: (items) => chrome.storage.local.set(items),
    remove: (keys) => chrome.storage.local.remove(keys)
  };
}
