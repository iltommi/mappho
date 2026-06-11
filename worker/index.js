// Cloudflare Worker — proxies pCloud API and CDN requests.
// Deploy at: https://dash.cloudflare.com → Workers → Create Worker → paste this file.
// Then set VITE_PROXY_URL to your worker's *.workers.dev URL in the app.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // /cdn?url=ENCODED_URL  →  proxy the CDN file download
    // /anything-else        →  proxy to eapi.pcloud.com
    let targetUrl;
    if (url.pathname === '/cdn') {
      targetUrl = url.searchParams.get('url');
      if (!targetUrl) return new Response('Missing url param', { status: 400 });
    } else {
      targetUrl = `https://eapi.pcloud.com${url.pathname}${url.search}`;
    }

    const fetchHeaders = {};
    const range = request.headers.get('Range');
    if (range) fetchHeaders['Range'] = range;

    const upstream = await fetch(targetUrl, { headers: fetchHeaders });

    const respHeaders = { ...CORS };
    respHeaders['Content-Type'] = upstream.headers.get('Content-Type') ?? 'application/octet-stream';
    const cr = upstream.headers.get('Content-Range');
    if (cr) respHeaders['Content-Range'] = cr;

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  },
};
