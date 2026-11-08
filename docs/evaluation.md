# Qwen Code Evaluation

[English](evaluation.md) | [简体中文](evaluation.zh-CN.md)

This evaluation compares seven Qwen Code versions on SWE-bench Verified using
the same Qwen 3.7 Max model and configuration. Average scores range from
**76.40% to 77.80%**, a spread of **1.40 percentage points**.

## Scores by Qwen Code Version

![Average SWE-bench Verified scores by Qwen Code version, ranging from 76.40% to 77.80%.](../.github/assets/qwen-code-avg-score-trend.svg)

| Version | Avg Score | Pass Rate | pass@3 | pass^3 |
| ------- | --------: | --------: | -----: | -----: |
| 0.0.14  |    77.80% |     84.6% |  84.6% |  69.2% |
| 0.1.0   |    76.73% |     84.6% |  84.6% |  68.0% |
| 0.5.0   |    76.60% |     83.0% |  83.0% |  68.4% |
| 0.10.0  |    76.47% |     84.4% |  84.4% |  67.4% |
| 0.15.0  |    77.67% |     84.6% |  84.6% |  68.6% |
| 0.19.0  |    76.40% |     85.0% |  85.0% |  65.8% |
| 0.22.0  |    77.33% |     84.4% |  84.4% |  68.0% |

The line chart connects versions in release order and uses an explicitly labeled
70%–80% scale. The table retains all reported metrics;
Pass Rate and pass@3 have identical values in these results.

## Evaluation Configuration

| Configuration           | Value                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| Dataset                 | `princeton-nlp/SWE-bench_Verified`, 500 cases                                                       |
| Runs                    | 3 trials per version, 1,500 jobs per version; 7 Qwen Code versions                                  |
| Model                   | `Qwen 3.7 Max`                                                                                      |
| Sampling                | `temperature=1`, `top_p=0.95`                                                                       |
| Thinking / Reasoning    | `interleaved_thinking=true`, `thinking_type=adaptive`, `reasoning_effort=high`                      |
| Context / Output Limits | `context_1m=true`, `model_context_length=1,000,000`, `max_tokens=64,000`, `model_max_tokens=65,535` |
| Harness Limits          | `max_iterations=500`, `runtime_timeout_sec=7,200`, `agent_timeout_multiplier=3.0`                   |

[Back to README](../README.md#qwen-code-evaluation)
