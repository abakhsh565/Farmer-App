import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5273,
    strictPort: false,
    host: '127.0.0.1',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
    /*
     * The screen-level suites assert on real timers — the feed's own 600 ms
     * loading state, a 4 s window for storage, a 1.2 s analysis step. Run with
     * every core saturated and those windows close before the assertion lands,
     * which reads as a product failure and is not one. Capping the pool is the
     * honest fix: the tests keep their real timing, the machine stops being
     * oversubscribed.
     */
    pool: 'threads',
    poolOptions: { threads: { maxThreads: 4, minThreads: 1 } },
    testTimeout: 15_000,
  },
});
