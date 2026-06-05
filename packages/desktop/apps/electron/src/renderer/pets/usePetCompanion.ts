/**
 * Bridges the persisted pet settings + custom pets (main process) with shared
 * Jotai atoms so the Appearance picker and the floating overlay stay in sync.
 */
import { useAtom } from 'jotai';
import { useCallback, useEffect, useMemo } from 'react';
import {
  customPetsAtom,
  petEnabledAtom,
  petSettingsLoadedAtom,
  petSizeAtom,
  selectedPetIdAtom,
} from './pet-atoms';
import { normalizePetSize } from './pet-size';
import { mergeCustomPets, resolvePet, type PetDescriptor } from './registry';

// Load persisted state once per app session, regardless of how many components
// mount the hook.
let bootstrapStarted = false;

export interface PetCompanion {
  pets: PetDescriptor[];
  selectedPet: PetDescriptor;
  selectedPetId: string;
  setSelectedPetId: (id: string) => void;
  petEnabled: boolean;
  setPetEnabled: (enabled: boolean) => void;
  petSettingsLoaded: boolean;
  petSize: number;
  setPetSize: (size: number) => void;
  refreshCustomPets: () => Promise<void>;
}

export function usePetCompanion(): PetCompanion {
  const [selectedPetId, setSelectedIdState] = useAtom(selectedPetIdAtom);
  const [petEnabled, setEnabledState] = useAtom(petEnabledAtom);
  const [petSettingsLoaded, setPetSettingsLoaded] = useAtom(
    petSettingsLoadedAtom,
  );
  const [petSize, setPetSizeState] = useAtom(petSizeAtom);
  const [customPets, setCustomPets] = useAtom(customPetsAtom);

  const refreshCustomPets = useCallback(async () => {
    const list = await window.electronAPI?.loadCustomPets?.();
    if (list) setCustomPets(list);
  }, [setCustomPets]);

  useEffect(() => {
    if (bootstrapStarted) return;
    bootstrapStarted = true;
    void (async () => {
      try {
        const [id, enabled, size, custom] = await Promise.all([
          window.electronAPI?.getSelectedPetId?.(),
          window.electronAPI?.getPetEnabled?.(),
          window.electronAPI?.getPetSize?.(),
          window.electronAPI?.loadCustomPets?.(),
        ]);
        if (id) setSelectedIdState(id);
        if (typeof enabled === 'boolean') setEnabledState(enabled);
        if (typeof size === 'number') setPetSizeState(normalizePetSize(size));
        if (custom) setCustomPets(custom);
      } catch {
        // Fall back to in-memory defaults if the IPC layer isn't ready.
      } finally {
        setPetSettingsLoaded(true);
      }
    })();
  }, [
    setSelectedIdState,
    setEnabledState,
    setPetSettingsLoaded,
    setPetSizeState,
    setCustomPets,
  ]);

  useEffect(() => {
    return window.electronAPI?.onPetEnabledChanged?.((enabled) => {
      setEnabledState(enabled);
    });
  }, [setEnabledState]);

  const pets = useMemo(() => mergeCustomPets(customPets), [customPets]);
  const selectedPet = useMemo(
    () => resolvePet(selectedPetId, pets),
    [selectedPetId, pets],
  );

  const setSelectedPetId = useCallback(
    (id: string) => {
      setSelectedIdState(id);
      void window.electronAPI?.setSelectedPetId?.(id);
    },
    [setSelectedIdState],
  );

  const setPetEnabled = useCallback(
    (enabled: boolean) => {
      setEnabledState(enabled);
      void window.electronAPI?.setPetEnabled?.(enabled);
    },
    [setEnabledState],
  );

  const setPetSize = useCallback(
    (size: number) => {
      const normalized = normalizePetSize(size);
      setPetSizeState(normalized);
      void window.electronAPI?.setPetSize?.(normalized);
    },
    [setPetSizeState],
  );

  return {
    pets,
    selectedPet,
    selectedPetId,
    setSelectedPetId,
    petEnabled,
    setPetEnabled,
    petSettingsLoaded,
    petSize,
    setPetSize,
    refreshCustomPets,
  };
}
