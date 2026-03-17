import { AppCrypto } from './crypto.js';

// --- VMD MODULE ---
export const VMD = {
  serialize: (node, level = -1, includeTimestamp = false) => {
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

      // Add timestamp if requested
      if (includeTimestamp && node.updated_at) {
        const timestampIndent = '  '.repeat(level + 1);
        result += `${timestampIndent}// updated_at: ${node.updated_at}\n`;
      }
    }

    if (node.children) {
      for (const child of node.children) {
        result += VMD.serialize(child, level + 1, includeTimestamp);
      }
    }
    return result;
  },

  parse: (text) => {
    const lines = text.split('\n');
    const root = { id: 'root', text: 'My Notes', children: [], updated_at: new Date().toISOString() };
    const stack = [{ node: root, indentLevel: -1 }];
    let lastNode = null;

    for (const line of lines) {
      if (!line.trim()) continue;

      // Check for timestamp comment
      const timestampMatch = line.match(/^(\s*)\/\/ updated_at: (.+)$/);
      if (timestampMatch) {
        const indentStr = timestampMatch[1];
        const timestamp = timestampMatch[2];
        const indentLevel = Math.floor(indentStr.length / 2);
        if (lastNode) {
          lastNode.updated_at = timestamp;
        }
        continue;
      }

      // Check for escaped characters at the beginning of lines
      const escapedMatch = line.match(/^(\s*)(\\[+-]) (.*)$/);
      if (escapedMatch) {
        const indentStr = escapedMatch[1];
        const escapedChar = escapedMatch[2]; // Will be \+ or \-
        const content = escapedMatch[3];
        const indentLevel = Math.floor(indentStr.length / 2);

        while (stack.length > 1 && stack[stack.length - 1].indentLevel >= indentLevel) {
          stack.pop();
        }

        const parent = stack[stack.length - 1].node;
        const newNode = {
          id: AppCrypto.generateSalt(),
          text: escapedChar + ' ' + content, // Keep the escaped character in the text
          children: [],
          collapsed: false,
          updated_at: new Date().toISOString()
        };

        parent.children.push(newNode);
        stack.push({ node: newNode, indentLevel: indentLevel });
        lastNode = newNode;
        continue;
      }

      const match = line.match(/^(\s*)([-+*]) (.*)$/);

      if (match) {
        const indentStr = match[1];
        const bullet = match[2];
        const content = match[3];

        const indentLevel = Math.floor(indentStr.length / 2);

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
        stack.push({ node: newNode, indentLevel: indentLevel });
        lastNode = newNode;
      } else {
        if (lastNode) {
          const trimmed = line.trim();
          lastNode.description = lastNode.description
            ? lastNode.description + '\n' + trimmed
            : trimmed;
        }
      }
    }
    return root;
  }
};

export const getNode = (root, path) => {
  let current = root;
  for (let i = 0; i < path.length; i++) {
    if (!current.children) return null;
    current = current.children[path[i]];
  }
  return current;
};

export const getParent = (root, path) => {
  if (path.length === 0) return null;
  let current = root;
  for (let i = 0; i < path.length - 1; i++) {
    current = current.children[path[i]];
  }
  return current;
};

export const findPath = (node, id, currentPath = []) => {
  if (node.id === id) return currentPath;
  if (node.children) {
    for (let i = 0; i < node.children.length; i++) {
      const res = findPath(node.children[i], id, [...currentPath, i]);
      if (res) return res;
    }
  }
  return null;
};
