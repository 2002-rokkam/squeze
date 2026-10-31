Tokens an agent consumes to obtain a gold file, 61 SWE-bench dev instances (o200k_base). Reference: **S1**.

| strategy | reach | mean tokens (reached) | median tokens (reached) | tokens per reached instance | cost-per-reach vs reference (95% CI) | geo-mean ratio, both reached (95% CI) | reach diff, McNemar p |
|---|---:|---:|---:|---:|---:|---:|---:|
| S1 | 46/61 (75%) | 96,146 | 42,013 | 162,086 | 1 (reference) | - | - |
| S1b | 51/61 (84%) | 44,452 | 16,064 | 67,082 | 0.414 [0.294, 0.566] | 0.480 [0.347, 0.647] (n=45) | +8%, p=0.125 |
| ripgrep-naive | 40/61 (66%) | 3,981 | 3,981 | 6,043 | 0.037 [0.029, 0.050] | 0.146 [0.091, 0.229] (n=37) | -10%, p=0.146 |
| ripgrep-naive+expand | 40/61 (66%) | 3,981 | 3,981 | 6,128 | 0.038 [0.029, 0.051] | 0.146 [0.091, 0.229] (n=37) | -10%, p=0.146 |
| baseline-2.1.0 | 28/61 (46%) | 3,974 | 3,980 | 8,506 | 0.052 [0.039, 0.074] | 0.204 [0.121, 0.340] (n=27) | -30%, p=0.000 |
| baseline-2.1.0+expand | 28/61 (46%) | 3,974 | 3,980 | 9,208 | 0.057 [0.042, 0.081] | 0.204 [0.121, 0.340] (n=27) | -30%, p=0.000 |
| squeze | 39/61 (64%) | 3,980 | 3,986 | 6,228 | 0.038 [0.029, 0.052] | 0.155 [0.095, 0.250] (n=36) | -11%, p=0.092 |
| squeze+expand | 39/61 (64%) | 3,980 | 3,986 | 6,548 | 0.040 [0.030, 0.055] | 0.155 [0.095, 0.250] (n=36) | -11%, p=0.092 |

Pack rows that failed or were missing (counted as not reached, 0 tokens): baseline-2.1.0=1.
