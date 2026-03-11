/**
 * Theme Store
 *
 * Manages light/dark theme preference with localStorage persistence.
 */

import { create } from 'zustand';

type ColorMode = 'light' | 'dark';

interface ThemeState {
  colorMode: ColorMode;
  toggleColorMode: () => void;
  setColorMode: (mode: ColorMode) => void;
  particlesEnabled: boolean;
  toggleParticles: () => void;
}

// Update body class for scrollbar theming
function updateBodyClass(mode: ColorMode) {
  if (typeof document === 'undefined') return;
  document.body.classList.remove('light-mode', 'dark-mode');
  document.body.classList.add(mode === 'dark' ? 'dark-mode' : 'light-mode');
}

// Get initial theme from localStorage or system preference
function getInitialColorMode(): ColorMode {
  if (typeof window === 'undefined') return 'dark';

  const stored = localStorage.getItem('system2-theme');
  if (stored === 'light' || stored === 'dark') {
    updateBodyClass(stored);
    return stored;
  }

  // Fall back to system preference
  if (window.matchMedia('(prefers-color-scheme: light)').matches) {
    updateBodyClass('light');
    return 'light';
  }

  updateBodyClass('dark');
  return 'dark';
}

function getInitialParticlesEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  const stored = localStorage.getItem('system2-particles');
  return stored !== 'false';
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  colorMode: getInitialColorMode(),

  toggleColorMode: () => {
    const newMode = get().colorMode === 'dark' ? 'light' : 'dark';
    localStorage.setItem('system2-theme', newMode);
    updateBodyClass(newMode);
    set({ colorMode: newMode });
  },

  setColorMode: (mode: ColorMode) => {
    localStorage.setItem('system2-theme', mode);
    updateBodyClass(mode);
    set({ colorMode: mode });
  },

  particlesEnabled: getInitialParticlesEnabled(),

  toggleParticles: () => {
    const next = !get().particlesEnabled;
    localStorage.setItem('system2-particles', String(next));
    set({ particlesEnabled: next });
  },
}));
