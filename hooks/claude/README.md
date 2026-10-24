# Claude Code hooks (optional auto-context)

Copy these into your project and merge `settings.example.json` into
`.claude/settings.json`:

```bash
mkdir -p .claude/hooks
cp hooks/claude/git-impact.mjs hooks/claude/statusline.mjs .claude/hooks/
cp hooks/claude/settings.example.json .claude/settings.example.json
# then merge the "statusLine" and "hooks" blocks from settings.example.json
# into your .claude/settings.json (project- or user-level)
```

What it does:

- `SessionStart` + `Stop` hooks run `git-impact.mjs`, which prints a compact
  **git-impact summary** (changed files, unstaged/staged diff stat) whenever the
  working tree is dirty.
- Claude Code surfaces hook stdout in the session, so diff context is injected
  automatically — no prompt engineering required.

- The `statusLine` runs `statusline.mjs`, which shows **in yellow** how many
  tokens token-shrink saved on the last call and over the session, e.g.
  `⚡ token-shrink −10,544 tokens (84.5%) · session −52,310 (81.2%)`. It reads
  `.token-shrink/stats.json`, which the MCP server updates after every
  `get_compressed_code_context` / `git_diff_context` call (disable with
  `--no-stats` or `TOKEN_SHRINK_STATS=0`).

Notes & limits:

- This is the lightweight, always-on complement to the heavier
  `git_diff_context` MCP tool (full changed-file code + pruned caller skeletons),
  which the auto-workflow rule triggers for multi-file/review work.
- Hook stdout is cheap: one or two `git` calls per event.
- If your tree is clean the hook prints nothing useful and exits quietly.
- The hook runs `git` in `CLAUDE_PROJECT_DIR` (or `$1` when invoked manually).
