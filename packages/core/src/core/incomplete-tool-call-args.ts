/**
 * Marker for tool calls whose arguments arrived unterminated and were repaired
 * into shape by the streaming parser.
 *
 * The scheduler's reject-incomplete-file-writes guard keys on
 * `wasOutputTruncated`, which `turn.ts` derives solely from
 * `finishReason === MAX_TOKENS`. That derivation conflates two different
 * facts: that the arguments were incomplete, and that the output token limit
 * is what cut them. QwenLM/qwen-code#12970 fixed the second half — a provider
 * reporting usage far below the ceiling was not cut off, so rewriting its
 * finish reason to `length` misdiagnosed malformed generation as truncation —
 * but suppressing the rewrite also cleared `wasOutputTruncated`, silently
 * disarming the guard on exactly the responses whose arguments really were
 * incomplete. A repaired half-written `write_file` then executed where the
 * previous behaviour rejected it.
 *
 * This marker carries the fact the guard needs separately from the diagnosis
 * the user-visible message needs, so correcting one cannot withdraw the other.
 * It follows the `PROVIDER_TOOL_CALL_ID` precedent in `toolCallIdUtils.ts`:
 * a non-enumerable symbol on the `FunctionCall`, which survives
 * `GenerateContentResponse.functionCalls` because that getter returns the same
 * object references the converter assigned, and never reaches the wire, a log,
 * or `Object.keys`. Being non-enumerable also means it does not survive an
 * object spread, so every layer that rebuilds a call into a fresh literal must
 * carry it across explicitly (`carryIncompleteArgumentsMarker`).
 */
import type { FunctionCall, Part } from '@google/genai';

const INCOMPLETE_TOOL_CALL_ARGS = Symbol('incompleteToolCallArgs');

type FunctionCallWithIncompleteArgs = FunctionCall & {
  [INCOMPLETE_TOOL_CALL_ARGS]?: true;
};

/** Marks every function call in `parts` as having arrived unterminated. */
export function markToolCallArgumentsIncomplete(
  parts: readonly Part[] | undefined,
): void {
  for (const part of parts ?? []) {
    const functionCall = part?.functionCall;
    if (!functionCall) continue;
    Object.defineProperty(functionCall, INCOMPLETE_TOOL_CALL_ARGS, {
      value: true,
      enumerable: false,
    });
  }
}

export function toolCallArgumentsWereIncomplete(
  functionCall: FunctionCall,
): boolean {
  return (
    (functionCall as FunctionCallWithIncompleteArgs)[
      INCOMPLETE_TOOL_CALL_ARGS
    ] === true
  );
}

/**
 * Carries the marker from `source` onto `target`, a rebuilt copy of the same
 * call. Object spread copies only *enumerable* own properties, so any layer
 * that normalizes a `FunctionCall` into a fresh literal would silently drop
 * the marker and disarm the guard — exactly the failure this module exists to
 * prevent. `normalizeModelToolCallIds` calls this the same way it re-attaches
 * `PROVIDER_TOOL_CALL_ID`.
 */
export function carryIncompleteArgumentsMarker(
  source: FunctionCall,
  target: FunctionCall,
): void {
  if (!toolCallArgumentsWereIncomplete(source)) return;
  Object.defineProperty(target, INCOMPLETE_TOOL_CALL_ARGS, {
    value: true,
    enumerable: false,
  });
}
