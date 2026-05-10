// Local empty PostCSS config so Vite does not climb up to the Next.js root config
// (which depends on @tailwindcss/postcss not installed in the admin SPA).
export default { plugins: {} };
