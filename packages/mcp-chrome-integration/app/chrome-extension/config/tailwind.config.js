/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/sidepanel/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        qwen: {
          orange: '#615fff',
        },
        'clay-orange': '#4f46e5',
        ivory: '#f5f5ff',
        slate: '#141420',
        green: '#6bcf7f',
        success: '#74c991',
        error: '#c74e39',
        warning: '#e1c08d',
        loading: 'var(--app-secondary-foreground)',
      },
      spacing: {
        small: '4px',
        medium: '8px',
        large: '12px',
        xlarge: '16px',
      },
      borderRadius: {
        small: '4px',
        medium: '6px',
        large: '8px',
      },
      animation: {
        'completion-menu-enter': 'completion-menu-enter 0.15s ease-out',
        'pulse-slow': 'pulse 1.5s infinite',
        'slide-up': 'slideUp 0.3s ease-out',
        fadeIn: 'fadeIn 0.2s ease-in',
      },
      keyframes: {
        'completion-menu-enter': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideUp: {
          '0%': { transform: 'translateY(100%)' },
          '100%': { transform: 'translateY(0)' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};
