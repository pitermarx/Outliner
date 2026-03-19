import { AppCrypto } from './crypto.js';

// --- STORAGE MODULE ---
export const storage = {
  // Initialize storage - check/create salt
  init: () => {
    if (!localStorage.getItem('vmd_salt')) {
      localStorage.setItem('vmd_salt', AppCrypto.generateSalt());
    }
  },

  // Get the persistent salt
  getSalt: () => localStorage.getItem('vmd_salt'),
  setSalt: (salt) => localStorage.setItem('vmd_salt', salt),

  // Plain read/write helpers for non-document values.
  getRaw: (key) => localStorage.getItem(key),
  setRaw: (key, value) => localStorage.setItem(key, value),
  hasRaw: (key) => localStorage.getItem(key) !== null,

  // Encrypt and store value
  set: async (key, value, cryptoKey) => {
    const encrypted = await AppCrypto.encrypt(JSON.stringify(value), cryptoKey);
    localStorage.setItem(key, encrypted);
  },

  // Retrieve and decrypt value
  get: async (key, cryptoKey) => {
    const item = localStorage.getItem(key);
    if (!item) return null;
    try {
      const decrypted = await AppCrypto.decrypt(item, cryptoKey);
      return JSON.parse(decrypted);
    } catch (e) {
      console.error(`Failed to read ${key}:`, e);
      return null;
    }
  },

  remove: (key) => localStorage.removeItem(key),
};
