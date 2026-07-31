# PromenadeFinder

Type any city, town or village — PromenadeFinder locates its **main promenade area(s)**:
the pedestrian streets, squares, waterfronts, boulevards and connected public spaces where
people are most likely to stroll, socialize and soak up the local atmosphere. Some places
genuinely have no promenade, and the app says so instead of inventing one.

## Run it

Open `index.html` in any modern browser. No build, no server, no API keys.

```
open index.html
```

Requires an internet connection (map tiles, geocoding, OpenStreetMap data).

## How it works

1. **Geocode** the locality with [Nominatim](https://nominatim.org) (admin boundary preferred;
   point + plausible-extent radius as fallback for villages/hamlets).
2. **Fetch** walkable/social features from the [Overpass API](https://overpass-api.de)
   (3 mirrors with automatic failover): pedestrian & living streets, named footways, public
   squares, beaches, piers, marinas, parks, cafés/restaurants/bars, fountains, attractions.
   Very large cities are clamped to the central ~10 km.
3. **Score** a 110 m grid (`promenade.js`): walkable length weighted by kind (pedestrian 3.0,
   pier 2.5, square 2.0, living 1.2, footpath 0.9, beach 0.4), multiplied by neighbor-aware
   café/restaurant density, with bonuses for waterfront, parks, and promenade-like names
   (promenade, esplanade, corso, faleza, lungomare, rambla, …). Café-only clusters get a weak
   score of their own — the village-corso signal. Hiking trails are excluded.
4. **Cluster** high-scoring cells (flood fill), rank areas, label them from their anchor
   streets and squares, and draw hulls + highlighted ways on the map.
5. **Verdict**: *strong* needs a high score **and** social proof (cafés, a square, waterfront,
   or a promenade name) — a long empty lane is not a promenade; *weak* = modest walkable spots;
   otherwise an honest *"no clear promenade found."*

## Files

- `index.html` — UI shell and styles
- `app.js` — geocoding, Overpass fetch (mirror failover), Leaflet rendering
- `promenade.js` — pure analysis engine (also loadable from Node)
- `test/calibrate.js` — calibration harness against localities with known ground truth
  (`node test/calibrate.js`; caches Overpass responses in `test/cache/`)

## Calibration results

| Locality | Expectation | Result |
|---|---|---|
| Sibiu, RO | historic-center corso | ✅ strong: Piața Mare · Piața Mică (+ Str. N. Bălcescu) |
| Constanța, RO | seafront | ✅ strong: Piața Ovidiu · Faleza promenadă Cazino |
| Vama Veche, RO | beach village | ✅ strong: beachfront strip (bars & restaurants) |
| Rășinari, RO | village, none | ✅ "no clear promenade found" |

Data © OpenStreetMap contributors. Results reflect what's mapped in OSM; under-mapped
villages may show fewer features than reality.
