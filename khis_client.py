"""KHIS client for the Jamii Tekelezi Reporting Rates app (independent).

Retrieves dataset-completeness (reporting rate) data from the national
Kenya HIS DHIS2 server using the analytics endpoint with the dataSet
dimension, plus a fallback to completeDataSetRegistrations.

All payloads are cached to disk so the app keeps working even if KHIS
is slow or briefly unavailable.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests
from requests.auth import HTTPBasicAuth
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

import config

_lock = threading.Lock()
_write_lock = threading.Lock()
_session = None


def _get_session():
    global _session
    if _session is None:
        s = requests.Session()
        s.auth = HTTPBasicAuth(config.KHIS_USER, config.KHIS_PASS)
        s.headers.update({
            "Accept": "application/json",
            "User-Agent": "JamiiTekelezi-ReportingRates/1.0",
        })
        retry = Retry(total=config.KHIS_RETRIES, backoff_factor=1.5,
                      status_forcelist=[429, 500, 502, 503, 504])
        s.mount("https://", HTTPAdapter(max_retries=retry))
        s.mount("http://", HTTPAdapter(max_retries=retry))
        _session = s
    return _session


def khis_get(path, params=None, timeout=None):
    """GET a KHIS endpoint; returns parsed JSON or None on failure."""
    s = _get_session()
    url = f"{config.KHIS_BASE}/{path.lstrip('/')}"
    try:
        r = s.get(url, params=params or {}, timeout=timeout or config.KHIS_TIMEOUT)
        if not r.ok:
            return None
        return r.json()
    except Exception:
        return None


# --------------------------------------------------------------------------
# Dataset-ID resolution (MOH 643B / 729 / 730B)
# --------------------------------------------------------------------------

def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Serialize writes within this process (Windows locks the dest during
    # os.replace; on Linux the same tmp name across gunicorn workers caused
    # FileNotFoundError when a concurrent worker already moved it).
    with _write_lock:
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(obj, f, indent=1)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


def resolve_moh_dataset_ids(force=False):
    """Resolve KHIS dataset IDs for the three MOH forms.

    Uses the explicit ds_id from config (verified on KHIS); falls back to a
    keyword search only if the direct fetch fails. Returns
    {form_key: {"id": uid, "name": full name}}, disk-cached.
    """
    cached = _read_json(config.DATASET_IDS_CACHE)
    if cached and not force:
        age = time.time() - cached.get("ts", 0)
        if age < config.IDS_CACHE_TTL_SECONDS:
            return cached.get("datasets", {})

    result = {}
    ok_any = False
    for form in config.MOH_FORMS:
        found = None
        if form.get("ds_id"):
            d = khis_get(f"dataSets/{form['ds_id']}.json", {"fields": "id,name,periodType"})
            if d and d.get("id"):
                found = d
        if not found:
            for kw in form["search"]:
                data = khis_get("dataSets.json", {
                    "fields": "id,name,periodType",
                    "filter": f"name:ilike:{kw}",
                    "paging": "false",
                })
                if not data:
                    continue
                hits = data.get("dataSets", [])
                # Prefer a hit whose name contains the form keyword AND 2023
                exact = [d for d in hits if "2023" in d["name"].lower()]
                pool = exact or hits
                if pool:
                    pool.sort(key=lambda d: len(d["name"]))  # shortest = most specific
                    found = pool[0]
                    break
        if found:
            ok_any = True
            result[form["key"]] = {"id": found["id"], "name": found["name"]}
        else:
            # keep previously cached id if we have one
            if cached and cached.get("datasets", {}).get(form["key"]):
                result[form["key"]] = cached["datasets"][form["key"]]

    if ok_any or not cached:
        _write_json(config.DATASET_IDS_CACHE, {"ts": time.time(), "datasets": result})
    return result


# --------------------------------------------------------------------------
# Latest *closed* month (default-period auto-resolution)
# --------------------------------------------------------------------------
# The three Revision-2023 datasets are monthly returns. KHIS "closes" a month
# once reporting for it has finished — detectable by comparing completed-
# registration counts against earlier, already-closed months. We watch MOH
# 643B (the busiest dataset) across the JT counties; the result is cached to
# disk for 24h so every cold boot stays fast and the default flips to the new
# month automatically when KHIS closes it.
_CLOSED_MIN = 30          # below this many completed registrations = not closed
_CLOSED_RATIO = 0.8       # a month is closed once it reaches 80% of the prior one

_detect_thread = None
_default_thread_lock = threading.Lock()
_default_period = None    # best-known default (module global)


def _jt_county_ids(scope=None):
    """County ids of a roster scope (lazy, from its filters CSV)."""
    scope = config.normalize_scope(scope)
    cache = getattr(_jt_county_ids, "_cache", None)
    if cache is None:
        cache = {}
        _jt_county_ids._cache = cache
    if scope not in cache:
        try:
            import pandas as pd
            df = pd.read_csv(config.filters_csv(scope))
            cache[scope] = list(dict.fromkeys(df["county_id"].tolist()))
        except Exception:
            cache[scope] = []
    return cache[scope]


def _prev_calendar_months(n):
    """The n calendar months ending with the month before this one (newest last)."""
    import datetime as _dt
    today = _dt.date.today()
    out = []
    for i in range(n - 1, -1, -1):
        ym = (today.month - 1) - i - 1  # 0-based target month index
        yy = today.year + (ym // 12)
        mm = (ym % 12) + 1
        out.append(f"{yy}{mm:02d}")
    return out


def _month_completion_count(period, county_ids):
    """Completed MOH 643B registrations across the counties for a month."""
    ds = resolve_moh_dataset_ids().get("moh643")
    if not ds or not county_ids:
        return None
    total = 0
    ok = 0
    for cid in county_ids:
        d = khis_get("completeDataSetRegistrations.json", {
            "dataSet": ds["id"], "period": period,
            "orgUnit": cid, "children": "true"})
        if d is None:
            continue
        ok += 1
        total += len(d.get("completeDataSetRegistrations") or [])
    return total if ok else None


def _resolve_default_period():
    """Detect and cache the newest closed month (called once per staleness)."""
    global _default_period
    if os.environ.get("JT_DEFAULT_PERIOD"):
        _default_period = config.DEFAULT_PERIOD
        return _default_period

    cached = _read_json(config.DEFAULT_PERIOD_CACHE) or {}
    months = _prev_calendar_months(4)
    counties = _jt_county_ids()
    if not counties:
        _default_period = cached.get("period") or config.DEFAULT_PERIOD
        return _default_period

    counts = {}
    for per in months:
        counts[per] = _month_completion_count(per, counties)
        if counts[per] is None:  # KHIS unreachable -> keep last known default
            _default_period = cached.get("period") or config.DEFAULT_PERIOD
            return _default_period

    chosen = months[0]  # oldest window month is long closed -> sane baseline
    for k in range(1, len(months)):
        prev_c = counts[months[k - 1]]
        c = counts[months[k]]
        if prev_c and c is not None and c >= max(_CLOSED_MIN, _CLOSED_RATIO * prev_c):
            chosen = months[k]
        else:
            break
    _write_json(config.DEFAULT_PERIOD_CACHE,
                {"ts": time.time(), "period": chosen, "counts": counts})
    _default_period = chosen
    return chosen


def current_default_period():
    """Best-known default period without ever blocking on KHIS."""
    global _default_period
    if _default_period is None:
        cached = _read_json(config.DEFAULT_PERIOD_CACHE) or {}
        if cached.get("period"):
            _default_period = cached["period"]
    return _default_period or config.DEFAULT_PERIOD


def ensure_default_period():
    """Return the current default; kick a background re-check when the 24h
    closure cache is stale so the app self-updates when KHIS closes a month."""
    global _default_period, _detect_thread
    if _default_period is not None:
        return _default_period
    cached = _read_json(config.DEFAULT_PERIOD_CACHE) or {}
    fresh = (cached and (time.time() - cached.get("ts", 0))
             < config.DEFAULT_PERIOD_TTL_SECONDS)
    if cached.get("period"):
        _default_period = cached["period"]
    if not fresh and not os.environ.get("JT_DEFAULT_PERIOD"):
        with _default_thread_lock:
            if _detect_thread is None or not _detect_thread.is_alive():
                _detect_thread = threading.Thread(
                    target=_resolve_default_period, daemon=True)
                _detect_thread.start()
    return _default_period or config.DEFAULT_PERIOD


# --------------------------------------------------------------------------
# Reporting rates (dataset completeness)
# --------------------------------------------------------------------------

def _rate_cache_path(ds_id, period, ou_ids):
    h = hashlib.md5(";".join(sorted(ou_ids)).encode()).hexdigest()[:12]
    return os.path.join(config.RATES_CACHE_DIR, f"{ds_id}_{period}_{h}.json")


def _cache_valid(path):
    try:
        age = time.time() - os.path.getmtime(path)
        return age < config.RATE_CACHE_TTL_SECONDS
    except Exception:
        return False


def _assigned_ou_ids(ds_id):
    """Set of org-unit uids assigned to a dataset (disk-cached, 7 days)."""
    path = os.path.join(config.CACHE_DIR, f"ds_ous_{ds_id}.json")
    cached = _read_json(path)
    if cached and (time.time() - cached.get("ts", 0)) < config.IDS_CACHE_TTL_SECONDS:
        return set(cached.get("ids", []))

    ids = []
    page = 1
    while True:
        data = khis_get(f"dataSets/{ds_id}/organisationUnits.json", {
            "fields": "id", "page": page, "pageSize": 2000,
        })
        if not data:
            break
        ous = data.get("organisationUnits") or []
        ids += [o["id"] for o in ous]
        total = (data.get("pager") or {}).get("total", len(ids))
        if len(ids) >= total or not ous:
            break
        page += 1

    if ids:
        _write_json(path, {"ts": time.time(), "ids": ids})
    return set(ids)


def fetch_reporting_rates(ds_id, ou_ids, period, county_ids):
    """Return {ou_id: {"expected": int, "actual": int, "rate": float|None}}.

    expected = facility is assigned the dataset in KHIS (dataSet org-units)
    actual   = facility has a completeDataSetRegistration for the period,
               queried per county with children=true (this KHIS instance
               rejects the analytics dataSet dimension; the plain orgUnit
               query excludes descendants, hence per-county queries).
    Results are cached to disk (12h); stale/absent cache falls back to an
    empty expected/actual set so the UI can still render.
    """
    ou_ids = list(dict.fromkeys(ou_ids))
    if not ou_ids or not ds_id:
        return {}

    cpath = _rate_cache_path(ds_id, period, ou_ids)
    if _cache_valid(cpath):
        cached = _read_json(cpath)
        if cached is not None:
            return cached

    expected_ids = set(ou_ids) & _assigned_ou_ids(ds_id)

    completed = set()
    counties = [c for c in (county_ids or []) if c]
    if counties:
        def _fetch(cid):
            data = khis_get("completeDataSetRegistrations.json", {
                "dataSet": ds_id, "period": period, "orgUnit": cid, "children": "true",
            })
            if not data:
                return []
            return [r.get("organisationUnit")
                    for r in (data.get("completeDataSetRegistrations") or [])
                    if r.get("organisationUnit")]

        with ThreadPoolExecutor(max_workers=min(8, len(counties))) as ex:
            for chunk in ex.map(_fetch, counties):
                completed.update(chunk)

    result = {}
    for uid in ou_ids:
        exp = 1 if uid in expected_ids else 0
        act = 1 if uid in completed else 0
        result[uid] = {
            "expected": exp,
            "actual": act,
            "rate": round(100.0 * act / exp, 1) if exp else None,
        }

    _write_json(cpath, result)
    return result


# --------------------------------------------------------------------------
# Per-facility form values (the actual numbers submitted on each form)
# --------------------------------------------------------------------------

_REV_RE = re.compile(r"Rev(?:ision)?[ _]?(\d{4})", re.IGNORECASE)


def _dataset_elements(ds_id):
    """Data elements inside a dataset: {de_id: {name, value_type}}. Cached 30d."""
    path = os.path.join(config.CACHE_DIR, f"ds_elements_{ds_id}.json")
    cached = _read_json(path)
    if cached and (time.time() - cached.get("ts", 0)) < config.ELEMENTS_CACHE_TTL_SECONDS:
        return cached.get("elements", {})
    d = khis_get(f"dataSets/{ds_id}.json", {
        "fields": "dataSetElements[dataElement[id,name,valueType]]",
    })
    elements = {}
    for de in (d or {}).get("dataSetElements") or []:
        el = de.get("dataElement") or {}
        if el.get("id"):
            elements[el["id"]] = {
                "name": el.get("name", "?"),
                "value_type": el.get("valueType", ""),
            }
    if elements:
        _write_json(path, {"ts": time.time(), "elements": elements})
    return elements


def _revision_of(name):
    """Exact dataset revision year embedded in an element name ('2023', '2017'...)."""
    m = _REV_RE.search(name or "")
    return m.group(1) if m else None


def _clean_metric_name(name):
    """Strip the '<form> ... Rev/Revision YYYY' prefix for a readable label."""
    m = _REV_RE.search(name or "")
    if m:
        rest = (name or "")[m.end():]
        return rest.lstrip(" _-/\u2013\u2014:") or name
    return name or "?"


def fetch_facility_form_values(ds_id, period, ou_id, target_revision=config.TARGET_REVISION):
    """Exact submitted form values for ONE facility + dataset + month.

    ONLY metrics belonging to the target revision (e.g. '2023') are tracked —
    older/newer elements carried inside the same dataset (e.g. 'Revision 2017',
    'Rev 2026') are ignored so the version stays exact. Each tracked metric's
    value is summed across category-option combos (disaggregations) so it shows
    the true monthly total; metrics with no submitted value are listed as
    unreported. Disk-cached 12h.
    """
    path = os.path.join(
        config.VALUES_CACHE_DIR,
        f"{ds_id}_{period}_{ou_id}_r{target_revision}.json",
    )
    if _cache_valid(path):
        cached = _read_json(path)
        if cached is not None:
            return cached

    elements = _dataset_elements(ds_id)
    ds = khis_get(f"dataSets/{ds_id}.json", {"fields": "id,name"})
    data = khis_get("dataValueSets.json", {
        "dataSet": ds_id, "period": period, "orgUnit": ou_id,
        "includeDeleted": "false",
    })

    totals = {}  # de_id -> [sum(float|None), raw_count, first_non_numeric]
    for v in (data or {}).get("dataValues") or []:
        de_id = v.get("dataElement")
        if not de_id:
            continue
        raw = v.get("value")
        try:
            num = float(raw) if raw not in (None, "") else 0.0
        except (TypeError, ValueError):
            num = None
        t = totals.setdefault(de_id, [None, 0, None])
        if num is not None:
            t[0] = (t[0] or 0.0) + num
            t[1] += 1
        elif t[2] is None:
            t[2] = raw

    # Only the target revision's data elements are tracked
    target_elements = [
        {"id": de_id, "name": el.get("name", de_id)}
        for de_id, el in elements.items()
        if _revision_of(el.get("name", "")) == target_revision
    ]
    target_elements.sort(key=lambda e: e["name"].lower())

    metrics = []
    unreported = []
    for el in target_elements:
        de_id = el["id"]
        t = totals.get(de_id)
        if t is not None:
            total, raw_count, text_val = t
            value = text_val if text_val is not None else total
            if isinstance(value, float) and value.is_integer():
                value = int(value)
            metrics.append({
                "id": de_id,
                "name": _clean_metric_name(el["name"]),
                "value": value,
                "raw_count": raw_count,
                "reported": True,
            })
        else:
            unreported.append(_clean_metric_name(el["name"]))
            metrics.append({
                "id": de_id,
                "name": _clean_metric_name(el["name"]),
                "value": None,
                "raw_count": 0,
                "reported": False,
            })

    reported_metrics = len(metrics) - len(unreported)
    result = {
        "dataset_name": (ds or {}).get("name", ds_id),
        "version": target_revision,
        "total_metrics": len(target_elements),
        "reported_metrics": reported_metrics,
        "unreported_metrics": unreported,
        "metrics": metrics,
        "revision_groups": [{
            "version": target_revision,
            "label": f"Revision {target_revision}",
            "metrics": [m for m in metrics if m["reported"]],
        }] if reported_metrics else [],
        "n_metrics": reported_metrics,
    }
    _write_json(path, result)
    return result


def _bulk_tracked_map(ds_id, target_revision):
    """{de_id: clean_name} for a dataset's target-revision elements (cached)."""
    elements = _dataset_elements(ds_id)
    return {de_id: _clean_metric_name(meta.get("name", de_id))
            for de_id, meta in elements.items()
            if _revision_of(meta.get("name", "")) == target_revision}


def _bulk_cache_path(ds_id, period, ou_ids):
    h = hashlib.md5(";".join(sorted(ou_ids)).encode()).hexdigest()[:12]
    return os.path.join(config.BULK_CACHE_DIR, f"{ds_id}_{period}_{h}.json")


def _bulk_county_values(ds_id, period, county_ids):
    """dataValues rows for a dataset + month across whole counties (children).

    One KHIS call per county instead of one per facility — the same values,
    ~30x fewer requests on large scopes.
    """
    rows = []

    def _fetch(cid):
        d = khis_get("dataValueSets.json", {
            "dataSet": ds_id, "period": period, "orgUnit": cid,
            "children": "true", "paging": "false"})
        return (d or {}).get("dataValues") or []

    with ThreadPoolExecutor(max_workers=min(8, len(county_ids))) as ex:
        for chunk in ex.map(_fetch, county_ids):
            rows += chunk
    return rows


def reported_metric_sets(ds_id, period, ou_ids, county_ids=None,
                         target_revision=config.TARGET_REVISION):
    """Which tracked metrics each facility reported for a dataset + month.

    Large scopes (>= config.BULK_MIN_FACILITIES) use one county-wide
    dataValueSets call per county and the result is disk-cached (12h); small
    scopes reuse the per-facility form-values cache (which also warms the
    facility drill-down).

    Returns ( {ou_id: [de_id, ...]}, total_metrics, {de_id: clean_name} ).
    """
    ou_ids = list(dict.fromkeys(ou_ids))
    if not ou_ids or not ds_id:
        return {}, 0, {}
    name_map = _bulk_tracked_map(ds_id, target_revision)
    total = len(name_map)

    if county_ids and len(ou_ids) >= config.BULK_MIN_FACILITIES:
        cpath = _bulk_cache_path(ds_id, period, ou_ids)
        if _cache_valid(cpath):
            cached = _read_json(cpath)
            if cached is not None:
                return cached.get("sets", {}), cached.get("total", total), name_map

        ou_set = set(ou_ids)
        by_fac = {}
        for v in _bulk_county_values(ds_id, period, county_ids):
            de, ou = v.get("dataElement"), v.get("orgUnit")
            if de in name_map and ou in ou_set:
                by_fac.setdefault(ou, set()).add(de)
        sets = {uid: sorted(by_fac.get(uid, ())) for uid in ou_ids}
        # cache even an empty result so an empty month isn't re-fetched
        _write_json(cpath, {"ts": time.time(), "sets": sets, "total": total})
        return sets, total, name_map

    # small scope -> per-facility path (also warms the drill-down cache)
    sets = {}
    for uid in ou_ids:
        fv = fetch_facility_form_values(ds_id, period, uid, target_revision)
        sets[uid] = sorted(m["id"] for m in (fv.get("metrics") or [])
                           if m.get("reported"))
    return sets, total, name_map


def fetch_metric_reporting(ds_id, period, ou_ids, target_revision=config.TARGET_REVISION,
                           county_ids=None):
    """Per-facility count of reported metrics for a dataset.

    Returns {ou_id: {"reported": int, "total": int}}. For large scopes this
    uses the county-wide bulk fetch (a handful of KHIS calls), for small
    scopes the per-facility cached path.
    """
    ou_ids = list(dict.fromkeys(ou_ids))
    if not ou_ids or not ds_id:
        return {}
    sets, total, _ = reported_metric_sets(
        ds_id, period, ou_ids, county_ids, target_revision)
    return {uid: {"reported": len(sets.get(uid, ())), "total": total}
            for uid in ou_ids}


def khis_reachable():
    """Cheap reachability probe against system/info with our credentials."""
    data = khis_get("system/info.json", {"fields": "version"}, timeout=20)
    return data is not None and bool(data.get("version"))


# --------------------------------------------------------------------------
# Tracer commodity consumption & balances (MOH 730B / 643B)
# --------------------------------------------------------------------------
# Every commodity data element (e.g. TLD 90s) is one *row* of the form; the
# row's columns — Beginning balance, Received, Issued/Used, Closing count,
# Days out of stock … — are categoryOptionCombos (see config.COMMODITY_COLUMNS).
# dataValueSets therefore returns several rows per (facility, commodity), one
# per column, and we fold them into {facility: {commodity: {column: value}}}.

def _tracer_hash(form_key):
    ids = sorted(config.commodity_elements_for(form_key))
    return hashlib.md5(",".join(ids).encode()).hexdigest()[:8]


def _commodity_cache_path(ds_id, period, county_id, form_key):
    return os.path.join(
        config.COMMODITY_CACHE_DIR,
        f"{ds_id}_{period}_{county_id}_{_tracer_hash(form_key)}.json")


def _county_commodity_matrix(form_key, ds_id, period, county_id):
    """{ou_id: {de_id: {column_key: value}}} for one county (cached 12h)."""
    path = _commodity_cache_path(ds_id, period, county_id, form_key)
    if _cache_valid(path):
        cached = _read_json(path)
        if cached is not None:
            return cached.get("ous") or {}

    elements = set(config.commodity_elements_for(form_key))
    d = khis_get("dataValueSets.json", {
        "dataSet": ds_id, "period": period, "orgUnit": county_id,
        "children": "true", "paging": "false"})
    if d is None:
        # KHIS failed — do NOT persist an empty result, it would look like
        # "nobody reported anything" for the whole cache window.
        return {}

    ous = {}
    for v in d.get("dataValues") or []:
        de = v.get("dataElement")
        if de not in elements:
            continue
        col = config.commodity_column_key(form_key, v.get("categoryOptionCombo"))
        if not col:
            continue
        raw = v.get("value")
        try:
            num = float(raw) if raw not in (None, "") else 0.0
        except (TypeError, ValueError):
            continue
        bucket = ous.setdefault(v.get("orgUnit"), {}).setdefault(de, {})
        bucket[col] = bucket.get(col, 0.0) + num

    _write_json(path, {"ts": time.time(), "ous": ous})
    return ous


def fetch_commodity_matrix(form_key, period, county_ids):
    """{ou_id: {de_id: {column_key: value}}} merged across counties.

    One KHIS call per county (disk-cached 12h) instead of one per facility.
    Returns {} when the scope has no counties / the dataset is unresolved.
    """
    ds = resolve_moh_dataset_ids().get(form_key)
    county_ids = [c for c in (county_ids or []) if c]
    if not ds or not county_ids:
        return {}

    def _one(cid):
        return _county_commodity_matrix(form_key, ds["id"], period, cid)

    merged = {}
    with ThreadPoolExecutor(max_workers=min(8, len(county_ids))) as ex:
        for ous in ex.map(_one, county_ids):
            for ou, by_de in ous.items():
                tgt = merged.setdefault(ou, {})
                for de, cols in by_de.items():
                    b = tgt.setdefault(de, {})
                    for k, v in cols.items():
                        b[k] = b.get(k, 0.0) + v
    return merged


def commodity_scope_matrix(period, facility_ids, county_ids, forms=None):
    """Matrix restricted to a facility scope, ready for aggregation.

    {ou_id: {form_key: {de_id: {column: value}}}}
    Pass `forms` to fetch only the datasets you actually need.
    """
    wanted = set(facility_ids or ())
    forms = forms or sorted({t["form"] for t in config.COMMODITY_TRACERS})
    out = {}
    for form in forms:
        matrix = fetch_commodity_matrix(form, period, county_ids)
        for ou, by_de in matrix.items():
            if wanted and ou not in wanted:
                continue
            out.setdefault(ou, {})[form] = by_de
    return out


# --------------------------------------------------------------------------
# Background warm (default month across the whole JT scope)
# --------------------------------------------------------------------------
def warm_default_scope(period=None, scope=None):
    """Pre-fetch reporting rates + bulk metric detail + tracer commodities for
    the default month across a whole roster scope, so the first page load (or
    a month change) is served from cache. Cheap when caches are already valid;
    returns quickly.
    """
    scope = config.normalize_scope(scope)
    period = period or current_default_period()
    county_ids = _jt_county_ids(scope)
    if not county_ids:
        return
    try:
        import pandas as pd
        df = pd.read_csv(config.filters_csv(scope))
        facility_ids = list(dict.fromkeys(df["facility_id"].tolist()))
    except Exception:
        return
    datasets = resolve_moh_dataset_ids()
    for form in config.MOH_FORMS:
        ds = datasets.get(form["key"])
        if not ds or not facility_ids:
            continue
        # reporting rates (completeness) — cached 12h, no-op when valid
        fetch_reporting_rates(ds["id"], facility_ids, period, county_ids)
        # metric detail — county-wide bulk fetch, cached 12h, no-op when valid
        reported_metric_sets(ds["id"], period, facility_ids, county_ids)
    # tracer commodities (consumption & balances) — county-wide, cached 12h
    for form in sorted({t["form"] for t in config.COMMODITY_TRACERS}):
        if not datasets.get(form):
            continue
        fetch_commodity_matrix(form, period, county_ids)


def start_background_jobs():
    """One background job per host: resolve the default (latest closed) month
    and warm that month's caches. Guarded by an atomic dir so concurrent
    gunicorn workers don't each run it."""
    try:
        os.makedirs(config.CACHE_DIR, exist_ok=True)
        os.mkdir(os.path.join(config.CACHE_DIR, ".background"))  # one winner
    except FileExistsError:
        return
    except Exception:
        pass

    def _job():
        try:
            _resolve_default_period()
            warm_default_scope(period=current_default_period(),
                               scope=config.DEFAULT_SCOPE)
        except Exception:
            pass

    threading.Thread(target=_job, daemon=True).start()
