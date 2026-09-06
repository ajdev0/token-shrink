/**
 * Symbol extraction from a parsed tree. One tree-sitter parse yields every
 * named definition (function/class/interface/…) with its byte range, so the
 * MCP server can:
 *   - `expand_symbol`: return a specific definition's full, un-pruned body;
 *   - `search_symbol_signatures`: index names + signature lines for fast lookup.
 *
 * Node types are matched by name across grammars, and definitions are only
 * kept when the grammar exposes a `name` field (verified for TS/JS/TSX/JSX,
 * Python, Go, Rust, Kotlin, Dart, Swift, Java, PHP). Grammars without a
 * `name` field (e.g. C/C++ `function_definition`) simply contribute nothing.
 */

import type { SyntaxNode } from 'web-tree-sitter';

export type SymbolKind =
  | 'function'
  | 'method'
  | 'arrow'
  | 'class'
  | 'interface'
  | 'enum'
  | 'type'
  | 'other';

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  /** 1-based line of the definition start. */
  line: number;
  /** Byte range in the original source (the full definition, body included). */
  start: number;
  end: number;
  /** First line of the definition (trimmed, capped) for search previews. */
  signature?: string;
}

/** Map of tree-sitter node types to a symbol kind (unique keys only). */
const KIND_BY_TYPE: Record<string, SymbolKind> = {
  // TypeScript / JavaScript / TSX / JSX
  function_declaration: 'function',
  generator_function_declaration: 'function',
  function_expression: 'function',
  function_signature_item: 'function',
  method_definition: 'method',
  method_signature: 'method',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  type_alias_declaration: 'type',
  // Python
  function_definition: 'function',
  class_definition: 'class',
  // Go
  method_declaration: 'method',
  type_spec: 'type',
  // Rust
  function_item: 'function',
  struct_item: 'class',
  enum_item: 'enum',
  trait_item: 'interface',
  type_item: 'type',
  // Java / Kotlin / PHP / Dart / Swift (best-effort generic names)
  constructor_declaration: 'method',
  module_declaration: 'class',
  protocol_declaration: 'interface',
};

/** Signature preview cap. */
const SIGNATURE_MAX = 200;

/**
 * Walk `root` and collect every named definition with its byte range.
 * `source` is only needed to build signature/line previews.
 */
export function collectSymbols(root: SyntaxNode, source: string): SymbolInfo[] {
  const out: SymbolInfo[] = [];
  const walk = (node: SyntaxNode) => {
    const kind = KIND_BY_TYPE[node.type];
    if (kind) {
      const nameNode = node.childForFieldName('name');
      if (nameNode && nameNode.text.trim()) {
        out.push(symbolFrom(nameNode.text.trim(), kind, node.startIndex, node.endIndex, source));
      }
    } else if (node.type === 'variable_declarator') {
      // `const fn = (…) => …` / `const f = function () { … }`
      const value = node.childForFieldName('value');
      const valueType = value?.type;
      if (valueType === 'arrow_function' || valueType === 'function_expression') {
        const nameNode = node.childForFieldName('name');
        if (nameNode && nameNode.text.trim()) {
          out.push(
            symbolFrom(nameNode.text.trim(), 'arrow', node.startIndex, node.endIndex, source),
          );
        }
      }
    }
    // Keep descending so nested methods/inner functions are indexed too.
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  };
  walk(root);
  return out;
}

/**
 * Resolve `query` to matching symbols. Exact name match wins; falls back to
 * case-insensitive exact, then substring. `kind` narrows the candidates.
 */
export function matchSymbols(
  symbols: SymbolInfo[],
  query: string,
  kind?: SymbolKind,
): SymbolInfo[] {
  const q = query.trim();
  if (!q) return [];
  const pool = kind ? symbols.filter((s) => s.kind === kind) : symbols;
  const byName = pool.filter((s) => s.name === q);
  if (byName.length > 0) return byName;
  const byNameCi = pool.filter((s) => s.name.toLowerCase() === q.toLowerCase());
  if (byNameCi.length > 0) return byNameCi;
  const lower = q.toLowerCase();
  const bySubstring = pool.filter((s) => s.name.toLowerCase().includes(lower));
  return bySubstring.length > 0
    ? bySubstring
    : pool.filter((s) => (s.signature ?? '').toLowerCase().includes(lower));
}

function symbolFrom(
  name: string,
  kind: SymbolKind,
  start: number,
  end: number,
  source: string,
): SymbolInfo {
  return {
    name,
    kind,
    line: source.slice(0, start).split('\n').length,
    start,
    end,
    signature: signaturePreview(source, start, end),
  };
}

function signaturePreview(source: string, start: number, end: number): string {
  const nl = source.indexOf('\n', start);
  const endOfLine = nl === -1 ? end : nl;
  const first = source.slice(start, Math.min(endOfLine, end)).trim();
  return first.length > SIGNATURE_MAX ? `${first.slice(0, SIGNATURE_MAX)}…` : first;
}
