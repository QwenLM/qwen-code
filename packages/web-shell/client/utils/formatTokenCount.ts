export function formatTokenCount(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.floor(count / 1000)}k`;
}

/**
 * Context-usage token count — k/M with one decimal (e.g. `53.6k`, `1.0M`),
 * shared by the composer ring tooltip and the /context panel so both
 * surfaces describe the same session identically.
 */
export function formatContextTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return `${count}`;
}

/** `53.6k / 1.0M tokens (5.4%)` — the context ring's hover detail. */
export function formatContextUsageDetail(used: number, size: number): string {
  const pct = size > 0 ? ((used / size) * 100).toFixed(1) : '0.0';
  return `${formatContextTokens(used)} / ${formatContextTokens(size)} tokens (${pct}%)`;
}

/**
 * Token count in megatokens — always `M` with one decimal (e.g. `810.7M`,
 * `9382.8M`), the usage dashboard's convention where even billions read as M.
 * Sub-1M values render raw with locale grouping (e.g. `80`, `12,345`).
 */
export function formatMegaTokens(count: number): string {
  const n = Math.round(count);
  if (Math.abs(n) < 1_000_000) return n.toLocaleString();
  return `${(n / 1_000_000).toFixed(1)}M`;
}
