/**
 * Status Storage
 *
 * Filesystem-based storage for workspace status configurations.
 * Statuses are stored at {workspaceRootPath}/statuses/config.json
 *
 * Icon handling:
 * - Local files: statuses/icons/{id}.svg (auto-discovered)
 * - Emoji: Rendered as text in UI
 * - URL: Auto-downloaded to statuses/icons/{id}.{ext}
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { WorkspaceStatusConfig, StatusConfig, StatusCategory } from './types.ts';
import { readJsonFileSync } from '../utils/files.ts';
import { DEFAULT_ICON_SVGS } from './default-icons.ts';
import {
  validateIconValue,
  downloadIcon,
  needsIconDownload,
  isIconUrl,
  ICON_EXTENSIONS,
} from '../utils/icon.ts';
import { migrateStatusColors } from '../colors/migrate.ts';
import { debug } from '../utils/debug.ts';

const STATUS_CONFIG_DIR = 'statuses';
const STATUS_CONFIG_FILE = 'statuses/config.json';
const STATUS_ICONS_DIR = 'statuses/icons';

/**
 * Get default status configuration (matches current hardcoded behavior)
 * Note: icon field is omitted - uses auto-discovered files in statuses/icons/{id}.svg
 */
export function getDefaultStatusConfig(): WorkspaceStatusConfig {
  // Note: color is omitted - defaults from colors/defaults.ts are applied:
  // - backlog: foreground/50 (muted, not yet planned)
  // - todo: foreground/50 (muted, ready to work on)
  // - needs-review: info (amber, attention needed)
  // - done: accent (purple, completed)
  // - cancelled: foreground/50 (muted, inactive)
  //
  // Note: icon is omitted - auto-discovered from statuses/icons/{id}.svg
  return {
    version: 1,
    statuses: [
      {
        id: 'backlog',
        label: 'Backlog',
        category: 'open',
        isFixed: false,
        isDefault: true,
        order: 0,
      },
      {
        id: 'todo',
        label: 'Todo',
        category: 'open',
        isFixed: true,
        isDefault: false,
        order: 1,
      },
      {
        id: 'needs-review',
        label: 'Needs Review',
        category: 'open',
        isFixed: false,
        isDefault: true,
        order: 2,
      },
      {
        id: 'done',
        label: 'Done',
        category: 'closed',
        isFixed: true,
        isDefault: false,
        order: 3,
      },
      {
        id: 'cancelled',
        label: 'Cancelled',
        category: 'closed',
        isFixed: true,
        isDefault: false,
        order: 4,
      },
    ],
    defaultStatusId: 'todo',
  };
}

/**
 * Ensure default icon files exist in statuses/icons/
 * Creates missing icon files from embedded SVG strings
 */
export function ensureDefaultIconFiles(workspaceRootPath: string): void {
  const iconsDir = join(workspaceRootPath, STATUS_ICONS_DIR);

  // Create icons directory if missing
  if (!existsSync(iconsDir)) {
    mkdirSync(iconsDir, { recursive: true });
  }

  // Write each default icon file if missing
  for (const [statusId, svgContent] of Object.entries(DEFAULT_ICON_SVGS)) {
    const iconPath = join(iconsDir, `${statusId}.svg`);

    if (!existsSync(iconPath)) {
      try {
        writeFileSync(iconPath, svgContent, 'utf-8');
      } catch (error) {
        console.error(`[ensureDefaultIconFiles] Failed to write ${statusId}.svg:`, error);
      }
    }
  }
}

/**
 * Validate status configuration has required fixed statuses
 */
function validateStatusConfig(config: WorkspaceStatusConfig): boolean {
  const requiredFixedStatuses = ['todo', 'done', 'cancelled'];

  return requiredFixedStatuses.every(id =>
    config.statuses.some(s => s.id === id && s.isFixed)
  );
}

/**
 * Load workspace status configuration
 * Returns defaults if no config exists or validation fails.
 * Ensures icon files exist.
 * Auto-migrates old Tailwind color format to EntityColor on first load.
 */
export function loadStatusConfig(workspaceRootPath: string): WorkspaceStatusConfig {
  // Ensure default icon files exist (self-healing)
  ensureDefaultIconFiles(workspaceRootPath);

  const configPath = join(workspaceRootPath, STATUS_CONFIG_FILE);

  // Return defaults if config doesn't exist
  if (!existsSync(configPath)) {
    return getDefaultStatusConfig();
  }

  try {
    const config = readJsonFileSync<WorkspaceStatusConfig>(configPath);

    // Validate required fixed statuses exist
    if (!validateStatusConfig(config)) {
      console.warn('[loadStatusConfig] Invalid config: missing required fixed statuses, returning defaults');
      return getDefaultStatusConfig();
    }

    // Auto-migrate old Tailwind class colors (e.g., "text-accent") to new EntityColor format.
    // If migration occurs, write the updated config back to disk.
    const migrated = migrateStatusColors(config);
    if (migrated) {
      debug('[loadStatusConfig] Migrated old color format, writing back');
      saveStatusConfig(workspaceRootPath, config);
    }

    return config;
  } catch (error) {
    console.error('[loadStatusConfig] Failed to parse config:', error);
    return getDefaultStatusConfig();
  }
}

/**
 * Save workspace status configuration to disk
 */
export function saveStatusConfig(
  workspaceRootPath: string,
  config: WorkspaceStatusConfig
): void {
  const statusDir = join(workspaceRootPath, STATUS_CONFIG_DIR);
  const configPath = join(workspaceRootPath, STATUS_CONFIG_FILE);

  // Create status directory if missing
  if (!existsSync(statusDir)) {
    mkdirSync(statusDir, { recursive: true });
  }

  // Write config to disk
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (error) {
    console.error('[saveStatusConfig] Failed to save config:', error);
    throw error;
  }
}

/**
 * Get a single status by ID
 * Returns null if not found
 */
export function getStatus(
  workspaceRootPath: string,
  statusId: string
): StatusConfig | null {
  const config = loadStatusConfig(workspaceRootPath);
  return config.statuses.find(s => s.id === statusId) || null;
}

/**
 * Get all statuses sorted by order
 */
export function listStatuses(workspaceRootPath: string): StatusConfig[] {
  const config = loadStatusConfig(workspaceRootPath);
  return [...config.statuses].sort((a, b) => a.order - b.order);
}

/**
 * Check if a status ID is valid for this workspace
 */
export function isValidStatusId(
  workspaceRootPath: string,
  statusId: string
): boolean {
  const config = loadStatusConfig(workspaceRootPath);
  return config.statuses.some(s => s.id === statusId);
}

/**
 * Get category for a status ID
 * Returns null if status not found
 */
export function getStatusCategory(
  workspaceRootPath: string,
  statusId: string
): StatusCategory | null {
  const status = getStatus(workspaceRootPath, statusId);
  return status?.category || null;
}

// ============================================================
// Icon Operations (uses shared utilities from utils/icon.ts)
// ============================================================

/**
 * Find icon file for a status
 * Looks for statuses/icons/{statusId}.{svg,png,jpg,jpeg}
 * Returns absolute path to icon file or undefined
 */
export function findStatusIcon(
  workspaceRootPath: string,
  statusId: string
): string | undefined {
  const iconsDir = join(workspaceRootPath, STATUS_ICONS_DIR);

  for (const ext of ICON_EXTENSIONS) {
    const iconPath = join(iconsDir, `${statusId}${ext}`);
    if (existsSync(iconPath)) {
      return iconPath;
    }
  }
  return undefined;
}

/**
 * Download an icon from a URL and save it to the status icons directory.
 * Saves as statuses/icons/{statusId}.{ext}
 * Returns the path to the downloaded icon, or null on failure.
 */
export async function downloadStatusIcon(
  workspaceRootPath: string,
  statusId: string,
  iconUrl: string
): Promise<string | null> {
  const iconsDir = join(workspaceRootPath, STATUS_ICONS_DIR);

  // Ensure icons directory exists
  if (!existsSync(iconsDir)) {
    mkdirSync(iconsDir, { recursive: true });
  }

  // Download to a temp file first, then rename to {statusId}.{ext}
  const tempPath = await downloadIcon(iconsDir, iconUrl, 'Statuses');
  if (!tempPath) return null;

  // Rename from icon.{ext} to {statusId}.{ext}
  const ext = tempPath.substring(tempPath.lastIndexOf('.'));
  const finalPath = join(iconsDir, `${statusId}${ext}`);

  try {
    const { renameSync, unlinkSync } = await import('fs');
    // Remove any existing icon with different extension
    for (const existingExt of ICON_EXTENSIONS) {
      const existingPath = join(iconsDir, `${statusId}${existingExt}`);
      if (existsSync(existingPath) && existingPath !== finalPath) {
        unlinkSync(existingPath);
      }
    }
    // Rename temp file to final path
    if (tempPath !== finalPath) {
      renameSync(tempPath, finalPath);
    }
    debug(`[downloadStatusIcon] Icon saved for ${statusId}: ${finalPath}`);
    return finalPath;
  } catch (error) {
    debug(`[downloadStatusIcon] Failed to rename icon for ${statusId}:`, error);
    return tempPath; // Return temp path as fallback
  }
}

/**
 * Check if a status needs its icon downloaded.
 * Returns true if config has a URL icon and no local icon file exists.
 */
export function statusNeedsIconDownload(
  workspaceRootPath: string,
  status: StatusConfig
): boolean {
  const iconPath = findStatusIcon(workspaceRootPath, status.id);
  return needsIconDownload(status.icon, iconPath);
}

// Re-export icon utilities for convenience
export { isIconUrl } from '../utils/icon.ts';
