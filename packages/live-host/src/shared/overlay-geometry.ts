export const OVERLAY_GEOMETRY = {
  canvas: { width: 700, height: 620 },
  setup: { x: 158, y: 70, width: 384, height: 480 },
  card: { x: 60, y: 334, width: 234, height: 194 },
  header: { x: 75, y: 349, width: 204, height: 12 },
  orb: { x: 78, y: 381, width: 51, height: 51 },
  orbMotion: { x: 78, y: 381, width: 51, height: 51 },
  toolbar: { x: 75, y: 450, width: 204, height: 41 },
  status: { x: 142, y: 389.5, width: 137, height: 34 },
  summary: { x: 60, y: 541, width: 234, height: 30 },
  caption: { x: 41, y: 239, width: 272, height: 88 },
  preview: { x: 96.5, y: 159, width: 161, height: 107 },
  previewWithCaption: { x: 96.5, y: 122, width: 161, height: 107 },
  previewToggle: { x: 256, y: 408, width: 23, height: 23 },
  settings: { x: 350, y: 32, width: 306, height: 532 },
  settingsBounds: { x: 25, y: 16, width: 647, height: 575 },
  bounds: {
    setup: { x: 142, y: 54, width: 416, height: 512 },
    orb: { x: 25, y: 227, width: 304, height: 364 },
    'orb-preview': { x: 25, y: 110, width: 304, height: 481 },
  },
} as const;

export type OverlayLayout = keyof typeof OVERLAY_GEOMETRY.bounds;
