import type { Envelope } from './types.js';

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
    !candidate.startsWith(prefix) &&
    (candidate.startsWith('@') || candidate.startsWith('<@'))
  ) {
    const mention = candidate.match(/^(?:@[^@\s]+|<@[^>]{1,64}>)\s+/u)?.[0];
    if (!mention) return undefined;
    candidate = candidate.slice(mention.length);
  }
  if (!candidate.startsWith(prefix)) return undefined;

  const suffix = candidate.slice(prefix.length);
  if (!/^\s+\S[\s\S]*$/u.test(suffix)) return undefined;
  return suffix.trim();
}

/**
 * Where to splice the stripped payload into an adapter-composed `text`.
 *
 * An adapter-supplied `displayTextOffset` is authoritative, and validated
 * before use so a stale one cannot corrupt the text. Otherwise the
 * segment is located by search, and a second occurrence makes the
 * location ambiguous: on QQ both the sender nick and the body are
 * attacker-controlled, so a nick equal to the body would put the first
 * occurrence inside the sender tag, leaving the prefix on the dispatched
 * message and corrupting the tag. Ambiguity fails closed rather than
 * picking one.
 */
function locateDisplayText(
  envelope: Envelope,
  displayText: string,
): number | 'ambiguous' {
  const offset = envelope.displayTextOffset;
  if (offset !== undefined && envelope.text.startsWith(displayText, offset)) {
    return offset;
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
  if (!prefix || envelope.bypassMessagePrefix) return true;

  const displayText = envelope.displayText;
  const prefixText = envelope.messagePrefixText;
  const sourceText = prefixText ?? displayText ?? envelope.text;
  const stripped = stripMessagePrefix(sourceText, prefix);
  if (stripped === undefined) return false;
  if (prefixText !== undefined) envelope.messagePrefixText = stripped;

  if (displayText === undefined) {
    envelope.text = stripped;
    return true;
  }

  envelope.displayText = stripped;
  if (envelope.text === displayText) {
    envelope.text = stripped;
  } else if (envelope.text.endsWith(displayText)) {
    envelope.text = envelope.text.slice(0, -displayText.length) + stripped;
  } else {
    const at = locateDisplayText(envelope, displayText);
    if (at === 'ambiguous') return false;
    envelope.text =
      at === -1
        ? stripped
        : envelope.text.slice(0, at) +
          stripped +
          envelope.text.slice(at + displayText.length);
  }
  return true;
}
