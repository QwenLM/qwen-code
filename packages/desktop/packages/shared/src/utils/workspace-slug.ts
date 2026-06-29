/**
 * Browser-safe workspace slug extraction (no Node.js dependencies).
 *
 * Use this module in renderer/browser contexts. For Node.js contexts that need
 * plugin manifest reading, use ./workspace.ts instead.
 */

/**
 * Extract workspace slug from a path (browser-safe, no filesystem access).
 *
 * Returns the last path component, or the fallback ID if the path has no components.
 */
export function extractWorkspaceSlugFromPath(rootPath: string, fallbackId: string): string {
  const pathParts = rootPath.split(/[\\/]/).filter(Boolean);
  return pathParts[pathParts.length - 1] || fallbackId;
}
