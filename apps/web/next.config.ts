import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "export",
  trailingSlash: false,
  images: { unoptimized: true },
  // Monorepo: trace files from repo root (avoids wrong root when another lockfile exists on the machine)
  outputFileTracingRoot: path.join(__dirname, "..", "..")
};

export default nextConfig;
