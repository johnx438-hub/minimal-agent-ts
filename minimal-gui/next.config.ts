import path from "node:path";
import { fileURLToPath } from "node:url";

import { withAui } from "@assistant-ui/next";
import type { NextConfig } from "next";

/** This app lives under minimal-agent-ts; pin Turbopack root so parent lockfiles don't win. */
const root = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  turbopack: {
    root,
  },
};

export default withAui(nextConfig);
