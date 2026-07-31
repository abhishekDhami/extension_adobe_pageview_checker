const tokenUrl = "https://ims-na1.adobelogin.com/ims/token/v3";
const authUrl = "https://ims-na1.adobelogin.com/ims/authorize";
const analyticsDiscoveryUrl = "https://analytics.adobe.io/discovery/me";
const reportingAPIURL = "https://analytics.adobe.io/api";
let sessionKey = null; // In-memory encryption key
let sessionTimer = null; // Timer for automatic expiry
const SESSION_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours
const WRAPPED_KEY_STORAGE = "wrappedSessionKey";
const DERIVED_KEY_SESSION = "derivedKeyCache";
const CONTENT_SCRIPT_ID = "aa-pageviews-content";

if (globalThis.debugExtension === undefined) {
  globalThis.debugExtension = false;
}

// =====================
// Dynamic content script registration
// =====================

function normalizeDomainEntry(entry) {
  return String(entry || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
}

function buildContentScriptMatches(allowedDomains) {
  if (!allowedDomains || !Array.isArray(allowedDomains) || allowedDomains.length === 0) {
    return ["<all_urls>"];
  }

  const matches = new Set();
  for (const raw of allowedDomains) {
    const domain = normalizeDomainEntry(raw);
    if (!domain) continue;
    if (domain === "localhost") {
      matches.add("*://localhost/*");
      matches.add("*://127.0.0.1/*");
      continue;
    }
    matches.add(`*://${domain}/*`);
    matches.add(`*://*.${domain}/*`);
  }

  return matches.size > 0 ? [...matches] : ["<all_urls>"];
}

function isUrlAllowedForDomains(url, allowedDomains) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (!allowedDomains || !Array.isArray(allowedDomains) || allowedDomains.length === 0) {
      return true;
    }
    return allowedDomains.some((domain) => {
      const normalized = normalizeDomainEntry(domain);
      if (!normalized) return false;
      return hostname === normalized || hostname.endsWith("." + normalized);
    });
  } catch {
    return false;
  }
}

async function injectIntoOpenMatchingTabs(allowedDomains) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  } catch {
    return;
  }

  const files = ["lib/chart.umd.min.js", "content.js"];
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    if (!isUrlAllowedForDomains(tab.url, allowedDomains)) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files,
      });
    } catch {
      // Tab may be restricted or script already present
    }
  }
}

async function updateContentScriptRegistration() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  } catch {
    // Not registered yet
  }

  const { enableOnPage, allowedDomains } = await chrome.storage.local.get(["enableOnPage", "allowedDomains"]);
  if (enableOnPage !== true) {
    return;
  }

  const matches = buildContentScriptMatches(allowedDomains);
  const domains = Array.isArray(allowedDomains) ? allowedDomains : [];

  await chrome.scripting.registerContentScripts([
    {
      id: CONTENT_SCRIPT_ID,
      js: ["lib/chart.umd.min.js", "content.js"],
      matches,
      runAt: "document_end",
      persistAcrossSessions: true,
    },
  ]);

  await injectIntoOpenMatchingTabs(domains);
}

function isTrustedExtensionSender(sender) {
  return Boolean(sender && sender.id === chrome.runtime.id);
}

chrome.runtime.onInstalled.addListener(() => {
  updateContentScriptRegistration();
});

chrome.runtime.onStartup.addListener(() => {
  updateContentScriptRegistration();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.enableOnPage || changes.allowedDomains)) {
    updateContentScriptRegistration();
  }
});

updateContentScriptRegistration();

// =====================
// Date Preset Helpers
// =====================

// Format date as YYYY-MM-DD using local timezone (avoids UTC shift with toISOString)
function formatLocalDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const DATE_PRESETS = {
  "7d": { label: "Last 7 Days", days: 7, granularity: "day", dimension: "variables/daterangeday" },
  "3w": { label: "Last 3 Weeks", weeks: 3, granularity: "week", dimension: "variables/daterangeweek" },
  "5w": { label: "Last 5 Weeks", weeks: 5, granularity: "week", dimension: "variables/daterangeweek" },
  "3m": { label: "Last 3 Months", months: 3, granularity: "month", dimension: "variables/daterangemonth" },
  "6m": { label: "Last 6 Months", months: 6, granularity: "month", dimension: "variables/daterangemonth" },
};

// Get today's date in the report suite's timezone (falls back to local timezone)
function getTodayInTimezone(tz) {
  try {
    if (tz) {
      // Intl.DateTimeFormat with en-CA locale gives YYYY-MM-DD format
      const dateStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      // Parse YYYY-MM-DD into a local Date object
      const [y, m, d] = dateStr.split("-").map(Number);
      return new Date(y, m - 1, d);
    }
  } catch (e) {
    console.log("Error using report suite timezone, falling back to local:", e);
  }
  return new Date();
}

function getDateRangeForPreset(presetKey, reportSuiteTimezone) {
  const preset = DATE_PRESETS[presetKey] || DATE_PRESETS["7d"];
  const today = getTodayInTimezone(reportSuiteTimezone);
  let startDate, endDate, limit;

  if (preset.granularity === "day") {
    // Last N days: from (today - N+1) to (today + 1) to include today
    endDate = new Date(today);
    endDate.setDate(today.getDate() + 1);
    startDate = new Date(today);
    startDate.setDate(today.getDate() - (preset.days - 1));
    limit = preset.days;
  } else if (preset.granularity === "week") {
    // For weekly: go back N full ISO weeks from the current week
    // Find start of current ISO week (Monday)
    const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon...
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const currentWeekMonday = new Date(today);
    currentWeekMonday.setDate(today.getDate() + mondayOffset);

    // End date is next Monday (to include current week in the range)
    endDate = new Date(currentWeekMonday);
    endDate.setDate(currentWeekMonday.getDate() + 7);

    // Start date is N weeks before current week Monday
    startDate = new Date(currentWeekMonday);
    startDate.setDate(currentWeekMonday.getDate() - (preset.weeks - 1) * 7);
    limit = preset.weeks;
  } else if (preset.granularity === "month") {
    // For monthly: include current month + (N-1) previous months
    // End date is start of next month (to include current month fully)
    endDate = new Date(today.getFullYear(), today.getMonth() + 1, 1);

    // Start date is first day of (current month - (N-1))
    startDate = new Date(today.getFullYear(), today.getMonth() - (preset.months - 1), 1);
    limit = preset.months;
  }

  const dateRangeString = `${formatLocalDate(startDate)}T00:00:00.000/${formatLocalDate(endDate)}T00:00:00.000`;

  return {
    dateRangeString,
    dimension: preset.dimension,
    granularity: preset.granularity,
    limit,
    label: preset.label,
  };
}

// Listen for extension icon click to open options page
chrome.action.onClicked.addListener(() => {
  chrome.tabs.query({}, (tabs) => {
    const existing = tabs.find((tab) => tab.url?.includes("aph_options.html"));
    if (existing) {
      chrome.tabs.update(existing.id, { active: true });
    } else {
      chrome.runtime.openOptionsPage();
    }
  });
});

function safeAdobeTruncate(inpString, byteLimit = 100) {
  let maxLimitReached = false;
  try {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8");

    // 1. Convert to UTF-8 bytes
    const allBytes = encoder.encode(inpString);

    if (allBytes.length <= byteLimit - 1) return { opStr: inpString, maxLimitReached: maxLimitReached };

    // 2. Slice to the byte limit
    const truncatedBytes = allBytes.slice(0, byteLimit);
    if (truncatedBytes.length >= byteLimit - 1) maxLimitReached = true;

    // 3. Decode back to string
    let decodedString = decoder.decode(truncatedBytes);

    // 4. Remove the corrupted replacement character if it's at the end
    return { opStr: decodedString.replace(/\uFFFD$/g, ""), maxLimitReached: maxLimitReached };
  } catch (err) {
    return { opStr: "", maxLimitReached: maxLimitReached };
  }
}

async function getEnableOnPageFlag() {
  const { enableOnPage } = await chrome.storage.local.get("enableOnPage");
  if (enableOnPage === undefined) return false;
  return enableOnPage;
}

function getReport(pageIdentifier, reportType = "pageViews", datePreset = "7d") {
  return new Promise(async (resolve, reject) => {
    try {
      const { selectedCompanyID, selectedrsID, pageIdentifierConfig, reportSuiteTimezone } = await chrome.storage.local.get([
        "selectedCompanyID",
        "selectedrsID",
        "pageIdentifierConfig",
        "reportSuiteTimezone",
      ]);
      const clientCreds = await decryptClientCredentials();
      if (!clientCreds) {
        resolve({ reportData: null, success: false });
        return;
      }
      const client_id = clientCreds.client_id;

      if (!pageIdentifierConfig?.adobeDimensionConfig) {
        resolve({ reportData: null, success: false, error: "Page identifier not configured." });
        return;
      }

      if (pageIdentifier == undefined) {
        resolve({ reportData: null, success: false });
        return;
      }

      // Use preset for date range and granularity
      const presetConfig = getDateRangeForPreset(datePreset, reportSuiteTimezone);
      let dateRangeString = presetConfig.dateRangeString;

      let adobeDimension = pageIdentifierConfig.adobeDimensionConfig.dimension || "Page";
      adobeDimension = adobeDimension.toLowerCase();
      let pageIdentifierValue = "";
      if (pageIdentifierConfig.source === "url") {
        pageIdentifierValue = pageIdentifier.value;
        let urlObj = new URL(pageIdentifierValue);
        if (pageIdentifierConfig.urlConfig?.removeQuery) {
          urlObj.search = "";
        }
        if (pageIdentifierConfig.urlConfig?.removeHash) {
          urlObj.hash = "";
        }
        if (pageIdentifierConfig.urlConfig?.urlType === "path") {
          pageIdentifierValue = urlObj.origin + urlObj.pathname;
        } else {
          pageIdentifierValue = urlObj.toString();
        }
      } else if (pageIdentifierConfig.source === "title") {
        pageIdentifierValue = pageIdentifier.value;
        if (pageIdentifierConfig.titleConfig?.lowercase) {
          pageIdentifierValue = pageIdentifierValue.toLowerCase();
        }
        if (pageIdentifierConfig.titleConfig?.trim) {
          pageIdentifierValue = pageIdentifierValue.trim();
        }
      } else if (pageIdentifierConfig.source === "window") {
        pageIdentifierValue = pageIdentifier.value;
      } else {
        resolve({ reportData: null, success: false });
        return;
      }

      //Cropping value based on max length supported by Adobe Analytics for that dimension
      let truncationResult = { opStr: pageIdentifierValue, maxLimitReached: false };
      if (adobeDimension === "page" || adobeDimension.includes("prop")) {
        truncationResult = safeAdobeTruncate(pageIdentifierValue, 100);
        pageIdentifierValue = truncationResult.opStr;
      } else if (adobeDimension.includes("evar")) {
        truncationResult = safeAdobeTruncate(pageIdentifierValue, 250);
        pageIdentifierValue = truncationResult.opStr;
      }
      if (pageIdentifierValue.length === 0) {
        resolve({ reportData: null, success: false });
        return;
      }
      //creating matching condition, which can be shown on widget
      let matchCondition = `${adobeDimension} ${pageIdentifierConfig.adobeDimensionConfig.match} '${pageIdentifierValue}'`;
      chrome.storage.local.set({
        pageIdentifierCondition: matchCondition,
      });

      let segmentMatchCondition = pageIdentifierConfig.adobeDimensionConfig.match;
      if (segmentMatchCondition === "exact") {
        segmentMatchCondition = "streq";
      } else if (segmentMatchCondition === "contains") {
        segmentMatchCondition = "contains";
      } else {
        segmentMatchCondition = "contains";
      }

      //When user has selected 'exact' and pageIdentifierValue is already truncated then we will convert matching condition to 'contains'
      if (segmentMatchCondition === "streq" && truncationResult.maxLimitReached === true) {
        segmentMatchCondition = "contains";
      }

      //Reading data from Cache first — include datePreset in cache key
      let cacheReadResponse = await readCache(
        selectedrsID,
        pageIdentifier.value,
        pageIdentifierConfig.adobeDimensionConfig.dimension,
        pageIdentifierConfig.adobeDimensionConfig.match,
        reportType,
        datePreset,
      );
      if (cacheReadResponse.data != null && cacheReadResponse.hit === true) {
        resolve({ reportData: cacheReadResponse.data, success: true, fromCache: true });
        return;
      }

      let metricsArray = [],
        rowDimension = "",
        customSettings = {};
      if (reportType === "countryData") {
        metricsArray = [
          {
            id: "metrics/pageviews",
            columnId: "0",
            sort: "desc",
          },
        ];
        rowDimension = "variables/geocountry";
        customSettings = {
          limit: 5,
        };
      } else if (reportType === "pageViews") {
        metricsArray = [
          {
            id: "metrics/pageviews",
            columnId: "0",
          },
          {
            id: "metrics/visits",
            columnId: "1",
          },
          {
            id: "metrics/visitors",
            columnId: "2",
          },
        ];
        // Use dimension from preset (daterangeday or daterangeweek)
        rowDimension = presetConfig.dimension;
        customSettings = {
          limit: presetConfig.limit,
          dimensionSort: "asc",
        };
      }
      let predicates = [];
      predicates.push({
        func: "container",
        context: "hits",
        pred: {
          func: segmentMatchCondition,
          val: {
            func: "attr",
            name: `variables/${adobeDimension}`,
          },
          str: pageIdentifierValue,
        },
      });
      let reportReq = {
        rsid: selectedrsID,
        globalFilters: [
          {
            type: "dateRange",
            dateRange: dateRangeString,
          },
          {
            type: "segment",
            segmentDefinition: {
              func: "segment",
              version: [1, 0, 0],
              container: {
                func: "container",
                context: "hits",
                pred: {
                  func: "or",
                  preds: predicates,
                },
              },
            },
          },
        ],
        metricContainer: {
          metrics: metricsArray,
        },
        dimension: rowDimension,
        settings: customSettings,
      };
      let finalReportURL = `${reportingAPIURL}/${selectedCompanyID}/reports`;
      let tokenResponse = await getValidAccessToken();
      let accessToken;
      if (tokenResponse.success !== true) {
        resolve(tokenResponse);
        return;
      }
      accessToken = tokenResponse.accessToken;
      const resp = await fetch(finalReportURL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "x-api-key": client_id,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(reportReq),
      });
      if (!resp.ok) {
        resolve({ reportData: null, success: false, error: `Report API error (${resp.status})` });
        return;
      }
      const reportData = await resp.json();
      if (reportData.error_code) {
        resolve({ reportData: null, success: false, error: reportData.message || "Report API error" });
        return;
      }
      let rows = reportData?.rows || [];
      if (rows && rows.length > 0) {
        let data = null;
        if (reportType === "pageViews") {
          data = { dates: [], pageViews: [], visits: [], visitors: [], filteredTotals: [], granularity: presetConfig.granularity };
          rows.forEach((row) => {
            data.dates.push(row.value);
            data.pageViews.push(row.data[0]);
            data.visits.push(row.data[1]);
            data.visitors.push(row.data[2]);
          });
          data.filteredTotals = reportData?.summaryData?.filteredTotals || [];
        } else if (reportType === "countryData") {
          data = { countries: [], pageViews: [], rawCounts: [] };
          let totals = reportData?.summaryData?.filteredTotals?.[0] || 0;
          rows.forEach((row) => {
            data.countries.push(row.value);
            data.rawCounts.push(row.data[0] || 0);
            let prctContribution = totals > 0 ? (row.data[0] / totals) * 100 : 0;
            prctContribution = parseFloat(prctContribution.toFixed(2));
            data.pageViews.push(prctContribution);
          });
        }
        saveCache(selectedrsID, pageIdentifier.value, pageIdentifierConfig.adobeDimensionConfig.dimension, pageIdentifierConfig.adobeDimensionConfig.match, reportType, datePreset, data);
        resolve({ reportData: data, success: true, fromCache: false });
        cleanupExpiredCache();
      } else {
        resolve({ reportData: null, success: false });
      }
      return;
    } catch (error) {
      console.log("Error fetching page view data:", error);
      resolve({ reportData: null, success: false, error: "Failed to fetch page view data." });
    }
  });
}

// Custom report: filtered by primary dimension + optional secondary dimension only (no page identifier)
// customFilters = { primaryDimension: "variables/evar5", primaryMatch: "exact"|"contains", primaryValue: "ABC",
//                   secondaryDimension: "variables/prop3" (optional), secondaryValue: "XYZ" (optional) }
function getCustomReport(pageIdentifier, reportType = "pageViews", datePreset = "7d", customFilters = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      const { selectedCompanyID, selectedrsID, reportSuiteTimezone } = await chrome.storage.local.get(["selectedCompanyID", "selectedrsID", "reportSuiteTimezone"]);
      const clientCreds = await decryptClientCredentials();
      if (!clientCreds) {
        resolve({ reportData: null, success: false });
        return;
      }
      const client_id = clientCreds.client_id;

      if (!customFilters.primaryDimension || !customFilters.primaryValue) {
        resolve(null);
        return;
      }

      const presetConfig = getDateRangeForPreset(datePreset, reportSuiteTimezone);
      let dateRangeString = presetConfig.dateRangeString;

      // Build custom report cache key
      let customCacheKey = `CRCACHE||${selectedrsID}||${customFilters.primaryDimension}||${customFilters.primaryValue}||${customFilters.secondaryDimension || "none"}||${customFilters.secondaryValue || "none"}||${reportType}||${datePreset}`;
      let pattern = /[^a-zA-Z0-9|\s]/g;
      customCacheKey = customCacheKey.replace(pattern, "");

      // Check cache
      const cacheResult = await chrome.storage.local.get([customCacheKey]);
      if (cacheResult && cacheResult[customCacheKey]) {
        const { data, ttl } = cacheResult[customCacheKey];
        const now = new Date().getTime();
        if (ttl && now <= ttl) {
          resolve({ reportData: data, success: true, fromCache: true });
          return;
        } else {
          await chrome.storage.local.remove([customCacheKey]);
        }
      }

      // Build metrics and dimension
      let metricsArray = [],
        rowDimension = "",
        customSettings = {};
      if (reportType === "countryData") {
        metricsArray = [{ id: "metrics/pageviews", columnId: "0", sort: "desc" }];
        rowDimension = "variables/geocountry";
        customSettings = { limit: 5 };
      } else if (reportType === "pageViews") {
        metricsArray = [
          { id: "metrics/pageviews", columnId: "0" },
          { id: "metrics/visits", columnId: "1" },
          { id: "metrics/visitors", columnId: "2" },
        ];
        rowDimension = presetConfig.dimension;
        customSettings = { limit: presetConfig.limit, dimensionSort: "asc" };
      }

      // Build segment predicates: primary dimension AND optional secondary (NO page identifier)
      let andPredicates = [];

      // Primary dimension predicate
      let primaryMatchFunc = customFilters.primaryMatch === "exact" ? "streq" : "contains";
      andPredicates.push({
        func: "container",
        context: "hits",
        pred: {
          func: primaryMatchFunc,
          val: { func: "attr", name: customFilters.primaryDimension },
          str: customFilters.primaryValue,
        },
      });

      // Secondary dimension predicate (optional)
      if (customFilters.secondaryDimension && customFilters.secondaryValue) {
        andPredicates.push({
          func: "container",
          context: "hits",
          pred: {
            func: "streq",
            val: { func: "attr", name: customFilters.secondaryDimension },
            str: customFilters.secondaryValue,
          },
        });
      }

      // Build segment — use "and" for multiple predicates, single pred directly if only primary
      let segmentPred;
      if (andPredicates.length === 1) {
        segmentPred = andPredicates[0];
      } else {
        segmentPred = {
          func: "container",
          context: "hits",
          pred: {
            func: "and",
            preds: andPredicates,
          },
        };
      }

      let reportReq = {
        rsid: selectedrsID,
        globalFilters: [
          { type: "dateRange", dateRange: dateRangeString },
          {
            type: "segment",
            segmentDefinition: {
              func: "segment",
              version: [1, 0, 0],
              container: segmentPred,
            },
          },
        ],
        metricContainer: { metrics: metricsArray },
        dimension: rowDimension,
        settings: customSettings,
      };

      let finalReportURL = `${reportingAPIURL}/${selectedCompanyID}/reports`;
      let tokenResponse = await getValidAccessToken();
      if (tokenResponse.success !== true) {
        resolve(tokenResponse);
        return;
      }
      let accessToken = tokenResponse.accessToken;

      const resp = await fetch(finalReportURL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "x-api-key": client_id,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(reportReq),
      });

      if (!resp.ok) {
        resolve({ reportData: null, success: false, error: `Report API error (${resp.status})` });
        return;
      }
      const reportData = await resp.json();
      if (reportData.error_code) {
        resolve({ reportData: null, success: false, error: reportData.message || "Report API error" });
        return;
      }
      let rows = reportData?.rows || [];
      if (rows && rows.length > 0) {
        let data = null;
        if (reportType === "pageViews") {
          data = { dates: [], pageViews: [], visits: [], visitors: [], filteredTotals: [], granularity: presetConfig.granularity };
          rows.forEach((row) => {
            data.dates.push(row.value);
            data.pageViews.push(row.data[0]);
            data.visits.push(row.data[1]);
            data.visitors.push(row.data[2]);
          });
          data.filteredTotals = reportData?.summaryData?.filteredTotals || [];
        } else if (reportType === "countryData") {
          data = { countries: [], pageViews: [], rawCounts: [] };
          let totals = reportData?.summaryData?.filteredTotals?.[0] || 0;
          rows.forEach((row) => {
            data.countries.push(row.value);
            data.rawCounts.push(row.data[0] || 0);
            let prctContribution = totals > 0 ? (row.data[0] / totals) * 100 : 0;
            prctContribution = parseFloat(prctContribution.toFixed(2));
            data.pageViews.push(prctContribution);
          });
        }
        // Save to cache
        let ttl = new Date().getTime() + 15 * 60 * 1000;
        await chrome.storage.local.set({ [customCacheKey]: { data: data, ttl } });
        resolve({ reportData: data, success: true, fromCache: false });
        cleanupExpiredCache();
      } else {
        resolve({ reportData: null, success: false });
      }
    } catch (error) {
      console.log("Error fetching custom report data:", error);
      resolve({ reportData: null, success: false, error: "Failed to fetch custom report data." });
    }
  });
}

function readCache(rsid, pageIdentifierValue, pageIdentifierDimension, pageIdentifierMatchType, reportType, datePreset = "7d") {
  return new Promise(async (resolve, reject) => {
    try {
      let cacheKey = `CACHE||${rsid}||${pageIdentifierDimension}||${pageIdentifierMatchType}||${pageIdentifierValue}||${reportType}||${datePreset}`;

      let pattern = /[^a-zA-Z0-9|\s]/g;
      cacheKey = cacheKey.replace(pattern, "");
      const result = await chrome.storage.local.get([cacheKey]);
      if (!result || !result[cacheKey]) {
        resolve({ hit: false, data: null });
        return;
      }
      const { data, ttl } = result[cacheKey];
      const now = new Date().getTime();
      // TTL expired
      if (!ttl || now > ttl) {
        await chrome.storage.local.remove([cacheKey]);
        resolve({ hit: false, data: null });
        return;
      }
      // Cache hit
      resolve({ hit: true, data });
    } catch (err) {
      resolve({ error: "Error reading from cache.", data: null });
    }
  });
}

async function saveCache(rsid, pageIdentifierValue, pageIdentifierDimension, pageIdentifierMatchType, reportType, datePreset = "7d", reportData) {
  return new Promise(async (resolve, reject) => {
    try {
      let cacheKey = `CACHE||${rsid}||${pageIdentifierDimension}||${pageIdentifierMatchType}||${pageIdentifierValue}||${reportType}||${datePreset}`;

      let pattern = /[^a-zA-Z0-9|\s]/g;
      cacheKey = cacheKey.replace(pattern, "");
      let ttl = new Date().getTime() + 15 * 60 * 1000; //15 minutes TTL
      await chrome.storage.local.set({ [cacheKey]: { data: reportData, ttl } });
      resolve({ success: true });
    } catch (err) {
      resolve({ error: "Error saving to cache.", data: null });
    }
  });
}

async function cleanupExpiredCache() {
  const now = Date.now();

  const allItems = await chrome.storage.local.get(null);
  const keysToRemove = [];

  for (const [key, value] of Object.entries(allItems)) {
    if (!key.startsWith("CACHE||") && !key.startsWith("CRCACHE||")) continue;
    if (!value || !value.ttl || now > value.ttl) {
      keysToRemove.push(key);
    }
  }

  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
}

// Function to set or reset session key
function setSessionKey(key) {
  sessionKey = key;
  // Reset expiry timer whenever new key set
  resetSessionTimer();
}

// Function to clear the session key
function clearSessionKey() {
  sessionKey = null;
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = null;
}

// Reset the expiry timer
function resetSessionTimer() {
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    clearSessionKey();
  }, SESSION_TIMEOUT_MS);
}

// Listen for messages from options or popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  let args = msg.args || {};

  const handlers = {
    // =========================
    // TOKEN
    // =========================
    GET_TOKEN_VALIDITY_OPTIONS: async () => {
      let resp = await getValidAccessToken();
      sendResponseMessage("GET_TOKEN_VALIDITY_OPTIONS_RESPONSE", resp, args);
      return true;
    },

    GET_TOKEN_VALIDITY_CONTENT: async () => {
      let response = await getValidAccessToken();
      return response;
    },

    GET_KEY_STATUS: () => {
      let hasKey = sessionKey !== null;
      return { hasKey };
    },

    // =========================
    // AUTH (IMPORTANT: keep event-based)
    // =========================
    AUTHENTICATE_USER: async () => {
      let { client_id, client_secret, org_id, userpassword } = msg;

      const redirectUri = chrome.identity.getRedirectURL();
      const scope = "additional_info.projectedProductContext, openid, read_organizations, additional_info.job_function, AdobeID";

      const params = new URLSearchParams({
        client_id,
        response_type: "code",
        redirect_uri: redirectUri,
        scope,
      });

      let authUrlwithParam = `${authUrl}?${params.toString()}`;

      chrome.identity.launchWebAuthFlow({ url: authUrlwithParam, interactive: true }, async (redirectResponse) => {
        try {
          if (chrome.runtime.lastError || !redirectResponse) {
            sendResponseMessage("AUTHENTICATE_USER_RESPONSE", { error: "Authentication failed. Please try again." }, args);
            return;
          }

          const code = new URL(redirectResponse).searchParams.get("code");

          const body = new URLSearchParams({
            grant_type: "authorization_code",
            client_id,
            client_secret,
            code,
          });

          const tokenResp = await fetch(tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
          });

          const tokenData = await tokenResp.json();

          if (!tokenData.access_token) {
            let msgErr = "Token fetch failed.";
            if (tokenData.error) msgErr += ` Error: ${tokenData.error}`;

            sendResponseMessage("AUTHENTICATE_USER_RESPONSE", { error: msgErr }, args);
            return;
          }

          let expires_at = Date.now() + (tokenData.expires_in || 3600) * 1000;

          await encryptAndStoreCredentials(userpassword, tokenData.access_token, tokenData.refresh_token, client_id, client_secret, org_id, expires_at);

          let companyDataResponse = await fetchCompaniesAndSuites();

          sendResponseMessage("AUTHENTICATE_USER_RESPONSE", companyDataResponse.success ? { success: true, companiesData: companyDataResponse.data } : companyDataResponse, args);
        } catch (error) {
          console.error(error);
          sendResponseMessage("AUTHENTICATE_USER_RESPONSE", { error: "Authentication failed." }, args);
        }
      });

      return true; // keep alive
    },

    // =========================
    // DATA
    // =========================
    FETCH_COMPANIES: async () => {
      let resp = await fetchCompaniesAndSuites();
      return resp.success ? { success: true, companiesData: resp.data } : resp;
    },

    FETCH_REPORT_SUITES: async () => {
      let resp = await fetchReportSuites(msg.companyId);
      return resp.success ? { success: true, suitesData: resp.suitesData } : resp;
    },

    VALIDATE_PASSWORD: async () => {
      let isPasswordValid = await validatePassword(msg.password);
      return { isPasswordValid };
    },

    OPEN_EXTENSION_OPTION: () => {
      chrome.runtime.openOptionsPage();
      return { success: true };
    },

    GET_ENABLED_ON_PAGE_FLAG: async () => {
      const isEnabled = await getEnableOnPageFlag();
      return { isEnabled };
    },

    GET_PAGE_IDENTIFIERS: async () => {
      return new Promise((resolve) => {
        chrome.storage.local.get(["pageIdentifierConfig"], (result) => {
          let config = result.pageIdentifierConfig;

          if (config) {
            resolve({
              success: true,
              pageIdentifier: {
                source: config.source,
                windowPath: config.windowPathConfig?.windowPath || "",
              },
            });
          } else {
            resolve({ success: false });
          }
        });
      });
    },

    GET_REPORT: async () => {
      return await getReport(msg.pageIdentifier, msg.reportType, msg.datePreset);
    },

    GET_DATE_PRESET: async () => {
      return new Promise((resolve) => {
        chrome.storage.local.get(["datePreset"], (result) => {
          resolve({ datePreset: result.datePreset || "7d" });
        });
      });
    },

    SET_DATE_PRESET: async () => {
      return new Promise((resolve) => {
        chrome.storage.local.set({ datePreset: msg.datePreset }, () => {
          resolve({ success: true });
        });
      });
    },

    FETCH_DIMENSIONS: async () => {
      return await fetchDimensions(msg.companyId, msg.rsid);
    },

    FETCH_DIMENSION_VALUES: async () => {
      return await fetchDimensionValues(msg.companyId, msg.rsid, msg.dimensionId, msg.limit, msg.segmentFilter);
    },

    GET_CUSTOM_REPORT: async () => {
      return await getCustomReport(msg.pageIdentifier, msg.reportType, msg.datePreset, msg.customFilters);
    },
  };
  if (handlers[msg.type]) {
    if (!isTrustedExtensionSender(sender)) {
      sendResponse({ success: false, error: "Unauthorized sender" });
      return false;
    }

    const result = handlers[msg.type](msg, sender);

    // 🔥 IMPORTANT: handle both Promise + sync
    if (result instanceof Promise) {
      result
        .then((res) => sendResponse(res))
        .catch((err) => {
          if (globalThis.debugExtension) {
            console.error("Handler error:", msg.type, err);
          }
          sendResponse({ success: false, error: err.message });
        });
      return true; // keep channel open (Edge needs this)
    } else {
      sendResponse(result);
      return false;
    }
  }

  sendResponse({ success: false, error: "Unknown message type" });
  return false;
});

function sendResponseMessage(type, payload, args) {
  chrome.runtime.sendMessage({ type, ...payload, args: args });
}

async function fetchCompaniesAndSuites() {
  let tokenResponse = await getValidAccessToken();
  let accessToken;
  if (tokenResponse.success !== true) {
    return tokenResponse;
  }
  accessToken = tokenResponse.accessToken;
  const clientCreds = await decryptClientCredentials();
  if (!clientCreds) return { error: "Unable to decrypt credentials. Please re-enter password." };
  const { client_id } = clientCreds;
  const { org_id } = await chrome.storage.local.get(["org_id"]);
  const resp = await fetch(analyticsDiscoveryUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, "x-api-key": client_id },
  });
  const data = await resp.json();
  if (data.error_code) {
    return { ...data, reauthenticate: true };
  }
  return { data, success: true };
}

async function fetchReportSuites(companyId) {
  let tokenResponse = await getValidAccessToken();
  let accessToken;
  if (tokenResponse.success !== true) {
    return tokenResponse;
  }
  accessToken = tokenResponse.accessToken;
  const clientCreds = await decryptClientCredentials();
  if (!clientCreds) return { error: "Unable to decrypt credentials. Please re-enter password." };
  const { client_id } = clientCreds;
  await chrome.storage.local.set({
    selectedCompanyID: companyId,
  });
  const suitesResp = await fetch(`https://analytics.adobe.io/api/${companyId}/collections/suites?limit=100&expansion=timezoneZoneinfo`, {
    headers: { Authorization: `Bearer ${accessToken}`, "x-api-key": client_id, "x-proxy-global-company-id": companyId },
  });
  const suitesData = await suitesResp.json();
  if (suitesData.error_code) {
    return { ...suitesData, reauthenticate: true };
  }
  return { suitesData: suitesData, success: true };
}

async function getValidAccessToken() {
  try {
    // try auto restore session key
    if (!sessionKey) {
      const cachedKey = await getCachedDerivedKey();

      if (cachedKey) {
        const { wrappedSessionKey } = await chrome.storage.local.get(WRAPPED_KEY_STORAGE);

        if (wrappedSessionKey) {
          sessionKey = await unwrapSessionKey(wrappedSessionKey, cachedKey);
          setSessionKey(sessionKey);
          // Migrate plaintext client creds if needed (one-time for existing users)
          await migrateClientCredentials();
        }
      }
    }

    let isTokenValid = false;
    const { expires_at } = await chrome.storage.local.get("expires_at");
    if (expires_at && Date.now() < expires_at && sessionKey !== null) {
      isTokenValid = true;
    } else {
      isTokenValid = false;
    }
    if (isTokenValid == false) {
      //If sessionKey is not available, prompt for password
      if (sessionKey == null) {
        let { refreshToken } = await chrome.storage.local.get("refreshToken");
        if (refreshToken) return { reenterpassword: true };
        else return { reauthenticate: true };
        //If sessionKey is available but token expired, refresh token
      } else if (sessionKey != null) {
        //Refreshing token
        const resp = await decryptStoredCredentials(sessionKey);
        if (resp.success !== true) {
          return resp;
        }
        let { refreshToken } = resp;
        let tokenResponse = await refreshAccessToken(refreshToken);
        return tokenResponse;
      }
    } else {
      const resp = await decryptStoredCredentials(sessionKey);
      return resp;
    }
  } catch (error) {
    console.log("Error getting valid access token:", error);
    return { reauthenticate: true };
  }
}

async function refreshAccessToken(refreshToken) {
  try {
    const clientCreds = await decryptClientCredentials();
    if (!clientCreds) return { reauthenticate: true };
    const { client_id, client_secret } = clientCreds;
    const body = new URLSearchParams({
      client_id: client_id,
      client_secret: client_secret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    const tokenResp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const tokenData = await tokenResp.json();

    if (!tokenData.access_token) {
      if (tokenData.error) console.log(` Error: ${tokenData.error}`);
      return { reauthenticate: true };
    }

    let expires_at = Date.now() + (tokenData.expires_in || 3600) * 1000;
    let encryptedRefreshToken, encryptedAccessToken;
    encryptedRefreshToken = await encryptData(tokenData.refresh_token, sessionKey);
    encryptedAccessToken = await encryptData(tokenData.access_token, sessionKey);
    await chrome.storage.local.set({
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      expires_at,
    });

    return { accessToken: tokenData.access_token, success: true };
  } catch (error) {
    console.log("Error refreshing access token:", error);
    return { reauthenticate: true };
  }
}

// --------------------
// 📊 Dimensions & Values API
// --------------------

// Fetch all props and eVars for a report suite
async function fetchDimensions(companyId, rsid) {
  try {
    let tokenResponse = await getValidAccessToken();
    if (tokenResponse.success !== true) {
      return tokenResponse;
    }
    let accessToken = tokenResponse.accessToken;
    const clientCreds = await decryptClientCredentials();
    if (!clientCreds) return { error: "Unable to decrypt credentials. Please re-enter password." };
    const { client_id } = clientCreds;

    const resp = await fetch(`${reportingAPIURL}/${companyId}/dimensions?rsid=${encodeURIComponent(rsid)}&locale=en_US&expansion=tags,extraTitleInfo`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "x-api-key": client_id,
        "x-proxy-global-company-id": companyId,
        Accept: "application/json",
      },
    });

    const data = await resp.json();

    if (data.error_code) {
      return { error: data.message || "Failed to fetch dimensions.", success: false };
    }

    // Filter to only props and eVars (including classified sub-dimensions)
    const filtered = data
      .filter((dim) => {
        const id = dim.id || "";
        return id.startsWith("variables/prop") || id.startsWith("variables/evar");
      })
      .map((dim) => {
        const id = dim.id;
        const isClassified = id.includes(".");
        return {
          id: id, // e.g., "variables/prop1", "variables/prop23.year-of-publication"
          name: dim.name || "", // friendly name
          type: id.includes("prop") ? "prop" : "evar",
          isClassified: isClassified,
          extraTitleInfo: dim.extraTitleInfo || "", // parent dimension name for classified vars
        };
      })
      .sort((a, b) => {
        // Sort: props first then eVars, numerically within each group
        if (a.type !== b.type) return a.type === "prop" ? -1 : 1;
        const numA = parseInt(a.id.replace(/\D/g, "")) || 0;
        const numB = parseInt(b.id.replace(/\D/g, "")) || 0;
        return numA - numB;
      });

    return { dimensions: filtered, success: true };
  } catch (error) {
    console.log("Error fetching dimensions:", error);
    return { error: "Failed to fetch dimensions.", success: false };
  }
}

// Fetch top N values for a specific dimension (last 30 days)
async function fetchDimensionValues(companyId, rsid, dimensionId, limit = 50, segmentFilter = null) {
  try {
    let tokenResponse = await getValidAccessToken();
    if (tokenResponse.success !== true) {
      return tokenResponse;
    }
    let accessToken = tokenResponse.accessToken;
    const clientCreds = await decryptClientCredentials();
    if (!clientCreds) return { error: "Unable to decrypt credentials. Please re-enter password." };
    const { client_id } = clientCreds;
    const { reportSuiteTimezone } = await chrome.storage.local.get(["reportSuiteTimezone"]);

    // Calculate last 30 days date range using report suite timezone
    const today = getTodayInTimezone(reportSuiteTimezone);
    const endDate = new Date(today);
    endDate.setDate(today.getDate() + 1);
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 29);

    const dateRangeString = `${formatLocalDate(startDate)}T00:00:00.000/${formatLocalDate(endDate)}T00:00:00.000`;

    // Build global filters
    let globalFilters = [
      {
        type: "dateRange",
        dateRange: dateRangeString,
      },
    ];

    // If segmentFilter provided, add it as a segment (e.g., scope secondary values by primary dimension)
    if (segmentFilter && segmentFilter.dimension && segmentFilter.value) {
      let matchFunc = segmentFilter.match === "exact" ? "streq" : "contains";
      globalFilters.push({
        type: "segment",
        segmentDefinition: {
          func: "segment",
          version: [1, 0, 0],
          container: {
            func: "container",
            context: "hits",
            pred: {
              func: matchFunc,
              val: { func: "attr", name: segmentFilter.dimension },
              str: segmentFilter.value,
            },
          },
        },
      });
    }

    const reportReq = {
      rsid: rsid,
      globalFilters: globalFilters,
      metricContainer: {
        metrics: [
          {
            id: "metrics/occurrences",
            columnId: "0",
            sort: "desc",
          },
        ],
      },
      dimension: dimensionId,
      settings: {
        limit: limit,
        dimensionSort: "desc",
        countRepeatInstances: true,
      },
    };

    const finalReportURL = `${reportingAPIURL}/${companyId}/reports`;

    const resp = await fetch(finalReportURL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "x-api-key": client_id,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reportReq),
    });

    const reportData = await resp.json();

    if (reportData.error_code) {
      return { error: reportData.message || "Failed to fetch dimension values.", success: false };
    }

    const rows = reportData?.rows || [];
    const values = rows
      .filter((row) => row.value && row.value !== "Unspecified" && row.value !== "")
      .map((row) => ({
        value: row.value,
        count: row.data?.[0] || 0,
      }));

    return { values: values, success: true };
  } catch (error) {
    console.log("Error fetching dimension values:", error);
    return { error: "Failed to fetch dimension values.", success: false };
  }
}

// --------------------
// 🔐 Encryption Helpers
// --------------------

// Derive an AES-GCM key from a password (PBKDF2)
async function deriveKeyFromPassword(password, saltBase64) {
  const salt = saltBase64 ? Uint8Array.from(atob(saltBase64), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 250000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
  );

  return { key, saltBase64: saltBase64 || btoa(String.fromCharCode(...salt)) };
}

// Encrypt plain text using AES-GCM key
async function encryptData(plainText, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plainText);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const combined = new Uint8Array(iv.byteLength + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.byteLength);
  return btoa(String.fromCharCode(...combined));
}

// Decrypt base64 data using AES-GCM key
async function decryptData(encryptedBase64, key) {
  const data = Uint8Array.from(atob(encryptedBase64), (c) => c.charCodeAt(0));
  const iv = data.slice(0, 12);
  const cipher = data.slice(12);
  const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(plainBuffer);
}

// --------------------------------------
// 🔒 Encrypt and Store Credentials Securely
// --------------------------------------
async function encryptAndStoreCredentials(password, accessToken, refreshToken, client_id, client_secret, org_id, expires_at) {
  const { key: derivedKey, saltBase64 } = await deriveKeyFromPassword(password);

  // create random session key
  const newSessionKey = await generateSessionKey();

  // wrap session key
  const wrapped = await wrapSessionKey(newSessionKey, derivedKey);

  // encrypt tokens with session key
  const encryptedAccessToken = await encryptData(accessToken, newSessionKey);
  const encryptedRefreshToken = await encryptData(refreshToken, newSessionKey);

  // encrypt client credentials with session key
  const encryptedClientId = await encryptData(client_id, newSessionKey);
  const encryptedClientSecret = await encryptData(client_secret, newSessionKey);

  const encryptedVerifier = await encryptData("verify_secret", newSessionKey);

  // store wrapped key persistently
  await chrome.storage.local.set({
    accessToken: encryptedAccessToken,
    refreshToken: encryptedRefreshToken,
    encryptedVerifier,
    saltBase64,
    client_id: encryptedClientId,
    client_secret: encryptedClientSecret,
    org_id,
    expires_at,
    [WRAPPED_KEY_STORAGE]: wrapped,
  });

  // memory + session cache
  setSessionKey(newSessionKey);
  await cacheDerivedKey(derivedKey);
}

// --------------------------------------
// 🔓 Verify Password and Unlock Session
// --------------------------------------
async function validatePassword(password) {
  if (!password) return false;

  const { saltBase64 } = await chrome.storage.local.get(["saltBase64"]);
  const { wrappedSessionKey } = await chrome.storage.local.get(WRAPPED_KEY_STORAGE);

  if (!saltBase64 || !wrappedSessionKey) return false;

  try {
    const { key: derivedKey } = await deriveKeyFromPassword(password, saltBase64);

    const unwrappedSessionKey = await unwrapSessionKey(wrappedSessionKey, derivedKey);

    setSessionKey(unwrappedSessionKey);
    await cacheDerivedKey(derivedKey);

    // Migrate plaintext client_id/client_secret to encrypted (one-time for existing users)
    await migrateClientCredentials();

    return true;
  } catch {
    return false;
  }
}

// One-time migration: encrypt plaintext client_id/client_secret from older versions
async function migrateClientCredentials() {
  if (!sessionKey) return;
  try {
    const { client_id, client_secret } = await chrome.storage.local.get(["client_id", "client_secret"]);
    if (!client_id || !client_secret) return;

    // Try decrypting — if it works, already encrypted, skip migration
    try {
      await decryptData(client_id, sessionKey);
      return; // already encrypted, no migration needed
    } catch {
      // Decryption failed — value is plaintext, needs migration
    }

    const encryptedClientId = await encryptData(client_id, sessionKey);
    const encryptedClientSecret = await encryptData(client_secret, sessionKey);
    await chrome.storage.local.set({
      client_id: encryptedClientId,
      client_secret: encryptedClientSecret,
    });
    console.log("Migrated client credentials to encrypted storage.");
  } catch (err) {
    console.log("Client credential migration failed:", err);
  }
}

// --------------------------------------
// 🔓 Decrypt Stored Credentials
// --------------------------------------
async function decryptStoredCredentials(key) {
  let { accessToken, refreshToken } = await chrome.storage.local.get(["accessToken", "refreshToken"]);

  if (!accessToken || !refreshToken) {
    console.warn("No encrypted tokens found. Reauthentication required.");
    return { reauthenticate: true };
  }
  try {
    accessToken = await decryptData(accessToken, key);
    refreshToken = await decryptData(refreshToken, key);

    return { accessToken, refreshToken, success: true };
  } catch (err) {
    console.log("Failed to decrypt credentials:", err);
    return { reauthenticate: true };
  }
}

// Decrypt client_id and client_secret using session key
async function decryptClientCredentials() {
  if (!sessionKey) return null;
  try {
    const { client_id, client_secret } = await chrome.storage.local.get(["client_id", "client_secret"]);
    if (!client_id || !client_secret) return null;
    const decryptedClientId = await decryptData(client_id, sessionKey);
    const decryptedClientSecret = await decryptData(client_secret, sessionKey);
    return { client_id: decryptedClientId, client_secret: decryptedClientSecret };
  } catch {
    return null;
  }
}

// --------------------------------------
// 🔐 Session Key Wrapping Helpers
// --------------------------------------

async function generateSessionKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

async function wrapSessionKey(sessionKey, derivedKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const wrapped = await crypto.subtle.wrapKey("raw", sessionKey, derivedKey, { name: "AES-GCM", iv });

  const combined = new Uint8Array(iv.length + wrapped.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(wrapped), iv.length);

  return btoa(String.fromCharCode(...combined));
}

async function unwrapSessionKey(wrappedBase64, derivedKey) {
  const data = Uint8Array.from(atob(wrappedBase64), (c) => c.charCodeAt(0));

  const iv = data.slice(0, 12);
  const cipher = data.slice(12);

  return crypto.subtle.unwrapKey("raw", cipher, derivedKey, { name: "AES-GCM", iv }, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

async function cacheDerivedKey(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(raw)));

  await chrome.storage.session.set({
    [DERIVED_KEY_SESSION]: base64,
  });
}

async function getCachedDerivedKey() {
  const res = await chrome.storage.session.get(DERIVED_KEY_SESSION);
  if (!res[DERIVED_KEY_SESSION]) return null;

  const raw = Uint8Array.from(atob(res[DERIVED_KEY_SESSION]), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
}

function sendMessageAsync(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          if (globalThis.debugExtension) {
            console.error("[Extension Error]", message.type, chrome.runtime.lastError);
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
