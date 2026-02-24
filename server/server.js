#!/usr/bin/env node

/**
 * dom-to-pptx HTTP API Server
 *
 * Start: node server.js
 * Port:  3000 (configurable via PORT environment variable)
 *
 * API:
 *   POST /convert       - Convert HTML to PPTX (JSON body, returns base64 or binary)
 *   POST /upload        - Upload HTML file (multipart), returns PPTX binary
 *   GET  /health        - Health check
 *   GET  /stats         - Server and browser pool statistics
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { URL } = require('url');

const API_SECRET = process.env.API_SECRET;
if (!API_SECRET) {
  console.error('API_SECRET is not set. Refusing to start without authentication enabled.');
  process.exit(1);
}

// Pre-load dom-to-pptx bundle once at startup (avoids per-request overhead).
// In Docker the bundle is placed next to this file by the Dockerfile.
// Locally it lives in dist/ after running `npm run build` from the repo root.
const BUNDLE_PATHS = [
  path.join(__dirname, 'dom-to-pptx.bundle.js'),       // Docker / co-located
  path.join(__dirname, '../dist/dom-to-pptx.bundle.js'), // local dev
];
const bundlePath = BUNDLE_PATHS.find(p => fs.existsSync(p));
if (!bundlePath) {
  console.error('dom-to-pptx.bundle.js not found. Run `npm run build` from the repo root first.');
  process.exit(1);
}
const DOM_TO_PPTX_SCRIPT = fs.readFileSync(bundlePath, 'utf8');
console.log(`📦 Bundle loaded from: ${bundlePath}`);

// ============== Configuration ==============
const CONFIG = {
  port: parseInt(process.env.PORT) || 3000,
  pool: {
    min: 2,
    max: parseInt(process.env.POOL_MAX) || 5,
    idleTimeout: 60000,
  },
  convert: {
    timeout: 60000,
    queueMax: 100,
  },
  viewport: {
    width: 1920,
    height: 1080,
  },
};

// ============== Browser Pool ==============
class BrowserPool {
  constructor(options) {
    this.min = options.min;
    this.max = options.max;
    this.idleTimeout = options.idleTimeout;
    this.available = [];
    this.inUse = new Set();
    this.pending = [];
    this.closed = false;
    this.stats = { created: 0, destroyed: 0, acquired: 0, released: 0, timeouts: 0 };
  }

  async init() {
    console.log(`🚀 Initializing browser pool (min=${this.min}, max=${this.max})...`);
    const browsers = await Promise.all(
      Array.from({ length: this.min }, () => this._createBrowser())
    );
    this.available.push(...browsers);
    console.log(`✅ Browser pool ready with ${this.available.length} instance(s)`);
  }

  async _createBrowser() {
    const browser = await chromium.launch({
      headless: true,
      // Required in Kubernetes/Docker — the default Chromium sandbox uses
      // syscalls that are blocked by the container seccomp profile.
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    browser._poolCreatedAt = Date.now();
    browser._poolLastUsed = Date.now();
    this.stats.created++;
    return browser;
  }

  async acquire(timeout = 30000) {
    if (this.closed) throw new Error('Pool is closed');

    if (this.available.length > 0) {
      const browser = this.available.pop();
      browser._poolLastUsed = Date.now();
      this.inUse.add(browser);
      this.stats.acquired++;
      return browser;
    }

    if (this.available.length + this.inUse.size < this.max) {
      const browser = await this._createBrowser();
      this.inUse.add(browser);
      this.stats.acquired++;
      return browser;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pending.findIndex(p => p.resolve === resolve);
        if (idx !== -1) this.pending.splice(idx, 1);
        this.stats.timeouts++;
        reject(new Error('Acquire browser timeout'));
      }, timeout);
      this.pending.push({ resolve, reject, timer });
    });
  }

  async release(browser) {
    if (!this.inUse.has(browser)) return;
    this.inUse.delete(browser);
    this.stats.released++;
    browser._poolLastUsed = Date.now();

    let healthy = true;
    try {
      const contexts = browser.contexts();
      for (let i = 1; i < contexts.length; i++) {
        await contexts[i].close().catch(() => {});
      }
    } catch {
      healthy = false;
    }

    if (!healthy) {
      await this._destroyBrowser(browser);
      return;
    }

    if (this.pending.length > 0) {
      const { resolve, timer } = this.pending.shift();
      clearTimeout(timer);
      browser._poolLastUsed = Date.now();
      this.inUse.add(browser);
      this.stats.acquired++;
      resolve(browser);
      return;
    }

    this.available.push(browser);
  }

  async _destroyBrowser(browser) {
    try { await browser.close(); } catch {}
    this.stats.destroyed++;
  }

  getStats() {
    return {
      available: this.available.length,
      inUse: this.inUse.size,
      pending: this.pending.length,
      total: this.available.length + this.inUse.size,
      ...this.stats,
    };
  }

  async close() {
    this.closed = true;
    for (const { reject, timer } of this.pending) {
      clearTimeout(timer);
      reject(new Error('Pool is closing'));
    }
    this.pending = [];
    const all = [...this.available, ...this.inUse];
    await Promise.all(all.map(b => this._destroyBrowser(b)));
    this.available = [];
    this.inUse.clear();
  }
}

// ============== Converter ==============
class Converter {
  constructor(pool) {
    this.pool = pool;
    this.queue = 0;
    this.stats = { total: 0, success: 0, failed: 0 };
  }

  async convert(options) {
    const { html, url, selector = '.slide', viewport } = options;

    if (this.queue >= CONFIG.convert.queueMax) {
      throw new Error('Server is busy, try again later');
    }

    this.queue++;
    this.stats.total++;

    let browser;
    try {
      browser = await this.pool.acquire(CONFIG.convert.timeout);
      const result = await this._doConvert(browser, { html, url, selector, viewport });
      this.stats.success++;
      return result;
    } catch (err) {
      this.stats.failed++;
      throw err;
    } finally {
      this.queue--;
      if (browser) await this.pool.release(browser);
    }
  }

  async _doConvert(browser, { html, url, selector, viewport }) {
    const context = await browser.newContext({
      viewport: viewport || CONFIG.viewport,
    });
    const page = await context.newPage();

    try {
      page.setDefaultTimeout(CONFIG.convert.timeout);

      if (url) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } else if (html) {
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
      } else {
        throw new Error('Missing html or url parameter');
      }

      await page.waitForTimeout(100);

      await page.evaluate((script) => {
        const el = document.createElement('script');
        el.textContent = script;
        document.head.appendChild(el);
      }, DOM_TO_PPTX_SCRIPT);

      await page.waitForFunction(() => typeof window.domToPptx !== 'undefined', {
        timeout: 5000,
      });

      let finalSelector = selector;
      const exists = await page.evaluate(
        (sel) => document.querySelectorAll(sel).length > 0,
        selector
      );

      if (!exists) {
        for (const fb of ['.slide', '#slide', '[class*="slide"]', 'body > div:first-child', 'body']) {
          const found = await page.evaluate((s) => document.querySelectorAll(s).length > 0, fb);
          if (found) { finalSelector = fb; break; }
        }
      }

      const pptxBase64 = await page.evaluate(async (sel) => {
        const elements = Array.from(document.querySelectorAll(sel));
        if (elements.length === 0) throw new Error('Element not found: ' + sel);
        const target = elements.length === 1 ? elements[0] : elements;
        const blob = await window.domToPptx.exportToPptx(target, { skipDownload: true });
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result.split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }, finalSelector);

      return { success: true, data: pptxBase64, selector: finalSelector };

    } finally {
      await context.close().catch(() => {});
    }
  }

  getStats() {
    return { queue: this.queue, ...this.stats };
  }
}

// ============== HTTP Helpers ==============
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundaryMatch) { reject(new Error('Missing boundary in content-type')); return; }

    const boundary = boundaryMatch[1] || boundaryMatch[2];
    const chunks = [];
    let totalSize = 0;

    req.on('data', chunk => {
      totalSize += chunk.length;
      if (totalSize > 50 * 1024 * 1024) { reject(new Error('File too large (max 50MB)')); req.destroy(); return; }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const result = { fields: {}, files: [] };
        const boundaryBuf = Buffer.from('--' + boundary);
        const parts = [];
        let start = 0, idx;

        while ((idx = buffer.indexOf(boundaryBuf, start)) !== -1) {
          if (start > 0) {
            const partEnd = idx - 2;
            if (partEnd > start) parts.push(buffer.subarray(start, partEnd));
          }
          start = idx + boundaryBuf.length;
          if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;
        }

        for (const part of parts) {
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) continue;
          const headerStr = part.subarray(0, headerEnd).toString('utf8');
          const content = part.subarray(headerEnd + 4);
          const headers = {};
          for (const line of headerStr.split('\r\n')) {
            const ci = line.indexOf(':');
            if (ci !== -1) headers[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
          }
          const disp = headers['content-disposition'] || '';
          const nameMatch = disp.match(/name="([^"]+)"/);
          const filenameMatch = disp.match(/filename="([^"]+)"/);
          if (!nameMatch) continue;
          if (filenameMatch) {
            result.files.push({
              name: nameMatch[1],
              filename: filenameMatch[1],
              contentType: headers['content-type'] || 'application/octet-stream',
              data: content,
            });
          } else {
            result.fields[nameMatch[1]] = content.toString('utf8');
          }
        }
        resolve(result);
      } catch (err) {
        reject(new Error('Failed to parse multipart: ' + err.message));
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function sendBinary(res, buffer, filename) {
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': buffer.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buffer);
}

function extractAuthToken(req) {
  const headerSecret = req.headers['x-api-secret'] || req.headers['x-api-key'];
  if (typeof headerSecret === 'string' && headerSecret.trim()) return headerSecret.trim();
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  return null;
}

function isAuthorized(req) {
  const token = extractAuthToken(req);
  return token && token === API_SECRET;
}

// ============== Start Server ==============
async function startServer() {
  const pool = new BrowserPool(CONFIG.pool);
  await pool.init();

  const converter = new Converter(pool);
  const startTime = Date.now();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Secret, X-API-Key',
      });
      res.end();
      return;
    }

    try {
      if (pathname !== '/health' && !isAuthorized(req)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      // GET /health
      if (pathname === '/health' && req.method === 'GET') {
        const poolStats = pool.getStats();
        const healthy = poolStats.available > 0 || poolStats.inUse < CONFIG.pool.max;
        sendJson(res, healthy ? 200 : 503, {
          status: healthy ? 'ok' : 'unhealthy',
          uptime: Math.floor((Date.now() - startTime) / 1000),
          pool: { available: poolStats.available, inUse: poolStats.inUse, max: CONFIG.pool.max },
        });
        return;
      }

      // GET /stats
      if (pathname === '/stats' && req.method === 'GET') {
        sendJson(res, 200, {
          uptime: Math.floor((Date.now() - startTime) / 1000),
          pool: pool.getStats(),
          converter: converter.getStats(),
        });
        return;
      }

      // POST /convert  — body: { html?, url?, selector?, viewport?, filename? }
      // Query param:   ?format=base64 (default) | ?format=binary
      if (pathname === '/convert' && req.method === 'POST') {
        const body = await parseBody(req);
        const format = url.searchParams.get('format') || 'base64';

        if (!body.html && !body.url) {
          sendJson(res, 400, { error: 'Provide either html or url in request body' });
          return;
        }

        const result = await converter.convert({
          html: body.html,
          url: body.url,
          selector: body.selector,
          viewport: body.viewport,
        });

        if (format === 'binary') {
          sendBinary(res, Buffer.from(result.data, 'base64'), body.filename || 'output.pptx');
        } else {
          sendJson(res, 200, { success: true, data: result.data, selector: result.selector });
        }
        return;
      }

      // POST /upload  — multipart/form-data: file (HTML), selector?, filename?, viewport?
      if (pathname === '/upload' && req.method === 'POST') {
        if (!(req.headers['content-type'] || '').includes('multipart/form-data')) {
          sendJson(res, 400, { error: 'Content-Type must be multipart/form-data' });
          return;
        }

        const { fields, files } = await parseMultipart(req);
        const htmlFile = files.find(f => f.name === 'file' || f.name === 'html');
        if (!htmlFile) {
          sendJson(res, 400, { error: 'Missing file. Use "file" or "html" as the field name.' });
          return;
        }

        let viewport;
        if (fields.viewport) {
          try { viewport = JSON.parse(fields.viewport); } catch {}
        }

        const result = await converter.convert({
          html: htmlFile.data.toString('utf8'),
          selector: fields.selector || '.slide',
          viewport,
        });

        const filename = fields.filename
          || htmlFile.filename.replace(/\.(html?|htm)$/i, '.pptx')
          || 'output.pptx';

        sendBinary(res, Buffer.from(result.data, 'base64'), filename);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });

    } catch (err) {
      console.error(`❌ ${err.message}`);
      sendJson(res, 500, { error: err.message });
    }
  });

  const shutdown = async (signal) => {
    console.log(`\n📴 Received ${signal}, shutting down...`);
    server.close(() => console.log('🔌 HTTP server stopped'));
    await pool.close();
    console.log('🌐 Browser pool closed');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen(CONFIG.port, () => {
    console.log(`
╔═══════════════════════════════════════════════════╗
║         dom-to-pptx API Server started            ║
╠═══════════════════════════════════════════════════╣
║  Address: http://localhost:${CONFIG.port.toString().padEnd(22)}║
║  Browser pool: ${CONFIG.pool.min}-${CONFIG.pool.max} instance(s)${' '.repeat(24)}║
╠═══════════════════════════════════════════════════╣
║    POST /convert  - Convert HTML → PPTX (JSON)    ║
║    POST /upload   - Upload HTML file → PPTX       ║
║    GET  /health   - Health check                  ║
║    GET  /stats    - Server statistics             ║
╚═══════════════════════════════════════════════════╝
`);
  });
}

startServer().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
