// ── pCloud OAuth app settings ──────────────────────────────────────────────
// 1. Go to https://docs.pcloud.com/my_apps/ and create a new app.
// 2. Under "Redirect URIs" add:
//      http://localhost:5173   (for development)
//      https://your-domain     (for production)
// 3. Set VITE_PCLOUD_CLIENT_ID in .env (local) or as a repo secret (CI).
export const PCLOUD_CLIENT_ID = import.meta.env.VITE_PCLOUD_CLIENT_ID ?? 'YOUR_CLIENT_ID_HERE';
