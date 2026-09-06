# Web Shell Composer Performance

## Problem

Composer input competes with several unrelated or document-wide operations:

- intent classification previously lifted every settled draft into `App`;
- input highlighting rescanned the complete CodeMirror document;
- slash and mention menus rebuilt unchanged state and could render unbounded
  category or command lists;
- the touch textarea reread computed styles after every input;
- transcript store notifications rerendered Web Shell once per streaming chunk.

These costs are small in an empty session but compound with long drafts, large
command sets, and active streaming.

## Design

Keep work proportional to what is visible or changing:

- intent classification receives drafts through a stable callback and only
  updates React when its visible suggestion changes;
- input decorations cover CodeMirror's visible ranges;
- slash completion reads only the current line and translates its result back
  to document coordinates;
- command and mention menus expose at most 50 immediately rendered results and
  reuse semantically unchanged menu state;
- inline-tag presence checks stop at the first decoration while retaining
  ordinary document-change mapping;
- mobile browsers use CSS intrinsic textarea sizing when available, while the
  fallback caches its computed height cap;
- Web Shell subscribes to transcript blocks through an animation-frame
  boundary, coalescing streaming notifications before they reach `App` or
  split chat panes;
- the shared streaming-state hook subscribes to its derived enum instead of
  rerendering consumers for block updates that keep the same state.

Search still reaches commands and providers outside the initial 50-item view.
Transcript consumers receive the newest complete snapshot at most once per
animation frame.

## Safety

- Suggestion cancellation, stale-draft checks, and session checks remain
  synchronous.
- CodeMirror rebuilds decorations when the document or viewport changes.
- The mobile JavaScript auto-grow path remains as a fallback when
  `field-sizing: content` is unsupported.
- Approval extraction, goal state, transcript callbacks, and message
  conversion all consume the same framed transcript snapshot.

## Verification

- A draft waiting for intent classification does not rerender the app shell.
- A 10,000-line composer scans only its visible line for input decorations.
- A slash refresh in a 10,000-line draft does not serialize the document again,
  and multiline replacement coordinates remain correct.
- Removing the final inline tag through an ordinary document change clears
  attachment state.
- Slash and mention menus cap their immediate result sets at 50.
- Repeating an unchanged mention refresh preserves state identity.
- Mobile input does not reread computed styles after mount.
- One hundred transcript notifications in a frame produce one React update
  containing the latest snapshot.
- Equivalent transcript updates do not rerender streaming-state-only
  consumers.
