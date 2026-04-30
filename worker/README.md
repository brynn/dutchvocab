# Dutch Vocab Worker (proxy + cloud sync)

A Cloudflare Worker that:
1. Holds the OpenAI API key (translation + example sentence generation).
2. Stores all your flashcards in a D1 database so they sync across devices.

## One-time setup

```bash
cd worker

# install wrangler if you don't have it
npm install -g wrangler
wrangler login

# upload the OpenAI key as an encrypted secret
wrangler secret put OPENAI_API_KEY

# create the D1 database (prints a database_id)
wrangler d1 create dutchvocab-db
# -> copy the database_id into wrangler.toml (replace REPLACE_WITH_DATABASE_ID)

# create the schema
wrangler d1 execute dutchvocab-db --remote --file=schema.sql

# deploy
wrangler deploy
```

After deploy, the URL prints (e.g. `https://dutchvocab-proxy.<sub>.workers.dev`).
Paste it into `WORKER_URL` near the top of `../app.js`.

## Updating worker code

```bash
wrangler deploy
```

## Updating the schema

Edit `schema.sql`, then:

```bash
wrangler d1 execute dutchvocab-db --remote --file=schema.sql
```

## Inspecting cards

```bash
wrangler d1 execute dutchvocab-db --remote --command="SELECT id, dutch, english FROM cards ORDER BY createdAt DESC"
```

## Rotating the OpenAI key

```bash
wrangler secret put OPENAI_API_KEY
```
