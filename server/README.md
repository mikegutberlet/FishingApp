# The archive server

One small container for your own infrastructure that keeps the water corpus private (see [docs/corpus/README.md](../docs/corpus/README.md)):

1. **Builds it nightly.** At `BUILD_HOUR` it pulls this repo (the state data files the GitHub jobs keep current), reads your books and links (`scripts/ingest.mjs`, below) and runs `scripts/build-corpus.mjs` into the mounted folder: one JSON file per water, the catalogue pages, the changelog, and the pack. Logs go to `<folder>/logs/<date>.log`.
2. **Serves it to the app.** Plain HTTP on `PORT` with a key: the app sends `Authorization: Bearer <CORPUS_TOKEN>` and reads a water's file the moment you open it, keeping a copy on the phone for offline. `/health` needs no key and reports what is in the archive. Nothing else is served: no books, no directory listings.

Put it behind your own HTTPS (reverse proxy, Cloudflare Tunnel, Tailscale Serve): phones only talk HTTPS to a page served over HTTPS, and `ALLOW_ORIGIN` must be where the app is served from (`https://mikegutberlet.github.io`).

## Run it

```
cp server/.env.example server/.env      # set CORPUS_PATH (the NAS folder) and CORPUS_TOKEN (long and random)
docker compose -f server/docker-compose.yml up -d --build
curl http://localhost:8787/health
```

Compose builds the image straight from this repo on GitHub, so the server needs no checkout and no registry; `--build` picks up a new version. The container runs as uid 3000 by default (`PUID`/`PGID`), so the archive folder should be owned by that user.

## Behind a reverse proxy or Tailscale

The deployment itself (compose service, secret, route) belongs in the infrastructure repo; this README only covers the container. The route must **not** sit behind a forward-auth login (Authentik and the like): the app sends its own key, and a browser fetch can't follow a login redirect. When the HTTPS name is a tailnet name, phones must be on the tailnet to reach it; friends would need an invitation to it, or the pack import instead.

Copy the existing archive into `CORPUS_PATH` first (the project's `sources/corpus/` folder has the records built so far), or set `BUILD_ON_START=1` and let the first run start from nothing.

Then in the app: ⚙️ gear → **Your private archive** → the HTTPS address and the key → **Connect**.

## Without Docker

`CORPUS_DIR=/path/to/folder CORPUS_TOKEN=… node server/serve.mjs` from a checkout of this repo does the same on any machine with Node 22 and git.

## Books and links

Drop books into `<folder>/library/` (PDF, EPUB, `.txt`, or scans and page photos as PNG/JPEG/TIFF) and websites into `<folder>/urls.md` (one URL per line; two spaces and a water name after it when the page is about one water, e.g. `https://example.com/report  Convict Lake` or `  ca:18122`). Every night `scripts/ingest.mjs` reads them, splits the text into paragraphs and files each paragraph that names a stocked water onto that water under `passages`, with the page (or chapter, or link). The app shows them on the Info tab under **From your library**, the catalogue counts them, and the pack carries them. A PDF without a text layer and any image goes through OCR (`tesseract`, in the image); the extracted text is cached in `library/.text/` so a second run is instant.

- Beside a book, an optional sidecar `<file>.json`: `{ "title": "…", "author": "…", "states": ["ca"], "pages": { "112-118": "ca:18122", "200": "ca:Crowley Lake" } }`. `states` limits name matching to those states (a book about the Eastern Sierra shouldn't fill Oregon's Blue Lake); `pages` files whole page ranges on one water, for chapters that say "the lake" rather than its name.
- `<folder>/aliases.json` adds or blocks matching terms: `{ "Convict": "ca:18122", "Crowley": "ca:Crowley Lake", "Silver Lake": null }`. A name that fits several waters (three Silver Lakes in California) is filed on each and marked *may be another water with this name* until an alias or a sidecar settles it.
- Passages belong to their source: a replaced book or a changed page updates its own, a removed book or a dropped URL takes its passages with it, and a page that failed to load keeps last run's. Sites' `robots.txt` is honoured; a page that forbids us is dropped. Hand notes and excerpts (`notes`, `excerpts`) are never touched.
- `CORPUS_DIR=<folder> node scripts/ingest.mjs --dry` prints what would be filed without writing. `INGEST=0` on the container turns the step off.

## Notes by hand

`CORPUS_DIR=<folder> node scripts/add-notes.mjs notes.json` files short notes and excerpts from your books onto the right waters; the next nightly run (or `CORPUS_DOCS_ONLY=1 node scripts/build-corpus.mjs`) folds them into the catalogue and the pack, and the app sees them the next time it opens the water.
