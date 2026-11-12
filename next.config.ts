import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Let phones/tablets on the home network use the dev server (e.g. http://192.168.4.42:3100).
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.*.*.*", "*.local"],
  // Self-contained server bundle (.next/standalone) — used by the Mac app (electron/).
  output: "standalone",
  // The server builds data paths at runtime, so the tracer would otherwise copy local renders,
  // sample media and sources into the bundle. None of it is needed to run.
  outputFileTracingExcludes: {
    "*": [
      ".beatsync-data/**", "public/samples/**", "samples/**", "tests/**", "scripts/**", "src/**",
      "electron/**", "dist/**", "app-build/**", "node_modules/sharp/**", "node_modules/@img/**",
    ],
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
