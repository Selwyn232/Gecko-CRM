import json, sys, warnings, collections
warnings.filterwarnings("ignore")
import rdata, numpy as np
from shapely.geometry import Polygon, MultiPolygon, mapping
from shapely.ops import unary_union

src, out = sys.argv[1], sys.argv[2]
TARGET = 200
df = rdata.conversion.convert(rdata.parser.parse_file(src), default_encoding="utf8")["nl_postcode4"]

def to_geom(g):
    polys = []
    for poly in g:
        rings = [np.asarray(r, dtype=float) for r in poly]
        if len(rings[0]) < 4: continue
        polys.append(Polygon(rings[0], [r for r in rings[1:] if len(r) >= 4]))
    geom = MultiPolygon(polys) if len(polys) > 1 else polys[0]
    return geom if geom.is_valid else geom.buffer(0)

rows = []
for _, r in df.iterrows():
    rows.append({"pc4": int(r["pc4"]), "city": str(r["city"]), "geom": to_geom(r["geometry"])})
rows.sort(key=lambda x: x["pc4"])
print("PC4-gebieden:", len(rows))

# Verdeel 200 gebieden over de 90 PC2-reeksen, naar rato van het aantal PC4-codes (minimaal 1 per reeks).
by_pc2 = collections.OrderedDict()
for r in rows: by_pc2.setdefault(r["pc4"] // 100, []).append(r)
counts = {k: len(v) for k, v in by_pc2.items()}
total = sum(counts.values())
alloc = {k: 1 for k in counts}
remaining = TARGET - len(alloc)
quota = {k: counts[k] / total * TARGET for k in counts}
# extra gebieden naar de reeksen met het grootste tekort
while remaining > 0:
    k = max(counts, key=lambda k: (quota[k] - alloc[k]) if alloc[k] < counts[k] else -1e9)
    alloc[k] += 1; remaining -= 1

features = []
for pc2, items in by_pc2.items():
    k = alloc[pc2]
    chunks = np.array_split(np.arange(len(items)), k)
    for idx in chunks:
        group = [items[i] for i in idx]
        lo, hi = group[0]["pc4"], group[-1]["pc4"]
        cities = collections.Counter(g["city"] for g in group)
        top = [c for c, _ in cities.most_common(2)]
        name = top[0] if len(top) == 1 or cities[top[1]] < len(group) * 0.3 else f"{top[0]} / {top[1]}"
        geom = unary_union([g["geom"] for g in group]).simplify(0.0012, preserve_topology=True)
        # Afronden op 4 decimalen (~10 m) houdt het bestand klein.
        def rnd(c): return [[round(x, 4), round(y, 4)] for x, y in c]
        gj = mapping(geom)
        if gj["type"] == "Polygon":
            coords = [[rnd(r) for r in gj["coordinates"]]]
        else:
            coords = [[rnd(r) for r in p] for p in gj["coordinates"]]
        # Kleine splinters (eilandjes < ~0,05 km²) weglaten voor de leesbaarheid.
        coords = [p for p in coords if Polygon(p[0]).area > 5e-6] or coords[:1]
        features.append({
            "type": "Feature",
            "properties": {"code": f"{lo}-{hi}", "name": f"{name} ({lo}–{hi})", "from": lo, "to": hi, "pc4Count": len(group)},
            "geometry": {"type": "MultiPolygon", "coordinates": coords},
        })
fc = {"type": "FeatureCollection", "attribution": "Postcodegebieden (PC4): CBS / Kadaster, CC BY 4.0 — via R-pakket spatialrisk", "features": features}
json.dump(fc, open(out, "w"), separators=(",", ":"), ensure_ascii=False)
print("gebieden:", len(features))
import os; print("bestandsgrootte KB:", os.path.getsize(out) // 1024)
print("voorbeelden:", [f["properties"]["name"] for f in features[:3]], [f["properties"]["name"] for f in features[95:98]])
