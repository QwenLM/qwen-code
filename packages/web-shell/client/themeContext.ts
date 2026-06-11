import { createContext, useContext } from 'react';

export type WebShellTheme = 'dark' | 'light';

const ThemeContext = createContext<WebShellTheme>('dark');

export const ThemeProvider = ThemeContext.Provider;

export function useTheme(): WebShellTheme {
  return useContext(ThemeContext);
}
