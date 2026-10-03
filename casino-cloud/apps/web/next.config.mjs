/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@m1/shared', '@m1/ui'],
  reactStrictMode: true,
  poweredByHeader: false,
};
export default nextConfig;
