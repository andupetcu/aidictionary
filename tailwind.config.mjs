/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        pink: { brand: '#FF1493' },
        red: { brand: '#FF0040' },
        orange: { brand: '#FF6B00' },
        yellow: { brand: '#FFD700', highlight: '#FFE500' },
        body: '#1a1a1a',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
