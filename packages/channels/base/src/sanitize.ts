/**
 * Neutralize a platform display name before embedding it in a `[name]` prompt
 * tag: strip the bracket/newline delimiters that would let a crafted nickname
 * break out of the tag (or inject extra lines) and cap the length. Shared by
 * ChannelBase group attribution and adapters that self-prefix (e.g. QQ), so the
 * rules stay identical in every code path.
 */
export function sanitizeSenderName(name: string): string {
  return name.replace(/[[\]\r\n]/g, ' ').slice(0, 64);
}
