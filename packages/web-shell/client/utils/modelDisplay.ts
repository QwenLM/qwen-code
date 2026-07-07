export function getModelDisplayName(modelId: string): string {
  return modelId.replace(/\([^()]+\)$/, '');
}
