import type { Envelope } from './types.js';

export function stripMessagePrefix(
  text: string,
  prefix: string | undefined,
): string | undefined {
  if (!prefix) return text;

  let candidate = text.trim();
  if (!candidate.startsWith(prefix)) {
    while (candidate.startsWith('@') || candidate.startsWith('<@')) {
      const mention = candidate.match(/^(?:@[^@\s]+|<@[^>]{1,64}>)\s+/u)?.[0];
      if (!mention) return undefined;
      candidate = candidate.slice(mention.length);
    }
  }
  if (!candidate.startsWith(prefix)) return undefined;

  const suffix = candidate.slice(prefix.length);
  if (!/^\s+\S[\s\S]*$/u.test(suffix)) return undefined;
  return suffix.trim();
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
    const at = envelope.text.indexOf(displayText);
    envelope.text =
      at === -1
        ? stripped
        : envelope.text.slice(0, at) +
          stripped +
          envelope.text.slice(at + displayText.length);
  }
  return true;
}
