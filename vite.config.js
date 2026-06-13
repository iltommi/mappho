import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.BASE_URL ?? '/',
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
});
