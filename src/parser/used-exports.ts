/**
 * Ring-1 "used exports" filtering (TypeScript / JavaScript family). Given the
 * names an importer actually pulls from a module, drop every top-level
 * statement that those names do not reach — through the identifiers and type
 * names left in their (already pruned) signatures. Imports, overloads and
 * merged declarations follow automatically because they bind the same names.
 *
 * Bails out (returns no ranges) whenever filtering could hide something the
 * importer relies on: no ES exports (CommonJS), or none of the requested names
 * declared here (barrel / re-export files).
 */

import type { Node } from 'web-tree-sitter';

import type { PruneRange } from './analyze.js';

/** Node types that declare names at module top level. */
const DECLARATION_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_signature',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'lexical_declaration',
  'variable_declaration',
  'ambient_declaration',
  'module',
  'internal_module',
]);

/** Identifier-like node types that reference a binding. */
const REFERENCE_TYPES = new Set(['identifier', 'type_identifier', 'shorthand_property_identifier']);

interface TopLevel {
  node: Node;
  /** Comments directly above the statement (removed together with it). */
  leading: Node[];
  /** Local names this statement binds. */
  binds: string[];
  /** Names it is visible under to importers (`default` for default exports). */
  exports: string[];
  /** Kept regardless of usage (re-exports, directives). */
  always: boolean;
  /** For `export { a as b }`: locals referenced when the clause is kept. */
  locals: string[];
}

/** Names bound by a declaration node (`name` field or variable declarators). */
function declaredNames(node: Node): string[] {
  if (node.type === 'ambient_declaration') {
    return node.namedChildren.flatMap(declaredNames);
  }
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    return node.namedChildren
      .filter((c) => c.type === 'variable_declarator')
      .flatMap((d) => {
        const name = d.childForFieldName('name');
        if (!name) return [];
        if (name.type === 'identifier') return [name.text];
        return name.descendantsOfType(['identifier', 'shorthand_property_identifier_pattern']).map((n) => n.text);
      });
  }
  const name = node.childForFieldName('name');
  return name ? [name.text] : [];
}

/** Local names bound by an `import …` statement. */
function importBindings(node: Node): string[] {
  const clause = node.namedChildren.find((c) => c.type === 'import_clause');
  if (!clause) return [];
  const names: string[] = [];
  for (const c of clause.namedChildren) {
    if (c.type === 'identifier') names.push(c.text);
    else if (c.type === 'namespace_import') {
      const id = c.namedChildren.find((n) => n.type === 'identifier');
      if (id) names.push(id.text);
    } else if (c.type === 'named_imports') {
      for (const spec of c.namedChildren) {
        if (spec.type !== 'import_specifier') continue;
        const local = spec.childForFieldName('alias') ?? spec.childForFieldName('name');
        if (local) names.push(local.text);
      }
    }
  }
  return names;
}

function classify(node: Node): Omit<TopLevel, 'leading'> {
  const base = { node, binds: [] as string[], exports: [] as string[], always: false, locals: [] as string[] };
  if (node.type === 'import_statement') return { ...base, binds: importBindings(node) };
  if (node.type === 'export_statement') {
    // `export * from` / `export { a } from`: barrel lines, always kept.
    if (node.childForFieldName('source')) return { ...base, always: true };
    const isDefault = node.children.some((c) => c.type === 'default');
    const decl = node.childForFieldName('declaration');
    if (decl) {
      const names = declaredNames(decl);
      return { ...base, binds: names, exports: isDefault ? [...names, 'default'] : names };
    }
    if (isDefault) return { ...base, exports: ['default'] };
    const clause = node.namedChildren.find((c) => c.type === 'export_clause');
    if (clause) {
      const specs = clause.namedChildren.filter((c) => c.type === 'export_specifier');
      return {
        ...base,
        exports: specs.map((s) => (s.childForFieldName('alias') ?? s.childForFieldName('name'))!.text),
        locals: specs.map((s) => s.childForFieldName('name')!.text),
      };
    }
    return { ...base, always: true };
  }
  if (DECLARATION_TYPES.has(node.type)) return { ...base, binds: declaredNames(node) };
  // `'use client'`-style directive strings stay; other statements are dropped.
  if (node.type === 'expression_statement' && node.firstNamedChild?.type === 'string') {
    return { ...base, always: true };
  }
  return base;
}

/** Referenced names inside `node`, ignoring text that pruning removes anyway. */
function references(node: Node, pruned: PruneRange[]): string[] {
  const inside = pruned.filter((r) => r.start >= node.startIndex && r.end <= node.endIndex);
  return node
    .descendantsOfType([...REFERENCE_TYPES])
    .filter((n) => !inside.some((r) => n.startIndex >= r.start && n.endIndex <= r.end))
    .map((n) => n.text);
}

/**
 * Removal ranges for top-level statements not reachable from `keep`.
 * `pruned` are the body ranges already scheduled, so references inside
 * collapsed bodies do not keep their targets alive.
 */
export function unusedTopLevelRanges(
  root: Node,
  source: string,
  keep: string[],
  pruned: PruneRange[],
): PruneRange[] {
  if (root.type !== 'program') return [];
  const items: TopLevel[] = [];
  let leading: Node[] = [];
  for (const node of root.namedChildren) {
    if (node.type === 'comment') {
      leading.push(node);
      continue;
    }
    items.push({ ...classify(node), leading });
    leading = [];
  }

  const exported = items.filter((i) => i.exports.length > 0);
  const wanted = new Set(keep);
  if (exported.length === 0 || !exported.some((i) => i.exports.some((n) => wanted.has(n)))) {
    return [];
  }

  // Worklist: start from the requested exports, follow references to bindings.
  const kept = new Set<TopLevel>();
  const reached = new Set<string>();
  const queue: TopLevel[] = items.filter(
    (i) => i.always || i.exports.some((n) => wanted.has(n)),
  );
  while (queue.length > 0) {
    const item = queue.pop()!;
    if (kept.has(item)) continue;
    kept.add(item);
    for (const name of [...item.locals, ...references(item.node, pruned)]) {
      if (reached.has(name)) continue;
      reached.add(name);
      for (const other of items) {
        if (!kept.has(other) && other.binds.includes(name)) queue.push(other);
      }
    }
  }

  return items
    .filter((i) => !kept.has(i))
    .map((i) => lineRange(source, (i.leading[0] ?? i.node).startIndex, i.node.endIndex));
}

/** Range covering `start..end`, widened to whole lines when they hold nothing else. */
function lineRange(source: string, start: number, end: number): PruneRange {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const nl = source.indexOf('\n', end);
  const lineEnd = nl === -1 ? source.length : nl + 1;
  const whole =
    source.slice(lineStart, start).trim() === '' &&
    source.slice(end, nl === -1 ? source.length : nl).trim() === '';
  return whole ? { start: lineStart, end: lineEnd, token: '' } : { start, end, token: '' };
}
