import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        medical: {
          red: "#FF2E2E",
          blue: "#2E5BFF",
        },
      },
      fontSize: {
        'display-large': ['2.5rem', { lineHeight: '3rem', fontWeight: '700' }],
        'display-medium': ['2rem', { lineHeight: '2.5rem', fontWeight: '700' }],
        'display-small': ['1.75rem', { lineHeight: '2.25rem', fontWeight: '600' }],
        'value-large': ['2rem', { lineHeight: '2.5rem', fontWeight: '600' }],
        'value-medium': ['1.75rem', { lineHeight: '2.25rem', fontWeight: '600' }],
        'value-small': ['1.5rem', { lineHeight: '2rem', fontWeight: '600' }],
      },
    },
  },
  plugins: [],
} satisfies Config;
