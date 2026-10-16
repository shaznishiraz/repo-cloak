import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import checkbox from '@inquirer/checkbox';

function buildTree(root, options) {
  const { maxDepth, ignore } = options;
  const nodes = new Map();
  const checked = new Set();

  function walk(currentPath, depth, parentId) {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        if (ignore(fullPath, entry.name)) continue;

        const id = fullPath;
        const node = {
          id,
          name: entry.name,
          fullPath,
          parentId,
          children: [],
          isDirectory: entry.isDirectory(),
        };
        nodes.set(id, node);

        if (parentId) {
          const parent = nodes.get(parentId);
          if (parent) parent.children.push(id);
        }

        if (entry.isDirectory()) {
          walk(fullPath, depth + 1, id);
        }
      }
    } catch (e) {
      // ignore read errors
    }
  }

  walk(root, 0, undefined);
  return { nodes, checked };
}

function setSubtreeChecked(state, nodeId, checkedStatus) {
  const queue = [nodeId];
  while (queue.length) {
    const id = queue.pop();
    if (checkedStatus) state.checked.add(id);
    else state.checked.delete(id);
    const node = state.nodes.get(id);
    if (node) queue.push(...node.children);
  }
}

function recomputeParentFromChildren(state, nodeId) {
  let current = state.nodes.get(nodeId);
  while (current?.parentId) {
    const parent = state.nodes.get(current.parentId);
    if (!parent) break;
    const allChildrenChecked = parent.children.length
      ? parent.children.every((cid) => state.checked.has(cid))
      : false;

    if (allChildrenChecked) state.checked.add(parent.id);
    else state.checked.delete(parent.id);

    current = parent;
  }
}

function applyExplicitNodeState(state, nodeId, targetState) {
  setSubtreeChecked(state, nodeId, targetState);
  recomputeParentFromChildren(state, nodeId);
}

function flattenNodesHierarchically(nodes) {
  const roots = Array.from(nodes.values()).filter((n) => !n.parentId);
  roots.sort((a, b) => a.name.localeCompare(b.name));

  const flatList = [];

  function visit(node, prefix, isLast) {
    const connector = prefix ? (isLast ? '└─ ' : '├─ ') : '';
    const icon = node.isDirectory ? '[d] ' : '    ';

    flatList.push({
      node,
      displayName: `${prefix}${connector}${icon}${node.name}`
    });

    const childPrefix = prefix + (isLast ? '   ' : '|  ');
    const children = node.children
      .map((id) => nodes.get(id))
      .sort((a, b) => a.name.localeCompare(b.name));

    children.forEach((child, index) => {
      const last = index === children.length - 1;
      visit(child, childPrefix, last);
    });
  }

  roots.forEach((root, index) => {
    const last = index === roots.length - 1;
    visit(root, '', last);
  });

  return flatList;
}

function printSelectionSummary(root, state, hierarchicalNodes) {
  const selectedFiles = hierarchicalNodes.filter(n => !n.node.isDirectory && state.checked.has(n.node.id));
  if (selectedFiles.length === 0) {
    console.log('\x1b[90m  (no files selected yet)\x1b[0m\n');
  } else {
    console.log(`\x1b[32m  ${selectedFiles.length} file(s) selected:\x1b[0m`);
    const maxDisplay = 10;
    selectedFiles.slice(0, maxDisplay).forEach(n => {
      const rel = path.relative(root, n.node.id);
      console.log(`    \x1b[32m+\x1b[0m ${rel}`);
    });
    if (selectedFiles.length > maxDisplay) {
      console.log(`\x1b[90m    ... and ${selectedFiles.length - maxDisplay} more\x1b[0m`);
    }
    console.log('');
  }
}

export async function checkboxTreeSelect(options = {}) {
  const {
    root = process.cwd(),
    maxDepth = 5,
    ignore = (fullPath, name) => name === 'node_modules' || name.startsWith('.git'),
    message = 'Select files',
    pageSize = 15,
    precheck = [],
  } = options;

  const state = buildTree(root, { maxDepth, ignore });

  if (precheck && precheck.length > 0) {
    for (const p of precheck) {
      if (state.nodes.has(p)) applyExplicitNodeState(state, p, true);
    }
  }

  const hierarchicalNodes = flattenNodesHierarchically(state.nodes);
  const allNodes = hierarchicalNodes.map(item => item.node);

  if (hierarchicalNodes.length === 0) {
    console.log(`No items found in ${root}`);
    return [];
  }

  // Search loop: user types a query, sees filtered results, selects with space.
  // Empty search + Enter = done.
  while (true) {
    console.clear();
    console.log(`\nRoot: \x1b[1m${root}\x1b[0m`);
    console.log('\x1b[90mType a filename to search. Space to select, Enter to confirm. Empty search + Enter to finish.\x1b[0m\n');
    printSelectionSummary(root, state, hierarchicalNodes);

    const { query } = await inquirer.prompt([{
      type: 'input',
      name: 'query',
      message: `${message} — search:`,
    }]);

    const trimmed = query.trim().toLowerCase();

    // Empty query = user is done selecting
    if (!trimmed) break;

    // Filter nodes whose relative path matches the query
    const matched = hierarchicalNodes.filter(({ node }) => {
      const rel = path.relative(root, node.id).toLowerCase();
      return rel.includes(trimmed);
    });

    if (matched.length === 0) {
      console.log(`\x1b[33m  No results for "${query}". Try a different term.\x1b[0m`);
      await new Promise(r => setTimeout(r, 1200));
      continue;
    }

    // Build choices for the checkbox prompt from search results
    const choices = matched.map(({ node }) => {
      const rel = path.relative(root, node.id);
      const icon = node.isDirectory ? '[dir] ' : '';
      return {
        name: `${icon}${rel}`,
        value: node.id,
        checked: state.checked.has(node.id),
      };
    });

    const prevChecked = new Set(state.checked);

    let selected;
    try {
      selected = await checkbox({
        message: `Results for "${query}" — Space to toggle, Enter to go back to search`,
        choices,
        pageSize,
        loop: false,
      });
    } catch {
      // User force-quit (ctrl+c) — treat as done
      break;
    }

    // Apply changes: determine what was toggled from the matched set
    const nextChecked = new Set(selected);
    for (const { node } of matched) {
      const was = prevChecked.has(node.id);
      const now = nextChecked.has(node.id);
      if (was !== now) {
        applyExplicitNodeState(state, node.id, now);
      }
    }
  }

  return Array.from(state.checked);
}

export async function checkboxTreeSelectFilesOnly(options = {}) {
  const paths = await checkboxTreeSelect(options);
  return paths.filter((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

export async function checkboxTreeSelectSingleDir(options = {}) {
  while (true) {
    const paths = await checkboxTreeSelect({ ...options, message: options.message + ' (Select MAXIMUM ONE directory)' });
    const dirs = paths.filter(p => {
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    });
    if (dirs.length > 1) {
      console.log('\nPlease select ONLY ONE directory.\n');
      continue;
    }
    return dirs[0] || '';
  }
}
