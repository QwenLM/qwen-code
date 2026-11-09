# Mod prompt submission

[English](2026-10-30-mod-prompt-submit.md) | [简体中文](2026-10-30-mod-prompt-submit.zh-CN.md)

Status: proposed. This stage follows the turn events in #15443 and is tracked in #13749. It follows the Claude Code 2.1.310 plugin API declarations of `prompt.submit` and `$.prompt.submit`.

## Problem and current behavior

Mods written for Claude Code act on the prompts a person sends:

- A guard drops a prompt that holds a credential, with `{ drop: reason }`.
- A Mod rewrites a prompt, for example to expand a shorthand, with `next({ ...e, text })`.
- A Mod attaches context the model reads beside the prompt and the person never sees, with `next({ ...e, context: [...] })`.
- A Mod sends a prompt of its own once the session is idle, with `$.prompt.submit`.

Qwen Code skips `prompt.submit` hooks at load and reports `Hooks for unsupported events will not run: prompt.submit`. A guard written there silently does not run.

## Goals and non-goals

Goals, in six pull requests:

1. Core and headless runs: the event, its rules and its context. This document lands with it.
2. The Ink terminal.
3. The OpenTUI terminal.
4. `$.prompt.submit` in core and headless runs, described in section 9.
5. `$.prompt.submit` in the Ink terminal.
6. `$.prompt.submit` in the OpenTUI terminal.

Non-goals:

- Slash commands, which Claude Code raises with `command`. They come with a later step on command rows.
- Prompts the host starts on its own: background notifications, scheduled prompts, teammate messages, goal continuations and the continuation of an interrupted turn. Claude Code marks some of these with `isMeta`. A prompt a Mod submits with `$.prompt.submit` is in scope, as section 9 describes, though the person did not type it either.
- Prompts typed while a turn runs that steer it at a model boundary.
- `attachments` and `$.prompt.media`.

## Proposed changes

### 1. When it fires

`prompt.submit` fires for each prompt a person submits, and from step 4 for each prompt a Mod submits (section 9), after the host has its text and before anything reads it: before UserPromptSubmit, before `@` references are read and before the user message is recorded or shown. Only a host that raises the event loads its hooks; any other host skips them at startup with the usual line, so a guard is never silently bypassed. Step 1 raises it in headless runs, for the `-p` prompt and each stream-json user message. Step 2 raises it in the Ink terminal, as described in section 7, and step 3 in the OpenTUI terminal, as described in section 8.

### 2. Input

| Field     | Value                                                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`    | the prompt as submitted, with pasted text expanded; for a stream-json message, its text blocks                                                |
| `context` | absent as the host raises it                                                                                                                  |
| `wait`    | `false`                                                                                                                                       |
| `origin`  | `{ kind: 'sdk' }` in headless runs; `{ kind: 'composer' }` in the terminals; `{ kind: 'plugin', name, asUser? }` for a prompt a Mod submitted |
| `turnId`  | absent until a terminal raises the event for a prompt typed during a turn                                                                     |

A hook passes `text` and `context` on to `next`; `origin`, `wait` and `turnId` are pinned. `context` is a list of texts.

### 3. What enters

The prompt that enters is the one that arrives beneath the hooks, as in Claude Code: the worker records the `text` and `context` that reach the bottom of the chain. `next(e)` resolves to them with the origin. What a hook answers after its `next` resolved changes nothing, and only a drop there is checked.

The chain settles one of three ways:

- the prompt arrived beneath the hooks: it enters with its text and context;
- a hook answered `{ drop: reason }`: the prompt is dropped by a hook;
- the chain settled without reaching the bottom, because a hook answered `{ text }` without `next`: the prompt is not submitted, as Claude Code's `a hook answered without passing the prompt on`.

A hook that answers a drop after calling `next` fails, as in Claude Code: its `.catch` is asked, or it is skipped and its last `next` stands. A hook that fails or times out is skipped, and a failed worker lets the prompt through unchanged, so a broken plugin never blocks a prompt.

### 4. Rewrite and context

A rewritten text replaces the prompt everywhere the host keeps it: the text sent to the model, the text `@` processing reads, the `turn.start` text, the transcript record and its display text. A stream-json message that also has blocks other than text reaches the model as text with those blocks serialized; the hooks hear only its text blocks, and a rewrite replaces them, with the other blocks after it, in the model's text and in the transcript alike, as without a rewrite.

The context joins UserPromptSubmit's `additionalContext` in the hidden block core already appends after the prompt, ahead of it, escaped the same way. The client takes it as a new send option, `promptContext`, which only the prompt's own UserQuery spends. The transcript records the block as hook context, so resume hides it and compaction keeps it the way it keeps UserPromptSubmit's.

### 5. Drop

A drop stops the prompt before UserPromptSubmit and before any model request, and starts no turn. The reason is one line, kept to its first 4,096 characters with an ellipsis after, as Claude Code keeps it. Headless runs end with the error result `Prompt dropped by a hook: <reason>`, or `Prompt not submitted: a hook answered without passing the prompt on`, and exit code 1. A stream-json session goes on to its next message.

### 6. Limits

A prompt longer than half a Mod payload (128 KiB as JSON) reaches no hook, and the line `prompt.submit hook skipped: the prompt is too long for a Mod payload` appears where transcript logs do. Claude Code passes it whole. A rewrite or context that makes a hook's answer larger than a Mod payload fails that hook.

### 7. The Ink terminal

The Ink terminal raises the event in `prepareQueryForLlm`, for a prompt the person typed, before the input history records it, before its row is added and before `@` references are read. It loads the hooks only once it raises the event: `InteractiveModSession.initialize` takes `{ prompts: true }`, and the terminal host passes it on to the load request. The first `initialize()` call decides, since it is the one that loads the Mods: `{ prompts: true }` must ride that call, because a later call cannot turn prompt hooks on. A host that draws a band initializes once, with both.

- **Which prompts.** A typed prompt, including one queued while a turn runs, which raises the event when it is sent. Slash commands, shell-mode commands, scheduled prompts, notifications, teammate messages and retries raise none.
- **Queued prompts wait for the turn to end.** The terminal normally sends a prompt typed during a turn into that turn at the next tool boundary. While a Mod hooks `prompt.submit`, that boundary takes none, so each queued prompt is sent, and heard, once the turn ends.
- **What the hooks hear.** The text the person typed, with pasted text expanded. Attachment references and the one-shot notices the terminal puts ahead of a prompt for the model alone, such as a resumed worktree, are not part of it.
- **A rewrite.** It replaces the typed text in the model's prompt, with the attachment references and notices still ahead of it, and in the prompt's row, the input history, the cancel restore, the workflow keywords and `turn.start`. The terminal finds the typed text at the end of the model's prompt by framing its pastes as the composer did. Each paste the rewrite gives back whole is collapsed and framed again; a rewrite that does not give every paste back whole is refused, as below. An answer that differs from the prompt only in surrounding whitespace is no rewrite.
- **A drop.** The reason is shown as an error line. The prompt gets no row and is not written to the input history. It goes back to the input box with its pastes collapsed, ahead of anything typed since, so the person can edit it and send it again.
- **Esc while the hooks run.** It cancels the prompt, which goes back to the input box the same way.

### 8. The OpenTUI terminal

The OpenTUI terminal raises the event at two sites. The live turn (`useOpenTuiLiveTurn`) raises it for a prompt the person typed, before its row is added, before the input history records it and before `@` references are read. The command dispatcher (`OpenTuiSlashDispatcher`) raises it for `?`-form input, before the input history records it and before the command runs. It opts in the same way, through `initialize(['AbovePrompt'], { prompts: true })`, in the one call that loads the Mods.

- **Which prompts.** The same as in Ink: a typed prompt, including one queued while a turn runs, which raises the event when it becomes a turn. Slash-form text, shell-mode commands, prompts a slash command generates and retries raise none. Slash-form text sent with an attached image is the exception: the shell sends it to the model as a prompt, so it raises the event like any typed prompt. `?`-form input such as `?btw`, which OpenTUI runs as a command and Ink sends as a prompt, is typed text too: the hooks hear it with its pastes expanded before it is recorded or run, a drop refuses it and hands it back, and a rewrite runs in its place. A rewrite must keep the command the person typed; one that resolves to another command, or leaves `?`-form, is refused with an error line and runs nothing. Context the hooks attach rides the first send of a turn the command starts, such as a skill's; `?btw` starts none, so its context is not used.
- **Queued prompts wait for the turn to end**, as in Ink: while a Mod hooks `prompt.submit`, the tool boundary takes no queued prompt.
- **What the hooks hear.** The typed text with its pastes expanded. The composer sends attached images as parts of their own beside the text, and OpenTUI adds no notices to a prompt, so the hooks hear the whole of the prompt's text.
- **The row waits for the hooks.** Without prompt hooks the row is added when the prompt is submitted. With them, it is added once the hooks let the prompt through, holding the rewrite if there is one; until then the turn shows as working.
- **A prompt sent while the Mods load waits for them**, as in Ink, so the first prompt of a session cannot pass before its hooks load. If the Mods fail to load, the prompt is refused with the line Ink shows and goes back to the input box. Slash-form text neither waits nor is refused, as in Ink, unless it carries an attached image and so goes to the model as a prompt. A session that fails to start before it loads the Mods is not a Mod failure: its prompts go on to the send, which reports the session's own error.
- **A rewrite.** It replaces the prompt's text for the model, the row and its recall text, the input history, the cancel restore, the `UserPromptSubmit` provenance and `turn.start`. Attached images stay after it. Each paste the rewrite gives back whole is collapsed and framed again; a rewrite that does not give every paste back whole is refused, as below. Surrounding whitespace alone is no rewrite.
- **A drop.** The reason is shown as an error line, the prompt gets no row and no input history entry, and it goes back to the input box with its pastes collapsed, ahead of anything typed since.
- **Esc while the hooks run.** The prompt goes back to the input box ahead of the prompts queued behind it and of anything typed since. When a dialog has the input box closed, the prompt waits for the box to open again and the queued prompts stay queued.

### 9. A Mod's own prompt: `$.prompt.submit`

`$.prompt.submit({ text, asUser? })` submits a prompt a Mod wrote, to start a turn of its own once the session is idle.

- **The call.** It is an API event, like the other `$` methods: the worker raises `prompt.submit` with the input `{ text, wait: false, origin: { kind: 'plugin', name, asUser? } }`, `name` being the caller's. The hooks it runs through are every hook but the caller and those the caller runs beneath, which the existing frames of a `$` call leave out; the caller's plugin's other hooks hear it. A call of another shape rejects, and `attachments` reject with a line of their own. A call whose text is empty or only whitespace, or longer than half a Mod payload (128 KiB as JSON), resolves to a drop without raising the event; an input too large for any Mod call rejects.
- **The bottom of the chain.** Once every hook has answered, what last arrived beneath them goes to the host as `{ plugin, text, context?, asUser? }`, so a hook that calls `next` twice queues one prompt. The host queues it or says why not, and the call resolves to `{ text, context?, origin }` or to `{ drop }`. A hook's drop, a hook that answers without `next`, or a hook that passes on an empty text or one past half a payload queues nothing. Held to half a payload, what the call resolves to always fits a Mod payload, so a queued prompt is never reported as failed.
- **When it resolves.** At the end of that chain, inside the dispatch of the hook that called. The worker runs one dispatch at a time and waits for a dispatch's calls before it ends, so a call that waited for its turn to start would hold up the very dispatch that keeps the session from being idle. The chain's hooks do not run beneath the calling hook, so a call the hook does not await still queues after the hook has returned. For the same reason the call does not pause the caller's budget as other calls do: a hook that went on running while the call was pending would otherwise run unbudgeted. A hook that awaits it is charged for the time the other Mods' `prompt.submit` hooks take.
- **Where hosts take it.** A host that runs such prompts passes a queue at load, and the load request says so. `$.session.version()` lists the method only then; elsewhere a call resolves to a drop without raising the event. Step 4 passes one in headless runs. In step 5 the Ink terminal passes one too: `InteractiveModSession.initialize` takes `{ runsPrompts: true }` beside `{ prompts: true }`, in the call that loads the Mods, and the session tells the terminal each time a prompt is queued. In step 6 the OpenTUI terminal passes `{ runsPrompts: true }` in its own load call.
- **The turn.** When the run is idle, the prompt runs as a turn of its own after the queue's earlier items: a `UserQuery` with the Mod's text as the submitted prompt and the context the hooks attached, so UserPromptSubmit hears it and it counts toward the session turn limit. `@` references are not read. The turn raises `turn.start` and `turn.complete`. A slash command that answers with a message, as a Mod command does, starts no turn of its own: when it leaves a Mod's prompt queued, the run shows its reply and goes on to run the prompt, and ends with one result. Text output, which prints only the run's last answer, writes the reply as it comes. A worktree notice the run would have given the command goes with the first request the run sends.
- **The Ink terminal.** Once the session is idle, the terminal takes the next prompt and submits it as a `UserQuery` with the framed text, the Mod's text as the submitted prompt and the hooks' context, as a headless run does. It waits for the prompts the person queued, for the background notifications that can run now, and while a Goal owns the session's turns, since the prompt is neither the person's words nor a turn the Goal asked for. A Monitor update waiting out the minimum interval between its turns does not hold it: a Monitor that prints within every interval would hold it for as long as it runs. The prompt does not pass the Mods' `prompt.submit` hooks again, is not written to the input history, reads no `@` reference and runs no command, slash form or shell mode alike. Its row is a notification line, `Mod <name>: <text>`, sanitized for the terminal, with `asUser` too, since the person did not type it; it is not a turn to rewind to, and a cancel does not hand it to the input box. A submission that wins the same idle moment leaves the prompt queued, uncounted, and the drain runs again once that submission settles, since it may start no turn. A dual-output sidecar receives the Mod's text as a user message and then a `mod_prompt` system message, as a stream-json client does. A resumed session shows the record's display text in the same row.
- **The OpenTUI terminal.** Once the session is idle, the shell asks the live turn (`runModPrompt`) to take the next prompt and run it as a turn of its own, sent as in Ink: a `UserQuery` with the framed text, the Mod's text as the submitted prompt, the hooks' context, the Mod's name and its recall query. It waits for the prompts and commands the person queued, while a dialog owns the UI, while a `!` command runs, and while a submission the person sent is still being routed through the command registry and dispatcher, since that submission may yet start a turn. It also waits while a Goal owns the session's turns, as in Ink, since the prompt is neither the person's words nor a turn the Goal asked for, and the shell tries again when the Goal lets go of them. OpenTUI runs no background notification turns, so none holds it. The prompt does not pass the Mods' `prompt.submit` hooks again, is not written to the input history, reads no `@` reference and runs no command. Its row is an info line with the text Ink shows, `Mod <name>: <text>`; a cancel does not hand it to the input box, and the prompt a stopped turn left at the end of the conversation is taken out, as in Ink. A resumed session shows the same line: OpenTUI now draws the notification items Ink draws as info rows, so a resumed session also shows the background agent and cron lines it used to leave out. A dual-output sidecar receives the Mod's text and a `mod_prompt` system message, as in Ink.
- **What the model reads.** Unless the Mod passed `asUser`, the text goes inside a `<qwen:mod-prompt mod="<name>">` block, followed by a line saying the Mod sent it and it waited until the session was idle, that the person did not type it, and that it is a request on the person's behalf within what they asked for and allowed. Every `<` and `>` inside the text is escaped, as for the hooks' context, so no spelling of a closing marker can end the block. With `asUser` the model reads the text as it is.
- **The record.** The transcript keeps the prompt as a user message with the provenance `mod_prompt`, the Mod's name and its text as the display text. Goal evidence and the session-agent view read only the person's words, so neither takes it for theirs. It keeps its turn's place among the texts a session title is drawn from but offers the title nothing, and it does not by itself make the title read only those texts, so a session whose prompts recorded no display text still draws its title from the conversation, with the Mod's message, as the model read it, left out; one sent with `asUser` is not left out, since its bare text reads as the person's and would match a prompt the person typed alike. It does not count as a prompt in the commit attribution. Memory recall searches for the Mod's text, not the frame. A stream-json client, which did not send the prompt, receives its text as a user message and then a `mod_prompt` system message naming the Mod, before the turn's output.
- **The turn limit.** The Mods' prompts start at most 8 turns, queued ones counted, before the person sends a prompt. Past that, a call resolves to a drop and the line `$.prompt.submit refused: …` appears where transcript logs do. In a headless run the prompt the run was given is the person's, and in a stream-json session each message the client sends is, a slash command too. In the Ink and OpenTUI terminals each prompt or command the person sends is; as in Ink, a prompt or command typed during a turn and queued counts when it runs, not when it is sent, so a stop the turn before it made still holds until then. In OpenTUI, steering text sent into a running turn counts as soon as the turn takes it; in Ink it does not count, and the stop and the count hold until the person's next prompt runs. A switch to another session, by `/clear` or `/resume`, starts the new one with nothing queued and the count at 0, and a prompt submitted while the old one ends is refused as `the session is ending`.
- **What does not run.** A prompt queued for a session that `/clear` or `/resume` replaced, one queued once the session is closing, and one still queued when a run stops early on an interrupt, a structured result, a detected loop or a slash command that fails. In the Ink and OpenTUI terminals, one still queued when the person stops a turn, with Esc or by declining every tool it asks to run. Until the person sends a prompt again, a call then resolves to a drop, `the person stopped a turn and has not sent a prompt since`, so a `turn.complete` hook of the stopped turn, which runs after the stop, starts no turn. A turn a Mod ends with `$.turn.abort` keeps them, so a Mod can stop a turn and redirect it.

## Design decisions

- **The host raises the event.** Each host already holds the submitted text before it expands or records it. Raising the event there keeps the rewrite ahead of every use of the text without changing core's send.
- **UserPromptSubmit runs after the Mod hooks, in core.** Claude Code runs both in one admission and lets a settings hook's block beneath turn `next(e)` into `{ drop }`. Here the bottom of the chain does not wait for UserPromptSubmit, which runs later in the send and can take as long as its commands. A Mod that must know whether UserPromptSubmit blocked a prompt can read `turn.start`, which only an admitted prompt raises.
- **Hosts opt in.** The load request says whether the host raises `prompt.submit`, as it names the sites it draws for `ui.render`, so each step enables only the host it adds.
- **The context shares the hook context block.** It reaches the model, the transcript and resume the way UserPromptSubmit's context does, so no new record kind is needed. A context the conversation already holds word for word is not sent again, as for UserPromptSubmit. Each Mod context and UserPromptSubmit's count on their own, so a Mod context that changes every turn does not make an unchanged UserPromptSubmit context repeat.

- **A dropped prompt is kept out of the input history.** The input history is written to disk and comes back in later sessions, and a guard usually drops a prompt for what it holds, such as a credential. Keeping it out of that history keeps the guard's purpose. Handing it back to the input box still lets the person fix it without retyping; whatever was typed since stays after it.
- **Steering waits while prompt hooks are loaded.** Steering appends queued text to the tool results of a running turn and has no prompt of its own to hold back or rewrite. Holding queued prompts until the turn ends lets every prompt the person types pass the hooks, at the cost of mid-turn steering for sessions with such a hook.
- **In OpenTUI the row waits for the hooks.** A guard drops a prompt for what it holds, so a row that showed the prompt first would display what the guard meant to keep out, and a rewrite would replace a row the person had already seen. The row is held while a Mod hooks `prompt.submit` and until the Mods finish loading, so the transcript never shows a prompt before the hooks that may drop it can answer; sessions whose Mods hook nothing pay only the load. A prompt typed during a turn still shows in the queued-messages strip until it is sent, as the input box showed it: the strip is the person's own pending input, it is not recorded, and the prompt leaves it when the hooks hear it.
- **A rewrite gives every paste back whole, or it is refused.** The model is told which text was pasted, so it treats that text as material rather than as the person's instructions. The hooks hear the pastes expanded, so the terminal finds each paste in a rewrite by its text. A paste that comes back edited inside, removed or repeated cannot be found, and sending the rewrite would hand the model pasted text as if the person had typed it. The terminal refuses such a rewrite with an error line and hands the prompt back, in Ink, in OpenTUI and for `?`-form input alike. A guard that must keep a paste out drops the prompt. The same text pasted twice is found when it appears twice.
- **`$.prompt.submit` resolves when its prompt is queued.** The worker's single dispatch is what keeps a hook's calls from outliving it; a call that resolved at its turn's start would need a call that survives its dispatch, and a hook that awaited it would hold the session busy so the turn never started. Resolving once the hooks have answered matches what `next(e)` already does for a typed prompt, so a Mod reads the same shape at the same moment either way.
- **The model is told who sent a Mod's prompt.** A prompt the person did not type should not read as theirs: the model weighs a person's words above a tool's, and a Mod can run code the person never looked at. The block names the Mod, and the line after it gives the prompt the standing of a request made for the person. `asUser` is the Mod's choice to send the text as the person's words, as the API allows.
- **A Mod's prompt has a provenance of its own.** The transcript marks the person's prompts as theirs, and a Goal's verifier reads those as what the person asked for. A prompt a Mod wrote under the person's provenance would let a Mod speak for them there; a provenance of its own keeps every reader that looks for the person's words from finding it. The session title and the commit attribution's prompt count read the person's prompts in other ways, so each skips a Mod's prompt on its own.
- **A limit on the Mods' turns.** A hook that submits at every `turn.complete` would keep a session busy forever, and in a headless run would never let it exit. Eight turns covers a Mod that follows up a few times; the person's next prompt resets the count, so an interactive session keeps going while the person does.
- **Stopping a turn stops the Mods' prompts until the person speaks again.** A person who presses Esc, or declines the tools a turn asks for, wants the session's work to stop; a Mod's prompt starting as soon as the session is idle would undo that, and a Mod that submits at every turn could only be stopped by its limit. Dropping the queue is not enough, since the stopped turn's `turn.complete` hooks run after the stop. Refusing only until those hooks settle is not enough either: the prompt a hook submits without awaiting reaches the host after the other Mods' `prompt.submit` hooks, which can be after the hook has returned. The person's next prompt is the point at which they ask for work again, and it already resets the turn count. The Mod's own `$.turn.abort` keeps the queue, since ending a turn to submit another is what a Mod may mean by it.
- **The terminals show a Mod's prompt as a notification line.** A user row would read as something the person typed, and would offer the prompt to rewind and to the input box. The line names the Mod, the same way live and on resume, and in Ink and OpenTUI alike.
- **In OpenTUI a Mod's prompt waits for what the person sent.** The shell routes each submission through the command registry and the dispatcher before it becomes a turn, and both can take a moment while the session looks idle. A Mod's prompt that started then would run ahead of what the person just sent, which would then wait behind it.
- **UserPromptSubmit hears a Mod's prompt.** It is a prompt entering the session, and a settings hook that guards prompts should not be bypassed because a Mod wrote one.
- **The hooks hear the typed text, not the model-only notices.** The person wrote the typed text; the notices belong to the terminal and change from session to session. A rewrite replaces only what the person typed, so a guard cannot drop the terminal's notices by accident.

## Differences from Claude Code

These go into the user guide:

- Slash commands and prompts the person did not type raise none, so `command` and `isMeta` never appear.
- `attachments` never appears, and `$.prompt.media` does not exist.
- A UserPromptSubmit block does not turn `next(e)` into `{ drop }`, and `next(e)` resolves before the turn starts.
- A context the conversation already holds word for word is not sent again, each Mod context and UserPromptSubmit's on its own.
- A prompt longer than 128 KiB as JSON reaches no hook.
- A headless drop is an error result with exit code 1.
- `$.prompt.submit` resolves once its prompt is queued, not once its turn starts, and takes no `attachments`.

## Validation and acceptance

- Real QuickJS worker tests:
  - which plugins hear the event, and a host that raises none skipping its hooks;
  - the prompt and context that arrive beneath the hooks, and an answer after `next` that changes nothing;
  - a hook's drop, and a hook that answers without `next`;
  - a downstream drop's reason survives a post-next text answer across plugins, within one plugin, and during recovery; a caught late drop does not replace a later local continuation's outcome or mark a host continuation as called;
  - a drop after `next`, a changed `origin` or `wait`, a context that is not a list, a wrong answer and a throw, each skipped;
  - a `.catch` that drops for a failed guard.
- Mod session tests: no hooks, the origin, a rewrite with context, a drop's one line and its 4,096 characters, a failed worker, a cancelled prompt, and a prompt too long for a payload.
- Client test: the Mods' context ahead of UserPromptSubmit's, escaped, with and without UserPromptSubmit hooks, and only for a new prompt.
- OpenTUI live-turn tests: a rewrite with context in the sent prompt, the row, the input history and `turn.start`; a paste kept whole beside an attached image; a rewrite that changed a paste refused and handed back; the context a `?`-form command carries reaching its turn's send; a whitespace-only answer; a drop handed back with its pastes; Esc while the hooks run, with and without a composer; a prompt sent while the Mods load waiting for them, refused and handed back when they fail, and handed back on Esc while it waits; queued prompts held from the tool boundary and heard, with their pastes expanded, when they run; no event for slash-form text or a generated prompt, and an event for slash-form text sent with an image.
- OpenTUI dispatcher tests for `?`-form input: the hooks hear it with pastes expanded and a rewrite keeps a paste framed; a rewrite that changed a paste is refused; a drop refuses it; a rewrite that leaves `?`-form, turns into the slash form or resolves to another command is refused; the hooks' context reaches the turn a command starts; it waits for Mods that are still loading, is refused when they fail, and is refused on Esc while it waits; the shell hands a refused input back, at once or from the queue in the order sent with its pastes, and keeps it for the input box when a queued command behind it opens a dialog.
- Headless tests: the rewritten prompt and its context reaching the send and `turn.start`, a drop in JSON and text, and no event for a slash command or a notification.
- The built CLI against a fixture server in headless JSON, text and stream-json: a rewrite that the model request and the transcript both hold, context in the hidden block, a drop, and a guard whose `.catch` drops.
- `$.prompt.submit`:
  - real QuickJS worker tests: the event through every hook but the caller's and those it runs beneath, the origin, what is queued and what the call resolves to; a hook's drop, a hook that answers without `next`, an empty text from the caller or a hook, and a host's refusal queuing nothing; a call the hook does not await, under a slow hook, queued once as it last arrived though a hook called `next` twice; a host that runs no such prompts; calls of the wrong shape;
  - Mod session tests: a stop dropping the queue, refusing calls and puts-back until the person's prompt or a new session; the queue in order, the turn limit counting queued and started prompts, its line, the person's prompt resetting it, a replaced or closing session, a run discarding what has not started, a queue for a terminal only once it runs the prompts and its notice of each, and a prompt put back uncounted, once, and only into its own session;
  - the record: provenance `mod_prompt` and the Mod's name; the title projection keeping its place with nothing in it, live and on resume, and a title drawn from the conversation leaving the Mod's message out; no attribution count;
  - the frame: the Mod named, a closing marker in any spelling escaped, `asUser` read as it is;
  - a prompt past half a payload, from the call or a hook, dropped before it is queued, and an input too large for the bridge rejecting;
  - Goal evidence leaving a `mod_prompt` record out beside a person's;
  - title keys kept least recently used, and none for an `asUser` prompt;
  - a Mod command's reply in text output, and the worktree notice reaching the prompt it hands on;
  - a stream-json run that stops early not carrying a Mod's prompt into the next one, and memory recall reading the Mod's text;
  - headless tests on both loops: a prompt queued while the person's turn ended running after it, framed, with its context and submitted prompt, an `asUser` prompt read bare, `turn.start` for each turn, and a Mod command's prompt running after its reply with no turn for the command;
  - Ink stream tests: a queued prompt running once idle as a `UserQuery` with the frame, its submitted prompt, the Mod's name, its recall query and context, `turn.start` hearing its text, under a notification row and with no user row, no `prompt.submit` hooks, no input history and no `@` read; an `asUser` prompt sent bare with no command run from it; queued prompts one turn after another; waiting for the person's queued prompts and for a Goal that owns the turns; the person's prompt, not a Mod's, resetting the count; Esc and declining every tool stopping the queue, and `$.turn.abort` keeping it; a Monitor update in its interval not holding a prompt, one that can run now going first; a prompt put back when its turn cannot start, and run once the winning submission settles; the dual-output sidecar receiving the Mod's text and name; the owner's opt-in and its queue's notice;
  - resume: a `mod_prompt` record restored as the Mod's notification line, `asUser` too;
  - OpenTUI live-turn tests: a queued prompt running as a turn with the frame, its submitted prompt, context and Mod, under the Mod's line with no user row and no input log, `turn.start` hearing its text; an `asUser` slash-form prompt sent bare as no command; one turn at a time; none taken while a Goal owns the turns; Esc and declining every tool stopping the queue and taking the stopped prompt out of the conversation, `$.turn.abort` keeping it, and Esc with no turn stopping nothing;
  - OpenTUI send tests: the Mod's name, `asUser` and recall query on the first send only, no `@` read, and the sidecar receiving the Mod's text and name;
  - OpenTUI shell tests: a prompt running once the turn ends and the next once it is queued; waiting for a command the person sent that is still running, which resets the count; running after the commands the turn held back; waiting while a Goal owns the turns and running once it lets go;
  - OpenTUI resume: a `mod_prompt` record restored as the Mod's info line with no user row, and a notification item drawn as an info row;
  - the built CLI in a real terminal, Ink and OpenTUI, against a fixture server (`integration-tests/interactive/mods-prompt-submit.test.ts`): a `turn.complete` hook's prompt running after the person's turn under the Mod's line, framed in the second request and recorded as the Mod's, and a hook that submits at every turn stopped at the limit;
  - the built CLI against a fixture server (`integration-tests/cli/mods-prompt-submit.test.ts`): a `turn.complete` hook that submits, the second request holding the frame and the hooks' context, the transcript record as the Mod's, an `asUser` prompt read bare, and a hook that submits at every turn stopped at the limit.

## Risks and open questions

- A slow hook delays the prompt by up to its budget, 10 seconds a hook.
- Masking a slash command's arguments needs `command.run` today; `prompt.submit` with `command` comes later.
- A Mod's prompt waits while a Goal owns the session's turns, and runs once the Goal stops, or not at all if the person stops a turn first.
