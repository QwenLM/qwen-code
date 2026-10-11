# AgentDefinition regression coverage

[English](2026-10-09-agent-definition-regression-coverage.md) | [简体中文](2026-10-09-agent-definition-regression-coverage.zh-CN.md)

## Scope

This is a test-only follow-up to [#13191](https://github.com/QwenLM/qwen-code/issues/13191), checked against main `5ddd43815b`. It does not change stored digests, migrations, API responses, or the execution implementation in [#13530](https://github.com/QwenLM/qwen-code/pull/13530).

The original issue includes historical claims. R1-4, R1-7, R1-11, R1-13 and R2-3 were handled in #13142. Its proposed R2-1 locking change was reverted after real MySQL testing found deadlocks; the reported interleaving was accepted as a legal serial history. This change adds no replacement lock or stronger concurrency guarantee.

## Coverage

| Follow-up     | Contract protected                                                                                                                                                                   | Test layer                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| R1-14         | An invalid update key returns the declared `400` response.                                                                                                                           | Existing API contract exchange          |
| R1-15         | Required-only content is accepted; absent and null optional fields normalize equally; supplied optional content is stored, and changing the environment template appends a revision. | Existing HTTP/database definition tests |
| R1-16         | Replaying an update after a newer revision exists returns its original revision without changing the head.                                                                           | Existing HTTP/database revision test    |
| R1-17         | Omitting any of the four required fields is refused without storing a definition.                                                                                                    | Existing request-validation test        |
| R1-18 / R1-19 | Race recovery receives the digest covering operation, content and update agent ID; a different committed request conflicts for both create and update.                               | Existing service tests                  |
| R2-2          | Refusing the matrix collection path stores no revision and consumes no command key.                                                                                                  | Existing HTTP/database refusal test     |
| M9            | A competing revision insert produces `agent_revision_conflict`; rollback leaves the losing key retryable.                                                                            | MySQL integration test                  |
| M14 / M15     | Tenants in both definition and command storage, and command keys, compare case-sensitively.                                                                                          | MySQL integration tests                 |

The MySQL race uses a second connection that commits after the losing transaction reads the head. No timing sleep or mocked duplicate-key exception decides its outcome. Case tests exercise reads, writes and replay through the migrated tables, because H2 cannot protect MySQL collation behavior.

## Validation

Run the focused definition, service and API contract suites; the three selected MySQL cases; Java Checkstyle; and the repository build and typecheck. Verify regression sensitivity with temporary changes to the relevant production behavior or isolated MySQL table collations, then restore the candidate before the final run. Passing counts alone do not establish sensitivity.

There is no UI change: only tests and this design are changed. The protected production paths remain the public definition API and its database stores.

## Remaining follow-ups

R1-6 (timestamp representation), R1-10 (creator provenance), and the aggregate request-size bound still require contract decisions. R1-12 (revision grammar in the contract) remains a separate contract change. R1-5/R1-8/R1-9 need focused materialization/query evidence and coordination with #13530's store changes. These items remain in #13191; this PR must not close the entire issue.
