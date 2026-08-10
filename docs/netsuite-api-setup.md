# NetSuite API Setup

Use NetSuite SuiteTalk REST Web Services and SuiteQL for this project. Oracle recommends OAuth 2.0 for new REST integrations; Token-Based Authentication is included as a fallback because many existing NetSuite integrations still use it.

Official references:

- [Overview of SuiteTalk REST Web Services](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_1540391670.html)
- [Setting Up Authentication](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0627022005.html)
- [OAuth 2.0 for REST Web Services](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157780312610.html)
- [REST Web Services URL Schema and Account-Specific URLs](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1546938065.html)
- [Executing SuiteQL Queries Through REST Web Services](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157909186990.html)

## Recommended Path: OAuth 2.0

1. In NetSuite, go to `Setup > Company > Enable Features`.
2. On the SuiteCloud subtab, enable `REST Web Services`.
3. Enable OAuth 2.0 if it is not already enabled.
4. Create an integration record for this app.
5. Note the OAuth client ID and client secret.
6. Complete the OAuth authorization flow for a NetSuite user/role that can read the item and inventory records needed by SuiteQL.
7. Put the resulting access token in `.env`:

```text
NETSUITE_ACCOUNT_ID=1234567_SB1
NETSUITE_AUTH_MODE=oauth2
NETSUITE_OAUTH2_ACCESS_TOKEN=...
```

NetSuite REST requests then use:

```http
Authorization: Bearer <access token>
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

## Inventory Query

Start with this query, then confirm the table and field names in your account's NetSuite Records Catalog:

```sql
SELECT
  i.itemid AS sku,
  SUM(b.quantityavailable) AS quantity_available,
  SUM(b.quantityonhand) AS quantity_on_hand
FROM inventorybalance b
JOIN item i ON i.id = b.item
WHERE i.isinactive = 'F'
GROUP BY i.itemid
ORDER BY i.itemid
```

Put your final query on one line in `.env`:

```text
NETSUITE_SUITEQL_INVENTORY_QUERY=SELECT i.itemid AS sku, SUM(b.quantityavailable) AS quantity_available, SUM(b.quantityonhand) AS quantity_on_hand FROM inventorybalance b JOIN item i ON i.id = b.item WHERE i.isinactive = 'F' GROUP BY i.itemid ORDER BY i.itemid
```

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
