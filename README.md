# Are my third parties green? Cloudflare Worker

This Cloudflare Workers powers the [Are my third parties green?](https://amtpg.run) online checking tool.

![](https://aremythirdpartiesgreen.com/ogimage.jpg)

This project relies on:

- Cloudflare [Workers](https://developers.cloudflare.com/workers/)
- Cloudflare [Browser Rendering](https://developers.cloudflare.com/browser-rendering/)
- Cloudflare [Radar API](https://developers.cloudflare.com/api/resources/radar/)
- The [Third Party Web](https://github.com/patrickhulce/third-party-web/) project
- The [Green Web Foundation's Greencheck API](https://www.thegreenwebfoundation.org/)

## Getting started

1. Clone this repository.
2. Install dependencies using your package manager (for example, `npm install`).
3. Create the `.env` file (see below).
4. Run the worker locally with `npx wrangler dev`.

## Environment variables

Create a `.env` file in the project root with the following variable:

- `CF_RADAR_API=your_api_token_here`

### How to obtain a CF Radar API key

1. Sign in to the Cloudflare dashboard.
2. Go to **My Profile → API Tokens** and create a new token.
3. Grant the token access to the Radar API (see the [Cloudflare Radar API docs](https://developers.cloudflare.com/api/resources/radar/) for the exact permissions required).
4. Copy the token value and set it as `CF_RADAR_API` in your `.env` file.

## Workers KV

This project also uses Cloudflare Workers KV stores to cache checks for 7 days. This reduces resources from repeated checks on the same URL. To setup caching, you should:

1. [Create a new Workers KV](https://developers.cloudflare.com/api/resources/radar/) called `CACHE`. If you change this name, be sure to update it throughout the code.
2. Update the `wrangler.jsonc` file with your KV binding details.

## Run in development

From the repository root, start the local worker with:

- `npx wrangler dev`

This will start a local development server (http://localhost) and load environment variables from your `.env` file.

### Running a scan

To run a scan, you should pass a website `url` as a query parameter. For example: `http://localhost?url=http://example.com`.

To prevent cached results from being returned, you can also use the `nocache=true` parameter. For example: `http://localhost?url=http://example.com&nocache=true`.

## Deploying to production

1. Make sure Wrangler is authenticated with your Cloudflare account: `npx wrangler login`.
2. Set the Radar API token as a secret for production (do not commit `.env` to git):
   - `npx wrangler secret put CF_RADAR_API`
3. Update routes/paths in `wrangler.jsonc` under `routes` to match your production endpoints. Each entry includes:
   - `pattern`: the URL pattern (for example, `api.example.com/v1/*`)
   - `zone_name`: the Cloudflare zone (for example, `example.com`)
4. Deploy the Worker using `npx wrangler deploy`
