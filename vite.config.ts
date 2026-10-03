// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { loadEnv, type Plugin } from "vite";

const loadServerEnvironment: Plugin = {
  name: "load-server-environment",
  config(_config, { mode }) {
    // Vite exposes only VITE_-prefixed values to import.meta.env. Load server-only
    // secrets into the Node environment without defining them in the client bundle.
    for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), ""))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  },
};

export default defineConfig({
  plugins: [loadServerEnvironment],
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
