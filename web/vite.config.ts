// One page: desk2.html. Its own UI is an inline script; desk2-extras.ts bundles the modules it
// shares (terminal, alerts, Ask targets, dialogs).
import { defineConfig } from "vite";
import { resolve } from "node:path";

// `npm run dev:web` (port 5199) talks to a desk running on 7420.
const desk = "http://127.0.0.1:7420";

export default defineConfig({
  server: {
    proxy: {
      "/ws": { target: desk, ws: true },
      "/pty": { target: desk, ws: true },
      "/healthz": desk,
      "/upload": desk,
      "/uploads": desk,
    },
  },
  build: {
    rollupOptions: {
      input: {
        desk2: resolve(import.meta.dirname, "desk2.html"),
      },
    },
  },
});
