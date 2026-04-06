/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/src/**/*.{js,ts,jsx,tsx}', './src/renderer/*.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          50: '#f8fafc',
          100: '#1e1e2e',
          200: '#181825',
          300: '#11111b',
          400: '#0a0a14'
        },
        accent: {
          DEFAULT: '#6c63ff',
          hover: '#7c74ff',
          dim: '#4a44b3'
        }
      }
    }
  },
  plugins: []
}
