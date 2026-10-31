# Code graph

`squeze graph` builds a deterministic graph of a repository and answers structural questions in a few hundred tokens.

* **Nodes:** files and definitions. **Edges:** `imports` (resolved to repository files; marked `EXTRACTED`), `defines`, and name-based `references` (marked `INFERRED`, with generic and over-defined names down-weighted). External packages are leaf nodes and are never invented as files.
* **Import resolution:** JS/TS (relative paths, index files, `tsconfig` paths), Python (absolute and relative, source roots), Go (module path), Java/Kotlin/Scala (package to file), Rust (`mod`, `use crate::`), C/C++ (`#include "…"`), C#, Ruby (`require_relative`), PHP.
* **Analytics (all deterministic):** communities (named from their dominant directory and identifiers), hub nodes, cross-community links, shortest path, impact set, cycles.
* **Honesty markers:** every output states how many edges are extracted versus inferred, and says when the index is partial (large repositories parsed in cascade mode).

```sh
squeze graph --root REPO                      # subsystems, hubs, flows, cycles (default budget 1500 tokens)
squeze graph --root REPO --neighbors X        # imports, importers, callers, callees of a file or symbol
squeze graph --root REPO --impact X           # what depends on X
squeze graph --root REPO --path A B           # shortest dependency chain
squeze graph --root REPO --mermaid [X]        # Mermaid flowchart
squeze graph --root REPO --json               # versioned JSON export
squeze graph --root REPO --html graph.html    # self-contained HTML (no remote assets, strict CSP)
```

The same modes are available as the `squeze_graph` MCP tool (default tool set) and a VS Code language-model tool, plus the command **Squeze: Show Code Graph**, which opens the HTML view in a webview.

Real output on gin (`--budget 500`):

```text
code graph @e69736f · 99 files · 1123 defs · 80 imports (EXTRACTED) · 1428 refs (INFERRED, name-based) · 11 subsystems
S0 render · write, content, response (20f, 218d) | key: response_writer.go
S1 binding · context, validate, run (18f, 198d) | key: binding.go
...
god nodes: debug.go (in 6, out 1), utils.go (in 6, out 1), binding/binding.go (in 19, out 1)
```

```text
impact of binding/binding.go: 7 files via imports within 3 hops (direct 6), +17 only via name-based references
d1 (6): context.go, mode.go, context_test.go, deprecated.go, deprecated_test.go, mode_test.go
```

Measured accuracy, token cost and build time: [benchmarks/v22/graph.md](../benchmarks/v22/graph.md). Limits: Go imports resolve to one file instead of the whole package, so impact precision is 25% on gin and 39% on ripgrep (75% on average over six repositories), Rust `use` of items is partly unresolved, and cascade-mode graphs on repositories above 5,000 files cover only the parsed candidates.
