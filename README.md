# Elder Link Daily

The iPad companion app at https://elderlinkdaily.com.

- `public/` holds the site: `index.html` (the whole app), `manifest.json` and the icons.
- `wrangler.jsonc` tells Cloudflare to serve `public/` from the Worker `super-violet-6c21`.

Every push to `main` deploys automatically through Cloudflare Workers Builds.
