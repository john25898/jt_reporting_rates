/* Jamii Tekelezi Reporting Rates — app logic (vanilla JS, no build step) */
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  locations: null,
  period: "202607",
  scope: {
    county_id: null,
    subcounty_id: null,
    ward_id: null,
    facility_id: null,
  },
  data: null,
  metrics: null, // /api/metrics-summary payload (per-MOH metric cards)
  sort: { key: "rate", dir: -1 }, // per-MOH table sort
};

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function fmtMonth(ym) {
  const y = ym.slice(0, 4);
  const m = parseInt(ym.slice(4, 6), 10) - 1;
  return `${MONTH_NAMES[m] || "?"} ${y}`;
}

/* ---------------- Form documentation ---------------- */

const FORM_INFO = {
  moh643: {
    full_name:
      "MOH 643B — Facility Consumption Data Report and Request (Lab Commodities)",
    short:
      "Inventory & resupply for lab reagents and diagnostic testing commodities.",
    tagline:
      "Primary inventory and resupply form for laboratory reagents and diagnostic testing commodities. Completed by the laboratory in-charge at the end of every month.",
    sections: [
      {
        title: "Commodities tracked",
        items: [
          {
            label: "HIV Testing",
            desc: "HIV Rapid Test Kits (RTKs).",
          },
          {
            label: "ART Monitoring",
            desc: "CD3/CD4 reporting reagents, Early Infant Diagnosis (EID) kits, and Viral Load (VL) consumables.",
          },
          {
            label: "General Lab",
            desc: "Basic Biochemistry and Haematology supplies.",
          },
        ],
      },
      {
        title: "Data fields / metrics (inventory logic)",
        items: [
          {
            label: "Beginning Balance",
            desc: "Stock available at the start of the reporting month — must logically match the ending balance of the previous month.",
          },
          {
            label: "Quantity Received",
            desc: "Stock delivered to the facility during the month.",
          },
          {
            label: "Total Used / Tests Done",
            desc: "Actual number of tests conducted successfully, excluding repeats or failed runs.",
          },
          {
            label: "Losses / Wastage",
            desc: "Commodities that expired, were damaged, or failed during quality control.",
          },
          {
            label: "Positive / Negative Adjustments",
            desc: "Stock borrowed from or lent to neighboring facilities.",
          },
          {
            label: "Ending Balance (Physical Count)",
            desc: "Actual stock counted on the shelves at the end of the month.",
          },
          {
            label: "Amount to Request",
            desc: "Calculated resupply quantity needed to prevent stock-outs.",
          },
        ],
      },
    ],
  },
  moh729: {
    full_name: "MOH 729 — Monthly ART / Patient Summary Report",
    short: "Clinical summary of the patient cohort on ART and OI treatment.",
    tagline:
      "Unlike the commodity forms, MOH 729 tracks human beings. It is the clinical summary of the patient cohort currently receiving Antiretroviral Therapy (ART) and Opportunistic Infection (OI) treatments.",
    sections: [
      {
        title: "Patient cohorts & categories tracked",
        items: [
          {
            label: "Current Active Patients (Tx_CURR)",
            desc: "Patients actively on a specific ARV or OI treatment regimen during the reporting period.",
          },
          {
            label: "Regimen Disaggregation",
            desc: "Patients broken down by exact treatment — e.g., Adult 1st Line, Adult 2nd Line, Pediatric regimens.",
          },
          {
            label: "New Patients (Tx_NEW)",
            desc: "Clients newly initiated on ART during that specific month.",
          },
          {
            label: "Patient Attrition / Retention",
            desc: "Clients who Transferred In (TI), Transferred Out (TO), stopped treatment, or were Lost to Follow-Up (LTFU).",
          },
          {
            label: "Special Populations",
            desc: "Pregnant and lactating mothers on PMTCT (Prevention of Mother-to-Child Transmission) and HIV-Exposed Infants (HEI).",
          },
        ],
      },
    ],
  },
  moh730: {
    full_name:
      "MOH 730B — Facility Consumption Data Report and Request (ARV & OI Commodities)",
    short: "Pharmacy consumption of ARV and opportunistic-infection drugs.",
    tagline:
      "This form bridges the gap between the patient numbers in MOH 729 and the pharmacy store. It tracks the physical consumption of pharmaceutical drugs used to treat HIV and opportunistic infections.",
    sections: [
      {
        title: "Commodities tracked",
        items: [
          {
            label: "Adult Antiretrovirals (ARVs)",
            desc: "e.g., TLD (Tenofovir/Lamivudine/Dolutegravir), TL, ATV/r.",
          },
          {
            label: "Pediatric ARVs",
            desc: "e.g., Pediatric LPV/r pellets, ABC/3TC formulations.",
          },
          {
            label: "Prophylaxis / OI Drugs",
            desc: "Medications for opportunistic infections such as Cotrimoxazole (Septrin), Fluconazole, Dapsone, and Isoniazid (for TB preventive therapy).",
          },
        ],
      },
      {
        title: "Data fields / metrics (pharmacy logic)",
        items: [
          {
            label: "Beginning Balance",
            desc: "Stock at the start of the month.",
          },
          {
            label: "Quantity Received",
            desc: "Drugs supplied to the pharmacy.",
          },
          {
            label: "Quantity Dispensed",
            desc: "Total pills/packs issued directly to patients — cross-references with the patient numbers in MOH 729.",
          },
          {
            label: "Losses & Wastage",
            desc: "Expired or damaged medication.",
          },
          {
            label: "Physical Count",
            desc: "Physical stock remaining at the end of the month.",
          },
          {
            label: "Days Out of Stock",
            desc: "Number of days the facility was completely unable to dispense a specific drug.",
          },
          {
            label: "Quantity Requested",
            desc: "The order placed for the next resupply cycle.",
          },
        ],
      },
    ],
  },
};

function renderFormInfo(key) {
  const info = FORM_INFO[key];
  if (!info) return "";
  const cols = info.sections
    .map(
      (sec) => `
      <div class="info-col">
        <h4>${sec.title}</h4>
        ${sec.items
          .map(
            (it) => `
          <div class="info-item">
            <div class="info-label">${it.label}</div>
            <div class="info-desc">${it.desc}</div>
          </div>`,
          )
          .join("")}
      </div>`,
    )
    .join("");
  return `
    <details class="card form-info" open>
      <summary>ℹ About this form — ${info.full_name}</summary>
      <p class="info-tagline">${info.tagline}</p>
      <div class="info-grid">${cols}</div>
    </details>`;
}

/* ---------------- Locations / filter cascade ---------------- */

async function loadLocations() {
  const res = await fetch(`/api/locations?cb=${Date.now()}`);
  state.locations = await res.json();

  const periodSel = $("period-select");
  periodSel.innerHTML = "";
  (state.locations.periods || ["202607"]).forEach((p) => {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = fmtMonth(p);
    if (p === state.locations.default_period) o.selected = true;
    periodSel.appendChild(o);
  });
  state.period = periodSel.value;

  renderStatus(state.locations);
  renderCountyOptions();
  updateScopeSummary();
  loadRates();
}

function renderStatus(loc) {
  const b = $("status-banner");
  b.classList.remove("hidden");
  if (!loc.khis_ok) {
    b.className = "status-banner error";
    b.textContent =
      "KHIS is currently unreachable (account may be locked). Reporting rates cannot be refreshed — showing cached data if available.";
    return;
  }
  const ds = loc.datasets || {};
  const missing =
    Object.values(ds).length < 3
      ? ` (resolved ${Object.values(ds).length}/3 dataset IDs)`
      : "";
  b.className = "status-banner ok";
  b.textContent = `KHIS connected · ${Object.values(ds)
    .map((d) => d.name)
    .join(" · ")}${missing}`;
}

function renderCountyOptions() {
  const sel = $("county-select");
  sel.innerHTML = '<option value="">All Counties</option>';
  state.locations.counties.forEach((c) => {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.name;
    sel.appendChild(o);
  });
  resetLevels("county");
}

function resetLevels(fromLevel) {
  if (fromLevel === "county") {
    $("county-select").value = "";
  }
  if (["county", "subcounty"].includes(fromLevel)) {
    $("subcounty-select").innerHTML =
      '<option value="">All Sub-Counties</option>';
    $("subcounty-select").value = "";
  }
  if (["county", "subcounty", "ward"].includes(fromLevel)) {
    $("ward-select").innerHTML = '<option value="">All Wards</option>';
    $("ward-select").value = "";
  }
  if (fromLevel !== "facility") {
    $("facility-select").innerHTML = '<option value="">All Facilities</option>';
    $("facility-select").value = "";
  }
}

function optionsFor(list, selected) {
  return list
    .map(
      (x) =>
        `<option value="${x.id}" ${x.id === selected ? "selected" : ""}>${x.name}</option>`,
    )
    .join("");
}

function onCountyChange() {
  const cid = $("county-select").value;
  resetLevels("subcounty");
  if (!cid) {
    updateScopeSummary();
    loadRates();
    return;
  }
  const subs = state.locations.subcounties.filter((s) => s.county_id === cid);
  $("subcounty-select").innerHTML =
    '<option value="">All Sub-Counties</option>' + optionsFor(subs, null);
  updateScopeSummary();
  loadRates();
}

function onSubcountyChange() {
  const sid = $("subcounty-select").value;
  resetLevels("ward");
  if (!sid) {
    updateScopeSummary();
    loadRates();
    return;
  }
  const wards = state.locations.wards.filter((w) => w.subcounty_id === sid);
  $("ward-select").innerHTML =
    '<option value="">All Wards</option>' + optionsFor(wards, null);
  updateScopeSummary();
  loadRates();
}

function onWardChange() {
  const wid = $("ward-select").value;
  resetLevels("facility");
  if (!wid) {
    updateScopeSummary();
    loadRates();
    return;
  }
  const facs = state.locations.facilities.filter((f) => f.ward_id === wid);
  $("facility-select").innerHTML =
    '<option value="">All Facilities</option>' + optionsFor(facs, null);
  updateScopeSummary();
  loadRates();
}

function onFacilityChange() {
  updateScopeSummary();
  loadRates();
}

function updateScopeSummary() {
  const cid = $("county-select").value,
    sid = $("subcounty-select").value,
    wid = $("ward-select").value,
    fid = $("facility-select").value;
  state.scope = {
    county_id: cid,
    subcounty_id: sid,
    ward_id: wid,
    facility_id: fid,
  };
  const names = [
    $("county-select").selectedOptions[0]?.text,
    $("subcounty-select").selectedOptions[0]?.text,
    $("ward-select").selectedOptions[0]?.text,
    $("facility-select").selectedOptions[0]?.text,
  ].filter((t) => t && !t.startsWith("All "));
  $("scope-summary").textContent = names.length
    ? `Scope: ${names.join(" → ")}`
    : `Scope: All ${state.locations?.total_facilities ?? ""} Jamii Tekelezi facilities`;
}

/* ---------------- Reporting rates ---------------- */

async function loadRates() {
  state.metrics = null; // stale metric summaries must not linger across scopes
  const p = new URLSearchParams({ period: state.period, cb: Date.now() });
  const s = state.scope;
  if (s.county_id) p.set("county_id", s.county_id);
  if (s.subcounty_id) p.set("subcounty_id", s.subcounty_id);
  if (s.ward_id) p.set("ward_id", s.ward_id);
  if (s.facility_id) p.set("facility_id", s.facility_id);

  $("loading").classList.remove("hidden");
  try {
    const res = await fetch(`/api/reporting-rates?${p.toString()}`);
    state.data = await res.json();
    renderAll();
  } catch (err) {
    $("loading").classList.add("hidden");
    showError(`Failed to load reporting rates: ${err.message}`);
  }
  loadMetrics();
}

/* Per-MOH metric reporting cards (tracked 2023-version metrics only) */
async function loadMetrics() {
  const p = new URLSearchParams({ period: state.period, cb: Date.now() });
  const s = state.scope;
  if (s.county_id) p.set("county_id", s.county_id);
  if (s.subcounty_id) p.set("subcounty_id", s.subcounty_id);
  if (s.ward_id) p.set("ward_id", s.ward_id);
  if (s.facility_id) p.set("facility_id", s.facility_id);

  try {
    const res = await fetch(`/api/metrics-summary?${p.toString()}`);
    state.metrics = await res.json();
    const byKey = {};
    (state.metrics.forms || []).forEach((f) => {
      byKey[f.key] = f;
    });
    ["moh643", "moh729", "moh730"].forEach((k) =>
      renderMetricCards(k, byKey[k]),
    );
    if (state.data) {
      // upgrade the overview with the metric story now that it has arrived
      renderFormCards(state.data);
      renderMetricsStory();
    }
  } catch (err) {
    // cards stay as placeholders; rates already rendered
  }
}

function renderAll() {
  $("loading").classList.add("hidden");
  const d = state.data;
  if (!d) return;
  // reuse the datasets resolved by /api/locations (state.locations)
  renderStatus({
    khis_ok: d.khis_ok,
    datasets: (state.locations && state.locations.datasets) || {},
  });

  renderOverview(d);
  const byKey = {};
  d.forms.forEach((f) => {
    byKey[f.key] = f;
  });
  renderMhoSection("moh643", byKey.moh643);
  renderMhoSection("moh729", byKey.moh729);
  renderMhoSection("moh730", byKey.moh730);
}

/* ---------------- Overview ---------------- */

function renderOverview(d) {
  $("overview-hero").innerHTML = renderHero(d);
  renderFormCards(d);
  renderMetricsStory();
  renderCountyMatrix(d);
  renderFacilityList(d);
}

/* Combined rate + "how many facilities did everything" story */
function combinedRates(d) {
  let exp = 0,
    act = 0;
  d.forms.forEach((f) => {
    exp += f.summary.expected_reports;
    act += f.summary.actual_reports;
  });
  return { expected: exp, actual: act, rate: exp ? (100 * act) / exp : null };
}

function complianceBuckets(d) {
  const facs = {};
  d.forms.forEach((f) => {
    f.facilities.forEach((r) => {
      if (!facs[r.facility_id])
        facs[r.facility_id] = { expected: 0, reported: 0 };
      if (r.expected) {
        facs[r.facility_id].expected += 1;
        if (r.reported) facs[r.facility_id].reported += 1;
      }
    });
  });
  const vals = Object.values(facs).filter((b) => b.expected > 0);
  // A facility may be assigned only some of the 3 forms (KHIS assignment
  // differs per dataset) — buckets must honour each facility's own assignment.
  const assignedAll3 = vals.filter((b) => b.expected === 3);
  const all3 = assignedAll3.filter((b) => b.reported === 3).length;
  const completeAssigned = vals.filter(
    (b) => b.reported === b.expected && b.expected < 3,
  ).length; // 1/1 or 2/2 — fully reported what they were assigned
  const partial = vals.filter(
    (b) => b.reported > 0 && b.reported < b.expected,
  ).length;
  const none = vals.filter((b) => b.reported === 0).length;
  return {
    total: vals.length,
    assignedAll3: assignedAll3.length,
    all3,
    completeAssigned,
    partial,
    none,
  };
}

function renderHero(d) {
  const c = combinedRates(d);
  const cb = complianceBuckets(d);
  const rate = c.rate;
  let verdict, verdictCls;
  if (rate == null) {
    verdict = "No report data for this scope yet.";
    verdictCls = "muted";
  } else if (rate >= 90) {
    verdict = `Strong month — ${rate.toFixed(1)}% of expected reports were submitted.`;
    verdictCls = "good";
  } else if (rate >= 75) {
    const missed = cb.total - cb.all3 - cb.completeAssigned;
    verdict = `Solid month — ${rate.toFixed(1)}% submitted, but ${missed} facility(-ies) did not complete everything assigned to them.`;
    verdictCls = "warn";
  } else {
    verdict = `Attention needed — only ${rate.toFixed(1)}% of expected reports were submitted.`;
    verdictCls = "bad";
  }
  const pct = (n) => (cb.total ? Math.round((100 * n) / cb.total) : 0);
  return `
    <div class="card ov-hero">
      <div class="ov-hero-left">
        <div class="ov-kicker">${fmtMonth(state.period)} · ${(d.scope || {}).facility_count ?? ""} facilities in scope</div>
        <div class="ov-hero-main">
          <span class="big-rate ${rate == null ? "muted" : rate >= 90 ? "good" : rate >= 75 ? "warn" : "bad"}">${rate == null ? "—" : rate.toFixed(1) + "%"}</span>
          <div>
            <div class="ov-hero-title">of expected monthly reports submitted</div>
            <div class="ov-hero-sub muted">${c.actual.toLocaleString()} of ${c.expected.toLocaleString()} expected reports across MOH 643 B · 729 · 730 B (2023 versions)</div>
          </div>
        </div>
        <p class="ov-verdict ${verdictCls}">${verdict}</p>
      </div>
      <div class="ov-hero-right">
        <div class="ov-hero-title">Facilities completing ALL THREE forms</div>
        <div class="ov-hero-num">${cb.all3} <span class="muted">/ ${cb.assignedAll3}</span></div>
        <div class="compliance-bar">
          <div class="compliance-seg seg-all" style="width:${pct(cb.all3)}%" title="All 3 forms"></div>
          <div class="compliance-seg seg-assigned" style="width:${pct(cb.completeAssigned)}%" title="All assigned forms"></div>
          <div class="compliance-seg seg-part" style="width:${pct(cb.partial)}%" title="Partial"></div>
          <div class="compliance-seg seg-none" style="width:${pct(cb.none)}%" title="No form"></div>
        </div>
        <div class="compliance-legend">
          <span><i class="dot dot-all"></i>All 3 (${cb.all3})</span>
          <span><i class="dot dot-assigned"></i>All assigned ✓ (${cb.completeAssigned})</span>
          <span><i class="dot dot-part"></i>Partial (${cb.partial})</span>
          <span><i class="dot dot-none"></i>None (${cb.none})</span>
        </div>
      </div>
    </div>`;
}

function renderFormCards(d) {
  const wrap = $("overview-cards");
  wrap.innerHTML = "";
  d.forms.forEach((f) => {
    const s = f.summary;
    const rate = s.overall_rate;
    const info = FORM_INFO[f.key] || {};
    const mf =
      state.metrics && state.metrics.forms
        ? state.metrics.forms.find((x) => x.key === f.key)
        : null;
    const badge =
      f.key === "moh643" ? "643B" : f.key === "moh729" ? "729" : "730B";
    wrap.insertAdjacentHTML(
      "beforeend",
      `
      <div class="card overview-card" data-tablink="${f.key}">
        <span class="ov-form-badge">${badge}</span>
        <h3>${f.title}</h3>
        <div class="ov-desc">${info.short || ""}</div>
        <div class="big-rate ${rate == null ? "muted" : rate >= 80 ? "good" : rate >= 50 ? "warn" : "bad"}">${rate == null ? "—" : rate.toFixed(1) + "%"}</div>
        <div class="ov-stats">
          <span>${s.facilities_reported} / ${s.facilities_with_expected} facilities submitted</span>
          <span>Expected: ${s.expected_reports} · Actual: ${s.actual_reports}</span>
          ${mf && mf.total_metrics ? `<span class="ov-metric-line">Metrics ${mf.overall_metric_rate == null ? "—" : mf.overall_metric_rate.toFixed(1) + "%"} · ${mf.total_metrics} tracked</span>` : ""}
        </div>
        <div class="mini-bar"><div class="mini-fill ${rate == null ? "" : rate >= 80 ? "bar-good" : rate >= 50 ? "bar-warn" : "bar-bad"}" style="width:${rate == null ? 0 : Math.min(100, rate)}%"></div></div>
      </div>`,
    );
  });
  wrap.querySelectorAll("[data-tablink]").forEach((el) => {
    el.addEventListener("click", () => switchTab(el.dataset.tablink));
  });
}

/* Metrics narrative — combines the three forms' tracked 2023 metrics */
function metricsStory(m) {
  if (!m || !m.forms) return null;
  const forms = m.forms.filter((f) => f.total_metrics > 0);
  const merged = [];
  let sumReported = 0,
    sumDenom = 0;
  forms.forEach((f) => {
    sumReported += f.reported_facility_metrics || 0;
    sumDenom += (f.facilities || 0) * (f.total_metrics || 0);
    (f.metrics || []).forEach((mt) =>
      merged.push({
        name: mt.name,
        reported: mt.reported,
        total: mt.total,
        form: f.key === "moh643" ? "643B" : f.key === "moh729" ? "729" : "730B",
      }),
    );
  });
  if (!merged.length) return null;
  merged.forEach((mt) => {
    mt.pct = mt.total ? (100 * mt.reported) / mt.total : 0;
  });
  merged.sort((a, b) => a.pct - b.pct || b.total - a.total);
  return {
    tracked: merged.length,
    overallRate: sumDenom ? (100 * sumReported) / sumDenom : null,
    reported: sumReported,
    worst: merged.slice(0, 8),
    best: merged.slice(-8).reverse(),
    green: merged.filter((x) => x.pct >= 80).length,
    amber: merged.filter((x) => x.pct >= 50 && x.pct < 80).length,
    red: merged.filter((x) => x.pct < 50).length,
  };
}

function renderMetricsStory() {
  const wrap = $("overview-metrics");
  const story = metricsStory(state.metrics);
  if (!story) {
    wrap.innerHTML = `
      <div class="card">
        <div class="metric-head">
          <h3>Metric reporting <span class="muted small">— tracked 2023-version metrics</span></h3>
        </div>
        <p class="muted small">Loading metric detail from KHIS… (first load takes about a minute, then it's cached)</p>
      </div>`;
    return;
  }
  const rate = story.overallRate;
  const seg = (n) =>
    story.tracked ? Math.max(2, Math.round((100 * n) / story.tracked)) : 0;
  const row = (mt) => `
    <tr>
      <td class="metric-name">${escapeHtml(mt.name)}</td>
      <td><span class="form-tag">${mt.form}</span></td>
      <td class="num">${mt.reported} / ${mt.total}</td>
      <td class="num">${mt.pct.toFixed(0)}%</td>
      <td><div class="cov-bar"><div class="cov-fill ${mt.pct >= 80 ? "bar-good" : mt.pct >= 50 ? "bar-warn" : "bar-bad"}" style="width:${Math.min(100, mt.pct)}%"></div></div></td>
    </tr>`;
  wrap.innerHTML = `
    <div class="card">
      <div class="metric-head">
        <h3>Metric reporting <span class="muted small">— the ${story.tracked} tracked 2023-version metrics across the 3 forms</span></h3>
      </div>
      <div class="cards-grid">
        <div class="card stat-card"><div class="stat-label">Tracked metrics (2023)</div><div class="stat-value">${story.tracked}</div></div>
        <div class="card stat-card"><div class="stat-label">Reported facility-metrics</div><div class="stat-value">${story.reported.toLocaleString()}</div></div>
        <div class="card stat-card accent"><div class="stat-label">Overall metric reporting rate</div><div class="stat-value ${rate == null ? "muted" : rate >= 80 ? "good" : rate >= 50 ? "warn" : "bad"}">${rate == null ? "—" : rate.toFixed(1) + "%"}</div></div>
      </div>

      <div class="cov-dist">
        <div class="cov-dist-bar">
          <div class="cov-dist-seg d-green" style="width:${seg(story.green)}%" title="${story.green} metrics ≥80%"></div>
          <div class="cov-dist-seg d-amber" style="width:${seg(story.amber)}%" title="${story.amber} metrics 50–79%"></div>
          <div class="cov-dist-seg d-red" style="width:${seg(story.red)}%" title="${story.red} metrics <50%"></div>
        </div>
        <div class="cov-dist-legend">
          <span><i class="dot dot-all"></i>${story.green} metrics reported by ≥80% of facilities</span>
          <span><i class="dot dot-part"></i>${story.amber} by 50–79%</span>
          <span><i class="dot dot-none"></i>${story.red} by &lt;50% — biggest gaps</span>
        </div>
      </div>

      <div class="metric-rank-grid">
        <div class="rank-col">
          <h4>🔻 Most often missing <span class="muted small">(lowest coverage)</span></h4>
          <table class="coverage-table">
            <thead><tr><th>Metric</th><th>Form</th><th class="num">Coverage</th><th>Bar</th></tr></thead>
            <tbody>${story.worst.map(row).join("")}</tbody>
          </table>
        </div>
        <div class="rank-col">
          <h4>🔺 Best reported <span class="muted small">(highest coverage)</span></h4>
          <table class="coverage-table">
            <thead><tr><th>Metric</th><th>Form</th><th class="num">Coverage</th><th>Bar</th></tr></thead>
            <tbody>${story.best.map(row).join("")}</tbody>
          </table>
        </div>
      </div>
    </div>`;
}

/* County × form matrix (click a county to filter) */
function countyMatrix(d) {
  const facs = {};
  d.forms.forEach((f) => {
    f.facilities.forEach((r) => {
      if (!facs[r.facility_id])
        facs[r.facility_id] = { county: r.county_name, byForm: {} };
      facs[r.facility_id].byForm[f.key] = {
        expected: r.expected,
        reported: r.reported,
      };
    });
  });
  const byCounty = {};
  Object.values(facs).forEach((b) => {
    if (!byCounty[b.county]) byCounty[b.county] = { name: b.county, facs: [] };
    byCounty[b.county].facs.push(b);
  });
  return Object.values(byCounty).map((c) => {
    const formRates = d.forms.map((f) => {
      let exp = 0,
        act = 0;
      c.facs.forEach((b) => {
        const s = b.byForm[f.key] || {};
        if (s.expected) {
          exp += 1;
          if (s.reported) act += 1;
        }
      });
      return { key: f.key, rate: exp ? (100 * act) / exp : null };
    });
    const all3 = c.facs.filter((b) => {
      const expKeys = Object.values(b.byForm).filter((s) => s.expected);
      return expKeys.length >= 3 && expKeys.every((s) => s.reported);
    }).length;
    return { name: c.name, nFac: c.facs.length, formRates, all3 };
  });
}

function renderCountyMatrix(d) {
  const wrap = $("overview-counties");
  const rows = countyMatrix(d);
  if (!rows.length) {
    wrap.innerHTML = "";
    return;
  }
  const badge = (k) =>
    k === "moh643" ? "643B" : k === "moh729" ? "729" : "730B";
  const chip = (rate) =>
    `<span class="rate-chip ${rate == null ? "muted" : rate >= 80 ? "chip-good" : rate >= 50 ? "chip-warn" : "chip-bad"}">${rate == null ? "—" : rate.toFixed(0) + "%"}</span>`;
  wrap.innerHTML = `
    <div class="card">
      <div class="metric-head">
        <h3>By county <span class="muted small">— reporting rate per form · click a county to zoom into it</span></h3>
      </div>
      <table class="rate-table county-table">
        <thead><tr>
          <th>County</th><th class="num">Facilities</th>
          ${d.forms.map((f) => `<th class="num">${badge(f.key)}</th>`).join("")}
          <th class="num">All 3 forms</th>
        </tr></thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr class="county-row" data-county="${escapeHtml(r.name)}">
              <td class="fname">${escapeHtml(r.name)}</td>
              <td class="num">${r.nFac}</td>
              ${r.formRates.map((fr) => `<td class="num">${chip(fr.rate)}</td>`).join("")}
              <td class="num"><span class="pill ${r.all3 === r.nFac ? "ok" : r.all3 > 0 ? "warn-pill" : "bad"}">${r.all3} / ${r.nFac}</span></td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
  wrap.querySelectorAll("[data-county]").forEach((el) => {
    el.addEventListener("click", () => {
      const sel = $("county-select");
      const opt = [...sel.options].find(
        (o) => o.textContent === el.dataset.county,
      );
      if (opt && sel.value !== opt.value) {
        sel.value = opt.value;
        onCountyChange();
      }
    });
  });
}

function renderFacilityList(d) {
  const list = $("overview-facility-list");
  const allFacs = {};
  d.forms.forEach((f) => {
    f.facilities.forEach((r) => {
      if (!allFacs[r.facility_id])
        allFacs[r.facility_id] = {
          name: r.facility_name,
          county: r.county_name,
          sub: r.subcounty_name,
          ward: r.ward_name,
          expected: 0,
          reported: 0,
          byForm: {},
        };
      const b = allFacs[r.facility_id];
      b.byForm[f.key] = r;
      if (r.expected) {
        b.expected += 1;
        if (r.reported) b.reported += 1;
      }
    });
  });
  const vals = Object.values(allFacs);
  list.innerHTML = vals.length
    ? vals
        .map((f) => {
          const rates = d.forms.map((form) => {
            const r = f.byForm[form.key];
            return r && r.rate != null ? r.rate.toFixed(0) + "%" : "—";
          });
          const pill =
            f.expected === 0
              ? `<span class="pill mute">Unassigned</span>`
              : f.reported === f.expected
                ? f.expected >= 3
                  ? `<span class="pill ok">All 3 ✓</span>`
                  : `<span class="pill ok">${f.reported}/${f.expected} ✓</span>`
                : f.reported > 0
                  ? `<span class="pill warn-pill">${f.reported}/${f.expected} forms</span>`
                  : `<span class="pill bad">None</span>`;
          return `<div class="facility-row"><span class="fname">${f.name}</span>
                <span class="fmeta">${f.county} · ${f.sub} · ${f.ward}</span>
                <span class="frates">643B: ${rates[0]} &nbsp; 729: ${rates[1]} &nbsp; 730B: ${rates[2]}</span>
                ${pill}</div>`;
        })
        .join("")
    : '<p class="muted">No facilities in scope.</p>';
}

/* ---------------- Per-MOH section ---------------- */

function renderMhoSection(key, form) {
  const panel = $(`tab-${key}`);
  if (!form) {
    panel.innerHTML =
      '<div class="card"><p class="muted">No data for this form.</p></div>';
    return;
  }
  const s = form.summary;
  const rate = s.overall_rate;
  panel.innerHTML = `
    ${renderFormInfo(key)}
    <div class="cards-grid">
      <div class="card stat-card"><div class="stat-label">Facilities in scope</div><div class="stat-value">${s.facilities_in_scope}</div></div>
      <div class="card stat-card"><div class="stat-label">Expected reports</div><div class="stat-value">${s.expected_reports}</div></div>
      <div class="card stat-card"><div class="stat-label">Actual reports</div><div class="stat-value">${s.actual_reports}</div></div>
      <div class="card stat-card"><div class="stat-label">Facilities reported</div><div class="stat-value">${s.facilities_reported} / ${s.facilities_with_expected}</div></div>
      <div class="card stat-card accent"><div class="stat-label">Reporting rate</div><div class="stat-value ${rate == null ? "muted" : rate >= 80 ? "good" : rate >= 50 ? "warn" : "bad"}">${rate == null ? "—" : rate.toFixed(1) + "%"}</div></div>
    </div>
    <div class="metric-cards-holder"></div>
    <div class="card">
      <h3>${form.title} — Facility detail <span class="muted small">(${fmtMonth(state.period)} period)</span></h3>
      <p class="muted small hint">Click any facility row to open its per-metric reporting page.</p>
      <table class="rate-table">
        <thead><tr>
          <th data-sort="facility_name">Facility</th>
          <th data-sort="county_name">County</th>
          <th data-sort="subcounty_name">Sub-County</th>
          <th data-sort="ward_name">Ward</th>
          <th data-sort="expected" class="num">Expected</th>
          <th data-sort="actual" class="num">Actual</th>
          <th data-sort="rate" class="num">Rate</th>
          <th>Status</th>
        </tr></thead>
        <tbody id="${key}-tbody"></tbody>
      </table>
    </div>`;

  const tbody = $(`${key}-tbody`);
  tbody.addEventListener("click", (ev) => {
    const th = ev.target.closest("th[data-sort]");
    if (th) {
      toggleSort(key, th.dataset.sort, form);
      return;
    }
    const tr = ev.target.closest("tr.frow");
    if (tr) openFacilityPage(key, form, tr.dataset.fid);
  });

  state.sort = { key: "rate", dir: -1 };
  renderMhoRows(key, form);
  const mf =
    state.metrics && state.metrics.forms
      ? state.metrics.forms.find((f) => f.key === key)
      : null;
  if (mf) renderMetricCards(key, mf);
}

function renderMhoRows(key, form) {
  const tbody = $(`${key}-tbody`);
  const { key: sortKey, dir } = state.sort;
  const facs = [...form.facilities].sort((a, b) => {
    if (sortKey === "rate") {
      const av = a.rate == null ? -1 : a.rate,
        bv = b.rate == null ? -1 : b.rate;
      return (av - bv) * dir;
    }
    const av = a[sortKey] ?? "",
      bv = b[sortKey] ?? "";
    return String(av).localeCompare(String(bv)) * dir;
  });

  tbody.innerHTML = facs
    .map((f) => {
      const pill = f.reported
        ? "pill ok"
        : f.expected
          ? "pill bad"
          : "pill mute";
      const label = f.reported
        ? "Reported"
        : f.expected
          ? "Not reported"
          : "No data";
      const barW = f.rate == null ? 0 : Math.min(100, f.rate);
      const barCls =
        f.rate == null
          ? ""
          : f.rate >= 80
            ? "bar-good"
            : f.rate >= 50
              ? "bar-warn"
              : "bar-bad";
      return `<tr class="frow" data-fid="${f.facility_id}">
      <td class="fname">${f.facility_name}</td>
      <td>${f.county_name}</td>
      <td>${f.subcounty_name}</td>
      <td>${f.ward_name}</td>
      <td class="num">${f.expected}</td>
      <td class="num">${f.actual}</td>
      <td class="num">${f.rate == null ? "—" : f.rate.toFixed(1) + "%"}
        <div class="rate-bar"><div class="rate-fill ${barCls}" style="width:${barW}%"></div></div></td>
      <td><span class="${pill}">${label}</span></td>
    </tr>`;
    })
    .join("");
}

function toggleSort(key, sortKey, form) {
  if (state.sort.key === sortKey) {
    state.sort.dir *= -1;
  } else {
    state.sort = { key: sortKey, dir: 1 };
  }
  renderMhoRows(key, form);
}

/* ---------------- Facility page + per-MOH metric cards ---------------- */

function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

function formatNum(v) {
  if (typeof v === "number") return v.toLocaleString("en-US");
  return String(v ?? "\u2014");
}

/* Clicking a facility row opens a dedicated page showing how many of each
   metric per dataset were reported for that facility + month. */
function openFacilityPage(key, form, fid) {
  const url = `/facility?facility_id=${encodeURIComponent(fid)}&period=${state.period}`;
  window.open(url, "_blank");
}

/* "More cards per MOH tab" — metrics reporting for the tracked 2023 version:
   tracked metrics, facilities reporting, overall metric rate + per-metric
   coverage table. */
function renderMetricCards(key, mf) {
  const panel = $(`tab-${key}`);
  const holder = panel && panel.querySelector(".metric-cards-holder");
  if (!holder) return;
  if (!mf) {
    holder.innerHTML =
      '<div class="card"><p class="muted">Metric reporting unavailable for this form.</p></div>';
    return;
  }
  const total = mf.total_metrics;
  const rate = mf.overall_metric_rate;
  const rows = (mf.metrics || [])
    .map((m) => {
      const pct = m.total ? Math.round((100 * m.reported) / m.total) : 0;
      const cls = pct >= 80 ? "bar-good" : pct >= 50 ? "bar-warn" : "bar-bad";
      return `<tr>
        <td class="metric-name">${escapeHtml(m.name)}</td>
        <td class="num">${m.reported} / ${m.total}</td>
        <td class="num">${pct}%</td>
        <td><div class="cov-bar"><div class="cov-fill ${cls}" style="width:${pct}%"></div></div></td>
      </tr>`;
    })
    .join("");
  holder.innerHTML = `
    <div class="card metric-block">
      <div class="metric-head">
        <h3>Metrics reporting <span class="version-badge">v${escapeHtml(mf.version || "")}</span></h3>
        <span class="muted small">Only metrics belonging to the ${escapeHtml(mf.version || "")} version of this form are tracked — older/newer elements are ignored.</span>
      </div>
      <div class="cards-grid">
        <div class="card stat-card"><div class="stat-label">Tracked metrics</div><div class="stat-value">${total}</div></div>
        <div class="card stat-card"><div class="stat-label">Facilities reporting ≥1 metric</div><div class="stat-value">${mf.any_reported} / ${mf.facilities}</div></div>
        <div class="card stat-card accent"><div class="stat-label">Metric reporting rate</div><div class="stat-value ${rate == null ? "muted" : rate >= 80 ? "good" : rate >= 50 ? "warn" : "bad"}">${rate == null ? "—" : rate.toFixed(1) + "%"}</div></div>
        <div class="card stat-card"><div class="stat-label">Reported facility-metrics</div><div class="stat-value">${mf.reported_facility_metrics}</div></div>
      </div>
      <details class="metric-coverage" open>
        <summary>Per-metric coverage <span class="muted small">(${(mf.metrics || []).length} metrics)</span></summary>
        <table class="metric-table coverage-table">
          <thead><tr><th>Metric</th><th class="num">Facilities reported</th><th class="num">Coverage</th><th>Bar</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </details>
    </div>`;
}

/* ---------------- Tabs & misc ---------------- */

function switchTab(tab) {
  document
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  document
    .querySelectorAll(".tab-panel")
    .forEach((p) => p.classList.toggle("active", p.id === `tab-${tab}`));
  if (tab === "overview" && state.data) renderOverview(state.data);
}

function showError(msg) {
  const b = $("status-banner");
  b.className = "status-banner error";
  b.textContent = msg;
  b.classList.remove("hidden");
}

/* ---------------- init ---------------- */

document.addEventListener("DOMContentLoaded", () => {
  $("county-select").addEventListener("change", onCountyChange);
  $("subcounty-select").addEventListener("change", onSubcountyChange);
  $("ward-select").addEventListener("change", onWardChange);
  $("facility-select").addEventListener("change", onFacilityChange);
  $("period-select").addEventListener("change", () => {
    state.period = $("period-select").value;
    loadRates();
  });
  $("refresh-btn").addEventListener("click", () => loadRates());
  $("tabs-nav").addEventListener("click", (ev) => {
    const btn = ev.target.closest(".tab");
    if (btn) switchTab(btn.dataset.tab);
  });
  loadLocations();
});
