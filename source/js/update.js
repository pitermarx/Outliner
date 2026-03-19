import { state } from './state.js';
import { storage } from './storage.js';
import { AppCrypto } from './crypto.js';
import { AppSync } from './sync.js';
import { getNode, getParent } from './model.js';

// Helper to traverse and update
const updateDoc = (fn, options = { history: true }) => {
  try {
    const currentDoc = state.doc.value;

    if (options.history) {
      const snapshot = JSON.parse(JSON.stringify(currentDoc));
      const history = [...state.history.value, snapshot];
      if (history.length > 100) history.shift();
      state.history.value = history;
      state.future.value = [];
    }

    const newDoc = JSON.parse(JSON.stringify(currentDoc));
    fn(newDoc);
    state.doc.value = newDoc;
    storage.set('vmd_data', newDoc, state.key.value);
  } catch (e) {
    console.error('updateDoc error:', e);
  }
};

export const undo = () => {
  if (state.history.value.length === 0) return;
  const previous = state.history.value[state.history.value.length - 1];
  state.future.value = [...state.future.value, state.doc.value];
  state.history.value = state.history.value.slice(0, -1);
  state.doc.value = previous;
  storage.set('vmd_data', previous, state.key.value);
};

export const redo = () => {
  if (state.future.value.length === 0) return;
  const next = state.future.value[state.future.value.length - 1];
  state.history.value = [...state.history.value, state.doc.value];
  state.future.value = state.future.value.slice(0, -1);
  state.doc.value = next;
  storage.set('vmd_data', next, state.key.value);
};

export const dispatch = (action, path, payload) => {
  if (action === 'update') {
    updateDoc(d => {
      const node = getNode(d, path);
      if (node) {
        Object.assign(node, payload);
        node.updated_at = new Date().toISOString();
      }
    });
    return;
  }

  if (action === 'toggleCollapse') {
    updateDoc(d => {
      const node = getNode(d, path);
      if (node) {
        node.collapsed = !node.collapsed;
        node.updated_at = new Date().toISOString(); // Update timestamp
      }
    });
    return;
  }

  if (action === 'move') {
    const fromPath = path;
    const toPath = payload;
    if (!toPath) return;

    // Check if moving into descendant
    if (toPath.length > fromPath.length && fromPath.every((v, i) => v === toPath[i])) {
      return;
    }

    updateDoc(d => {
      const newToPath = [...toPath];
      let divergenceIndex = -1;
      for (let i = 0; i < Math.min(fromPath.length, toPath.length); i++) {
        if (fromPath[i] !== toPath[i]) {
          divergenceIndex = i;
          break;
        }
      }

      if (divergenceIndex !== -1 && fromPath[divergenceIndex] < toPath[divergenceIndex]) {
        newToPath[divergenceIndex]--;
      }

      const parentFrom = getParent(d, fromPath);
      const indexFrom = fromPath[fromPath.length - 1];
      const node = parentFrom.children[indexFrom];

      parentFrom.children.splice(indexFrom, 1);

      const parentTo = getParent(d, newToPath);
      const indexTo = newToPath[newToPath.length - 1];

      if (parentTo) {
        parentTo.children.splice(indexTo, 0, node);
        state.focusPath.value = newToPath;
        node.updated_at = new Date().toISOString(); // Update timestamp
      }
    });
    return;
  }

  // Navigation actions (read-only)
  if (['focusPrev', 'focusNext'].includes(action)) {
    const doc = state.doc.value;

    if (action === 'focusPrev') {
      const index = path[path.length - 1];
      if (index > 0) {
        // Go to previous sibling's deepest last child
        let targetPath = [...path];
        targetPath[targetPath.length - 1]--;

        let node = getNode(doc, targetPath);
        while (node && node.children && node.children.length > 0 && !node.collapsed) {
          targetPath.push(node.children.length - 1);
          node = node.children[node.children.length - 1];
        }
        state.focusPath.value = targetPath;
      } else if (path.length > 1) {
        // Go to parent (if not at root level)
        state.focusPath.value = path.slice(0, -1);
      }
    } else if (action === 'focusNext') {
      const node = getNode(doc, path);
      if (node.children && node.children.length > 0 && !node.collapsed) {
        // Go to first child
        state.focusPath.value = [...path, 0];
      } else {
        // Go to next sibling or parent's next sibling
        let currentPath = [...path];
        while (currentPath.length > 0) {
          const p = getParent(doc, currentPath);
          if (!p) break;
          const idx = currentPath[currentPath.length - 1];
          if (idx < p.children.length - 1) {
            currentPath[currentPath.length - 1]++;
            state.focusPath.value = currentPath;
            return;
          }
          currentPath.pop();
        }
      }
    }
    return;
  }

  // Pure state actions (no doc mutation, no storage write)
  if (action === 'zoom') {
    state.zoomPath.value = path;
    return;
  }
  if (action === 'focus') {
    state.focusPath.value = path;
    state.selection.value = []; // Clear selection when focusing
    return;
  }

  if (action === 'addChild') {
    updateDoc(d => {
      const node = getNode(d, path);
      if (!node) return;
      const newId = AppCrypto.generateSalt();
      const newNode = { id: newId, text: '', children: [], updated_at: new Date().toISOString() };
      if (!node.children) node.children = [];
      node.children.unshift(newNode);
      state.focusPath.value = [...path, 0];
    });
    return;
  }

  // Multi-select actions
  if (action === 'multiDelete') {
    const paths = state.selection.value;
    if (!paths || paths.length === 0) return;
    // Check if any node has children — require confirmation
    const doc = state.doc.value;
    const hasChildren = paths.some(p => {
      const n = getNode(doc, p);
      return n && n.children && n.children.length > 0;
    });
    if (hasChildren && !confirm(`Delete ${paths.length} nodes and all their children?`)) return;
    updateDoc(d => {
      // Sort by depth-first, bottom-to-top to avoid index shifts
      const sorted = [...paths].sort((a, b) => {
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
          if (a[i] !== b[i]) return b[i] - a[i];
        }
        return b.length - a.length;
      });
      for (const p of sorted) {
        const parent = getParent(d, p);
        if (parent) parent.children.splice(p[p.length - 1], 1);
      }
      state.focusPath.value = null;
      state.selection.value = [];
    });
    return;
  }

  if (action === 'multiToggleCollapse') {
    const paths = state.selection.value;
    if (!paths || paths.length === 0) return;
    const doc = state.doc.value;
    const allCollapsed = paths.every(p => { const n = getNode(doc, p); return n && n.collapsed; });
    updateDoc(d => {
      for (const p of paths) {
        const node = getNode(d, p);
        if (node) node.collapsed = allCollapsed ? false : true;
      }
    });
    return;
  }

  if (action === 'multiIndent') {
    const paths = state.selection.value;
    if (!paths || paths.length === 0) return;
    const sorted = [...paths].sort((a, b) => a[a.length - 1] - b[b.length - 1]); // ascending
    const minIdx = sorted[0][sorted[0].length - 1];
    if (minIdx === 0) return; // can't indent first node
    updateDoc(d => {
      const parentPath = sorted[0].slice(0, -1);
      const parent = parentPath.length > 0 ? getNode(d, parentPath) : d;
      const prevSibling = parent.children[minIdx - 1];
      // Collect nodes first (before modifying)
      const nodesToMove = sorted.map(p => getNode(d, p));
      // Remove in reverse order to preserve indices
      for (let i = sorted.length - 1; i >= 0; i--) {
        parent.children.splice(sorted[i][sorted[i].length - 1], 1);
      }
      // Append all to previous sibling's children
      prevSibling.children.push(...nodesToMove);
      prevSibling.collapsed = false;
      state.selection.value = [];
    });
    return;
  }

  if (action === 'multiUnindent') {
    updateDoc(d => {
      const sorted = [...state.selection.value].sort((a, b) => a[a.length - 1] - b[b.length - 1]);
      for (const p of sorted) {
        if (p.length <= 1) continue;
        const idx = p[p.length - 1];
        const parent = getParent(d, p);
        const grandparent = getParent(d, p.slice(0, -1));
        if (!grandparent) continue;
        const parentIdx = p[p.length - 2];
        const node = parent.children[idx];
        parent.children.splice(idx, 1);
        grandparent.children.splice(parentIdx + 1, 0, node);
      }
      state.selection.value = [];
    });
    return;
  }

  updateDoc(d => {
    const parent = getParent(d, path);
    const index = path[path.length - 1];

    if (action === 'add') {
      const node = getNode(d, path);
      if (node.children && node.children.length > 0 && !node.collapsed) {
        // Add as first child
        const newId = AppCrypto.generateSalt();
        const newNode = { id: newId, text: '', children: [], updated_at: new Date().toISOString() };
        node.children.unshift(newNode);
        state.focusPath.value = [...path, 0];
      } else {
        // Add as next sibling
        if (!parent) return;
        const newId = AppCrypto.generateSalt();
        const newNode = { id: newId, text: '', children: [], updated_at: new Date().toISOString() };
        parent.children.splice(index + 1, 0, newNode);
        const newPath = [...path];
        newPath[newPath.length - 1] = index + 1;
        state.focusPath.value = newPath;
      }
    } else if (action === 'delete') {
      if (!parent) return; // Cannot delete root

      // Confirm if children exist
      const node = parent.children[index];
      if (node.children && node.children.length > 0) {
        if (!confirm('Delete node and all children?')) return;
      }

      // Remove node
      parent.children.splice(index, 1);
      // Focus previous sibling or parent
      if (index > 0) {
        const newPath = [...path];
        newPath[newPath.length - 1] = index - 1;
        state.focusPath.value = newPath;
      } else {
        state.focusPath.value = path.slice(0, -1);
      }
    } else if (action === 'moveUp') {
      if (index > 0) {
        const node = parent.children[index];
        parent.children.splice(index, 1);
        parent.children.splice(index - 1, 0, node);
        node.updated_at = new Date().toISOString(); // Update timestamp

        const newPath = [...path];
        newPath[newPath.length - 1] = index - 1;
        state.focusPath.value = newPath;
      }
    } else if (action === 'moveDown') {
      if (index < parent.children.length - 1) {
        const node = parent.children[index];
        parent.children.splice(index, 1);
        parent.children.splice(index + 1, 0, node);
        node.updated_at = new Date().toISOString(); // Update timestamp

        const newPath = [...path];
        newPath[newPath.length - 1] = index + 1;
        state.focusPath.value = newPath;
      }
    } else if (action === 'indent') {
      if (index === 0) return;

      const prevSibling = parent.children[index - 1];
      const node = parent.children[index];

      parent.children.splice(index, 1);

      prevSibling.children.push(node);
      prevSibling.collapsed = false;
      prevSibling.updated_at = new Date().toISOString(); // Update timestamp

      const newPath = [...path];
      newPath[newPath.length - 1] = index - 1;
      newPath.push(prevSibling.children.length - 1);
      state.focusPath.value = newPath;
    } else if (action === 'unindent') {
      if (path.length <= 1) return;

      const node = parent.children[index];

      parent.children.splice(index, 1);

      const grandparent = getParent(d, path.slice(0, -1));
      const parentIndex = path[path.length - 2];

      grandparent.children.splice(parentIndex + 1, 0, node);
      grandparent.updated_at = new Date().toISOString(); // Update timestamp

      const newPath = path.slice(0, -1);
      newPath[newPath.length - 1] = parentIndex + 1;
      state.focusPath.value = newPath;
    } else if (action === 'toggleCollapse') {
      const node = getNode(d, path);
      if (node) {
        node.collapsed = !node.collapsed;
        node.updated_at = new Date().toISOString();
      }
    }
  });

  // Trigger background sync after write operations
  if (['update', 'add', 'addChild', 'delete', 'move', 'moveUp', 'moveDown', 'indent', 'unindent', 'toggleCollapse'].includes(action)) {
    if (state.user.value) { // Only sync if user is logged in
      state.syncStatus.value = 'syncing';
      AppSync.triggerBackgroundUpload(state.doc.value, state.key.value);
    }
  }
};
