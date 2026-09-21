import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ioredis is a CommonJS client with runtime requires; let Node resolve it
  // from node_modules instead of bundling it into the server output.
  serverExternalPackages: ["ioredis"],
};

export default nextConfig;
