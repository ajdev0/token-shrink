# token-shrink

A **local-first, framework-aware token reduction engine** — a polyglot AST semantic proxy and MCP server. It prunes implementation bodies out of **dependency files** while preserving every type signature, interface, and module export, so LLM agents see the full shape of the code at a fraction of the tokens.

> **The 80–90% reduction target**: full type information, no implementation noise. Ring 0 (your active file) stays complete; Ring 1 (its direct imports) is delivered as pruned skeletons.

---

## How it works

```
       active file                       imports (Ring 1)
  ┌──────────────────┐       ┌──────────────────────┐
  │  src/page.ts     │  ──►  │  src/util.ts         │
  └──────────────────┘       └──────────────────────┘
          ▾                              ▾
  tree-sitter (WASM) ─────────────► prune impl blocks
       parse & query               keep interfaces · types ·
                                   signatures · exports
                                          ▾
                                  pruned skeleton (Ring 0 full source)
                                          ▾
                          Compressed Code Context (Markdown)
                                  │               │
                            via MCP (stdio)   via HTTP (Fastify)
                      get_compressed_code_context  POST /v1/context
```

Pipeline stages:

1. **Parse** — `web-tree-sitter` loads a `.wasm` grammar per language (auto-downloaded on first run).
2. **Prune** — an S-expression query matches implementation blocks (`statement_block`, `block`, `compound_statement`…), which are replaced with a short token (`/* ... */`, or `pass` for Python) using **descending-order splicing** so offsets stay valid.
3. **Watch** — `chokidar` watches the repo, `sha1`-hashes file contents, and refreshes the cache only on change.
4. **Assemble** — the active file's imports are resolved and merged into a Markdown context payload (Ring 0 + Ring 1).

---



## Install

Requires **Node.js 18+**.

```bash
# run anywhere without installing
#   --root   project root   --port   http port   --host   bind address
npx @ajdev0/token-shrink --root /path/to/project

# or install locally
npm install @ajdev0/token-shrink
```



### Build from source

```bash
# install deps
npm install

# compile (tsup -> dist/), typecheck, and run tests
npm run build
npm run typecheck
npm test
```

The build produces three binaries:


| Binary               | Entry           | Purpose                                      |
| -------------------- | --------------- | -------------------------------------------- |
| `@ajdev0/token-shrink`       | `dist/cli.cjs`   | Fastify HTTP server (`POST /v1/context`)     |
| `@ajdev0/token-shrink-mcp`   | `dist/mcp.cjs`   | MCP stdio server for AI agents               |
| library              | `dist/index.js` | `prune()`, `assemble()`, `createWatcher()` … |


---

## WASM grammars (auto-download)

Grammars are fetched from the official tree-sitter GitHub releases on **first use** and cached in `wasm/`:

```text
wasm/
├── tree-sitter-typescript.wasm
├── tree-sitter-javascript.wasm
├── tree-sitter-tsx.wasm
├── tree-sitter-python.wasm
├── tree-sitter-go.wasm
├── ...
```

- First run requires network access; afterwards everything is offline and fast.
- Files are written atomically (`*.tmp` → rename) with an in-flight lock, so concurrent first-run parses never corrupt the cache.

---



## Usage



### 1. MCP server (AI agents — Cursor, Claude, Cline, etc.)

Run the stdio MCP server and expose the `get_compressed_code_context` tool:

```bash
# point it at your project
token-shrink-mcp --root /path/to/project

# root also works via env or cwd
ROOT=/path/to/project token-shrink-mcp
cd /path/to/project && token-shrink-mcp
```

> **Zero-config auto-detect**: `--root` is optional. When neither `--root` nor
> `ROOT` is set, the server finds the project itself — it walks up for VCS
> directories (`.git`/`.hg`/`.svn`) or project manifests (`package.json`,
> `pyproject.toml`, `go.mod`, `Cargo.toml`, …), first around the directory the
> client launched it from, and otherwise lazily from the `activeFilePath` of the
> first `get_compressed_code_context` call (re-pointing if a later call opens a
> different project). The config examples below keep `--root` so the behavior is
> pinned and the index is already warm before the first request — but you may
> simply drop the `--root` argument entirely.

**Cursor MCP config** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "token-shrink": {
      "command": "token-shrink-mcp",
      "args": ["--root", "/absolute/path/to/your/project"]
    }
  }
}
```

**Claude Code MCP config** — add it to the project's `.mcp.json`, or register with the Claude CLI:

```bash
# register the server for this project
claude mcp add token-shrink -- token-shrink-mcp --root /path/to/project
# persistent flag: -- transport stdio
claude mcp add token-shrink --transport stdio -- token-shrink-mcp --root /path/to/project
```

or place in `.claude/settings.json` / project `.mcp.json`:

```json
{
  "mcpServers": {
    "token-shrink": {
      "command": "token-shrink-mcp",
      "args": ["--root", "/path/to/project"]
    }
  }
}
```

**Cline MCP config** — add it to the project's `.mcp.json` (or `mcp.json` in the `.cline` settings directory), or add the server via the Cline UI (**MCP Servers → Configure MCP Servers**):

```json
{
  "mcpServers": {
    "token-shrink": {
      "command": "token-shrink-mcp",
      "args": ["--root", "/path/to/project"]
    }
  }
}
```

**Auto rule**: by default the server writes agent integration rules so the tool is used automatically on every prompt:

- **Cursor**: `.cursor/rules/token-shrink.mdc`
- **Claude Code**: `.claude/rules/token-shrink.md`
- **Cline**: `.clinerules/token-shrink.md` (Cline's `.clinerules/` directory — every `.md`/`.txt` file there is loaded on every task)

All are sentinel-tagged and never rewrite a user-authored file at the same path. Repeated starts are no-ops. Choose the target(s) with `--rule-target=cursor|claude|cline|all` (default `all`, comma-separated values allowed):

```bash
# only Claude Code
token-shrink-mcp --root /path/to/project --rule-target=claude

# Cursor + Cline, no Claude rule
token-shrink-mcp --root /path/to/project --rule-target=cursor,cline

# completely disable auto-rules
token-shrink-mcp --root /path/to/project --no-create-rule
```

Opt out also via `--create-rule=false` or `TOKEN_SHRINK_CREATE_RULE=0`.

**MCP tools**

`get_compressed_code_context` — compressed context for one or more active files (Ring 0 full, Ring 1 pruned):

| Argument         | Type       | Required | Description                                        |
| ---------------- | ---------- | -------- | -------------------------------------------------- |
| `activeFilePath` | `string`   | no*      | Single file the agent is working on                |
| `activeFiles`    | `string[]` | no*      | Multiple Ring-0 files (combined Ring 1)            |
| `maxSkeletons`   | `number`   | no       | Cap on Ring-1 files (default `50`, max `200`)      |
| `maxTokens`      | `number`   | no       | Hard token budget; Ring 1 is relevance-packed to fit |
| `includeStats`   | `boolean`  | no       | Append approximate token counts                    |

\* Provide exactly one of `activeFilePath` / `activeFiles`. Ring 0 stays full; Ring 1 is the union of each file's local imports, minus files already in Ring 0.

`expand_symbol({ filePath, symbolName, maxMatches? })` — when a skeleton isn't enough, returns the **full, un-pruned definition** (function/class/method/… bodies included) for the named symbol in that file. Overloads and same-named members are all returned.

`git_diff_context({ scope?, base?, head?, includeUntracked?, maxFiles?, maxImporters?, maxSkeletons?, maxTokens? })` — impact analysis for changed code:
- `scope`: `worktree` (default) · `staged` · `branch` (`base...head`, defaults `HEAD~1...HEAD`)
- changed files are emitted in full as Ring 0; their imports **and** the files that import them (file-level callers) are attached as pruned skeletons. Great for PR reviews and multi-file regressions where there is no single active file.

`search_symbol_signatures({ query, maxResults?, kind? })` — repo-wide lookup of definitions backed by an in-memory index of the tree-sitter symbol pass. Returns compact `` `file:line — signature` `` lines (not raw file dumps), ranked exact → prefix → substring.

**Project config (`.tokenshrinkrc.json`)** at the repository root — hot-reloaded:

```json
{
  "ignorePatterns": ["**/dist/**", "**/generated/**"],
  "keepUnpruned": ["src/types/global.d.ts", "lib/models/*.dart"],
  "preserveAnnotations": ["@keepContext", "@api"]
}
```

- `ignorePatterns` — globs that are never indexed or watched.
- `keepUnpruned` — files that are indexed but never pruned (always full text).
- `preserveAnnotations` — definitions (and everything nested in them) preceded by `@marker` are kept fully un-pruned.

Invalid JSON logs a warning and falls back to defaults; editing the file while the server runs re-indexes automatically.

### 2. HTTP server (Fastify)

```bash
token-shrink --root /path/to/project --port 3000 --max-tokens 4000
# env equivalents: ROOT=… PORT=… HOST=…
```

| Route         | Method | Body                                                   | Returns                          |
| ------------- | ------ | ------------------------------------------------------ | -------------------------------- |
| `/health`     | `GET`  | —                                                      | status, root, indexed file count |
| `/v1/context` | `POST` | `{ activeFilePath? \| activeFiles?, maxSkeletons?, maxTokens?, includeStats? }` | assembled Markdown + deps + stats |


```bash
curl -s http://localhost:3000/health
# {"status":"ok","service":"token-shrink","version":"2.0.0","root":".","indexed":182}

curl -s -X POST http://localhost:3000/v1/context \
  -H 'Content-Type: application/json' \
  -d '{"activeFiles":["./src/page.ts","./src/api.ts"],"includeStats":true}'
```



### 3. Library API

```ts
import { prune, assemble, createWatcher } from 'token-shrink';

// prune a single file -> skeleton (keeps signatures, strips bodies)
const { code, removed } = await prune('src/util.ts', sourceText);

// assemble context for an active file from a warm cache
const { markdown } = assemble('src/page.ts', watcher.cache.entries, {
  includeStats: true,
});

// incremental watcher
const watcher = createWatcher({ root: process.cwd(), ignored: ['node_modules'] });
await watcher.indexAll();
```

---



## Supported languages

S-expression queries match implementation blocks; interfaces, signatures, and exports are never touched. The `Block node` column shows the AST node that gets collapsed during pruning.


| Language        | Extensions                              | Grammar wasm                  | Block node           |
| --------------- | --------------------------------------- | ----------------------------- | -------------------- |
| TypeScript      | `.ts` `.cts` `.mts`                     | `tree-sitter-typescript.wasm` | `statement_block`    |
| JavaScript      | `.js` `.cjs` `.mjs`                     | `tree-sitter-javascript.wasm` | `statement_block`    |
| React / Next.js | `.tsx`                                  | `tree-sitter-tsx.wasm`        | `statement_block`¹   |
| React (JSX)     | `.jsx`                                  | `tree-sitter-javascript.wasm` | `statement_block`¹   |
| Python          | `.py` `.pyi`                            | `tree-sitter-python.wasm`     | `block` → `pass`     |
| Dart / Flutter  | `.dart`                                 | `tree-sitter-dart.wasm`       | `block`              |
| Swift / SwiftUI | `.swift`                                | `tree-sitter-swift.wasm`      | `statements`         |
| Go              | `.go`                                   | `tree-sitter-go.wasm`         | `block`              |
| Rust            | `.rs`                                   | `tree-sitter-rust.wasm`       | `block`              |
| Java            | `.java`                                 | `tree-sitter-java.wasm`       | `block`              |
| Kotlin          | `.kt` `.kts`                            | `tree-sitter-kotlin.wasm`     | `block`              |
| C               | `.c` `.h`                               | `tree-sitter-c.wasm`          | `compound_statement` |
| C++             | `.cc` `.cpp` `.cxx` `.hpp` `.hh` `.hxx` | `tree-sitter-cpp.wasm`        | `compound_statement` |
| PHP             | `.php`                                  | `tree-sitter-php.wasm`        | `compound_statement` |


> ¹ TSX/JSX also preserve `'use client'` / `'use server'` directive lines inside otherwise-pruned bodies (framework-aware).

Language IDs: `typescript · javascript · tsx · jsx · python · dart · swift · go · rust · java · kotlin · c · cpp · php`.

---



## Example

**Input** `src/util.ts`

```ts
export interface User {
  id: number;
  name: string;
}
export function buildGreeting(u: User) {
  const parts = [u.name, u.email];
  return parts.join(' | ');
}
export const formatEmail = (u: User) => {
  return u.email.toLowerCase().trim();
};
```

**Pruned skeleton (Ring 1)** — signatures and the interface intact, bodies collapsed:

```ts
export interface User {
  id: number;
  name: string;
}
export function buildGreeting(u: User) /* ... */
export const formatEmail = (u: User) => /* ... */;
```

---



## Design notes

- **Bottom-up splicing** — ranges are sorted by start index descending and replaced in place, so earlier offsets never shift and the output stays a valid, parseable file.
- **Regex-based import extraction** — resilient across languages; resolves relative imports (`./x`, `../y`), aliases (`@/`, `~`), and skips bare package specifiers.
- **Incremental hashing** — files are re-pruned only when their `sha1` hash changes; the watcher is debounced (100 ms) and zero-CPU while idle.
- **Ram-safe watchers** — sockets / non-regular files are never opened with `fs.watch`, so stray unix sockets in the tree can't crash the server.

---



## Project layout

```
token-shrink/
├── package.json / tsconfig.json / tsup.config.ts / vitest.config.ts
├── src/
│   ├── index.ts             # library entry (exports)
│   ├── cli.ts               # Fastify HTTP server
│   ├── mcp.ts               # MCP stdio server
│   ├── parser/
│   │   ├── registry.ts      # extension → language spec + S-queries
│   │   ├── wasm.ts          # auto-download + cache of .wasm files
│   │   └── pruner.ts        # prune(filePath, source) → skeleton
│   ├── watcher/
│   │   └── sync.ts          # chokidar watch + hash cache + import graph
│   └── server/
│       └── assembler.ts     # Ring 0 + Ring 1 Markdown payload
├── tests/                   # pruning integrity + token-reduction tests
└── wasm/                    # auto-downloaded grammars (gitignored)
```



## License

MIT