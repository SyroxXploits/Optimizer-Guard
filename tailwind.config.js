/** @type {import('tailwindcss').Config} */
const channel = (v) => `rgb(var(${v}) / <alpha-value>)`

module.exports = {
  content: ['./src/renderer/src/**/*.{js,ts,jsx,tsx}', './src/renderer/index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: channel('--surface'),
          raised: channel('--surface-raised'),
          overlay: channel('--surface-overlay'),
          flyout: channel('--surface-flyout')
        },
        accent: {
          DEFAULT: channel('--accent'),
          light: channel('--accent-light'),
          dark: channel('--accent-dark')
        },
        // Neutral overlay fill — white on dark themes, black on light.
        fill: channel('--fill'),
        stroke: {
          DEFAULT: 'rgb(var(--stroke) / 0.09)',
          surface: 'rgb(var(--stroke) / 0.18)',
          divider: 'rgb(var(--stroke) / 0.09)'
        },
        text: {
          primary: channel('--text-primary'),
          secondary: channel('--text-secondary'),
          tertiary: channel('--text-tertiary'),
          disabled: channel('--text-disabled')
        },
        status: {
          success: channel('--status-success'),
          warning: channel('--status-warning'),
          error: channel('--status-error'),
          info: channel('--status-info')
        }
      },
      fontFamily: {
        sans: ['Segoe UI Variable', 'Segoe UI', 'system-ui', 'sans-serif']
      },
      borderRadius: {
        win: '8px',
        'win-lg': '12px',
        'win-xl': '16px'
      },
      boxShadow: {
        win: '0 8px 32px rgba(0,0,0,0.32)',
        'win-sm': '0 2px 8px rgba(0,0,0,0.24)',
        card: '0 0 0 1px rgb(var(--stroke) / 0.06), 0 4px 16px rgba(0,0,0,0.18)'
      },
      animation: {
        'pulse-slow': 'pulse 3s ease-in-out infinite',
        'spin-slow': 'spin 3s linear infinite',
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.2s ease-out'
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        }
      }
    }
  },
  plugins: []
}
