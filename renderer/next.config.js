/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== 'production';

module.exports = {
  output: isDev ? undefined : 'export',
  distDir: isDev ? '.next' : 'out',
  images: { unoptimized: true },
  trailingSlash: true,
  assetPrefix: isDev ? undefined : './',
  reactStrictMode: true,
};
