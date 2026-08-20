/**
 * Automations Atom
 *
 * Simple atom for storing parsed workspace automations.
 * AppShell populates this when automations.json is loaded from the workspace root.
 * MainContentPanel reads from it for automation detail display.
 */

import { atom } from 'jotai'
import type { AutomationListItem } from '../components/automations/types'

/**
 * Atom to store the current workspace's parsed automations.
 * AppShell loads automations.json, parses via parseAutomationsConfig(), and sets this atom.
 */
export const automationsAtom = atom<AutomationListItem[]>([])
