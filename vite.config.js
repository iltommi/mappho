import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.BASE_URL ?? '/',
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __GIT_SHA__: JSON.stringify(process.env.GITHUB_SHA ?? 'dev'),
  },
  test: {
    // jsdom, not node: several modules touch `document` at import time
    // (DOM-wiring for their view alongside their pure logic), so plain
    // `node` would throw just importing them even for pure-function tests.
    environment: 'jsdom',
    setupFiles: ['./test/setup.js'],
  },
});
