// Re-export browser-safe slug extraction for convenience
export { extractWorkspaceSlugFromPath } from './workspace-slug.ts';

/**
 * Extract workspace slug for skill qualification.
 *
 * NOTE: Requires Node.js (fs/path). For browser contexts, use extractWorkspaceSlugFromPath
 * from './workspace-slug.ts' instead.
 */
export function extractWorkspaceSlug(rootPath: string, fallbackId: string): string {
  const pathParts = rootPath.split(/[\\/]/).filter(Boolean);
  return pathParts[pathParts.length - 1] || fallbackId;
}
