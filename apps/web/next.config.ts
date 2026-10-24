import { config } from "dotenv";
import path from "node:path";
import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/security-headers";

// Single .env at the repo root, shared with the agent.
config({ path: "../../.env" });

const nextConfig: NextConfig = {
  // Self-contained server output for the Docker image; the trace root is the monorepo root.
  output: "standalone",
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  // Ticket renderer: native canvas module + the font it loads at runtime (must be copied into the standalone output).
  serverExternalPackages: ["@napi-rs/canvas"],
  outputFileTracingIncludes: { "/**": ["./assets/fonts/**"] },
  cacheComponents: true,
  partialPrefetching: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders(process.env.NODE_ENV !== "production") }];
  },
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
