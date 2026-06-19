import * as React from 'react'
import { useMemo } from 'react'
import JsonView from '@uiw/react-json-view'
import { vscodeTheme } from '@uiw/react-json-view/vscode'
import { githubLightTheme } from '@uiw/react-json-view/githubLight'
import { Layers, Check, Copy } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'
import { ContentFrame } from './ContentFrame'
import { ShikiCodeViewer } from '../code-viewer/ShikiCodeViewer'
import { TerminalOutput } from '../terminal/TerminalOutput'
import { Markdown } from '../markdown'
import { CodeBlock } from '../markdown/CodeBlock'
import { detectLanguage } from './GenericOverlay'
import type { OverlayCard } from '../../lib/tool-parsers'

export interface ActivityCardsOverlayProps {
  isOpen: boolean
  onClose: () => void
  cards: OverlayCard[]
  title: string
  theme?: 'light' | 'dark'
  onOpenUrl?: (url: string) => void
  onOpenFile?: (path: string) => void
}

const craftAgentDarkTheme = {
  ...vscodeTheme,
  '--w-rjv-font-family': 'var(--font-mono, ui-monospace, monospace)',
  '--w-rjv-background-color': 'transparent',
}

const craftAgentLightTheme = {
  ...githubLightTheme,
  '--w-rjv-font-family': 'var(--font-mono, ui-monospace, monospace)',
  '--w-rjv-background-color': 'transparent',
}

function deepParseJson(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return deepParseJson(JSON.parse(trimmed))
      } catch {
        return value
      }
    }
    return value
  }
  if (Array.isArray(value)) return value.map(deepParseJson)
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) result[k] = deepParseJson(v)
    return result
  }
  return value
}

export function ActivityCardsOverlay({
  isOpen,
  onClose,
  cards,
  title,
  theme = 'light',
  onOpenUrl,
  onOpenFile,
}: ActivityCardsOverlayProps) {
  const jsonTheme = useMemo(() => (theme === 'dark' ? craftAgentDarkTheme : craftAgentLightTheme), [theme])

  const renderMarkdownCard = (card: OverlayCard, content: string) => {
    return (
      <ContentFrame title={card.label}>
        <div className="px-10 pt-8 pb-8">
          <div className="text-sm">
            <Markdown
              mode="minimal"
              onUrlClick={onOpenUrl}
              onFileClick={onOpenFile}
              hideFirstMermaidExpand={false}
            >
              {content}
            </Markdown>
          </div>
        </div>
      </ContentFrame>
    )
  }

  const renderCard = (card: OverlayCard) => {
    const data = card.data
    const isInputCard = card.id === 'input'
    const commandPreview = card.commandPreview

    if (data.type === 'json') {
      const processedData = deepParseJson(data.data) as object
      return (
        <ContentFrame title={card.label}>
          <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-4">
            {isInputCard && commandPreview && (
              <div className="bg-background shadow-minimal rounded-[8px] px-4 py-3 font-mono">
                <div className="text-xs font-semibold text-muted-foreground/70 mb-1">Command</div>
                <div className="text-sm text-foreground overflow-x-auto">
                  <span className="text-muted-foreground select-none">$ </span>
                  <span>{commandPreview}</span>
                </div>
              </div>
            )}

            <div>
              {isInputCard && (
                <div className="text-xs font-semibold text-muted-foreground/70 mb-2 px-1">Input Params</div>
              )}
              <div className="p-4">
                <JsonView value={processedData} style={jsonTheme} collapsed={false} enableClipboard displayDataTypes={false} shortenTextAfterLength={100}>
                  <JsonView.Copied
                    render={(props) => {
                      const isCopied = (props as Record<string, unknown>)['data-copied']
                      return isCopied ? (
                        <Check className="ml-1.5 inline-flex cursor-pointer text-green-500" size={10} onClick={props.onClick} />
                      ) : (
                        <Copy className="ml-1.5 inline-flex cursor-pointer text-muted-foreground hover:text-foreground" size={10} onClick={props.onClick} />
                      )
                    }}
                  />
                </JsonView>
              </div>
            </div>
          </div>
        </ContentFrame>
      )
    }

    if (data.type === 'code') {
      return (
        <ContentFrame title={card.label} fitContent minWidth={850}>
          <ShikiCodeViewer
            code={data.content}
            filePath={data.filePath}
            language={undefined}
            startLine={data.startLine}
            theme={theme}
          />
        </ContentFrame>
      )
    }

    if (data.type === 'terminal') {
      return (
        <ContentFrame title={card.label}>
          <TerminalOutput
            command={data.command}
            output={data.output}
            exitCode={data.exitCode}
            toolType={data.toolType}
            description={data.description}
            theme={theme}
          />
        </ContentFrame>
      )
    }

    if (data.type === 'document') {
      return renderMarkdownCard(card, data.content)
    }

    const lang = detectLanguage(data.content)
    if (lang === 'markdown') {
      return renderMarkdownCard(card, data.content)
    }

    return (
      <ContentFrame title={card.label}>
        <div className="p-4">
          <CodeBlock code={data.content} language={lang} mode="minimal" forcedTheme={theme} />
        </div>
      </ContentFrame>
    )
  }

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{ icon: Layers, label: 'Activity', variant: 'blue' }}
      title={title}
      className="bg-foreground-3"
    >
      <div className="w-full space-y-6 py-1">
        {cards.map((card) => (
          <div key={card.id}>
            {renderCard(card)}
          </div>
        ))}
      </div>
    </PreviewOverlay>
  )
}
