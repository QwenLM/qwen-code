export interface ToolbarDropdownItem {
  id: string;
  label: string;
  searchText?: string;
}

export interface ToolbarDropdownRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ToolbarDropdownGeometry {
  placement: 'above' | 'below';
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
}

const MENU_GAP = 4;
const MENU_INSET = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
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

export function getToolbarDropdownGeometry({
  anchor,
  boundary,
  viewportHeight,
  preferredWidth,
  maxHeight,
}: {
  anchor: ToolbarDropdownRect;
  boundary: ToolbarDropdownRect;
  viewportHeight: number;
  preferredWidth: number;
  maxHeight?: number;
}): ToolbarDropdownGeometry {
  const boundaryLeft = Math.max(0, boundary.left);
  const boundaryRight = Math.min(
    typeof window === 'undefined' ? boundary.right : window.innerWidth,
    boundary.right,
  );
  const availableWidth = Math.max(
    0,
    boundaryRight - boundaryLeft - MENU_INSET * 2,
  );
  const width = Math.min(preferredWidth, availableWidth);
  const left = clamp(
    anchor.left,
    boundaryLeft + MENU_INSET,
    Math.max(boundaryLeft + MENU_INSET, boundaryRight - MENU_INSET - width),
  );

  const boundaryTop = Math.max(0, boundary.top);
  const boundaryBottom = Math.min(viewportHeight, boundary.bottom);
  const above = Math.max(0, anchor.top - boundaryTop - MENU_GAP - MENU_INSET);
  const below = Math.max(
    0,
    boundaryBottom - anchor.bottom - MENU_GAP - MENU_INSET,
  );
  const placement = above >= below ? 'above' : 'below';
  const availableHeight = placement === 'above' ? above : below;

  return {
    placement,
    left,
    ...(placement === 'above'
      ? { bottom: viewportHeight - anchor.top + MENU_GAP }
      : { top: anchor.bottom + MENU_GAP }),
    width,
    maxHeight:
      maxHeight === undefined
        ? availableHeight
        : Math.min(maxHeight, availableHeight),
  };
}

export function getToolbarLabelVisibility({
  availableWidth,
  modelLabelWidth,
  modeLabelWidth,
  modelLabelReady,
}: {
  availableWidth: number;
  modelLabelWidth: number;
  modeLabelWidth: number;
  modelLabelReady: boolean;
}): {
  showModelLabel: boolean;
  showModeLabel: boolean;
} {
  if (!modelLabelReady || availableWidth < modelLabelWidth) {
    return { showModelLabel: false, showModeLabel: false };
  }
  if (availableWidth < modelLabelWidth + modeLabelWidth) {
    return { showModelLabel: true, showModeLabel: false };
  }
  return { showModelLabel: true, showModeLabel: true };
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
