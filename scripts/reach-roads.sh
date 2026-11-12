#!/usr/bin/env bash
# The roads and the lake shorelines in an OpenStreetMap extract, one GeoJSON line each with its tags, for
# scripts/build-reach.mjs.
#   scripts/reach-roads.sh <extract.osm.pbf> <roads.geojsonseq> <water.geojsonseq>
# Needs osmium-tool. Paths and motorways are left out here; who may drive a road is read from its tags later.
set -euo pipefail
in="$1"; roads="$2"; water="$3"; tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
classes=trunk,primary,secondary,tertiary,unclassified,residential,living_street,service,road,track
links=trunk_link,primary_link,secondary_link,tertiary_link
osmium tags-filter "$in" "w/highway=$classes,$links" -o "$tmp/roads.osm.pbf" --overwrite
osmium export "$tmp/roads.osm.pbf" --geometry-types=linestring -f geojsonseq -x print_record_separator=false -o "$roads" --overwrite
osmium tags-filter "$in" wr/natural=water wr/landuse=reservoir -o "$tmp/water.osm.pbf" --overwrite
osmium export "$tmp/water.osm.pbf" --geometry-types=polygon -f geojsonseq -x print_record_separator=false -o "$water" --overwrite
