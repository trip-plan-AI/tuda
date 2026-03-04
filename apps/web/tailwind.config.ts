import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          sky: '#0ea5e9',
          indigo: '#1e1b4b',
          amber: '#f59e0b',
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
