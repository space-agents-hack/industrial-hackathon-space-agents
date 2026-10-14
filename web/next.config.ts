import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // The repository Admin › Releases reads, fixed when the web is built: GitHub Actions sets
  // GITHUB_REPOSITORY in the release job that builds it, so production needs nothing set by hand.
  env: { RELEASES_GITHUB_REPO: process.env.RELEASES_GITHUB_REPO ?? process.env.GITHUB_REPOSITORY ?? "" },
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
