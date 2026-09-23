/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function stringifyWorkflowResult(
  result: unknown,
  pretty = false,
): string {
  if (result === undefined) return '(workflow returned no value)';
  if (typeof result === 'string') return result;
  try {
    return (
      JSON.stringify(result, null, pretty ? 2 : undefined) ?? String(result)
    );
  } catch {
    return `(workflow returned a non-JSON-serializable value of type ${typeof result})`;
  }
}

export function truncateWorkflowText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = '… (truncated)';
  let end = Math.max(0, maxChars - marker.length);
  const before = text.charCodeAt(end - 1);
  const after = text.charCodeAt(end);
  if (
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  ) {
    end -= 1;
  }
  return `${text.slice(0, end)}${marker.slice(0, maxChars)}`;
}
