"""Seed the graph with demo source data (Price Paid, Reading district) via the api. Stdlib only.
Usage: python scripts/seed.py [pp-2025.csv ...]   (files relative to data/raw/)"""
import json
import sys
import urllib.request

PPD_COLUMNS = ["transaction_id", "price", "date", "postcode", "property_type", "new_build", "tenure",
               "paon", "saon", "street", "locality", "town", "district", "county", "ppd_category",
               "record_status"]


def op(op_name: str, **kwargs):
    req = urllib.request.Request(f"http://localhost:8000/api/op/{op_name}", data=json.dumps(kwargs).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read())


if __name__ == "__main__":
    files = sys.argv[1:] or ["pp-2025.csv"]
    for f in files:
        year = "".join(ch for ch in f if ch.isdigit()) or "data"
        r = op("ingest", path=f, name=f"price_paid_{year}_reading", columns=PPD_COLUMNS,
               filter="district == 'READING'", parse_dates=["date"])
        print(f"{f}: view {r['view_id']} with {r['row_count']} records")
