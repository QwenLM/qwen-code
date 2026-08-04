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
 * transcript mid-turn. While a turn is in flight the command is suppressed
 * instead of being added to the daemon pending-prompt queue, because local
 * commands must not be replayed as model-facing prompt text.
 *
 * The only call sites that should bypass this and append mid-stream are the
 * deliberate "busy acknowledgement" paths (e.g. clearing a goal while a turn
 * runs), which opt in by calling `append` directly. Read-only display
 * commands (/stats, /about, /context) use `appendLocalUserEchoIfIdle`
 * instead: they skip the echo mid-turn and still run immediately.
 */
export interface LocalEchoSink {
  /** Append the command as a local user message (renders inline immediately). */
  append: (text: string) => void;
}

/**
 * Append a local command's echo, or suppress it if a turn is streaming.
 *
 * @returns `true` if the command was suppressed — the caller must stop and not
 *   run its inline side effects. `false` if it was appended and the caller
 *   should proceed.
 */
export function appendOrDeferLocalUserMessage(
  isStreaming: boolean,
  text: string,
  _images: PromptImage[] | undefined,
  sink: LocalEchoSink,
): boolean {
  if (isStreaming) {
    return true;
  }
  sink.append(text);
  return false;
}

/**
 * Append a local command's echo when idle, skipping it while a turn is
 * streaming — without ever blocking the command itself.
 *
 * Read-only display commands render their result as a status block, which is
 * not a turn boundary in `applyTurnCollapse`, so they can run mid-turn; only
 * the user echo row would split the active turn. Skipping the echo also
 * avoids `appendLocalUserTranscriptMessage` finalizing the in-flight
 * assistant block mid-stream — and the command's result dispatch must pass
 * `clearActiveText: false` for the same reason.
 *
 * Delegates to `appendOrDeferLocalUserMessage` so the idle gate lives in one
 * place; note the inverted polarity — here `true` means "echo appended".
 *
 * @returns `true` if the echo was appended, `false` if it was skipped.
 */
export function appendLocalUserEchoIfIdle(
  isStreaming: boolean,
  text: string,
  sink: LocalEchoSink,
): boolean {
  return !appendOrDeferLocalUserMessage(isStreaming, text, undefined, sink);
}

/**
 * Whether a queued prompt is a slash (`/…`) or shell (`!…`) command rather than
 * model-facing prose.
 *
 * The queue's "insert" action injects the raw text into the running turn via
 * `enqueueMidTurnMessage` — it is NOT re-dispatched as a command, so a command
 * inserted this way reaches the model as the literal string "/context …" and
 * never runs. Callers use this to disable "insert" for command entries that may
 * still exist from daemon/custom command paths or from older sessions.
 */
export function isCommandPrompt(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('/') || trimmed.startsWith('!');
}
