/** @type {import('next').NextConfig} */
// Export mode is opted into explicitly by the build script (AGENTSFLOW_EXPORT=1)
// instead of being inferred from NODE_ENV, so a shell-inherited NODE_ENV can
// never flip this config.
const isExport = process.env.AGENTSFLOW_EXPORT === '1';

module.exports = {
  output: isExport ? 'export' : undefined,
  // With `output: 'export'`, Next treats a custom distDir as the EXPORT target
  // and forces the build itself into `.next` (see hasCustomExportOutput in
  // next/dist/build/index.js). Dev therefore must NOT live in `.next`: a
  // `next build` run while `npm run dev` is up would overwrite the dev
  // server's compilation state, and every already-open window would 404 its
  // lazily-loaded chunks and sit on "Loading…" forever.
  distDir: isExport ? 'out' : '.next-dev',
  images: { unoptimized: true },
  trailingSlash: true,
  // In production the app is served by electron-serve from the `app://-` origin.
  // A relative prefix ('./') resolves chunk URLs against the *current* route, so
  // after client-side navigation to /session/ the dynamically-imported chunks
  // (Terminal, FileTreeSidebar, FileEditor) 404 and the panes render blank.
  // Pin assets to the absolute electron-serve origin so they resolve from any route.
  assetPrefix: isExport ? 'app://-' : undefined,
  reactStrictMode: true,
  // The renderer imports runtime code from ../shared (e.g. fork-title.ts).
  // Next only transpiles TypeScript inside its own root by default, so a value
  // import from outside it fails with "Module parse failed: Unexpected token"
  // — type-only imports (shared/types.ts) never hit this because they're
  // erased before webpack. externalDir extends the SWC transform to files
  // outside the renderer directory.
  experimental: { externalDir: true },
};
