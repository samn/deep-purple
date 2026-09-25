import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // MapLibre is most of the page's JS and changes only on upgrades.
          // In its own chunk it stays cached (assets are served immutable)
          // across deploys that touch just the app.
          groups: [{ name: "maplibre", test: /node_modules[\\/]maplibre-gl[\\/]/ }],
        },
      },
    },
  },
  worker: {
    format: "es",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
