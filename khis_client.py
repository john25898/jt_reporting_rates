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
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests
from requests.auth import HTTPBasicAuth
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

import config

_lock = threading.Lock()
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
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)


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


def khis_reachable():
    """Cheap reachability probe against system/info with our credentials."""
    data = khis_get("system/info.json", {"fields": "version"}, timeout=20)
    return data is not None and bool(data.get("version"))
