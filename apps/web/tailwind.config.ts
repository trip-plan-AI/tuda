import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          blue: {
            DEFAULT: '#0ea5e9',
            hover: '#0284c7',
          },
          indigo: {
            DEFAULT: '#1e1b4b',
            hover: '#312e81',
          },
          yellow: {
            DEFAULT: '#f59e0b',
            hover: '#d97706',
          },
          purple: {
            DEFAULT: '#9333ea',
            hover: '#7e22ce',
          },
          sky: '#0ea5e9', // kept for backwards compatibility if used elsewhere
          amber: '#f59e0b', // kept for backwards compatibility
          light: '#f0f9ff',
          bg: '#f0f6ff',
        },
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
        '4xl': '2rem',
      },
    },
  },
};

export default config;
