# The water corpus

Tackle Box pulls from a lot of public services: state stocking schedules, USGS hydrography, Forest Service and BLM road and trail maps, PAD-US land records, OpenStreetMap, Wikipedia, Recreation.gov, state regulations and health advisories. Any of them can change shape or disappear. The corpus is a copy of what each of them said about each water, kept in this repo so the knowledge outlives the services, and so it can grow by hand over time.

- **Catalogue, one page per state:** [California](ca.md) · [Nevada](nv.md) · [Oregon](or.md)
- **[Changelog](CHANGELOG.md):** what each nightly run added or saw change
- **Data:** `data/corpus/<state>/<id>.json`, one file per stocked water, plus `index.json` per state

## What a water's file holds

Every section records where it came from and when it was fetched; `sources` lists every record the file draws on.

| Section | What | Where it comes from |
|---|---|---|
| `agency` | The state agency's page, write-up and last stocked year | CDFW / NDOW / ODFW (`data/<st>/waters.json`) |
| `facts` | Type, acres, elevation, max and mean depth, NHD id, HydroLAKES estimate, depth surveys | USGS NHD, Wikidata, LAGOS, HydroLAKES, USGS ScienceBase (`data/<st>/`) |
| `about` | A short description | Wikipedia (live) |
| `access` | Roads, trails, gates, cell masts within a few km with what each allows and when, the land manager, the walk in, and a one-line verdict ("High-clearance vehicle via Forest Road 10N12, then 0.6 mi on foot") | USFS MVUM, USFS roads and trails, BLM GTLF, PAD-US, OpenStreetMap, Open-Meteo elevation (live) |
| `camping` | Campgrounds within ~10 mi with facilities, fees, season and booking link; whether dispersed camping is allowed on the land around the water | USFS INFRA and recreation pages, Recreation.gov, BLM, California State Parks, OpenStreetMap, PAD-US (live) |
| `stocking` | The current schedule by year and species, and the multi-year history with a source document per year | agency schedules, ODFW annual reports, Internet Archive copies (`data/<st>/plants.json`, `stock-history.json`) |
| `introductions` | Historical fish introductions recorded at the water | USGS NAS (`data/<st>/history.json`) |
| `rules` | The special regulations that name the water | Title 14 CCR / NDOW / ODFW booklets (`data/<st>/regs.json`) |
| `advisories` | Toxic algae and fish-eating advisories in force when the file was built | state portals (`data/<st>/hab.json`, `oehha.json`, `advisories.json`) |
| `notes` | **Hand-kept.** Anything worth remembering that no service records, each with the book, page or web page it came from | you, your books, sites and blogs |
| `manual` | **Hand-kept.** Values that override the job's facts in the app (`{"maxDepthFt": 70}`) | you |
| `changes` | What the job saw change on each visit, newest first | the job |

The live sections keep the same shape the app stores on the phone (`access-lookup.js`, `camping.js`), with road and trail geometry thinned to about 10 m and 30 points per line, so the app can draw and reason from the archived copy exactly as it does from a live one.

## How it is kept

`scripts/build-corpus.mjs` runs nightly (`.github/workflows/build-corpus.yml`). It takes the stocked waters that have never been checked or were checked longest ago and rebuilds their files within a time budget (about 300 minutes; the road and campground services take 30–90 s per water). A water is revisited about every 120 days. A file is rewritten only when something changed, the `changes` list and the changelog get a line for each change, and the catalogue pages are regenerated from all the files every run.

Rules the job follows:

- **It never touches `notes` or `manual`.** Add a note by editing the water's JSON file (or ask Claude to): `{"date": "2026-10-27", "by": "Goobs", "text": "Gate at the dam is locked after Labor Day; park at the pullout and walk 10 min."}`. It shows up on the catalogue page and in the app's Info tab on the next run.
- **Notes from books, sites and blogs** go in with `scripts/add-notes.mjs`, which files each one on the right water with its source (`{"title": "…", "author": "…", "page": "112"}` for a book, `{"title": "…", "url": "https://…"}` for a web page) and shows it with the note in the app and the catalogue. This repo is public, so the sources themselves are kept privately, never here: a note is a short fact in our own words (at most 400 characters), not a copied passage. A water the job hasn't reached yet gets a file holding only its notes; the app shows them right away, and the catalogue lists the water once the job has built the rest on its next visit. `node scripts/add-notes.mjs --find "convict"` lists the ids to use.
- **It keeps the last good copy.** When a live service doesn't answer, the previous `access` or `camping` section stays and the file says which sources failed.
- **It cites everything.** Each road, trail, campground and parcel keeps the URL of the record it came from; each stocking year keeps the document it was read from.

Run it by hand:

```
node scripts/build-corpus.mjs                               # the nightly run
CORPUS_ONLY=ca:175,or:ALDER_LK node scripts/build-corpus.mjs # a few waters
CORPUS_NO_LIVE=1 node scripts/build-corpus.mjs              # refresh only what comes from the repo's own data files
CORPUS_DOCS_ONLY=1 node scripts/build-corpus.mjs            # regenerate the catalogue and index from the files
```

## How the app uses it

`corpus.js` reads a water's file from `data/corpus/<st>/<id>.json` (served with the app, so it is in the offline shell cache once seen). When a live source fails or the phone is offline, Getting there and Camping fill in from the archived copy and say so with its date; the Info tab shows an "In the archive" card with the hand notes and a link to the water's catalogue entry.

## Not in the corpus yet

- Ocean spots, piers and MPAs (`data/coast/`), which have their own weekly job.
- Waters that aren't on a state's stocked list (a lake you add by hand). Save one and open its Getting there tab once with signal: the lookup is kept on your phone for 90 days.
- Forecasts, lake levels, flows and fishing reports: these are about today, not knowledge to keep.
