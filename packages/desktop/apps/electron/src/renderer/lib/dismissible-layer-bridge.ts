export type DismissibleLayerType = 'radix-dialog' | 'radix-popover' | 'island' | 'modal' | 'custom'

export interface DismissibleLayerRegistration {
  id: string
  type: DismissibleLayerType
  priority?: number
  isOpen?: boolean
  close: () => void
  canBack?: () => boolean
  back?: () => boolean
}

export interface DismissibleLayerSnapshot {
  id: string
  type: DismissibleLayerType
  priority: number
}

export interface DismissibleLayerBridge {
  registerLayer: (layer: DismissibleLayerRegistration) => () => void
  hasOpenLayers: () => boolean
  getTopLayer: () => DismissibleLayerSnapshot | null
  closeTop: () => boolean
  handleEscape: () => boolean
}

const BRIDGE_KEY = '__craftAgentDismissibleLayerBridge__'

type BridgeHost = typeof globalThis & {
  [BRIDGE_KEY]?: DismissibleLayerBridge | null
}

function getBridgeHost(): BridgeHost {
  return globalThis as BridgeHost
}

export function setDismissibleLayerBridge(bridge: DismissibleLayerBridge | null): void {
  getBridgeHost()[BRIDGE_KEY] = bridge
}

export function getDismissibleLayerBridge(): DismissibleLayerBridge | null {
  return getBridgeHost()[BRIDGE_KEY] ?? null
}
