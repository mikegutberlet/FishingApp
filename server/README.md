# The archive server

One small container for your own infrastructure that keeps the water corpus private (see [docs/corpus/README.md](../docs/corpus/README.md)):

1. **Builds it nightly.** At `BUILD_HOUR` it pulls this repo (the state data files the GitHub jobs keep current) and runs `scripts/build-corpus.mjs` into the mounted folder: one JSON file per water, the catalogue pages, the changelog, and the pack. Logs go to `<folder>/logs/<date>.log`.
2. **Serves it to the app.** Plain HTTP on `PORT` with a key: the app sends `Authorization: Bearer <CORPUS_TOKEN>` and reads a water's file the moment you open it, keeping a copy on the phone for offline. `/health` needs no key and reports what is in the archive. Nothing else is served: no books, no directory listings.

Put it behind your own HTTPS (reverse proxy, Cloudflare Tunnel, Tailscale Serve): phones only talk HTTPS to a page served over HTTPS, and `ALLOW_ORIGIN` must be where the app is served from (`https://mikegutberlet.github.io`).

## Run it

```
cp server/.env.example server/.env      # set CORPUS_PATH (the NAS folder) and CORPUS_TOKEN (long and random)
docker compose -f server/docker-compose.yml up -d --build
curl http://localhost:8787/health
```

Copy the existing archive into `CORPUS_PATH` first (the project's `sources/corpus/` folder has the records built so far), or set `BUILD_ON_START=1` and let the first run start from nothing.

Then in the app: ⚙️ gear → **Your private archive** → the HTTPS address and the key → **Connect**.

## Without Docker

`CORPUS_DIR=/path/to/folder CORPUS_TOKEN=… node server/serve.mjs` from a checkout of this repo does the same on any machine with Node 22 and git.

## Notes and books

`CORPUS_DIR=<folder> node scripts/add-notes.mjs notes.json` files notes and excerpts from your books onto the right waters; the next nightly run (or `CORPUS_DOCS_ONLY=1 node scripts/build-corpus.mjs`) folds them into the catalogue and the pack, and the app sees them the next time it opens the water. Keep the books themselves in `<folder>/library/`.
