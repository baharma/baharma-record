import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fully client-side app (no backend/API routes), so it can be built as a
  // static site: `next build` outputs static files directly to ./out.
  output: "export",
};

export default nextConfig;
