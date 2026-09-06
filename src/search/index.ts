/**
 * In-memory symbol signature index for `search_symbol_signatures`.
 *
 * Zero-dependency alternative to SQLite FTS5: we index only symbol metadata
 * (names + signature lines) produced during the tree-sitter analyze pass, so
 * lookups stay well under a millisecond at repository scale without adding a
 * native module to the dependency tree.
 *
 * The index is kept fresh by the watcher: files are added/removed as chokidar
 * events and the analyze pass run.
 */

import type { SymbolInfo, SymbolKind } from '../parser/symbols.js';
import type { CacheEntry } from '../watcher/sync.js';

export interface SymbolDoc extends SymbolInfo {
  /** Absolute path of the containing file. */
  filePath: string;
}

export interface SymbolHit extends SymbolDoc {
  /** Higher is better. */
  score: number;
  /** Human label like `file.ts:12 — fn(a: number): number`. */
  label: string;
}

type ScoredHit = SymbolDoc & { score: number };

/** Split an identifier into searchable words (camelCase + snake_case aware). */
function words(text: string): string[] {
  const out = new Set<string>();
  for (const part of text.split(/[^A-Za-z0-9_$]+/)) {
    if (!part) continue;
    // camelCase / PascalCase boundaries.
    for (const seg of part.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
      const w = seg.toLowerCase();
      if (w) out.add(w);
    }
    // snake_case parts.
    for (const seg of part.split('_')) {
      const w = seg.toLowerCase();
      if (w) out.add(w);
    }
  }
  return [...out];
}

export class SymbolSearch {
  private docs: SymbolDoc[] = [];
  private byFile = new Map<string, SymbolDoc[]>();
  private inverted = new Map<string, number[]>();

  get size(): number {
    return this.docs.length;
  }

  /** Replace the docs for one file (or remove when `symbols` is empty). */
  setFile(filePath: string, symbols: SymbolInfo[]): void {
    this.removeFile(filePath);
    if (symbols.length === 0) return;
    const docs: SymbolDoc[] = symbols.map((s) => ({ ...s, filePath }));
    const ids = docs.map((d) => {
      const id = this.docs.length;
      this.docs.push(d);
      for (const w of words(`${d.name}`)) {
        const list = this.inverted.get(w) ?? [];
        list.push(id);
        this.inverted.set(w, list);
      }
      return id;
    });
    this.byFile.set(filePath, docs);
    void ids; // ids are implicit in `this.docs`
  }

  removeFile(filePath: string): void {
    const docs = this.byFile.get(filePath);
    if (!docs) return;
    const removed = new Set(docs);
    // Rebuild the arrays from scratch: file-level churn is rare enough that
    // this stays far cheaper than a persistent per-doc tombstones scheme.
    this.docs = this.docs.filter((d) => !removed.has(d));
    this.byFile.delete(filePath);
    this.rebuildInverted();
  }

  /** Bulk-load a whole cache (used at attach time and cold lazy builds). */
  loadCache(entries: ReadonlyMap<string, CacheEntry>): void {
    this.docs = [];
    this.byFile.clear();
    for (const [abs, entry] of entries) {
      if (!entry.symbols || entry.symbols.length === 0) continue;
      const docs: SymbolDoc[] = entry.symbols.map((s) => ({ ...s, filePath: abs }));
      this.byFile.set(abs, docs);
      this.docs.push(...docs);
    }
    this.rebuildInverted();
  }

  /** Ranked symbol hits for `query`. */
  search(
    query: string,
    opts: { maxResults?: number; kind?: SymbolKind } = {},
  ): SymbolHit[] {
    const maxResults = opts.maxResults ?? 10;
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const queryWords = words(q);
    let candidates: SymbolDoc[];
    if (queryWords.length > 0) {
      const ids = new Set<number>();
      for (const w of queryWords) {
        const post = this.inverted.get(w);
        if (post) for (const id of post) ids.add(id);
      }
      candidates = [...ids].map((id) => this.docs[id]);
    } else {
      candidates = this.docs;
    }
    if (opts.kind) candidates = candidates.filter((d) => d.kind === opts.kind);

    const scored = candidates
      .map((d) => this.score(d, q, queryWords))
      .filter((s): s is ScoredHit => s !== null)
      .sort((a, b) => b.score - a.score || a.line - b.line)
      .slice(0, maxResults);

    return scored.map((s) => ({ ...s, label: this.label(s) }));
  }

  private score(
    d: SymbolDoc,
    q: string,
    queryWords: string[],
  ): ScoredHit | null {
    const name = d.name.toLowerCase();
    let score = 0;
    if (name === q) score += 100;
    if (name.startsWith(q)) score += 60;
    if (name.includes(q)) score += 30;
    if ((d.signature ?? '').toLowerCase().includes(q)) score += 8;
    for (const w of queryWords) {
      if (name.includes(w)) score += 4;
      if ((d.signature ?? '').toLowerCase().includes(w)) score += 1;
    }
    if (score <= 0) return null;
    return { ...d, score };
  }

  private label(d: SymbolDoc): string {
    const sig = d.signature && d.signature.length > 0 ? ` — ${d.signature}` : '';
    return `${d.filePath}:${d.line}${sig}`;
  }

  private rebuildInverted(): void {
    this.inverted.clear();
    this.docs.forEach((d, id) => {
      for (const w of words(d.name)) {
        const list = this.inverted.get(w) ?? [];
        list.push(id);
        this.inverted.set(w, list);
      }
    });
  }
}

