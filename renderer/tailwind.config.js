const path = require('path');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    path.join(__dirname, 'pages/**/*.{ts,tsx}'),
    path.join(__dirname, 'components/**/*.{ts,tsx}'),
  ],
  safelist: [
    'bg-accent', 'bg-accent2', 'bg-ok', 'bg-warn', 'bg-err', 'bg-muted',
    'animate-pulse',
  ],
  theme: {
    extend: {
      colors: {
        bg: '#0f1115',
        panel: '#181b25',
        panel2: '#222636',
        border: '#3a4159',
        text: '#f1f3f8',
        muted: '#b2b8cc',
        subtle: '#8c93a8',
        accent: '#ff7847',
        accent2: '#ffa274',
        ok: '#4ade80',
        warn: '#fbbf24',
        err: '#ef4444',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
