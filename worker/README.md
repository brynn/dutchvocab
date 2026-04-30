# Dutch Vocab OpenAI proxy

A tiny Cloudflare Worker that holds the OpenAI API key so the PWA doesn't have to.

## One-time setup

```bash
# from the repo root
cd worker

# install wrangler if you don't have it
npm install -g wrangler

# log into your Cloudflare account
wrangler login

# upload your OpenAI key as an encrypted secret (paste it when prompted)
wrangler secret put OPENAI_API_KEY

# deploy
wrangler deploy
```

After `wrangler deploy` you'll see a URL like:

```
https://dutchvocab-proxy.<your-account>.workers.dev
```

Copy that URL into `WORKER_URL` near the top of `../app.js` and redeploy the site (push to `main`).

## Updating

```bash
wrangler deploy
```

Updates roll out immediately; no app changes needed unless you change the URL.

## Rotating the OpenAI key

```bash
wrangler secret put OPENAI_API_KEY
```

Overwrites the secret. No app or code change required.
