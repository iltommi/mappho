// Set this to your Cloudflare Worker URL after deploying worker/index.js.
// Leave empty to skip the proxy (file downloads will fail in production).
// Example: 'https://sharpho-proxy.YOUR_NAME.workers.dev'
export const PROXY_URL = import.meta.env.VITE_PROXY_URL ?? '';
