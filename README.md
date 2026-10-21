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
| Catch log | Species, length, weight, depth, water temp, lure, technique, photo, GPS spot, released. Weather, wind, pressure trend and moon are captured automatically | Device |
| Notes | Per-lake notes, optionally pinned to a spot | Device |
| Stats | By species, lake, lure, hour, pressure trend, moon phase, depth band | Device |
| Backup | Export/import one JSON file (photos included) to move devices or keep a copy | Device |

It is a PWA: open it once in Safari/Chrome, choose **Add to Home Screen**, and it behaves like an app and opens with no signal (map tiles you've already viewed are cached).

## California

* **Find stocked waters**: Lakes → *Find California stocked waters* lists every CDFW-stocked lake and river, filtered to recent and upcoming plants, with one-tap *Add*. The map also has a *CA stocked waters* layer (green = planted in the last 30 days).
* **Stocking per lake**: the Stocking tab shows CDFW plants for that water (upcoming plants, last plant, plants per year, full list). CDFW publishes week and species but not fish counts.
* **History**: CDFW's public schedule only goes back about a year, so the nightly job merges each day into `data/ca/plants.json`. History builds from 2025-10 onward.
* **Lake level**: for reservoirs, Conditions shows CDEC elevation, 7- and 30-day change, and storage. The nearest gauge within 25 km is used; set a station id under Edit if it picks the wrong one.

Data is refreshed daily by `.github/workflows/update-data.yml` running `scripts/update-ca-data.mjs`. It runs on GitHub because the state sites don't let a browser app fetch from them directly. It is all public data, and the job never sees anything from your phone.

**Nevada and Oregon (planned)**: same shape, as `states/nv.js` and `states/or.js` plus a nightly script each. The sources are NDOW's weekly stocking reports and ODFW's trout stocking schedule and past stocking reports. Nevada reservoir levels come from USBR and USGS. Oregon lake levels come from USGS and the Army Corps of Engineers.

## Sharing with friends

* Everyone installs the same link. Each person's catches, notes and spots stay on their own phone. There are no shared accounts.
* **Share a lake**: open a lake → *Share*. It sends a small file through Messages, AirDrop, email and so on, containing the lake, your Deeper depth maps and (if you choose) your notes and pinned spots. Catches are never included. Your friend opens the app → Data → *Import backup or shared lake*.

## Installing on iPhone and Android

* **iPhone**: open the link in Safari → Share → *Add to Home Screen*.
* **Android**: open the link in Chrome → ⋮ → *Install app*.

The Data tab shows the right steps for the phone you're on.

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

* Nevada and Oregon stocking and lake levels (see above).
* Depth contour lines (not just colored points) and spot waypoints with icons.
* Water-temp/thermocline log from Deeper readings.
* Optional encrypted sync between your own devices (e.g. to a folder you control) if you want phone + desktop.

## Files

* `index.html`, `styles.css`: UI
* `app.js`: views, map, catch log, stats
* `db.js`: IndexedDB storage and backup
* `data-sources.js`: Open-Meteo, USGS, moon phase, CSV/GPX/KML parsers
* `states/ca.js`: California stocking and reservoir lookups
* `scripts/update-ca-data.mjs` and `data/ca/`: nightly public-data refresh and its output
* `sw.js`, `manifest.json`: offline + install
