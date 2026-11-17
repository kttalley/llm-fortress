import { defineConfig } from 'vite';

export default defineConfig({
  base: '/projects/llm-fortress/',

  server: {
    origin: 'https://design.kristiantalley.com',
    allowedHosts: ['design.kristiantalley.com'],
    // Local dev: send API calls to a locally running llm-proxy (npm start in llm-proxy/).
    proxy: {
      '/projects/llm-fortress/api': 'http://127.0.0.1:8787',
    },
  },
});