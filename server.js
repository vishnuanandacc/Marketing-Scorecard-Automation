import crypto from 'node:crypto';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = __dirname;
const publicDir = path.join(rootDir, 'public');
const env = { ...process.env, ...loadEnv(path.join(rootDir, '.env')) };
const port = Number(env.PORT || 5173);

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

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        config: configStatus(),
      });
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

server.listen(port, () => {
  console.log(`ASP Calculator running at http://localhost:${port}`);
});

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

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  let raw = '';

  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) {
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

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function buildAspResponse(input) {
  const today = formatDate(new Date());
  const startDate = validateDate(input.startDate || startOfWeek(today));
  const endDate = validateDate(input.endDate || today);
  const granularity = normalizeGranularity(input.granularity);

  if (startDate > endDate) {
    throw httpError(400, 'Start date must be before or equal to end date');
  }

  const periods = buildPeriods(startDate, endDate, granularity);
  const status = configStatus();
  const demoMode = resolveDemoMode(status);

  if (demoMode) {
    const rows = buildDemoRows(periods);
    return withSummary({
      dataMode: 'demo',
      generatedAt: new Date().toISOString(),
      config: status,
      rows,
    });
  }

  if (!status.shopify.configured) {
    throw httpError(400, 'Shopify credentials are not configured');
  }

  if (!status.netsuite.configured) {
    throw httpError(400, 'NetSuite credentials are not configured');
  }

  const inventory = await queryNetSuiteInventory();
  const rows = [];

  for (const period of periods) {
    const shopify = await queryShopifyMetrics(period.startDate, period.endDate);
    rows.push({
      ...period,
      netSales: shopify.netSales,
      unitsSold: shopify.unitsSold,
      orders: shopify.orders,
      inventoryUnits: inventory.totalQuantity,
      asp: divide(shopify.netSales, shopify.unitsSold),
      salesPerInventoryUnit: divide(shopify.netSales, inventory.totalQuantity),
    });
  }

  return withSummary({
    dataMode: 'live',
    generatedAt: new Date().toISOString(),
    config: status,
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
      hasInventoryQuery: Boolean(text(env.NETSUITE_SUITEQL_INVENTORY_QUERY)),
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
  const orders = rows.reduce((total, row) => total + row.orders, 0);
  const latestInventory = rows.length ? rows[rows.length - 1].inventoryUnits : 0;

  return {
    ...payload,
    summary: {
      netSales,
      unitsSold,
      orders,
      inventoryUnits: latestInventory,
      asp: divide(netSales, unitsSold),
      salesPerInventoryUnit: divide(netSales, latestInventory),
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

async function queryShopifyMetrics(startDate, endDate) {
  const query = `
FROM sales
SHOW
  net_sales,
  net_items_sold,
  orders
SINCE ${startDate}
UNTIL ${endDate}
`;

  const result = await runShopifyQL(query);
  const row = result.rows[0] || {};

  return {
    netSales: numberFrom(row.net_sales ?? row.netSales ?? row['Net sales']),
    unitsSold: numberFrom(row.net_items_sold ?? row.netItemsSold ?? row['Net items sold']),
    orders: numberFrom(row.orders ?? row.Orders),
  };
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

async function queryNetSuiteInventory() {
  const query = text(env.NETSUITE_SUITEQL_INVENTORY_QUERY) || defaultNetSuiteInventoryQuery();
  const url = netSuiteSuiteQlUrl(1000, 0);
  const response = await netSuiteFetch(url, {
    method: 'POST',
    body: JSON.stringify({ q: query }),
  });

  const items = Array.isArray(response.items) ? response.items : [];
  const totalQuantity = items.reduce((total, item) => {
    const quantity =
      valueByCaseInsensitiveKey(item, 'quantity_available') ??
      valueByCaseInsensitiveKey(item, 'quantity_on_hand') ??
      valueByCaseInsensitiveKey(item, 'quantityavailable') ??
      valueByCaseInsensitiveKey(item, 'quantityonhand') ??
      valueByCaseInsensitiveKey(item, 'inventory_count') ??
      valueByCaseInsensitiveKey(item, 'quantity') ??
      0;

    return total + numberFrom(quantity);
  }, 0);

  return { totalQuantity, items };
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

function defaultNetSuiteInventoryQuery() {
  return [
    'SELECT itemid AS sku,',
    'quantityavailable AS quantity_available,',
    'quantityonhand AS quantity_on_hand',
    'FROM item',
    "WHERE isinactive = 'F'",
    'ORDER BY itemid',
  ].join(' ');
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
    const weekEnd = addDays(cursor, 6 - mondayDayIndex(cursor));
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
  return formatDate(addDays(date, -mondayDayIndex(date)));
}

function mondayDayIndex(date) {
  return (date.getDay() + 6) % 7;
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

function valueByCaseInsensitiveKey(record, key) {
  const requested = key.toLowerCase();
  const match = Object.keys(record || {}).find((candidate) => candidate.toLowerCase() === requested);
  return match ? record[match] : undefined;
}

function maskAccountId(accountId) {
  const value = text(accountId);
  if (value.length <= 4) return value ? 'set' : '';
  return `${value.slice(0, 2)}...${value.slice(-2)}`;
}

function oauthEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
