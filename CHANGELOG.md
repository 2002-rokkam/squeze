# Changelog

## 3.1.0 — 2026-11-16

### Added
- `squeze.explorer.ignore` (VS Code, resource-scoped, default `[]`): gitignore-style patterns for files to hide from the Code Explorer. Hidden files are removed before the node limit applies, so they do not use its slots. They stay indexed, so packs and MCP results are unchanged. Up to 200 patterns of at most 500 characters; invalid entries are skipped.

### Changed
- The Code Explorer draws the top 2,000 files by rank by default, which is also the maximum (was 600 by default, 2,000 maximum). The summary shows the ignored count when `squeze.explorer.ignore` hides files.
- The `squeze graph --html` export draws the top 2,000 files by default and at most (was 400 and 1,500). Repositories of 400 files or fewer produce the same output as before. At 2,000 files the page is about 620 KiB and renders in about 0.35 s on synthetic graphs.

## 3.0.3 — 2026-11-15

### Added
- An extension icon (`media/icon.png`, 256×256 PNG), referenced by the manifest `icon` field. It shows on the VS Code Marketplace listing and in the Extensions view. The npm and MCP behaviour is unchanged; the version constant in `src/mcp.ts` and `server.json` moves with the release.

## 3.0.2 — 2026-11-15

### Changed
- The README has a keyword-bearing title and lead, plus a new FAQ (`#faq`) covering token-budgeted context, GitHub Copilot use, where code is sent (nowhere), supported languages, and what the benchmark does not measure. The Contents list is renumbered.
- npm metadata: `description` shortened to name the GitHub Copilot and MCP coding-agent use, and keywords expanded (`codebase-context`, `code-retrieval`, `repo-map`, `context-window`, `token-budget`, `coding-agent`, `developer-tools`, `cli`). No behaviour changes; the version constant in `src/mcp.ts` moves with the release.

## 3.0.1 — 2026-11-15

### Changed
- The README opens as a landing page: install and quick start, measured results with confidence intervals (including the failed non-inferiority test), a good-fit note and a not-measured note. The evidence sections are unchanged.
- npm metadata: keywords expanded, `mcpName` set to `io.github.2002-rokkam/squeze` for the MCP Registry, and `server.json` added. No code changes.

## 3.0.0 — 2026-11-14

### Evidence
- Public corpus (9 pinned repositories, 40 cases each, seed 1729, budget 3,000 tokens): squeze recall 96.9% [95.0, 98.6] against grep 95.6% [93.3, 97.5]. The non-inferiority test at a 2.0-point margin **failed**: squeze loses 3.1 points [1.4, 5.0]. Express (12.5% loss), bat (7.5%) and flask, gin and django (2.5% each) account for the losses. The McNemar test is not significant (p = 0.42). Input tokens fall 87.3% against grep. Raw output: `bench/proof/results/public.md`.
- One private repository, aggregate numbers only: squeze recall 100% against grep 95%, non-inferiority passed, input tokens fall 86.2%.
- Per-call overhead of the MCP tool list (`npm run measure:overhead`): `--tools core` is 548 tokens for 4 tools, `--tools all` is 765 tokens for 6 tools.

### Added
- VS Code **Code Explorer** (`Squeze: Open Code Explorer`): a searchable, interactive map of the code graph with subsystems, hubs and links. It renders under a per-render nonce CSP that blocks network requests, and shows at most 600 nodes by default (2,000 maximum). Incomplete graphs are labelled "partial graph".
- `Squeze: Refresh Index` and the `squeze.autoRefresh` setting (on by default). The index follows file changes through a debounced, single-flight refresh.
- `Squeze: Show Token Savings`: a local ledger of input tokens avoided by each pack, estimated as the whole-repository input minus the pack output. It records pack calls only and is not billing data.
- Browser UI tests (`npm run test:ui`, Playwright at 1440, 768 and 360 px).
- Proof harness `bench/proof/`: `npm run bench:proof` runs the public corpus; `local <path>` runs a private repository and writes aggregate output only.

### Changed
- `Squeze: Show Code Graph` opens the Code Explorer. The HTML export (`squeze graph --html`) keeps its output: the layout code moved to a shared module, and output is byte-identical before and after on express, gin and requests.
- Index reuse also checks change time and inode, so a same-size edit whose modification time was restored is re-read. Files whose newest timestamp is within two seconds of the scan are always re-read (`RACY_WINDOW_MS`). Cache format version is 2; older caches are discarded once.

### Fixed
- A nested `.gitignore` that re-includes a file is honoured, and a directory excluded by a parent cannot be re-included. Checked against `git ls-files`.
- The MCP server reported version `2.2.0` while the package was 2.2.1.
- A file changed between indexing and text load no longer fails the whole `context` call; the pack is rebuilt (bounded to three attempts).
- Test scratch repositories and caches live in the OS temp directory, not under the repository root.

## 2.2.1

Evidence for every item is in the README, section "Evidence".

### Added
- Compact pack format, query-dense windows with the declaration kept, one-line pointers, identical-chunk collapse.
- Persistent cache outside the repository, compact inverted index, parallel indexing.
- 9 more tree-sitter grammars (20 total), leading doc comments and decorators, `signature`/`scope`/`doc` fields, generated-file detection.
- Structural chunkers for Markdown, JSON, YAML, TOML, XML, HTML, CSS, SQL, Dockerfile, Makefile, shell, protobuf, HCL.
- Secret redaction in place (`src/redact.ts`); long-query condensing and a stack-trace parser (`src/trace.ts`); Git history signals (`src/gitsignals.ts`, opt-in).
- PageRank repository map, file outlines and definition search (`map --path`, `map --query`).
- Upgraded log compaction (`src/logs/`).
- `RSQ_FEATURES`/`--features` switches, `--query -` (stdin), `--version`, `reposqueeze_v2_map` tool in VS Code.
- Benchmarks: SWE-bench harness (`bench/`), development suite, overhead measurement, research survey (`docs/V3_RESEARCH.md`).

### Changed
- MCP exposes three tools by default (`--tools all` restores compact and json).
- Tokenizer v2 (`RSQ_TOKENIZER=v1` restores the 2.1 tokenizer); input-token statistic is an estimate (`inputTokensEstimated`).
- Files containing secret-like values are indexed with the values redacted instead of being dropped (`RSQ_FEATURES=-redact` restores dropping).
- The cache moved from `.reposqueeze-v2/` in the repository to the platform cache directory (`REPOSQUEEZE_CACHE_DIR=repo` restores it).

### Fixed
- Python files no longer produce a whole-file chunk named after their first line.
- Token counting no longer hangs on very long unbroken lines.
- Ranking is computed once per query instead of twice; the whole repository is no longer tokenized per query.
