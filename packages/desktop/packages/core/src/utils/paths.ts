/**
 * Cross-Platform Path Utilities
 *
 * Functions for consistent path handling across Windows, macOS, and Linux.
 * Always normalize paths to forward slashes before comparison operations.
 */

/**
 * Normalize a path to use forward slashes for consistent cross-platform comparison.
 * Use this before comparing paths or using regex patterns on paths.
 *
 * @example
 * normalizePath('C:\\Users\\foo\\bar') // 'C:/Users/foo/bar'
 * normalizePath('/Users/foo/bar')      // '/Users/foo/bar' (unchanged)
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Check if a file path starts with a directory path (cross-platform).
 * Handles both Windows backslashes and Unix forward slashes.
 *
 * @example
 * pathStartsWith('C:\\Users\\foo\\file.txt', 'C:\\Users\\foo') // true
 * pathStartsWith('/home/user/file.txt', '/home/user')          // true
 * pathStartsWith('/home/user2/file.txt', '/home/user')         // false
 */
export function pathStartsWith(filePath: string, dirPath: string): boolean {
  const normalizedFile = normalizePath(filePath);
  const normalizedDir = normalizePath(dirPath);
  return normalizedFile.startsWith(normalizedDir + '/') || normalizedFile === normalizedDir;
}

/**
 * Strip a directory prefix from a path (cross-platform).
 * Returns the relative path portion after the prefix.
 *
 * @example
 * stripPathPrefix('/home/user/docs/file.txt', '/home/user') // 'docs/file.txt'
 * stripPathPrefix('C:\\foo\\bar\\baz.txt', 'C:\\foo')       // 'bar/baz.txt'
 */
export function stripPathPrefix(filePath: string, prefix: string): string {
  const normalizedFile = normalizePath(filePath);
  const normalizedPrefix = normalizePath(prefix);
  if (normalizedFile.startsWith(normalizedPrefix + '/')) {
    return normalizedFile.slice(normalizedPrefix.length + 1);
  }
  return filePath;
}
