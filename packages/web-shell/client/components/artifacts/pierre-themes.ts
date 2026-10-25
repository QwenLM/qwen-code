import { bundledThemes } from './pierre-resources';

/** @internal */
export const pierreThemes = { getThemes: () => [] };
/** @internal */
export const shikiThemes = {
  getTheme(name: string) {
    if (!Object.hasOwn(bundledThemes, name)) return undefined;
    const load = bundledThemes[name as keyof typeof bundledThemes];
    return { name, load };
  },
};
