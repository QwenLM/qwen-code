/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/client/**/*.{js,ts,jsx,tsx}',
    '../webui/src/**/*.{js,ts,jsx,tsx}',
  ],
  presets: [require('@qwen-code/webui/tailwind.preset')],
  theme: {
    extend: {},
  },
  plugins: [],
};
