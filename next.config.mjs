/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  experimental: {
    // #189: never reuse a cached client Router Cache entry for dynamic routes.
    // The queue pages (/ and /books) are now force-dynamic, so navigating
    // queue -> archive -> queue refetches their fresh server render instead of
    // replaying the pre-mutation RSC that still listed the just-archived item.
    // (The archive pages are client components that fetch their list on mount,
    // so they self-refresh on navigation regardless of this setting.)
    staleTimes: {
      dynamic: 0,
    },
  },
  // Dev-only: allow Server Actions to be called from other devices on your
  // network (phone testing). Set DEV_ALLOWED_ORIGINS to a comma-separated list
  // of hosts or IPs. Prod is unaffected.
  allowedDevOrigins: (process.env.DEV_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  // #269: the vendored logger shim reads its token file via a dynamic path,
  // which defeats output-file-tracing's static analysis — Next then traces the
  // ENTIRE repo (docs, tests, data dumps, ~5.6 MiB) into every server function
  // that imports the logger. Exclude what a serverless bundle can never need.
  // Remove once the upstream shim (the logger repository) is tracing-friendly.
  outputFileTracingExcludes: {
    '*': [
      'prod_data_dump.sql',
      'docs/**',
      'supabase/**',
      'scripts/**',
      'cron-worker/**',
      'audible-sync/**',
      'substack-progress-sync/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      'tsconfig.tsbuildinfo',
      'pnpm-lock.yaml',
    ],
  },
}

export default nextConfig
