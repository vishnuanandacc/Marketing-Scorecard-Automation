import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const {
  buildAspResponse,
  buildMappingIndex,
  collectShopifyQLRows,
  divide,
  guessCandleUnitFactorFromText,
  mergeShopifySourceMappings,
  summarizeShopifyRows,
} = await import('../server.js');

function mapping(overrides) {
  return {
    active: true,
    shopifySku: '',
    shopifyTitle: '',
    netsuiteItem: '',
    netsuiteName: '',
    candleUnitsPerNetSuiteUnit: 1,
    notes: '',
    ...overrides,
  };
}

function shopifyRow(overrides) {
  return {
    product_title_at_time_of_sale: 'Mapped 16 oz candle',
    product_variant_sku_at_time_of_sale: 'A 16',
    net_sales: 0,
    net_items_sold: 0,
    orders: 1,
    ...overrides,
  };
}

function summarizeShopify(rows, mappings) {
  const mappingIndex = buildMappingIndex(mappings);
  return summarizeShopifyRows(rows, mappingIndex);
}

async function aspFrom({ shopify, netsuite, mappings = [mapping({ shopifySku: 'A 16', netsuiteItem: 'A 16' })] }) {
  return buildAspResponse(
    { startDate: '2026-08-03', endDate: '2026-08-10', granularity: 'current_week' },
    {
      demoMode: false,
      status: {
        shopify: { configured: true },
        netsuite: { configured: true },
        demoMode: 'false',
      },
      mappingState: { mappings },
      queryShopifyMappedMetrics: async () => ({
        itemUnits: 0,
        orders: 1,
        mappedRows: 1,
        unmappedRows: 0,
        ...shopify,
      }),
      queryNetSuiteMappedCandleUnits: async () => ({
        rawQuantity: netsuite.candleUnits,
        mappedRows: 1,
        unmappedRows: 0,
        ...netsuite,
      }),
    }
  );
}

test('basic ASP is Shopify net sales divided by NetSuite candle units', async () => {
  const payload = await aspFrom({
    shopify: { netSales: 1000 },
    netsuite: { candleUnits: 40 },
  });

  assert.equal(payload.summary.netSales, 1000);
  assert.equal(payload.summary.unitsSold, 40);
  assert.equal(payload.summary.asp, 25);
});

test('weighted ASP uses total Shopify dollars divided by total NetSuite units', async () => {
  const payload = await aspFrom({
    shopify: { netSales: 3500 },
    netsuite: { candleUnits: 110 },
  });

  assert.equal(payload.summary.netSales, 3500);
  assert.equal(payload.summary.unitsSold, 110);
  assert.equal(payload.summary.asp, 31.818181818181817);
});

test('discounted sales use Shopify net_sales, not list price', async () => {
  const payload = await aspFrom({
    shopify: { netSales: 24 },
    netsuite: { candleUnits: 1 },
  });

  assert.equal(payload.summary.netSales, 24);
  assert.equal(payload.summary.asp, 24);
});

test('refunds are reflected through Shopify net_sales while NetSuite supplies final units', async () => {
  const payload = await aspFrom({
    shopify: { netSales: 240 },
    netsuite: { candleUnits: 8 },
  });

  assert.equal(payload.summary.netSales, 240);
  assert.equal(payload.summary.unitsSold, 8);
  assert.equal(payload.summary.asp, 30);
});

test('2 oz Shopify revenue is excluded even when its title resembles a mapped 16 oz title', () => {
  const result = summarizeShopify(
    [
      shopifyRow({
        product_title_at_time_of_sale: 'Fall Harvest 16 oz candle',
        product_variant_sku_at_time_of_sale: 'FH 16',
        net_sales: 300,
        net_items_sold: 10,
      }),
      shopifyRow({
        product_title_at_time_of_sale: 'Fall Harvest',
        product_variant_sku_at_time_of_sale: 'FH 2',
        net_sales: 120,
        net_items_sold: 20,
      }),
    ],
    [mapping({ shopifySku: 'FH 16', shopifyTitle: 'Fall Harvest 16 oz candle' })]
  );

  assert.equal(result.netSales, 300);
  assert.equal(result.unmappedRows, 1);
});

test('subscription Shopify revenue can be included while NetSuite component units carry the denominator', async () => {
  const payload = await aspFrom({
    mappings: [mapping({ shopifySku: 'SEASONAL SUB BOX', netsuiteItem: 'SEASONAL SUB BOX', candleUnitsPerNetSuiteUnit: 0 })],
    shopify: { netSales: 320 },
    netsuite: { candleUnits: 8, rawQuantity: 1 },
  });

  assert.equal(payload.summary.netSales, 320);
  assert.equal(payload.summary.unitsSold, 8);
  assert.equal(payload.summary.asp, 40);
});

test('zero NetSuite units are protected from division by zero', () => {
  assert.equal(divide(100, 0), 0);
});

test('NetSuite unit failure fails the ASP calculation explicitly', async () => {
  await assert.rejects(
    () =>
      buildAspResponse(
        { startDate: '2026-08-03', endDate: '2026-08-10', granularity: 'current_week' },
        {
          demoMode: false,
          status: {
            shopify: { configured: true },
            netsuite: { configured: true },
            demoMode: 'false',
          },
          mappingState: {
            mappings: [mapping({ shopifySku: 'A 16', netsuiteItem: 'A 16' })],
          },
          queryShopifyMappedMetrics: async () => ({
            netSales: 1000,
            itemUnits: 40,
            orders: 12,
            mappedRows: 1,
            unmappedRows: 0,
          }),
          queryNetSuiteMappedCandleUnits: async () => {
            throw new Error('NetSuite unavailable');
          },
        }
      ),
    {
      statusCode: 502,
      message: 'Unable to retrieve NetSuite candle units for the selected period.',
    }
  );
});

test('Shopify failure returns an explicit sales-data failure', async () => {
  await assert.rejects(
    () =>
      buildAspResponse(
        { startDate: '2026-08-03', endDate: '2026-08-10', granularity: 'current_week' },
        {
          demoMode: false,
          status: {
            shopify: { configured: true },
            netsuite: { configured: true },
            demoMode: 'false',
          },
          mappingState: {
            mappings: [mapping({ shopifySku: 'A 16', netsuiteItem: 'A 16' })],
          },
          queryShopifyMappedMetrics: async () => {
            throw new Error('Shopify unavailable');
          },
          queryNetSuiteMappedCandleUnits: async () => ({
            candleUnits: 40,
            rawQuantity: 40,
            mappedRows: 1,
            unmappedRows: 0,
          }),
        }
      ),
    {
      statusCode: 502,
      message: 'Unable to retrieve Shopify sales for the selected period.',
    }
  );
});

test('ShopifyQL pagination collects more than one page', async () => {
  const calls = [];
  const rows = await collectShopifyQLRows(
    'FROM sales SHOW net_sales',
    async (query) => {
      calls.push(query);
      return {
        rows: Array.from({ length: calls.length === 1 ? 1000 : 500 }, (_, index) => ({ index })),
      };
    },
    1000
  );

  assert.equal(rows.length, 1500);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /LIMIT 1000 OFFSET 0/);
  assert.match(calls[1], /LIMIT 1000 OFFSET 1000/);
});

test('Shopify source mappings expose Shopify rows and preserve multiple NetSuite matches', () => {
  const existingMappings = [
    mapping({ id: 'bundle-a', shopifySku: 'FBS BUNDLE 4', netsuiteItem: 'FBS A 16' }),
    mapping({ id: 'bundle-b', shopifySku: 'FBS BUNDLE 4', netsuiteItem: 'FBS B 16' }),
    mapping({ id: 'old', shopifySku: 'OLD 16', netsuiteItem: 'OLD 16' }),
  ];

  const result = mergeShopifySourceMappings(
    [
      shopifyRow({
        product_title_at_time_of_sale: 'FBS Bundle 4',
        product_variant_sku_at_time_of_sale: 'FBS BUNDLE 4',
        net_sales: 320,
        net_items_sold: 8,
        orders: 4,
      }),
    ],
    existingMappings
  );

  assert.equal(result.sources.length, 1);
  assert.equal(result.mappings.length, 2);
  assert.deepEqual(result.mappings.map((row) => row.netsuiteItem), ['FBS A 16', 'FBS B 16']);
  assert.equal(result.preservedMappings.length, 1);
  assert.equal(result.preservedMappings[0].id, 'old');
});

test('new Shopify source mappings are inactive with a suggested bundle unit count', () => {
  const result = mergeShopifySourceMappings(
    [
      shopifyRow({
        product_title_at_time_of_sale: 'Pumpkin Bundle 4',
        product_variant_sku_at_time_of_sale: 'PUMPKIN BUNDLE 4',
        net_sales: 160,
        net_items_sold: 4,
      }),
    ],
    []
  );

  assert.equal(result.mappings.length, 1);
  assert.equal(result.mappings[0].active, false);
  assert.equal(result.mappings[0].shopifySku, 'PUMPKIN BUNDLE 4');
  assert.equal(result.mappings[0].candleUnitsPerNetSuiteUnit, 4);
  assert.equal(guessCandleUnitFactorFromText('SAMPLE PACK', ''), 0);
});
