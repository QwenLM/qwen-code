export function formatTokenCount(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.floor(count / 1000)}k`;
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
