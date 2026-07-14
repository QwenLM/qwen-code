export interface ToolbarDropdownItem {
  id: string;
  label: string;
  searchText?: string;
}

export function filterToolbarDropdownItems<T extends ToolbarDropdownItem>(
  items: readonly T[],
  query: string,
): T[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...items];
  return items.filter((item) =>
    `${item.label}\n${item.searchText ?? ''}`
      .toLocaleLowerCase()
      .includes(normalized),
  );
}

export function getToolbarItemVisibility({
  availableWidth,
  items,
}: {
  availableWidth: number;
  items: ReadonlyArray<{
    id: string;
    expansionWidth: number;
    ready?: boolean;
  }>;
}): Record<string, boolean> {
  const visibility = Object.fromEntries(
    items.map((item) => [item.id, item.ready !== false]),
  );
  let usedWidth = items.reduce(
    (total, item) => total + (visibility[item.id] ? item.expansionWidth : 0),
    0,
  );

  for (const item of items) {
    if (usedWidth <= availableWidth) break;
    if (!visibility[item.id]) continue;
    visibility[item.id] = false;
    usedWidth -= item.expansionWidth;
  }

  return visibility;
}

export function getToolbarExpansionBudget({
  toolbarWidth,
  leadingWidth,
  rightWidth,
  currentExpansionWidth,
  gap,
}: {
  toolbarWidth: number;
  leadingWidth: number;
  rightWidth: number;
  currentExpansionWidth: number;
  gap: number;
}): number {
  const fixedLeadingWidth = Math.max(0, leadingWidth - currentExpansionWidth);
  return Math.max(0, toolbarWidth - rightWidth - fixedLeadingWidth - gap);
}

export function resolveToolbarModelLabel({
  currentModelLabel,
  lastConfirmedModelLabel,
}: {
  currentModelLabel: string;
  lastConfirmedModelLabel: string;
}): {
  modelLabel: string;
  modelLabelReady: boolean;
  nextConfirmedModelLabel: string;
} {
  const nextConfirmedModelLabel = currentModelLabel || lastConfirmedModelLabel;
  return {
    modelLabel: nextConfirmedModelLabel,
    modelLabelReady: Boolean(nextConfirmedModelLabel),
    nextConfirmedModelLabel,
  };
}
