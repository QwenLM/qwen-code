import type { ParsedMail } from 'mailparser';
import { normalizeAddress } from './config.js';
import { digest, isMessageId } from './state.js';
import type { ReplyRoute } from './state.js';

export function acceptedHeaderSender(
  mail: ParsedMail,
  ownAddress: string,
): string | undefined {
  if (
    mail.headerLines.filter((header) => header.key === 'from').length !== 1 ||
    mail.from?.value.length !== 1
  )
    return undefined;
  const sender = normalizeAddress(mail.from.value[0].address);
  if (!sender || sender === ownAddress) return undefined;
  for (const { key, line } of mail.headerLines) {
    const value = line
      .slice(line.indexOf(':') + 1)
      .trim()
      .toLowerCase();
    if (
      key.startsWith('list-') ||
      key === 'x-qwen-code-agent' ||
      (key === 'auto-submitted' && value.split(';')[0].trim() !== 'no') ||
      (key === 'precedence' && /^(bulk|junk|list)\b/.test(value)) ||
      (key === 'return-path' && value === '<>') ||
      (key === 'content-type' &&
        /^(multipart\/report|message\/delivery-status|message\/disposition-notification)\b/.test(
          value,
        ))
    )
      return undefined;
  }
  if (/^(mailer-daemon|postmaster)@/.test(sender)) return undefined;
  return sender;
}

export function noReplyAddress(address: string): boolean {
  return /^no[-_.]?reply(?:[+.]|@)/i.test(address);
}

export function boundedText(text: string, max: number): string {
  // Bound before splitting; quoted text and signatures remain user content, never instructions.
  const lines = text.slice(0, max).replace(/\r\n/g, '\n').split('\n');
  const end = lines.findIndex(
    (line) =>
      /^\s*>/.test(line) ||
      /^On .{1,300}wrote:\s*$/.test(line) ||
      /^-- ?$/.test(line) ||
      /^-{2,}\s*Original Message\s*-{2,}$/i.test(line),
  );
  return (end < 0 ? lines : lines.slice(0, end)).join('\n').trim();
}

function messageIds(value: unknown): string[] {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? (value.match(/<[^<>]+>/g) ?? [])
      : [];
  return candidates.filter(isMessageId).slice(0, 30);
}

export function replyRoute(
  mail: ParsedMail,
  sender: string,
  fallback: string,
  routes: ReplyRoute[],
  namespace: string,
): ReplyRoute {
  const references = messageIds(mail.references);
  const parent = isMessageId(mail.messageId)
    ? mail.messageId
    : `<${digest(fallback)}@qwen-email.invalid>`;
  const ancestors = [...references, ...messageIds(mail.inReplyTo)];
  const known = [...ancestors]
    .reverse()
    .map((id) =>
      routes.find((route) => route.sender === sender && route.ids.includes(id)),
    )
    .find(Boolean);
  const root = known?.references[0] ?? ancestors[0] ?? parent;
  const refs = [...new Set([root, ...references, parent])];
  const ids = [...new Set([root, ...(known?.ids ?? []), parent])];
  return {
    sender,
    threadId: known?.threadId ?? digest(`${namespace}\0${sender}\0${root}`),
    parent,
    references: [refs[0], ...refs.slice(1).slice(-29)],
    subject: (mail.subject ?? '(no subject)')
      .replace(/[\r\n\0]/g, ' ')
      .slice(0, 200),
    ids: [ids[0], ...ids.slice(1).slice(-63)],
  };
}
