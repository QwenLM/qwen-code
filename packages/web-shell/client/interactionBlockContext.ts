import { createContext, useContext } from 'react';

export type RegisterInteractionBlocker = () => () => void;

const noopRelease = () => {};
const noopRegisterInteractionBlocker = () => noopRelease;

export const InteractionBlockContext =
  createContext<RegisterInteractionBlocker>(noopRegisterInteractionBlocker);

export function useInteractionBlocker(): RegisterInteractionBlocker {
  return useContext(InteractionBlockContext);
}
