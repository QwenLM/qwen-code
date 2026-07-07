import * as React from 'react'
import { useTranslation } from 'react-i18next'

export interface BrowserEmptyPromptSample {
  short: string
  full: string
}

export interface BrowserEmptyStateCardProps {
  title: string
  description: string
  prompts?: readonly BrowserEmptyPromptSample[]
  showExamplePrompts?: boolean
  showSafetyHint?: boolean
  onPromptSelect?: (prompt: BrowserEmptyPromptSample) => void
}

export function BrowserEmptyStateCard({
  title,
  description,
  prompts = [],
  showExamplePrompts = true,
  showSafetyHint = true,
  onPromptSelect,
}: BrowserEmptyStateCardProps) {
  const { t } = useTranslation()
  return (
    <div className="w-full h-full flex items-center justify-center p-8">
      <div className="w-full max-w-[700px] bg-background shadow-minimal rounded-[8px] overflow-hidden border border-border/30">
        <div className="px-4 py-3 border-b border-border/30 flex items-center bg-muted/20 select-none">
          <h3 className="text-[13px] font-medium text-foreground tracking-tight">
            {title}
          </h3>
        </div>

        <div className="pl-[22px] pr-[16px] py-3 text-sm">
          <p className="text-foreground/65 leading-relaxed">
            {description}
          </p>

          {showExamplePrompts && prompts.length > 0 && (
            <div className="mt-3.5 space-y-1.5">
              {prompts.map((sample, index) => (
                <button
                  key={sample.short}
                  type="button"
                  title={sample.full}
                  onClick={() => onPromptSelect?.(sample)}
                  className="w-fit max-w-full flex items-center gap-1 h-8 px-2.5 rounded-[6px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors text-left cursor-pointer"
                >
                  <span className="w-4 shrink-0 text-[11px] text-foreground/40 tabular-nums">{index + 1}.</span>
                  <span className="truncate text-[12px] text-foreground/70">{sample.short}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {showSafetyHint && (
          <div className="px-4 py-2.5 border-t border-border/30 flex items-center gap-2 bg-muted/20 text-[13px] text-foreground/55">
            <p>
              {t('browser.safetyHint')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
