import type { ContentBadge } from '@craft-agent/core'

export interface SlashCommandMatch {
  type: 'command'
  id: string
  fullMatch: string
  startIndex: number
}

const UNSUPPORTED_SLASH_BADGE_NAMES = new Set(['model', 'skills'])
const SLASH_COMMAND_NAME_PATTERN = '[A-Za-z][\\w-]*(?::[\\w-]+)*'

function normalizeSlashCommandName(value: string): string {
  return value.trim().replace(/^\/+/, '').toLowerCase()
}

function isSupportedSlashCommandName(name: string): boolean {
  return !!name && !UNSUPPORTED_SLASH_BADGE_NAMES.has(name)
}

function getSlashCommandBadgeLabel(fullMatch: string): string {
  return fullMatch.replace(/^\/+/, '')
}

/**
 * Find slash commands that should render as command badges.
 *
 * When commandNames are provided, commands can appear anywhere after whitespace.
 * Without commandNames, only a leading slash command is matched for submitted
 * message display.
 */
export function findSlashCommandMatches(
  text: string,
  commandNames?: string[]
): SlashCommandMatch[] {
  const normalizedNames = commandNames
    ? new Set(commandNames.map(normalizeSlashCommandName).filter(isSupportedSlashCommandName))
    : undefined

  if (normalizedNames && normalizedNames.size === 0) return []

  const matches: SlashCommandMatch[] = []
  const pattern = normalizedNames
    ? new RegExp(`(^|\\s)(\\/(${SLASH_COMMAND_NAME_PATTERN}))(?=\\s|$)`, 'g')
    : new RegExp(`^(\\/(${SLASH_COMMAND_NAME_PATTERN}))(?=\\s|$)`, 'g')

  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const prefix = normalizedNames ? match[1] : ''
    const commandText = normalizedNames ? match[2] : match[1]
    const commandName = normalizedNames ? match[3] : match[2]
    if (!commandText || !commandName) continue

    const normalizedName = normalizeSlashCommandName(commandName)
    if (!isSupportedSlashCommandName(normalizedName)) continue
    if (normalizedNames && !normalizedNames.has(normalizedName)) continue

    matches.push({
      type: 'command',
      id: normalizedName,
      fullMatch: commandText,
      startIndex: match.index + (prefix?.length ?? 0),
    })
  }

  return matches
}

export function extractCommandBadges(text: string, commandNames?: string[]): ContentBadge[] {
  return findSlashCommandMatches(text, commandNames).map((match) => ({
    type: 'command',
    label: getSlashCommandBadgeLabel(match.fullMatch),
    rawText: match.fullMatch,
    start: match.startIndex,
    end: match.startIndex + match.fullMatch.length,
  }))
}
