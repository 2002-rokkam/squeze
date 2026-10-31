# Squeze standard for code structure answers

This is the bar for the code graph (`squeze graph`) and the caveman output style. A target counts as met only with a measurement in this repository. Compared with Graphify, Squeze is judged on the questions a coding agent asks and on the tokens those answers cost.

| # | Target | Measured now | Status |
| --- | --- | --- | --- |
| 1 | File dependents (`--impact`): precision ≥ 0.90 and recall ≥ 0.80 against a use-based ground truth (importers of a file's package that use a name the file defines, Go; importers, JVM/Python/JS/Rust) on six repositories | gin 1.00 / 0.84 (Go, after the fix in this release); flask, gson, thor, express, ripgrep measured before the Go fix (flask 1.00/0.87, gson 1.00/1.00, thor 1.00/1.00, express 0.88/0.60, ripgrep 0.39/0.71) | Partly met. ripgrep and express are below target. |
| 2 | Call edges ("who calls X"): precision proxy ≥ 0.80 and recall proxy ≥ 0.60 against Graphify's call edges on the same repositories | gin: 1,070 Squeze calls, 1,380 Graphify calls. 67% of Squeze's calls are also in Graphify (precision proxy); 52% of Graphify's are in Squeze (recall proxy). Before the unique-name fallback the recall proxy was 0.31. | Not met. Both are agreement with another extractor, not proof of correctness. |
| 3 | Head-to-head against Graphify on the same repositories, questions and token accounting, reported whatever the result | calls on gin (agreement above, raw in `benchmarks/v22/graph-calls-vs-graphify-gin.json`); one qualitative question (binding/binding.go): Squeze returned all 6 dependents, Graphify returned the file's own symbols | Partly met. Calls on one repository; dependents, paths and token counts on Graphify not yet compared. |
| 4 | Caveman output: at least 15% fewer tokens with no path or identifier lost, in every graph mode | impact 15.7% fewer tokens over ten gin files, 0 of 153 paths lost; path and neighbours covered by a test (shorter, all paths kept) but not yet measured | Partly met (impact only). |
| 5 | Every output within the requested token budget | tests in `tests/graph.test.ts` and `tests/mcp.test.ts` | Met. |
| 6 | Deterministic: same repository state, same bytes | cold, warm and restart runs in the index tests | Met. |
| 7 | Covers documents and configuration files, not only code | structural chunkers feed the retrieval index, not the graph | Not met. Graphify covers docs, papers and images. |
| 8 | Reproducible evidence in `benchmarks/v22/` and the README, including the wrong numbers that were found and fixed | `benchmarks/v22/graph.md`, README section 9, correction recorded | Met. |

## What "better than Graphify" must mean

Squeze wins only where it is measured to win. Each claim needs the same repositories, the same questions and the same token count for both tools.

* **Targets that must hold before any comparison claim:** 1, 2, 3 and 4 across all six repositories.
* **Where Squeze is already designed to be stronger:** fixed token budgets with exact citations, a caveman output style that cuts tokens without losing paths, and one server that also serves retrieval (`context`, `expand`, `map`, `graph`).
* **Where Graphify is stronger today:** call edges, documents and images, and export formats (Obsidian, GraphML, Neo4j).

## Ground truth rules

* A Go file's dependents are importers of its package that use a name the file defines. A word match on the file name is not a valid ground truth for Go (see `scripts/graph-eval.ts`).
* An import is an edge only if the importer uses something the target defines. The fallback that linked every package file was removed because it over-reported dependents (use-based precision went from 0.19 to 1.00 on gin).
