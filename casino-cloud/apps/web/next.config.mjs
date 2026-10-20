/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@m1/shared', '@m1/ui'],
  reactStrictMode: true,
  poweredByHeader: false,
  // basic hardening of the web app (no framing, no MIME sniffing, no referrer leak to other sites)
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'geolocation=(), microphone=()' },
      ],
    }];
  },
};
export default nextConfig;
