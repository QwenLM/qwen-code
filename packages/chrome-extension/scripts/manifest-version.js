/**
 * Convert an npm package version into Chrome's numeric manifest format.
 * Chrome rejects prerelease labels such as `-alpha.1`.
 */
export function toChromeManifestVersion(packageVersion) {
  const numericVersion = packageVersion.split('-', 1)[0];
  const parts = numericVersion.split('.');
  if (
    parts.length < 1 ||
    parts.length > 4 ||
    parts.some((part) => !/^\d+$/.test(part))
  ) {
    throw new Error(`Invalid extension package version: ${packageVersion}`);
  }
  return parts.join('.');
}
