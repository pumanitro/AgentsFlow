/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== 'production';

module.exports = {
  output: isDev ? undefined : 'export',
  distDir: isDev ? '.next' : 'out',
  images: { unoptimized: true },
  trailingSlash: true,
  // In production the app is served by electron-serve from the `app://-` origin.
  // A relative prefix ('./') resolves chunk URLs against the *current* route, so
  // after client-side navigation to /session/ the dynamically-imported chunks
  // (Terminal, FileTreeSidebar, FileEditor) 404 and the panes render blank.
  // Pin assets to the absolute electron-serve origin so they resolve from any route.
  assetPrefix: isDev ? undefined : 'app://-',
  reactStrictMode: true,
};
