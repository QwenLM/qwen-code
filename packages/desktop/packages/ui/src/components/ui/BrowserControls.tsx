import { useState, useCallback, useRef, useEffect, forwardRef, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, RotateCw, X, Globe } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { cn } from '../../lib/utils'
import { useTranslation } from 'react-i18next'
import { Spinner } from './LoadingIndicator'

/* ------------------------------------------------------------------ */
/*  NavButton – small internal button matching TopBarButton styling   */
/* ------------------------------------------------------------------ */

interface NavButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
}

const NavButton = forwardRef<HTMLButtonElement, NavButtonProps>(
  ({ children, className, disabled, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      className={cn(
        'h-7 w-7 flex items-center justify-center rounded-[6px]',
        'hover:bg-foreground/5 focus:outline-none focus-visible:ring-0',
        'disabled:opacity-30 disabled:pointer-events-none',
        'transition-colors duration-100',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  ),
)
NavButton.displayName = 'NavButton'

/* ------------------------------------------------------------------ */
/*  BrowserControls                                                    */
/* ------------------------------------------------------------------ */

export interface BrowserControlsProps {
  /** Current URL displayed in the address bar */
  url?: string
  /** Whether page is loading (toggles Stop/Reload, shows progress) */
  loading?: boolean
  /** Enable back button */
  canGoBack?: boolean
  /** Enable forward button */
  canGoForward?: boolean
  /** Called when user submits a URL */
  onNavigate?: (url: string) => void
  /** Back button click */
  onGoBack?: () => void
  /** Forward button click */
  onGoForward?: () => void
  /** Reload button click */
  onReload?: () => void
  /** Stop button click */
  onStop?: () => void
  /** Controlled URL input change */
  onUrlChange?: (url: string) => void
  /** Compact layout variant */
  compact?: boolean
  /** Content rendered before navigation buttons */
  leadingContent?: ReactNode
  /** Content rendered after URL bar (e.g. label) */
  trailingContent?: ReactNode
  /** Show animated loading progress bar (default true) */
  showProgressBar?: boolean
  /** Additional CSS classes on the URL bar group (reload + form) */
  urlBarClassName?: string
  /**
   * Minimum left clearance in px. When set, enables window-center mode:
   * back/forward are absolutely positioned and the reload + URL bar
   * centers in the full component width via CSS max(), falling back
   * to this clearance when the component is narrow.
   */
  leftClearance?: number
  /**
   * Website theme color (from `<meta name="theme-color">`).
   * When set, tints the toolbar background like Safari/Chrome.
   * Text and icons automatically adjust for contrast.
   */
  themeColor?: string | null
  /** Additional CSS classes on the root element */
  className?: string
}

/**
 * Validate a color string is safe for CSS interpolation.
 * Only allows hex, rgb/rgba, hsl/hsla, oklch, oklab, lch, lab, color() — rejects anything
 * that could break out of a CSS value context.
 */
const SAFE_CSS_COLOR_RE = /^(#[0-9a-f]{3,8}|(?:rgba?|hsla?|oklch|oklab|lch|lab|color)\([^;{}]*\))$/i
function safeCssColor(color: string | null | undefined): string | null {
  if (!color) return null
  const trimmed = color.trim()
  if (!trimmed || !SAFE_CSS_COLOR_RE.test(trimmed)) return null
  return trimmed
}

/**
 * Parse a CSS color to sRGB relative luminance (0–1).
 * Handles hex (#rgb, #rrggbb) and rgb/rgba (comma or space separated).
 * Returns null for unparseable formats (oklch, lch, etc.).
 */
function colorLuminance(color: string): number | null {
  let r: number, g: number, b: number
  // hex
  const hm = /^#([0-9a-f]{3,8})$/i.exec(color)
  if (hm) {
    const h = hm[1]
    if (!h) return null

    if (h.length === 3) {
      r = Number.parseInt(h.charAt(0).repeat(2), 16)
      g = Number.parseInt(h.charAt(1).repeat(2), 16)
      b = Number.parseInt(h.charAt(2).repeat(2), 16)
    } else if (h.length >= 6) {
      r = Number.parseInt(h.slice(0, 2), 16)
      g = Number.parseInt(h.slice(2, 4), 16)
      b = Number.parseInt(h.slice(4, 6), 16)
    } else {
      return null
    }
  } else {
    // rgb/rgba — comma or space separated
    const rm = color.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/)
    if (!rm) return null

    const rStr = rm[1]
    const gStr = rm[2]
    const bStr = rm[3]
    if (!rStr || !gStr || !bStr) return null

    r = Number(rStr)
    g = Number(gStr)
    b = Number(bStr)
  }
  const toLinear = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

/** Half of the default URL bar max-width (600px), used for CSS max() centering calc */
const HALF_MAX_WIDTH = 300

export function BrowserControls({
  url: controlledUrl,
  loading = false,
  canGoBack = false,
  canGoForward = false,
  onNavigate,
  onGoBack,
  onGoForward,
  onReload,
  onStop,
  onUrlChange,
  compact = false,
  leadingContent,
  trailingContent,
  showProgressBar = true,
  urlBarClassName,
  leftClearance,
  themeColor,
  className,
}: BrowserControlsProps) {
  const { t } = useTranslation()
  const [localUrl, setLocalUrl] = useState(controlledUrl ?? '')
  const [isFocused, setIsFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync with controlled url when not focused
  useEffect(() => {
    if (!isFocused && controlledUrl != null) {
      setLocalUrl(controlledUrl === 'about:blank' ? '' : controlledUrl)
    }
  }, [controlledUrl, isFocused])

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const trimmed = localUrl.trim()
      if (trimmed) {
        onNavigate?.(trimmed)
        inputRef.current?.blur()
      }
    },
    [localUrl, onNavigate],
  )

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      setLocalUrl(value)
      onUrlChange?.(value)
    },
    [onUrlChange],
  )

  const handleFocus = useCallback(() => {
    setIsFocused(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }, [])

  const handleBlur = useCallback(() => {
    setIsFocused(false)
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (controlledUrl != null) {
          setLocalUrl(controlledUrl === 'about:blank' ? '' : controlledUrl)
        }
        inputRef.current?.blur()
      }
    },
    [controlledUrl],
  )

  const safeThemeColor = safeCssColor(themeColor)
  const themeLum = safeThemeColor ? colorLuminance(safeThemeColor) : null
  const isDarkBg = themeLum != null && themeLum < 0.4
  const useWindowCenter = leftClearance != null

  /* Shared: reload / stop button */
  const reloadButton = (
    <NavButton
      aria-label={loading ? t('browser.stopLoading') : t('common.reload')}
      onClick={loading ? onStop : onReload}
    >
      {loading ? (
        <X className="h-[16px] w-[16px] text-foreground/70" style={safeThemeColor ? { color: 'var(--tb-fg)' } : undefined} strokeWidth={1.8} />
      ) : (
        <RotateCw className="h-[15px] w-[15px] text-foreground/70" style={safeThemeColor ? { color: 'var(--tb-fg)' } : undefined} strokeWidth={1.8} />
      )}
    </NavButton>
  )

  /* Shared: URL input form */
  const urlForm = (
    <form className="flex-1 min-w-0" onSubmit={handleSubmit}>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={localUrl}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={t('browser.urlPlaceholder')}
          className={cn(
            'w-full rounded-[8px] bg-transparent px-3 pl-8 text-[13px] text-foreground/70 outline-none transition-all',
            compact ? 'h-[28px]' : 'h-[30px]',
            !safeThemeColor && (isFocused
              ? 'bg-background border border-transparent shadow-minimal'
              : 'border border-foreground/5'),
            safeThemeColor && 'border border-transparent',
          )}
          style={safeThemeColor ? {
            color: isFocused ? (isDarkBg ? '#fff' : '#000') : 'var(--tb-fg)',
            borderColor: 'var(--tb-input-border)',
            ...(isFocused ? { boxShadow: '0 0 0 1.5px var(--tb-focus-ring)' } : {}),
          } : undefined}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
        <span className="absolute inset-y-0 left-3 flex items-center justify-center">
          {loading ? (
            <span className="flex items-center justify-center h-3.5 w-3.5" style={safeThemeColor ? { color: isFocused ? 'var(--tb-fg)' : 'var(--tb-fg-muted)' } : undefined}>
              <Spinner className="text-[11px] text-foreground/40" />
            </span>
          ) : (
            <Globe className="h-3.5 w-3.5 text-foreground/30" style={safeThemeColor ? { color: isFocused ? 'var(--tb-fg)' : 'var(--tb-fg-muted)' } : undefined} />
          )}
        </span>
      </div>
    </form>
  )

  /* Shared: progress bar */
  const progressBar = showProgressBar && (
    <AnimatePresence>
      {loading && (
        <motion.div
          className="pointer-events-none absolute left-0 right-0 bottom-0 h-[2px] bg-gradient-to-r from-transparent via-accent to-transparent"
          style={{ backgroundSize: '220% 100%' }}
          initial={{ opacity: 0 }}
          animate={{
            opacity: 0.9,
            backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'],
          }}
          exit={{ opacity: 0 }}
          transition={{
            opacity: { duration: 0.2, ease: 'easeOut' },
            backgroundPosition: { duration: 1.6, repeat: Infinity, ease: 'easeInOut' },
          }}
        />
      )}
    </AnimatePresence>
  )

  /* ---- Layout ---- */
  return (
    <div
      className={cn(
        'relative flex items-center gap-1',
        compact ? 'h-[40px] px-2' : 'h-[48px] border-b border-foreground/6 px-3',
        className,
      )}
      data-themed={safeThemeColor ? '' : undefined}
      style={{
        ...(safeThemeColor ? {
          backgroundColor: safeThemeColor,
          borderColor: isDarkBg ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
          '--tb-fg': isDarkBg ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)',
          '--tb-fg-muted': isDarkBg ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)',
          '--tb-hover': isDarkBg ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
          '--tb-input-border': isDarkBg ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)',
          '--tb-focus-ring': isDarkBg ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.15)',
        } : {}),
        transition: 'background-color 200ms ease, border-color 200ms ease',
      } as React.CSSProperties}
    >
      {/* Scoped hover styles for themed toolbar — buttons use --tb-hover */}
      {safeThemeColor && (
        <style dangerouslySetInnerHTML={{ __html: `
          [data-themed] button:hover:not(:disabled) { background: var(--tb-hover) !important; }
        `}} />
      )}
      {leadingContent}

      <NavButton aria-label={t('common.back')} disabled={!canGoBack} onClick={onGoBack} style={safeThemeColor ? { color: 'var(--tb-fg)' } : undefined}>
        <ChevronLeft className="h-[18px] w-[18px] text-foreground/70" style={safeThemeColor ? { color: 'inherit' } : undefined} strokeWidth={1.5} />
      </NavButton>
      <NavButton aria-label={t('common.forward')} disabled={!canGoForward} onClick={onGoForward} style={safeThemeColor ? { color: 'var(--tb-fg)' } : undefined}>
        <ChevronRight className="h-[18px] w-[18px] text-foreground/70" style={safeThemeColor ? { color: 'inherit' } : undefined} strokeWidth={1.5} />
      </NavButton>

      <div className="flex-1 flex items-center min-w-0">
        <div className={cn('mx-auto flex items-center gap-1 w-full', urlBarClassName)}>
          {reloadButton}
          {urlForm}
        </div>
      </div>

      {trailingContent}
      {progressBar}
    </div>
  )
}
