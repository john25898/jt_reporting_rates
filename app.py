"""Jamii Tekelezi Facility Reporting Rates — INDEPENDENT Flask app.

Serves a web UI with a cascade filter (all facilities -> county ->
subcounty -> ward -> facility) and three separate MOH reporting-rate
sections (MOH 643 B, MOH 729, MOH 730 B).

Run:  python app.py   (default http://0.0.0.0:5060)
"""
from __future__ import annotations

import threading
import time

import pandas as pd
from flask import Flask, jsonify, request, send_from_directory

import config
import khis_client

app = Flask(__name__, static_folder="static", static_url_path="")

# --------------------------------------------------------------------------
# Facility hierarchy (from the JT filters CSV — authoritative source)
# --------------------------------------------------------------------------

_hierarchy_lock = threading.Lock()
_hierarchy = None
_hierarchy_loaded_at = 0


def _load_hierarchy():
    """Load counties/subcounties/wards/facilities from the filters CSV."""
    global _hierarchy, _hierarchy_loaded_at
    now = time.time()
    if _hierarchy is not None and now - _hierarchy_loaded_at < 300:
        return _hierarchy
    with _hierarchy_lock:
        df = pd.read_csv(config.FILTERS_CSV)
        h = {
            "counties": [], "subcounties": [], "wards": [], "facilities": [],
            "facility_lookup": {},  # facility_id -> row
            "subcounty_by_county": {}, "ward_by_subcounty": {}, "facility_by_ward": {},
            "county_of_facility": {}, "subcounty_of_facility": {}, "ward_of_facility": {},
        }
        seen = set()
        for _, r in df.iterrows():
            cid, sid, wid, fid = r["county_id"], r["subcounty_id"], r["ward_id"], r["facility_id"]
            key = (cid, sid, wid, fid)
            if key in seen:
                continue
            seen.add(key)
            row = {
                "county_id": cid, "county_name": r["county_name"],
                "subcounty_id": sid, "subcounty_name": r["subcounty_name"],
                "ward_id": wid, "ward_name": r["ward_name"],
                "facility_id": fid, "facility_name": r["facility_name"],
            }
            if cid not in h["subcounty_by_county"]:
                h["counties"].append({"id": cid, "name": r["county_name"]})
                h["subcounty_by_county"][cid] = {}
            if sid not in h["subcounty_by_county"][cid]:
                h["subcounties"].append({"id": sid, "name": r["subcounty_name"], "county_id": cid})
                h["subcounty_by_county"][cid][sid] = {"id": sid, "name": r["subcounty_name"]}
                h["ward_by_subcounty"][sid] = {}
            if wid not in h["ward_by_subcounty"][sid]:
                h["wards"].append({"id": wid, "name": r["ward_name"], "subcounty_id": sid})
                h["ward_by_subcounty"][sid][wid] = {"id": wid, "name": r["ward_name"]}
                h["facility_by_ward"][wid] = {}
            if fid not in h["facility_by_ward"][wid]:
                h["facilities"].append({"id": fid, "name": r["facility_name"], "ward_id": wid})
                h["facility_by_ward"][wid][fid] = {"id": fid, "name": r["facility_name"]}
            h["facility_lookup"][fid] = row
            h["county_of_facility"][fid] = cid
            h["subcounty_of_facility"][fid] = sid
            h["ward_of_facility"][fid] = wid
        h["counties"].sort(key=lambda x: x["name"])
        for lst in (h["subcounties"], h["wards"], h["facilities"]):
            lst.sort(key=lambda x: x["name"])
        _hierarchy = h
        _hierarchy_loaded_at = now
    return _hierarchy


def _facilities_in_scope(county_id, subcounty_id, ward_id, facility_id):
    h = _load_hierarchy()
    if facility_id:
        rows = [h["facility_lookup"].get(facility_id)]
        return [r for r in rows if r]
    if ward_id:
        fids = list(h["facility_by_ward"].get(ward_id, {}).keys())
    elif subcounty_id:
        fids = []
        for wid, facs in h["ward_by_subcounty"].get(subcounty_id, {}).items():
            fids += list(h["facility_by_ward"].get(wid, {}).keys())
    elif county_id:
        fids = []
        for sid in h["subcounty_by_county"].get(county_id, {}):
            for wid in h["ward_by_subcounty"].get(sid, {}):
                fids += list(h["facility_by_ward"].get(wid, {}).keys())
    else:
        fids = list(h["facility_lookup"].keys())
    return [h["facility_lookup"][fid] for fid in fids if fid in h["facility_lookup"]]


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------

@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.after_request
def _no_cache(resp):
    # API responses must never be heuristically cached by the browser
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "app": "jt-reporting-rates", "time": time.time()})


@app.get("/api/locations")
def locations():
    h = _load_hierarchy()
    khis_ok = khis_client.khis_reachable()
    datasets = khis_client.resolve_moh_dataset_ids()
    return jsonify({
        "counties": h["counties"],
        "subcounties": h["subcounties"],
        "wards": h["wards"],
        "facilities": h["facilities"],
        "total_facilities": len(h["facility_lookup"]),
        "khis_ok": khis_ok,
        "datasets": datasets,
        "periods": config.PERIODS,
        "default_period": config.DEFAULT_PERIOD,
    })


@app.get("/api/reporting-rates")
def reporting_rates():
    period = request.args.get("period", config.DEFAULT_PERIOD)
    county_id = request.args.get("county_id") or None
    subcounty_id = request.args.get("subcounty_id") or None
    ward_id = request.args.get("ward_id") or None
    facility_id = request.args.get("facility_id") or None

    rows = _facilities_in_scope(county_id, subcounty_id, ward_id, facility_id)
    facility_ids = [r["facility_id"] for r in rows]

    # counties to query for completions: the selected one, or all four
    h = _load_hierarchy()
    if county_id:
        counties = [county_id]
    else:
        counties = [c["id"] for c in h["counties"]]

    datasets = khis_client.resolve_moh_dataset_ids()
    khis_ok = khis_client.khis_reachable()

    forms = []
    for form in config.MOH_FORMS:
        ds = datasets.get(form["key"])
        rates = {}
        if ds and facility_ids:
            rates = khis_client.fetch_reporting_rates(ds["id"], facility_ids, period, counties)
        per_facility = []
        total_expected = 0
        total_actual = 0
        n_with_expected = 0
        n_reported = 0
        for r in rows:
            e = rates.get(r["facility_id"], {"expected": 0, "actual": 0, "rate": None})
            exp, act = e.get("expected", 0), e.get("actual", 0)
            if exp:
                total_expected += exp
                total_actual += act
                n_with_expected += 1
                if act:
                    n_reported += 1
            per_facility.append({
                "facility_id": r["facility_id"],
                "facility_name": r["facility_name"],
                "county_name": r["county_name"],
                "subcounty_name": r["subcounty_name"],
                "ward_name": r["ward_name"],
                "expected": exp,
                "actual": act,
                "rate": e.get("rate") if exp else None,
                "reported": bool(act) if exp else False,
            })
        overall = round(100.0 * total_actual / total_expected, 1) if total_expected else None
        forms.append({
            "key": form["key"],
            "title": form["title"],
            "dataset_id": ds["id"] if ds else None,
            "summary": {
                "facilities_in_scope": len(rows),
                "facilities_with_expected": n_with_expected,
                "facilities_reported": n_reported,
                "expected_reports": total_expected,
                "actual_reports": total_actual,
                "overall_rate": overall,
            },
            "facilities": per_facility,
        })

    return jsonify({
        "period": period,
        "khis_ok": khis_ok,
        "scope": {
            "county_id": county_id, "subcounty_id": subcounty_id,
            "ward_id": ward_id, "facility_id": facility_id,
            "facility_count": len(rows),
        },
        "forms": forms,
    })


@app.get("/api/facility-form")
def facility_form():
    """Exact submitted form values for one facility + form + month (drill-down)."""
    form_key = request.args.get("form")
    period = request.args.get("period", config.DEFAULT_PERIOD)
    facility_id = request.args.get("facility_id")
    valid_keys = {f["key"] for f in config.MOH_FORMS}
    if not facility_id or form_key not in valid_keys:
        return jsonify({"error": "form and facility_id are required"}), 400

    h = _load_hierarchy()
    row = h["facility_lookup"].get(facility_id)
    if not row:
        return jsonify({"error": "unknown facility"}), 404

    ds = khis_client.resolve_moh_dataset_ids().get(form_key)
    if not ds:
        return jsonify({"error": "dataset not resolved"}), 502

    values = khis_client.fetch_facility_form_values(ds["id"], period, facility_id)
    return jsonify({
        "form": form_key,
        "title": next((f["title"] for f in config.MOH_FORMS if f["key"] == form_key), form_key),
        "period": period,
        "facility": {
            "id": row["facility_id"],
            "name": row["facility_name"],
            "county_name": row["county_name"],
            "subcounty_name": row["subcounty_name"],
            "ward_name": row["ward_name"],
        },
        "dataset_name": values.get("dataset_name"),
        "n_metrics": values.get("n_metrics", 0),
        "revision_groups": values.get("revision_groups", []),
    })


if __name__ == "__main__":
    print(f"JT Reporting Rates app on http://{config.HOST}:{config.PORT}")
    app.run(host=config.HOST, port=config.PORT, debug=False, threaded=True)
