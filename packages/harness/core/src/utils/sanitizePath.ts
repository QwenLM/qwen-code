/** Maximum directory component length before appending the stable hash. */
export const MAX_SANITIZED_LENGTH = 200;

/** Shared by storage and permission adapters so project identifiers agree. */
export function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  let hash = 5381;
  for (let index = 0; index < name.length; index++) {
    hash = (hash * 33) ^ name.charCodeAt(index);
  }
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${Math.abs(hash).toString(36)}`;
}
