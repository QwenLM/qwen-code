// labels.ts — centralized labels for edges and other enums

export const EDGE_LABELS = {
  DEFAULT: 'default',
  TRUE: 'true',
  FALSE: 'false',
  ON_ERROR: 'onError',
} as const;

export type EdgeLabel = (typeof EDGE_LABELS)[keyof typeof EDGE_LABELS];
