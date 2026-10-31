# Squeze code graph: measured results

Questions about structure ("what depends on X?", "how does A reach B?", "what are the subsystems?") are answered from a graph of files, definitions, imports and name-based references instead of by reading files. Produced by `src/graph.ts`; method and raw JSON: `scripts/graph-eval.ts`. Machine: shared 8-core laptop, load average about 40.

## Edge correctness (imports)

Fifty import edges per repository were sampled; an edge counts as correct when its target file exists in the repository and the import statement text is present in the source file.

| Repo | Languages | Files | Import statements | Import edges | Unresolved | Verified |
| --- | --- | ---: | ---: | ---: | --- | --- |
| express | javascript | 142 | 405 | 154 | 0 (0%) | 50/50 |
| flask | bash, python | 84 | 675 | 180 | 0 (0%) | 50/50 |
| gin | go | 99 | 517 | 80 | 0 (0%) | 50/50 |
| gson | java | 264 | 2678 | 1022 | 0 (0%) | 50/50 |
| ripgrep | rust, bash, ruby | 106 | 1003 | 233 | 142 (26%) | 50/50 |
| thor | ruby, bash | 81 | 140 | 97 | 0 (0%) | 50/50 |

All 300 sampled edges verified. This checks *existence and textual presence*, not completeness: it does not measure missing edges. Go imports resolve to a package, so gin's 50 sampled edges are package-level (`INFERRED`) edges narrowed to a file. In ripgrep, 26% of import statements (Rust `use` of items) are unresolved.

## Tokens to answer structural questions

6 repositories (express, flask, gin, gson, ripgrep, thor), about 20 questions each. "Read whole files" = the agent opens every file that contains the target identifier; "Grep listing" = the match listing only (a lower bound: a listing alone usually does not answer the question).

| Question type | Repos | Squeze graph (median of repo medians) | Read whole files (median) | Grep listing (median) | Reduction vs reading files | Reduction vs grep (mean of repos) | Importer precision / recall (mean of repos) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| impact | 6 | 264 | 28,330 | 630 | 98.4% | 4% | 75% / 79% |
| neighbors | 6 | 111 | 26,943 | 1164 | 94.8% | 79% | n/a |
| path | 6 | 60 | 11,070 | 11070 | 99.3% | 99% | n/a |
| overview | 6 | 860 | 36,305 | 790 | 96.4% | -12% | n/a |

* Versus **reading whole files** the graph answer is 94.8–99.3% smaller.
* Versus a **grep listing** the saving is small or negative: `impact` 4%, `overview` −12%.
* **Importer accuracy (impact, 8 files per repository, grep ground truth):** precision 75%, recall 79% on average. Per repository: flask 100%/87%, gson 100%/100%, thor 100%/100%, express 88%/60%, ripgrep 39%/71%, gin 25%/58%.
* **Correction:** an earlier version reported 59% precision and 0% for gin. The grep ground truth missed Go `import ( ... )` blocks; the eval now recognises them (`scripts/graph-eval.ts`). The read-whole-files and graph token numbers are unchanged by that fix; only the grep listing and accuracy columns changed.
* Treat these as a proxy for agent behaviour, not a billing measurement.

## Build cost

| Repo | Files | Definitions | Edges | Index mode | Graph build | Warm load | Query | Peak RSS |
| --- | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| django | 2,986 | 5,419 | 16,986 | cascade | 0.7 s | 4.3 s | 51 ms | 863 MB |
| scale50k | 50,000 | 0 | 0 | cascade | 1.6 s | 3.1 s | 40 ms | 1206 MB |
| scrapy | 541 | 7,398 | 29,206 | full | 1.1 s | 0.9 s | 49 ms | 1500 MB |

`cascade` means only the candidate files that were parsed are in the graph and the output says so (`partial`). The 50,000-file synthetic repository has no definitions because only sketches were parsed in cascade mode.
