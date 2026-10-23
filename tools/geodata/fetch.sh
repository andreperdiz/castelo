#!/bin/sh
# Downloads the raw geodata for Óbidos into tools/geodata/raw (gitignored). Both sources are free:
#   - OpenStreetMap (© OpenStreetMap contributors, ODbL) through the public Overpass API
#   - Copernicus DEM GLO-30 (© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018,
#     provided under COPERNICUS by the European Union and ESA) from the AWS open data bucket
# The DGT LiDAR terrain tiles (MDT-2m-*.tif, CC BY 4.0) need a free account at https://cdd.dgterritorio.gov.pt/:
# download them there into raw/ by hand.
# Then `node tools/geodata/build.mjs` converts them into public/data and src/world/obidos/osm.json.
set -e
cd "$(dirname "$0")"
mkdir -p raw
UA="castelo-dev/0.1 (github.com/jmogielnicki/castelo)"

curl -s -A "$UA" -o raw/obidos-osm.json --data-urlencode 'data=[out:json][timeout:120];(way(39.352,-9.166,39.370,-9.146);relation["type"="multipolygon"](39.352,-9.166,39.370,-9.146);node["natural"="tree"](39.352,-9.166,39.370,-9.146);node["historic"](39.352,-9.166,39.370,-9.146);node["amenity"](39.352,-9.166,39.370,-9.146););out body;>;out skel qt;' https://overpass-api.de/api/interpreter

for t in N39_00_W010_00 N39_00_W009_00; do
	n=$(echo $t | sed 's/_00//g')
	curl -s -o raw/cop30_$n.tif "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_${t}_DEM/Copernicus_DSM_COG_10_${t}_DEM.tif"
done
ls -la raw
