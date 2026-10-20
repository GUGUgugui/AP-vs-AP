/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
        },
        surface: {
          DEFAULT: '#fafafa',
          raised: '#ffffff',
          sunken: '#f5f5f5',
          hover: '#f0f0f0',
        },
        ink: {
          DEFAULT: '#0f0f11',
          muted: '#3f3f46',
          subtle: '#71717a',
          faint: '#8a8a91',
          line: '#e4e4e7',
        },
      },
      fontFamily: {
        sans: ['"PingFang SC"', '"Microsoft YaHei"', '"Hiragino Sans GB"', 'system-ui', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        'soft': '0 1px 2px 0 rgba(0,0,0,0.03), 0 1px 3px 0 rgba(0,0,0,0.04)',
        'card': '0 0 0 1px rgba(0,0,0,0.03), 0 2px 4px rgba(0,0,0,0.03), 0 6px 16px rgba(0,0,0,0.04)',
        'elevated': '0 0 0 1px rgba(0,0,0,0.04), 0 4px 8px rgba(0,0,0,0.04), 0 12px 24px rgba(0,0,0,0.06)',
        'input': '0 0 0 1px rgba(0,0,0,0.05), 0 2px 4px rgba(0,0,0,0.03)',
      },
      transitionTimingFunction: {
        'smooth': 'cubic-bezier(0.4, 0, 0.2, 1)',
        'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
  },
  plugins: [],
}
