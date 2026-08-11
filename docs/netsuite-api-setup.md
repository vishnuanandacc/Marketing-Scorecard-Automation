# NetSuite API Setup

Use NetSuite SuiteTalk REST Web Services and SuiteQL for this project. This repo is configured to match `testnetsuite.py`: OAuth 2.0 client credentials with a short-lived JWT client assertion signed by the NetSuite certificate/private key.

Official references:

- [Overview of SuiteTalk REST Web Services](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_1540391670.html)
- [Setting Up Authentication](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0627022005.html)
- [OAuth 2.0 for REST Web Services](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157780312610.html)
- [REST Web Services URL Schema and Account-Specific URLs](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1546938065.html)
- [Executing SuiteQL Queries Through REST Web Services](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157909186990.html)

## Recommended Path: OAuth 2.0 JWT Client Credentials

1. In NetSuite, go to `Setup > Company > Enable Features`.
2. On the SuiteCloud subtab, enable `REST Web Services`.
3. Enable OAuth 2.0 if it is not already enabled.
4. Create an integration record for this app.
5. Add/upload the public certificate to the integration and note the certificate ID.
6. Note the OAuth client ID.
7. Make sure the integration role can access REST Web Services and the item/inventory records needed by SuiteQL.
8. Keep the private key file local only, for example `certs/private.pem`.
9. Put the non-secret identifiers and private key path in `.env`:

```text
NETSUITE_ACCOUNT_ID=1234567
NETSUITE_AUTH_MODE=oauth2_jwt
NETSUITE_CLIENT_ID=...
NETSUITE_CERTIFICATE_ID=...
NETSUITE_PRIVATE_KEY_PATH=certs/private.pem
```

The app will:

1. Build a JWT with `iss`, `scope`, `aud`, `iat`, `exp`, and `jti`.
2. Sign it with `PS256`, using `kid` as the certificate ID.
3. Request an access token from:

```text
https://<account-id>.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token
```

4. Use that short-lived token on REST and SuiteQL requests:

```http
Authorization: Bearer <access token>
```

## Optional Path: Static Bearer Token

For one-off testing only, you can provide a pre-generated bearer token:

```text
NETSUITE_ACCOUNT_ID=1234567
NETSUITE_AUTH_MODE=oauth2_bearer
NETSUITE_OAUTH2_ACCESS_TOKEN=...
```

## Fallback Path: Token-Based Authentication

Oracle's docs warn that as of NetSuite 2027.1, new TBA integrations cannot be created for SOAP web services, REST web services, and RESTlets. Existing integrations continue working. Use this path mainly if your NetSuite account already has TBA available.

1. In NetSuite, enable `REST Web Services` and `Token-Based Authentication`.
2. Create an integration record that supports TBA.
3. Note the consumer key and consumer secret.
4. Create or customize a role with the needed record permissions, plus token permissions such as `User Access Tokens` or `Log in using Access Tokens`.
5. Assign the role to the integration user.
6. Create an access token for that user, role, and integration record.
7. Put the values in `.env`:

```text
NETSUITE_ACCOUNT_ID=1234567_SB1
NETSUITE_AUTH_MODE=tba
NETSUITE_CONSUMER_KEY=...
NETSUITE_CONSUMER_SECRET=...
NETSUITE_TOKEN_ID=...
NETSUITE_TOKEN_SECRET=...
```

The app signs REST requests with OAuth 1.0 and `HMAC-SHA256`.

## SuiteQL Endpoint

The REST SuiteQL endpoint is:

```text
POST https://<account-id>.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql?limit=1000&offset=0
```

Required headers:

```http
Content-Type: application/json
Accept: application/json
Prefer: transient
Authorization: Bearer <access token>
```

Body:

```json
{
  "q": "SELECT id, itemid FROM item FETCH FIRST 10 ROWS ONLY"
}
```

## Sales-Order Unit Query

ASP uses Shopify revenue as the numerator and NetSuite sales-order item quantities as the denominator. The app groups NetSuite `SalesOrd` transaction lines by item and applies the editable product mapping's `candleUnitsPerNetSuiteUnit` factor.

The ASP scope is 16oz candles only, including 16oz candles sold through bundles and subscription/sub boxes. Sample packs and 2oz candles are intentionally excluded. For sub boxes, keep the Shopify sub-box SKU included so its revenue counts, but keep the NetSuite parent item factor at `0`; the individual component candle lines carry the denominator units.

Default filters:

```text
NETSUITE_SALES_TRANSACTION_TYPE=SalesOrd
NETSUITE_SALES_EXTERNAL_ID_PREFIX=SHPF
NETSUITE_SHOPIFY_ORDER_NAME_REGEX=^#[0-9]+$
```

`SHPF` matches Shopify-originated NetSuite orders like the manual workbook's `External ID` values. The order-name regex keeps the NetSuite denominator aligned to standard numeric Shopify orders like `#734990` and excludes nonstandard exchange/tester order-name flows. The query also excludes `transactionline.kitmemberof` rows so kit/component members are not double-counted; bundle parent items carry the mapped candle factor.

The generated SuiteQL shape is:

```sql
SELECT
  i.itemid AS netsuite_item,
  SUM(ABS(tl.quantity)) AS raw_quantity
FROM transaction t
JOIN transactionline tl ON tl.transaction = t.id
JOIN item i ON i.id = tl.item
WHERE t.trandate >= TO_DATE('2026-07-01', 'YYYY-MM-DD')
  AND t.trandate <= TO_DATE('2026-07-07', 'YYYY-MM-DD')
  AND t.type = 'SalesOrd'
  AND t.externalid LIKE 'SHPF%'
  AND REGEXP_LIKE(t.custbody_shopify_order_name, '^#[0-9]+$')
  AND tl.quantity IS NOT NULL
  AND tl.mainline = 'F'
  AND tl.taxline = 'F'
  AND tl.kitmemberof IS NULL
GROUP BY i.itemid
ORDER BY i.itemid
```

## On-Hand Inventory Query

The on-hand query is retained as a diagnostic/reference query, but it is no longer the ASP denominator.

```sql
SELECT
  SUM(item.totalquantityonhand) AS quantity_on_hand
FROM item
WHERE item.isinactive = 'F'
```

Put your final query on one line in `.env`:

```text
NETSUITE_SUITEQL_INVENTORY_QUERY=SELECT SUM(item.totalquantityonhand) AS quantity_on_hand FROM item WHERE item.isinactive = 'F'
```

In this account, unqualified `quantityavailable` returned `Unknown identifier 'quantityavailable'`. Qualifying it as `item.quantityavailable` works, but it currently returns `0` for the sampled items. `item.totalquantityonhand` is the better starting inventory count. The default query uses `SUM(...)` so the app does not undercount by only summing the first paged result set. If the app can authenticate but the query returns `Record 'item' was not found` or `INSUFFICIENT_PERMISSIONS`, update the NetSuite integration role. Grant at least view access to item records, and add location/inventory permissions if you move the query to location-level balances.

## First API Test

After `.env` is filled in:

```powershell
.\start.ps1
```

Open:

```text
http://localhost:5173/api/health
```

Then run the page at:

```text
http://localhost:5173
```

If the NetSuite query fails, first test a very small SuiteQL query in Postman:

```sql
SELECT id, itemid FROM item FETCH FIRST 10 ROWS ONLY
```

Once that works, switch back to the inventory query and adjust field names from the Records Catalog.
