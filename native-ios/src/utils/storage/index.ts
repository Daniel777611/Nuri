// Native storage (Metro picks index.web.ts on web).
// Helpers never throw: reads return `fallback`, writes return `false`.
// Values supported: string | number | boolean | null (JSON-serialized on disk).
// Usage: import { storage } from "@/src/utils/storage"; await storage.getItem(key, fallback);

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

import { AssertNoExtras, StorageBase, StorageItemValue } from "./storage-base";

// The standalone Native Lab deliberately starts with a fresh session. Never
// read, migrate, or delete the original app's unprefixed keys/default service.
export const NATIVE_STORAGE_NAMESPACE = "com.ordashtech.nuri.nativelab.v1.";
export const NATIVE_SECURE_STORAGE_OPTIONS: SecureStore.SecureStoreOptions = Object.freeze({
  keychainService: "com.ordashtech.nuri.nativelab.credentials.v1",
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  // Do not request a shared accessGroup. Use the lab app's private signed group.
});

function nativeStorageKey(key: string) {
  return NATIVE_STORAGE_NAMESPACE + key;
}

export class Storage extends StorageBase {
  // General KV — backed by AsyncStorage, with native-lab-only keys.
  async getItem<Fallback extends StorageItemValue>(
    key: string,
    fallback: Fallback,
  ): Promise<Fallback | null> {
    try {
      const raw = await AsyncStorage.getItem(nativeStorageKey(key));
      return this.retrieve(raw, fallback);
    } catch (e) {
      this.warn("getItem", key, e);
      return fallback;
    }
  }

  async setItem<Value extends StorageItemValue>(
    key: string,
    value: Value,
  ): Promise<boolean> {
    try {
      await AsyncStorage.setItem(nativeStorageKey(key), JSON.stringify(value));
      return true;
    } catch (e) {
      this.warn("setItem", key, e);
      return false;
    }
  }

  async removeItem(key: string): Promise<boolean> {
    try {
      await AsyncStorage.removeItem(nativeStorageKey(key));
      return true;
    } catch (e) {
      this.warn("removeItem", key, e);
      return false;
    }
  }

  // Sensitive values — Keychain (iOS) / EncryptedSharedPreferences (Android).
  async secureGet<Fallback extends StorageItemValue>(
    key: string,
    fallback: Fallback,
  ): Promise<Fallback | null> {
    try {
      const raw = await SecureStore.getItemAsync(nativeStorageKey(key), NATIVE_SECURE_STORAGE_OPTIONS);
      return this.retrieve(raw, fallback);
    } catch (e) {
      this.warn("secureGet", key, e);
      return fallback;
    }
  }

  async secureSet<Value extends StorageItemValue>(
    key: string,
    value: Value,
  ): Promise<boolean> {
    try {
      await SecureStore.setItemAsync(nativeStorageKey(key), JSON.stringify(value), NATIVE_SECURE_STORAGE_OPTIONS);
      return true;
    } catch (e) {
      this.warn("secureSet", key, e);
      return false;
    }
  }

  async secureRemove(key: string): Promise<boolean> {
    try {
      await SecureStore.deleteItemAsync(nativeStorageKey(key), NATIVE_SECURE_STORAGE_OPTIONS);
      return true;
    } catch (e) {
      this.warn("secureRemove", key, e);
      return false;
    }
  }
}

export const storage = new Storage();

// Compile-time guard: any new method must be declared in storage-base.ts first.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional compile-time-only assertion
type _NoExtras = AssertNoExtras<Exclude<keyof Storage, keyof StorageBase>>;
