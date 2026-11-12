"""Builds seed/settlement-coords.json from the CBS settlements file(s).

Source: Israel Central Bureau of Statistics, "רשימת יישובים" (bycodeYYYY.xlsx),
https://www.cbs.gov.il/he/publications/doclib/2019/ishuvim/bycode2024.xlsx
Column "קואורדינטות" is ITM (EPSG:2039) as 12 digits: 6 digits east + 6 digits north.
Column "סמל יישוב" is the same code the jobs board uses as citySymbol.

Usage (dev machine only, not at runtime):
  python -I build-settlement-coords.py out.json locations.json bycode2024.xlsx [bycode2021.xlsx ...]
locations.json: the board's locations (seed/live-snapshot.json works). Used only to place
the board's own non-CBS codes: regional councils ("מ.א. X") get the average point of the
council's settlements in the newest file, and a few merged codes are aliased below.
Earlier xlsx files only fill codes missing from the newer ones (settlements that merged or were renamed).
Needs: openpyxl, pyproj.
"""
import json
import sys

import openpyxl
from pyproj import Transformer

itm_to_wgs = Transformer.from_crs("EPSG:2039", "EPSG:4326", always_xy=True)


# Board codes that are not CBS settlement codes -> CBS codes to average.
ALIASES = {9494: [494, 534]}  # דאלית אל-כרמל - עספיא


def read_councils(path):
    """Regional council name -> list of (lat, lng) of its settlements."""
    wb = openpyxl.load_workbook(path, read_only=True)
    rows = wb.active.iter_rows(values_only=True)
    header = list(next(rows))
    i_code = header.index("סמל יישוב")
    i_auth = header.index("שם רשות מקומית")
    i_type = header.index("סמל סוג רשות מקומית")
    out = {}
    for r in rows:
        if r[i_type] == 3 and r[i_auth]:
            out.setdefault(str(r[i_auth]).strip(), []).append(int(r[i_code]))
    return out


def read(path):
    wb = openpyxl.load_workbook(path, read_only=True)
    rows = wb.active.iter_rows(values_only=True)
    header = list(next(rows))
    i_code = header.index("סמל יישוב")
    i_coord = header.index("קואורדינטות")
    i_name = header.index("שם יישוב")
    out = {}
    for r in rows:
        code, coord = r[i_code], r[i_coord]
        if code is None or coord is None:
            continue
        s = str(coord).strip().split(".")[0]
        if len(s) != 12 or not s.isdigit():
            continue
        e, n = int(s[:6]), int(s[6:])
        lng, lat = itm_to_wgs.transform(e, n)
        if not (29.3 < lat < 33.5 and 34.0 < lng < 36.0):
            continue
        out[int(code)] = {"lat": round(lat, 5), "lng": round(lng, 5), "name": str(r[i_name]).strip()}
    return out


def main():
    out_path, locations_path, *sources = sys.argv[1:]
    coords = {}
    for src in sources:
        for code, v in read(src).items():
            coords.setdefault(code, v)

    def avg(codes):
        pts = [coords[c] for c in codes if c in coords]
        if not pts:
            return None
        return {"lat": round(sum(p["lat"] for p in pts) / len(pts), 5),
                "lng": round(sum(p["lng"] for p in pts) / len(pts), 5)}

    with open(locations_path, encoding="utf-8") as f:
        locs = json.load(f)
    if isinstance(locs, dict):
        locs = locs.get("locations", locs)
        locs = locs.get("data", locs) if isinstance(locs, dict) else locs
    councils = read_councils(sources[0])
    extra = 0
    for l in locs:
        code, name = int(l["citySymbol"]), str(l["city"]).strip()
        if code <= 0 or code in coords:
            continue
        p = None
        if code in ALIASES:
            p = avg(ALIASES[code])
        elif name.startswith("מ.א. "):
            want = name[5:].strip()
            key = next((k for k in councils if k == want or k.startswith(want + " ")), None)
            p = avg(councils[key]) if key else None
        if p:
            coords[code] = p
            extra += 1
    print(f"{extra} board codes placed by council average / alias")
    data = {
        "source": "CBS settlements list (bycode), ITM -> WGS84 via pyproj: " + ", ".join(s.replace("\\", "/").split("/")[-1] for s in sources),
        "settlements": {str(k): [v["lat"], v["lng"]] for k, v in sorted(coords.items())},
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(coords)} settlements -> {out_path}")


if __name__ == "__main__":
    main()
