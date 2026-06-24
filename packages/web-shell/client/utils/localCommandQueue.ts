import type { PromptImage } from '../adapters/promptTypes';

/**
 * Single choke point for echoing a local slash command into the transcript.
 *
 * Some local commands "echo": they append a local user message
 * (`store.appendLocalUserMessage`) and render their result inline. If one runs
 * while a turn is streaming, the injected user row acts as a turn boundary in
 * `applyTurnCollapse` (a turn spans one user message up to the next) and splits
 * the active turn into two — its tool/thinking/token counters are then computed
 * per fragment and come out wrong.
 *
 * Routing every echo through this helper means a command can never append to the
 * transcript mid-turn: while a turn is in flight it is deferred to the prompt
 * queue instead, which re-dispatches it through `handleSubmit` once the turn
 * settles so it runs as its own clean turn. This covers every entry point —
 * keyboard submit and UI affordances (e.g. the status-bar context button) — as
 * long as they funnel through here rather than calling `append` directly.
 *
 * The only call sites that should bypass this and append mid-stream are the
 * deliberate "busy acknowledgement" paths (e.g. clearing a goal while a turn
 * runs), which opt in by calling `append` directly.
 */
export interface LocalEchoSink {
  /** Append the command as a local user message (renders inline immediately). */
  append: (text: string) => void;
  /** Defer the command to the prompt queue for re-dispatch when the turn settles. */
  enqueue: (text: string, images?: PromptImage[]) => void;
}

/**
 * Append a local command's echo, or defer it to the queue if a turn is streaming.
 *
 * @returns `true` if the command was deferred — the caller must stop and not run
 *   its inline side effects (they will run on re-dispatch). `false` if it was
 *   appended and the caller should proceed.
 */
export function appendOrDeferLocalUserMessage(
  isStreaming: boolean,
  text: string,
  images: PromptImage[] | undefined,
  sink: LocalEchoSink,
): boolean {
  if (isStreaming) {
    sink.enqueue(text, images);
    return true;
  }
  sink.append(text);
  return false;
}

/**
 * Whether a queued prompt is a slash (`/…`) or shell (`!…`) command rather than
 * model-facing prose.
 *
 * The queue's "insert" action injects the raw text into the running turn via
 * `enqueueMidTurnMessage` — it is NOT re-dispatched as a command, so a command
 * inserted this way reaches the model as the literal string "/context …" and
 * never runs. Callers use this to disable "insert" for command entries; they
 * still run correctly when the queue drains and re-dispatches them through
 * `handleSubmit`.
 */
export function isCommandPrompt(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('/') || trimmed.startsWith('!');
}
