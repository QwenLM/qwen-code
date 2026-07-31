/**
 * TerminalOutput - Terminal-style display for command output
 *
 * Platform-agnostic component for displaying terminal output with:
 * - ANSI color code support
 * - Grep output line number highlighting
 * - Light/dark theme support
 * - Copy functionality
 */

import * as React from 'react'
import { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal, Copy, Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import { parseAnsi, stripAnsi, isGrepContentOutput, parseGrepOutput } from './ansi-parser'

export type ToolType = 'bash' | 'grep' | 'glob'

export interface TerminalOutputProps {
  /** The command that was executed */
  command: string
  /** The output from the command */
  output: string
  /** Exit code (0 = success) */
  exitCode?: number
  /** Tool type for display styling */
  toolType?: ToolType
  /** Optional description of what the command does */
  description?: string
  /** Theme mode */
  theme?: 'light' | 'dark'
  /** Additional class names */
  className?: string
}

/**
 * TerminalOutput - Display terminal command and output with ANSI colors
 */
export function TerminalOutput({
  command,
  output,
  exitCode,
  toolType = 'bash',
  description,
  theme = 'light',
  className,
}: TerminalOutputProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState<'command' | 'output' | null>(null)

  const isDark = theme === 'dark'

  // Theme-aware colors for inner elements (outer bg inherits from overlay's bg-background)
  const textColor = isDark ? '#e4e4e4' : '#1a1a1a'
  const mutedColor = isDark ? '#888888' : '#666666'
  const matchColor = '#22c55e' // Green for grep matches
  const cmdColor = isDark ? '#60a5fa' : '#2563eb' // Blue for command
  const codeBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'
  const outputBg = isDark ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.03)'

  // Copy to clipboard (strip ANSI codes for clean text)
  const copyToClipboard = useCallback(async (text: string, type: 'command' | 'output') => {
    try {
      await navigator.clipboard.writeText(stripAnsi(text))
      setCopied(type)
      setTimeout(() => setCopied(null), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [])

  // Memoize ANSI-parsed output for performance
  const parsedOutput = useMemo(() => {
    if (!output) return []
    return parseAnsi(output)
  }, [output])

  // Check if this looks like grep content output
  const isGrepOutput = useMemo(() => {
    if (!output) return false
    return isGrepContentOutput(output)
  }, [output])

  // Parse grep output if applicable
  const grepLines = useMemo(() => {
    if (!isGrepOutput || !output) return []
    return parseGrepOutput(output)
  }, [isGrepOutput, output])

  return (
    <div
      className={cn('h-full w-full overflow-auto px-5 py-4 font-mono text-sm', className)}
      style={{ fontFamily: '"JetBrains Mono", monospace' }}
    >
      {/* Command section */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-xs" style={{ color: mutedColor }}>
            <Terminal className="w-3 h-3" />
            <span>Command</span>
          </div>
          <button
            onClick={() => copyToClipboard(command, 'command')}
            className={cn(
              'p-1 rounded transition-colors',
              isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'
            )}
            title={copied === 'command' ? t('common.copied') : t('terminal.copyCommand')}
          >
            {copied === 'command' ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" style={{ color: mutedColor }} />
            )}
          </button>
        </div>
        <div className="overflow-x-auto">
          <code className="text-foreground">{command}</code>
        </div>
      </div>

      {/* Output section */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-xs" style={{ color: mutedColor }}>
            <Terminal className="w-3 h-3" />
            <span>{t('terminal.output')}</span>
            {exitCode !== undefined && (
              <span
                className="px-1.5 py-0.5 rounded text-[10px]"
                style={{
                  backgroundColor: exitCode === 0 ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                  color: exitCode === 0 ? 'rgb(34, 197, 94)' : 'rgb(239, 68, 68)',
                }}
              >
                exit {exitCode}
              </span>
            )}
          </div>
          <button
            onClick={() => copyToClipboard(output, 'output')}
            className={cn(
              'p-1 rounded transition-colors',
              isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'
            )}
            title={copied === 'output' ? t('common.copied') : t('terminal.copyOutput')}
          >
            {copied === 'output' ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" style={{ color: mutedColor }} />
            )}
          </button>
        </div>
        <pre
          className="overflow-auto"
          style={{ color: textColor }}
        >
          {/* Grep output with line number highlighting */}
          {isGrepOutput && grepLines.length > 0 ? (
            <div className="space-y-0">
              {grepLines.map((line, i) => (
                <div
                  key={i}
                  className="flex"
                  style={{
                    backgroundColor: line.isMatch ? 'rgba(34, 197, 94, 0.08)' : undefined,
                  }}
                >
                  {/* Line number */}
                  {line.lineNum && (
                    <span
                      className="select-none pr-3 text-right shrink-0"
                      style={{
                        color: line.isMatch ? matchColor : mutedColor,
                        minWidth: '3rem',
                      }}
                    >
                      {line.lineNum}
                      <span style={{ color: line.isMatch ? matchColor : (isDark ? '#444444' : '#cccccc') }}>
                        {line.isMatch ? ':' : '-'}
                      </span>
                    </span>
                  )}
                  {/* Content */}
                  <span
                    className="whitespace-pre-wrap break-words"
                    style={{ color: line.isMatch ? textColor : mutedColor }}
                  >
                    {line.content}
                  </span>
                </div>
              ))}
            </div>
          ) : parsedOutput.length > 0 ? (
            /* ANSI-colored output */
            <div className="whitespace-pre-wrap break-words">
              {parsedOutput.map((span, i) => (
                <span
                  key={i}
                  style={{
                    color: span.fg,
                    backgroundColor: span.bg,
                    fontWeight: span.bold ? 'bold' : undefined,
                    // Add padding for background colors
                    padding: span.bg ? '0 2px' : undefined,
                    borderRadius: span.bg ? '2px' : undefined,
                  }}
                >
                  {span.text}
                </span>
              ))}
            </div>
          ) : (
            <span style={{ color: mutedColor }}>(no output)</span>
          )}
        </pre>
      </div>
    </div>
  )
}
