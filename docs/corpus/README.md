# The water corpus (your private archive)

Tackle Box pulls from a lot of public services: state stocking schedules, USGS hydrography, Forest Service and BLM road and trail maps, PAD-US land records, OpenStreetMap, Wikipedia, Recreation.gov, state regulations and health advisories. Any of them can change shape or disappear. The corpus is a copy of what each of them said about each water, plus your own notes and excerpts from the books you own, kept so the knowledge outlives the services and grows by hand over time.

**It is not in this repo.** This repo is public (GitHub Pages serves the app from it), so the corpus lives in a private folder of your own (a NAS share synced to Google Drive): `scripts/build-corpus.mjs` writes there, and the app reads it only after you import its pack file on the phone. Nothing from the archive is ever served from, or sent to, GitHub.

## What the folder holds

```
<CORPUS_DIR>/
  ca/<id>.json, nv/…, or/…      one file per stocked water, plus index.json per state
  docs/ca.md, nv.md, or.md      the readable catalogue, one section per water
  docs/CHANGELOG.md             what each run added or saw change
  library/                      the books themselves (PDF, EPUB, scans, photos); read nightly by scripts/ingest.mjs
  library/<file>.json           optional sidecar per book: title, author, states it covers, page ranges per water
  library/.text/                cached text extracted from each book (by content hash), so OCR runs once
  urls.md                       websites and blogs to read nightly, one per line, optional water name after two spaces
  aliases.json                  extra matching terms ({"Convict": "ca:18122"}) or blocked ones ({"Silver Lake": null})
  maps/regions.json             optional: your own region list for the topo map packs (default: data/maps/regions.json)
  maps/<region>/<z>/<x>/<y>.png USGS topo tiles the archive server fills nightly (scripts/build-maps.mjs), served to the app
  maps/index.json, maps/<region>/index.json, maps/<region>/missing.json   how far each region has got; tiles USGS doesn't have
  logs/<date>.log               the archive server's nightly run log
  tackle-box-private-corpus.json   the pack the app imports (⚙️ gear → Import)
```

Every section of a water's file records where it came from and when it was fetched; `sources` lists every record the file draws on.

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
| `notes` | **Hand-kept.** Anything worth remembering that no service records, each with the book, page or web page it came from | you, your books, sites and blogs (`scripts/add-notes.mjs`) |
| `excerpts` | **Hand-kept.** Passages from your own books worth keeping whole, with the page | your books (`scripts/add-notes.mjs`) |
| `passages` | **Ingest-kept.** Every paragraph of your books and links that names the water, with the page or chapter (books) or link (web), which name matched, whether the name could mean another water too, and a `hash` of the text (how the ingest knows a passage is the same one next run) | `scripts/ingest.mjs`, nightly in the archive server, from `library/` and `urls.md` |
| `manual` | **Hand-kept.** Values that override the job's facts in the app (`{"maxDepthFt": 70}`) | you |
| `changes` | What the job saw change on each visit, newest first | the job |

The live sections keep the same shape the app stores on the phone (`access-lookup.js`, `camping.js`), with road and trail geometry thinned to about 10 m and 30 points per line, so the app can draw and reason from the archived copy exactly as it does from a live one.

## How it is kept

`scripts/build-corpus.mjs` runs nightly on your own computer, from a checkout of this repo, with `CORPUS_DIR` pointing at the folder. It takes the stocked waters that have never been checked or were checked longest ago and rebuilds their files within a time budget (about 300 minutes; the road and campground services take 30–90 s per water). A water is revisited about every 120 days. A file is rewritten only when something changed, the `changes` list and the changelog get a line for each change, and the catalogue pages and the pack are regenerated from all the files every run.

Rules the job follows:

- **It never touches `notes`, `excerpts` or `manual`.** Add them with `scripts/add-notes.mjs`, which files each note on the right water with its source (`{"title": "…", "author": "…", "page": "112"}` for a book, `{"title": "…", "url": "https://…"}` for a web page) and, when a passage is worth keeping whole, the `excerpt` itself. They show up in the app's Info tab and on the catalogue page. A water the job hasn't reached yet gets a file holding only its notes; the job builds the rest on its next visit. `node scripts/add-notes.mjs --find "convict"` lists the ids to use.
- **`passages` belongs to the ingest.** `scripts/ingest.mjs` (run by the archive server before the build) owns that list: each source's passages are replaced when the source is read again, dropped when the book or URL is gone, and kept when a page failed to load. The build keeps the list as it is. See `server/README.md` for the sidecar and alias files.
- **It keeps the last good copy.** When a live service doesn't answer, the previous `access` or `camping` section stays and the file says which sources failed.
- **It cites everything.** Each road, trail, campground and parcel keeps the URL of the record it came from; each stocking year keeps the document it was read from.

Run it:

```
export CORPUS_DIR=/Volumes/NAS/TackleBox/corpus                   # wherever the folder is
node scripts/build-corpus.mjs                                     # the nightly run
CORPUS_ONLY=ca:175,or:ALDER_LK node scripts/build-corpus.mjs      # a few waters
CORPUS_NO_LIVE=1 node scripts/build-corpus.mjs                    # refresh only what comes from the repo's own data files
CORPUS_DOCS_ONLY=1 node scripts/build-corpus.mjs                  # regenerate the catalogue, index and pack from the files
node scripts/add-notes.mjs notes.json                             # file notes and excerpts from your sources
node scripts/ingest.mjs [--dry]                                   # read library/ and urls.md, file passages per water
node --test 'scripts/test/*.test.mjs'                             # the scripts' tests
```

## How the app uses it

Import `tackle-box-private-corpus.json` from the folder (⚙️ gear → Import; the Files app can open Google Drive). It goes into the phone's own storage, like your catches, and `corpus.js` reads it from there. When a live source fails or the phone is offline, Getting there and Camping fill in from the archived copy and say so with its date; the Info tab shows an "In the archive" card with the record, your notes and the passages from your books. Import the pack again whenever you want the phone's copy brought up to date; "Your private archive" in Settings shows what is loaded and can remove it.

## Not in the corpus yet

- Ocean spots, piers and MPAs (`data/coast/`), which have their own weekly job.
- Waters that aren't on a state's stocked list (a lake you add by hand). Save one and open its Getting there tab once with signal: the lookup is kept on your phone for 90 days.
- Forecasts, lake levels, flows and fishing reports: these are about today, not knowledge to keep.
