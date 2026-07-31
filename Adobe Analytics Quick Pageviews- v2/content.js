let pageIdentifier = {};
let chartInstances = {};
let currentDatePreset = "7d"; // default preset
let spaDebounceTimer = null;
let fetchPageDataAttempts = 0;
const SPA_DEBOUNCE_MS = 1500; // debounce SPA navigation re-fetches
const MINIMAL_DATE_PRESET = "7d";
const MAX_FETCH_PAGE_DATA_ATTEMPTS = 15;

if (globalThis.debugExtension === undefined) {
  globalThis.debugExtension = false;
}

function inInitCharts() {
  Chart.defaults.color = "#ddd";
  Chart.defaults.borderColor = "#333";
  Chart.defaults.font.size = 8;
  Chart.defaults.font.family = "Arial";
}
inInitCharts();

// Inject page-context script for window variable paths and SPA detection
window.addEventListener("load", () => {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("getPageIdentifiers.js");
  (document.head || document.documentElement).appendChild(script);
});

window.addEventListener("load", async () => {
  const isWidgetEnabled = await getEnableOnPageFlag();
  if (isWidgetEnabled == false) return;

  const isDomainAllowed = await checkCurrentDomainAllowed();
  if (!isDomainAllowed) return;

  currentDatePreset = await getSavedDatePreset();

  await delay(1); // wait for injected script (window variable path resolution)
  loadWidgetOnThePage();
});

window.addEventListener("pageIdentifierWindowPathValue", async (e) => {
  if (!e.detail || !e.detail.pageIdentifier) return;
  pageIdentifier.value = e.detail.pageIdentifier.value;
  if (typeof window.updateWidgetWithPageData === "function") {
    await window.updateWidgetWithPageData();
  }
});

// =====================
// SPA Navigation Handler
// =====================
window.addEventListener("spaNavigationDetected", (e) => {
  if (spaDebounceTimer) clearTimeout(spaDebounceTimer);
  spaDebounceTimer = setTimeout(() => {
    handleSpaNavigation();
  }, SPA_DEBOUNCE_MS);
});

async function handleSpaNavigation() {
  if (!document.getElementById("aa-extension-root")) return;

  if (typeof window.refetchPageDataForSpa === "function") {
    await window.refetchPageDataForSpa();
  }
}

function delay(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

// =====================
// Date Preset Helpers
// =====================
async function getSavedDatePreset() {
  const response = await sendMessageAsync({ type: "GET_DATE_PRESET" });

  if (!response) return "7d";

  return response.datePreset || "7d";
}

async function saveDatePreset(preset) {
  await sendMessageAsync({ type: "SET_DATE_PRESET", datePreset: preset });
}

const DATE_PRESET_LABELS = {
  "7d": "Last 7 Days",
  "3w": "Last 3 Weeks",
  "5w": "Last 5 Weeks",
  "3m": "Last 3 Months",
  "6m": "Last 6 Months",
};

function formatLargeNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return "0";
  num = Number(num);
  if (num < 0) return "-" + formatLargeNumber(Math.abs(num));
  if (num >= 1_000_000_000) {
    const val = num / 1_000_000_000;
    return val % 1 === 0 ? val.toFixed(0) + "B" : val.toFixed(2).replace(/\.?0+$/, "") + "B";
  }
  if (num >= 1_000_000) {
    const val = num / 1_000_000;
    return val % 1 === 0 ? val.toFixed(0) + "M" : val.toFixed(2).replace(/\.?0+$/, "") + "M";
  }
  return num.toLocaleString();
}

function compute7dDailyAverage(pageData) {
  const total7dPV = pageData?.filteredTotals?.[0] || 0;
  const dayCount = pageData?.pageViews?.length || 0;
  if (!dayCount) return 0;
  return Math.round(total7dPV / dayCount);
}

function applyCompactValueClass(el, formattedValue) {
  if (!el) return;
  const len = String(formattedValue).length;
  el.classList.remove("pv-value-compact", "pv-value-tight");
  if (len > 9) el.classList.add("pv-value-tight");
  else if (len > 6) el.classList.add("pv-value-compact");
}

function normalizeDomainEntry(entry) {
  return String(entry || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
}

function hostnameMatchesDomain(hostname, domain) {
  const host = hostname.toLowerCase();
  const normalized = normalizeDomainEntry(domain);
  if (!normalized) return false;
  return host === normalized || host.endsWith("." + normalized);
}

async function checkCurrentDomainAllowed() {
  const { allowedDomains } = await chrome.storage.local.get("allowedDomains");
  if (!allowedDomains || !Array.isArray(allowedDomains) || allowedDomains.length === 0) {
    return true;
  }
  return allowedDomains.some((domain) => hostnameMatchesDomain(window.location.hostname, domain));
}

async function loadWidgetOnThePage() {
  if (document.getElementById("aa-extension-root")) {
    return;
  }
  // ---------- create host ----------
  const host = document.createElement("div");
  host.id = "aa-extension-root";
  // make host non-intrusive but allow children to accept events
  host.style.all = "initial";
  document.documentElement.appendChild(host);

  // ---------- shadow ----------
  const shadow = host.attachShadow({ mode: "open" });

  // ---------- styles ----------
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }

    .badge {
      position: fixed;
      top: 120px;
      right: 8px;
      width: 200px;
      max-width:  50vw;
      min-width: 200px;
      max-height: 95vh;
      color: #fff;
      background: #111;
      border-left: 3px solid #75c8bb;
      border-radius: 8px 0 0 8px;
      box-shadow: -4px 4px 18px rgba(0, 0, 0, .5);

      transition: 
        width 0.28s cubic-bezier(.4,0,.2,1),
        max-width 0.28s cubic-bezier(.4,0,.2,1),
        opacity 0.18s ease;
      pointer-events: auto;
      font-family: Arial, Helvetica, sans-serif;

      overflow: hidden;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
    }

    /* header only */
    .badge.collapsed .badge-body {
      display: none;
    }

    /* minimal — dynamic width between min and max */
    .badge.minimal {
      width: fit-content;
      min-width: 200px;
      max-width: min(300px, 45vw);
    }

    .badge.minimal .badge-header {
      white-space: nowrap;
    }

    .badge.minimal .badge-title {
      font-size: clamp(11px, 2.8vw, 13px);
    }

    /* minimal layout — Option A */
    .badge.minimal .minimal-section {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .pv-row {
      display: flex;
      gap: 6px;
    }

    .pv-row .pv-box {
      flex: 1;
      min-width: 0;
      overflow: hidden;
    }

    .badge.minimal .pv-label {
      font-size: 9px;
      letter-spacing: 0.4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .pv-substat {
      font-size: 9px;
      font-weight: 500;
      margin-top: 2px;
      line-height: 1.2;
      color: #888;
      opacity: 0.9;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .minimal-metrics-row {
      display: flex;
      justify-content: space-between;
      gap: 6px;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 6px;
      padding: 5px 8px;
      font-size: 10px;
      color: #aaa;
    }

    .minimal-metrics-row strong {
      color: #75c8bb;
      font-weight: 700;
    }

    .minimal-footer-row {
      display: flex;
      gap: 6px;
      align-items: stretch;
    }

    .minimal-total-box {
      flex: 1;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 6px;
      padding: 6px;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    .minimal-total-label {
      font-size: 9px;
      opacity: 0.6;
      letter-spacing: 0.5px;
      margin-bottom: 2px;
    }

    .minimal-total-value {
      font-size: 14px;
      font-weight: bold;
      color: #ccc;
    }

    .minimal-footer-row .pv-box {
      flex: 0 0 56px;
    }

    /* small (today/yesterday) */
    .badge.minimal .badge-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      justify-content: flex-start; 
    }

    /* full dashboard */
    .badge.expanded .badge-body {
      display: block;
    }

    .badge-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      gap: 8px;
      cursor: grab;
      user-select: none;
    }

    .badge-title {
      display:flex;
      align-items:center;
      gap:6px;
      font-size:13px;
      font-weight:600;
      color: #ffffff;
    }

    .badge-ident {
      display:inline-block;
      background: #75c8bbff;
      color:#000;
      font-size:10px;
      padding:2px 6px;
      border-radius:4px;
      font-weight:700;
    }

    /* Info icon for data delay disclaimer */
    .info-tip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 15px;
      height: 15px;
      border-radius: 50%;
      font-size: 9px;
      font-weight: 700;
      color: #999;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      cursor: help;
      position: relative;
      flex-shrink: 0;
    }

    .info-tip .info-tooltip {
      display: none;
      position: absolute;
      top: 22px;
      right: 0;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 6px;
      padding: 6px 8px;
      font-size: 11px;
      font-weight: 400;
      color: #ccc;
      line-height: 1.4;
      z-index: 100;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      white-space: nowrap;
    }

    .info-tooltip-expanded {
      width: 200px;
      white-space: normal !important;
      right: auto;
      left: 0;
    }

    /* Minimal: show short, hide full */
    .badge.minimal .info-tooltip-expanded { display: none !important; }
    .badge.minimal .info-tip:hover .info-tooltip-minimal { display: block; }

    /* Expanded: show full, hide short */
    .badge.expanded .info-tooltip-minimal { display: none !important; }
    .badge.expanded .info-tip:hover .info-tooltip-expanded { display: block; }

    /* Collapsed: show short on hover */
    .badge.collapsed .info-tooltip-expanded { display: none !important; }
    .badge.collapsed .info-tip:hover .info-tooltip-minimal { display: block; }

    .info-tip:hover .info-tooltip {
      display: block;
    }

    .toggle-wrap {
      display:flex;
      align-items:center;
      gap: 6px;
    }

    .header-icon-btn {
      background: transparent;
      border: none;
      color: #777;
      font-size: 18px;
      cursor: pointer;
      padding: 2px;
      line-height: 1;
      transition: color 0.15s;
    }

    .header-icon-btn:hover {
      color: #75c8bb;
    }

    .feedback-link {
      font-size: 10px;
      color: #666;
      text-decoration: none;
      cursor: pointer;
      transition: color 0.15s;
    }

    .feedback-link:hover {
      color: #75c8bb;
      text-decoration: underline;
    }

    /* small toggle switch */
    .switch {
      position: relative;
      width: 40px;
      height: 20px;
      display:inline-block;
    }
    .switch input { display:none; }
    .slider {
      position:absolute;
      inset:0;
      background: #555;
      border-radius:20px;
      transition: background .18s;
    }
    .slider:before {
      content: "";
      position: absolute;
      left: 2px;
      top: 2px;
      width: 16px;
      height: 16px;
      background: #fff;
      border-radius: 50%;
      transition: transform .18s;
    }
    input:checked + .slider {
      background: #75c8bbff;
    }
    input:checked + .slider:before {
      transform: translateX(20px);
    }

    .badge-body {
      padding: 6px 8px;
      background: #0e0e0e;
      border-top: 1px solid #222;
      pointer-events: auto;
      position: relative;
    }

    .pv-box {
      flex: 1;
      background: #1a1a1aff;
      border: 1px solid #2a2a2a;
      border-radius: 6px;
      padding: 6px;
      text-align: center;
      cursor: default;
      transition: background 0.2s, transform 0.15s;
    }

    .pv-box:hover {
      background: #232323;
      transform: translateY(-1px);
    }

    .pv-label {
      font-size: 10px;
      opacity: 0.6;
      margin-bottom: 4px;
      letter-spacing: 0.6px;
    }

    .pv-value {
      font-size: 18px;
      font-weight: bold;
      color: #75c8bbff;
      transition: color 0.3s ease, transform 0.2s ease, font-size 0.15s ease;
      white-space: nowrap;
      line-height: 1.15;
    }

    .badge.minimal .pv-value {
      font-size: clamp(14px, 4.2vw, 18px);
    }

    .badge.minimal .pv-value.pv-value-compact {
      font-size: clamp(12px, 3.5vw, 15px);
    }

    .badge.minimal .pv-value.pv-value-tight {
      font-size: clamp(11px, 3vw, 13px);
    }

    .badge.minimal .minimal-total-value {
      font-size: clamp(12px, 3.8vw, 14px);
      white-space: nowrap;
    }

    .badge.minimal .minimal-metrics-row {
      white-space: nowrap;
    }

    .badge.minimal .minimal-metrics-row strong {
      font-size: clamp(10px, 2.8vw, 11px);
    }

    .clickable {
      cursor: pointer;
    }

    .clickable:hover {
      background: #003344;
      border-color: #75c8bbff;
    }


    .field {
      margin: 6px 0;
    }

    .field strong { display:inline-block; width: 90px; color:#dfefff; }

    #reauthenticateBtn {
      margin-top: 10px;
      padding: 6px 8px;
      border-radius: 5px;
      border: none;
      background: #ff5c5c;
      color: white;
      cursor: pointer;
      font-size: 13px;
    }

    /* dragging cursors */
    .draggable { cursor: grab; }
    .dragging { cursor: grabbing !important; }

    /* small responsive adjustments */
    @media (max-width: 480px) {
      .badge { width: 70vw; right: 6px; min-width: 200px; max-width: none; }
      .badge.minimal {
        width: fit-content;
        min-width: 200px;
        max-width: min(300px, 88vw);
      }
    }

    .badge.expanded {
      width: 45vw;
      max-width: 50vw;
      min-width: 360px;
    }

    /* ===== metrics row ===== */
    .metrics-row {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
    }

    .metric-card {
      flex: 1;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 6px;
      padding: 6px;
      text-align: center;
    }

    .metric-label {
      font-size: 10px;
      opacity: 0.6;
      color: #ffffff;
    }

    .metric-value {
      font-size: 16px;
      font-weight: bold;
      color: #75c8bb;
    }

    /* ===== charts grid ===== */
    .charts-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      margin-bottom: 6px;
    }

    .chart-card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 6px;
      padding: 4px;
    }


    .chart-title {
      font-size: 12px;
      color: #ddd;
      margin-bottom: 4px;
      font-weight: 600;
    }

    .chart-box {
      height: 120px;
      width: 100%;
      position: relative;
    }

    .chart-box canvas {
      max-width: 100%;
    }

    /* ===== status row ===== */
    .status-row {
      font-size: 12px;
      opacity: 0.9;
      text-align: center;
    }

    /* section visibility */
    .minimal-section { display: none; }
    .expanded-section { display: none; }

    /* minimal state */
    .badge.minimal .minimal-section {
      display: flex;
      flex-direction: column;
    }

    /* expanded state */
    .badge.expanded .expanded-section {
      display: block;
    }

    .expanded-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      color: #ccc;
    }

    .expanded-title {
      font-size: 13px;
      font-weight: 600;
    }

    .expanded-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .range-label {
      font-size: 11px;
      opacity: 0.7;
    }

    /* Date preset dropdown */
    .preset-select {
      background: #1a1a1a;
      color: #ccc;
      border: 1px solid #333;
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 11px;
      font-family: Arial, Helvetica, sans-serif;
      cursor: pointer;
      outline: none;
      transition: border-color 0.15s;
    }

    .preset-select:hover,
    .preset-select:focus {
      border-color: #75c8bb;
      color: #fff;
    }

    .preset-select option {
      background: #1a1a1a;
      color: #ccc;
    }

    .collapse-btn {
      background: transparent;
      border: none;
      color: #bbb;
      font-size: 14px;
      cursor: pointer;
    }

    .collapse-btn:hover {
      color: #fff;
    }

    .header-action-btn {
      background: transparent;
      border: none;
      color: #888;
      font-size: 18px;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
      transition: color 0.15s, background 0.15s;
      line-height: 1;
    }

    .header-action-btn:hover {
      color: #75c8bb;
      background: rgba(117, 200, 187, 0.1);
    }

    .header-action-btn.spinning {
      animation: spin 0.7s linear infinite;
    }

    /* smooth content appearance */
    .expanded-section {
      opacity: 0;
      transform: translateY(4px);
      transition: opacity 0.18s ease, transform 0.18s ease;
    }

    .badge.expanded .expanded-section {
      opacity: 1;
      transform: translateY(0);
    }

    .filter-footer {
      display: flex;
      justify-content: flex-end;
      font-size: 10px;
      color: #8a8a8a;
      margin-top: 4px;
      margin-bottom: 2px;
      padding-right: 2px;
      opacity: 0.85;
    }

    .filter-footer span {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 95%;
    }

    /* Data delay disclaimer footer */
    .delay-disclaimer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 10px;
      color: #8a8a8a;
      padding: 0 2px 4px;
      line-height: 1.3;
      opacity: 0.85;
    }

    /* ===== Tab navigation ===== */
    .tab-bar {
      display: flex;
      border-bottom: 1px solid #2a2a2a;
      margin-bottom: 8px;
      gap: 0;
    }

    .tab-btn {
      flex: 1;
      padding: 7px 8px;
      font-size: 11px;
      font-weight: 600;
      color: #888;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
      text-align: center;
      font-family: Arial, Helvetica, sans-serif;
      position: relative;
    }

    .tab-btn:hover:not(.disabled) {
      color: #ccc;
    }

    .tab-btn.active {
      color: #75c8bb;
      border-bottom-color: #75c8bb;
    }

    .tab-btn.disabled {
      color: #555;
      cursor: not-allowed;
      opacity: 1;
    }

    .tab-btn-tooltip {
      display: none;
      position: absolute;
      bottom: calc(100% + 6px);
      left: 50%;
      transform: translateX(-50%);
      background: #222;
      color: #aaa;
      font-size: 10px;
      font-weight: 400;
      padding: 5px 8px;
      border-radius: 4px;
      border: 1px solid #333;
      white-space: nowrap;
      z-index: 10;
      pointer-events: none;
    }

    .tab-btn.disabled:hover .tab-btn-tooltip {
      display: block;
    }

    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
    }

    /* Secondary filter dropdown inside custom report row */
    .cr-filter-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
      font-size: 11px;
      color: #ccc;
      flex-wrap: nowrap;
      overflow: hidden;
    }

    .cr-primary-label {
      background: rgba(117, 200, 187, 0.12);
      border: 1px solid rgba(117, 200, 187, 0.25);
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 10px;
      color: #75c8bb;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 45%;
      flex-shrink: 1;
    }

    .cr-filter-sep {
      color: #444;
      flex-shrink: 0;
    }

    .cr-secondary-label {
      font-size: 10px;
      color: #999;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .cr-filter-bar select {
      background: #1a1a1a;
      color: #ccc;
      border: 1px solid #333;
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 11px;
      font-family: Arial, Helvetica, sans-serif;
      cursor: pointer;
      outline: none;
      max-width: 200px;
    }

    .cr-filter-bar select:hover,
    .cr-filter-bar select:focus {
      border-color: #75c8bb;
      color: #fff;
    }

    .cr-not-configured {
      font-size: 12px;
      color: #666;
      text-align: center;
      padding: 16px 8px;
    }

    /* ===== Loading overlay ===== */
    .loading-overlay {
      display: none;
      position: absolute;
      inset: 0;
      background: rgba(14, 14, 14, 0.85);
      z-index: 10;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;
      border-radius: 0 0 0 8px;
    }

    .loading-overlay.active {
      display: flex;
    }

    .loading-spinner {
      width: 24px;
      height: 24px;
      border: 3px solid #333;
      border-top-color: #75c8bb;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    .loading-text {
      font-size: 11px;
      color: #999;
      letter-spacing: 0.3px;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

  `;
  shadow.appendChild(style);
  // ---------- HTML ----------
  const badge = document.createElement("div");
  badge.className = "badge collapsed";
  badge.innerHTML = `
    <div class="badge-header draggable" id="badgeHeader">
      <div class="badge-title">
        <span>Adobe Analytics Pageviews</span>
        <span class="info-tip" id="headerInfoTip">i
          <span class="info-tooltip info-tooltip-minimal">Data may be delayed ~1 hr.</span>
          <span class="info-tooltip info-tooltip-expanded">Data shown is not real-time and may have a delay of approximately 1 hour. Metrics reflect the latest available Adobe Analytics Workspace data.</span>
        </span>
      </div>
      <div class="toggle-wrap">
        <button class="header-icon-btn" id="settingsBtn" title="Open Settings">&#x2699;</button>
        <label class="switch" title="Show analytics">
          <input type="checkbox" id="expandToggle" />
          <span class="slider"></span>
        </label>
      </div>
    </div>

    <div class="badge-body" id="badgeBody" aria-hidden="true">

      <!-- Loading overlay -->
      <div class="loading-overlay" id="loadingOverlay">
        <div class="loading-spinner"></div>
        <div class="loading-text">Fetching data…</div>
      </div>

      <!-- ================================================= -->
      <!-- MINIMAL VIEW (Today / Yesterday / More)           -->
      <!-- ================================================= -->
      <div class="minimal-section" id="minimalSection">

        <div class="pv-row">
          <div class="pv-box" id="todayPV">
            <div class="pv-label">TODAY (SO FAR)</div>
            <div class="pv-value" id="pageViewsToday">—</div>
            <div class="pv-substat" id="today7dAvg">7d avg: —</div>
          </div>

          <div class="pv-box" id="yesterdayPV">
            <div class="pv-label">YESTERDAY</div>
            <div class="pv-value" id="pageViewsYesterday">—</div>
          </div>
        </div>

        <div class="minimal-metrics-row" title="Visits and unique visitors for today (so far)">
          <span>Visits: <strong id="minimalVisits">—</strong></span>
          <span>UV: <strong id="minimalVisitors">—</strong></span>
        </div>

        <div class="minimal-footer-row">
          <div class="minimal-total-box">
            <div class="minimal-total-label">7D TOTAL PV</div>
            <div class="minimal-total-value" id="minimal7dTotal">—</div>
          </div>
          <div class="pv-box clickable" id="moreBtn">
            <div class="pv-label">MORE</div>
            <div class="pv-value">⋯</div>
          </div>
        </div>

      </div>


      <!-- ================================================= -->
      <!-- EXPANDED DASHBOARD VIEW                           -->
      <!-- ================================================= -->
      <div class="expanded-section" id="expandedSection">
        <div class="expanded-header">
          <span class="expanded-title">Analytics Dashboard</span>
          <div class="expanded-right">
            <span class="range-label">Date Range:</span>
            <select class="preset-select" id="datePresetSelect">
              <option value="7d">Last 7 Days</option>
              <option value="3w">Last 3 Weeks</option>
              <option value="5w">Last 5 Weeks</option>
              <option value="3m">Last 3 Months</option>
              <option value="6m">Last 6 Months</option>
            </select>
            <button id="refreshBtn" class="header-action-btn" title="Refresh data">&#x21bb;</button>
            <button id="exportCsvBtn" class="header-action-btn" title="Export to CSV">&#x2913;</button>
            <button id="collapseBtn" class="collapse-btn">✕</button>
          </div>
        </div>

        <!-- ===== Tab Navigation ===== -->
        <div class="tab-bar" id="tabBar">
          <button class="tab-btn active" id="tabPagePerf" data-tab="pagePerf">Page Performance</button>
          <button class="tab-btn disabled" id="tabCustomReport" data-tab="customReport">
            Custom Report
            <span class="tab-btn-tooltip">Configure Step 4 on Options page to access this tab</span>
          </button>
        </div>

        <!-- ===== Tab Content: Page Performance ===== -->
        <div class="tab-content active" id="tabContentPagePerf">
            <div class="metrics-row">
              <div class="metric-card">
                <div class="metric-label">PAGEVIEWS</div>
                <div class="metric-value" id="metricTotalPV">—</div>
              </div>
              <div class="metric-card">
                <div class="metric-label">VISITS</div>
                <div class="metric-value" id="metricTotalVisits">—</div>
              </div>
              <div class="metric-card">
                <div class="metric-label">VISITORS</div>
                <div class="metric-value" id="metricTotalVisitors">—</div>
              </div>
            </div>

            <div class="charts-grid">
              <div class="chart-card">
                <div class="chart-title" id="pvChartTitle">Pageviews (7d)</div>
                <div class="chart-box"><canvas id="pvChart"></canvas></div>
              </div>
              <div class="chart-card">
                <div class="chart-title" id="visitsChartTitle">Visits (7d)</div>
                <div class="chart-box"><canvas id="visitsChart"></canvas></div>
              </div>
              <div class="chart-card">
                <div class="chart-title" id="uvChartTitle">Visitors (7d)</div>
                <div class="chart-box"><canvas id="uvChart"></canvas></div>
              </div>
              <div class="chart-card">
                <div class="chart-title">Traffic Share by Country (%)</div>
                <div class="chart-box"><canvas id="countryChart"></canvas></div>
              </div>
            </div>

            <div class="filter-footer">
              <span id="filterCondition"></span>
            </div>
        </div>

        <!-- ===== Tab Content: Custom Report ===== -->
        <div class="tab-content" id="tabContentCustomReport">
            <!-- Combined filter bar: primary label + secondary dropdown in one row -->
            <div class="cr-filter-bar" id="crFilterBar">
              <span class="cr-primary-label" id="crPrimaryLabel"></span>
              <span class="cr-filter-sep">|</span>
              <span class="cr-secondary-label" id="crSecondaryLabel"></span>
              <select id="crSecondarySelect">
                <option value="">No Filter</option>
              </select>
            </div>

            <div class="metrics-row">
              <div class="metric-card">
                <div class="metric-label">PAGEVIEWS</div>
                <div class="metric-value" id="crMetricPV">—</div>
              </div>
              <div class="metric-card">
                <div class="metric-label">VISITS</div>
                <div class="metric-value" id="crMetricVisits">—</div>
              </div>
              <div class="metric-card">
                <div class="metric-label">VISITORS</div>
                <div class="metric-value" id="crMetricVisitors">—</div>
              </div>
            </div>

            <div class="charts-grid">
              <div class="chart-card">
                <div class="chart-title" id="crPvChartTitle">Pageviews (7d)</div>
                <div class="chart-box"><canvas id="crPvChart"></canvas></div>
              </div>
              <div class="chart-card">
                <div class="chart-title" id="crVisitsChartTitle">Visits (7d)</div>
                <div class="chart-box"><canvas id="crVisitsChart"></canvas></div>
              </div>
              <div class="chart-card">
                <div class="chart-title" id="crUvChartTitle">Visitors (7d)</div>
                <div class="chart-box"><canvas id="crUvChart"></canvas></div>
              </div>
              <div class="chart-card">
                <div class="chart-title">Traffic Share by Country (%)</div>
                <div class="chart-box"><canvas id="crCountryChart"></canvas></div>
              </div>
            </div>
        </div>

        <div class="delay-disclaimer">
          <span>Data is not real-time and may have a delay of ~1 hour.</span>
          <a class="feedback-link" id="feedbackLink" title="Share your feedback on Chrome Web Store">Feedback &#x2197;</a>
        </div>

      </div>


      <!-- ===== STATUS + AUTH (shared) ===== -->
      <div class="status-row">
        <span id="status">Checking token…</span>
        <button id="reauthenticateBtn" hidden>Reauthenticate</button>
      </div>
    </div>
  `;
  shadow.appendChild(badge);

  // expose easy refs
  const header = shadow.getElementById("badgeHeader");
  const toggle = shadow.getElementById("expandToggle");
  const body = shadow.getElementById("badgeBody");
  const statusEl = shadow.getElementById("status");
  const reauthBtn = shadow.getElementById("reauthenticateBtn");
  const moreBtn = shadow.getElementById("moreBtn");
  const collapseBtn = shadow.getElementById("collapseBtn");
  const refreshBtn = shadow.getElementById("refreshBtn");
  const exportCsvBtn = shadow.getElementById("exportCsvBtn");
  const settingsBtn = shadow.getElementById("settingsBtn");
  const feedbackLink = shadow.getElementById("feedbackLink");
  const datePresetSelect = shadow.getElementById("datePresetSelect");
  const loadingOverlay = shadow.getElementById("loadingOverlay");

  // Tab refs
  const tabPagePerf = shadow.getElementById("tabPagePerf");
  const tabCustomReport = shadow.getElementById("tabCustomReport");
  const tabContentPagePerf = shadow.getElementById("tabContentPagePerf");
  const tabContentCustomReport = shadow.getElementById("tabContentCustomReport");
  const crSecondarySelect = shadow.getElementById("crSecondarySelect");

  // Custom report chart instances (separate from page perf)
  let crChartInstances = {};
  let customReportConfig = null;
  let crSecondaryValues = [];

  // Store last fetched data for export
  let lastPagePerfData = null;
  let lastPagePerfCountryData = null;
  let lastCrData = null;
  let lastCrCountryData = null;

  function showLoading() {
    if (loadingOverlay) loadingOverlay.classList.add("active");
  }

  function hideLoading() {
    if (loadingOverlay) loadingOverlay.classList.remove("active");
  }

  // Set saved preset in dropdown
  datePresetSelect.value = currentDatePreset;

  //If badge position saved in sessionStorage, apply it
  const savedLeft = sessionStorage.getItem("badgeLeftPosition");
  const savedTop = sessionStorage.getItem("badgeTopPosition");
  if (savedLeft && savedTop) {
    badge.style.left = savedLeft;
    badge.style.top = savedTop;
    badge.style.position = "fixed";
    badge.style.right = "auto";
  }

  //Initial toggle state from sessionStorage
  const toggleState = sessionStorage.getItem("adobePVExtensionToggle");
  const viewMode = sessionStorage.getItem("adobePVExtensionViewMode"); // "minimal" or "expanded"
  if (toggleState === "enabled") {
    toggle.checked = true;
    body.setAttribute("aria-hidden", "false");
    if (viewMode === "expanded" && isDesktop()) {
      badge.classList.remove("collapsed", "minimal");
      badge.classList.add("expanded");
      showLoading();
      // Fetch data and render expanded view directly with correct preset
      setTimeout(async () => {
        // Get page identifier first (needed for API calls)
        let pageIdentifierResp = await fetchPageIdentifiers();
        if (pageIdentifierResp.success === false) {
          hideLoading();
          return;
        }
        let resp = await checkToken();
        if (resp) {
          const minimalData = await getPageData(MINIMAL_DATE_PRESET);
          const pageData = await getPageData(currentDatePreset);
          const countryData = await getCountryData(currentDatePreset);
          hideLoading();
          if (minimalData) renderMinimalMetrics(minimalData);
          if (pageData) {
            renderExpandedMetrics(pageData);
            updateChartTitles();
            renderCharts(pageData, countryData);
          }
          updateFilterCondition();
          await loadCustomReportTab();
          // Restore active tab
          const savedTab = sessionStorage.getItem("adobePVExtensionActiveTab");
          if (savedTab === "customReport" && !tabCustomReport.classList.contains("disabled")) {
            switchTab("customReport");
            await fetchAndRenderCustomReport();
          }
        } else {
          hideLoading();
        }
      }, 2000);
    } else {
      badge.classList.remove("collapsed", "expanded");
      badge.classList.add("minimal");
      showLoading();
      setTimeout(fetchPageData, 2000);
    }
  } else {
    toggle.checked = false;
    badge.classList.remove("minimal", "expanded");
    badge.classList.add("collapsed");
    body.setAttribute("aria-hidden", "true");
  }

  // ---------- toggle behavior ----------
  toggle.addEventListener("change", async () => {
    if (toggle.checked) {
      badge.classList.remove("collapsed", "expanded");
      badge.classList.add("minimal");
      sessionStorage.setItem("adobePVExtensionToggle", "enabled");
      sessionStorage.setItem("adobePVExtensionViewMode", "minimal");
      body.setAttribute("aria-hidden", "false");
      showLoading();
      await fetchPageData();
      hideLoading();
    } else {
      badge.classList.remove("minimal", "expanded");
      badge.classList.add("collapsed");
      sessionStorage.setItem("adobePVExtensionToggle", "disabled");
      sessionStorage.removeItem("adobePVExtensionViewMode");
      body.setAttribute("aria-hidden", "true");
    }
  });

  /* ---------- Settings button → open options page ---------- */
  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // Prevent drag
    chrome.runtime.sendMessage({ type: "OPEN_EXTENSION_OPTION" });
  });

  /* ---------- Feedback link → Chrome Web Store ---------- */
  feedbackLink.addEventListener("click", (e) => {
    e.preventDefault();
    window.open("https://chromewebstore.google.com/detail/oommkcdglakgcanecjjfbmoipcfiljbe", "_blank");
  });

  /* ---------- MORE → expanded ---------- */
  moreBtn.addEventListener("click", async () => {
    if (!isDesktop()) {
      statusEl.textContent = "Expanded charts available on desktop only";
      return;
    }

    // minimal → expanded
    badge.classList.remove("minimal");
    badge.classList.add("expanded");
    sessionStorage.setItem("adobePVExtensionViewMode", "expanded");
    showLoading();
    let resp = await checkToken();
    if (!resp) {
      hideLoading();
      return;
    }
    const minimalData = await getPageData(MINIMAL_DATE_PRESET);
    const pageData = await getPageData(currentDatePreset);
    const countryData = await getCountryData(currentDatePreset);
    hideLoading();

    if (minimalData) renderMinimalMetrics(minimalData);
    if (pageData) {
      renderExpandedMetrics(pageData);
      updateChartTitles();
      renderCharts(pageData, countryData);
    }
    updateFilterCondition();

    // Load custom report config and show/hide row 2
    await loadCustomReportTab();
  });

  /* ---------- collapse → minimal ---------- */
  collapseBtn.addEventListener("click", async () => {
    badge.classList.remove("expanded");
    badge.classList.add("minimal");
    sessionStorage.setItem("adobePVExtensionViewMode", "minimal");
    Object.values(chartInstances).forEach((c) => c?.destroy());
    chartInstances = {};
    Object.values(crChartInstances).forEach((c) => c?.destroy());
    crChartInstances = {};

    // Refresh minimal view with 7d data for today/yesterday values
    showLoading();
    const pageData = await getPageData(MINIMAL_DATE_PRESET);
    hideLoading();
    if (pageData) renderMinimalMetrics(pageData);
  });

  /* ---------- Tab Switching ---------- */
  function switchTab(tabName) {
    // Deactivate all tabs and content
    tabPagePerf.classList.remove("active");
    tabCustomReport.classList.remove("active");
    tabContentPagePerf.classList.remove("active");
    tabContentCustomReport.classList.remove("active");

    if (tabName === "pagePerf") {
      tabPagePerf.classList.add("active");
      tabContentPagePerf.classList.add("active");
    } else if (tabName === "customReport") {
      tabCustomReport.classList.add("active");
      tabContentCustomReport.classList.add("active");
    }

    sessionStorage.setItem("adobePVExtensionActiveTab", tabName);
  }

  tabPagePerf.addEventListener("click", () => {
    switchTab("pagePerf");
  });

  tabCustomReport.addEventListener("click", async () => {
    if (tabCustomReport.classList.contains("disabled")) return;
    switchTab("customReport");
    // Fetch custom report data when switching to this tab
    await fetchAndRenderCustomReport();
  });

  /* ---------- Secondary dimension filter change ---------- */
  crSecondarySelect.addEventListener("change", async () => {
    await fetchAndRenderCustomReport();
  });

  /* ---------- Refresh Button ---------- */
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.classList.add("spinning");
    showLoading();
    let resp = await checkToken();
    if (!resp) {
      hideLoading();
      refreshBtn.classList.remove("spinning");
      return;
    }

    if (tabContentCustomReport.classList.contains("active")) {
      // Refresh custom report tab
      await fetchAndRenderCustomReport();
    } else {
      // Refresh page performance tab
      const minimalData = await getPageData(MINIMAL_DATE_PRESET);
      const pageData = await getPageData(currentDatePreset);
      const countryData = await getCountryData(currentDatePreset);
      hideLoading();
      if (minimalData) renderMinimalMetrics(minimalData);
      if (pageData && countryData) {
        renderExpandedMetrics(pageData);
        updateChartTitles();
        renderCharts(pageData, countryData);
        updateFilterCondition();
      }
    }
    refreshBtn.classList.remove("spinning");
  });

  /* ---------- Export CSV Button ---------- */
  exportCsvBtn.addEventListener("click", async () => {
    let csvContent = "";
    let filename = "";

    if (tabContentCustomReport.classList.contains("active")) {
      // Export custom report data
      if (!lastCrData) {
        statusEl.textContent = "No data to export.";
        return;
      }
      csvContent = await buildCsvContent(lastCrData, lastCrCountryData, "Custom Report");
      filename = `custom_report_${currentDatePreset}_${new Date().toISOString().split("T")[0]}.csv`;
    } else {
      // Export page performance data
      if (!lastPagePerfData) {
        statusEl.textContent = "No data to export.";
        return;
      }
      csvContent = await buildCsvContent(lastPagePerfData, lastPagePerfCountryData, "Page Performance");
      filename = `page_performance_${currentDatePreset}_${new Date().toISOString().split("T")[0]}.csv`;
    }

    // Download via Blob + anchor
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  async function buildCsvContent(pageData, countryData, reportName) {
    let csv = "";
    const granularity = pageData.granularity || "day";
    const granularityLabels = {
      day: "Daily",
      week: "Weekly",
      month: "Monthly",
    };
    const granularityLabel = granularityLabels[granularity] || "Daily";

    // Header section
    csv += `${reportName} - ${DATE_PRESET_LABELS[currentDatePreset] || currentDatePreset}\n`;
    csv += `Exported: ${new Date().toLocaleString()}\n`;
    csv += `Source: Adobe Analytics Workspace\n`;

    // Report Suite ID
    const { selectedrsID } = await chrome.storage.local.get("selectedrsID");
    if (selectedrsID) csv += `Report Suite: ${selectedrsID}\n`;

    // Filter conditions
    if (reportName === "Page Performance") {
      const { pageIdentifierCondition } = await chrome.storage.local.get("pageIdentifierCondition");
      if (pageIdentifierCondition) csv += `Filter: ${pageIdentifierCondition}\n`;
    } else if (reportName === "Custom Report" && customReportConfig) {
      let condition = `${customReportConfig.primaryDimension?.displayLabel || ""} ${customReportConfig.primaryMatch || ""} '${customReportConfig.primaryValue || ""}'`;
      const secVal = crSecondarySelect?.value;
      if (secVal && customReportConfig.secondaryDimension?.displayLabel) {
        condition += ` AND ${customReportConfig.secondaryDimension.displayLabel} exact '${secVal}'`;
      }
      csv += `Filter: ${condition}\n`;
    }

    csv += `\n`;

    // Totals
    const totalPV = pageData.filteredTotals?.[0] || 0;
    const totalVisits = pageData.filteredTotals?.[1] || 0;
    const totalVisitors = pageData.filteredTotals?.[2] || 0;
    csv += `Total Pageviews,Total Visits,Total Visitors\n`;
    csv += `${totalPV},${totalVisits},${totalVisitors}\n\n`;

    // Trend data with granularity in column header
    csv += `Date (${granularityLabel}),Pageviews,Visits,Visitors\n`;
    const dates = pageData.dates || [];
    const pvs = pageData.pageViews || [];
    const visits = pageData.visits || [];
    const visitors = pageData.visitors || [];
    for (let i = 0; i < dates.length; i++) {
      csv += `${dates[i]},${pvs[i] || 0},${visits[i] || 0},${visitors[i] || 0}\n`;
    }

    // Country data with raw counts
    if (countryData && countryData.countries && countryData.countries.length > 0) {
      csv += `\nCountry (Top 5 Countries),Pageviews,Traffic Share (%)\n`;
      const rawCounts = countryData.rawCounts || [];
      for (let i = 0; i < countryData.countries.length; i++) {
        // Use rawCounts if available, otherwise compute from percentage and total PV
        let count = rawCounts[i];
        if (count === undefined || count === null) {
          count = Math.round((countryData.pageViews[i] / 100) * totalPV);
        }
        csv += `${countryData.countries[i]},${count},${countryData.pageViews[i] || 0}\n`;
      }
    }

    return csv;
  }

  /* ---------- Date Preset Change ---------- */
  datePresetSelect.addEventListener("change", async (e) => {
    currentDatePreset = e.target.value;
    await saveDatePreset(currentDatePreset);

    // Re-fetch expanded view data with new preset
    showLoading();
    statusEl.textContent = "";
    let resp = await checkToken();
    if (!resp) {
      hideLoading();
      return;
    }

    const pageData = await getPageData(currentDatePreset);
    const countryData = await getCountryData(currentDatePreset);

    if (!pageData || !countryData) {
      hideLoading();
      statusEl.textContent = "No data available for this page.";
      return;
    }
    hideLoading();
    statusEl.textContent = "";

    const minimalData = await getPageData(MINIMAL_DATE_PRESET);
    if (minimalData) renderMinimalMetrics(minimalData);
    renderExpandedMetrics(pageData);
    updateChartTitles();
    renderCharts(pageData, countryData);
    updateFilterCondition();

    // Also refresh custom report if it's open
    if (tabContentCustomReport.classList.contains("active")) {
      await fetchAndRenderCustomReport();
    }
  });

  // ---------- dragging (mouse + touch) ----------
  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  const startDrag = (clientX, clientY) => {
    dragging = true;
    badge.classList.add("dragging");
    const rect = badge.getBoundingClientRect();
    dragOffsetX = clientX - rect.left;
    dragOffsetY = clientY - rect.top;
    badge.style.left = rect.left + "px";
    badge.style.top = rect.top + "px";
    badge.style.right = "auto";
    badge.style.position = "fixed";
  };

  const doDrag = (clientX, clientY) => {
    if (!dragging) return;
    const newLeft = clientX - dragOffsetX;
    const newTop = clientY - dragOffsetY;
    const maxLeft = window.innerWidth - 40;
    const maxTop = window.innerHeight - 40;
    badge.style.left = Math.min(Math.max(0, newLeft), maxLeft) + "px";
    badge.style.top = Math.min(Math.max(0, newTop), maxTop) + "px";
  };

  const stopDrag = async () => {
    dragging = false;
    badge.classList.remove("dragging");
    sessionStorage.setItem("badgeLeftPosition", badge.style.left);
    sessionStorage.setItem("badgeTopPosition", badge.style.top);
  };

  // mouse events
  header.addEventListener("mousedown", (ev) => {
    if (ev.target.closest("label.switch")) return;
    ev.preventDefault();
    startDrag(ev.clientX, ev.clientY);
  });
  document.addEventListener("mousemove", (ev) => doDrag(ev.clientX, ev.clientY));
  document.addEventListener("mouseup", stopDrag);

  // touch events
  header.addEventListener(
    "touchstart",
    (ev) => {
      const touch = ev.touches[0];
      if (!touch) return;
      startDrag(touch.clientX, touch.clientY);
    },
    { passive: false },
  );
  document.addEventListener(
    "touchmove",
    (ev) => {
      const touch = ev.touches[0];
      if (!touch) return;
      doDrag(touch.clientX, touch.clientY);
    },
    { passive: false },
  );
  document.addEventListener("touchend", stopDrag);

  // ---------- reauthBtn Click handler ----------
  reauthBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "OPEN_EXTENSION_OPTION" }, (response) => {
      if (chrome.runtime.lastError) {
        if (globalThis.debugExtension) {
          console.error(chrome.runtime.lastError);
        }
        return;
      }
    });
  });

  // ---------- Auto-refresh on tab focus (after re-authentication) ----------
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) return;
    if (!toggle.checked) return;

    // Only auto-refresh if widget was showing "Token is invalid" state
    if (reauthBtn.hidden) return;

    const isValid = await checkTokenValidity();
    if (!isValid) return;

    // Token is now valid — user re-authenticated on options page
    reauthBtn.hidden = true;
    statusEl.textContent = "";
    showLoading();

    const currentView = badge.classList.contains("expanded") ? "expanded" : "minimal";

    if (currentView === "expanded") {
      const minimalData = await getPageData(MINIMAL_DATE_PRESET);
      const pageData = await getPageData(currentDatePreset);
      const countryData = await getCountryData(currentDatePreset);
      hideLoading();
      if (minimalData) renderMinimalMetrics(minimalData);
      if (pageData && countryData) {
        renderExpandedMetrics(pageData);
        updateChartTitles();
        renderCharts(pageData, countryData);
        updateFilterCondition();
        await loadCustomReportTab();
      }
    } else {
      await fetchPageData();
      hideLoading();
    }
  });

  // ---------- Checking Token validity ----------
  async function checkToken() {
    const isTokenValid = await checkTokenValidity();
    if (isTokenValid) {
      statusEl.textContent = "";
      reauthBtn.hidden = true;
    } else {
      hideLoading();
      statusEl.textContent = "Token is invalid or expired.";
      reauthBtn.hidden = false;
    }
    return isTokenValid;
  }

  async function checkTokenValidity() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_TOKEN_VALIDITY_CONTENT" }, (response) => {
        if (chrome.runtime.lastError) {
          if (globalThis.debugExtension) {
            console.error(chrome.runtime.lastError);
          }
          resolve(false);
          return;
        }
        if (response && response.success) {
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

  async function fetchPageData() {
    let pageIdentifierResp = await fetchPageIdentifiers();
    if (pageIdentifierResp.success === false) {
      fetchPageDataAttempts += 1;
      if (fetchPageDataAttempts >= MAX_FETCH_PAGE_DATA_ATTEMPTS) {
        return;
      }
      setTimeout(() => {
        fetchPageData();
      }, 2000);
      return;
    } else if (pageIdentifierResp?.success === true) {
      fetchPageDataAttempts = 0;
      await updateWidgetWithPageData();
    }
  }

  function fetchPageIdentifiers() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "GET_PAGE_IDENTIFIERS" }, (response) => {
        if (response.pageIdentifier && response.success) {
          pageIdentifier = response.pageIdentifier;
          if (pageIdentifier.source == "url") {
            pageIdentifier.value = window.location.href;
            resolve({ success: true, pageIdentifier: pageIdentifier });
          } else if (pageIdentifier.source == "title") {
            pageIdentifier.value = document.title;
            resolve({ success: true, pageIdentifier: pageIdentifier });
          } else if (pageIdentifier.source == "window") {
            window.dispatchEvent(
              new CustomEvent("fetchPageWindowPathIdentifiers", {
                detail: pageIdentifier,
              }),
            );
            resolve({});
          }
        } else {
          resolve({ success: false, pageIdentifier: {} });
        }
        return true;
      });
    });
  }

  async function updateWidgetWithPageData() {
    let resp = await checkToken();
    if (!resp) return;
    showLoading();
    statusEl.textContent = "";

    const minimalData = await getPageData(MINIMAL_DATE_PRESET);
    if (!minimalData) {
      hideLoading();
      statusEl.textContent = "No data available for this page.";
      return;
    }

    renderMinimalMetrics(minimalData);

    if (badge.classList.contains("expanded")) {
      const pageData = await getPageData(currentDatePreset);
      const countryData = await getCountryData(currentDatePreset);
      if (pageData) {
        renderExpandedMetrics(pageData);
        updateChartTitles();
      }
      if (pageData && countryData) {
        renderCharts(pageData, countryData);
      }
      updateFilterCondition();
      if (tabContentCustomReport.classList.contains("active")) {
        await fetchAndRenderCustomReport();
      }
    } else {
      updateFilterCondition();
    }
    hideLoading();

    return;
  }
  window.updateWidgetWithPageData = updateWidgetWithPageData;

  // =====================
  // SPA Re-fetch Handler
  // =====================
  async function refetchPageDataForSpa() {
    // Re-read page identifier based on current source

    let pageIdentifierResp = await fetchPageIdentifiers();
    if (pageIdentifierResp.success === true) {
      // For url/title sources, update immediately
      await updateWidgetWithPageData();
    }
  }
  window.refetchPageDataForSpa = refetchPageDataForSpa;

  function renderMinimalMetrics(pageData) {
    if (!pageData) return;

    const pageViews = pageData.pageViews || [];
    const visits = pageData.visits || [];
    const visitors = pageData.visitors || [];

    const todayPV = pageViews[pageViews.length - 1] || 0;
    const yesterdayPV = pageViews[pageViews.length - 2] || 0;
    const todayVisits = visits[visits.length - 1] || 0;
    const todayVisitors = visitors[visitors.length - 1] || 0;
    const total7dPV = pageData.filteredTotals?.[0] || 0;
    const avg7dDaily = compute7dDailyAverage(pageData);

    const todayFormatted = formatLargeNumber(todayPV);
    const yesterdayFormatted = formatLargeNumber(yesterdayPV);
    const visitsFormatted = formatLargeNumber(todayVisits);
    const uvFormatted = formatLargeNumber(todayVisitors);
    const total7dFormatted = formatLargeNumber(total7dPV);
    const avgFormatted = formatLargeNumber(avg7dDaily);

    const todayEl = badge.querySelector("#pageViewsToday");
    const yesterdayEl = badge.querySelector("#pageViewsYesterday");
    const avgEl = badge.querySelector("#today7dAvg");
    const visitsEl = badge.querySelector("#minimalVisits");
    const uvEl = badge.querySelector("#minimalVisitors");
    const total7dEl = badge.querySelector("#minimal7dTotal");

    if (todayEl) {
      todayEl.textContent = todayFormatted;
      applyCompactValueClass(todayEl, todayFormatted);
    }
    if (yesterdayEl) {
      yesterdayEl.textContent = yesterdayFormatted;
      applyCompactValueClass(yesterdayEl, yesterdayFormatted);
    }
    if (visitsEl) visitsEl.textContent = visitsFormatted;
    if (uvEl) uvEl.textContent = uvFormatted;
    if (total7dEl) {
      total7dEl.textContent = total7dFormatted;
      applyCompactValueClass(total7dEl, total7dFormatted);
    }
    if (avgEl) avgEl.textContent = `7d avg: ${avgFormatted}/day`;
  }

  function renderExpandedMetrics(pageData) {
    if (!pageData) return;

    const totalPV = pageData.filteredTotals?.[0] || 0;
    const totalVisits = pageData.filteredTotals?.[1] || 0;
    const totalVisitors = pageData.filteredTotals?.[2] || 0;

    const pvEl = badge.querySelector("#metricTotalPV");
    const visitsEl = badge.querySelector("#metricTotalVisits");
    const uvEl = badge.querySelector("#metricTotalVisitors");

    if (pvEl) pvEl.textContent = formatLargeNumber(totalPV);
    if (visitsEl) visitsEl.textContent = formatLargeNumber(totalVisits);
    if (uvEl) uvEl.textContent = formatLargeNumber(totalVisitors);
  }

  function renderMetrics(pageData) {
    renderMinimalMetrics(pageData);
    renderExpandedMetrics(pageData);
  }

  function updateChartTitles() {
    const presetLabel = DATE_PRESET_LABELS[currentDatePreset] || "Last 7 Days";
    const shortLabels = {
      "7d": "7d",
      "3w": "3w",
      "5w": "5w",
      "3m": "3m",
      "6m": "6m",
    };
    const shortLabel = shortLabels[currentDatePreset] || "7d";
    const pvTitle = badge.querySelector("#pvChartTitle");
    const visitsTitle = badge.querySelector("#visitsChartTitle");
    const uvTitle = badge.querySelector("#uvChartTitle");
    if (pvTitle) pvTitle.textContent = `Pageviews (${shortLabel})`;
    if (visitsTitle) visitsTitle.textContent = `Visits (${shortLabel})`;
    if (uvTitle) uvTitle.textContent = `Visitors (${shortLabel})`;
  }

  function formatChartLabel(rawLabel, granularity) {
    // For daily: "Jan 15, 2025" → "Jan 15"
    // For weekly: "Jan 13, 2025 ~ Jan 19, 2025" → "Jan 13-19"
    // For monthly: "Jan 2025" → "Jan" or "January 2025" → "Jan '25"
    if (granularity === "month") {
      // Adobe returns month labels like "January 2025" or "Jan 2025"
      const parts = rawLabel.trim().split(/\s+/);
      if (parts.length >= 2) {
        const monthShort = parts[0].substring(0, 3);
        const yearShort = "'" + parts[parts.length - 1].slice(-2);
        return `${monthShort} ${yearShort}`;
      }
      return rawLabel;
    }
    if (granularity === "week") {
      // Adobe returns week ranges like "Jan 13, 2025 ~ Jan 19, 2025"
      const parts = rawLabel.split("~").map((s) => s.trim());
      if (parts.length === 2) {
        const startParts = parts[0].split(",")[0].trim(); // "Jan 13"
        const endDate = parts[1].split(",")[0].trim().split(" "); // ["Jan", "19"]
        const endDay = endDate[endDate.length - 1]; // "19"
        return `${startParts}-${endDay}`;
      }
      return rawLabel.split(",")[0];
    }
    // Daily: just remove the year
    return rawLabel.split(",")[0];
  }

  function createVerticalChart(canvas, labels, values, granularity, store) {
    if (!canvas) return;
    const instanceStore = store || chartInstances;
    const ctx = canvas.getContext("2d");
    if (instanceStore[canvas.id]) {
      instanceStore[canvas.id].destroy();
    }

    const formattedLabels = labels.map((l) => formatChartLabel(l, granularity));

    instanceStore[canvas.id] = new Chart(ctx, {
      type: "bar",
      data: {
        labels: formattedLabels,
        datasets: [
          {
            data: values,
            backgroundColor: "#75c8bb",
            borderColor: "#75c8bb",
            borderWidth: 0,
            barPercentage: 0.7,
            categoryPercentage: 0.8,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,

        layout: {
          padding: {
            top: 5,
            right: 5,
            bottom: 0,
            left: 0,
          },
        },

        interaction: {
          mode: "index",
        },

        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            backgroundColor: "#1f1f1f",
            borderColor: "#75c8bb",
            borderWidth: 1,
            titleColor: "#fff",
            bodyColor: "#fff",
            titleFont: { size: 11 },
            bodyFont: { size: 11, weight: "bold" },
            padding: 6,
            displayColors: false,
            callbacks: {
              title: function (context) {
                // Show the original full label in tooltip
                const idx = context[0].dataIndex;
                return labels[idx] || context[0].label;
              },
              label: function (context) {
                return context.parsed.y.toLocaleString();
              },
            },
          },
        },

        scales: {
          x: {
            grid: {
              display: false,
            },
            ticks: {
              color: "#ddd",
              font: {
                size: 8,
              },
            },
          },
          y: {
            beginAtZero: true,
            grid: {
              color: "#333",
            },
            ticks: {
              color: "#ddd",
              font: {
                size: 9,
              },
            },
          },
        },
      },
    });
  }

  function createHorizontalChart(canvas, labels, values, store) {
    if (!canvas) return;
    const instanceStore = store || chartInstances;
    const ctx = canvas.getContext("2d");
    if (instanceStore[canvas.id]) {
      instanceStore[canvas.id].destroy();
    }

    instanceStore[canvas.id] = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            data: values,
            backgroundColor: "#75c8bb",
            borderColor: "#75c8bb",
            borderWidth: 0,
            barPercentage: 0.6,
            categoryPercentage: 0.8,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,

        layout: {
          padding: {
            top: 5,
            right: 10,
            bottom: 0,
            left: 0,
          },
        },

        interaction: {
          mode: "index",
        },

        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            backgroundColor: "#1f1f1f",
            borderColor: "#75c8bb",
            borderWidth: 1,
            titleColor: "#fff",
            bodyColor: "#fff",
            titleFont: { size: 11 },
            bodyFont: { size: 11, weight: "bold" },
            padding: 6,
            displayColors: false,
            callbacks: {
              title: function (context) {
                return context[0].label;
              },
              label: function (context) {
                return context.parsed.x + "%";
              },
            },
          },
        },

        scales: {
          x: {
            beginAtZero: true,
            grid: {
              color: "#333",
            },
            ticks: {
              color: "#ddd",
              font: {
                size: 8,
              },
              callback: (v) => v + "%",
            },
          },
          y: {
            grid: {
              display: false,
            },
            ticks: {
              color: "#ddd",
              font: {
                size: 9,
              },
            },
          },
        },
      },
    });
  }

  function renderCharts(pageData, countryData) {
    if (!pageData || !countryData) return;

    // Store for CSV export
    lastPagePerfData = pageData;
    lastPagePerfCountryData = countryData;

    const root = badge;
    const granularity = pageData.granularity || "day";

    createVerticalChart(root.querySelector("#pvChart"), pageData.dates, pageData.pageViews, granularity);

    createVerticalChart(root.querySelector("#visitsChart"), pageData.dates, pageData.visits, granularity);

    createVerticalChart(root.querySelector("#uvChart"), pageData.dates, pageData.visitors, granularity);

    createHorizontalChart(root.querySelector("#countryChart"), countryData.countries, countryData.pageViews);
  }

  async function updateFilterCondition() {
    const el = badge.querySelector("#filterCondition");
    if (!el) return;

    const { pageIdentifierCondition } = await chrome.storage.local.get("pageIdentifierCondition");

    if (!pageIdentifierCondition) {
      el.textContent = "";
      return;
    }

    el.textContent = `Filter: ${pageIdentifierCondition}`;
    el.title = pageIdentifierCondition;
  }

  // =============================================
  // CUSTOM REPORT FUNCTIONS
  // =============================================

  async function loadCustomReportTab() {
    const { customReportConfig: config } = await chrome.storage.local.get("customReportConfig");
    customReportConfig = config;

    if (!config || !config.enabled || !config.primaryDimension?.id || !config.primaryValue) {
      // Disable custom report tab
      tabCustomReport.classList.add("disabled");
      tabCustomReport.classList.remove("active");
      tabContentCustomReport.classList.remove("active");
      // Ensure page perf tab is active
      if (!tabPagePerf.classList.contains("active")) {
        switchTab("pagePerf");
      }
      return;
    }

    // Enable custom report tab
    tabCustomReport.classList.remove("disabled");

    // Set primary filter label
    const primaryLabel = badge.querySelector("#crPrimaryLabel");
    if (primaryLabel) {
      primaryLabel.textContent = `${config.primaryDimension.displayLabel} ${config.primaryMatch} '${config.primaryValue}'`;
      primaryLabel.title = primaryLabel.textContent;
    }

    // Set secondary label and dropdown visibility
    const secondaryLabel = badge.querySelector("#crSecondaryLabel");
    const filterSep = badge.querySelector(".cr-filter-sep");
    if (config.secondaryDimension?.id) {
      // Build label like "Prop3 - Platform"
      const secDisplay = config.secondaryDimension.displayLabel || config.secondaryDimension.id;
      if (secondaryLabel) secondaryLabel.textContent = `${secDisplay}:`;
      if (filterSep) filterSep.style.display = "inline";
      crSecondarySelect.style.display = "inline-block";
      populateSecondaryDropdown();
    } else {
      // No secondary configured — hide secondary elements
      if (secondaryLabel) secondaryLabel.textContent = "";
      if (filterSep) filterSep.style.display = "none";
      crSecondarySelect.style.display = "none";
    }
  }

  async function populateSecondaryDropdown() {
    const { secondaryDimensionValues } = await chrome.storage.local.get("secondaryDimensionValues");
    crSecondarySelect.innerHTML = "";

    // "No Filter" option
    const noFilterOpt = document.createElement("option");
    noFilterOpt.value = "";
    noFilterOpt.textContent = "No Filter";
    crSecondarySelect.appendChild(noFilterOpt);

    if (secondaryDimensionValues) {
      try {
        crSecondaryValues = JSON.parse(secondaryDimensionValues);
        crSecondaryValues.forEach((v) => {
          const opt = document.createElement("option");
          opt.value = v.value;
          opt.textContent = v.value;
          crSecondarySelect.appendChild(opt);
        });
      } catch (e) {
        crSecondaryValues = [];
      }
    }
  }

  async function fetchAndRenderCustomReport() {
    if (!customReportConfig || !customReportConfig.enabled) return;

    showLoading();
    let resp = await checkToken();
    if (!resp) {
      hideLoading();
      return;
    }

    const customFilters = {
      primaryDimension: customReportConfig.primaryDimension.id,
      primaryMatch: customReportConfig.primaryMatch || "exact",
      primaryValue: customReportConfig.primaryValue,
    };

    // Add secondary filter if selected
    const secondaryValue = crSecondarySelect.value;
    if (secondaryValue && customReportConfig.secondaryDimension?.id) {
      customFilters.secondaryDimension = customReportConfig.secondaryDimension.id;
      customFilters.secondaryValue = secondaryValue;
    }

    const [crPageData, crCountryData] = await Promise.all([getCustomReportData("pageViews", currentDatePreset, customFilters), getCustomReportData("countryData", currentDatePreset, customFilters)]);
    hideLoading();

    renderCustomReportMetrics(crPageData);
    renderCustomReportCharts(crPageData, crCountryData);
    updateCustomReportFilterCondition(customFilters);
    updateCrChartTitles();
  }

  function renderCustomReportMetrics(pageData) {
    const pvEl = badge.querySelector("#crMetricPV");
    const visitsEl = badge.querySelector("#crMetricVisits");
    const uvEl = badge.querySelector("#crMetricVisitors");

    if (!pageData) {
      if (pvEl) pvEl.textContent = "0";
      if (visitsEl) visitsEl.textContent = "0";
      if (uvEl) uvEl.textContent = "0";
      return;
    }

    const totalPV = pageData.filteredTotals?.[0] || 0;
    const totalVisits = pageData.filteredTotals?.[1] || 0;
    const totalVisitors = pageData.filteredTotals?.[2] || 0;

    if (pvEl) pvEl.textContent = formatLargeNumber(totalPV);
    if (visitsEl) visitsEl.textContent = formatLargeNumber(totalVisits);
    if (uvEl) uvEl.textContent = formatLargeNumber(totalVisitors);
  }

  function renderCustomReportCharts(pageData, countryData) {
    // Store for CSV export
    lastCrData = pageData;
    lastCrCountryData = countryData;

    const root = badge;
    const granularity = pageData?.granularity || "day";

    // Destroy existing CR charts
    Object.values(crChartInstances).forEach((c) => c?.destroy());
    crChartInstances = {};

    if (pageData) {
      createVerticalChart(root.querySelector("#crPvChart"), pageData.dates, pageData.pageViews, granularity, crChartInstances);
      createVerticalChart(root.querySelector("#crVisitsChart"), pageData.dates, pageData.visits, granularity, crChartInstances);
      createVerticalChart(root.querySelector("#crUvChart"), pageData.dates, pageData.visitors, granularity, crChartInstances);
    }

    if (countryData) {
      createHorizontalChart(root.querySelector("#crCountryChart"), countryData.countries, countryData.pageViews, crChartInstances);
    }
  }

  function updateCrChartTitles() {
    const shortLabels = {
      "7d": "7d",
      "3w": "3w",
      "5w": "5w",
      "3m": "3m",
      "6m": "6m",
    };
    const shortLabel = shortLabels[currentDatePreset] || "7d";
    const pvTitle = badge.querySelector("#crPvChartTitle");
    const visitsTitle = badge.querySelector("#crVisitsChartTitle");
    const uvTitle = badge.querySelector("#crUvChartTitle");
    if (pvTitle) pvTitle.textContent = `Pageviews (${shortLabel})`;
    if (visitsTitle) visitsTitle.textContent = `Visits (${shortLabel})`;
    if (uvTitle) uvTitle.textContent = `Visitors (${shortLabel})`;
  }

  function updateCustomReportFilterCondition(customFilters) {
    // No-op: filter conditions are now displayed in the filter bar at the top
    // Primary label is set in loadCustomReportTab
    // Secondary is handled by the dropdown
  }
}

function getPageData(datePreset = "7d") {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "GET_REPORT",
        pageIdentifier: pageIdentifier,
        reportType: "pageViews",
        datePreset: datePreset,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          if (globalThis.debugExtension) {
            console.error(chrome.runtime.lastError);
          }
          resolve(null);
          return;
        }

        if (response.success) {
          response.reportData.dates = response.reportData.dates.map((dt) => dt.split(",")[0]);
          resolve(response.reportData);
        } else {
          resolve(null);
        }
      },
    );
  });
}

function getCountryData(datePreset = "7d") {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "GET_REPORT",
        pageIdentifier: pageIdentifier,
        reportType: "countryData",
        datePreset: datePreset,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          if (globalThis.debugExtension) {
            console.error(chrome.runtime.lastError);
          }
          resolve(null);
          return;
        }
        if (response.success) {
          resolve(response.reportData);
        } else {
          resolve(null);
        }
      },
    );
  });
}

function getCustomReportData(reportType = "pageViews", datePreset = "7d", customFilters = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "GET_CUSTOM_REPORT",
        pageIdentifier: pageIdentifier,
        reportType: reportType,
        datePreset: datePreset,
        customFilters: customFilters,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          if (globalThis.debugExtension) {
            console.error(chrome.runtime.lastError);
          }
          resolve(null);
          return;
        }
        if (response && response.success) {
          if (reportType === "pageViews" && response.reportData?.dates) {
            response.reportData.dates = response.reportData.dates.map((dt) => dt.split(",")[0]);
          }
          resolve(response.reportData);
        } else {
          resolve(null);
        }
      },
    );
  });
}

async function getEnableOnPageFlag() {
  const response = await sendMessageAsync({ type: "GET_ENABLED_ON_PAGE_FLAG" });

  if (response && typeof response.isEnabled === "boolean") {
    return response.isEnabled;
  }

  return false;
}

function isDesktop() {
  return window.innerWidth >= 900;
}

function sendMessageAsync(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          if (globalThis.debugExtension) {
            console.error(chrome.runtime.lastError);
          }
          resolve(null); // fallback
          return;
        }
        resolve(response);
      });
    } catch (err) {
      if (globalThis.debugExtension) {
        console.error("[Extension Exception]", message.type, err);
      }
      resolve(null);
    }
  });
}
