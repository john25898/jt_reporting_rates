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
# Facility hierarchy (from a roster CSV — one per scope)
# --------------------------------------------------------------------------
# Two rosters ship in data/ (see config.SCOPES):
#   daraja — 259 Daraja-supported facilities across 15 counties (+ a few
#            legacy JT sites that are no longer in the Daraja census)
#   jt     — the original 200 Jamii Tekelezi facilities across 4 counties
# Each is loaded and cached independently so the cascade filters always show
# the counties / sub-counties / wards / facilities of the active scope.

_hierarchy_lock = threading.Lock()
_hierarchies = {}  # scope -> {"h": hierarchy, "at": loaded_ts}
_HIERARCHY_TTL = 300


def _load_hierarchy(scope=None):
    """Load counties/subcounties/wards/facilities for a roster scope."""
    scope = config.normalize_scope(scope)
    now = time.time()
    with _hierarchy_lock:
        ent = _hierarchies.get(scope)
        if ent and now - ent["at"] < _HIERARCHY_TTL:
            return ent["h"]
        df = pd.read_csv(config.filters_csv(scope))
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
        _hierarchies[scope] = {"h": h, "at": now}
        return h


def _request_scope():
    """Scope key for the current request (defaults to the Daraja roster)."""
    return config.normalize_scope(request.args.get("scope"))


def _facilities_in_scope(scope, county_id, subcounty_id, ward_id, facility_id):
    h = _load_hierarchy(scope)
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


def _form_title(key):
    return next((f["title"] for f in config.MOH_FORMS if f["key"] == key), key)


def _metrics_summary_for_scope(facility_rows, period, county_ids=None):
    """Per-form metric reporting summary across a facility scope.

    For every form, counts how many of the tracked (2023-version) metrics
    were reported by each facility, and aggregates:
      total_metrics       — number of tracked metrics in the form version
      facilities          — facilities in scope
      any_reported        — facilities that reported at least one metric
      reported_facility_metrics — sum over facilities of reported metrics
      overall_metric_rate — reported / (facilities * total_metrics)
      metrics             — per-metric coverage {name, id, reported, total}

    county_ids lets large scopes use the county-wide bulk fetch (a handful of
    KHIS calls instead of one per facility).
    """
    datasets = khis_client.resolve_moh_dataset_ids()
    facility_ids = [r["facility_id"] for r in facility_rows]
    forms = []
    for form in config.MOH_FORMS:
        ds = datasets.get(form["key"])
        if not ds or not facility_ids:
            forms.append({
                "key": form["key"], "title": form["title"],
                "version": config.TARGET_REVISION,
                "dataset_id": ds["id"] if ds else None,
                "total_metrics": 0, "facilities": len(facility_rows),
                "any_reported": 0, "reported_facility_metrics": 0,
                "overall_metric_rate": None, "metrics": [],
                "error": "dataset unresolved" if not ds else None,
            })
            continue
        sets, total, name_map = khis_client.reported_metric_sets(
            ds["id"], period, facility_ids, county_ids, config.TARGET_REVISION)
        if not sets or not total:
            forms.append({
                "key": form["key"], "title": form["title"],
                "version": config.TARGET_REVISION,
                "dataset_id": ds["id"], "total_metrics": 0,
                "facilities": len(facility_rows), "any_reported": 0,
                "reported_facility_metrics": 0, "overall_metric_rate": None,
                "metrics": [], "error": "no data",
            })
            continue
        any_reported = sum(1 for s in sets.values() if s)
        reported_metrics = sum(len(s) for s in sets.values())
        # per-metric coverage across the scope (every tracked metric seeded)
        per_metric = {
            de_id: {"name": nm, "id": de_id, "reported": 0, "total": len(facility_rows)}
            for de_id, nm in name_map.items()
        }
        for s in sets.values():
            for de_id in s:
                pm = per_metric.get(de_id)
                if pm:
                    pm["reported"] += 1
        metric_rows = sorted(
            per_metric.values(),
            key=lambda m: (m["reported"] / m["total"] if m["total"] else 0, m["name"]))
        forms.append({
            "key": form["key"], "title": form["title"],
            "version": config.TARGET_REVISION,
            "dataset_id": ds["id"], "total_metrics": total,
            "facilities": len(facility_rows), "any_reported": any_reported,
            "reported_facility_metrics": reported_metrics,
            "overall_metric_rate": round(100.0 * reported_metrics / (total * len(facility_rows)), 1) if total and facility_rows else None,
            "metrics": metric_rows,
        })
    return forms


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


def _scope_counties(scope, county_id):
    """Counties whose data is needed for the current scope."""
    if county_id:
        return [county_id]
    return [c["id"] for c in _load_hierarchy(scope)["counties"]]


@app.get("/api/locations")
def locations():
    scope = _request_scope()
    h = _load_hierarchy(scope)
    khis_ok = khis_client.khis_reachable()
    datasets = khis_client.resolve_moh_dataset_ids()
    khis_client.ensure_default_period()
    return jsonify({
        "scope": scope,
        "scopes": [{"key": s["key"], "label": s["label"]} for s in config.SCOPES],
        "counties": h["counties"],
        "subcounties": h["subcounties"],
        "wards": h["wards"],
        "facilities": h["facilities"],
        "total_facilities": len(h["facility_lookup"]),
        "khis_ok": khis_ok,
        "datasets": datasets,
        "periods": config.PERIODS,
        "default_period": khis_client.current_default_period(),
    })


@app.get("/api/reporting-rates")
def reporting_rates():
    scope = _request_scope()
    period = request.args.get("period") or khis_client.current_default_period()
    county_id = request.args.get("county_id") or None
    subcounty_id = request.args.get("subcounty_id") or None
    ward_id = request.args.get("ward_id") or None
    facility_id = request.args.get("facility_id") or None

    rows = _facilities_in_scope(scope, county_id, subcounty_id, ward_id, facility_id)
    facility_ids = [r["facility_id"] for r in rows]

    # counties to query for completions: the selected one, or every county
    # in the active roster
    counties = _scope_counties(scope, county_id)

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
        "roster": scope,
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
    period = request.args.get("period") or khis_client.current_default_period()
    facility_id = request.args.get("facility_id")
    valid_keys = {f["key"] for f in config.MOH_FORMS}
    if not facility_id or form_key not in valid_keys:
        return jsonify({"error": "form and facility_id are required"}), 400

    h = _load_hierarchy(_request_scope())
    row = h["facility_lookup"].get(facility_id)
    if not row:
        return jsonify({"error": "unknown facility"}), 404

    ds = khis_client.resolve_moh_dataset_ids().get(form_key)
    if not ds:
        return jsonify({"error": "dataset not resolved"}), 502

    values = khis_client.fetch_facility_form_values(
        ds["id"], period, facility_id, config.TARGET_REVISION)
    return jsonify({
        "form": form_key,
        "title": _form_title(form_key),
        "version": config.TARGET_REVISION,
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
        "total_metrics": values.get("total_metrics", 0),
        "reported_metrics": values.get("reported_metrics", 0),
        "unreported_metrics": values.get("unreported_metrics", []),
        "revision_groups": values.get("revision_groups", []),
    })


@app.get("/api/metrics-summary")
def metrics_summary():
    """Per-MOH metric reporting cards + per-metric coverage for the scope."""
    scope = _request_scope()
    period = request.args.get("period") or khis_client.current_default_period()
    county_id = request.args.get("county_id") or None
    subcounty_id = request.args.get("subcounty_id") or None
    ward_id = request.args.get("ward_id") or None
    facility_id = request.args.get("facility_id") or None

    rows = _facilities_in_scope(scope, county_id, subcounty_id, ward_id, facility_id)
    counties = _scope_counties(scope, county_id)
    forms = _metrics_summary_for_scope(rows, period, counties)
    return jsonify({
        "period": period,
        "version": config.TARGET_REVISION,
        "roster": scope,
        "scope": {
            "county_id": county_id, "subcounty_id": subcounty_id,
            "ward_id": ward_id, "facility_id": facility_id,
            "facility_count": len(rows),
        },
        "forms": forms,
    })


@app.get("/facility")
def facility_page():
    """Full page: per-dataset metric reporting for one facility."""
    return send_from_directory(app.static_folder, "facility.html")


@app.get("/api/facility-metrics")
def facility_metrics():
    """Per-dataset metric reporting for ONE facility across all three forms.

    Each form lists every tracked (2023-version) metric with its submitted
    value (or 'not reported'), so you can see exactly how many of each metric
    per dataset were reported for the facility + month.
    """
    period = request.args.get("period") or khis_client.current_default_period()
    facility_id = request.args.get("facility_id")
    if not facility_id:
        return jsonify({"error": "facility_id is required"}), 400

    h = _load_hierarchy(_request_scope())
    row = h["facility_lookup"].get(facility_id)
    if not row:
        return jsonify({"error": "unknown facility"}), 404

    datasets = khis_client.resolve_moh_dataset_ids()
    forms = []
    for form in config.MOH_FORMS:
        ds = datasets.get(form["key"])
        if not ds:
            forms.append({
                "key": form["key"], "title": _form_title(form["key"]),
                "version": config.TARGET_REVISION, "dataset_id": None,
                "total_metrics": 0, "reported_metrics": 0,
                "unreported_metrics": [], "metrics": [],
                "error": "dataset unresolved",
            })
            continue
        values = khis_client.fetch_facility_form_values(
            ds["id"], period, facility_id, config.TARGET_REVISION)
        forms.append({
            "key": form["key"],
            "title": _form_title(form["key"]),
            "version": config.TARGET_REVISION,
            "dataset_id": ds["id"],
            "dataset_name": values.get("dataset_name"),
            "total_metrics": values.get("total_metrics", 0),
            "reported_metrics": values.get("reported_metrics", 0),
            "unreported_metrics": values.get("unreported_metrics", []),
            "metrics": values.get("metrics", []),
        })

    return jsonify({
        "period": period,
        "version": config.TARGET_REVISION,
        "facility": {
            "id": row["facility_id"],
            "name": row["facility_name"],
            "county_name": row["county_name"],
            "subcounty_name": row["subcounty_name"],
            "ward_name": row["ward_name"],
        },
        "forms": forms,
    })


# --------------------------------------------------------------------------
# Tracer commodity consumption & balances (MOH 730B / 643B)
# --------------------------------------------------------------------------

def _tidy(v):
    """Float -> int when it is a whole number (keeps JSON readable)."""
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def _tracer_by_id(tracer_id):
    return next((t for t in config.COMMODITY_TRACERS if t["id"] == tracer_id), None)


def _commodity_scope_filter():
    """Shared scope parsing for the two commodity endpoints."""
    scope = _request_scope()
    period = request.args.get("period") or khis_client.current_default_period()
    county_id = request.args.get("county_id") or None
    subcounty_id = request.args.get("subcounty_id") or None
    ward_id = request.args.get("ward_id") or None
    facility_id = request.args.get("facility_id") or None
    rows = _facilities_in_scope(scope, county_id, subcounty_id, ward_id, facility_id)
    counties = _scope_counties(scope, county_id)
    return scope, period, rows, counties, {
        "county_id": county_id, "subcounty_id": subcounty_id,
        "ward_id": ward_id, "facility_id": facility_id,
        "facility_count": len(rows),
    }


@app.get("/api/commodities")
def commodities():
    """Scope-wide consumption & closing balance for every tracer commodity.

    Totals are summed across the facilities in the current scope; each tracer
    is reported individually (one data element = one pack size / presentation)
    so nothing is silently mixed.
    """
    scope, period, rows, counties, scope_obj = _commodity_scope_filter()
    facility_ids = [r["facility_id"] for r in rows]
    matrix = khis_client.commodity_scope_matrix(period, facility_ids, counties)

    groups = []
    for grp in config.COMMODITY_GROUPS:
        form_key = grp["form"]
        columns = config.COMMODITY_COLUMNS.get(form_key, [])
        col_keys = [c["key"] for c in columns]
        items = []
        for tracer in config.COMMODITY_TRACERS:
            if tracer["group"] != grp["key"]:
                continue
            totals = {k: 0.0 for k in col_keys}
            reported = 0
            for fid in facility_ids:
                cols = ((matrix.get(fid) or {}).get(form_key) or {}).get(tracer["id"])
                if not cols:
                    continue
                reported += 1
                for k, v in cols.items():
                    if k in totals:
                        totals[k] += v
            items.append({
                "id": tracer["id"],
                "label": tracer["label"],
                "form": form_key,
                "totals": {k: _tidy(v) for k, v in totals.items()},
                "highlight": {k: _tidy(totals.get(k, 0.0))
                              for k in config.COMMODITY_HIGHLIGHT_KEYS},
                "facilities_reported": reported,
                "facilities_tracked": len(facility_ids),
            })
        groups.append({
            "key": grp["key"], "label": grp["label"], "form": form_key,
            "form_title": grp.get("form_title"), "unit_note": grp.get("unit_note"),
            "columns": columns,
            "commodities": items,
        })

    return jsonify({
        "period": period,
        "roster": scope,
        "scope": scope_obj,
        "highlight_keys": list(config.COMMODITY_HIGHLIGHT_KEYS),
        "groups": groups,
    })


@app.get("/api/commodity-facilities")
def commodity_facilities():
    """Per-facility consumption & balance detail for ONE tracer commodity."""
    commodity_id = request.args.get("commodity_id")
    tracer = _tracer_by_id(commodity_id)
    if not tracer:
        return jsonify({"error": "unknown commodity_id"}), 400

    scope, period, rows, counties, scope_obj = _commodity_scope_filter()
    facility_ids = [r["facility_id"] for r in rows]
    form_key = tracer["form"]
    columns = config.COMMODITY_COLUMNS.get(form_key, [])
    col_keys = [c["key"] for c in columns]

    matrix = khis_client.commodity_scope_matrix(
        period, facility_ids, counties, forms=[form_key])

    facilities = []
    for r in rows:
        cols = ((matrix.get(r["facility_id"]) or {}).get(form_key) or {}).get(tracer["id"]) or {}
        facilities.append({
            "facility_id": r["facility_id"],
            "facility_name": r["facility_name"],
            "county_name": r["county_name"],
            "subcounty_name": r["subcounty_name"],
            "ward_name": r["ward_name"],
            "values": {k: _tidy(cols.get(k)) for k in col_keys},
            "reported": bool(cols),
        })
    # facilities that reported first, then alphabetical
    facilities.sort(key=lambda f: (not f["reported"], f["facility_name"].lower()))

    totals = {k: 0.0 for k in col_keys}
    for f in facilities:
        for k, v in f["values"].items():
            if v is not None:
                totals[k] += v

    return jsonify({
        "period": period,
        "roster": scope,
        "scope": scope_obj,
        "commodity": {
            "id": tracer["id"], "label": tracer["label"], "form": form_key,
            "group": tracer["group"],
            "form_title": next((g.get("form_title") for g in config.COMMODITY_GROUPS
                                if g["key"] == tracer["group"]), form_key),
        },
        "columns": columns,
        "highlight_keys": list(config.COMMODITY_HIGHLIGHT_KEYS),
        "totals": {k: _tidy(v) for k, v in totals.items()},
        "facilities": facilities,
    })


if __name__ == "__main__":
    print(f"JT Reporting Rates app on http://{config.HOST}:{config.PORT}")
    app.run(host=config.HOST, port=config.PORT, debug=False, threaded=True)
else:
    # Under gunicorn: resolve the latest closed month and warm its caches in
    # the background so the first visitor is served from cache.
    khis_client.start_background_jobs()
    app.run(host=config.HOST, port=config.PORT, debug=False, threaded=True)
