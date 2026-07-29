# Web Shell Composer Intent Suggestions

## Summary

Extend Web Shell's existing new-topic suggestion so one conservative
classification can recommend either asking a side question with `/btw` or
sending a substantial new topic in a fresh session.

The composer continues to show at most one non-blocking action. A valid
`none` decision renders nothing. Invalid, failed, or cancelled classifications
also render nothing.

## Decision contract

```ts
type SuggestionKind = 'btw' | 'new_session' | 'none';

interface SuggestionDecision {
  suggestion: SuggestionKind;
  confidence: number;
}
```

Only `btw` and `new_session` decisions at or above the existing confidence
threshold become actionable. The actionable state records the exact classified
draft and source session so both can be checked again when the user clicks.

## Behavior

- `btw` is for a quick, self-contained side question that should not disturb
  the main task.
- `new_session` is for a clearly different, substantial task or topic.
- `none` covers continuations, uncertainty, and drafts that fit neither action.
- BTW classification starts after one prior user/assistant exchange. New-session
  suggestions keep their stricter existing context thresholds.
- Follow-up-like wording may be classified for BTW, but can never use the
  relaxed BTW threshold to surface a new-session action.
- Clicking a `btw` suggestion submits `/btw <draft>` through the existing
  editor path, which preserves the command's current history and composer-clear
  semantics.
- A draft with an image or composer tag is never eligible for `btw`.
- `new_session` retains the existing clear, detach, create, and auto-submit
  sequence, including image preservation and session-race cancellation.

## Safety

The classifier remains conservative and fail-closed:

- malformed output, unknown actions, invalid confidence, errors, and
  cancellation produce no action;
- a session change aborts pending classification and invalidates a visible
  suggestion;
- a draft or attachment change invalidates a visible suggestion;
- click handling checks the current draft, source session, and attachment state
  immediately before executing;
- attachments are treated as present until ChatEditor reports otherwise, so a
  transient unknown state cannot expose a `/btw` action.

## Scope

The change stays inside Web Shell. It reuses existing daemon session generation,
editor submission, and `/btw` behavior. It does not add daemon or SDK routes,
change styling, or introduce a general-purpose suggestion framework.

## Composer performance

Draft changes enter the classifier through a stable callback. They update the
classifier's refs, cancellation state, and debounce timer without updating
React state. The Web Shell app only rerenders when an actionable suggestion
appears or an existing suggestion is invalidated.

This keeps intent classification off the composer's render path while
preserving immediate cancellation when the draft changes.

## Test strategy

- Hook tests cover the three decision values, strict parsing, confidence,
  attachment gating, and stale-session results.
- App tests cover `/btw` execution and composer clearing, stale draft/session
  rejection, attachment rejection, the existing new-session races, and the
  absence of an app rerender while classification is pending.
- ChatEditor tests cover attachment-presence reporting.
