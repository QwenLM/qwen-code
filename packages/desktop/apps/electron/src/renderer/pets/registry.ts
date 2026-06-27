/**
 * Built-in pet companions and custom-pet merging.
 *
 * Built-in spritesheets are bundled by Vite from `assets/pets/`. Custom pets
 * come from the main process (`loadCustomPets`) as base64 data URLs.
 */
import type { CustomPetEntry } from '@craft-agent/shared/config';
import qwenSpritesheet from '@/assets/pets/qwen-spritesheet.webp';

export interface PetDescriptor {
  id: string;
  displayName: string;
  description: string;
  /** URL or data URL usable directly as a CSS background-image. */
  spritesheetUrl: string;
  custom?: boolean;
}

export const DEFAULT_PET_ID = 'qwen';

export const BUILT_IN_PETS: PetDescriptor[] = [
  {
    id: 'qwen',
    displayName: 'Qwen',
    description: 'Your Qwen capybara companion.',
    spritesheetUrl: qwenSpritesheet,
  },
];

/** Built-in pets followed by any custom pets (custom ids cannot shadow built-ins). */
export function mergeCustomPets(
  custom: CustomPetEntry[] | undefined,
): PetDescriptor[] {
  if (!custom || custom.length === 0) return BUILT_IN_PETS;
  const builtinIds = new Set(BUILT_IN_PETS.map((p) => p.id));
  const extras = custom
    .filter((c) => c.id && !builtinIds.has(c.id))
    .map<PetDescriptor>((c) => ({
      id: c.id,
      displayName: c.displayName || c.id,
      description: c.description,
      spritesheetUrl: c.spritesheetDataUrl,
      custom: true,
    }));
  return [...BUILT_IN_PETS, ...extras];
}

/** Resolve a pet by id, falling back to the default then the first available. */
export function resolvePet(
  id: string | undefined,
  pets: PetDescriptor[] = BUILT_IN_PETS,
): PetDescriptor {
  return (
    pets.find((p) => p.id === id) ??
    pets.find((p) => p.id === DEFAULT_PET_ID) ??
    pets[0] ??
    BUILT_IN_PETS[0]
  );
}
