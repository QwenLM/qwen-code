export function resolveBranchNewPanelOption(options?: { newPanel?: boolean }): boolean {
  return options?.newPanel ?? true
}
