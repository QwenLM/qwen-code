export const OVERLAY_GEOMETRY = {
  canvas: { width: 384, height: 480 },
  orb: { x: 136, y: 296, width: 112, height: 112 },
  orbMotion: { x: 114, y: 274, width: 156, height: 156 },
  toolbar: { x: 80, y: 234, width: 224, height: 36 },
  status: { x: 68, y: 438, width: 248, height: 32 },
  caption: { x: 60, y: 134, width: 264, height: 60 },
  preview: { x: 104, y: 94, width: 176, height: 100 },
  previewWithCaption: { x: 104, y: 26, width: 176, height: 100 },
  previewToggle: { x: 288, y: 288, width: 28, height: 28 },
  bounds: {
    setup: { x: 0, y: 0, width: 384, height: 480 },
    orb: { x: 60, y: 130, width: 264, height: 344 },
    'orb-preview': { x: 60, y: 22, width: 264, height: 452 },
  },
} as const;

export type OverlayLayout = keyof typeof OVERLAY_GEOMETRY.bounds;
