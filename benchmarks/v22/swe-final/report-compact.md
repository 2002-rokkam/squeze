# SWE retrieval benchmark: DEV split

- Command: `node --import tsx bench/run.ts --dataset lite,multilingual --split dev --repos axios/axios,briannesbitt/carbon,burntsushi/ripgrep,caddyserver/caddy,django/django,faker-ruby/faker,fmtlib/fmt,gin-gonic/gin,google/gson,immutable-js/immutable-js,jekyll/jekyll,jqlang/jq,marshmallow-code/marshmallow,micropython/micropython,mwaskom/seaborn,nlohmann/json,pallets/flask,preactjs/preact,psf/requests,pydicom/pydicom,pytest-dev/pytest,sharkdp/bat,sphinx-doc/sphinx,sympy/sympy,tokio-rs/axum,tokio-rs/tokio --sample 60 --offline --variant baseline --variant final=<final-build>:REPOSQUEEZE_CACHE_DIR=~/reposqueeze-lab/tmp/cache-bench3/final --variant final-none=<final-build>:RSQ_FEATURES=none,REPOSQUEEZE_CACHE_DIR=~/reposqueeze-lab/tmp/cache-bench3/final-none --budget 4000 --workers 2 --timeout 240 --max-load 80 --out ~/reposqueeze-lab/results/final2/swe`
- Started: 2026-10-31T17:14:15.774Z, finished: 2026-10-31T18:22:14.626Z
- Environment: Node v25.9.0, darwin/arm64, 8 cores, 16 GiB RAM, 2 worker(s), 240 s task timeout
- Budget: 4000 o200k_base tokens; bootstrap: 10,000 resamples, seed 1729; harness 2a022ff86474
- Instances: 60 (SHA-256 of sorted ids 2c565469f5620c56)
- Corpus: 26 full clone(s), 0 depth-1 snapshot repo(s) (shallow repos give variants no git history)
- Filters: repos=axios/axios,briannesbitt/carbon,burntsushi/ripgrep,caddyserver/caddy,django/django,faker-ruby/faker,fmtlib/fmt,gin-gonic/gin,google/gson,immutable-js/immutable-js,jekyll/jekyll,jqlang/jq,marshmallow-code/marshmallow,micropython/micropython,mwaskom/seaborn,nlohmann/json,pallets/flask,preactjs/preact,psf/requests,pydicom/pydicom,pytest-dev/pytest,sharkdp/bat,sphinx-doc/sphinx,sympy/sympy,tokio-rs/axum,tokio-rs/tokio sample=60 sampleMode=even

## Datasets

| dataset | HF revision | content SHA-256 | unique instances | dev | held-out test | dev prepared | selected |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SWE-bench/SWE-bench_Lite | b0dde1093fe4 | 168468da50ffec2f | 323 | 167 | 156 | 167 | 19 |
| SWE-bench/SWE-bench_Multilingual | 846e647b9f33 | 23d209c7ffcfe2ac | 300 | 160 | 140 | 160 | 41 |

No instance was skipped during gold extraction.

## Variants

| variant | path | git SHA | dirty | engine version | env | query truncation | src fingerprint |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | <baseline-2.1.0> | 25fe500f3317 | no | 2.1.0 | - | 8000 chars | 3c4d6c1f3d2b |
| final | <final-build> | aa02549ebca0 | yes | 2.2.0 | REPOSQUEEZE_CACHE_DIR=~/reposqueeze-lab/tmp/cache-bench3/final | none | e6fc759f03ce |
| final-none | <final-build> | aa02549ebca0 | yes | 2.2.0 | RSQ_FEATURES=none REPOSQUEEZE_CACHE_DIR=~/reposqueeze-lab/tmp/cache-bench3/final-none | none | e6fc759f03ce |

## Overall

Means over all instances; a timeout or error counts as a zero for every retrieval metric (`fail` shows how many). Intervals are 95% percentile-bootstrap CIs over instances. Hit@k and MRR rank distinct files by first appearance in `pack.evidence`; line recall uses pre-image edit-site lines (removed lines plus context anchors around pure insertions). Seconds are `engine.context()` wall time over completed runs.

**All-evidence metrics** (every `pack.evidence` entry counts, including one-line pointers):

| variant | N | fail (timeout/error) | packFileHit | packFileRecall | goldLineRecall | packLineHit | MRR | Hit@1 | Hit@3 | Hit@5 | Hit@10 | tokens | sec mean (p50/p90) | cpu sec mean | load avg | RSS MB mean/max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 60 | 1 (1/0) | 0.467 [0.33, 0.58] | 0.415 [0.30, 0.53] | 0.270 [0.16, 0.38] | 0.300 [0.18, 0.42] | 0.280 [0.19, 0.38] | 0.200 [0.10, 0.30] | 0.333 [0.22, 0.45] | 0.383 [0.27, 0.50] | 0.433 [0.32, 0.55] | 3969 | 30.0 (18.4/61.0) | 15.48 | 43.7 | 841/2549 |
| final | 60 | 0 (0/0) | 0.833 [0.73, 0.92] | 0.767 [0.67, 0.86] | 0.549 [0.43, 0.66] | 0.617 [0.50, 0.73] | 0.410 [0.31, 0.51] | 0.300 [0.18, 0.42] | 0.417 [0.30, 0.53] | 0.550 [0.43, 0.67] | 0.717 [0.60, 0.82] | 3982 | 29.6 (17.3/72.2) | 12.53 | 44.8 | 1130/2619 |
| final-none | 60 | 0 (0/0) | 0.583 [0.45, 0.70] | 0.493 [0.38, 0.61] | 0.317 [0.20, 0.43] | 0.333 [0.22, 0.45] | 0.318 [0.23, 0.41] | 0.200 [0.10, 0.30] | 0.400 [0.28, 0.52] | 0.533 [0.42, 0.65] | 0.567 [0.45, 0.68] | 3970 | 31.8 (14.1/86.2) | 11.89 | 45.7 | 1134/2245 |

**Shown-only metrics**: the same metrics computed on evidence with `kind != 'pointer'` (pointers are "Also relevant (not shown)" references, not source code):

| variant | packFileHit | packFileRecall | goldLineRecall | MRR | Hit@1 | Hit@3 | Hit@5 | Hit@10 | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.467 [0.33, 0.58] | 0.415 [0.30, 0.53] | 0.270 [0.16, 0.38] | 0.280 [0.19, 0.38] | 0.200 [0.10, 0.30] | 0.333 [0.22, 0.45] | 0.383 [0.27, 0.50] | 0.433 [0.32, 0.55] |  |
| final | 0.633 [0.52, 0.75] | 0.543 [0.43, 0.66] | 0.348 [0.23, 0.47] | 0.391 [0.29, 0.50] | 0.300 [0.18, 0.42] | 0.417 [0.30, 0.53] | 0.533 [0.42, 0.65] | 0.617 [0.50, 0.73] |  |
| final-none | 0.583 [0.45, 0.70] | 0.493 [0.38, 0.61] | 0.317 [0.20, 0.43] | 0.318 [0.23, 0.41] | 0.200 [0.10, 0.30] | 0.400 [0.28, 0.52] | 0.533 [0.42, 0.65] | 0.567 [0.45, 0.68] |  |

## Paired comparisons

### final vs baseline

Paired over 60 common instances. **All-evidence metrics** (pointer entries count as packed):

| metric | baseline | final | final - baseline [95% CI] | only baseline / only final | McNemar exact p |
| --- | --- | --- | --- | --- | --- |
| packFileHit | 0.467 | 0.833 | +0.367 [0.250, 0.483] | 0 / 22 | <0.0001 |
| packFileRecall | 0.415 | 0.767 | +0.352 [0.242, 0.465] |  |  |
| goldLineRecall | 0.270 | 0.549 | +0.279 [0.176, 0.387] |  |  |
| packLineHit | 0.300 | 0.617 | +0.317 [0.200, 0.433] | 0 / 19 | <0.0001 |
| MRR | 0.280 | 0.410 | +0.130 [0.064, 0.203] |  |  |
| Hit@1 | 0.200 | 0.300 | +0.100 [0.017, 0.200] | 1 / 7 | 0.0703 |
| Hit@3 | 0.333 | 0.417 | +0.083 [-0.017, 0.183] | 2 / 7 | 0.1797 |
| Hit@5 | 0.383 | 0.550 | +0.167 [0.067, 0.267] | 1 / 11 | 0.0063 |
| Hit@10 | 0.433 | 0.717 | +0.283 [0.167, 0.400] | 0 / 17 | <0.0001 |
| outputTokens | 3903.3 | 3982.0 | +78.750 [8.233, 214.933] |  |  |
| seconds | 33.5 | 29.6 | -3.871 [-13.820, 4.754] |  |  |

**Shown-only metrics** (pointer entries excluded):

| metric | baseline | final | final - baseline [95% CI] | only baseline / only final | McNemar exact p |
| --- | --- | --- | --- | --- | --- |
| packFileHit | 0.467 | 0.633 | +0.167 [0.083, 0.267] | 0 / 10 | 0.0020 |
| packFileRecall | 0.415 | 0.543 | +0.128 [0.053, 0.212] |  |  |
| goldLineRecall | 0.270 | 0.348 | +0.078 [-0.023, 0.184] |  |  |
| MRR | 0.280 | 0.391 | +0.111 [0.044, 0.186] |  |  |
| Hit@1 | 0.200 | 0.300 | +0.100 [0.017, 0.200] | 1 / 7 | 0.0703 |
| Hit@3 | 0.333 | 0.417 | +0.083 [-0.017, 0.183] | 2 / 7 | 0.1797 |
| Hit@5 | 0.383 | 0.533 | +0.150 [0.050, 0.250] | 1 / 10 | 0.0117 |
| Hit@10 | 0.433 | 0.617 | +0.183 [0.100, 0.283] | 0 / 11 | 0.0010 |

### final-none vs baseline

Paired over 60 common instances. **All-evidence metrics** (pointer entries count as packed):

| metric | baseline | final-none | final-none - baseline [95% CI] | only baseline / only final-none | McNemar exact p |
| --- | --- | --- | --- | --- | --- |
| packFileHit | 0.467 | 0.583 | +0.117 [0.017, 0.217] | 2 / 9 | 0.0654 |
| packFileRecall | 0.415 | 0.493 | +0.078 [-0.009, 0.169] |  |  |
| goldLineRecall | 0.270 | 0.317 | +0.048 [-0.047, 0.149] |  |  |
| packLineHit | 0.300 | 0.333 | +0.033 [-0.067, 0.133] | 4 / 6 | 0.7539 |
| MRR | 0.280 | 0.318 | +0.037 [-0.012, 0.088] |  |  |
| Hit@1 | 0.200 | 0.200 | +0.000 [-0.067, 0.067] | 2 / 2 | 1.0000 |
| Hit@3 | 0.333 | 0.400 | +0.067 [0.000, 0.150] | 1 / 5 | 0.2188 |
| Hit@5 | 0.383 | 0.533 | +0.150 [0.050, 0.267] | 2 / 11 | 0.0225 |
| Hit@10 | 0.433 | 0.567 | +0.133 [0.033, 0.250] | 2 / 10 | 0.0386 |
| outputTokens | 3903.3 | 3970.3 | +66.983 [-3.050, 202.733] |  |  |
| seconds | 33.5 | 31.8 | -1.695 [-7.873, 4.028] |  |  |

**Shown-only metrics** (pointer entries excluded):

| metric | baseline | final-none | final-none - baseline [95% CI] | only baseline / only final-none | McNemar exact p |
| --- | --- | --- | --- | --- | --- |
| packFileHit | 0.467 | 0.583 | +0.117 [0.017, 0.217] | 2 / 9 | 0.0654 |
| packFileRecall | 0.415 | 0.493 | +0.078 [-0.009, 0.169] |  |  |
| goldLineRecall | 0.270 | 0.317 | +0.048 [-0.047, 0.149] |  |  |
| MRR | 0.280 | 0.318 | +0.037 [-0.012, 0.088] |  |  |
| Hit@1 | 0.200 | 0.200 | +0.000 [-0.067, 0.067] | 2 / 2 | 1.0000 |
| Hit@3 | 0.333 | 0.400 | +0.067 [0.000, 0.150] | 1 / 5 | 0.2188 |
| Hit@5 | 0.383 | 0.533 | +0.150 [0.050, 0.267] | 2 / 11 | 0.0225 |
| Hit@10 | 0.433 | 0.567 | +0.133 [0.033, 0.250] | 2 / 10 | 0.0386 |

## Bias indicator: does the issue name a gold file?

13 of 60 instances (21.7%) literally mention a gold file by path or file name (12 by path suffix, 13 by file name; 21 also by bare file stem, a weaker signal). 60 of 60 have at least one code file in the gold set; 15 have more than one gold file. Retrievers benefit from such literal hints, so read the split below before concluding anything about semantic retrieval.

## By dataset

| dataset | N | baseline hit | baseline recall | baseline line | baseline MRR | baseline fail | final hit | final recall | final line | final MRR | final fail | final-none hit | final-none recall | final-none line | final-none MRR | final-none fail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lite | 19 | 0.47 | 0.47 | 0.34 | 0.38 | 1 | 0.79 | 0.79 | 0.70 | 0.56 | 0 | 0.58 | 0.58 | 0.46 | 0.41 | 0 |
| multilingual | 41 | 0.46 | 0.39 | 0.24 | 0.23 | 0 | 0.85 | 0.76 | 0.48 | 0.34 | 0 | 0.59 | 0.45 | 0.25 | 0.27 | 0 |

## By language

| language | N | baseline hit | baseline recall | baseline line | baseline MRR | baseline fail | final hit | final recall | final line | final MRR | final fail | final-none hit | final-none recall | final-none line | final-none MRR | final-none fail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C | 5 | 0.20 | 0.20 | 0.00 | 0.10 | 0 | 1.00 | 1.00 | 0.60 | 0.27 | 0 | 0.60 | 0.60 | 0.40 | 0.21 | 0 |
| C++ | 3 | 0.33 | 0.33 | 0.00 | 0.05 | 0 | 1.00 | 0.83 | 0.08 | 0.17 | 0 | 0.33 | 0.33 | 0.00 | 0.08 | 0 |
| Go | 6 | 0.33 | 0.33 | 0.33 | 0.19 | 0 | 0.67 | 0.67 | 0.67 | 0.36 | 0 | 0.33 | 0.33 | 0.33 | 0.19 | 0 |
| Java | 3 | 1.00 | 0.83 | 0.92 | 1.00 | 0 | 1.00 | 1.00 | 0.87 | 1.00 | 0 | 1.00 | 1.00 | 0.79 | 0.83 | 0 |
| JavaScript | 7 | 0.57 | 0.50 | 0.29 | 0.16 | 0 | 1.00 | 0.93 | 0.60 | 0.25 | 0 | 0.43 | 0.36 | 0.00 | 0.20 | 0 |
| PHP | 3 | 0.00 | 0.00 | 0.00 | 0.00 | 0 | 0.67 | 0.37 | 0.09 | 0.19 | 0 | 0.67 | 0.23 | 0.00 | 0.18 | 0 |
| Python | 19 | 0.47 | 0.47 | 0.34 | 0.38 | 1 | 0.79 | 0.79 | 0.70 | 0.56 | 0 | 0.58 | 0.58 | 0.46 | 0.41 | 0 |
| Ruby | 5 | 0.40 | 0.40 | 0.40 | 0.17 | 0 | 0.60 | 0.60 | 0.60 | 0.20 | 0 | 0.40 | 0.40 | 0.40 | 0.14 | 0 |
| Rust | 9 | 0.67 | 0.44 | 0.11 | 0.31 | 0 | 0.89 | 0.66 | 0.26 | 0.40 | 0 | 0.89 | 0.49 | 0.22 | 0.41 | 0 |

## By issue names a gold file

| issue names a gold file | N | baseline hit | baseline recall | baseline line | baseline MRR | baseline fail | final hit | final recall | final line | final MRR | final fail | final-none hit | final-none recall | final-none line | final-none MRR | final-none fail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| does not name a gold file | 47 | 0.38 | 0.33 | 0.20 | 0.21 | 1 | 0.79 | 0.70 | 0.49 | 0.35 | 0 | 0.51 | 0.41 | 0.21 | 0.24 | 0 |
| names a gold file (path or file name) | 13 | 0.77 | 0.71 | 0.54 | 0.52 | 0 | 1.00 | 1.00 | 0.77 | 0.62 | 0 | 0.85 | 0.79 | 0.69 | 0.58 | 0 |

## Notes

- Gold = pre-image files edited by the gold patch (tests and new files excluded); gold lines = removed lines plus context anchors around pure insertions.
- Every (instance, variant) pair runs in a fresh child process on its own pristine checkout of the base commit; variants of one instance run sequentially in a hash-determined order.
- Timeouts and engine errors count as zero for every retrieval metric and are reported separately.
