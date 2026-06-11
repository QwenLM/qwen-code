import type { IslandTransitionConfig } from '../ui'

export type PointerSnapshot = {
  x: number
  y: number
  ts: number
}

const VIEWPORT_PADDING = 12
const DEFAULT_WIDTH_ESTIMATE = 192
const DEFAULT_START_SCALE = 0.25
const MIN_ENTRY_DISTANCE = 20
const MAX_ENTRY_DISTANCE = 132
const FALLBACK_ENTRY_DISTANCE = 44
const SPEED_TO_DISTANCE_FACTOR = 0.065

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function clampIslandAnchorX(anchorX: number, islandWidth: number): number {
  if (typeof window === 'undefined') return anchorX

  const halfWidth = islandWidth / 2
  const minX = VIEWPORT_PADDING + halfWidth
  const maxX = window.innerWidth - VIEWPORT_PADDING - halfWidth

  return clamp(anchorX, minX, maxX)
}

export function getDefaultIslandWidthEstimate(): number {
  return DEFAULT_WIDTH_ESTIMATE
}

export function buildSelectionEntryTransition(from: PointerSnapshot | null, to: PointerSnapshot | null): IslandTransitionConfig {
  if (!from || !to) {
    return {
      entryAngleDeg: 90,
      entryDistancePx: FALLBACK_ENTRY_DISTANCE,
      entryStartScale: DEFAULT_START_SCALE,
    }
  }

  const dx = to.x - from.x
  const dy = to.y - from.y
  const distancePx = Math.hypot(dx, dy)
  const deltaMs = Math.max(12, to.ts - from.ts)
  const speedPxPerSec = distancePx / (deltaMs / 1000)

  const angleDeg = (Math.atan2(dy, dx) * 180 / Math.PI + 540) % 360
  const derivedDistancePx = clamp(
    speedPxPerSec * SPEED_TO_DISTANCE_FACTOR,
    MIN_ENTRY_DISTANCE,
    MAX_ENTRY_DISTANCE,
  )

  return {
    entryAngleDeg: Number.isFinite(angleDeg) ? angleDeg : 90,
    entryDistancePx: Number.isFinite(derivedDistancePx) ? derivedDistancePx : FALLBACK_ENTRY_DISTANCE,
    entryStartScale: DEFAULT_START_SCALE,
  }
}

export function buildAnnotationChipEntryTransition(): IslandTransitionConfig {
  return {
    entryAngleDeg: 90,
    entryDistancePx: 64,
    entryStartScale: DEFAULT_START_SCALE,
  }
}
