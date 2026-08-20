export type AnnotationHost = 'turncard' | 'fullscreen'

export interface AnnotationCanAnnotateOptions {
  hasAddAnnotationHandler: boolean
  hasMessageId: boolean
  isStreaming: boolean
}

export function canAnnotateMessage({
  hasAddAnnotationHandler,
  hasMessageId,
  isStreaming,
}: AnnotationCanAnnotateOptions): boolean {
  return hasAddAnnotationHandler && hasMessageId && !isStreaming
}

/**
 * Portal strategy is centralized so host-specific differences are explicit.
 * Fullscreen keeps in-overlay rendering to avoid stack/clip issues with modal hosts.
 */
export function shouldRenderAnnotationIslandInPortal(host: AnnotationHost): boolean {
  return host !== 'fullscreen'
}
