import * as React from 'react'
import type { ComponentEntry } from './types'
import { cn } from '@/lib/utils'

type ShadowKind = 'class' | 'inline' | 'arbitrary' | 'runtime'

interface ShadowSpec {
  id: string
  component: string
  file: string
  kind: ShadowKind
  shadow: string
  border: string
  hasExplicitBorder: boolean
  note?: string
  previewClassName?: string
  previewStyle?: React.CSSProperties
}

// Only unresolved items stay here intentionally.
const activeShadowSpecs: ShadowSpec[] = [
  {
    id: 'sortable-list-overlay',
    component: 'SortableList drag overlay',
    file: 'components/ui/sortable-list.tsx',
    kind: 'inline',
    shadow: "boxShadow: '0 0 0 1px rgba(...), 0 15px 15px ...'",
    border: 'none (1px edge is included inside boxShadow first layer)',
    hasExplicitBorder: false,
    previewClassName: 'rounded-[8px] bg-background px-3 py-2 text-sm',
    previewStyle: { boxShadow: '0 0 0 1px rgba(63, 63, 68, 0.05), 0px 15px 15px 0 rgba(34, 33, 81, 0.25)' },
  },
  {
    id: 'ui-browser-controls',
    component: 'BrowserControls focus ring',
    file: 'packages/ui/components/ui/BrowserControls.tsx',
    kind: 'inline',
    shadow: "boxShadow: '0 0 0 1.5px var(--tb-focus-ring)'",
    border: "base state: 'border border-transparent'",
    hasExplicitBorder: true,
    previewClassName: 'rounded-md bg-background border border-transparent px-3 py-2 text-sm',
    previewStyle: { boxShadow: '0 0 0 1.5px var(--ring)' },
  },
  {
    id: 'ui-image-card-stack',
    component: 'ImageCardStack stacked card',
    file: 'packages/ui/components/markdown/ImageCardStack.tsx',
    kind: 'arbitrary',
    shadow: 'shadow-[1px_3px_8px_rgba(0,0,0,0.28)]',
    border: 'none (card depth comes entirely from arbitrary shadow)',
    hasExplicitBorder: false,
    previewClassName: 'rounded-[8px] bg-background px-3 py-2 text-sm shadow-[1px_3px_8px_rgba(0,0,0,0.28)]',
  },
]

const runtimeShadowSpecs: ShadowSpec[] = [
  {
    id: 'browser-pane-overlay',
    component: 'Browser pane live overlay',
    file: 'main/browser-pane-manager.ts + shared/browser-live-fx.ts',
    kind: 'runtime',
    shadow: "overlay.style.boxShadow = 'inset ... color-mix(...)'",
    border: "runtime class: 'border border-foreground/20' on overlay element",
    hasExplicitBorder: true,
    note: 'Main-process runtime overlay for browser live mode (not a React component).',
    previewClassName: 'rounded-[10px] bg-background px-3 py-2 text-sm border border-foreground/20',
    previewStyle: { boxShadow: 'inset 0 0 0 1px color-mix(in oklab, var(--accent) 45%, transparent), inset 0 0 20px color-mix(in oklab, var(--accent) 28%, transparent)' },
  },
]

const kindBadgeClass: Record<ShadowKind, string> = {
  class: 'bg-success/10 text-success',
  inline: 'bg-info/10 text-info',
  arbitrary: 'bg-destructive/10 text-destructive',
  runtime: 'bg-accent/10 text-accent',
}

function ValueBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-foreground/50">{label}</div>
      <div className="rounded-[8px] bg-foreground/3 p-2 text-[11px] text-foreground/70 font-mono leading-snug break-words">
        {value}
      </div>
    </div>
  )
}

function BorderBadge({ hasExplicitBorder }: { hasExplicitBorder: boolean }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-[6px] px-1.5 py-0.5 text-[10px] font-medium',
        hasExplicitBorder ? 'bg-success/10 text-success' : 'bg-foreground/10 text-foreground/70'
      )}
    >
      Border: {hasExplicitBorder ? 'Yes' : 'No'}
    </span>
  )
}

function ShadowSpecCard({ spec }: { spec: ShadowSpec }) {
  return (
    <div className="rounded-[10px] border border-border bg-background p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{spec.component}</div>
          <div className="text-[11px] text-foreground/50 truncate">{spec.file}</div>
        </div>
        <div className="flex items-center gap-1.5">
          <BorderBadge hasExplicitBorder={spec.hasExplicitBorder} />
          <span className={cn('shrink-0 rounded-[6px] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide', kindBadgeClass[spec.kind])}>
            {spec.kind}
          </span>
        </div>
      </div>

      <ValueBlock label="Shadow" value={spec.shadow} />
      <ValueBlock label="Border" value={spec.border} />

      <div className="rounded-[8px] bg-foreground/2 p-3">
        <div className={cn('w-full flex items-center', spec.previewClassName)} style={spec.previewStyle}>
          Shadow + border preview
        </div>
      </div>

      {spec.note && <div className="text-[11px] text-foreground/60">{spec.note}</div>}
    </div>
  )
}

function Section({
  title,
  specs,
  shadowOnly,
}: {
  title: string
  specs: ShadowSpec[]
  shadowOnly: boolean
}) {
  const filteredSpecs = shadowOnly ? specs.filter((s) => !s.hasExplicitBorder) : specs
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="text-xs text-foreground/50">
          {filteredSpecs.length}/{specs.length} items
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {filteredSpecs.map((spec) => <ShadowSpecCard key={spec.id} spec={spec} />)}
      </div>
      {filteredSpecs.length === 0 && (
        <div className="rounded-[8px] border border-border bg-foreground/2 p-3 text-sm text-foreground/60">
          No items in this section match the current filter.
        </div>
      )}
    </section>
  )
}

function CustomShadowsAudit() {
  const [shadowOnly, setShadowOnly] = React.useState(false)

  return (
    <div className="w-full max-w-[1200px] p-6 space-y-6">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Custom Shadows Audit</h2>
        <p className="text-sm text-foreground/70">
          Consolidated review surface for remaining components and runtime overlays that still use non-standard
          shadow styles (custom classes, inline boxShadow, arbitrary shadow values, or runtime-injected shadows).
          Resolved items are intentionally removed so you can focus on what still needs renaming/cleanup.
          Each card lists both the shadow value and border strategy.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-foreground/60">Filter:</span>
        <button
          type="button"
          onClick={() => setShadowOnly(false)}
          className={cn(
            'h-7 px-2.5 rounded-[6px] text-xs font-medium transition-colors',
            !shadowOnly ? 'bg-background shadow-minimal text-foreground' : 'bg-foreground/5 text-foreground/70 hover:bg-foreground/10'
          )}
        >
          All
        </button>
        <button
          type="button"
          onClick={() => setShadowOnly(true)}
          className={cn(
            'h-7 px-2.5 rounded-[6px] text-xs font-medium transition-colors',
            shadowOnly ? 'bg-background shadow-minimal text-foreground' : 'bg-foreground/5 text-foreground/70 hover:bg-foreground/10'
          )}
        >
          Shadow-only (no explicit border)
        </button>
      </div>

      <Section title="Active UI components" specs={activeShadowSpecs} shadowOnly={shadowOnly} />

      <Section title="Runtime overlays (main process)" specs={runtimeShadowSpecs} shadowOnly={shadowOnly} />
    </div>
  )
}

interface AllowedShadowVariant {
  className: string
  note: string
}

const allowedShadowVariants: AllowedShadowVariant[] = [
  { className: 'shadow-none', note: 'No shadow — explicit opt-out.' },
  { className: 'shadow-xs', note: 'Very subtle elevation from base Tailwind token.' },
  { className: 'shadow-minimal', note: 'Design-system default panel elevation.' },
  { className: 'shadow-tinted', note: 'Tinted elevation using --shadow-color (semantic/accent contexts).' },
  { className: 'shadow-thin', note: 'Thin border + light blur stack.' },
  { className: 'shadow-middle', note: 'Mid-depth layered elevation for larger surfaces.' },
  { className: 'shadow-strong', note: 'High-elevation layered shadow.' },
  { className: 'shadow-panel-focused', note: 'Focus-like elevated treatment with emphasis ring.' },
  { className: 'shadow-modal-small', note: 'Modal/dropdown depth profile.' },
  { className: 'shadow-bottom-border', note: 'Inset bottom separator (1.5px).' },
  { className: 'shadow-bottom-border-thin', note: 'Inset bottom separator (1px).' },
]

function VariantPreview({ variant }: { variant: AllowedShadowVariant }) {
  if (variant.className === 'shadow-bottom-border' || variant.className === 'shadow-bottom-border-thin') {
    return (
      <div className="rounded-[8px] border border-border bg-background overflow-hidden">
        <div className={cn('px-3 py-2 text-sm', variant.className)}>Row 1</div>
        <div className={cn('px-3 py-2 text-sm', variant.className)}>Row 2</div>
        <div className="px-3 py-2 text-sm">Last row (no separator)</div>
      </div>
    )
  }

  const style: React.CSSProperties | undefined = variant.className === 'shadow-tinted'
    ? { ['--shadow-color' as any]: 'var(--accent-rgb)' }
    : undefined

  return (
    <div className="rounded-[8px] bg-foreground/2 p-4">
      <div className={cn('rounded-[8px] bg-background px-3 py-2 text-sm', variant.className)} style={style}>
        Preview surface
      </div>
    </div>
  )
}

function ShadowShowcase() {
  return (
    <div className="w-full max-w-[1200px] p-6 space-y-6">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Shadow Showcase</h2>
        <p className="text-sm text-foreground/70">
          Canonical visual gallery of approved shadow variants for the Electron renderer.
          Use these classes instead of arbitrary shadow values or inline boxShadow.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {allowedShadowVariants.map((variant) => (
          <div key={variant.className} className="rounded-[10px] border border-border bg-background p-3 space-y-2">
            <div className="space-y-1">
              <div className="text-sm font-medium">{variant.className}</div>
              <div className="text-[11px] text-foreground/60">{variant.note}</div>
            </div>
            <VariantPreview variant={variant} />
          </div>
        ))}
      </div>
    </div>
  )
}

export const customShadowsComponents: ComponentEntry[] = [
  {
    id: 'shadow-showcase',
    name: 'Shadow Showcase',
    category: 'Custom Shadows',
    description: 'Canonical gallery of all approved shadow variants in the design system.',
    component: ShadowShowcase,
    props: [],
    variants: [],
    layout: 'top',
  },
  {
    id: 'custom-shadows-audit',
    name: 'Custom Shadows Audit',
    category: 'Custom Shadows',
    description: 'Review remaining components/runtime overlays with unresolved custom shadow styles and border strategies.',
    component: CustomShadowsAudit,
    props: [],
    variants: [],
    layout: 'top',
  },
]
