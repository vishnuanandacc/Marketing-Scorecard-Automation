import crypto from 'node:crypto';
import http from 'node:http';
import { existsSync, readFileSync, watch } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = __dirname;
const publicDir = path.join(rootDir, 'public');
const dataDir = path.join(rootDir, 'data');
const productMappingPath = path.join(dataDir, 'product-mapping.json');
const env = { ...process.env, ...loadEnv(path.join(rootDir, '.env')) };
const port = Number(env.PORT || 5173);
const hotReloadEnabled = isTruthy(process.env.HOT_RELOAD || env.HOT_RELOAD);
const hotReloadClients = new Set();
let hotReloadTimer = null;
let hotReloadWatchersStarted = false;
const appPassword = text(env.APP_PASSWORD);
const sessionCookieName = 'asp_session';
const sessionDurationMs = 12 * 60 * 60 * 1000;
const sessions = new Map();

const shopifyTokenCache = {
  token: '',
  expiresAt: 0,
};

const netSuiteTokenCache = {
  token: '',
  expiresAt: 0,
};

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/__dev/reload') {
      return handleHotReloadEvents(req, res);
    }

    if (req.method === 'GET' && (url.pathname === '/login' || url.pathname === '/login.html')) {
      if (isAuthenticated(req)) return redirect(res, '/');
      return serveStatic('/login.html', res);
    }

    if (req.method === 'POST' && url.pathname === '/api/login') {
      const body = await readJsonBody(req);
      if (!appPassword) {
        return sendJson(res, 500, { error: 'Login password is not configured' });
      }

      if (!passwordMatches(body.password)) {
        return sendJson(res, 401, { error: 'Invalid password' });
      }

      const token = createSession();
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': serializeSessionCookie(token),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      destroySession(req);
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': clearSessionCookie(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/session') {
      return sendJson(res, 200, { authenticated: isAuthenticated(req) });
    }

    if (!isPublicRequest(req, url) && !isAuthenticated(req)) {
      if (url.pathname.startsWith('/api/')) {
        return sendJson(res, 401, { error: 'Authentication required' });
      }

      return redirect(res, '/login');
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      const mappingState = await loadProductMappingState();
      return sendJson(res, 200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        config: configStatus(),
        mappings: mappingSummary(mappingState.mappings),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/mappings') {
      const mappingState = await loadProductMappingState();
      return sendJson(res, 200, {
        ...mappingState,
        summary: mappingSummary(mappingState.mappings),
      });
    }

    if (req.method === 'PUT' && url.pathname === '/api/mappings') {
      const body = await readJsonBody(req);
      const saved = await saveProductMappingState(body);
      return sendJson(res, 200, {
        ...saved,
        summary: mappingSummary(saved.mappings),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/mappings/shopify-source') {
      const body = await readJsonBody(req);
      const response = await buildShopifySourceMappingResponse(body);
      return sendJson(res, 200, response);
    }

    if (req.method === 'POST' && url.pathname === '/api/asp') {
      const body = await readJsonBody(req);
      const response = await buildAspResponse(body);
      return sendJson(res, 200, response);
    }

    if (req.method === 'GET') {
      return serveStatic(url.pathname, res);
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    const status = Number(error.statusCode || 500);
    sendJson(res, status, {
      error: status >= 500 ? 'Server error' : error.message,
      detail: status >= 500 ? error.message : undefined,
    });
  }
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(port, () => {
    console.log(`ASP Calculator running at http://localhost:${port}`);
    if (hotReloadEnabled) {
      startHotReloadWatchers();
      console.log('Hot reload enabled. Browser pages will refresh after public/data file changes.');
    }
  });
}

function loadEnv(filePath) {
  if (!existsSync(filePath)) return {};

  const raw = requireReadFile(filePath);
  const values = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function requireReadFile(filePath) {
  return readFileSync(filePath, 'utf8');
}

async function serveStatic(requestPath, res) {
  const cleanPath = requestPath === '/' ? '/index.html' : requestPath;
  const decodedPath = decodeURIComponent(cleanPath);
  const filePath = path.normalize(path.join(publicDir, decodedPath));

  if (!filePath.startsWith(publicDir)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  if (!existsSync(filePath)) {
    return sendJson(res, 404, { error: 'Not found' });
  }

  const ext = path.extname(filePath);
  const contentType = contentTypes[ext] || 'application/octet-stream';
  const body = await readFile(filePath);
  const responseBody = hotReloadEnabled && ext === '.html'
    ? Buffer.from(injectHotReloadClient(body.toString('utf8')), 'utf8')
    : body;

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(responseBody);
}

function handleHotReloadEvents(req, res) {
  if (!hotReloadEnabled) {
    return sendJson(res, 404, { error: 'Hot reload is not enabled' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const heartbeat = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15_000);

  hotReloadClients.add(res);
  req.on('close', () => {
    clearInterval(heartbeat);
    hotReloadClients.delete(res);
  });
}

function startHotReloadWatchers() {
  if (hotReloadWatchersStarted) return;
  hotReloadWatchersStarted = true;

  for (const directory of [publicDir, dataDir]) {
    if (!existsSync(directory)) continue;

    try {
      watch(directory, { recursive: true }, (_eventType, filename) => {
        scheduleHotReload(filename ? String(filename) : path.basename(directory));
      });
    } catch (error) {
      console.warn(`Hot reload watcher skipped for ${directory}: ${error.message}`);
    }
  }
}

function scheduleHotReload(filename) {
  clearTimeout(hotReloadTimer);
  hotReloadTimer = setTimeout(() => {
    const payload = JSON.stringify({
      changed: filename,
      at: new Date().toISOString(),
    });

    for (const client of hotReloadClients) {
      client.write(`event: reload\ndata: ${payload}\n\n`);
    }
  }, 100);
}

function injectHotReloadClient(html) {
  if (html.includes('/__dev/reload')) return html;

  const script = `
    <script>
      (() => {
        const source = new EventSource('/__dev/reload');
        let reloadTimer = null;
        source.addEventListener('reload', () => window.location.reload());
        source.onerror = () => {
          if (reloadTimer) return;
          reloadTimer = window.setTimeout(() => window.location.reload(), 750);
        };
      })();
    </script>`;

  return html.includes('</body>')
    ? html.replace('</body>', `${script}\n  </body>`)
    : `${html}${script}`;
}

async function readJsonBody(req) {
  let raw = '';

  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) {
      throw httpError(413, 'Request body is too large');
    }
  }

  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, 'Invalid JSON body');
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
  });
  res.end();
}

function isPublicRequest(req, url) {
  if (req.method !== 'GET') return false;
  return ['/styles.css', '/login.js', '/login.html', '/login'].includes(url.pathname);
}

function isAuthenticated(req) {
  const token = cookieValue(req.headers.cookie, sessionCookieName);
  if (!token) return false;

  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;

  if (expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }

  return true;
}

function createSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + sessionDurationMs);
  return token;
}

function destroySession(req) {
  const token = cookieValue(req.headers.cookie, sessionCookieName);
  if (token) sessions.delete(token);
}

function passwordMatches(candidate) {
  if (!appPassword) return false;

  const candidateText = text(candidate);
  const expected = Buffer.from(appPassword);
  const actual = Buffer.from(candidateText);

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function cookieValue(cookieHeader, name) {
  const cookies = String(cookieHeader || '').split(';');
  for (const cookie of cookies) {
    const [rawKey, ...rawValue] = cookie.trim().split('=');
    if (rawKey === name) return decodeURIComponent(rawValue.join('='));
  }
  return '';
}

function serializeSessionCookie(token) {
  return [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(sessionDurationMs / 1000)}`,
  ].join('; ');
}

function clearSessionCookie() {
  return `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function loadProductMappingState() {
  if (!existsSync(productMappingPath)) {
    return {
      version: 1,
      updatedAt: '',
      sourceFiles: [],
      mappings: [],
    };
  }

  const raw = await readFile(productMappingPath, 'utf8');
  const parsed = JSON.parse(raw);

  return {
    version: Number(parsed.version || 1),
    updatedAt: text(parsed.updatedAt),
    sourceFiles: Array.isArray(parsed.sourceFiles) ? parsed.sourceFiles : [],
    mappings: sanitizeProductMappings(parsed.mappings || []),
  };
}

async function saveProductMappingState(input) {
  const current = await loadProductMappingState();
  const mappings = sanitizeProductMappings(input.mappings || []);
  const payload = {
    version: Number(input.version || current.version || 1),
    updatedAt: new Date().toISOString(),
    sourceFiles: Array.isArray(input.sourceFiles) ? input.sourceFiles : current.sourceFiles,
    mappings,
  };

  await mkdir(dataDir, { recursive: true });
  await writeFile(productMappingPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function sanitizeProductMappings(rows) {
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row, index) => {
      const shopifySku = text(row.shopifySku).toUpperCase();
      const shopifyTitle = text(row.shopifyTitle);
      const netsuiteItem = text(row.netsuiteItem).toUpperCase();
      const netsuiteName = text(row.netsuiteName);
      const notes = text(row.notes);
      const multiplier = numberFrom(row.candleUnitsPerNetSuiteUnit);
      const id = text(row.id) || `map-${String(index + 1).padStart(4, '0')}`;

      return {
        id,
        active: Boolean(row.active),
        shopifySku,
        shopifyTitle,
        netsuiteItem,
        netsuiteName,
        candleUnitsPerNetSuiteUnit: multiplier >= 0 ? multiplier : 1,
        notes,
      };
    })
    .filter((row) => row.shopifySku || row.shopifyTitle || row.netsuiteItem || row.netsuiteName);
}

function mappingSummary(mappings) {
  const active = mappings.filter((mapping) => mapping.active);
  return {
    total: mappings.length,
    active: active.length,
    shopifySkus: new Set(active.map((mapping) => normalizeKey(mapping.shopifySku)).filter(Boolean)).size,
    netsuiteItems: new Set(active.map((mapping) => normalizeKey(mapping.netsuiteItem)).filter(Boolean)).size,
  };
}

async function buildShopifySourceMappingResponse(input, dependencies = {}) {
  const today = formatDate(new Date());
  const startDate = validateDate(input.startDate || startOfWeek(today));
  const endDate = validateDate(input.endDate || today);

  if (startDate > endDate) {
    throw httpError(400, 'Start date must be before or equal to end date');
  }

  const status = dependencies.status || configStatus();
  const mappingState = dependencies.mappingState || await loadProductMappingState();
  const querySource = dependencies.queryShopifySourceRows || queryShopifySourceRows;

  if (!status.shopify?.configured && !dependencies.queryShopifySourceRows) {
    throw httpError(400, 'Shopify credentials are not configured');
  }

  let shopifyRows;
  try {
    shopifyRows = await querySource(startDate, endDate);
  } catch {
    throw httpError(502, 'Unable to retrieve Shopify SKUs for the selected period.');
  }

  const merged = mergeShopifySourceMappings(shopifyRows, mappingState.mappings);
  const allMappings = [...merged.mappings, ...merged.preservedMappings];

  return {
    ...mappingState,
    mappings: merged.mappings,
    preservedMappings: merged.preservedMappings,
    summary: mappingSummary(allMappings),
    sourceSummary: {
      startDate,
      endDate,
      total: merged.sources.length,
      active: merged.mappings.filter((mapping) => mapping.active).length,
      netSales: roundMoney(merged.sources.reduce((total, source) => total + numberFrom(source.shopifyNetSales), 0)),
      itemUnits: merged.sources.reduce((total, source) => total + numberFrom(source.shopifyItemUnits), 0),
      orders: merged.sources.reduce((total, source) => total + numberFrom(source.orders), 0),
      generatedAt: new Date().toISOString(),
    },
  };
}

async function queryShopifySourceRows(startDate, endDate) {
  const query = `
FROM sales
SHOW
  net_sales,
  net_items_sold,
  orders
WHERE line_type = 'product'
GROUP BY
  product_title_at_time_of_sale,
  product_variant_sku_at_time_of_sale
SINCE ${startDate}
UNTIL ${endDate}
ORDER BY net_sales DESC
`;

  return collectShopifyQLRows(query);
}

function mergeShopifySourceMappings(shopifyRows, existingMappings) {
  const sourceRows = buildShopifySourceRows(shopifyRows);
  const lookup = buildExistingMappingLookup(existingMappings);
  const matchedMappingIds = new Set();
  const mappings = [];

  sourceRows.forEach((source, sourceIndex) => {
    const existingMatches = existingMappingsForSource(source, lookup);

    if (!existingMatches.length) {
      mappings.push(newMappingFromShopifySource(source, sourceIndex));
      return;
    }

    existingMatches.forEach((existing) => {
      matchedMappingIds.add(String(existing.id || ''));
      mappings.push(mappingFromShopifySource(source, existing));
    });
  });

  const preservedMappings = existingMappings
    .filter((mapping) => !matchedMappingIds.has(String(mapping.id || '')))
    .map((mapping) => ({ ...mapping, source: 'saved' }));

  return { mappings, preservedMappings, sources: sourceRows };
}

function buildShopifySourceRows(rows) {
  const bySource = new Map();

  for (const row of rows || []) {
    const sku = normalizeKey(
      row.product_variant_sku_at_time_of_sale ??
        row.product_variant_sku ??
        row['Product variant SKU at time of sale']
    );
    const title = text(
      row.product_title_at_time_of_sale ??
        row.product_title ??
        row['Product title at time of sale']
    );
    const identity = shopifySourceIdentity(sku, title);

    if (!identity) continue;

    const current = bySource.get(identity) || {
      shopifySku: sku,
      shopifyTitle: title,
      shopifyNetSales: 0,
      shopifyItemUnits: 0,
      orders: 0,
    };

    current.shopifyNetSales += numberFrom(row.net_sales ?? row.netSales ?? row['Net sales']);
    current.shopifyItemUnits += numberFrom(row.net_items_sold ?? row.netItemsSold ?? row['Net items sold']);
    current.orders += numberFrom(row.orders ?? row.Orders);
    bySource.set(identity, current);
  }

  return [...bySource.values()].sort((left, right) => {
    const salesDifference = numberFrom(right.shopifyNetSales) - numberFrom(left.shopifyNetSales);
    if (salesDifference) return salesDifference;
    return (left.shopifySku || left.shopifyTitle).localeCompare(right.shopifySku || right.shopifyTitle);
  });
}

function buildExistingMappingLookup(mappings) {
  const byShopifySku = new Map();
  const byShopifyTitle = new Map();

  for (const mapping of mappings || []) {
    pushLookupValue(byShopifySku, normalizeKey(mapping.shopifySku), mapping);
    pushLookupValue(byShopifyTitle, normalizeTextKey(mapping.shopifyTitle), mapping);
  }

  return { byShopifySku, byShopifyTitle };
}

function existingMappingsForSource(source, lookup) {
  const matches = [];
  const seen = new Set();
  const skuKey = normalizeKey(source.shopifySku);
  const titleKey = normalizeTextKey(source.shopifyTitle);

  for (const mapping of lookup.byShopifySku.get(skuKey) || []) {
    pushUniqueMapping(matches, seen, mapping);
  }

  for (const mapping of lookup.byShopifyTitle.get(titleKey) || []) {
    pushUniqueMapping(matches, seen, mapping);
  }

  return matches;
}

function mappingFromShopifySource(source, existing) {
  return {
    ...existing,
    shopifySku: existing.shopifySku || source.shopifySku,
    shopifyTitle: source.shopifyTitle || existing.shopifyTitle,
    source: 'shopify',
    shopifyNetSales: roundMoney(source.shopifyNetSales),
    shopifyItemUnits: source.shopifyItemUnits,
    orders: source.orders,
  };
}

function newMappingFromShopifySource(source, index) {
  return {
    id: `shopify-${slugifyId(source.shopifySku || source.shopifyTitle || `row-${index + 1}`)}`,
    active: false,
    shopifySku: source.shopifySku,
    shopifyTitle: source.shopifyTitle,
    netsuiteItem: '',
    netsuiteName: '',
    candleUnitsPerNetSuiteUnit: guessCandleUnitFactorFromText(source.shopifySku, source.shopifyTitle),
    notes: '',
    source: 'shopify',
    shopifyNetSales: roundMoney(source.shopifyNetSales),
    shopifyItemUnits: source.shopifyItemUnits,
    orders: source.orders,
  };
}

function pushLookupValue(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function pushUniqueMapping(target, seen, mapping) {
  const id = String(mapping.id || '');
  const key = id || `${normalizeKey(mapping.shopifySku)}|${normalizeKey(mapping.netsuiteItem)}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push(mapping);
}

function shopifySourceIdentity(sku, title) {
  const skuKey = normalizeKey(sku);
  if (skuKey) return `sku:${skuKey}`;

  const titleKey = normalizeTextKey(title);
  return titleKey ? `title:${titleKey}` : '';
}

function guessCandleUnitFactorFromText(sku, title) {
  const value = `${text(sku)} ${text(title)}`.toUpperCase();

  if (/\b(SAMPLE|SAMPLES|SAMPLER|2OZ|2 OZ|2-?OUNCE|TEALIGHT|WAX MELT|GIFT CARD)\b/.test(value)) {
    return 0;
  }

  if (/\b(SUB BOX|SUBSCRIPTION BOX|MONTH SUB|MONTHLY SUB)\b/.test(value)) {
    return 0;
  }

  const bundleMatch =
    value.match(/\bBUNDLE(?:\s+OF)?\s+(TEN|NINE|EIGHT|SEVEN|SIX|FIVE|FOUR|THREE|TWO|ONE|\d{1,2})\b/) ||
    value.match(/\b(TEN|NINE|EIGHT|SEVEN|SIX|FIVE|FOUR|THREE|TWO|ONE|\d{1,2})\s*(?:PACK|PK)\b/);

  if (bundleMatch) {
    return wordOrNumber(bundleMatch[1]);
  }

  return 1;
}

function wordOrNumber(value) {
  const words = {
    ONE: 1,
    TWO: 2,
    THREE: 3,
    FOUR: 4,
    FIVE: 5,
    SIX: 6,
    SEVEN: 7,
    EIGHT: 8,
    NINE: 9,
    TEN: 10,
  };
  const normalized = normalizeKey(value);
  return words[normalized] || numberFrom(normalized) || 1;
}

function slugifyId(value) {
  const slug = text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (slug) return slug;
  return crypto.createHash('sha1').update(text(value)).digest('hex').slice(0, 8);
}

function roundMoney(value) {
  return Math.round(numberFrom(value) * 100) / 100;
}

function buildMappingIndex(mappings) {
  const active = mappings.filter((mapping) => mapping.active);
  const shopifySkus = new Set();
  const shopifyTitles = new Set();
  const shopifyMultipliers = new Map();
  const shopifyTitleMultipliers = new Map();
  const netsuiteItems = new Set();
  const netsuiteMultipliers = new Map();

  for (const mapping of active) {
    const shopifySku = normalizeKey(mapping.shopifySku);
    const shopifyTitle = normalizeTextKey(mapping.shopifyTitle);
    const netsuiteItem = normalizeKey(mapping.netsuiteItem);
    const multiplier = numberFrom(mapping.candleUnitsPerNetSuiteUnit);

    if (shopifySku) {
      shopifySkus.add(shopifySku);
      shopifyMultipliers.set(shopifySku, Math.max(multiplier, shopifyMultipliers.get(shopifySku) ?? 0));
    } else if (shopifyTitle) {
      shopifyTitles.add(shopifyTitle);
      shopifyTitleMultipliers.set(shopifyTitle, Math.max(multiplier, shopifyTitleMultipliers.get(shopifyTitle) ?? 0));
    }
    if (netsuiteItem) {
      netsuiteItems.add(netsuiteItem);
      netsuiteMultipliers.set(netsuiteItem, Math.max(multiplier, netsuiteMultipliers.get(netsuiteItem) ?? 0));
    }
  }

  return {
    activeCount: active.length,
    shopifySkus,
    shopifyTitles,
    shopifyMultipliers,
    shopifyTitleMultipliers,
    netsuiteItems,
    netsuiteMultipliers,
  };
}

async function buildAspResponse(input, dependencies = {}) {
  const today = formatDate(new Date());
  const startDate = validateDate(input.startDate || startOfWeek(today));
  const endDate = validateDate(input.endDate || today);
  const granularity = normalizeGranularity(input.granularity);

  if (startDate > endDate) {
    throw httpError(400, 'Start date must be before or equal to end date');
  }

  const periods = buildPeriods(startDate, endDate, granularity);
  const status = dependencies.status || configStatus();
  const mappingState = dependencies.mappingState || await loadProductMappingState();
  const mappingIndex = buildMappingIndex(mappingState.mappings);
  const demoMode = dependencies.demoMode ?? resolveDemoMode(status);
  const queryShopify = dependencies.queryShopifyMappedMetrics || queryShopifyMappedMetrics;
  const queryNetSuiteUnits = dependencies.queryNetSuiteMappedCandleUnits || queryNetSuiteMappedCandleUnits;

  if (demoMode) {
    const rows = buildDemoRows(periods);
    return withSummary({
      status: 'success',
      dataMode: 'demo',
      generatedAt: new Date().toISOString(),
      config: status,
      mappings: mappingSummary(mappingState.mappings),
      errors: [],
      rows,
    });
  }

  if (!status.shopify?.configured) {
    throw httpError(400, 'Shopify credentials are not configured');
  }

  if (!status.netsuite?.configured) {
    throw httpError(400, 'NetSuite credentials are not configured');
  }

  const rows = [];

  for (const period of periods) {
    const shopify = await readShopifyAspMetrics(period, mappingIndex, queryShopify);
    const netsuite = await readNetSuiteAspUnits(period, mappingIndex, queryNetSuiteUnits);
    rows.push({
      ...period,
      netSales: shopify.netSales,
      unitsSold: netsuite.candleUnits,
      shopifyItemUnits: shopify.itemUnits,
      netSuiteCandleUnits: netsuite.candleUnits,
      netSuiteRawQuantity: netsuite.rawQuantity,
      orders: shopify.orders,
      inventoryUnits: netsuite.candleUnits,
      mappedShopifyRows: shopify.mappedRows,
      unmappedShopifyRows: shopify.unmappedRows,
      mappedNetSuiteRows: netsuite.mappedRows,
      unmappedNetSuiteRows: netsuite.unmappedRows,
      asp: divide(shopify.netSales, netsuite.candleUnits),
      salesPerInventoryUnit: 0,
    });
  }

  return withSummary({
    status: 'success',
    dataMode: 'live',
    generatedAt: new Date().toISOString(),
    config: status,
    mappings: mappingSummary(mappingState.mappings),
    errors: [],
    rows,
  });
}

function configStatus() {
  const shop = normalizeShopifyShop(env.SHOPIFY_SHOP || '');
  const hasShopifyToken = Boolean(text(env.SHOPIFY_ACCESS_TOKEN));
  const hasShopifyClientCredentials = Boolean(text(env.SHOPIFY_CLIENT_ID) && text(env.SHOPIFY_CLIENT_SECRET));
  const netSuiteAuthMode = normalizeNetSuiteAuthMode();
  const hasNetSuiteAccount = Boolean(text(env.NETSUITE_ACCOUNT_ID));
  const hasOAuth2Bearer = Boolean(text(env.NETSUITE_OAUTH2_ACCESS_TOKEN));
  const hasOAuth2Jwt = Boolean(
    text(env.NETSUITE_CLIENT_ID) &&
      text(env.NETSUITE_CERTIFICATE_ID) &&
      text(env.NETSUITE_PRIVATE_KEY_PATH)
  );
  const hasTba = Boolean(
    text(env.NETSUITE_CONSUMER_KEY) &&
      text(env.NETSUITE_CONSUMER_SECRET) &&
      text(env.NETSUITE_TOKEN_ID) &&
      text(env.NETSUITE_TOKEN_SECRET)
  );

  return {
    shopify: {
      configured: Boolean(shop && (hasShopifyToken || hasShopifyClientCredentials)),
      shop,
      auth: hasShopifyToken ? 'access_token' : hasShopifyClientCredentials ? 'client_credentials' : 'missing',
      apiVersion: text(env.SHOPIFY_API_VERSION) || '2026-07',
    },
    netsuite: {
      configured: Boolean(
        hasNetSuiteAccount &&
          ((netSuiteAuthMode === 'oauth2_jwt' && hasOAuth2Jwt) ||
            (netSuiteAuthMode === 'oauth2_bearer' && hasOAuth2Bearer) ||
            (netSuiteAuthMode === 'tba' && hasTba))
      ),
      accountId: hasNetSuiteAccount ? maskAccountId(env.NETSUITE_ACCOUNT_ID) : '',
      auth: netSuiteAuthMode,
    },
    demoMode: text(env.DEMO_MODE) || 'auto',
  };
}

function resolveDemoMode(status) {
  const setting = String(status.demoMode || 'auto').toLowerCase();
  if (setting === 'true') return true;
  if (setting === 'false') return false;
  return !(status.shopify.configured && status.netsuite.configured);
}

function withSummary(payload) {
  const rows = payload.rows;
  const netSales = rows.reduce((total, row) => total + row.netSales, 0);
  const unitsSold = rows.reduce((total, row) => total + row.unitsSold, 0);
  const shopifyItemUnits = rows.reduce((total, row) => total + (row.shopifyItemUnits || 0), 0);
  const orders = rows.reduce((total, row) => total + row.orders, 0);
  const mappedShopifyRows = rows.reduce((total, row) => total + (row.mappedShopifyRows || 0), 0);
  const mappedNetSuiteRows = rows.reduce((total, row) => total + (row.mappedNetSuiteRows || 0), 0);

  return {
    ...payload,
    summary: {
      netSales,
      unitsSold,
      shopifyItemUnits,
      orders,
      inventoryUnits: unitsSold,
      mappedShopifyRows,
      mappedNetSuiteRows,
      asp: divide(netSales, unitsSold),
      salesPerInventoryUnit: 0,
    },
  };
}

function buildDemoRows(periods) {
  return periods.map((period, index) => {
    const days = daysBetween(period.startDate, period.endDate) + 1;
    const netSales = Math.round((7200 + days * 685 + index * 1250) * 100) / 100;
    const unitsSold = Math.max(1, Math.round(netSales / (23.75 + index * 0.85)));
    const orders = Math.max(1, Math.round(unitsSold / 2.8));
    const inventoryUnits = Math.max(0, 5200 - index * 135);

    return {
      ...period,
      netSales,
      unitsSold,
      orders,
      inventoryUnits,
      asp: divide(netSales, unitsSold),
      salesPerInventoryUnit: divide(netSales, inventoryUnits),
    };
  });
}

async function readShopifyAspMetrics(period, mappingIndex, queryShopify) {
  try {
    return await queryShopify(period.startDate, period.endDate, mappingIndex);
  } catch {
    throw httpError(502, 'Unable to retrieve Shopify sales for the selected period.');
  }
}

async function readNetSuiteAspUnits(period, mappingIndex, queryNetSuiteUnits) {
  try {
    return await queryNetSuiteUnits(period.startDate, period.endDate, mappingIndex);
  } catch {
    throw httpError(502, 'Unable to retrieve NetSuite candle units for the selected period.');
  }
}

async function queryShopifyMappedMetrics(startDate, endDate, mappingIndex) {
  const query = `
FROM sales
SHOW
  net_sales,
  net_items_sold,
  orders
WHERE line_type = 'product'
GROUP BY
  product_title_at_time_of_sale,
  product_variant_sku_at_time_of_sale
SINCE ${startDate}
UNTIL ${endDate}
ORDER BY net_sales DESC
`;

  const rows = await collectShopifyQLRows(query);
  return summarizeShopifyRows(rows, mappingIndex);
}

async function collectShopifyQLRows(baseQuery, runQuery = runShopifyQL, pageSize = numberFrom(env.SHOPIFYQL_PAGE_SIZE) || 1000) {
  const limit = Math.max(1, Math.min(5000, Math.floor(pageSize)));
  const rows = [];
  let offset = 0;
  let pages = 0;

  while (true) {
    const result = await runQuery(`${baseQuery.trim()}\nLIMIT ${limit} OFFSET ${offset}\n`);
    const pageRows = Array.isArray(result.rows) ? result.rows : [];
    rows.push(...pageRows);

    if (pageRows.length < limit) break;

    pages += 1;
    offset += limit;
    if (pages > 100) {
      throw new Error('ShopifyQL pagination exceeded 100 pages');
    }
  }

  return rows;
}

function summarizeShopifyRows(rows, mappingIndex) {
  const hasMappingScope = mappingIndex.shopifySkus.size > 0 || mappingIndex.shopifyTitles.size > 0;
  let netSales = 0;
  let itemUnits = 0;
  let candleUnits = 0;
  let orders = 0;
  let mappedRows = 0;
  let unmappedRows = 0;

  for (const row of rows) {
    const sku = text(row.product_variant_sku_at_time_of_sale ?? row.product_variant_sku ?? row['Product variant SKU at time of sale']);
    const title = text(row.product_title_at_time_of_sale ?? row.product_title ?? row['Product title at time of sale']);
    const match = shopifyMappingMatch(sku, title, mappingIndex, hasMappingScope);

    if (!match.mapped) {
      unmappedRows += 1;
      continue;
    }

    const rowUnits = numberFrom(row.net_items_sold ?? row.netItemsSold ?? row['Net items sold']);
    mappedRows += 1;
    netSales += numberFrom(row.net_sales ?? row.netSales ?? row['Net sales']);
    itemUnits += rowUnits;
    candleUnits += rowUnits * match.multiplier;
    orders += numberFrom(row.orders ?? row.Orders);
  }

  return {
    netSales,
    itemUnits,
    candleUnits,
    orders,
    mappedRows,
    unmappedRows,
  };
}

function shopifyMappingMatch(sku, title, mappingIndex, hasMappingScope) {
  if (!hasMappingScope) return { mapped: true, multiplier: 1 };

  const skuKey = normalizeKey(sku);
  if (skuKey) {
    if (!mappingIndex.shopifySkus.has(skuKey)) return { mapped: false, multiplier: 0 };
    return {
      mapped: true,
      multiplier: mappingIndex.shopifyMultipliers.get(skuKey) ?? 1,
    };
  }

  const titleKey = normalizeTextKey(title);
  if (!titleKey || !mappingIndex.shopifyTitles.has(titleKey)) return { mapped: false, multiplier: 0 };

  return {
    mapped: true,
    multiplier: mappingIndex.shopifyTitleMultipliers.get(titleKey) ?? 1,
  };
}

async function queryNetSuiteMappedCandleUnits(startDate, endDate, mappingIndex) {
  const query = defaultNetSuiteSalesUnitsQuery(startDate, endDate);
  const response = await runNetSuiteSuiteQL(query);
  const rows = Array.isArray(response.items) ? response.items : [];
  const hasMappingScope = mappingIndex.netsuiteItems.size > 0;
  let candleUnits = 0;
  let rawQuantity = 0;
  let mappedRows = 0;
  let unmappedRows = 0;

  for (const row of rows) {
    const item = text(
      valueByCaseInsensitiveKey(row, 'netsuite_item') ??
        valueByCaseInsensitiveKey(row, 'itemid') ??
        valueByCaseInsensitiveKey(row, 'item')
    );
    const itemKey = normalizeKey(item);
    const mapped = !hasMappingScope || mappingIndex.netsuiteItems.has(itemKey);

    if (!mapped) {
      unmappedRows += 1;
      continue;
    }

    const quantity = numberFrom(
      valueByCaseInsensitiveKey(row, 'raw_quantity') ??
        valueByCaseInsensitiveKey(row, 'quantity') ??
        valueByCaseInsensitiveKey(row, 'net_suite_quantity')
    );
    const multiplier = mappingIndex.netsuiteMultipliers.has(itemKey)
      ? mappingIndex.netsuiteMultipliers.get(itemKey)
      : 1;

    mappedRows += 1;
    rawQuantity += quantity;
    candleUnits += quantity * multiplier;
  }

  return {
    candleUnits,
    rawQuantity,
    mappedRows,
    unmappedRows,
  };
}

async function runNetSuiteSuiteQL(query, limit = 1000, offset = 0) {
  const url = netSuiteSuiteQlUrl(limit, offset);
  return netSuiteFetch(url, {
    method: 'POST',
    body: JSON.stringify({ q: query }),
  });
}

async function runShopifyQL(shopifyqlQuery) {
  const shop = normalizeShopifyShop(env.SHOPIFY_SHOP || '');
  const apiVersion = text(env.SHOPIFY_API_VERSION) || '2026-07';
  const token = await getShopifyAccessToken(shop);

  const endpoint = `https://${shop}.myshopify.com/admin/api/${apiVersion}/graphql.json`;
  const graphqlQuery = `
query RunShopifyQL($query: String!) {
  shopifyqlQuery(query: $query) {
    tableData {
      columns {
        name
        dataType
        displayName
      }
      rows
    }
    parseErrors
  }
}
`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({
      query: graphqlQuery,
      variables: { query: shopifyqlQuery },
    }),
  });

  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(`Shopify GraphQL request failed with status ${response.status}: ${JSON.stringify(payload)}`);
  }

  if (payload.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(payload.errors)}`);
  }

  const result = payload.data?.shopifyqlQuery;
  if (!result) {
    throw new Error(`Shopify response did not include shopifyqlQuery: ${JSON.stringify(payload)}`);
  }

  if (result.parseErrors?.length) {
    throw new Error(`ShopifyQL parse errors: ${result.parseErrors.join('; ')}`);
  }

  const tableData = result.tableData || { columns: [], rows: [] };
  const columns = tableData.columns || [];
  const rows = normalizeTableRows(columns, tableData.rows || []);

  return { columns, rows };
}

async function getShopifyAccessToken(shop) {
  const existingToken = text(env.SHOPIFY_ACCESS_TOKEN);
  if (existingToken) return existingToken;

  if (shopifyTokenCache.token && shopifyTokenCache.expiresAt > Date.now() + 60_000) {
    return shopifyTokenCache.token;
  }

  const clientId = text(env.SHOPIFY_CLIENT_ID);
  const clientSecret = text(env.SHOPIFY_CLIENT_SECRET);

  if (!shop || !clientId || !clientSecret) {
    throw new Error('Missing Shopify shop or client credentials');
  }

  const tokenUrl = `https://${shop}.myshopify.com/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(`Shopify token request failed with status ${response.status}: ${JSON.stringify(payload)}`);
  }

  if (!payload.access_token) {
    throw new Error(`Shopify token response did not include an access token: ${JSON.stringify(payload)}`);
  }

  shopifyTokenCache.token = payload.access_token;
  shopifyTokenCache.expiresAt = Date.now() + Math.max(1, Number(payload.expires_in || 3600) - 60) * 1000;
  return shopifyTokenCache.token;
}

async function netSuiteFetch(url, options) {
  const method = options.method || 'GET';
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Prefer: 'transient',
    Authorization: await netSuiteAuthorizationHeader(method, url),
    ...(options.headers || {}),
  };

  const response = await fetch(url, {
    ...options,
    method,
    headers,
  });

  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(`NetSuite request failed with status ${response.status}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function netSuiteAuthorizationHeader(method, url) {
  const authMode = normalizeNetSuiteAuthMode();

  if (authMode === 'oauth2_jwt') {
    const token = await getNetSuiteJwtAccessToken();
    return `Bearer ${token}`;
  }

  if (authMode === 'oauth2_bearer') {
    const token = text(env.NETSUITE_OAUTH2_ACCESS_TOKEN);
    if (!token) throw new Error('Missing NetSuite OAuth 2.0 access token');
    return `Bearer ${token}`;
  }

  return netSuiteTbaAuthorizationHeader(method, url);
}

async function getNetSuiteJwtAccessToken() {
  if (netSuiteTokenCache.token && netSuiteTokenCache.expiresAt > Date.now() + 60_000) {
    return netSuiteTokenCache.token;
  }

  const accountId = text(env.NETSUITE_ACCOUNT_ID);
  const clientId = text(env.NETSUITE_CLIENT_ID);
  const certificateId = text(env.NETSUITE_CERTIFICATE_ID);
  const privateKeyPath = text(env.NETSUITE_PRIVATE_KEY_PATH);

  if (!accountId || !clientId || !certificateId || !privateKeyPath) {
    throw new Error('Missing NetSuite OAuth 2.0 JWT client credentials');
  }

  const tokenUrl = `${netSuiteBaseUrl()}/services/rest/auth/oauth2/v1/token`;
  const now = Math.floor(Date.now() / 1000);
  const clientAssertion = signJwtPs256(
    {
      typ: 'JWT',
      alg: 'PS256',
      kid: certificateId,
    },
    {
      iss: clientId,
      scope: ['rest_webservices'],
      aud: tokenUrl,
      iat: now,
      exp: now + 300,
      jti: crypto.randomUUID(),
    },
    readNetSuitePrivateKey(privateKeyPath)
  );

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: clientAssertion,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(`NetSuite OAuth token request failed with status ${response.status}: ${JSON.stringify(payload)}`);
  }

  if (!payload.access_token) {
    throw new Error(`NetSuite OAuth token response did not include an access token: ${JSON.stringify(payload)}`);
  }

  netSuiteTokenCache.token = payload.access_token;
  netSuiteTokenCache.expiresAt = Date.now() + Math.max(1, Number(payload.expires_in || 3600) - 60) * 1000;
  return netSuiteTokenCache.token;
}

function signJwtPs256(header, payload, privateKey) {
  const signingInput = [
    base64UrlJson(header),
    base64UrlJson(payload),
  ].join('.');
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return `${signingInput}.${signature.toString('base64url')}`;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function readNetSuitePrivateKey(privateKeyPath) {
  const resolvedPath = path.isAbsolute(privateKeyPath)
    ? privateKeyPath
    : path.join(rootDir, privateKeyPath);

  if (!existsSync(resolvedPath)) {
    throw new Error(`NetSuite private key file was not found at ${privateKeyPath}`);
  }

  return readFileSync(resolvedPath, 'utf8');
}

function netSuiteTbaAuthorizationHeader(method, url) {
  const accountId = text(env.NETSUITE_ACCOUNT_ID);
  const realm = text(env.NETSUITE_REALM) || accountId;
  const oauthParams = {
    oauth_consumer_key: text(env.NETSUITE_CONSUMER_KEY),
    oauth_token: text(env.NETSUITE_TOKEN_ID),
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_version: '1.0',
  };

  for (const [key, value] of Object.entries(oauthParams)) {
    if (!value) throw new Error(`Missing NetSuite TBA value: ${key}`);
  }

  const urlObject = new URL(url);
  const baseUrl = `${urlObject.protocol}//${urlObject.host}${urlObject.pathname}`;
  const params = [];

  urlObject.searchParams.forEach((value, key) => {
    params.push([key, value]);
  });

  Object.entries(oauthParams).forEach(([key, value]) => {
    params.push([key, value]);
  });

  params.sort((left, right) => {
    const keyCompare = oauthEncode(left[0]).localeCompare(oauthEncode(right[0]));
    if (keyCompare !== 0) return keyCompare;
    return oauthEncode(left[1]).localeCompare(oauthEncode(right[1]));
  });

  const normalizedParams = params.map(([key, value]) => `${oauthEncode(key)}=${oauthEncode(value)}`).join('&');
  const baseString = [
    method.toUpperCase(),
    oauthEncode(baseUrl),
    oauthEncode(normalizedParams),
  ].join('&');
  const signingKey = `${oauthEncode(text(env.NETSUITE_CONSUMER_SECRET))}&${oauthEncode(text(env.NETSUITE_TOKEN_SECRET))}`;
  const signature = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');

  return `OAuth ${[
    ['realm', realm],
    ...Object.entries(oauthParams),
    ['oauth_signature', signature],
  ]
    .map(([key, value]) => `${oauthEncode(key)}="${oauthEncode(value)}"`)
    .join(', ')}`;
}

function netSuiteSuiteQlUrl(limit, offset) {
  return `${netSuiteBaseUrl()}/services/rest/query/v1/suiteql?limit=${limit}&offset=${offset}`;
}

function netSuiteBaseUrl() {
  const accountId = text(env.NETSUITE_ACCOUNT_ID);
  if (!accountId) throw new Error('Missing NetSuite account ID');

  const hostAccount = accountId.replace(/_/g, '-').toLowerCase();
  return `https://${hostAccount}.suitetalk.api.netsuite.com`;
}

function defaultNetSuiteSalesUnitsQuery(startDate, endDate) {
  const transactionType = escapeSuiteQLString(text(env.NETSUITE_SALES_TRANSACTION_TYPE) || 'SalesOrd');
  const externalIdPrefix = escapeSuiteQLString(text(env.NETSUITE_SALES_EXTERNAL_ID_PREFIX) || 'SHPF');
  const shopifyOrderNameRegex = escapeSuiteQLString(text(env.NETSUITE_SHOPIFY_ORDER_NAME_REGEX) || '^#[0-9]+$');

  return [
    'SELECT',
    'i.itemid AS netsuite_item,',
    'SUM(ABS(tl.quantity)) AS raw_quantity',
    'FROM transaction t',
    'JOIN transactionline tl ON tl.transaction = t.id',
    'JOIN item i ON i.id = tl.item',
    `WHERE t.trandate >= TO_DATE('${startDate}', 'YYYY-MM-DD')`,
    `AND t.trandate <= TO_DATE('${endDate}', 'YYYY-MM-DD')`,
    `AND t.type = '${transactionType}'`,
    `AND t.externalid LIKE '${externalIdPrefix}%'`,
    `AND REGEXP_LIKE(t.custbody_shopify_order_name, '${shopifyOrderNameRegex}')`,
    'AND tl.quantity IS NOT NULL',
    "AND tl.mainline = 'F'",
    "AND tl.taxline = 'F'",
    'AND tl.kitmemberof IS NULL',
    'GROUP BY i.itemid',
    'ORDER BY i.itemid',
  ].join(' ');
}

function escapeSuiteQLString(value) {
  return String(value).replace(/'/g, "''");
}

function normalizeTableRows(columns, rows) {
  if (!Array.isArray(rows)) return [];

  return rows.map((row) => {
    if (!Array.isArray(row)) return row || {};

    return row.reduce((record, value, index) => {
      const column = columns[index];
      const name = column?.name || column?.displayName || `column_${index}`;
      record[name] = value;
      return record;
    }, {});
  });
}

async function readJsonResponse(response) {
  const textBody = await response.text();
  if (!textBody) return {};

  try {
    return JSON.parse(textBody);
  } catch {
    return { raw: textBody };
  }
}

function normalizeShopifyShop(shopValue) {
  return String(shopValue || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\.myshopify\.com\/?$/i, '')
    .replace(/\/+$/g, '')
    .toLowerCase();
}

function normalizeNetSuiteAuthMode() {
  const authMode = String(env.NETSUITE_AUTH_MODE || 'oauth2').toLowerCase();

  if (authMode === 'tba') return 'tba';
  if (['oauth2_bearer', 'bearer', 'access_token'].includes(authMode)) return 'oauth2_bearer';
  if (['oauth2_jwt', 'jwt', 'client_credentials'].includes(authMode)) return 'oauth2_jwt';

  return text(env.NETSUITE_PRIVATE_KEY_PATH) || text(env.NETSUITE_CLIENT_ID)
    ? 'oauth2_jwt'
    : 'oauth2_bearer';
}

function normalizeGranularity(value) {
  const normalized = String(value || 'current_week').toLowerCase();
  if (['current_week', 'wow', 'mom'].includes(normalized)) return normalized;
  return 'current_week';
}

function buildPeriods(startDate, endDate, granularity) {
  if (granularity === 'mom') return buildMonthPeriods(startDate, endDate);
  if (granularity === 'wow') return buildWeekPeriods(startDate, endDate);

  return [
    {
      label: `${humanDate(startDate)} to ${humanDate(endDate)}`,
      startDate,
      endDate,
    },
  ];
}

function buildWeekPeriods(startDate, endDate) {
  const periods = [];
  let cursor = parseDate(startDate);
  const finalDate = parseDate(endDate);

  while (cursor <= finalDate) {
    const weekEnd = addDays(cursor, 6 - sundayDayIndex(cursor));
    const periodEnd = weekEnd < finalDate ? weekEnd : finalDate;
    periods.push({
      label: `Week of ${humanDate(formatDate(cursor))}`,
      startDate: formatDate(cursor),
      endDate: formatDate(periodEnd),
    });
    cursor = addDays(periodEnd, 1);
  }

  return periods;
}

function buildMonthPeriods(startDate, endDate) {
  const periods = [];
  let cursor = parseDate(startDate);
  const finalDate = parseDate(endDate);

  while (cursor <= finalDate) {
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const periodEnd = monthEnd < finalDate ? monthEnd : finalDate;
    periods.push({
      label: cursor.toLocaleString('en-US', { month: 'short', year: 'numeric' }),
      startDate: formatDate(cursor),
      endDate: formatDate(periodEnd),
    });
    cursor = addDays(periodEnd, 1);
  }

  return periods;
}

function startOfWeek(dateString) {
  const date = parseDate(dateString);
  return formatDate(addDays(date, -sundayDayIndex(date)));
}

function sundayDayIndex(date) {
  return date.getDay();
}

function validateDate(value) {
  const dateString = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    throw httpError(400, 'Dates must use YYYY-MM-DD format');
  }
  return dateString;
}

function parseDate(value) {
  const [year, month, day] = validateDate(value).split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function daysBetween(startDate, endDate) {
  return Math.round((parseDate(endDate) - parseDate(startDate)) / 86_400_000);
}

function humanDate(dateString) {
  return parseDate(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function numberFrom(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'object') {
    return numberFrom(value.amount ?? value.value ?? value.quantity ?? 0);
  }

  const cleaned = String(value).replace(/[$,%\s,]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function divide(numerator, denominator) {
  const top = numberFrom(numerator);
  const bottom = numberFrom(denominator);
  return bottom === 0 ? 0 : top / bottom;
}

function text(value) {
  return String(value || '').trim();
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(text(value).toLowerCase());
}

function normalizeKey(value) {
  return text(value).toUpperCase();
}

function normalizeTextKey(value) {
  return text(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b16\s*oz\s*candle\b/g, '')
    .replace(/\b16\s*oz\b/g, '')
    .replace(/\bcandle\b/g, '')
    .replace(/\bby\b.*$/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function valueByCaseInsensitiveKey(record, key) {
  const requested = key.toLowerCase();
  const match = Object.keys(record || {}).find((candidate) => candidate.toLowerCase() === requested);
  return match ? record[match] : undefined;
}

export {
  buildAspResponse,
  buildMappingIndex,
  buildPeriods,
  buildShopifySourceMappingResponse,
  collectShopifyQLRows,
  divide,
  guessCandleUnitFactorFromText,
  mergeShopifySourceMappings,
  queryShopifySourceRows,
  queryNetSuiteMappedCandleUnits,
  summarizeShopifyRows,
};

function maskAccountId(accountId) {
  const value = text(accountId);
  if (value.length <= 4) return value ? 'set' : '';
  return `${value.slice(0, 2)}...${value.slice(-2)}`;
}

function oauthEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
