/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Yandex Maps 3.0 creates multiple WebGL contexts per instance.
  // React Strict Mode double-mounts components in dev, which exceeds the browser
  // WebGL context limit (~16). Disabled until migration to MapLibre (P6).
  reactStrictMode: false,
};

export default nextConfig;