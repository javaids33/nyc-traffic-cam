/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Big Shoulders Display"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        ink: {
          950: '#06080A',
          900: '#0B0F14',
          800: '#10161E',
          700: '#161E28',
          600: '#1E2733',
          500: '#2A3441',
        },
        signal: {
          DEFAULT: '#B5F500',
          dim: '#6E9400',
          bright: '#D7FF66',
        },
        warn: '#FFCC22',
        alarm: '#FF8A1F',
        crit: '#FF3A6C',
        hi: '#E91FFF',
      },
      boxShadow: {
        'glow-signal': '0 0 18px rgba(181, 245, 0, 0.45)',
        'glow-crit': '0 0 22px rgba(255, 58, 108, 0.55)',
        'glow-hi': '0 0 30px rgba(233, 31, 255, 0.55)',
      },
    },
  },
  plugins: [],
};
