import { useEffect } from 'react';
import { usePetCompanion } from '@/pets/usePetCompanion';

/**
 * Headless. Mirrors the pet's enabled state + current selection into the
 * separate always-on-top desktop window owned by the main process. Re-runs on
 * selection change so the main process can reload the window with the new pet.
 */
export function PetWindowController() {
  const { petEnabled, selectedPetId } = usePetCompanion();

  useEffect(() => {
    void window.electronAPI?.setPetWindowEnabled?.(petEnabled);
  }, [petEnabled, selectedPetId]);

  return null;
}
