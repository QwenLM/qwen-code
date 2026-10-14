import { bundledThemes } from './pierre-resources';

export const pierreThemes = { getThemes: () => [] };
export const shikiThemes = {
  getTheme(name: string) {
    if (!Object.hasOwn(bundledThemes, name)) return undefined;
    const load = bundledThemes[name as keyof typeof bundledThemes];
    return { name, load };
  },
};
