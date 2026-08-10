# ASP Calculator

One-page ASP calculator that combines Shopify sales with NetSuite inventory data.

The current formula is:

```text
ASP = Shopify net sales / Shopify net items sold
```

NetSuite inventory is shown beside ASP as the current inventory count. If you want NetSuite to be the source for sold units instead, change the SuiteQL query and denominator in `server.js`.

## Run Locally

1. Copy `.env.example` to `.env`.
2. Fill in Shopify and NetSuite credentials.
3. Start the server:

```powershell
.\start.ps1
```

Then open `http://localhost:5173`.

Without credentials, `DEMO_MODE=auto` returns demo data so the page still works.

## Shopify API Pattern

This follows the pattern from `01_monthly_channel_attribution_july_monthly_review.ipynb`:

1. Use `SHOPIFY_SHOP` as the myshopify subdomain only.
2. Request an Admin API access token from `/admin/oauth/access_token` with `grant_type=client_credentials`, `SHOPIFY_CLIENT_ID`, and `SHOPIFY_CLIENT_SECRET`.
3. Send ShopifyQL queries to `/admin/api/{SHOPIFY_API_VERSION}/graphql.json`.
4. Include the token in `X-Shopify-Access-Token`.

The app queries:

```shopifyql
FROM sales
SHOW
  net_sales,
  net_items_sold,
  orders
SINCE 2026-08-03
UNTIL 2026-08-10
```

The Shopify app needs access scopes that allow ShopifyQL reporting, including `read_reports`.

## NetSuite API Setup

The app now matches `testnetsuite.py`: OAuth 2.0 client credentials with a JWT client assertion signed by `certs/private.pem`.

Use these `.env` keys:

```text
NETSUITE_ACCOUNT_ID=1234567
NETSUITE_AUTH_MODE=oauth2_jwt
NETSUITE_CLIENT_ID=...
NETSUITE_CERTIFICATE_ID=...
NETSUITE_PRIVATE_KEY_PATH=certs/private.pem
```

See [docs/netsuite-api-setup.md](docs/netsuite-api-setup.md) for the full setup and SuiteQL query notes.

## GitHub Version Control

This project is intended to use:

```text
https://github.com/vishnuanandacc/ASP-Calculator.git
```

Useful commands:

```powershell
git status
git add .
git commit -m "Initial ASP calculator"
git push -u origin main
```

If GitHub says the remote already has commits, run:

```powershell
git pull --rebase origin main
git push -u origin main
```
