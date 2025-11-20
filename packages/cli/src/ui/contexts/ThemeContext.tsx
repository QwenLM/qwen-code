/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { themeManager } from '../themes/theme-manager.js';
import type { Theme } from '../themes/theme.js';
import type { SemanticColors } from '../themes/semantic-tokens.js';

// Define the context type
interface ThemeContextType {
  theme: SemanticColors;
  activeTheme: Theme;
  updateTheme: () => void; // Function to manually trigger a theme update
}

// Create the context with a default value
const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

interface ThemeProviderProps {
  children: ReactNode;
}

// ThemeProvider component
export const ThemeProvider = ({ children }: ThemeProviderProps) => {
  const [activeTheme, setActiveTheme] = useState(themeManager.getActiveTheme());

  // Function to update the theme state
  const updateTheme = () => {
    const newTheme = themeManager.getActiveTheme();
    setActiveTheme(newTheme);
  };

  // Effect to update theme when themeManager changes
  useEffect(() => {
    // Update immediately on mount
    updateTheme();

    // Set up a listener for theme changes
    const handleThemeChange = () => {
      // Update theme when it changes
      updateTheme();
    };

    // Add listener for theme changes
    themeManager.on('themeChanged', handleThemeChange);

    // Cleanup listener on unmount
    return () => {
      themeManager.off('themeChanged', handleThemeChange);
    };
  }, []); // Only run once on mount

  // Create the context value
  const contextValue: ThemeContextType = {
    theme: activeTheme.semanticColors,
    activeTheme,
    updateTheme,
  };

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
};

// Custom hook to use the theme context
export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
