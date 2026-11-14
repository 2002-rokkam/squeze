# Changelog

## Unreleased

### Added
- VS Code **Code Explorer** (`Squeze: Open Code Explorer`): a searchable, interactive map of the code graph with subsystems, hubs and links. It renders under a per-render nonce CSP that blocks network requests, and shows at most 600 nodes by default (2,000 maximum). Incomplete graphs are labelled "partial graph".
- `Squeze: Refresh Index` and the `squeze.autoRefresh` setting (on by default). The index follows file changes through a debounced, single-flight refresh.
- `Squeze: Show Token Savings`: a local ledger of input tokens avoided by each pack, estimated as the whole-repository input minus the pack output. It records pack calls only and is not billing data.

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
