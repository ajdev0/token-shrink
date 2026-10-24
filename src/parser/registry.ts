/**
 * Language registry mapping file extensions to tree-sitter grammars and
 * pruning strategies. Each spec defines:
 *   - the web-tree-sitter language name
 *   - the `.wasm` file and the authoritative download URL
 *   - one or more S-expression queries (the "prune query") that match the
 *     implementation blocks to remove, plus the replacement token.
 *
 * The empty-query default of '' matches nothing, so the pruner leaves the
 * file untouched when a language has no registered prune rules yet.
 */

import path from 'node:path';

/** Source of truth mirror in the PRD language matrix. */
export type Replacement = {
  /** Token used to replace a pruned block. */
  token: string;
  /**
   * Optional regex, run against the raw block text. If it matches, the block
   * is kept instead of pruned. Used to preserve directive/header lines
   * ('use client/server') even when they live inside an otherwise-pruned body.
   */
  keepIf?: RegExp;
  /**
   * Token used instead when the block is the body of a control-flow
   * statement (`if`/`try`/`catch`/loops — parent type ending in
   * `statement`/`clause`) or an arrow function, where a bare comment would
   * leave the construct without a body and the skeleton unparseable.
   */
  bracedToken?: string;
  /** Only prune captures at least this many characters long. */
  minLength?: number;
  /** Skip captures of these node types (another rule already handles them). */
  skipNodeTypes?: string[];
  /**
   * Comment rule: doc comments (`/**`, `///`, `//!`) are compressed to their
   * summary + key tags, other comments are dropped (whole line when alone on
   * it). `token` is ignored.
   */
  comment?: boolean;
};

export interface LanguageSpec {
  /** Friendly name, used in logs and the report header. */
  name: string;
  /** web-tree-sitter `Language.load` file name. */
  wasm: string;
  /** Where to download the `.wasm` binary if not cached locally. */
  url: string;
  /** Extensions that map to this language: `.ts`, `.tsx`, etc. */
  extensions: string[];
  /**
   * One or more (query, replacement) pairs. Blocks matched by each query are
   * pruned bottom-up. Queries are combined; a block is pruned if it matches
   * any. This keeps small, frequently repeated constructs cheap to configure.
   */
  rules: { query: string; replacement: Replacement }[];
}

// ---------------------------------------------------------------------------
// Pruning workhorse: prune every `statement_block` / `block` node.
// ---------------------------------------------------------------------------

const BLOCK = {
  query: '(statement_block) @block',
  replacement: { token: '/* ... */', bracedToken: '{ /* ... */ }' },
};
const SWIFT_BLOCK = { query: '(statements) @block', replacement: { token: '/* ... */' } };
const GO_BLOCK = { query: '(block) @block', replacement: { token: '/* ... */' } };
const RUST_BLOCK = { query: '(block) @block', replacement: { token: '/* ... */' } };
const PY_BLOCK = { query: '(block) @block', replacement: { token: 'pass' } };
const C_BLOCK = { query: '(compound_statement) @block', replacement: { token: '/* ... */' } };
const JAVA_BLOCK = {
  query: '(block) @block',
  replacement: { token: '/* ... */' },
};
const PHP_BLOCK = {
  query: '(compound_statement) @block',
  replacement: { token: '/* ... */' },
};
const KOTLIN_BLOCK = { query: '(block) @block', replacement: { token: '/* ... */' } };
const DART_BLOCK = { query: '(block) @block', replacement: { token: '/* ... */' } };

// `const f = (x) => x * 2 + …`: expression bodies have no statement_block.
const ARROW_EXPR = {
  query: '(arrow_function body: (_) @body)',
  replacement: { token: '{ /* ... */ }', minLength: 40, skipNodeTypes: ['statement_block'] },
};

// Large top-level object/array initializers (config tables, fixtures).
const LITERAL_MIN = 200;
const topLevelLiteral = (node: string) =>
  `(program (lexical_declaration (variable_declarator value: (${node}) @lit)))\n` +
  `(export_statement (lexical_declaration (variable_declarator value: (${node}) @lit)))`;
const OBJECT_LITERAL = {
  query: topLevelLiteral('object'),
  replacement: { token: '{ /* ... */ }', minLength: LITERAL_MIN },
};
const ARRAY_LITERAL = {
  query: topLevelLiteral('array'),
  replacement: { token: '[ /* ... */ ]', minLength: LITERAL_MIN },
};

const COMMENT = { query: '(comment) @comment', replacement: { token: '', comment: true } };
const LINE_BLOCK_COMMENT = {
  query: '[(line_comment) (block_comment)] @comment',
  replacement: { token: '', comment: true },
};
const JS_EXTRAS = [ARROW_EXPR, OBJECT_LITERAL, ARRAY_LITERAL, COMMENT];

// Keeps `'use client'`/`'use server'` and top-level directive strings.
const DIRECTIVE_KEEP: Replacement = {
  token: '/* ... */',
  bracedToken: '{ /* ... */ }',
  keepIf: /^\s*'use (client|server)'/,
};

export const registry: Record<string, LanguageSpec> = {
  typescript: {
    name: 'TypeScript',
    wasm: 'tree-sitter-typescript.wasm',
    url: 'https://github.com/tree-sitter/tree-sitter-typescript/releases/latest/download/tree-sitter-typescript.wasm',
    extensions: ['.ts', '.cts', '.mts'],
    rules: [BLOCK, ...JS_EXTRAS],
  },
  javascript: {
    name: 'JavaScript',
    wasm: 'tree-sitter-javascript.wasm',
    url: 'https://github.com/tree-sitter/tree-sitter-javascript/releases/latest/download/tree-sitter-javascript.wasm',
    extensions: ['.js', '.cjs', '.mjs'],
    rules: [BLOCK, ...JS_EXTRAS],
  },
  tsx: {
    name: 'React / Next.js (TSX)',
    wasm: 'tree-sitter-tsx.wasm',
    url: 'https://github.com/tree-sitter/tree-sitter-typescript/releases/latest/download/tree-sitter-tsx.wasm',
    extensions: ['.tsx'],
    rules: [{ query: '(statement_block) @block', replacement: DIRECTIVE_KEEP }, ...JS_EXTRAS],
  },
  jsx: {
    name: 'React (JSX)',
    wasm: 'tree-sitter-javascript.wasm',
    url: 'https://github.com/tree-sitter/tree-sitter-javascript/releases/latest/download/tree-sitter-javascript.wasm',
    extensions: ['.jsx'],
    rules: [{ query: '(statement_block) @block', replacement: DIRECTIVE_KEEP }, ...JS_EXTRAS],
  },
  python: {
    name: 'Python',
    wasm: 'tree-sitter-python.wasm',
    url: 'https://github.com/tree-sitter/tree-sitter-python/releases/latest/download/tree-sitter-python.wasm',
    extensions: ['.py', '.pyi'],
    rules: [PY_BLOCK, COMMENT],
  },
  dart: {
    name: 'Dart / Flutter',
    wasm: 'tree-sitter-dart.wasm',
    url: 'https://github.com/UserNobody14/tree-sitter-dart.wasm/releases/latest/download/tree-sitter-dart.wasm',
    extensions: ['.dart'],
    rules: [DART_BLOCK],
  },
  swift: {
    name: 'Swift / SwiftUI',
    wasm: 'tree-sitter-swift.wasm',
    url: 'https://github.com/alex-pinkus/tree-sitter-swift/releases/latest/download/tree-sitter-swift.wasm',
    extensions: ['.swift'],
    rules: [SWIFT_BLOCK],
  },
  go: {
    name: 'Go',
    wasm: 'tree-sitter-go.wasm',
    url: 'https://github.com/tree-sitter/tree-sitter-go/releases/latest/download/tree-sitter-go.wasm',
    extensions: ['.go'],
    rules: [GO_BLOCK, COMMENT],
  },
  rust: {
    name: 'Rust',
    wasm: 'tree-sitter-rust.wasm',
    url: 'https://github.com/tree-sitter/tree-sitter-rust/releases/latest/download/tree-sitter-rust.wasm',
    extensions: ['.rs'],
    rules: [RUST_BLOCK, LINE_BLOCK_COMMENT],
  },
  java: {
    name: 'Java',
    wasm: 'tree-sitter-java.wasm',
    url: 'https://github.com/tree-sitter/tree-sitter-java/releases/latest/download/tree-sitter-java.wasm',
    extensions: ['.java'],
    rules: [JAVA_BLOCK, LINE_BLOCK_COMMENT],
  },
  kotlin: {
    name: 'Kotlin',
    wasm: 'tree-sitter-kotlin.wasm',
    url: 'https://github.com/fwcd/tree-sitter-kotlin/releases/latest/download/tree-sitter-kotlin.wasm',
    extensions: ['.kt', '.kts'],
    rules: [KOTLIN_BLOCK],
  },
  c: {
    name: 'C',
    wasm: 'tree-sitter-c.wasm',
    url: 'https://github.com/tree-sitter/tree-sitter-c/releases/latest/download/tree-sitter-c.wasm',
    extensions: ['.c', '.h'],
    rules: [C_BLOCK, COMMENT],
  },
  cpp: {
    name: 'C++',
    wasm: 'tree-sitter-cpp.wasm',
    url: 'https://github.com/tree-sitter/tree-sitter-cpp/releases/latest/download/tree-sitter-cpp.wasm',
    extensions: ['.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'],
    rules: [C_BLOCK, COMMENT],
  },
  php: {
    name: 'PHP',
    wasm: 'tree-sitter-php.wasm',
    url: 'https://github.com/tree-sitter/tree-sitter-php/releases/latest/download/tree-sitter-php.wasm',
    extensions: ['.php'],
    rules: [PHP_BLOCK, COMMENT],
  },
} satisfies Record<string, LanguageSpec>;

/** Map of extension -> language spec id, built once. */
const extensionIndex = new Map<string, string>();
for (const [id, spec] of Object.entries(registry)) {
  for (const ext of spec.extensions) {
    extensionIndex.set(ext, id);
  }
}

export type LanguageId = keyof typeof registry;

/** Return the language spec for a file path, or null if unsupported. */
export function languageForFile(filePath: string): LanguageSpec | null {
  const langId = extensionIndex.get(path.extname(filePath).toLowerCase());
  if (!langId) return null;
  return registry[langId];
}

/** All languages that have at least one prune rule. */
export const supportedLanguageIds = Object.keys(registry) as LanguageId[];

/** Convenience: list every known extension. */
export const allExtensions = [...extensionIndex.keys()];
