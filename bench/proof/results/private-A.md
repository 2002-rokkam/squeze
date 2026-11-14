# Squeze proof: private-A

Sample: up to 40 gold cases per repository (seed 1729). Budget 3000 tokens per pack. Grep arm: 8 whole-file reads, 200 listing lines. Token counts use o200k_base on the text the agent receives.

## Verdict

- Recall: squeze 100.0% [100.0%, 100.0%] (n=40); grep 95.0% [87.5%, 100.0%]; whole repository 100.0% (ceiling).
- Non-inferiority to whole-repository reading (margin 2.0%): loss 0.0% [0.0%, 0.0%]. **pass**.
- Tokens per case, pooled: squeeze 119,417, grep 868,234, whole 291,527,240.
- Reduction versus grep: 86.2% [79.8%, 90.4%]. Median per-case reduction 80.6%. Squeeze cheaper in 37 of 40 cases.
- Reduction versus whole repository: 100.0% [100.0%, 100.0%].
- Versus grep (McNemar, exact): squeeze-only 2, grep-only 0, p = 0.5000.
- Squeze pack latency p50 923 ms, p90 1973 ms (warm, after cold index).

## Per repository

| Repository | Files (universe / squeze) | Cases | Squeeze recall | Grep recall | Reduction vs grep | Reduction vs whole | Non-inferior | Cold index ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| private-A | 1,100 / 1,100 (full) | 40 of 4655 | 100.0% [100.0%, 100.0%] | 95.0% | 86.2% | 100.0% | pass (loss 0.0%) | 9103 |

## Losses

0 of 40 cases where squeeze's pack did not show a gold file (names and paths withheld in aggregate-only mode).

## Universe exclusions

- private-A: 1,125 listed; excluded too-large 5, path-policy 12, tracked-but-ignored 8.

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
