// @ts-check
import react from "@astrojs/react";
import vercel from "@astrojs/vercel";
import { cacheVercel } from "@astrojs/vercel/cache";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, fontProviders } from "astro/config";

// https://astro.build/config
export default defineConfig({
  adapter: vercel({
    webAnalytics: {
      enabled: false,
    },
  }),
  // Serves on-demand rendered routes (see src/pages/contributors.astro) from
  // the Vercel edge, so the GitHub API is hit at most once per TTL no matter
  // how many people load the page.
  cache: {
    provider: cacheVercel(),
  },
  fonts: [
    {
      cssVariable: "--font-geist-sans",
      fallbacks: ["sans-serif"],
      name: "Geist Sans",
      provider: fontProviders.fontsource(),
    },
    {
      cssVariable: "--font-geist-mono",
      fallbacks: ["monospace"],
      name: "Geist Mono",
      provider: fontProviders.fontsource(),
    },
  ],
  image: {
    remotePatterns: [
      {
        hostname: "**.public.blob.vercel-storage.com",
        protocol: "https",
      },
      {
        hostname: "avatars.githubusercontent.com",
        protocol: "https",
      },
    ],
    service: {
      entrypoint: "astro/assets/services/sharp",
    },
  },
  integrations: [react()],
  output: "static",
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      noExternal: ["react-tweet"],
    },
  },
});
