# Squeze proof: public corpus (9 pinned repositories)

Sample: up to 40 gold cases per repository (seed 1729). Budget 3000 tokens per pack. Grep arm: 8 whole-file reads, 200 listing lines. Token counts use o200k_base on the text the agent receives.

## Verdict

- Recall: squeze 96.9% [95.0%, 98.6%] (n=360); grep 95.6% [93.3%, 97.5%]; whole repository 100.0% (ceiling).
- Non-inferiority to whole-repository reading (margin 2.0%): loss 3.1% [1.4%, 5.0%]. **fail**.
- Tokens per case, pooled: squeeze 1,073,401, grep 8,439,683, whole 606,575,360.
- Reduction versus grep: 87.3% [84.8%, 89.2%]. Median per-case reduction 66.1%. Squeeze cheaper in 280 of 360 cases.
- Reduction versus whole repository: 99.8% [99.8%, 99.8%].
- Versus grep (McNemar, exact): squeeze-only 15, grep-only 10, p = 0.4244.
- Squeze pack latency p50 1443 ms, p90 4462 ms (warm, after cold index).

## Per repository

| Repository | Files (universe / squeze) | Cases | Squeeze recall | Grep recall | Reduction vs grep | Reduction vs whole | Non-inferior | Cold index ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| flask | 229 / 229 (full) | 40 of 137 | 97.5% [92.5%, 100.0%] | 92.5% | 77.7% | 98.9% | fail (loss 2.5%) | 5696 |
| requests | 115 / 115 (full) | 40 of 99 | 100.0% [100.0%, 100.0%] | 100.0% | 87.2% | 99.6% | pass (loss 0.0%) | 2606 |
| gin | 128 / 128 (full) | 40 of 194 | 97.5% [92.5%, 100.0%] | 100.0% | 73.0% | 98.8% | fail (loss 2.5%) | 3037 |
| ripgrep | 216 / 215 (full) | 40 of 185 | 100.0% [100.0%, 100.0%] | 95.0% | 89.3% | 99.7% | pass (loss 0.0%) | 6143 |
| express | 215 / 215 (full) | 40 of 44 | 87.5% [77.5%, 97.5%] | 100.0% | 83.9% | 98.5% | fail (loss 12.5%) | 5303 |
| gson | 314 / 314 (full) | 40 of 144 | 100.0% [100.0%, 100.0%] | 90.0% | 85.7% | 99.4% | pass (loss 0.0%) | 5220 |
| bat | 899 / 899 (full) | 40 of 142 | 92.5% [82.5%, 100.0%] | 95.0% | 94.2% | 99.9% | fail (loss 7.5%) | 13389 |
| preact | 308 / 308 (full) | 40 of 403 | 100.0% [100.0%, 100.0%] | 97.5% | 82.3% | 99.3% | pass (loss 0.0%) | 1314 |
| django | 5,644 / 5,644 (cascade) | 40 of 3908 | 97.5% [92.5%, 100.0%] | 90.0% | 89.1% | 100.0% | fail (loss 2.5%) | 6194 |

## Losses

| Repository | Case | Gold files | Grep reached gold | Grep tokens | Squeeze tokens |
| --- | --- | --- | --- | --- | --- |
| flask | create | examples/tutorial/flaskr/blog.py | no | 37,930 | 2,992 |
| gin | engine | ginS/gins.go | yes | 46,753 | 2,992 |
| express | verbose | examples/route-map/index.js | yes | 1,915 | 2,937 |
| express | methods | lib/application.js, test/res.send.js | yes | 43,825 | 2,986 |
| express | dirname | lib/view.js | yes | 40,632 | 2,987 |
| express | redirect | examples/vhost/index.js | yes | 57,190 | 2,957 |
| express | fixtures | test/express.static.js, test/res.sendFile.js | yes | 10,169 | 2,987 |
| bat | expect | tests/syntax-tests/source/Zig/example.zig | yes | 71,371 | 2,989 |
| bat | assert | tests/benchmarks/highlighting-speed-src/jquery.js | yes | 235,586 | 2,991 |
| bat | document | tests/benchmarks/highlighting-speed-src/jquery.js | yes | 80,419 | 2,979 |
| django | Entries | tests/aggregation_regress/models.py | yes | 24,790 | 2,992 |

## Universe exclusions

- flask: 236 listed; excluded path-policy 7.
- requests: 130 listed; excluded path-policy 12, too-large 1, not-regular 2.
- gin: 130 listed; excluded path-policy 2.
- ripgrep: 226 listed; excluded path-policy 3, not-regular 1, binary 6.
- express: 216 listed; excluded path-policy 1.
- gson: 315 listed; excluded path-policy 1.
- bat: 1,014 listed; excluded path-policy 8, binary 13, not-regular 94.
- preact: 310 listed; excluded not-regular 1, path-policy 1.
- django: 7,102 listed; excluded path-policy 136, binary 1321, tracked-but-ignored 1.

## Method

- Universe: files git lists (tracked and untracked, not ignored), minus tracked files that match an ignore rule, then the same path policy squeze applies, regular files up to 2 MiB, no NUL byte in the first 8 KiB.
- Gold: a name declared at column 0 in one or two universe files (after modifiers) and mentioned in at least two files; length at least 6; not a stopword. The question asked is "Where is NAME defined and how is it used?".
- Whole: the agent reads every universe file. Recall is 1 whenever a gold file is in the universe, so this arm is a ceiling, not a measurement.
- Grep: `\bNAME\b` over universe text. Files ranked by match count, then path. The listing is the first 200 match lines in path order; the agent then reads up to 8 files in rank order until it reads a gold file. The ranking is free to grep, which favours grep.
- Squeze: `Engine.context(query, 3000)` with no follow-up `expand`. A case counts as reached when a gold file has a shown excerpt (pointers excluded). Tokens are the pack text.
- Statistics: 95% percentile bootstrap, 10,000 resamples, seed 1729. Non-inferiority is a paired bootstrap on (whole - squeeze). Token reductions are ratio-of-sums bootstraps over cases.

## Limitations

- Symbol lookups only. Gold covers top-level declarations, not methods, and uses the same declaration pattern family as squeze, which may favour squeze.
- Output tokens and model answer quality are not measured; no model was called.
- Whole-repository recall is trivially 1 for in-universe gold, so non-inferiority reduces to squeze recall within the margin.
- Grep is given a free ranking by match count, which is generous to grep; squeze is not given a follow-up, which is conservative for squeze.
- Results describe this sample and seed. Confidence intervals reflect sampling of cases, not of repositories.
