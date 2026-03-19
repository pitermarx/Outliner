import { state } from './state.js';
import { storage } from './storage.js';
import { AppCrypto } from './crypto.js';

const SUPABASE_CONFIG_KEY = 'supabaseconfig';
const SYNC_BASE_KEY = 'vmd_sync_base';
const DEFAULT_SUPABASE_CONFIG = {
  url: 'https://gcpdascpdrakecpknrtt.supabase.co',
  key: 'sb_publishable_9Uxo-0GD-21K6mUPQ2FSuw_mDO06TJc'
};
const MERGE_FIELDS = ['text', 'description', 'collapsed', 'parentId', 'childIds'];

function normalizeChildIds(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((id) => typeof id === 'string');
}

function indexDocument(doc) {
  const index = new Map();

  const walk = (node, parentId) => {
    const childIds = normalizeChildIds((node.children || []).map((child) => child.id));
    index.set(node.id, {
      id: node.id,
      text: node.text || '',
      description: typeof node.description === 'string' ? node.description : '',
      collapsed: !!node.collapsed,
      parentId,
      childIds,
      updatedAt: node.updated_at || null
    });

    for (const child of node.children || []) {
      walk(child, node.id);
    }
  };

  walk(doc, null);
  return index;
}

function fieldValue(entry, field) {
  if (!entry) return null;
  if (field === 'childIds') return normalizeChildIds(entry.childIds);
  if (field === 'description') return entry.description || '';
  return entry[field] ?? null;
}

function isFieldChanged(baseEntry, sideEntry, field) {
  if (!baseEntry && !sideEntry) return false;
  if (!baseEntry || !sideEntry) return true;

  const baseValue = fieldValue(baseEntry, field);
  const sideValue = fieldValue(sideEntry, field);

  if (field === 'childIds') {
    if (baseValue.length !== sideValue.length) return true;
    return baseValue.some((id, idx) => id !== sideValue[idx]);
  }

  return baseValue !== sideValue;
}

function valuesEqual(field, leftEntry, rightEntry) {
  const left = fieldValue(leftEntry, field);
  const right = fieldValue(rightEntry, field);

  if (field === 'childIds') {
    if (left.length !== right.length) return false;
    return left.every((id, idx) => id === right[idx]);
  }

  return left === right;
}

function serializeConflictSide(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    text: entry.text || '',
    description: entry.description || '',
    collapsed: !!entry.collapsed,
    parentId: entry.parentId || null,
    childIds: normalizeChildIds(entry.childIds)
  };
}

function createDefaultRootEntry() {
  return {
    id: 'root',
    text: 'My Notes',
    description: '',
    collapsed: false,
    parentId: null,
    childIds: [],
    updatedAt: new Date().toISOString()
  };
}

function buildDocFromEntryMap(entriesMap) {
  const entries = new Map(entriesMap);
  if (!entries.has('root')) {
    entries.set('root', createDefaultRootEntry());
  }

  const nodes = new Map();
  for (const [id, entry] of entries.entries()) {
    const node = {
      id,
      text: entry.text || '',
      children: [],
      collapsed: !!entry.collapsed,
      updated_at: entry.updatedAt || new Date().toISOString()
    };
    if (entry.description) {
      node.description = entry.description;
    }
    nodes.set(id, node);
  }

  const parentById = new Map();
  for (const [id, entry] of entries.entries()) {
    if (id === 'root') continue;
    let parentId = entry.parentId;
    if (!parentId || !entries.has(parentId) || parentId === id) {
      parentId = 'root';
    }
    parentById.set(id, parentId);
  }

  // Break cycles by redirecting problematic links to root.
  const seenCycle = new Set();
  const hasCycle = (startId) => {
    const visited = new Set([startId]);
    let cursor = parentById.get(startId);
    while (cursor && cursor !== 'root') {
      if (visited.has(cursor)) return true;
      visited.add(cursor);
      cursor = parentById.get(cursor);
    }
    return false;
  };

  for (const id of parentById.keys()) {
    if (hasCycle(id)) {
      parentById.set(id, 'root');
      seenCycle.add(id);
    }
  }

  const childrenByParent = new Map();
  for (const [id, parentId] of parentById.entries()) {
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(id);
  }

  for (const [parentId, childIds] of childrenByParent.entries()) {
    const parentEntry = entries.get(parentId);
    const preferredOrder = new Map();
    for (const [idx, childId] of normalizeChildIds(parentEntry?.childIds).entries()) {
      preferredOrder.set(childId, idx);
    }

    childIds.sort((a, b) => {
      const ai = preferredOrder.has(a) ? preferredOrder.get(a) : Number.MAX_SAFE_INTEGER;
      const bi = preferredOrder.has(b) ? preferredOrder.get(b) : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.localeCompare(b);
    });

    const parentNode = nodes.get(parentId);
    if (!parentNode) continue;
    parentNode.children = childIds.map((childId) => nodes.get(childId)).filter(Boolean);
  }

  const rootNode = nodes.get('root') || {
    id: 'root',
    text: 'My Notes',
    children: []
  };
  rootNode.updated_at = new Date().toISOString();

  if (seenCycle.size > 0) {
    console.warn(`Merge normalization detected cycles on ${seenCycle.size} node(s); redirected to root.`);
  }

  return rootNode;
}

function getSupabaseConfig() {
  const raw = localStorage.getItem(SUPABASE_CONFIG_KEY);

  if (!raw) {
    localStorage.setItem(SUPABASE_CONFIG_KEY, JSON.stringify(DEFAULT_SUPABASE_CONFIG));
    return DEFAULT_SUPABASE_CONFIG;
  }

  try {
    const parsed = JSON.parse(raw);
    const url = parsed.url || parsed.supabaseUrl;
    const key = parsed.key || parsed.supabaseAnonKey;
    if (!url || !key) throw new Error('Invalid config format');
    return { url, key };
  } catch (error) {
    console.warn('Failed to parse Supabase config, resetting to default', error);
    localStorage.setItem(SUPABASE_CONFIG_KEY, JSON.stringify(DEFAULT_SUPABASE_CONFIG));
    return DEFAULT_SUPABASE_CONFIG;
  }
}

async function saveSyncBase(doc, key) {
  if (!doc || !key) return;
  try {
    await storage.set(SYNC_BASE_KEY, doc, key);
  } catch (error) {
    console.warn('Failed to persist sync base', error);
  }
}

// --- SYNC MODULE ---
export const AppSync = {
  client: null,
  conflictCallback: null,
  _pollInterval: null,
  _polling: false,
  _lastServerUpdatedAt: null,
  _uploadTimer: null,

  init: () => {
    try {
      if (!window.supabase) {
        console.error('Supabase library not loaded');
        state.syncConfigured.value = false;
        return;
      }

      const config = getSupabaseConfig();
      AppSync.client = window.supabase.createClient(config.url, config.key);
      state.syncConfigured.value = true;
      console.log('Supabase initialized');
    } catch (e) {
      state.syncConfigured.value = false;
      console.error('Failed to init Supabase', e);
    }
  },

  signIn: async (email, password) => {
    if (!AppSync.client) throw new Error('Sync not configured');
    const { data, error } = await AppSync.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  signUp: async (email, password) => {
    if (!AppSync.client) throw new Error('Sync not configured');
    const { data, error } = await AppSync.client.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  },

  signOut: async () => {
    AppSync.stopPolling();
    if (!AppSync.client) return;
    console.log('[sync] signing out');
    await AppSync.client.auth.signOut();
  },

  getUser: async () => {
    if (!AppSync.client) return null;
    const { data: { user } } = await AppSync.client.auth.getUser();
    return user;
  },

  refreshSession: async () => {
    if (!AppSync.client) {
      state.syncConfigured.value = false;
      state.user.value = null;
      state.syncStatus.value = 'offline';
      return null;
    }

    state.syncConfigured.value = true;
    const user = await AppSync.getUser();
    state.user.value = user;
    state.syncStatus.value = user ? 'synced' : 'offline';
    return user;
  },

  attemptFieldLevelMerge: (baseDoc, localDoc, serverDoc) => {
    if (!baseDoc || !localDoc || !serverDoc) return null;

    const baseMap = indexDocument(baseDoc);
    const localMap = indexDocument(localDoc);
    const serverMap = indexDocument(serverDoc);

    const allIds = new Set([...baseMap.keys(), ...localMap.keys(), ...serverMap.keys()]);
    const mergedEntries = new Map();
    const unresolved = [];
    let autoMergedFields = 0;

    const setEntry = (id, entry) => {
      if (!entry) {
        mergedEntries.delete(id);
        return;
      }
      mergedEntries.set(id, {
        id,
        text: entry.text || '',
        description: entry.description || '',
        collapsed: !!entry.collapsed,
        parentId: entry.parentId || null,
        childIds: normalizeChildIds(entry.childIds),
        updatedAt: entry.updatedAt || new Date().toISOString()
      });
    };

    for (const id of allIds) {
      const baseEntry = baseMap.get(id) || null;
      const localEntry = localMap.get(id) || null;
      const serverEntry = serverMap.get(id) || null;

      if (id === 'root' && !localEntry && !serverEntry) {
        setEntry('root', baseEntry || createDefaultRootEntry());
        continue;
      }

      if (!baseEntry) {
        if (localEntry && !serverEntry) {
          setEntry(id, localEntry);
          autoMergedFields += MERGE_FIELDS.length;
        } else if (!localEntry && serverEntry) {
          setEntry(id, serverEntry);
          autoMergedFields += MERGE_FIELDS.length;
        } else if (localEntry && serverEntry) {
          const equivalent = MERGE_FIELDS.every((field) => valuesEqual(field, localEntry, serverEntry));
          if (equivalent) {
            setEntry(id, localEntry);
            autoMergedFields += MERGE_FIELDS.length;
          } else {
            unresolved.push({
              id,
              type: 'new_node_collision',
              fields: [...MERGE_FIELDS],
              local: serializeConflictSide(localEntry),
              server: serializeConflictSide(serverEntry)
            });
            setEntry(id, localEntry);
          }
        }
        continue;
      }

      if (!localEntry && !serverEntry) {
        continue;
      }

      if (!localEntry || !serverEntry) {
        const existingEntry = localEntry || serverEntry;
        const isModified = MERGE_FIELDS.some((field) => isFieldChanged(baseEntry, existingEntry, field));
        if (!isModified) {
          // Deleted on one side, unchanged on the other -> delete wins.
          mergedEntries.delete(id);
          autoMergedFields += MERGE_FIELDS.length;
        } else {
          unresolved.push({
            id,
            type: 'delete_vs_modify',
            fields: ['presence'],
            local: serializeConflictSide(localEntry),
            server: serializeConflictSide(serverEntry)
          });
          if (localEntry) {
            setEntry(id, localEntry);
          } else {
            mergedEntries.delete(id);
          }
        }
        continue;
      }

      const merged = {
        id,
        text: baseEntry.text || '',
        description: baseEntry.description || '',
        collapsed: !!baseEntry.collapsed,
        parentId: baseEntry.parentId || null,
        childIds: normalizeChildIds(baseEntry.childIds),
        updatedAt: localEntry.updatedAt || serverEntry.updatedAt || baseEntry.updatedAt || new Date().toISOString()
      };

      const conflictingFields = [];

      for (const field of MERGE_FIELDS) {
        const localChanged = isFieldChanged(baseEntry, localEntry, field);
        const serverChanged = isFieldChanged(baseEntry, serverEntry, field);

        if (localChanged && serverChanged) {
          if (valuesEqual(field, localEntry, serverEntry)) {
            merged[field] = fieldValue(localEntry, field);
            autoMergedFields++;
          } else {
            conflictingFields.push(field);
          }
        } else if (localChanged) {
          merged[field] = fieldValue(localEntry, field);
          autoMergedFields++;
        } else if (serverChanged) {
          merged[field] = fieldValue(serverEntry, field);
          autoMergedFields++;
        } else {
          merged[field] = fieldValue(baseEntry, field);
        }
      }

      setEntry(id, merged);

      if (conflictingFields.length > 0) {
        unresolved.push({
          id,
          type: 'field_collision',
          fields: conflictingFields,
          local: serializeConflictSide(localEntry),
          server: serializeConflictSide(serverEntry)
        });
      }
    }

    if (!mergedEntries.has('root')) {
      mergedEntries.set('root', createDefaultRootEntry());
    }

    return {
      mergedEntries,
      unresolved,
      autoMergedFields
    };
  },

  finalizeMergeAttempt: (attempt, choices = {}) => {
    if (!attempt || !attempt.mergedEntries) return null;

    const finalEntries = new Map(attempt.mergedEntries);

    for (const conflict of attempt.unresolved || []) {
      const choice = choices[conflict.id] === 'server' ? 'server' : 'local';
      const chosen = choice === 'server' ? conflict.server : conflict.local;

      if (conflict.type === 'delete_vs_modify' || conflict.type === 'new_node_collision') {
        if (!chosen) {
          finalEntries.delete(conflict.id);
        } else {
          finalEntries.set(conflict.id, {
            id: chosen.id,
            text: chosen.text || '',
            description: chosen.description || '',
            collapsed: !!chosen.collapsed,
            parentId: chosen.parentId || null,
            childIds: normalizeChildIds(chosen.childIds),
            updatedAt: new Date().toISOString()
          });
        }
        continue;
      }

      const current = finalEntries.get(conflict.id) || {
        id: conflict.id,
        text: '',
        description: '',
        collapsed: false,
        parentId: 'root',
        childIds: [],
        updatedAt: new Date().toISOString()
      };

      for (const field of conflict.fields || []) {
        if (!chosen || chosen[field] === undefined) continue;
        current[field] = field === 'childIds' ? normalizeChildIds(chosen[field]) : chosen[field];
      }
      current.updatedAt = new Date().toISOString();
      finalEntries.set(conflict.id, current);
    }

    return buildDocFromEntryMap(finalEntries);
  },

  syncAfterUnlock: async (localDoc, localKey) => {
    console.log('[sync] syncAfterUnlock called');
    if (!AppSync.client) {
      state.user.value = null;
      state.syncStatus.value = 'offline';
      return { success: true, action: 'none' };
    }

    const user = await AppSync.getUser();
    state.user.value = user;

    if (!user) {
      state.syncStatus.value = 'offline';
      return { success: true, action: 'none' };
    }

    if (!localDoc || !localKey) {
      state.syncStatus.value = 'synced';
      AppSync.startPolling();
      return { success: true, action: 'none' };
    }

    state.syncStatus.value = 'syncing';
    const result = await AppSync.checkAndSync(localDoc, localKey);
    console.log('[sync] syncAfterUnlock result:', result.action);

    if (!result.success) {
      if (result.action === 'conflict_pending') {
        state.syncStatus.value = 'error';
      } else {
        state.syncStatus.value = navigator.onLine ? 'error' : 'offline';
      }
      return result;
    }

    if (result.data) {
      state.doc.value = result.data;
      await storage.set('vmd_data', result.data, localKey);
    }

    state.syncStatus.value = 'synced';
    AppSync.startPolling();
    return result;
  },

  // Compare local vs server timestamps and handle conflicts.
  checkAndSync: async (localDoc, localKey) => {
    if (!AppSync.client) return { success: true, action: 'none' };

    console.log('[sync] checkAndSync: local updated_at:', localDoc?.updated_at || '(none)');

    try {
      // Lightweight probe first — avoids decrypting the full document when nothing changed.
      const serverTs = await AppSync.fetchServerTimestamp();

      if (!serverTs) {
        console.log('[sync] checkAndSync: no server data, uploading local');
        const encryptedData = await AppCrypto.encrypt(JSON.stringify(localDoc), localKey);
        await AppSync.upload(encryptedData, storage.getSalt());
        await saveSyncBase(localDoc, localKey);
        return { success: true, action: 'uploaded_local' };
      }

      AppSync._lastServerUpdatedAt = serverTs;

      const serverTimestamp = new Date(serverTs);
      const localTimestamp = new Date(localDoc.updated_at || Date.now());

      console.log('[sync] checkAndSync: local=', localTimestamp.toISOString(), 'server=', serverTimestamp.toISOString());

      if (localTimestamp > serverTimestamp) {
        console.log('[sync] checkAndSync: local is newer, uploading');
        const encryptedData = await AppCrypto.encrypt(JSON.stringify(localDoc), localKey);
        await AppSync.upload(encryptedData, storage.getSalt());
        await saveSyncBase(localDoc, localKey);
        return { success: true, action: 'uploaded_local' };
      }

      if (serverTimestamp <= localTimestamp) {
        // Timestamps are equal, no action needed.
        console.log('[sync] checkAndSync: timestamps equal, no action needed');
        return { success: true, action: 'none' };
      }

      // Server is newer — fetch the full document for merging.
      console.log('[sync] checkAndSync: server is newer, fetching full document for merge');
      const serverData = await AppSync.download();
      if (!serverData) return { success: true, action: 'none' };

      const serverDoc = JSON.parse(await AppCrypto.decrypt(serverData.data, localKey));
      const baseDoc = await storage.get(SYNC_BASE_KEY, localKey);
      const mergeAttempt = AppSync.attemptFieldLevelMerge(baseDoc, localDoc, serverDoc);

      if (mergeAttempt) {
        console.log('[sync] checkAndSync: merge attempt — unresolved:', mergeAttempt.unresolved.length, 'auto-merged fields:', mergeAttempt.autoMergedFields);
        if ((mergeAttempt.unresolved || []).length === 0) {
          const mergedDoc = AppSync.finalizeMergeAttempt(mergeAttempt, {});
          if (mergedDoc) {
            console.log('[sync] checkAndSync: auto-merge successful');
            // Stamp the merged doc with the upload timestamp so
            // state.doc.updated_at always matches _lastServerUpdatedAt,
            // preventing a spurious re-sync on the next poll tick.
            const uploadTs = new Date().toISOString();
            mergedDoc.updated_at = uploadTs;
            const encryptedMerged = await AppCrypto.encrypt(JSON.stringify(mergedDoc), localKey);
            await AppSync.upload(encryptedMerged, storage.getSalt(), uploadTs);
            await saveSyncBase(mergedDoc, localKey);
            return { success: true, action: 'merged_auto', data: mergedDoc };
          }
        } else if (AppSync.conflictCallback) {
          console.log('[sync] checkAndSync: conflicts require user resolution —', mergeAttempt.unresolved.length, 'node(s)');
          const payload = {
            type: 'field-merge',
            localUpdatedAt: localDoc?.updated_at || null,
            serverUpdatedAt: serverTs,
            autoMergedFields: mergeAttempt.autoMergedFields,
            conflicts: mergeAttempt.unresolved
          };

          const resolution = await AppSync.conflictCallback(payload);
          console.log('[sync] checkAndSync: user resolved with:', typeof resolution === 'string' ? resolution : resolution?.choice);

          if (resolution === 'server') {
            await saveSyncBase(serverDoc, localKey);
            return { success: true, action: 'applied_server', data: serverDoc };
          }

          if (resolution === 'local') {
            const encryptedData = await AppCrypto.encrypt(JSON.stringify(localDoc), localKey);
            await AppSync.upload(encryptedData, storage.getSalt());
            await saveSyncBase(localDoc, localKey);
            return { success: true, action: 'uploaded_local' };
          }

          if (resolution && resolution.choice === 'merge') {
            const mergedDoc = AppSync.finalizeMergeAttempt(mergeAttempt, resolution.choices || {});
            if (mergedDoc) {
              console.log('[sync] checkAndSync: user merge finalized');
              const encryptedMerged = await AppCrypto.encrypt(JSON.stringify(mergedDoc), localKey);
              await AppSync.upload(encryptedMerged, storage.getSalt());
              await saveSyncBase(mergedDoc, localKey);
              return { success: true, action: 'merged_user', data: mergedDoc };
            }
          }
        }

        return { success: false, action: 'conflict_pending' };
      }

      // Legacy fallback when we cannot build a merge attempt.
      console.log('[sync] checkAndSync: no merge base, falling back to legacy conflict UI');
      if (AppSync.conflictCallback) {
        const choice = await AppSync.conflictCallback({
          type: 'legacy',
          localUpdatedAt: localDoc?.updated_at || null,
          serverUpdatedAt: serverTs
        });
        console.log('[sync] checkAndSync: legacy choice:', choice);
        if (choice === 'server') {
          await saveSyncBase(serverDoc, localKey);
          return { success: true, action: 'applied_server', data: serverDoc };
        }
        if (choice === 'local') {
          const encryptedData = await AppCrypto.encrypt(JSON.stringify(localDoc), localKey);
          await AppSync.upload(encryptedData, storage.getSalt());
          await saveSyncBase(localDoc, localKey);
          return { success: true, action: 'uploaded_local' };
        }
      }

      return { success: false, action: 'conflict_pending' };
    } catch (error) {
      console.error('[sync] checkAndSync failed:', error);
      return { success: false, action: 'error', error };
    }
  },

  // Upload local data to server (encrypted)
  upload: async (encryptedData, salt, uploadedAt = null) => {
    if (!AppSync.client) return;
    const user = await AppSync.getUser();
    if (!user) return;

    const ts = uploadedAt || new Date().toISOString();
    console.log('[sync] upload: pushing to server');
    const { error } = await AppSync.client
      .from('outlines')
      .upsert({
        user_id: user.id,
        salt,
        data: encryptedData,
        updated_at: ts
      }, { onConflict: 'user_id' });

    if (error) throw error;
    AppSync._lastServerUpdatedAt = ts;
    console.log('[sync] upload: done, server updated_at:', ts);
  },

  // Download data from server.
  download: async () => {
    if (!AppSync.client) return null;
    const user = await AppSync.getUser();
    if (!user) return null;

    const { data, error } = await AppSync.client
      .from('outlines')
      .select('salt, data, updated_at')
      .eq('user_id', user.id)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  // Trigger background upload on write operations.
  // Debounced: rapid edits are batched into a single upload 800 ms after the last write.
  triggerBackgroundUpload: (doc, key) => {
    if (!AppSync.client) return;
    if (AppSync._uploadTimer) clearTimeout(AppSync._uploadTimer);
    AppSync._uploadTimer = setTimeout(async () => {
      AppSync._uploadTimer = null;
      console.log('[sync] triggerBackgroundUpload: starting');
      let delay = 1000;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const encryptedData = await AppCrypto.encrypt(JSON.stringify(doc), key);
          const salt = storage.getSalt();
          await AppSync.upload(encryptedData, salt);
          await saveSyncBase(doc, key);
          state.syncStatus.value = 'synced';
          console.log('[sync] triggerBackgroundUpload: success');
          return;
        } catch (error) {
          console.error(`[sync] triggerBackgroundUpload: failed (attempt ${attempt + 1}):`, error);
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay *= 2;
          } else {
            state.syncStatus.value = 'error';
          }
        }
      }
    }, 800);
  },

  // Lightweight probe: fetch only updated_at from the server row.
  fetchServerTimestamp: async () => {
    if (!AppSync.client) return null;
    const user = await AppSync.getUser();
    if (!user) return null;

    const { data, error } = await AppSync.client
      .from('outlines')
      .select('updated_at')
      .eq('user_id', user.id)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data?.updated_at || null;
  },

  // Start polling the server every 15 s for remote changes.
  startPolling: () => {
    AppSync.stopPolling();
    console.log('[sync] polling started (15s interval)');
    AppSync._pollInterval = setInterval(async () => {
      if (AppSync._polling) return;
      if (!state.user.value) return;
      if (state.syncStatus.value === 'syncing') return;

      AppSync._polling = true;
      try {
        const serverTs = await AppSync.fetchServerTimestamp();
        if (!serverTs) return;

        // Nothing changed since we last synced.
        if (AppSync._lastServerUpdatedAt &&
          new Date(serverTs).getTime() === new Date(AppSync._lastServerUpdatedAt).getTime()) return;

        console.log('[sync] poll: server updated_at changed to', serverTs, '— running sync');
        state.syncStatus.value = 'syncing';
        const result = await AppSync.checkAndSync(state.doc.value, state.key.value);
        console.log('[sync] poll: sync result:', result.action);

        if (result.success) {
          if (result.data) {
            state.doc.value = result.data;
            await storage.set('vmd_data', result.data, state.key.value);
          }
          if (result.action !== 'conflict_pending') {
            state.syncStatus.value = 'synced';
          }
        } else if (result.action !== 'conflict_pending') {
          state.syncStatus.value = navigator.onLine ? 'error' : 'offline';
        }
      } catch (err) {
        console.warn('[sync] poll error:', err);
      } finally {
        AppSync._polling = false;
      }
    }, 15000);
  },

  // Stop the polling interval.
  stopPolling: () => {
    if (AppSync._pollInterval) {
      clearInterval(AppSync._pollInterval);
      AppSync._pollInterval = null;
      console.log('[sync] polling stopped');
    }
  }
};
