/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // One accent, calm neutrals. Academic reading product.
        ink: {
          DEFAULT: '#1a1a1a',
          muted: '#6b6b6b',
          faint: '#9a9a9a',
        },
        surface: {
          DEFAULT: '#ffffff',
          sunken: '#faf9f7',
          raised: '#ffffff',
        },
        line: '#e7e5e1',
        accent: {
          DEFAULT: '#7c5c3e',
          soft: '#f3ede6',
          strong: '#664a30',
        },
      },
      fontFamily: {
        serif: ['"Source Serif 4"', '"Iowan Old Style"', 'Georgia', 'Cambria', 'serif'],
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: '6px',
      },
    },
  },
  plugins: [],
};
