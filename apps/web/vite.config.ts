import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'node:path';

/**
 * Two entry points: the staff PWA (index.html, offline-capable) and the public booking page (booking.html, also
 * used by the embeddable widget, the reservation management link and the feedback link).
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['favicon.png', 'brand/*.png', 'brand/*.jpg'],
      manifest: {
        id: '/',
        name: "Sofia's Resto-Lounge",
        short_name: "Sofia's",
        description: 'Restaurant operating & guest intelligence platform',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#3E0B12',
        theme_color: '#3E0B12',
        icons: [
          { src: '/brand/sofia-icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/brand/sofia-icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/brand/sofia-icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,jpg,svg,woff2,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/health/, /^\/book/, /^\/r\//, /^\/feedback/, /^\/widget\.js/],
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          { urlPattern: /\/api\/v1\/files\//, handler: 'CacheFirst', options: { cacheName: 'sofia-files', expiration: { maxEntries: 30 } } },
          { urlPattern: /\/api\/v1\/public\/branding$/, handler: 'NetworkFirst', options: { cacheName: 'sofia-branding', networkTimeoutSeconds: 3 } },
        ],
      },
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html'), booking: resolve(__dirname, 'booking.html') },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8080', '/health': 'http://127.0.0.1:8080' },
  },
  test: { environment: 'node' },
} as never);
