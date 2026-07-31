export const DEFAULT_PET_SIZE = 96;
export const MIN_PET_SIZE = 64;
export const MAX_PET_SIZE = 240;

export function normalizePetSize(size: number): number {
  return Math.round(Math.min(MAX_PET_SIZE, Math.max(MIN_PET_SIZE, size)));
}
