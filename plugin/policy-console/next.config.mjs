import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the workspace root to this app — the outer repo's package-lock.json
  // otherwise gets picked up and Next warns on every build.
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
};

export default nextConfig;
