/** Shared pet-companion state so the picker and the floating overlay stay in sync. */
import { atom } from 'jotai';
import type { CustomPetEntry } from '@craft-agent/shared/config';
import { DEFAULT_PET_ID } from './registry';

export const selectedPetIdAtom = atom<string>(DEFAULT_PET_ID);
export const petEnabledAtom = atom<boolean>(true);
export const customPetsAtom = atom<CustomPetEntry[]>([]);
