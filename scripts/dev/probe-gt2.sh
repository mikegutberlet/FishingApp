#!/usr/bin/env bash
# Temporary probe for the next Getting there features: which public services answer, with CORS, and what they return.
O='Origin: https://mikegutberlet.github.io'
p() { echo; echo "=================== $1"; curl -sS -m 40 -D - -H "$O" "${@:2}" -o /tmp/body; echo '--- body:'; head -c ${MAX:-1500} /tmp/body; echo; }
p meteo-snow 'https://api.open-meteo.com/v1/forecast?latitude=38.672&longitude=-120.0&current=snow_depth,temperature_2m,snowfall&daily=snowfall_sum,temperature_2m_max&past_days=14&forecast_days=7&timezone=auto&elevation=2710'
p meteo-snow-mar 'https://archive-api.open-meteo.com/v1/archive?latitude=38.672&longitude=-120.0&start_date=2026-03-01&end_date=2026-03-02&daily=snowfall_sum&hourly=snow_depth&elevation=2710'
MAX=600 p meteo-elev 'https://api.open-meteo.com/v1/elevation?latitude=38.672,38.68,38.69&longitude=-120.0,-120.01,-120.02'
MAX=3000 p snotel-stations 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/stations?stationTriplets=*:CA:SNTL&returnStationElements=false&activeOnly=true'
MAX=2000 p snotel-data 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?stationTriplets=1067:CA:SNTL&elements=SNWD,WTEQ&duration=DAILY&beginDate=2026-10-15&endDate=2026-10-26'
MAX=2500 p wfigs-points 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query?where=1%3D1&geometry=-125,32,-114,46.5&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&outFields=*&f=json&resultRecordCount=2'
MAX=2500 p wfigs-perims 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&geometry=-125,32,-114,46.5&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&outFields=*&returnGeometry=false&f=json&resultRecordCount=2'
MAX=800 p wfigs-count 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query?where=1%3D1&geometry=-125,32,-114,46.5&geometryType=esriGeometryEnvelope&inSR=4326&returnCountOnly=true&f=json'
MAX=1500 p calfire 'https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=false'
MAX=1500 p inciweb-rss 'https://inciweb.wildfire.gov/incidents/rss.xml'
MAX=1500 p inciweb-api 'https://inciweb.wildfire.gov/api/v1/incidents?status=active'
echo; echo '=================== EDW services with closure/order/rec in the name'
curl -sS -m 40 'https://apps.fs.usda.gov/arcx/rest/services/EDW?f=json' | python3 -c 'import sys,json; d=json.load(sys.stdin); print([s["name"] for s in d.get("services",[]) if any(k in s["name"].lower() for k in ("clos","order","alert","fire","rec","wild"))])'
echo; echo '=================== FCC map: endpoints in its scripts'
curl -sS -m 40 -A 'Mozilla/5.0' https://broadbandmap.fcc.gov/home -o /tmp/fcc.html; head -c 600 /tmp/fcc.html; echo
for js in $(grep -oE '(src|href)="[^"]+\.js"' /tmp/fcc.html | sed -E 's/.*"([^"]+)"/\1/' | head -20); do
  case $js in http*) u=$js;; /*) u=https://broadbandmap.fcc.gov$js;; *) u=https://broadbandmap.fcc.gov/$js;; esac
  curl -sS -m 40 -A 'Mozilla/5.0' "$u" -o /tmp/f.js; echo "$u $(wc -c </tmp/f.js)"
  grep -oE '"[^"]{0,40}(api|nbm)/[^"]{3,120}"' /tmp/f.js | sort -u | head -80
  grep -oE '`[^`]{0,40}(api|nbm)/[^`]{3,160}`' /tmp/f.js | sort -u | head -40
done
MAX=1500 p fcc-filing 'https://broadbandmap.fcc.gov/nbm/map/api/published/filing' -A 'Mozilla/5.0'
