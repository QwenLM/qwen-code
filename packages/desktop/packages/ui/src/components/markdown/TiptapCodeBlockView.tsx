import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { NodeViewWrapper, NodeViewContent, ReactNodeViewRenderer } from '@tiptap/react'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import CodeBlockShiki from 'tiptap-extension-code-block-shiki'
import { bundledLanguages } from 'shiki'
import { Check, ChevronDown, Copy } from 'lucide-react'
import { SimpleDropdown, SimpleDropdownItem } from '../ui/SimpleDropdown'
import { TiptapHoverActions, TiptapHoverActionButton } from './TiptapHoverActions'
import { cn } from '../../lib/utils'

interface TiptapCodeBlockViewProps {
  node: ProseMirrorNode
  updateAttributes: (attrs: Record<string, unknown>) => void
}

type CodeLanguageOption = {
  value: string | null
  label: string
  searchTerms: string[]
}

const EXCLUDED_LANGUAGES = new Set(['mermaid', 'latex', 'math', 'tex', 'katex'])
const PRIORITY_LANGUAGES = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'python',
  'json',
  'bash',
  'sql',
  'yaml',
  'markdown',
  'html',
  'css',
]

const LANGUAGE_ALIASES: Record<string, string[]> = {
  javascript: ['js'],
  typescript: ['ts'],
  python: ['py'],
  bash: ['sh', 'shell', 'zsh'],
  yaml: ['yml'],
  markdown: ['md'],
}

function formatLanguageLabel(value: string): string {
  if (value === 'tsx' || value === 'jsx') return value.toUpperCase()
  return value
    .split(/[-_]/g)
    .filter((part) => part.length > 0)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join(' ')
}

function buildLanguageOptions(): CodeLanguageOption[] {
  const allSupported = Object.keys(bundledLanguages)
    .filter((lang) => !EXCLUDED_LANGUAGES.has(lang))

  const prioritized = PRIORITY_LANGUAGES.filter((lang) => allSupported.includes(lang))
  const remaining = allSupported
    .filter((lang) => !PRIORITY_LANGUAGES.includes(lang))
    .sort((a, b) => a.localeCompare(b))

  const ordered = [...prioritized, ...remaining]

  return [
    {
      value: null,
      label: 'Plain text',
      searchTerms: ['plain', 'text', 'txt'],
    },
    ...ordered.map((value) => ({
      value,
      label: formatLanguageLabel(value),
      searchTerms: [value, ...(LANGUAGE_ALIASES[value] ?? [])],
    })),
  ]
}

const CODE_LANGUAGE_OPTIONS = buildLanguageOptions()

function normalizeLanguage(language: string | null | undefined): string | null {
  const normalized = language?.trim().toLowerCase()
  return normalized && normalized.length > 0 ? normalized : null
}

function getLanguageLabel(language: string | null | undefined): string {
  const normalized = normalizeLanguage(language)
  const found = CODE_LANGUAGE_OPTIONS.find((option) => option.value === normalized)
  if (found) return found.label
  return normalized ?? 'Plain text'
}

/**
 * React NodeView for regular code blocks only.
 *
 * Mermaid/LaTeX use dedicated rich block node types:
 * - mermaidBlock
 * - latexBlock
 */
function TiptapCodeBlockView({ node, updateAttributes }: TiptapCodeBlockViewProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = React.useState(false)
  const [languageFilter, setLanguageFilter] = React.useState('')
  const [languageDropdownOpen, setLanguageDropdownOpen] = React.useState(false)
  const [highlightedLanguageIndex, setHighlightedLanguageIndex] = React.useState(0)
  const copyTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const languageFilterInputRef = React.useRef<HTMLInputElement>(null)
  const languageOptionRefs = React.useRef<Array<HTMLButtonElement | null>>([])

  const currentLanguage = normalizeLanguage((node.attrs.language as string | undefined) ?? null)
  const languageLabel = getLanguageLabel(currentLanguage)

  const filteredLanguageOptions = React.useMemo(() => {
    const query = languageFilter.trim().toLowerCase()
    if (!query) return CODE_LANGUAGE_OPTIONS

    return CODE_LANGUAGE_OPTIONS.filter((option) => {
      if (option.label.toLowerCase().includes(query)) return true
      return option.searchTerms.some((term) => term.toLowerCase().includes(query))
    })
  }, [languageFilter])

  const handleLanguageSelect = React.useCallback((language: string | null) => {
    updateAttributes({ language })
  }, [updateAttributes])

  React.useEffect(() => {
    languageOptionRefs.current = []
  }, [filteredLanguageOptions])

  React.useEffect(() => {
    if (!languageDropdownOpen) return

    const selectedIndex = filteredLanguageOptions.findIndex((option) => option.value === currentLanguage)
    setHighlightedLanguageIndex(selectedIndex >= 0 ? selectedIndex : 0)
  }, [languageDropdownOpen, currentLanguage, filteredLanguageOptions])

  React.useEffect(() => {
    if (highlightedLanguageIndex < filteredLanguageOptions.length) return
    setHighlightedLanguageIndex(Math.max(0, filteredLanguageOptions.length - 1))
  }, [filteredLanguageOptions.length, highlightedLanguageIndex])

  React.useEffect(() => {
    if (!languageDropdownOpen) return
    languageOptionRefs.current[highlightedLanguageIndex]?.scrollIntoView({ block: 'nearest' })
  }, [languageDropdownOpen, highlightedLanguageIndex, filteredLanguageOptions])

  const handleLanguageFilterKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation()

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (filteredLanguageOptions.length === 0) return
      setHighlightedLanguageIndex((prev) => (prev + 1) % filteredLanguageOptions.length)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (filteredLanguageOptions.length === 0) return
      setHighlightedLanguageIndex((prev) => (prev - 1 + filteredLanguageOptions.length) % filteredLanguageOptions.length)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      languageOptionRefs.current[highlightedLanguageIndex]?.click()
      return
    }
  }, [filteredLanguageOptions.length, highlightedLanguageIndex])

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(node.textContent)
      setCopied(true)
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }, [node.textContent])

  React.useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    }
  }, [])

  React.useEffect(() => {
    if (languageDropdownOpen) {
      const focusInput = () => languageFilterInputRef.current?.focus()
      const raf = requestAnimationFrame(focusInput)
      const timeout = setTimeout(focusInput, 0)
      return () => {
        cancelAnimationFrame(raf)
        clearTimeout(timeout)
      }
    }

    setLanguageFilter('')
  }, [languageDropdownOpen])

  return (
    <NodeViewWrapper className="tiptap-code-block-node tiptap-hover-actions-host" data-actions-open={languageDropdownOpen ? 'true' : 'false'}>
      <TiptapHoverActions>
        <SimpleDropdown
          align="end"
          className="min-w-[220px] max-w-[320px]"
          keyboardNavigation={false}
          onOpenChange={setLanguageDropdownOpen}
          trigger={(
            <TiptapHoverActionButton
              active={languageDropdownOpen}
              title={t('editor.codeLanguage')}
              aria-label="Select code language"
              className="tiptap-code-block-language-trigger"
            >
              <span className="tiptap-code-block-language-label">{languageLabel}</span>
              <ChevronDown className="w-3 h-3" />
            </TiptapHoverActionButton>
          )}
        >
          <div className="px-3 pt-1.5 pb-1">
            <input
              ref={languageFilterInputRef}
              value={languageFilter}
              onChange={(event) => setLanguageFilter(event.target.value)}
              onKeyDown={handleLanguageFilterKeyDown}
              placeholder={t('editor.searchLanguages')}
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground placeholder:select-none"
            />
          </div>
          <div className="h-px bg-foreground/5 -mx-1" />

          <div className="max-h-[240px] overflow-y-auto p-1">
            {filteredLanguageOptions.length === 0 ? (
              <div className="px-2.5 py-2 text-xs text-foreground/50 select-none">No languages found</div>
            ) : (
              filteredLanguageOptions.map((option, index) => {
                const isActive = option.value === currentLanguage
                const isHighlighted = index === highlightedLanguageIndex
                return (
                  <SimpleDropdownItem
                    key={option.value ?? 'plain-text'}
                    onClick={() => handleLanguageSelect(option.value)}
                    buttonRef={(el) => {
                      languageOptionRefs.current[index] = el
                    }}
                    onMouseEnter={() => setHighlightedLanguageIndex(index)}
                    className={cn('pl-2.5', isActive && 'text-accent', isHighlighted && 'bg-foreground/[0.05]')}
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span>{option.label}</span>
                      {isActive ? <Check className="w-3.5 h-3.5 shrink-0" /> : <span className="w-3.5 h-3.5 shrink-0" />}
                    </span>
                  </SimpleDropdownItem>
                )
              })
            )}
          </div>
        </SimpleDropdown>

        <TiptapHoverActionButton
          title={t("common.copyCode")}
          aria-label={t("common.copyCode")}
          onClick={handleCopy}
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </TiptapHoverActionButton>
      </TiptapHoverActions>

      <pre>
        <NodeViewContent<'code'> as="code" />
      </pre>
    </NodeViewWrapper>
  )
}

/**
 * Extended CodeBlockShiki with React NodeView for regular code blocks.
 */
export const tiptapCodeBlock = CodeBlockShiki.extend({
  // Official @tiptap/markdown integration for fenced code blocks.
  markdownTokenName: 'code',

  parseMarkdown: (token: any, helpers: any) => {
    const lang = (token.lang ?? '').toLowerCase()

    // Dedicated rich block nodes handle these fenced languages.
    if (lang === 'mermaid' || lang === 'latex' || lang === 'math' || lang === 'tex' || lang === 'katex') {
      return []
    }

    return helpers.createNode(
      'codeBlock',
      { language: token.lang ?? null },
      token.text
        ? [
            {
              type: 'text',
              text: token.text,
            },
          ]
        : [],
    )
  },

  renderMarkdown: (
    node: { attrs?: { language?: string | null }; content?: unknown[]; textContent?: string },
    helpers: { renderChildren: (content: unknown[]) => string }
  ) => {
    const language = node.attrs?.language ?? ''
    const code = node.textContent ?? helpers.renderChildren(node.content ?? [])
    const langPart = language ? String(language) : ''

    return `\`\`\`${langPart}\n${code}\n\`\`\``
  },

  addNodeView() {
    return ReactNodeViewRenderer(TiptapCodeBlockView)
  },
})
