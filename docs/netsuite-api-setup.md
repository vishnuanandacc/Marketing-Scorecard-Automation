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

## Inventory Query

Start with this query, then confirm the table and field names in your account's NetSuite Records Catalog:

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
