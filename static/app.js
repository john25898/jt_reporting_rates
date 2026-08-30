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
  const wrap = $("overview-cards");
  wrap.innerHTML = "";
  d.forms.forEach((f) => {
    const s = f.summary;
    const rate = s.overall_rate;
    wrap.insertAdjacentHTML(
      "beforeend",
      `
      <div class="card overview-card" data-tablink="${f.key}">
        <h3>${f.title}</h3>
        <div class="ov-desc">${(FORM_INFO[f.key] || {}).short || ""}</div>
        <div class="big-rate ${rate == null ? "muted" : rate >= 80 ? "good" : rate >= 50 ? "warn" : "bad"}">${rate == null ? "—" : rate.toFixed(1) + "%"}</div>
        <div class="ov-stats">
          <span>${s.facilities_reported} / ${s.facilities_with_expected} reported</span>
          <span>Expected: ${s.expected_reports} · Actual: ${s.actual_reports}</span>
        </div>
        <div class="mini-bar"><div class="mini-fill" style="width:${rate == null ? 0 : Math.min(100, rate)}%"></div></div>
      </div>`,
    );
  });
  wrap.querySelectorAll("[data-tablink]").forEach((el) => {
    el.addEventListener("click", () => switchTab(el.dataset.tablink));
  });

  const list = $("overview-facility-list");
  const facs = d.forms[0] ? d.forms[0].facilities : [];
  list.innerHTML = facs.length
    ? facs
        .map((f) => {
          const rates = d.forms.map((form) => {
            const r = form.facilities.find(
              (x) => x.facility_id === f.facility_id,
            );
            return r && r.rate != null ? r.rate.toFixed(0) + "%" : "—";
          });
          return `<div class="facility-row"><span class="fname">${f.facility_name}</span>
                <span class="fmeta">${f.county_name} · ${f.subcounty_name} · ${f.ward_name}</span>
                <span class="frates">643B: ${rates[0]} &nbsp; 729: ${rates[1]} &nbsp; 730B: ${rates[2]}</span></div>`;
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
    <div class="card">
      <h3>${form.title} — Facility detail <span class="muted small">(${fmtMonth(state.period)} period)</span></h3>
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
    }
  });

  state.sort = { key: "rate", dir: -1 };
  renderMhoRows(key, form);
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
      return `<tr>
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
