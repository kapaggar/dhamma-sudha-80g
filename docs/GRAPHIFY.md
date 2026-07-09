# Graphify — Code Knowledge Graph

Graphify (installed locally, not a repo dependency) builds a semantic knowledge graph of this repo
(nodes = concepts/functions/flows, edges = relationships) that AI agents can read instead
of scanning raw source files. Output lives in `graphify-out/` (**gitignored** — rebuildable,
contains dated snapshots, a token-cost log, and an incremental cache).

## Why (token economics)

- First full build of this repo cost **~78k input tokens** (see `graphify-out/cost.json`).
- Re-runs cost **0 tokens**: `graphify-out/manifest.json` stores per-file AST/semantic
  hashes, so `graphify update .` only re-analyzes files that actually changed.
- `graphify-out/GRAPH_REPORT.md` is a ~6 KB summary of the whole codebase — pointing an
  AI session at it is far cheaper than having it read `WriteBack.gs` + `DanaImport.gs`
  (~60 KB) to orient itself.

**Never delete `graphify-out/cache/`** — that is what makes updates free.

## Daily usage

```bash
graphify update .        # after code/doc changes; incremental, no API cost
graphify query <topic>   # explore the graph interactively
open graphify-out/graph.html   # visual graph
```

Check freshness: `GRAPH_REPORT.md` records the commit it was built from — compare with
`git rev-parse HEAD`.

## What is excluded

`.graphifyignore` (committed) excludes `graphify-out/` itself, `.git/`, `.claude/`,
`.clasp.json`, dependency dirs, and env files. Keep it tight — every excluded file saves
tokens on full rebuilds.

**PII note:** the graph extracts code concepts only (function names, flows, gotchas), not
data values. After any full rebuild, skim `graph.json` / `GRAPH_REPORT.md` to confirm no
donor data (names, PAN, emails) leaked into node labels before sharing the report anywhere.

## Fresh-machine setup prompt (for Claude Code)

Paste this into Claude Code to verify the install and redo the full setup:

````markdown
# Graphify: verify install, post-install setup, and repo integration

Do the following in order. Report what you find at each step before moving on.

## 1. Verify installation
- Run `which graphify` and `graphify --version` (fall back to `graphify --help`
  if --version is unsupported). If not on PATH, check common installs
  (`pipx list`, `pip show graphify`, homebrew) and report how to install —
  do not install anything without telling me first.
- Confirm the Python interpreter graphify uses works (see
  `graphify-out/.graphify_python` if a previous run exists).

## 2. Check for a previous run
- Look for a `graphify-out/` directory in the repo root.
- If it exists, read `graphify-out/cost.json` (token spend per run),
  `graphify-out/manifest.json` (which files were analyzed, per-file hashes),
  and `graphify-out/GRAPH_REPORT.md` (the built-from commit hash).
- Compare the report's commit hash with `git rev-parse HEAD` and tell me if
  the graph is stale.
- NEVER delete `graphify-out/cache/` — it's what makes re-runs cost 0 tokens.

## 3. Post-install repo hygiene
- Create a `.graphifyignore` in the repo root (gitignore syntax) excluding:
  - `graphify-out/` (never let it self-analyze its own output)
  - `.git/`, `.claude/`, and tool-local config files (e.g. `.clasp.json`,
    `.vscode/`, IDE dirs) — check `manifest.json` from step 2 for any
    zero-semantic-value files it already analyzed and exclude those too
  - dependency dirs (`node_modules/`, `venv/`, etc.) and `.env` / `*.env`
- Add `graphify-out/` to `.gitignore` with a short comment (it's rebuildable
  generated output: dated snapshots, cache, cost logs — don't version it).
- If this repo handles sensitive data, skim `graph.json` and
  `GRAPH_REPORT.md` to confirm the extracted graph contains only code
  concepts, not real data values; flag anything sensitive before committing.

## 4. Build or refresh the graph
- If no graph exists yet: run `graphify .` (full build — costs tokens; tell
  me the expected scope first: number of files after ignores).
- If a graph exists and is stale: run `graphify update .` (incremental,
  no API cost — only re-analyzes files whose hashes changed).
- Afterwards, report the token cost from `cost.json` and the node/edge/
  community summary from `GRAPH_REPORT.md`.

## 5. Commit and push
- Stage and commit ONLY `.graphifyignore` and `.gitignore` (the
  `graphify-out/` dir must stay untracked).
- Commit message: `chore: add .graphifyignore and gitignore graphify output`
- Push to the current branch.

## 6. Tell me how to use it to save tokens
Finish with a short recap:
- `graphify update .` after code changes (incremental, free) vs full re-runs
- keep `graphify-out/cache/` intact
- point AI sessions at `GRAPH_REPORT.md` or `graphify query <topic>` for
  cheap codebase orientation instead of reading raw source files
- check graph freshness via the commit hash in the report before trusting it
````
