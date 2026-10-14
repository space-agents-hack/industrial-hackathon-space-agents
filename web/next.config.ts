import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // The repository Admin reads and changes (lib/github.ts), fixed when the web is built: GitHub
  // Actions sets GITHUB_REPOSITORY in the release job that builds it, so nobody sets it by hand.
  env: { GITHUB_REPO: process.env.GITHUB_REPO ?? process.env.GITHUB_REPOSITORY ?? "" },
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
