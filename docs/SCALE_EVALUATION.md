# 50,000-file scale evaluation

RepoSqueeze V2.1 was tested on a deterministic synthetic repository containing 50,000 TypeScript source files, at least 1.2 million lines and 100 query/gold-file pairs. Each query has 20 files containing the same incident term but only one root-cause file containing the full identifier evidence.

The first 80 tasks were used for development. Retrieval, packing and the evaluator were then frozen at SHA-256 `2ad34e1103ac9267471a9eaf376e643e86a520b177e9e5aa675077c73a3ef0a4`. The remaining 20 tasks ran once against that fingerprint.

## Results

| Metric | Development 80 | Held-out 20 |
| --- | ---: | ---: |
| Root-cause file Any@10 | 100% | **100%** |
| Root-cause file Any@20 | 100% | **100%** |
| Root-cause file included in 3K pack | 100% | **100%** |
| Mean parsed candidates | 200 | 200 |
| Mean output tokens | 2,959 | 2,967 |
| Median query time | 0.75 s | 1.31 s |
| 95th-percentile query time | 1.14 s | 4.51 s |
| Peak resident memory | 541 MiB | 475 MiB |

The initial development query built the persistent 4.0 MB compressed index in 10.50 seconds. Subsequent queries reused file sketches. Timings are from one Apple Silicon workstation and should not be treated as cross-machine guarantees.

The repository contained 50,001 eligible files during evaluation because its `.reposqueeze-v2ignore` control file was also indexed. Only 200 exact source files were parsed per query; ranking and packing still saw the complete file-level inventory.

## Incremental refresh on a real repository

Django at commit `f24f38c` (5,644 eligible Python files, Git working tree), Apple Silicon workstation, one run per mode. Each probe edits the tree, takes a snapshot and checks for a unique identifier from the edit. The probe script is local and is not committed.

| Step | Default (cascade) | Full index (`REPOSQUEEZE_LARGE_THRESHOLD=10000`) |
| --- | ---: | ---: |
| Cold index: snapshot / graph | 6.2 s / 5.1 s, 200 candidates parsed | 23.9 s / 3.3 s, all 5,644 parsed |
| No-op refresh, snapshot median (min–max) | 766 ms (555–1100) | 674 ms (543–1052) |
| Single-file edit, snapshot median (min–max) | 579 ms (507–1787) | 955 ms (864–1367) |
| Single-file edit, graph rebuild median | 789 ms | 2107 ms |
| Single-file edit, total median over 5 edits | 1368 ms | 3062 ms |

- Neither mode meets a 300 ms single-file target. The graph rebuild step calls `loadGraph`, which takes its own snapshot first (`src/graph-store.ts:38-52`), so part of that step is a repeated snapshot. Removing it is a follow-up. It is not removed here because the query may affect candidate selection and needs its own test.
- Cascade mode parses 200 of 5,644 files. Its graph is marked `partial`, and every view says so. Full mode parses every file and has a 3.8× slower cold snapshot.
- Earlier scratch runs on this clone, before the probe script was fixed, measured single-file totals of 1.9 s and 2.7 s in cascade mode. Those runs did not record phase timings, so they are not in the table.
- Probes: a touch-only edit leaves the revision unchanged. A same-size identifier edit (`slugify` to `slugifx`) changes the revision and is found through change time, because the modification time cannot be restored exactly from user space. An added file is found, and deleting it reverts the revision.
- The min–max columns show run-to-run variance within a single run. Treat these as one machine's measurements, not guarantees.

## Reproduce

```sh
npm run bench:scale:development
npm run bench:scale:test
```

The first command generates `/private/tmp/reposqueeze-scale-50000`, initializes its Git index, runs 80 tasks and writes the freeze. The second command refuses to run if scale retrieval, PCR, packing or the evaluator has changed.

Raw evidence:

- [Development report](../benchmarks/scale-development.json)
- [Held-out report](../benchmarks/scale-test.json)
- [Freeze](../benchmarks/scale-freeze.json)
- [Evaluator and generator](../scripts/benchmark-scale.ts)

## Limits

This benchmark proves operation on its generated distribution, not perfect retrieval for every 50,000-file repository. Its identifiers are deterministic and the gold files contain exact term evidence. Real monorepos have generated code, duplicated APIs, cross-language names, build indirection and tasks that do not name their relevant concepts.

The candidate stage can miss a file with no shared path or indexed term. Files with more than 8,192 unique normalized terms use deterministic term sampling. Increase `REPOSQUEEZE_MAX_CANDIDATES`, provide paths or identifiers, or use ordinary search when obligations are missing. Edits are detected by size, modification time, change time and inode, so a timestamp-preserving edit is re-read. `REPOSQUEEZE_REFRESH_INDEX=1` still forces a full re-read.

The 100% held-out result is scale-corpus retrieval accuracy. It is not 100% answer accuracy, patch success or Copilot-credit reduction.
