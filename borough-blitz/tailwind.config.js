/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Urban-signage display (the BLITZ wordmark, labels, buttons).
        bungee: ['Bungee', 'Impact', 'sans-serif'],
        // Tabloid headline weight — the giant score numbers.
        tabloid: ['Anton', 'Impact', 'sans-serif'],
        // Dispatch-terminal telemetry — HUD, timecode, mono readouts.
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        taxi: '#FFD400', // dominant accent — taxi / MetroCard yellow
        blitz: '#FF4D2E', // hot secondary — the "blitz" red-orange
        signal: '#39FF6A', // bullseye green
        route: {
          easy: '#37c46b', // MTA-bullet green
          medium: '#FFD400', // yellow
          hard: '#FF4D2E', // red
        },
        night: {
          950: '#070809',
          900: '#0b0d10',
          800: '#12151a',
          700: '#1b1f26',
          600: '#262b34',
        },
      },
      boxShadow: {
        hard: '4px 4px 0 #000',
        'hard-blitz': '5px 5px 0 #FF4D2E',
        'glow-taxi': '0 0 22px rgba(255,212,0,0.45)',
      },
      keyframes: {
        'rec-blink': {
          '0%,49%': { opacity: '1' },
          '50%,100%': { opacity: '0.15' },
        },
        'count-up': {
          from: { transform: 'translateY(0.35em)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
        'panel-in': {
          from: { transform: 'translateY(12px) scale(0.98)', opacity: '0' },
          to: { transform: 'translateY(0) scale(1)', opacity: '1' },
        },
        scan: {
          from: { transform: 'translateY(-100%)' },
          to: { transform: 'translateY(100%)' },
        },
      },
      animation: {
        'rec-blink': 'rec-blink 1.4s steps(1) infinite',
        'count-up': 'count-up 0.5s cubic-bezier(0.2,0.9,0.25,1) both',
        'panel-in': 'panel-in 0.35s cubic-bezier(0.2,0.9,0.25,1) both',
        scan: 'scan 7s linear infinite',
      },
    },
  },
  plugins: [],
};
