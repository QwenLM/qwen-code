# Edit stale-recovery fixtures

`edit-stale-recovery.json` selects two unchanged anonymous case objects from
[QwenLM/qwen-code PR #17216](https://github.com/QwenLM/qwen-code/pull/17216),
commit `405575cfe2c1bf08ae77b96447889d12b7ddac34`:

- [Public corpus](https://github.com/QwenLM/qwen-code/blob/405575cfe2c1bf08ae77b96447889d12b7ddac34/packages/core/src/tools/fixtures/edit-recovery-cases.json)
- [Original provenance and anonymization notes](https://github.com/QwenLM/qwen-code/blob/405575cfe2c1bf08ae77b96447889d12b7ddac34/packages/core/src/tools/fixtures/README.md)
- [Apache-2.0 license](https://github.com/QwenLM/qwen-code/blob/405575cfe2c1bf08ae77b96447889d12b7ddac34/LICENSE)

The public corpus uses per-case neutral tokens instead of original identifiers,
content, paths and URLs. No private provenance or original-to-anonymous mapping
is copied here. The original evidence and eligibility fields are retained.

`stale` is case-048, a full before/after snapshot whose external change removes
the final newline. The test seeds the previous Read, recreates drift locally,
and exercises the current exact-target recovery contract while preserving that
external change. `noMatch` is case-021, an excerpt without a previous snapshot;
its replay checks the ordinary fresh-file no-occurrence error and unchanged
bytes, without inventing an external-change sequence.

These were observed failures, not verified successful production recoveries.
The tests specify current tool behavior on the published anonymous data; they
are not a representative sample or a recovery-rate/performance benchmark.
