import { useState, useEffect } from 'react'
import { Dithering } from '@paper-design/shaders-react'

const FALLBACK_COLOR = '#2D8CFF'

function rgbToHex(r: number, g: number, b: number): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

function isGreyscale(r: number, g: number, b: number): boolean {
  return Math.max(r, g, b) - Math.min(r, g, b) < 15
}

function useAccentColor(): string {
  const [color, setColor] = useState(FALLBACK_COLOR)

  useEffect(() => {
    // --accent-rgb is pre-computed as "R, G, B" integers — no oklch resolution needed
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim()
    if (!raw) return
    const parts = raw.split(',').map((s) => Number(s.trim()))
    if (parts.length !== 3 || parts.some(isNaN)) return
    const r = parts[0]!
    const g = parts[1]!
    const b = parts[2]!
    if (isGreyscale(r, g, b)) return // keep blue fallback for greyscale accents
    setColor(rgbToHex(r, g, b))
  }, [])

  return color
}

export interface BrowserShaderProps {
  className?: string
  rounded?: boolean
  borderRadius?: string
  maskImage: string
  opacity?: number

  // TurnCard+HDR shader params
  colorBack?: string
  colorFront?: string
  shape?: 'warp' | 'simplex' | 'dots' | 'wave' | 'ripple' | 'swirl' | 'sphere'
  type?: '2x2' | '4x4' | '8x8' | 'random'
  size?: number
  speed?: number
  scale?: number
  maxPixelCount?: number
  minPixelRatio?: number
}

export function BrowserShader({
  className,
  rounded = false,
  borderRadius = '8px',
  maskImage,
  opacity = 0.85,
  colorBack = 'rgba(0,0,0,0)',
  colorFront,
  shape = 'warp',
  type = '4x4',
  size = 2,
  speed = 0.55,
  scale = 0.78,
  maxPixelCount = 350000,
  minPixelRatio = 1,
}: BrowserShaderProps) {
  const accentColor = useAccentColor()
  const resolvedColor = colorFront ?? accentColor

  return (
    <div
      className={`${className ?? ''} ${rounded ? 'overflow-hidden' : ''}`.trim()}
      style={{
        opacity,
        borderRadius: rounded ? borderRadius : 0,
        WebkitMaskImage: maskImage,
        maskImage,
      }}
    >
      <Dithering
        width="100%"
        height="100%"
        colorBack={colorBack}
        colorFront={resolvedColor}
        shape={shape}
        type={type}
        size={size}
        speed={speed}
        scale={scale}
        maxPixelCount={maxPixelCount}
        minPixelRatio={minPixelRatio}
      />
    </div>
  )
}
