/**
 * src/store/secureKey.js — SPEC §3.13 API Key 本地存储
 *
 * 规则（AGENTS.md 不可违背约束 2 + SPEC §3.13）：
 * - 原生（iOS/Android）→ `expo-secure-store`（Keystore / Keychain）。
 * - web → `expo-secure-store` 在 web 上是空实现（ExpoSecureStore.web.js 导出 `{}`，
 *   `isAvailableAsync()` 恒为 false，直接调用会 TypeError），因此**优雅降级**到 AsyncStorage，
 *   并通过返回值 `secure: false` 让界面显式提示「明文存储」风险。
 * - 绝不打印、绝不写日志、绝不进验证报告。
 */

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

/** AsyncStorage / SecureStore 共用的键名 */
export const KEY_STORAGE = 'od.apikey.v1';
/** v1.5：多模态端点（describe 与纠正用）的 Key 单独一个键，与决策模型的 Key 互不影响 */
export const VISION_KEY_STORAGE = 'od.visionkey.v1';

/** SPEC §3.12 · 中转口令的存储键（独立槽位，敏感度与 apiKey 同级）。 */
export const RELAY_TOKEN_STORAGE = 'od.relaytoken.v1';

const IS_WEB = Platform.OS === 'web';

/** SecureStore 是否真的可用（web 恒 false；原生也做一次探测，失败不抛错） */
export async function isSecureStorageAvailable() {
  if (IS_WEB) return false;
  try {
    if (SecureStore && typeof SecureStore.isAvailableAsync === 'function') {
      return !!(await SecureStore.isAvailableAsync());
    }
    return false;
  } catch {
    return false;
  }
}

function normalize(key) {
  return typeof key === 'string' ? key.trim() : '';
}

/**
 * 保存 API Key（空串 = 删除）→ Promise<{key, secure}>。
 * `secure === false` 表示降级为明文存储，界面必须提示用户。
 */
export async function saveApiKey(key) {
  const value = normalize(key);

  if (await isSecureStorageAvailable()) {
    try {
      if (value) await SecureStore.setItemAsync(KEY_STORAGE, value);
      else await SecureStore.deleteItemAsync(KEY_STORAGE);
      // 成功走安全存储：顺手清掉可能存在的降级残留，避免两份数据不一致
      await AsyncStorage.removeItem(KEY_STORAGE).catch(() => {});
      return { key: value, secure: true };
    } catch {
      // 安全存储写失败（模拟器/权限异常）→ 降级
    }
  }

  if (value) await AsyncStorage.setItem(KEY_STORAGE, value);
  else await AsyncStorage.removeItem(KEY_STORAGE);
  return { key: value, secure: false };
}

/** 读取 API Key → Promise<{key, secure}>；无 key 时返回 `{key:'', secure:<当前存储是否安全>}` */
export async function loadApiKey() {
  if (await isSecureStorageAvailable()) {
    try {
      const key = await SecureStore.getItemAsync(KEY_STORAGE);
      if (typeof key === 'string' && key) return { key, secure: true };
    } catch {
      // 读失败 → 继续尝试降级存储
    }
  }
  try {
    const key = await AsyncStorage.getItem(KEY_STORAGE);
    return { key: typeof key === 'string' ? key : '', secure: false };
  } catch {
    return { key: '', secure: false };
  }
}

/** 清除 API Key（两处都清）→ Promise<void> */
export async function clearApiKey() {
  await clearStoredKey(KEY_STORAGE);
}

/* ── v1.5：多模态端点的 Key（与决策模型的 Key 分开存） ───────────────── */

/** 保存多模态 Key → Promise<{key, secure}>；语义与 saveApiKey 完全一致。 */
export async function saveVisionKey(key) {
  return saveStoredKey(VISION_KEY_STORAGE, key);
}

/** 读取多模态 Key → Promise<{key, secure}>。 */
export async function loadVisionKey() {
  return loadStoredKey(VISION_KEY_STORAGE);
}

/** 清除多模态 Key → Promise<void>。 */
export async function clearVisionKey() {
  await clearStoredKey(VISION_KEY_STORAGE);
}

/* ── v1.7 §3.12：中转口令（与两把上游 Key 分开存，语义相同） ─────────────── */

/**
 * 保存中转口令 → Promise<{key, secure}>。
 *
 * 为什么要独立一个槽位：中转口令泄漏等于**我们的上游额度被白嫖**，
 * 它的敏感度与 apiKey 同级，必须同样进钥匙串，不能混进普通配置对象里。
 */
export async function saveRelayToken(token) {
  return saveStoredKey(RELAY_TOKEN_STORAGE, token);
}

/** 读取中转口令 → Promise<{key, secure}>。 */
export async function loadRelayToken() {
  return loadStoredKey(RELAY_TOKEN_STORAGE);
}

/** 清除中转口令 → Promise<void>。 */
export async function clearRelayToken() {
  await clearStoredKey(RELAY_TOKEN_STORAGE);
}

/** 通用：安全存储可用就写钥匙串，否则降级 AsyncStorage 明文。 */
async function saveStoredKey(storageKey, key) {  const value = normalize(key);
  if (await isSecureStorageAvailable()) {
    try {
      if (value) await SecureStore.setItemAsync(storageKey, value);
      else await SecureStore.deleteItemAsync(storageKey);
      await AsyncStorage.removeItem(storageKey).catch(() => {});
      return { key: value, secure: true };
    } catch {
      // 安全存储写失败 → 降级
    }
  }
  if (value) await AsyncStorage.setItem(storageKey, value);
  else await AsyncStorage.removeItem(storageKey);
  return { key: value, secure: false };
}

async function loadStoredKey(storageKey) {
  if (await isSecureStorageAvailable()) {
    try {
      const key = await SecureStore.getItemAsync(storageKey);
      if (typeof key === 'string' && key) return { key, secure: true };
    } catch {
      // 读失败 → 尝试降级存储
    }
  }
  try {
    const key = await AsyncStorage.getItem(storageKey);
    return { key: typeof key === 'string' ? key : '', secure: false };
  } catch {
    return { key: '', secure: false };
  }
}

async function clearStoredKey(storageKey) {
  try {
    if (!IS_WEB && SecureStore && typeof SecureStore.deleteItemAsync === 'function') {
      await SecureStore.deleteItemAsync(storageKey);
    }
  } catch {
    // 忽略：安全存储不可用时无需清除
  }
  try {
    await AsyncStorage.removeItem(storageKey);
  } catch {
    // 忽略：本来就没有
  }
}

export default {
  KEY_STORAGE,
  VISION_KEY_STORAGE,
  saveApiKey,
  loadApiKey,
  clearApiKey,
  saveVisionKey,
  loadVisionKey,
  clearVisionKey,
  isSecureStorageAvailable,
};
