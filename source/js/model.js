import { AppCrypto } from './crypto.js';

// --- VMD MODULE ---
export const VMD = {
  serialize: (node, level = -1) => {
    let result = '';

    if (level >= 0) {
      const indent = '  '.repeat(level);
      const bullet = (node.children && node.children.length > 0 && node.collapsed) ? '+' : '-';
      result += `${indent}${bullet} ${node.text}\n`;

      if (node.description) {
        const descIndent = '  '.repeat(level + 1);
        const lines = node.description.split('\n');
        for (const line of lines) {
          result += `${descIndent}${line}\n`;
        }
      }
    }

    if (node.children) {
      for (const child of node.children) {
        result += VMD.serialize(child, level + 1);
      }
    }
    return result;
  },

  parse: (text) => {
    const lines = text.split(/\r?\n/);
    const root = { id: 'root', text: 'My Notes', children: [], updated_at: new Date().toISOString() };
    const stack = [{ node: root, indentLevel: -1 }];
    let lastNode = null;

    for (const line of lines) {
      if (!line.trim()) continue;

      // Check for escaped characters at the beginning of lines
      const escapedMatch = line.match(/^(\s*)(\\[+-])\s+(.*)$/);
      if (escapedMatch) {
        const [, indentStr, escapedChar, content] = escapedMatch;
        const indentLevel = Math.floor(indentStr.length / 2);

        // Pop stack until we find the correct parent level
        while (stack.length > 1 && stack[stack.length - 1].indentLevel >= indentLevel) {
          stack.pop();
        }

        const parent = stack[stack.length - 1].node;
        const newNode = {
          id: AppCrypto.generateSalt(),
          text: `${escapedChar} ${content}`,
          children: [],
          collapsed: false,
          updated_at: new Date().toISOString()
        };

        parent.children.push(newNode);
        stack.push({ node: newNode, indentLevel });
        lastNode = newNode;
        continue;
      }

      // Match regular bullet points (-, +, *)
      const match = line.match(/^(\s*)([-+*])\s+(.*)$/);
      if (match) {
        const [, indentStr, bullet, content] = match;
        const indentLevel = Math.floor(indentStr.length / 2);

        // Pop stack until we find the correct parent level
        while (stack.length > 1 && stack[stack.length - 1].indentLevel >= indentLevel) {
          stack.pop();
        }

        const parent = stack[stack.length - 1].node;
        const newNode = {
          id: AppCrypto.generateSalt(),
          text: content,
          children: [],
          collapsed: bullet === '+',
          updated_at: new Date().toISOString()
        };

        parent.children.push(newNode);
        stack.push({ node: newNode, indentLevel });
        lastNode = newNode;
      } else {
        // Handle description lines (indented content without bullets)
        if (lastNode) {
          const trimmedLine = line.trim();
          if (trimmedLine) {
            lastNode.description = lastNode.description
              ? `${lastNode.description}\n${trimmedLine}`
              : trimmedLine;
          }
        }
      }
    }
    return root;
  }
};

export const getNode = (root, path) => {
  if (!root || !Array.isArray(path)) {
    return null;
  }

  let current = root;
  for (let i = 0; i < path.length; i++) {
    const index = path[i];
    if (!current.children || !Array.isArray(current.children) || index < 0 || index >= current.children.length) {
      return null;
    }
    current = current.children[index];
  }
  return current;
};

export const getParent = (root, path) => {
  if (!root || !Array.isArray(path) || path.length === 0) {
    return null;
  }
  // Use getNode with path slice to get parent (all but last element)
  return getNode(root, path.slice(0, -1));
};

export const findPath = (node, id, currentPath = []) => {
  if (!node || typeof id === 'undefined' || id === null) {
    return null;
  }

  if (node.id === id) {
    return currentPath;
  }

  if (node.children && Array.isArray(node.children)) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const res = findPath(child, id, [...currentPath, i]);
      if (res) return res;
    }
  }
  return null;
};
