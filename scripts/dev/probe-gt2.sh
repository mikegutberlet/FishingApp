#!/usr/bin/env bash
# Temporary probe for the next Getting there features (round 2): wildfire record fields, InciWeb RSS size, Overpass masts.
W='https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services'
attrs() { curl -sS -m 40 "$1" | python3 -c 'import sys,json; d=json.load(sys.stdin); [print(json.dumps(f["attributes"])[:6000]) for f in d.get("features",[])] or print(d)'; }
echo '=== points CA/NV/OR wildfires'
attrs "$W/WFIGS_Incident_Locations_Current/FeatureServer/0/query?where=IncidentTypeCategory%3D%27WF%27&geometry=-125,32,-114,46.5&geometryType=esriGeometryEnvelope&inSR=4326&outFields=*&returnGeometry=true&outSR=4326&f=json&resultRecordCount=2&orderByFields=IncidentSize%20DESC"
echo '=== perimeters'
attrs "$W/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&geometry=-125,32,-114,46.5&geometryType=esriGeometryEnvelope&inSR=4326&outFields=*&returnGeometry=false&f=json&resultRecordCount=2"
echo '=== count by type'
curl -sS -m 40 "$W/WFIGS_Incident_Locations_Current/FeatureServer/0/query?where=1%3D1&geometry=-125,32,-114,46.5&geometryType=esriGeometryEnvelope&inSR=4326&outFields=IncidentTypeCategory,IncidentName,IncidentSize,PercentContained,POOState&returnGeometry=false&f=json&resultRecordCount=200" | python3 -c 'import sys,json,collections; d=json.load(sys.stdin); a=[f["attributes"] for f in d["features"]]; print(collections.Counter(x["IncidentTypeCategory"] for x in a)); print(sorted([(x["IncidentSize"] or 0, x["IncidentName"], x["PercentContained"], x["POOState"]) for x in a], reverse=True)[:15])'
echo '=== InciWeb RSS size'
curl -sS -m 40 https://inciweb.wildfire.gov/incidents/rss.xml | tee /tmp/rss | wc -c; grep -c '<item>' /tmp/rss; grep -o 'State: [A-Za-z ]*' /tmp/rss | sort | uniq -c | sort -rn | head
echo '=== Overpass masts near Winnemucca Lake 15 km'
time curl -sS -m 90 https://overpass-api.de/api/interpreter --data-urlencode 'data=[out:json][timeout:30];(node["communication:mobile_phone"="yes"](around:15000,38.672,-120.0);node[man_made~"^(mast|tower)$"]["tower:type"="communication"](around:15000,38.672,-120.0););out tags center;' | head -c 3000
echo
echo '=== Overpass masts near Wilson Reservoir 25 km'
curl -sS -m 90 https://overpass-api.de/api/interpreter --data-urlencode 'data=[out:json][timeout:30];(nwr["communication:mobile_phone"="yes"](around:25000,41.71,-115.83);nwr[man_made~"^(mast|tower)$"]["tower:type"="communication"](around:25000,41.71,-115.83););out tags center;' | head -c 2000
echo
echo '=== FCC public API reachability'
curl -sS -m 30 -o /dev/null -w '%{http_code}\n' https://broadbandmap.fcc.gov/api/public/map/listAsOfDates
