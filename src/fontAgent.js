'use strict';
// Local font helper compatible with Figma's font agent protocol (same as figma-agent-linux).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { getFontFiles } = require('./fontScan');

const HOST = '127.0.0.1';
const PORT = 44950;
const ALLOWED_ORIGIN = 'https://www.figma.com';
const PACKAGE = '125.9.10';
const VERSION = 23;

const CONTENT_TYPES = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ttc': 'font/collection',
  '.otc': 'font/collection',
};

function corsHeaders(req) {
  const headers = { Vary: 'Origin' };
  if (req.headers.origin === ALLOWED_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
  }
  return headers;
}

function sendJson(req, res, body) {
  res.writeHead(200, { ...corsHeaders(req), 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendStatus(req, res, status) {
  res.writeHead(status, corsHeaders(req));
  res.end();
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...corsHeaders(req),
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '600',
    });
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendStatus(req, res, 405);

  switch (url.pathname) {
    case '/figma/version':
      return sendJson(req, res, { package: PACKAGE, version: VERSION });

    case '/figma/font-files': {
      const fontFiles = await getFontFiles();
      return sendJson(req, res, {
        fontFiles,
        modified_at: null,
        modified_fonts: null,
        package: PACKAGE,
        version: VERSION,
      });
    }

    case '/figma/font-file': {
      const file = url.searchParams.get('file');
      const fontFiles = await getFontFiles();
      // Only serve files that came from the font scan, never arbitrary paths.
      if (!file || !Object.hasOwn(fontFiles, file)) return sendStatus(req, res, 404);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        return sendStatus(req, res, 404);
      }
      res.writeHead(200, {
        ...corsHeaders(req),
        'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
      return;
    }

    default:
      return sendStatus(req, res, 404);
  }
}

// Starts the agent. Resolves to the server, or null if another agent already owns the port.
function startFontAgent() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        console.error('[font-agent]', err);
        if (!res.headersSent) sendStatus(req, res, 500);
        else res.destroy();
      });
    });
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[font-agent] port ${PORT} in use, assuming an existing figma-agent is running`);
      } else {
        console.error('[font-agent] failed to start:', err);
      }
      resolve(null);
    });
    server.listen(PORT, HOST, () => {
      console.log(`[font-agent] listening on http://${HOST}:${PORT}`);
      getFontFiles()
        .then((files) => console.log(`[font-agent] ${Object.keys(files).length} font files indexed`))
        .catch((err) => console.error('[font-agent] font scan failed:', err));
      resolve(server);
    });
  });
}

module.exports = { startFontAgent };

if (require.main === module) startFontAgent();
