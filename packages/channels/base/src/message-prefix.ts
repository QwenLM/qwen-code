import type { Envelope } from './types.js';

export function startsWithMessagePrefix(text: string, prefix: string): boolean {
  return (
    text.startsWith(prefix) &&
    (text.length === prefix.length || /\s/u.test(text.charAt(prefix.length)))
  );
}

export function stripMessagePrefix(
  text: string,
  prefix: string | undefined,
): string | undefined {
  if (!prefix) return text;

  let candidate = text.trim();
  // The prefix is re-checked every iteration, not once before the loop: a
  // configured prefix may itself start with `@` or `<@` (nothing rejects
  // `@qwen_bot` as a prefix), and consuming it as a mention token would
  // reject every correctly-prefixed message that carries a leading
  // mention of someone else.
  while (
    !startsWithMessagePrefix(candidate, prefix) &&
    (candidate.startsWith('@') || candidate.startsWith('<@'))
  ) {
    const mention = candidate.match(/^(?:@[^@\s]+|<@[^>]{1,64}>)\s+/u)?.[0];
    if (!mention) return undefined;
    candidate = candidate.slice(mention.length);
  }
  if (!startsWithMessagePrefix(candidate, prefix)) return undefined;

  const suffix = candidate.slice(prefix.length);
  if (!/^\s+\S[\s\S]*$/u.test(suffix)) return undefined;
  return suffix.trim();
}

/**
 * Where to splice the stripped payload into an adapter-composed `text`.
 *
 * An adapter-supplied `displayTextOffset` is authoritative, and validated
 * before use so a stale one cannot corrupt the text. Without an offset, a
 * trailing segment is preferred for adapters that append the user body after
 * sender context. Other duplicate occurrences are ambiguous: on QQ both the
 * sender nick and the body are attacker-controlled, so guessing could splice
 * inside the sender tag. Ambiguity fails closed rather than picking one.
 */
function locateDisplayText(
  envelope: Envelope,
  displayText: string,
): number | 'ambiguous' {
  const offset = envelope.displayTextOffset;
  if (offset !== undefined && envelope.text.startsWith(displayText, offset)) {
    return offset;
  }
  if (offset === undefined && envelope.text.endsWith(displayText)) {
    return envelope.text.length - displayText.length;
  }
  const first = envelope.text.indexOf(displayText);
  if (first === -1) return -1;
  return envelope.text.indexOf(displayText, first + 1) === -1
    ? first
    : 'ambiguous';
}

export function applyMessagePrefix(
  envelope: Envelope,
  prefix: string | undefined,
): boolean {
  if (!prefix || envelope.bypassMessagePrefix || envelope.syntheticText) {
    return true;
  }

  const displayText = envelope.displayText;
  const prefixText = envelope.messagePrefixText;
  const sourceText = prefixText ?? displayText ?? envelope.text;
  const stripped = stripMessagePrefix(sourceText, prefix);
  if (stripped === undefined) return false;

  if (displayText === undefined) {
    if (prefixText !== undefined) envelope.messagePrefixText = stripped;
    envelope.text = stripped;
    return true;
  }

  const at = locateDisplayText(envelope, displayText);
  if (at === 'ambiguous' || at === -1) return false;

  if (prefixText !== undefined) envelope.messagePrefixText = stripped;
  envelope.displayText = stripped;
  envelope.text =
    envelope.text.slice(0, at) +
    stripped +
    envelope.text.slice(at + displayText.length);
  return true;
}
