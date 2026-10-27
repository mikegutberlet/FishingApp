# Tackle Box: a private fishing app

A Fish Deeper–style app that keeps all of your data on your own device. No account, no server, no analytics.

<img src="docs/screenshot-conditions.png" width="300" alt="Lake conditions screen">

## What it does (MVP)

| Area | What you get | Data source |
|---|---|---|
| Map | Satellite/street map, your lakes, every catch pinned, depth maps overlaid | OpenStreetMap / Esri tiles |
| Conditions | Now, next 24 h, 7 days: temp, wind speed/direction/gusts, pressure + trend, clouds, rain chance, sunrise/sunset, moon phase | Open-Meteo (free, no key), moon computed locally |
| Water | Flow, gauge height and water temp from the nearest USGS gauges | USGS Water Services (free, no key) |
| Windy | Live Windy wind map embedded on each lake, plus a link that opens Windy with your Premium login | Windy embed |
| Depth charts | Import your Deeper soundings (CSV, GPX, KML) and see them as a colored depth map | Your own exports |
| Stocking | Stocking history per lake, totals by year, CSV import, link to the state report | You / state DNR downloads |
| Lake info | Acres, max depth, clarity, species, regulations, access, DNR links | You / state DNR pages |
| Catch log | Species, length, weight, depth, water temp, lure, technique, photos, GPS spot, released. Weather, wind, pressure trend and moon are captured automatically, also for catches logged later | Device |
| Notes | Per-lake notes, optionally pinned to a spot | Device |
| Stats | By species, lake, lure, hour, pressure trend, moon phase, depth band | Device |
| Backup | Export/import one JSON file (photos included), optionally password-encrypted, to move devices or keep a copy | Device |

It is a PWA: open it once in Safari/Chrome, choose **Add to Home Screen**, and it behaves like an app and opens with no signal (map tiles you've already viewed are cached).

## Conditions and forecasting

* **Bite windows:** solunar major periods (2 h around moon overhead and underfoot) and minor periods (1 h around moonrise and moonset), computed on the device, rated 0–4 stars by moon phase and overlap with sunrise/sunset. Marked on the 24-hour strip and listed for each of the 10 days.
* **Weather alerts:** National Weather Service alerts in effect at the water show as a banner on Conditions.
* **Rain radar:** map layer *Rain radar* (RainViewer, last 2 hours, play or scrub). RainViewer's free tiles stop at zoom 7, so it is blocky up close.
* **Wind on the water:** which bank the wind is blowing into, with the next big shift; map layer *Wind on my lakes* puts a wind arrow on each saved water.
* **Flow vs normal:** for USGS stream gauges, today's flow as a percent of the median for this date over the gauge's record, with a fishable / high / blown-out read on rivers.
* **Today (home screen):** your starred waters at a glance: weather, wind and which bank it's blowing into, the next bite window, 7-day level change, and new or upcoming CDFW plants, with NWS alerts flagged. Star a water with ☆ on its page.
* **Plan a trip:** pick a day in the next 10 and your saved waters are ranked 0–10 by wind, rain, temperature, pressure trend, solunar rating, days since the last plant and lake-level trend, with the reasons and the best time to be on the water.

## Logging and journal

* **Trip mode** (Journal → Start a trip, or the Log view): records your GPS track while the app is open, with big one-tap **Catch / Bite / Lost** buttons and a species picker built from your recent catches. Each tap is stamped with the time and your spot; add a length and photo right away or later. iPhones stop location updates when the screen locks, so trip mode keeps the screen on by default. The end-of-trip page shows time on the water, fish per hour, bites and lost fish, distance, and the track with every catch on a map.
* **Journal**: a rating, who you fished with, a write-up and photos for each trip, or for a past day without trip mode. The timeline lists trips, catches and notes newest first.
* **Search and filters** (Journal → Timeline): search species, lures, notes and waters, and filter by species, water, kept or released and dates; matching catches are listed whether or not they were on a trip.
* **Catch page**: tap any catch for its photos large (swipe, tap for full screen), size, water, lure, conditions and moon, a pin on the map, older/newer, and Edit / Share / Delete (`views/catch.js`).
* **Photos on the catch form**: add several per catch. The first photo of a new catch fills in When and the spot (and picks your saved water) from the photo's own time and GPS, read on the device.
* **Weather for catches logged later**: a catch logged more than 3 hours after the fact, or saved offline, gets that hour's weather from Open-Meteo's free archive (only the water's coordinates and the date are sent). Journal → Stats offers to fill it in for older catches that have none (`past-weather.js`).
* **Personal bests and life list**: every species you've caught, when and where first, longest and heaviest, overall and per water. A blank weight is estimated from length with standard-weight formulas for the species (shown with ≈).
* **Tackle box**: your lures and baits with photos; pick one on the catch form and see how many fish each has caught.
* **From photos**: pick old fish photos and Tackle Box reads the date and GPS on the device, matches the water (yours or any California water), and makes draft catches to confirm.
* **Units**: inches or cm, pounds or kg, feet or meters (⚙️ gear, top right). Records are stored in inches, pounds and feet.

## Water data and safety

* **Regs & safety tab** on every water: special regulations that name the water (Title 14 §7.50 trout, §7.40 salmon/steelhead, §5.00 black bass, §5.15 catfish, plus county-wide rules), matched by name, kind of water and county, with 🟢/🔴 for open or closed today; the statewide rules for the species; current toxic algae advisories; and OEHHA advice on how often you can eat each fish. The CDFW booklet and posted signs are still the final word.
* **Toxic algae banner** at the top of a water's page when the Water Boards have a Caution, Warning or Danger advisory on it, and a *Toxic algae advisories* map layer (on by default).
* **Getting there** tab on every water: whether you can drive to it and in what (paved road, dirt road fine for cars, high-clearance only, OHV only, or hike-in and how far), which nearby trails allow hiking, mountain bikes, motorcycles or ATVs, seasonal open dates, locked gates, who manages the land (and what that means for passes and permits) and a Wikipedia summary. Looked up live from the USFS Motor Vehicle Use Maps, USFS roads and trails, BLM routes, USGS PAD-US, OpenStreetMap and Wikipedia; every fact links to the record it came from, and *Show roads & trails on map* draws them. Big lakes and rivers ask which shore or stretch you mean. Answers stay on the device for 90 days (`access-lookup.js`, `access-rules.js`, `views/tabs/access.js`).
  * **The walk in**: the shortest way along mapped trails from a drivable road to the shore, with its elevation profile (Open-Meteo), climb, time each way by Naismith's rule, and directions to where you start walking.
  * **Today**: measured snow at the nearest NRCS SNOTEL station (or the Open-Meteo model at the water's elevation) and the snowfall forecast; wildfires and prescribed burns within about 30 miles (NIFC WFIGS, with InciWeb pages and the forest's closure orders); seasonal roads say whether they're open now (`access-now.js`).
  * **Cell signal**: what you and your crew noted per carrier, and the nearest cell mast mapped in OpenStreetMap.
  * **Your access notes** on each water (what it takes, the road, where to park with a pin, launch, gates and gate code, signal, photo), shared with friends through *Share with your crew*; a gate code goes only when you tick it (`access-notes.js`).
* **Camping** tab on every water: the campgrounds within about 10 miles of the shore, closest first, with who runs them, sites, fees, season, open or closed now, drinking water, toilets, showers, hookups, dump stations, RV length, reservable or first-come, and a Recreation.gov or ReserveCalifornia booking link; filters for free, reservable, drinking water and RVs; *Check open sites this weekend* counts the open Friday and Saturday sites at reservable federal campgrounds. **Dispersed camping** says, from the land manager within about 2 miles of the shore, whether free camping outside a campground is generally allowed (National Forest, BLM), backpack-only (wilderness) or not (state parks, Reclamation, private…), with the stay limits (36 CFR 261.58, 43 CFR 8365.1-2), the forest's closure orders, the Forest Service's mapped dispersed camping areas, and the state's campfire rules (California campfire permit). *Show campgrounds on map* adds a *Campgrounds* layer. Looked up live from USFS recreation sites (INFRA) and recreation opportunities, Recreation.gov, BLM recreation sites, California State Parks, OpenStreetMap and PAD-US; every fact links to its record; kept on the device for 7 days (`camping.js`, `camping-rules.js`, `views/tabs/camping.js`; dev check `scripts/dev/check-camping.mjs`).
* **Access & facilities** on the Getting there tab: boat ramps, fishing piers, parking near them, campgrounds, marinas, boat rentals and bait & tackle from OpenStreetMap, with distance and directions; map layer *Ramps & access* when zoomed in.
* **Plant calendars:** each stocked water has a calendar feed (`data/ca/ics/<stockId>.ics`); *Subscribe to plants* on the Stocking tab adds it to Apple or Google Calendar, with no server knowing who subscribed.
* **New since last visit:** the lake list badges saved waters with CDFW plants added since you last opened their Stocking tab.
* **Catch form warnings:** as you log a catch, a *Check the regs* box above Save flags a closed season, catch-and-release-only rules, wild fish that must go back, size minimums and the daily bag limit (counting what you've kept there that day). It never blocks saving. `CA.regsFor(lake)` and `CA.catchWarnings(lake, catch)` are the API behind it.

## Insights, privacy and sharing

* **Days like today** (Journal → Stats, and the Today screen): every catch is scored by how much its day resembles today (date in the season, pressure trend, air temp, wind, moon, time of day, same water), and the card says which species, lures, depths, hours and waters produced on the most similar days. Computed on the device.
* **Stats** (a section of the Journal): catch rate (fish per hour) from trips, by water and by hour of day; catches by lure color and water clarity (a new optional field on the catch form), with the best color for each clarity; and a **Year in review** page.
* **App lock** (⚙️ gear, top right): a 4–8 digit passcode, plus Face ID / Touch ID / fingerprint through the phone's own authenticator (WebAuthn, no server). Locks on open and after a chosen time in the background. It guards the screens; files that leave the phone should use the encrypted backup.
* **Encrypted backup**: the whole backup locked with a password (AES-256-GCM, key from PBKDF2-SHA256 with 600,000 rounds), saved through the share sheet (Save to Files → iCloud Drive, or Drive) or a folder you pick on a computer. Optional reminder when the last backup is older than a week, two weeks or a month. Plain JSON backups still import as before.
* **Crew sharing**: pick catches or a spot and send them as a file (AirDrop, Messages, email) or a QR code, optionally protected by a passphrase. The QR code holds the whole share in the link's `#` fragment, which browsers never send to the website. Shared photos are redrawn so camera and GPS data are gone, and catches leave out the exact spot unless you tick it. Friends' catches go to a separate Crew list (the water's **Crew** tab and the *Crew* map layer), never into your own stats.
* **License and report cards**: store your CDFW license and report-card dates; the app reminds you 30 days ahead and can make a calendar file with alerts.

## California

* **Find stocked waters**: Lakes → *Find California stocked waters* lists every CDFW-stocked lake and river, filtered to recent and upcoming plants, with one-tap *Add*. The map also has a *CA stocked waters* layer (green = planted in the last 30 days).
* **Stocking per lake**: the Stocking tab shows CDFW plants for that water (upcoming plants, last plant, plants per year, full list). CDFW publishes week and species but not fish counts.
* **History**: CDFW's public schedule only goes back about a year, so the nightly job merges each day into `data/ca/plants.json`. History builds from 2025-10 onward.
* **Lake level**: for reservoirs, Conditions shows CDEC elevation, 7- and 30-day change, and storage. The nearest gauge within 25 km is used; set a station id under Edit if it picks the wrong one.

Data is refreshed daily by `.github/workflows/update-data.yml` running `scripts/update-ca-data.mjs`. It runs on GitHub because the state sites don't let a browser app fetch from them directly. It is all public data, and the job never sees anything from your phone.

**Nevada and Oregon**: same shape, as `states/nv.js` and `states/or.js` plus nightly and weekly scripts each (below).

## Every California lake and river

* **Labels on the map** for every named lake, reservoir and river in California (zoom in for the small ones). Tap a label or the water itself to open it.
* **Tap any water** for current weather and a 10-day forecast, CDFW stocking and upcoming plants, lake level, depth, history and basic facts (size, elevation), all before you save it. *Save to my lakes* adds it to your list for catches and notes.
* **Lakes → Any California water** searches the whole list by name.
* **Depth:** max and average depth where a published survey exists, and full depth-contour charts for lakes USGS has surveyed (Calaveras, San Antonio, Whiskeytown and more as they appear), drawn as depth at today's level when the lake has a CDEC gauge.
* **History tab:** introductions and plantings recorded at that water, back to the 1870s, plus a statewide timeline of how California's waters were stocked.

### Where the statewide data comes from

| Data | Source | Refresh |
|---|---|---|
| Lake and river names, size, elevation | USGS National Hydrography Dataset | weekly |
| Max and mean depth | LAGOS-US DEPTH (published lake depth surveys), Wikidata for lakes it misses | weekly |
| Estimated average depth, volume, shoreline | HydroLAKES (modelled from lake shape and terrain, every lake over 25 acres) | monthly |
| Depth contour charts | USGS ScienceBase bathymetric surveys | monthly |
| Historical introductions and plantings | USGS Nonindigenous Aquatic Species database, plus documented early events (Fish Bulletin 178) | weekly |
| Current plants and stocking history | CDFW planting schedule | nightly |
| Lake levels | CDEC | nightly |
| Toxic algae advisories | California Water Boards FHAB bloom reports (data.ca.gov) | nightly |
| Plant calendar feeds | built from the CDFW planting schedule | nightly |
| Fishing regulations | California Code of Regulations Title 14 (Cornell LII), county lines from US Census TIGERweb | weekly |
| Fish consumption advisories | OEHHA (data.ca.gov) | weekly |
| Ramps, piers, parking, campgrounds, marinas, tackle shops | OpenStreetMap via Overpass | monthly |

### What the records can and can't tell you

* CDFW's digital planting records begin in the 2000s, and the public schedule shows about a year; the app keeps every day it sees, so history grows from October 2025 forward.
* Before that, the record is species introductions: the state Fish Commission (founded 1870), the U.S. Fish Commission and private parties moved shad, carp, bass, catfish, brown and brook trout into California waters from 1871 on. Those events, where they were recorded, show on the History tab.
* Native fish planted inside their native range, such as most rainbow trout plants in Sierra streams, were rarely logged by water before the 1930s and are not in any public database. Miners and settlers did carry trout into fishless high-country lakes from the 1870s; the golden trout transplant of 1876 is the best documented.

## Nevada

Pick the state at the top of **Lakes** (or *📍 Where I am*). The map labels every named lake and river in whichever state you're looking at, and the *Stocked waters* layer shows both states. A water belongs to the state it sits in (or the state saved on it), so Topaz Lake and Lake Tahoe use Nevada's data when you open them from the Nevada side.

* **Stocked waters**: every water NDOW publishes a page for (about 550 lakes, ponds, rivers and creeks), with each stocking's **date, number of fish and average length**. NDOW's pages keep a few years of stockings; the nightly job keeps everything it has seen, so history only grows.
* **NDOW fishing report** for the water (Stocking tab) and NDOW's write-up, history and angler guides (Info tab).
* **Lake levels**: USGS lake gauges (Walker, Topaz, Lahontan, Weber, Marlette, Wild Horse and others) and Reclamation's daily Lake Mead and Lake Mohave levels and storage. River flows come live from USGS for any water, as in California.
* **Regs & safety tab**: the special regulations NDOW lists for the water (season, hours, daily limit, notes), the region's general limits, closed waters in the county, statewide rules, active toxic algae advisories (HAB Watch / Warning / Danger) and mercury advisories on eating fish.
* **Depth**: HydroLAKES estimates, Wikidata max depths and any USGS survey the monthly job can contour.

| Data | Source | Refreshed |
|---|---|---|
| Waters, stockings, fishing reports | NDOW water pages (ndow.org) | nightly |
| Map points for NDOW waters | USGS NHD names, NDOW fishable-waters layer, OpenStreetMap (cached) | nightly |
| Lake levels | USGS Water Services, Reclamation RISE (Mead, Mohave) | nightly |
| Toxic algae | Nevada Office of State Epidemiology HAB list | nightly |
| Regulations, mercury advisories | Nevada Fishing Regulations on eRegulations (linked from NDOW) | weekly |
| Lakes and rivers, history | USGS NHD, USGS NAS | weekly |
| Depth surveys, HydroLAKES | USGS ScienceBase, HydroSHEDS | monthly |

NDOW pages don't carry coordinates, so each water is placed by matching its name (and the county or mountain range in names like "Carson River – Douglas" or "Willow Creek- Santa Rosa Range"). A few dozen small creeks and ponds have no point yet and show only in search; the job's report (`data/nv/update-report.json`) lists them.

## Oregon

Pick *Oregon* at the top of **Lakes**, or just pan the map north: Oregon's lakes and rivers label themselves as soon as the map shows part of the state.

* **Stocked waters**: every water on ODFW's weekly trout stocking schedule, with the **week and the number of legal, trophy, brood and fingerling trout** planned or stocked. ODFW shows two years; the nightly job keeps everything it has seen, so history only grows.
* **ODFW Recreation Report** entry for the water (Stocking tab), and ODFW's stocking-map notes on access, ramps and other species (Info tab).
* **Lake levels**: USGS lake gauges, the Army Corps' Willamette and Rogue reservoirs (Detroit, Green Peter, Lookout Point, Hills Creek, Lost Creek…) and Reclamation's central and eastern Oregon reservoirs (Wickiup, Crane Prairie, Prineville, Owyhee, Phillips…). River flows come live from USGS for any water.
* **Regs & safety tab**: the water's angling zone (from ODFW's zone map), the exceptions ODFW lists for it, the zone's general bag limits and seasons, statewide rules, Oregon Health Authority toxic algae advisories and its fish consumption advice (meals a month, for kids and pregnant or nursing people and for everyone else).
* **Depth**: HydroLAKES estimates, Wikidata max depths and any USGS survey the monthly job can contour.

| Data | Source | Refreshed |
|---|---|---|
| Stocking schedule and history | ODFW weekly trout stocking schedule (myodfw.com) | nightly |
| Fishing reports | ODFW Recreation Report, by zone | nightly |
| Map points for stocked waters | ODFW trout stocking maps, USGS NHD names, OpenStreetMap (cached) | nightly |
| Lake levels | USGS Water Services, Army Corps CWMS, Reclamation Hydromet | nightly |
| Toxic algae | Oregon Health Authority advisories | nightly |
| Regulations, angling zones | Oregon Sport Fishing Regulations on eRegulations, ODFW zone map | weekly |
| Fish consumption advisories | Oregon Health Authority | weekly |
| Lakes and rivers, history | USGS NHD, USGS NAS | weekly |
| Depth surveys, HydroLAKES | USGS ScienceBase, HydroSHEDS | monthly |

ODFW writes waters in short form ("HENRY HAGG LK", "SILVER CR RES"); the job spells them out and places them by name within their zone. Any it can't place are listed in `data/or/update-report.json`.

## Maps, depth and offline

* **Save a lake for offline**: open a water → *⬇ Offline*. It downloads the satellite map for the lake's area (zoom 10–17, capped at about 6,000 tiles with a size estimate first), its USGS depth chart and the California data the lake page uses. Saved lakes are listed under Data → *Offline maps*, where you can delete them. The street map isn't downloaded in advance because OpenStreetMap's tile policy doesn't allow offline prefetching; street areas you've already viewed stay cached.
* **Contour map from your Deeper scans**: Depth tab → *Contour map*. Every scan of the lake is merged on the phone into one grid (inverse-distance weighting over nearby soundings; areas you haven't scanned stay blank), traced into labeled contour lines with optional shading. On import the app asks for the scan date (read from the file when it has timestamps) and fills in that day's lake level from CDEC when the gauge has it, so scans taken at different water levels line up; the map is drawn at today's level.
* **Water temperature**: Depth tab → *Water temperature*. Surface temperature by date from Deeper scans that carry a temperature column (a Deeper floats, so it measures the surface) and from catches, a map of each scan's surface temperature, and temperature-by-depth profiles you enter from a drop thermometer, with the thermocline marked.
* **Catch heatmap**: map layers → *Catch heatmap*, filtered by species and season.
* **Waypoints**: long-press the map, or tap *📌 Mark* and use GPS or a tap, to mark a spot, structure, brush pile, drop-off, hazard or ramp with a name and note. They show as a *Waypoints* map layer, are listed on the lake's Depth tab, export as GPX, and go with a shared lake only if you include your notes and spots.

## Sharing with friends

* Everyone installs the same link. Each person's catches, notes and spots stay on their own phone. There are no shared accounts.
* **Share a lake**: open a lake → *Share*. It sends a small file through Messages, AirDrop, email and so on, containing the lake, your Deeper depth maps and (if you choose) your notes, pinned spots and waypoints. Catches are never included. Your friend opens the app → Data → *Import backup or shared lake*.

## Installing on iPhone and Android

* **iPhone**: open the link in Safari → Share → *Add to Home Screen*.
* **Android**: open the link in Chrome → ⋮ → *Install app*.

The ⚙️ gear (top right) shows the right steps for the phone you're on.

## Privacy model

* Catches, notes, photos, spots, depth data and stocking records live only in the browser's IndexedDB on your phone.
* The only outbound calls are: lake coordinates to Open-Meteo and USGS for conditions, map tile requests, and Windy when you open that panel. None carry your catch data.
* Because nothing is stored server-side, the app can be hosted anywhere static (even public GitHub Pages) without exposing data. Back up regularly: if you clear the browser's site data, the data goes with it.

## Running it

GPS and "Add to Home Screen" need HTTPS. Options, simplest first:

1. **GitHub Pages** (private repo + Pages, or public repo; data still stays on the phone).
2. **Your own machine**: `python3 -m http.server 8080` in this folder for desktop use; use Tailscale (`tailscale serve 8080`) to reach it from your phone over HTTPS.
3. Any static host (Netlify, Cloudflare Pages, a NAS).

No build step: it is plain HTML/JS with Leaflet vendored in `vendor/`.

## Getting your Deeper data in

In Fish Deeper, open Lakebook, pick the scan, and export (on the web at maps.fishdeeper.com, or share/export from the phone app). Import the CSV under **Lakes → your lake → Depth**. The importer looks for latitude, longitude and depth columns by name and converts meters to feet if the column or the units picker says meters. GPX/KML with depth or elevation per point also works.

Reverse-engineering other apps isn't needed: the public sources above cover conditions, and your own Deeper exports are the best depth data you can have for the water you fish.

## Windy and MyRadar

* **Windy**: your Premium subscription unlocks features on windy.com and in their app, but it is not an API key. The app embeds Windy's free map widget per lake and deep-links to windy.com where your Premium login applies. If you want Windy numbers *inside* the app (e.g. their ECMWF point forecast in the catch snapshot), that needs a separate Windy Point Forecast API key, which Windy sells separately. That would be a small addition (a key field in settings, stored only on the device).
* **MyRadar**: no public API for subscribers, so the app links out to it. Radar inside the app could come from free sources (NOAA/NWS radar or RainViewer tiles) if you want it.

## Next steps

* Oregon stocking and lake levels.
* Depth contour lines (not just colored points) and spot waypoints with icons.
* Water-temp/thermocline log from Deeper readings.
* Optional encrypted sync between your own devices (e.g. to a folder you control) if you want phone + desktop.

## Files

* `index.html`, `styles.css`: UI
* `app.js`: views, map, catch log, stats
* `db.js`: IndexedDB storage and backup
* `data-sources.js`: Open-Meteo, USGS, moon phase, CSV/GPX/KML parsers
* `states/index.js`: which state's data serves a water, and the state picked in Lakes
* `states/ca.js`: California stocking, reservoir, statewide water, depth-survey and history lookups
* `states/nv.js`, `states/common.js`: Nevada, built on lookups shared by states added after California
* `scripts/update-ca-data.mjs`: nightly CDFW plants, stocked waters and CDEC levels → `data/ca/`
* `scripts/build-ca-waters.mjs`, `build-ca-history.mjs`: weekly statewide water list and history
* `scripts/build-ca-bathymetry.mjs`: monthly depth contours → `data/ca/bathymetry/`
* `scripts/build-ca-hab.mjs`, `build-ca-ics.mjs`: nightly algae advisories → `data/ca/hab.json`, plant calendars → `data/ca/ics/`
* `scripts/build-ca-regs.mjs`, `build-ca-oehha.mjs`, `build-ca-access.mjs`: weekly regulations and county lines, fish advisories; monthly access → `data/ca/`
* `data/ca/logs/`: output of each data job, committed so problems can be read from the repo
* `scripts/nv/update-nv-data.mjs`: nightly NDOW waters, stockings and reports, lake levels, algae → `data/nv/`
* `scripts/nv/build-nv-regs.mjs`: weekly regulations and mercury advisories
* `states/or.js`, `views/tabs/or-safety.js`: Oregon
* `scripts/or/update-or-data.mjs`: nightly ODFW stocking schedule and Recreation Report, lake levels, algae → `data/or/`
* `scripts/or/build-or-regs.mjs`: weekly regulations, fish advisories and angling zones
* `scripts/build-state-waters.mjs`, `build-state-history.mjs`, `build-state-bathymetry.mjs` with `scripts/states.mjs`: the California jobs, for any other state (`node scripts/build-state-waters.mjs nv`)
* `sw.js`, `manifest.json`: offline + install
