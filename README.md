# token-shrink

**Cut the tokens your AI coding agent reads, without hiding how your code fits together.**

When an agent such as Claude Code, Cursor or Cline works on a file, it also needs the files that file imports. token-shrink sends those imported files as **skeletons**: every type, interface and function signature stays, and the function bodies are left out. The agent still knows how to call everything correctly, and you pay for far fewer tokens.

```text
⚡ token-shrink: 29,597 → 12,274 tokens (−17,323 · 58.5% saved)
```

On its own source code, token-shrink removes about **70%** of the tokens. It works with 14 languages, runs entirely on your machine, and needs no API key.

---

## Contents

- [Quick start (Claude Code)](#quick-start-claude-code)
- [Cursor, Cline and other agents](#cursor-cline-and-other-agents)
- [See how much you save](#see-how-much-you-save)
- [Troubleshooting](#troubleshooting)
- [What your agent gets](#what-your-agent-gets)
- [Project settings](#project-settings)
- [Server options](#server-options)
- [Supported languages](#supported-languages)
- [Updating](#updating)
- [Advanced: HTTP server, library, tool reference](#advanced)
- [How it works](#how-it-works)
- [Development](#development)

---

## Quick start (Claude Code)

You need **Node.js 18 or newer** (`node --version` to check). There's nothing else to install, because `npx` downloads token-shrink when it first runs.

### 1. Add the server

**Recommended: once, for all your projects.** Run this from any folder:

```bash
claude mcp add token-shrink --scope user -- npx -y -p @ajdev0/token-shrink token-shrink-mcp
```

Leave out `--root` here. token-shrink finds the project you're working in by itself, from the nearest `.git` folder or `package.json`.

**Or: for one project only.** Run this from inside that project's folder:

```bash
cd /path/to/your-project
claude mcp add token-shrink -- npx -y -p @ajdev0/token-shrink token-shrink-mcp --root .
```

> **Run that command in the project folder, not your home folder.** Without `--scope user`, Claude Code saves the server only for the folder you ran the command in. If you run it in your home folder, it won't appear when you open Claude in your project. See [Troubleshooting](#troubleshooting).

### 2. Restart Claude Code and check

Open Claude Code in your project and type `/mcp`. You should see **token-shrink** listed as connected. From a terminal, `claude mcp list` shows the same thing:

```text
token-shrink: npx -y -p @ajdev0/token-shrink token-shrink-mcp - ✔ Connected
```

### 3. Just work

You don't need to change how you prompt. The first time the server starts in a project, it writes a small rule file (`.claude/rules/token-shrink.md`) that tells Claude to use token-shrink before working on a file. The first run also downloads the parsers for your languages, so it needs internet access once.

---

## Cursor, Cline and other agents

Any agent that supports MCP servers can use token-shrink. Use this server definition:

```json
{
  "mcpServers": {
    "token-shrink": {
      "command": "npx",
      "args": ["-y", "-p", "@ajdev0/token-shrink", "token-shrink-mcp", "--root", "/absolute/path/to/your-project"]
    }
  }
}
```

| Agent | Where the definition goes | Rule file token-shrink writes |
| ----- | ------------------------- | ----------------------------- |
| Cursor | `.cursor/mcp.json` in your project | `.cursor/rules/token-shrink.mdc` |
| Cline | MCP Servers → Configure MCP Servers | `.clinerules/token-shrink.md` |
| Other MCP clients | wherever that client keeps MCP servers | none; ask the agent to call `get_compressed_code_context` |

By default, rule files are written for Claude Code, Cursor and Cline. Pick only the ones you use with `--rule-target` (see [Server options](#server-options)).

---

## See how much you save

Every request is measured against what the same files would cost without token-shrink. The totals are saved in your project, in `.token-shrink/stats.json`.

### In your terminal

Run this **inside your project folder**:

```bash
npx -y -p @ajdev0/token-shrink token-shrink stats
```

Example output:

```text
⚡ last call (get_compressed_code_context): 29,597 → 12,274 tokens (−17,323 · 58.5% saved)
⚡ session · 6 calls: 84,920 → 32,610 tokens (−52,310 · 61.6% saved)
⚡ all time · 41 calls: 512,400 → 188,950 tokens (−323,450 · 63.1% saved)
```

To check a different folder, add `--root /path/to/project`. If you see `No token-shrink stats yet`, the agent hasn't asked for context in that project yet.

### In Claude Code's status line (yellow, always visible)

**1. Download the status line script:**

```bash
curl -fsSL -o ~/.claude/token-shrink-statusline.mjs \
  https://raw.githubusercontent.com/ajdev0/token-shrink/main/hooks/claude/statusline.mjs
```

**2. Add this to `~/.claude/settings.json`** (create the file if it doesn't exist):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/token-shrink-statusline.mjs"
  }
}
```

Restart Claude Code. Below the prompt you'll see something like this, in yellow:

```text
⚡ token-shrink −17,323 tokens (58.5%) · session −52,310 (61.6%)
```

The line stays empty until token-shrink has handled a request in the current project. If you already have a `statusLine` setting, this replaces it.

### Good to know

- Add `.token-shrink/` to your project's `.gitignore`. The stats are personal and change constantly.
- To turn stats off, add `--no-stats` to the server command, or set `TOKEN_SHRINK_STATS=0`.
- Colors follow your terminal. `NO_COLOR=1` turns them off, and `FORCE_COLOR=1` forces them on.

---

## Troubleshooting

### "MCP server token-shrink already exists in local config", but it isn't in `/mcp`

You added it earlier from a different folder, often your home folder. A server added without `--scope user` only shows up in the folder it was added from. To fix it, remove that copy and add it for all projects:

```bash
cd ~                                            # the folder you originally added it from
claude mcp remove token-shrink --scope local
claude mcp add token-shrink --scope user -- npx -y -p @ajdev0/token-shrink token-shrink-mcp
```

Then restart Claude Code in your project.

> If you use `--scope user`, **don't** add `--root /some/project`. Every project would then get that one project's code.

### It shows as failed in `/mcp`

- Check your Node version with `node --version`. You need 18 or newer.
- Run the server by hand to see its error: `npx -y -p @ajdev0/token-shrink token-shrink-mcp --root .`, then press Ctrl+C to stop it.
- The first run downloads parsers from GitHub. Behind a firewall or offline, files are still indexed, but they aren't shrunk until the download succeeds.

### Claude doesn't seem to use it

- Check that `.claude/rules/token-shrink.md` exists in your project. If you started the server with `--no-create-rule`, ask Claude directly: "use get_compressed_code_context for src/app.ts".
- The rule only applies to code files (`.ts`, `.py`, `.go` and so on), not to Markdown or JSON.

### I'm getting an older version

`npx` can reuse a version it downloaded earlier. To always get the newest, use `@ajdev0/token-shrink@latest` in the server command. Check what's published with `npm view @ajdev0/token-shrink version`.

---

## What your agent gets

token-shrink adds four tools. **You don't call them yourself.** The rule file tells your agent when to use each one.

| Tool | What it does | When it's used |
| ---- | ------------ | -------------- |
| `get_compressed_code_context` | Your file in full, plus skeletons of the files it imports | Before working on any code file |
| `git_diff_context` | The changed files, their imports, and the files that call them | Reviews, multi-file edits, uncommitted changes |
| `expand_symbol` | The complete code of one function, class or method | When a skeleton isn't enough |
| `search_symbol_signatures` | Where something is defined, as `file:line — signature` lines | When a name isn't in the context yet |

### What a skeleton looks like

`src/user.ts` as written:

```ts
/**
 * Builds the label shown next to a user's avatar. Falls back to
 * the part of the email before the @ when no name is set.
 * @param u the user to label
 */
export function displayName(u: User): string {
  // prefer the real name when there is one
  if (u.name) {
    return u.name.trim();
  }
  return u.email.split('@')[0];
}
```

What the agent receives:

```ts
/** Builds the label shown next to a user's avatar. @param u the user to label */
export function displayName(u: User): string /* ... */
```

What gets trimmed:

- **Function and method bodies**, in all languages.
- **Long one-line arrow functions** (over 40 characters of expression).
- **Large constant objects and arrays** (over 200 characters at the top of a file). Type annotations and `as const` values stay.
- **Comments.** Doc comments shrink to their first sentence plus `@param` and `@returns`, and other comments are removed.
- **Unused exports**, if you opt in with `ringOneMode: "used"`. A dependency then keeps only what your file imports from it.
- **The active file, when it's too big for the budget.** Pass `focusLines` and only the function you're editing stays whole.

The agent always gets the file it's actually editing in full, unless that file alone is bigger than the token budget.

---

## Project settings

Optionally, add a `.tokenshrinkrc.json` file to your project root:

```json
{
  "ignorePatterns": ["**/generated/**"],
  "keepUnpruned": ["src/types/global.d.ts"],
  "preserveAnnotations": ["@api"],
  "ringOneMode": "used"
}
```

| Setting | What it does |
| ------- | ------------ |
| `ignorePatterns` | Folders and files to leave out entirely (glob patterns). |
| `keepUnpruned` | Files always sent in full, such as shared type definitions. |
| `preserveAnnotations` | Mark a function with a comment such as `// @api` and its body is kept. |
| `ringOneMode` | `"used"` keeps only the exports your file imports (TypeScript and JavaScript). The default, `"full"`, keeps the whole skeleton. |
| `autoWorkflow` | `false` makes the rule file lighter, so the agent decides on its own when to use the extra tools. |

The MCP server picks up changes to this file while it runs. If the JSON is invalid, a warning is logged and the defaults are used.

---

## Server options

Add these after `token-shrink-mcp` in the server command.

| Option | What it does |
| ------ | ------------ |
| `--root <folder>` | The project to work on. Optional; without it the project is detected automatically. Same as the `ROOT` environment variable. |
| `--rule-target=claude` | Which rule files to write: `claude`, `cursor`, `cline` or `all` (default). Comma-separate several: `--rule-target=claude,cursor`. |
| `--no-create-rule` | Don't write any rule files. Same as `TOKEN_SHRINK_CREATE_RULE=0`. |
| `--no-stats` | Don't save savings to `.token-shrink/stats.json`. Same as `TOKEN_SHRINK_STATS=0`. |

Example, for Claude Code only and without stats:

```bash
claude mcp add token-shrink --scope user -- npx -y -p @ajdev0/token-shrink token-shrink-mcp --rule-target=claude --no-stats
```

---

## Supported languages

| Language | File extensions |
| -------- | --------------- |
| TypeScript | `.ts` `.mts` `.cts` |
| JavaScript | `.js` `.mjs` `.cjs` |
| React (TSX / JSX) | `.tsx` `.jsx` |
| Python | `.py` `.pyi` |
| Go | `.go` |
| Rust | `.rs` |
| Java | `.java` |
| Kotlin | `.kt` `.kts` |
| Swift | `.swift` |
| Dart / Flutter | `.dart` |
| C | `.c` `.h` |
| C++ | `.cc` `.cpp` `.cxx` `.hpp` `.hh` `.hxx` |
| PHP | `.php` |

Unused-exports filtering (`ringOneMode: "used"`) works for TypeScript and JavaScript; other languages get the full skeleton. In React files, `'use client'` / `'use server'` directives are kept.

---

## Updating

- **With `npx`** (the setup above), you get new releases automatically. If an update doesn't arrive, use `@ajdev0/token-shrink@latest` in the server command and restart your agent.
- **Rule files** (`.claude/rules/token-shrink.md` and the others) are upgraded automatically when a release changes them. A rule file you wrote yourself is never touched. Edits to a generated file are kept until a release changes the rule again, so put custom instructions in a separate rule file.

---

## Advanced

### HTTP server

For tools that aren't MCP clients, run a local HTTP server:

```bash
npx -y -p @ajdev0/token-shrink token-shrink --root . --port 3000
```

```bash
curl -s -X POST http://localhost:3000/v1/context \
  -H 'Content-Type: application/json' \
  -d '{"activeFilePath": "./src/page.ts", "maxTokens": 8000}'
```

| Route | Method | Body | Returns |
| ----- | ------ | ---- | ------- |
| `/health` | `GET` | — | status, version, root, indexed file count |
| `/v1/context` | `POST` | `{ activeFilePath \| activeFiles, maxTokens?, maxSkeletons?, focusLines?, ringOneMode?, includeStats? }` | `markdown`, `dependencies`, `unresolved`, `tokenStats` |

`tokenStats` includes `originalTokens`, `totalTokens`, `savedTokens` and `reductionPct`. The server prints the yellow savings line after each request. Other options: `--host` (default `0.0.0.0`), `--max-tokens` (a default budget) and `--silent`. The HTTP server reads `.tokenshrinkrc.json` once at startup.

### Library

```bash
npm install @ajdev0/token-shrink
```

```ts
import { prune, createWatcher, assembleContext } from '@ajdev0/token-shrink';

// One file → skeleton
const { code } = await prune('src/user.ts', source);

// A whole project, kept up to date as files change
const watcher = createWatcher({ root: process.cwd() });
await watcher.indexAll();
const { markdown, tokenStats } = await assembleContext(['src/profile.ts'], watcher.cache.entries, {
  maxTokens: 8000,
  ringOneMode: 'used',
});
```

Works with both `import` and `require`. Other exports include `analyze`, `assembleMany`, `formatSavings`, `readStats` and `gitChangedFiles`.

### Tool reference

**`get_compressed_code_context`**

| Argument | Type | Description |
| -------- | ---- | ----------- |
| `activeFilePath` | `string` | The file being worked on. Use this or `activeFiles`. |
| `activeFiles` | `string[]` | Several files to send in full; their imports are combined. |
| `maxTokens` | `number` | Budget for the whole reply. Your files come first, then imports, most-used first. Anything that doesn't fit is listed in a note. |
| `focusLines` | `number[]` or `{ [path]: number[] }` | Lines being edited. If your file alone exceeds `maxTokens`, only the definitions around these lines keep their bodies. |
| `ringOneMode` | `"used"` \| `"full"` | Overrides the project setting for this call. |
| `maxSkeletons` | `number` | Maximum number of imported files (default 50, max 200). |
| `includeStats` | `boolean` | Adds token counts at the end of the reply. |

**`git_diff_context`**: `scope` (`worktree` default, `staged`, or `branch` for `base...head`), `base`, `head`, `includeUntracked`, `maxFiles` (default 30), `maxImporters` (default 20), `maxSkeletons`, `maxTokens`, `ringOneMode`. With a budget, the reply is packed as changed files, then their imports, then the files calling them. If the changed files alone are over budget, they're trimmed to the changed definitions.

**`expand_symbol`**: `filePath`, `symbolName`, `maxMatches`. Returns the complete definition, including all overloads.

**`search_symbol_signatures`**: `query`, `kind`, `maxResults`. Matches are ranked exact, then prefix, then substring.

---

## How it works

```text
  your file (Ring 0)  ──imports──►  dependencies (Ring 1)  ◄──imports──  callers (Ring 2, git_diff_context)
        full text                       skeletons                            skeletons
```

1. **Parse.** Each file is parsed with [tree-sitter](https://tree-sitter.github.io/), so cuts follow the real syntax instead of guesses. Parsers (`.wasm` files) are downloaded once, pinned to exact versions, and cached.
2. **Prune.** Bodies, long arrows, large literals and comments are replaced with placeholders such as `/* ... */` (`pass` in Python). The result is still valid code.
3. **Watch.** A file watcher re-prunes a file only when its contents change, so skeletons are ready before the agent asks.
4. **Assemble.** Your file, its imports and, for reviews, its callers are packed into one Markdown reply, within the token budget if one is set.

---

## Development

```bash
git clone https://github.com/ajdev0/token-shrink.git
cd token-shrink
npm install
npm run build        # compile to dist/
npm run typecheck
npm test             # offline suite
NETWORK=1 npx vitest run tests/grammars.test.ts   # downloads and checks every language parser
```

Releases are published to npm by `.github/workflows/publish.yml` when a version tag is pushed (`npm version minor && git push --follow-tags`).

## License

MIT
