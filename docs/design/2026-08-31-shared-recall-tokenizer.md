# Shared Recall Tokenizer Primitives

## Context

Core auto-memory recall and channel memory recall independently implement
NFKC normalization, lowercasing, and code-point bigram generation for CJK
text. Keeping those mechanics duplicated makes it possible for equivalent
memory text to normalize or split differently after a future change.

The two callers are not otherwise equivalent. Their token policies and
selection algorithms intentionally differ and must remain local.

| Behavior                  | Core auto-memory                                     | Channel memory                               |
| ------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| Unsafe invisible handling | Unchanged                                            | Replaced with spaces                         |
| CJK runs                  | Han, Hiragana, Katakana, and Hangul may form one run | Each script forms a separate run             |
| Other scripts             | Unicode letters, marks, and numbers                  | Latin letters and decimal numbers            |
| Latin/number minimum      | Three code points                                    | Two code points                              |
| Latin and numbers         | May form one token                                   | Separate namespaced terms                    |
| CJK terms                 | Raw bigrams                                          | Script-namespaced bigrams                    |
| Token bound               | First 32 and last 32 unique tokens                   | Unbounded set                                |
| Matching                  | Query tokens against normalized document substrings  | Exact term overlap between message and entry |

## Goals

- Share the NFKC-plus-lowercase normalization primitive.
- Share adjacent code-point bigram generation.
- Keep a thin caller-specific tokenizer around each existing policy.
- Preserve every current term, score, ordering rule, limit, and fallback.

## Non-goals

- Unifying the two token sets.
- Changing recall ranking, scoring, limits, or fallback behavior.
- Adding configuration or a tokenizer framework.
- Redesigning memory storage or context assembly.

## Proposed design

Expose two side-effect-free helpers from a narrow channel-base subpath:

- `normalizeRecallText(text)` returns `text.normalize('NFKC').toLowerCase()`.
- `codePointBigrams(run)` yields each adjacent pair while iterating Unicode
  code points rather than UTF-16 code units.

Core keeps its combined CJK run expression, Unicode non-CJK token policy,
deduplication, and 64-token edge bound. Channel memory keeps unsafe-invisible
sanitization, per-script expressions, namespaces, minimum lengths, and its
unbounded term set. These existing caller-specific functions are the thin
adapters; no new class or configuration layer is needed.

The selected package home is a side-effect-free
`@qwen-code/channel-base/recallTokenizer` export. Channel-base cannot depend
on core because channel plugins intentionally use channel-base as their only
Qwen Code dependency. The reverse dependency has no source cycle and avoids a
new publishable package. It does require building channel-base before core and
declaring channel-base as a core build/test prerequisite.

A dedicated shared package was considered and rejected for this change. It
would require new build, lockfile, publication, release-order, and versioning
surface for two small functions.

Official triage on issue #9377 leaves this choice to the implementer and names
this dependency direction as a natural option. The implementation can be
validated locally while the external PR waits for maintainer feedback.

## Downstream consumers

Core auto-memory flows through `MemoryManager.recall` into `QwenClient`'s
managed recall path used to assemble initial and tool-result model context.
Channel memory flows through `ChannelBase` selection and prompt formatting;
`PollingChannelBase` and the DingTalk, DWS, Feishu, GitHub, GitLab, QQBot,
Telegram, WeCom, Weixin, and plugin-example adapters consume that path.

The refactor must therefore keep both public selection functions unchanged:

- `selectRelevantAutoMemoryDocuments`
- `selectRelevantChannelMemory` and its prepared-index variant

## Verification

Characterization tests pin the intentional differences before extraction,
including cross-script CJK runs, mixed letters and numbers, non-Latin scripts,
NFKC input, and the core-only token bound. Primitive tests cover empty,
single-code-point, BMP, and supplementary-plane input.

After extraction, run the focused core and channel recall suites, then the
repository build and typecheck. This is a behavior-preserving internal
refactor, so no model-backed or TUI E2E flow should change.
