/**
 * Custom pet companion loading.
 *
 * Users can drop their own animated pets into `~/.qwen/pets/<name>/`:
 *
 *   ~/.qwen/pets/<name>/
 *   ├── pet.json          { id, displayName, description, spritesheetPath }
 *   └── spritesheet.webp  1536x1872, 8 cols x 9 rows, 192x208 cells, transparent
 *
 * The spritesheet is returned as a base64 data URL so the renderer can use it
 * directly as a CSS background-image without privileged file access.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';

/** On-disk manifest shape (`pet.json`). */
export interface PetManifest {
  id: string;
  displayName: string;
  description: string;
  spritesheetPath?: string;
}

/** A custom pet resolved for the renderer (spritesheet inlined as a data URL). */
export interface CustomPetEntry {
  id: string;
  displayName: string;
  description: string;
  spritesheetDataUrl: string;
}

/** Directory holding user-provided custom pets: ~/.qwen/pets (matches ~/.qwen/skills). */
export function getPetsDir(): string {
  return join(homedir(), '.qwen', 'pets');
}

// Refuse to inline absurdly large spritesheets (a well-formed atlas is < ~1MB).
const MAX_SPRITESHEET_BYTES = 12 * 1024 * 1024;

function mimeFor(ext: string): string | undefined {
  switch (ext.toLowerCase()) {
    case '.webp':
      return 'image/webp';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    default:
      return undefined;
  }
}

/**
 * Load every valid custom pet under `~/.qwen/pets/`.
 * Malformed pets are skipped rather than throwing so one bad folder cannot
 * break the picker.
 */
export function loadCustomPets(): CustomPetEntry[] {
  const petsDir = getPetsDir();
  if (!existsSync(petsDir)) return [];

  let names: string[];
  try {
    names = readdirSync(petsDir);
  } catch {
    return [];
  }

  const entries: CustomPetEntry[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    try {
      const dir = join(petsDir, name);
      if (!statSync(dir).isDirectory()) continue;

      const manifestPath = join(dir, 'pet.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(
        readFileSync(manifestPath, 'utf-8'),
      ) as Partial<PetManifest>;

      const spritesheetRel = manifest.spritesheetPath || 'spritesheet.webp';
      // Guard against path traversal: the resolved spritesheet must stay inside
      // the pet's own directory.
      const dirResolved = resolve(dir);
      const spritesheetPath = resolve(dir, spritesheetRel);
      if (
        spritesheetPath !== dirResolved &&
        !spritesheetPath.startsWith(dirResolved + sep)
      ) {
        continue;
      }
      if (!existsSync(spritesheetPath)) continue;

      const mime = mimeFor(extname(spritesheetPath));
      if (!mime) continue;
      if (statSync(spritesheetPath).size > MAX_SPRITESHEET_BYTES) continue;

      const base64 = readFileSync(spritesheetPath).toString('base64');
      const id = (manifest.id || name).trim();
      if (!id) continue;
      entries.push({
        id,
        displayName: (manifest.displayName || id).trim(),
        description: (manifest.description || '').trim(),
        spritesheetDataUrl: `data:${mime};base64,${base64}`,
      });
    } catch {
      // Skip malformed pet folder.
    }
  }

  return entries;
}
