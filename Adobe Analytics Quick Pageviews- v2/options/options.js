const step1 = document.getElementById("step1");
const step2 = document.getElementById("step2");
const step3 = document.getElementById("step3");
const step4 = document.getElementById("step4");
const authBtn = document.getElementById("authBtn");
const clearAuthBtn = document.getElementById("clearAuthBtn");
const saveConfigBtn = document.getElementById("saveConfigBtn");
const clearConfigBtn = document.getElementById("clearConfigBtn");
const companySelect = document.getElementById("companySelect");
const rsidSelect = document.getElementById("rsidSelect");
const enableOnPageToggle = document.getElementById("enableOnPageToggle");
const retrieveAccessTokenBtn = document.getElementById("retrieveAccessTokenBtn");
const pageIdentifierSource = document.getElementById("pageIdentifierSource");
const domainInput = document.getElementById("domainInput");
const addDomainBtn = document.getElementById("addDomainBtn");
const domainList = document.getElementById("domainList");
let messageQueue = [],
  msgCount = 1;
let hasStoredCredentials = false;

if (globalThis.debugExtension === undefined) {
  globalThis.debugExtension = false;
}

document.addEventListener("DOMContentLoaded", async () => {
  const { org_id, enableOnPage, client_id: storedClientId } = await chrome.storage.local.get(["org_id", "enableOnPage", "client_id"]);
  //populating step1 fields if already saved
  let client_idElem = document.getElementById("clientId");
  let client_secretElem = document.getElementById("clientSecret");
  let org_idElem = document.getElementById("orgid");

  // client_id and client_secret are encrypted — mask fields if already stored
  if (storedClientId) {
    hasStoredCredentials = true;
    client_idElem.value = "encrypted-credentials-saved";
    client_idElem.type = "password";
    client_idElem.disabled = true;
    client_secretElem.value = "encrypted-credentials-saved";
    client_secretElem.type = "password";
    client_secretElem.disabled = true;
    authBtn.textContent = "Reauthenticate with Saved Credentials";
  }
  if (org_id) {
    org_idElem.value = org_id;
    org_idElem.disabled = true;
  }
  if (enableOnPage !== undefined) {
    enableOnPageToggle.checked = enableOnPage;
  }
  await renderDomainList();
  saveConfigBtn.disabled = true;
  //populating step2 fields if already saved
  let { credsStored } = await chrome.storage.local.get(["credsStored"]);
  if (credsStored) {
    await populateStep2andStep3Fields();
  }
});

authBtn.addEventListener("click", async () => {
  try {
    let userpassword = document.getElementById("userpassword").value;
    if (!userpassword) {
      showMessage({
        msg: "Please enter your local password.",
        type: "error",
      });
      return;
    }
    if (userpassword.length < 6) {
      showMessage({
        msg: "Password should be at least 6 characters long.",
        type: "error",
      });
      return;
    }

    // Saved credentials are intentionally not read from these masked fields.
    // The background worker unlocks and decrypts them using this password.
    if (hasStoredCredentials) {
      chrome.runtime.sendMessage({
        type: "AUTHENTICATE_USER",
        reauthenticate: true,
        userpassword,
      });
      return;
    }

    let client_id = document.getElementById("clientId").value.trim();
    let client_secret = document.getElementById("clientSecret").value.trim();
    let org_id = document.getElementById("orgid").value.trim();
    if (!client_id || !client_secret || !org_id) {
      showMessage({
        msg: "Please enter valid Client ID, Secret, and Org ID.",
        type: "error",
      });
      return;
    }

    chrome.runtime.sendMessage({
      type: "AUTHENTICATE_USER",
      client_id,
      client_secret,
      org_id,
      userpassword,
    });
  } catch (error) {
    showMessage({
      msg: "An error occurred during authentication. Please try with valid credentials.",
      type: "error",
    });
    console.error(error);
  }
});

clearAuthBtn.addEventListener("click", async () => {
  await chrome.storage.local.clear();
  let client_idElem = document.getElementById("clientId");
  let client_secretElem = document.getElementById("clientSecret");
  let org_idElem = document.getElementById("orgid");
  let userpasswordElem = document.getElementById("userpassword");
  userpasswordElem.value = "";
  client_idElem.value = "";
  client_idElem.disabled = false;
  client_secretElem.value = "";
  client_secretElem.disabled = false;
  org_idElem.value = "";
  org_idElem.disabled = false;
  rsidSelect.innerHTML = "";
  companySelect.innerHTML = "<option value='' disabled selected>Select company</option>";
  showMessage({ msg: "Authentication cleared.", type: "info" });
  step2.style.display = "none";
  step3.style.display = "none";
  authBtn.disabled = false;
  rsidSelect.disabled = true;
  location.reload();
});

async function populateCompaniesAndSuites(companiesData) {
  const data = companiesData;
  const { org_id } = await chrome.storage.local.get(["org_id"]);

  if (data.imsOrgs === undefined || data.imsOrgs.length === 0) {
    showMessage({
      msg: "No organizations found for logged in user.",
      type: "error",
    });
    return;
  }
  let companies = [];
  data.imsOrgs.forEach((org) => {
    if (org.imsOrgId === org_id) {
      if (org.companies === undefined || org.companies.length === 0) {
        showMessage({
          msg: "No companies found for provided Org ID. Clear credentials and try again.",
          type: "error",
        });
        return;
      }
      org.companies.forEach((company) => {
        let opt = document.createElement("option");
        opt.value = company.globalCompanyId;
        opt.textContent = `${company.companyName} (${company.globalCompanyId})`;
        companySelect.appendChild(opt);
      });
      companies = org.companies;
    }
  });
  companies = JSON.stringify(companies);
  await chrome.storage.local.set({ companiesList: companies });
  step2.style.display = "block";
  step3.style.display = "block";
  step4.style.display = "block";
}

async function fetchCompaniesData() {
  const response = await sendMessageAsync({ type: "FETCH_COMPANIES" });

  if (response?.success) {
    return { companiesData: response.companiesData, success: true };
  } else {
    handleTokenErrorResponse(response);
    return {};
  }
}

companySelect.addEventListener("change", async () => {
  let companyId = companySelect.value;
  if (!companyId) return;
  let rsids = [];

  // Clear cached dimensions since RSID will change
  allDimensions = [];
  await chrome.storage.local.remove(["dimensionsList", "primaryDimensionValues", "secondaryDimensionValues"]);

  const response = await sendMessageAsync({
    type: "FETCH_REPORT_SUITES",
    companyId,
  });

  if (!response) {
    showMessage({ msg: "Error fetching Report.", type: "error" });
    return;
  }
  if (response.success) {
    let suitesData = response.suitesData;
    if (suitesData.content === undefined || suitesData.content.length === 0) {
      showMessage({
        msg: "No accesible report suites found for selected Company. Select other company or clear credentials and try again.",
        type: "error",
      });
      return;
    }
    //defualt option
    rsidSelect.innerHTML = "";
    let defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "Select report suite";
    defaultOpt.selected = true;
    defaultOpt.disabled = true;
    rsidSelect.appendChild(defaultOpt);
    suitesData.content.forEach((suite) => {
      const opt = document.createElement("option");
      opt.value = suite.rsid;
      opt.textContent = `${suite.name} (${suite.rsid})`;
      rsidSelect.appendChild(opt);
    });
    rsids = JSON.stringify(suitesData.content);
    rsidSelect.disabled = false;
    await chrome.storage.local.set({ rsidsList: rsids });
    validateStep2AndStep3Fields();
  } else {
    handleTokenErrorResponse(response);
  }
});

function validateStep2AndStep3Fields() {
  const source = document.getElementById("pageIdentifierSource").value;
  const adobeDimension = document.getElementById("piAdobeDimension").value.trim();
  const windowPath = document.getElementById("piWindowPath").value.trim();

  let isValid = true;

  // Report suite selection required
  if (!rsidSelect.value) {
    isValid = false;
  }

  //company selection required
  if (!companySelect.value) {
    isValid = false;
  }

  // Adobe dimension is always required
  if (!adobeDimension) {
    isValid = false;
  }

  // Window variable path required only for window source
  if (source === "window" && !windowPath) {
    isValid = false;
  }

  saveConfigBtn.disabled = !isValid;
}

// Add event listeners to validate form on input changes
["pageIdentifierSource", "piAdobeDimension", "piAdobeMatch", "piWindowPath", "rsidSelect"].forEach((id) => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener("input", validateStep2AndStep3Fields);
    el.addEventListener("change", validateStep2AndStep3Fields);
  }
});

async function savePageIdentifierConfig() {
  const config = {
    source: document.getElementById("pageIdentifierSource").value,

    urlConfig: {
      urlType: document.getElementById("piUrlType").value,
      removeQuery: document.getElementById("piRemoveQuery").checked,
      removeHash: document.getElementById("piRemoveHash").checked,
    },

    windowPathConfig: {
      windowPath: document.getElementById("piWindowPath").value.trim(),
    },

    titleConfig: {
      trim: document.getElementById("piTitleTrim").checked,
      lowercase: document.getElementById("piTitleLowercase").checked,
    },

    adobeDimensionConfig: {
      dimension: document.getElementById("piAdobeDimension").value.trim(),
      match: document.getElementById("piAdobeMatch").value,
    },
  };

  await chrome.storage.local.set({ pageIdentifierConfig: config });
}

saveConfigBtn.onclick = async () => {
  if (saveConfigBtn.disabled) return;
  saveConfigBtn.disabled = true;
  const rsid = rsidSelect.value;
  const { selectedrsID: previousRsid } = await chrome.storage.local.get("selectedrsID");
  const rsidChanged = previousRsid && previousRsid !== rsid;

  // Find timezone for selected report suite
  let reportSuiteTimezone = null;
  const { rsidsList } = await chrome.storage.local.get(["rsidsList"]);
  if (rsidsList) {
    try {
      const suites = JSON.parse(rsidsList);
      const selectedSuite = suites.find((s) => s.rsid === rsid);
      if (selectedSuite && selectedSuite.timezoneZoneinfo) {
        reportSuiteTimezone = selectedSuite.timezoneZoneinfo;
      }
    } catch (e) {}
  }

  await chrome.storage.local.set({
    selectedrsID: rsid,
    reportSuiteTimezone: reportSuiteTimezone,
  });
  await savePageIdentifierConfig();
  enableOnPageToggle.checked = true;
  await chrome.storage.local.set({ enableOnPage: true });

  if (rsidChanged) {
    await resetCustomReportStep4();
    showMessage({
      msg: "Step 4 has been reset due to report suite change. Please configure based on the latest report suite.",
      type: "info",
    });
  }

  showMessage({ msg: "Configuration saved successfully!", type: "success" });
  showMessage({
    msg: "Now Go to any webpage, Pageview report will be shown at the header",
    type: "info",
  });
  validateStep2AndStep3Fields();
};

clearConfigBtn.onclick = async () => {
  await clearStep2andStep3Fields();
  validateStep2AndStep3Fields();
};

function askUserToReauthenticate() {
  showMessage({ msg: "Please re-authenticate to continue.", type: "info" });
  authBtn.disabled = false;
  step2.style.display = "none";
  step3.style.display = "none";
  step4.style.display = "none";
  let userpasswordElem = document.getElementById("userpassword");
  userpasswordElem.value = "";
  userpasswordElem.disabled = false;
  userpasswordElem.type = "text";
  chrome.storage.local.remove(["accessToken", "refreshToken", "expires_at", "encryptedVerifier", "saltBase64", "credsStored"]);
  retrieveAccessTokenBtn.hidden = true;
}

function showMessage(info = {}, processNextMsg = false) {
  if (messageQueue.length === 0) {
    messageQueue.push(info);
    processNextMsg = true;
  }
  if (processNextMsg) {
    let msgInfo = messageQueue[0];
    showToast({
      title: "Notification",
      message: msgInfo.msg,
      type: msgInfo.type,
    });
    setTimeout(() => {
      messageQueue.shift();
      msgCount = msgCount - 1;
    }, 1000);
    return;
  } else {
    msgCount = msgCount + 1;
    setTimeout(() => {
      showMessage(info);
    }, 2000 * msgCount);
  }
}

/* Toast utility */

const TOAST_CONTAINER_ID = "__toast_container__";
function ensureContainer() {
  let c = document.getElementById(TOAST_CONTAINER_ID);
  if (!c) {
    c = document.createElement("div");
    c.id = TOAST_CONTAINER_ID;
    c.className = "toast-container";
    document.body.appendChild(c);
  }
  return c;
}

/**
 * showToast(options)
 * options: {
 *   title: string (optional),
 *   message: string (required),
 *   type: 'success'|'error'|'warning'|'info' (defaults to 'info'),
 *   timeout: milliseconds (defaults to 4500)
 * }
 */
function showToast(opts = {}) {
  const { title = "", message = "", type = "info", timeout = 2500 } = opts;
  if (!message) return;

  const container = ensureContainer();

  const toast = document.createElement("div");
  toast.className = "toast " + (type === "info" ? "" : type);
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");

  const icon = document.createElement("div");
  icon.className = "toast-icon";
  icon.innerText = type === "success" ? "\u2713" : type === "error" ? "\u2717" : type === "warning" ? "\u2757" : "i";

  const body = document.createElement("div");
  body.className = "toast-body";
  if (title) {
    const t = document.createElement("div");
    t.className = "toast-title";
    t.innerText = title;
    body.appendChild(t);
  }
  const msg = document.createElement("div");
  msg.className = "toast-msg";
  msg.innerText = message;
  body.appendChild(msg);

  const close = document.createElement("button");
  close.className = "toast-close";
  close.setAttribute("aria-label", "Close notification");
  close.innerHTML = "&#10005;"; // ×
  close.addEventListener("click", () => removeToast(toast));

  toast.appendChild(icon);
  toast.appendChild(body);
  toast.appendChild(close);

  // append & animate
  container.insertBefore(toast, container.firstChild);
  // small delay to allow transition
  requestAnimationFrame(() => {
    toast.classList.add("show");
  });

  // auto-dismiss with pause-on-hover
  let autoDismiss = true;
  let timeoutId = null;
  const startTimer = () => {
    if (!autoDismiss) return;
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => removeToast(toast), timeout);
  };
  const stopTimer = () => {
    clearTimeout(timeoutId);
  };

  toast.addEventListener("mouseenter", () => {
    autoDismiss = false;
    stopTimer();
  });
  toast.addEventListener("mouseleave", () => {
    autoDismiss = true;
    startTimer();
  });

  // start auto dismiss
  startTimer();

  // remove helper
  function removeToast(el) {
    if (!el) return;
    el.classList.remove("show");
    // give time for animation
    setTimeout(() => {
      try {
        el.remove();
      } catch (e) {}
    }, 220);
  }

  // return a handle if caller wants to remove manually
  return {
    remove: () => removeToast(toast),
  };
}
/* Toast utility */

async function clearStep2andStep3Fields() {
  rsidSelect.innerHTML = "";
  rsidSelect.disabled = true;
  companySelect.innerHTML = "<option value='' disabled selected>Select company</option>";
  await chrome.storage.local.remove([
    "selectedCompanyID",
    "selectedrsID",
    "pageIdentifierConfig",
    "customReportConfig",
    "dimensionsList",
    "primaryDimensionValues",
    "secondaryDimensionValues",
    "reportSuiteTimezone",
  ]);
  step3.querySelectorAll("input, select").forEach((el) => {
    if (el.type === "checkbox") el.checked = false;
    else el.value = "";
  });
  showMessage({ msg: "Configuration cleared.", type: "success" });
  showMessage({ msg: "Select company and report suite again.", type: "info" });
  populateStep2andStep3Fields(true);
  togglePageIdentifierSource("url");

  // Reset custom report UI
  allDimensions = [];
  enableCustomReportCheckbox.checked = false;
  customReportConfigDiv.style.display = "none";
  crPrimaryDimension.innerHTML = '<option value="" disabled selected>Loading dimensions...</option>';
  crPrimaryDimension.disabled = true;
  crPrimaryValueSelect.innerHTML = '<option value="" disabled selected>Select primary dimension first</option>';
  crPrimaryValueSelect.disabled = true;
  crPrimaryValueCustom.value = "";
  crSecondaryDimension.innerHTML = '<option value="" disabled selected>Select primary dimension first</option>';
  crSecondaryDimension.disabled = true;
}

async function populateStep2andStep3Fields(defaultSetting = false) {
  chrome.runtime.sendMessage({ type: "GET_TOKEN_VALIDITY_OPTIONS", args: { defaultSetting } });
}

async function handleTokenErrorResponse(response) {
  step2.style.display = "none";
  step3.style.display = "none";
  step4.style.display = "none";
  if (response.reauthenticate) {
    askUserToReauthenticate();
  } else if (response.reenterpassword) {
    let userpasswordElem = document.getElementById("userpassword");
    userpasswordElem.value = ""; //dummy value to indicate password is set
    userpasswordElem.disabled = false;
    userpasswordElem.type = "text";
    showMessage({
      msg: "Please re-enter your password to continue.",
      type: "info",
    });
    const { refreshToken } = await chrome.storage.local.get(["refreshToken"]);
    if (refreshToken) {
      retrieveAccessTokenBtn.hidden = false;
    }
    let { credsStored } = await chrome.storage.local.get(["credsStored"]);
    if (credsStored) {
      authBtn.disabled = true;
    }
  }
}

function togglePageIdentifierSource(source) {
  document.getElementById("pageIdUrlConfig").style.display = source === "url" ? "block" : "none";

  document.getElementById("pageIdTitleConfig").style.display = source === "title" ? "block" : "none";

  document.getElementById("pageIdWindowConfig").style.display = source === "window" ? "block" : "none";
}

pageIdentifierSource.addEventListener("change", (e) => {
  togglePageIdentifierSource(e.target.value);
  validateStep2AndStep3Fields();
});

retrieveAccessTokenBtn.addEventListener("click", async () => {
  let userpassword = document.getElementById("userpassword").value;
  if (!userpassword) {
    showMessage({
      msg: "Please enter your password to continue.",
      type: "error",
    });
    return;
  }
  showMessage({ msg: "Validating password...", type: "info" });
  const response = await sendMessageAsync({
    type: "VALIDATE_PASSWORD",
    password: userpassword,
  });
  if (response.isPasswordValid == true) {
    showMessage({
      msg: "Password validated. Kindly return back to website and Refresh the page to fetch data.",
      type: "success",
    });
    populateStep2andStep3Fields(false);
    retrieveAccessTokenBtn.hidden = true;
    authBtn.disabled = true;
  } else {
    showMessage({
      msg: "Invalid password. Please try again or Re-authenticate.",
      type: "error",
    });
    authBtn.disabled = false;
  }
});

enableOnPageToggle.addEventListener("change", async () => {
  const isEnabled = enableOnPageToggle.checked;
  await chrome.storage.local.set({ enableOnPage: isEnabled });
});

// =============================================
// DOMAIN ALLOWLIST
// =============================================

function normalizeDomainInput(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
}

async function renderDomainList() {
  const { allowedDomains } = await chrome.storage.local.get("allowedDomains");
  const domains = Array.isArray(allowedDomains) ? allowedDomains : [];

  domainList.innerHTML = "";

  if (domains.length === 0) {
    const hint = document.createElement("p");
    hint.className = "domain-empty-hint";
    hint.textContent = "No domains added. Widget runs on all websites.";
    domainList.appendChild(hint);
    return;
  }

  domains.forEach((domain) => {
    const li = document.createElement("li");
    li.className = "domain-list-item";

    const label = document.createElement("span");
    label.textContent = domain;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "domain-remove-btn";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      const updated = domains.filter((d) => d !== domain);
      await chrome.storage.local.set({ allowedDomains: updated });
      await renderDomainList();
      showMessage({ msg: `Removed ${domain}.`, type: "info" });
    });

    li.appendChild(label);
    li.appendChild(removeBtn);
    domainList.appendChild(li);
  });
}

addDomainBtn.addEventListener("click", async () => {
  const normalized = normalizeDomainInput(domainInput.value);
  if (!normalized) {
    showMessage({ msg: "Please enter a valid domain (e.g. example.com).", type: "error" });
    return;
  }

  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized) && normalized !== "localhost") {
    showMessage({ msg: "Invalid domain format. Use example.com", type: "error" });
    return;
  }

  const { allowedDomains } = await chrome.storage.local.get("allowedDomains");
  const domains = Array.isArray(allowedDomains) ? [...allowedDomains] : [];

  if (domains.includes(normalized)) {
    showMessage({ msg: "Domain already added.", type: "info" });
    return;
  }

  domains.push(normalized);
  await chrome.storage.local.set({ allowedDomains: domains });
  domainInput.value = "";
  await renderDomainList();
  showMessage({ msg: `Added ${normalized}. Widget will only appear on matching domains.`, type: "success" });
});

domainInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addDomainBtn.click();
  }
});

// =============================================
// CUSTOM REPORT — Step 4
// =============================================
const enableCustomReportCheckbox = document.getElementById("enableCustomReport");
const customReportConfigDiv = document.getElementById("customReportConfig");
const crPrimaryDimension = document.getElementById("crPrimaryDimension");
const crPrimaryMatch = document.getElementById("crPrimaryMatch");
const crPrimaryValueSelect = document.getElementById("crPrimaryValueSelect");
const crPrimaryValueCustom = document.getElementById("crPrimaryValueCustom");
const crSecondaryDimension = document.getElementById("crSecondaryDimension");
const saveCustomReportBtn = document.getElementById("saveCustomReportBtn");
const clearCustomReportBtn = document.getElementById("clearCustomReportBtn");

let allDimensions = []; // cached dimension list

// Show/hide custom report config when checkbox toggled
enableCustomReportCheckbox.addEventListener("change", async () => {
  const isEnabled = enableCustomReportCheckbox.checked;
  customReportConfigDiv.style.display = isEnabled ? "block" : "none";
  if (isEnabled) {
    await loadDimensionsIfNeeded();
  } else {
    // Disable custom report in storage so widget hides the row
    const { customReportConfig } = await chrome.storage.local.get(["customReportConfig"]);
    if (customReportConfig) {
      customReportConfig.enabled = false;
      await chrome.storage.local.set({ customReportConfig });
    }
  }
});

// When primary dimension changes, fetch its values and update secondary dropdown
crPrimaryDimension.addEventListener("change", async () => {
  const selectedDim = crPrimaryDimension.value;
  if (!selectedDim) return;

  // Fetch primary dimension values
  await fetchAndPopulatePrimaryValues(selectedDim);

  // Update secondary dropdown (exclude primary) and clear stale secondary values
  populateSecondaryDimensionDropdown(selectedDim);
  await chrome.storage.local.remove(["secondaryDimensionValues"]);
});

// When primary value dropdown changes, show/hide custom input and re-fetch secondary values if needed
crPrimaryValueSelect.addEventListener("change", async () => {
  if (crPrimaryValueSelect.value === "__custom__") {
    crPrimaryValueCustom.style.display = "block";
    crPrimaryValueCustom.focus();
  } else {
    crPrimaryValueCustom.style.display = "none";
    crPrimaryValueCustom.value = "";
  }

  // If secondary dimension is already selected, re-fetch its values scoped to the new primary value
  const secondaryDim = crSecondaryDimension.value;
  if (secondaryDim && crPrimaryValueSelect.value !== "__custom__") {
    await fetchAndSaveSecondaryValues(secondaryDim);
  }
});

// When custom primary value input loses focus, re-fetch secondary values if needed
crPrimaryValueCustom.addEventListener("blur", async () => {
  const secondaryDim = crSecondaryDimension.value;
  const customVal = crPrimaryValueCustom.value.trim();
  if (secondaryDim && customVal) {
    await fetchAndSaveSecondaryValues(secondaryDim);
  }
});

// When secondary dimension changes, fetch and save its values
crSecondaryDimension.addEventListener("change", async () => {
  const selectedDim = crSecondaryDimension.value;
  if (!selectedDim) return;
  await fetchAndSaveSecondaryValues(selectedDim);
});

// Save Custom Report config
saveCustomReportBtn.addEventListener("click", async () => {
  const primaryDim = crPrimaryDimension.value;
  const primaryMatch = crPrimaryMatch.value;
  const primaryValueFromSelect = crPrimaryValueSelect.value;
  const primaryValueCustom = crPrimaryValueCustom.value.trim();
  const secondaryDim = crSecondaryDimension.value;

  // Primary value: custom input if "__custom__" selected, otherwise dropdown value
  const primaryValue = primaryValueFromSelect === "__custom__" ? primaryValueCustom : primaryValueFromSelect;

  if (!primaryDim) {
    showMessage({ msg: "Please select a Primary Dimension.", type: "error" });
    return;
  }
  if (!primaryValue) {
    showMessage({
      msg: "Please select or enter a Primary Value.",
      type: "error",
    });
    return;
  }

  // Find friendly names
  const primaryDimObj = allDimensions.find((d) => d.id === primaryDim);
  const secondaryDimObj = allDimensions.find((d) => d.id === secondaryDim);

  const config = {
    enabled: true,
    primaryDimension: {
      id: primaryDim,
      name: primaryDimObj?.name || "",
      displayLabel: formatDimensionLabel(primaryDimObj),
    },
    primaryMatch: primaryMatch,
    primaryValue: primaryValue,
    secondaryDimension: secondaryDim
      ? {
          id: secondaryDim,
          name: secondaryDimObj?.name || "",
          displayLabel: formatDimensionLabel(secondaryDimObj),
        }
      : null,
  };

  await chrome.storage.local.set({ customReportConfig: config });
  showMessage({ msg: "Custom Report configuration saved!", type: "success" });
});

async function resetCustomReportStep4() {
  await chrome.storage.local.remove(["customReportConfig", "primaryDimensionValues", "secondaryDimensionValues", "dimensionsList"]);
  allDimensions = [];

  enableCustomReportCheckbox.checked = false;
  customReportConfigDiv.style.display = "none";

  crPrimaryDimension.innerHTML = '<option value="" disabled selected>Loading dimensions...</option>';
  crPrimaryDimension.disabled = true;
  crPrimaryMatch.value = "exact";
  crPrimaryValueSelect.innerHTML = "<option value='' disabled selected>Select primary dimension first</option>";
  crPrimaryValueSelect.disabled = true;
  crPrimaryValueCustom.value = "";
  crPrimaryValueCustom.style.display = "none";
  crSecondaryDimension.innerHTML = "<option value='' disabled selected>Select primary dimension first</option>";
  crSecondaryDimension.disabled = true;
}

// Clear Custom Report config
clearCustomReportBtn.addEventListener("click", async () => {
  await resetCustomReportStep4();
  showMessage({ msg: "Custom Report configuration cleared.", type: "success" });
});

// ---------- Helper Functions ----------

function formatDimensionLabel(dimObj) {
  if (!dimObj) return "";
  const idRaw = dimObj.id.replace("variables/", "");

  if (dimObj.isClassified && dimObj.extraTitleInfo) {
    // Classified: e.g., "Prop23 ('Year of Publication' Classified from 'Content Publish Date')"
    // Extract base var name like "Prop23" from "prop23.year-of-publication"
    const basePart = idRaw.split(".")[0];
    const shortBase = basePart.charAt(0).toUpperCase() + basePart.slice(1);
    const classifiedName = dimObj.name || "";
    const parentName = dimObj.extraTitleInfo || "";
    return `${shortBase} ('${classifiedName}' Classified from '${parentName}')`;
  }

  // Standard: e.g., "Prop1 (Site Section)"
  const shortName = idRaw.charAt(0).toUpperCase() + idRaw.slice(1);
  const friendlyName = dimObj.name || "";
  return friendlyName ? `${shortName} (${friendlyName})` : shortName;
}

async function loadDimensionsIfNeeded() {
  if (allDimensions.length > 0) {
    populatePrimaryDimensionDropdown();
    return;
  }

  const { selectedCompanyID, selectedrsID, dimensionsList } = await chrome.storage.local.get(["selectedCompanyID", "selectedrsID", "dimensionsList"]);

  // Try loading from cache first
  if (dimensionsList) {
    try {
      allDimensions = JSON.parse(dimensionsList);
      populatePrimaryDimensionDropdown();
      return;
    } catch (e) {
      // corrupted cache, re-fetch
    }
  }

  if (!selectedCompanyID || !selectedrsID) {
    showMessage({
      msg: "Please select Company and Report Suite and Save Configuration first (Step 2).",
      type: "error",
    });
    return;
  }

  // Fetch from API
  crPrimaryDimension.innerHTML = '<option value="" disabled selected>Loading dimensions...</option>';
  crPrimaryDimension.disabled = true;

  chrome.runtime.sendMessage(
    {
      type: "FETCH_DIMENSIONS",
      companyId: selectedCompanyID,
      rsid: selectedrsID,
    },
    async (response) => {
      if (chrome.runtime.lastError) {
        showMessage({ msg: "Error fetching dimensions.", type: "error" });
        if (globalThis.debugExtension) {
          console.error(chrome.runtime.lastError);
        }
        return;
      }
      if (response.success) {
        allDimensions = response.dimensions;
        await chrome.storage.local.set({
          dimensionsList: JSON.stringify(allDimensions),
        });
        populatePrimaryDimensionDropdown();
        showMessage({
          msg: `Loaded ${allDimensions.length} dimensions (Props & eVars).`,
          type: "success",
        });
      } else {
        showMessage({
          msg: response.error || "Failed to fetch dimensions.",
          type: "error",
        });
        crPrimaryDimension.innerHTML = '<option value="" disabled selected>Failed to load</option>';
      }
    },
  );
}

function populatePrimaryDimensionDropdown() {
  crPrimaryDimension.innerHTML = "";

  // Default option
  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = "Select a dimension";
  defaultOpt.disabled = true;
  defaultOpt.selected = true;
  crPrimaryDimension.appendChild(defaultOpt);

  allDimensions.forEach((dim) => {
    const opt = document.createElement("option");
    opt.value = dim.id;
    opt.textContent = formatDimensionLabel(dim);
    crPrimaryDimension.appendChild(opt);
  });

  crPrimaryDimension.disabled = false;
}

function populateSecondaryDimensionDropdown(excludeDimensionId) {
  crSecondaryDimension.innerHTML = "";

  // "None" option
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "None (No secondary dimension)";
  crSecondaryDimension.appendChild(noneOpt);

  allDimensions.forEach((dim) => {
    if (dim.id === excludeDimensionId) return; // exclude primary
    const opt = document.createElement("option");
    opt.value = dim.id;
    opt.textContent = formatDimensionLabel(dim);
    crSecondaryDimension.appendChild(opt);
  });

  crSecondaryDimension.disabled = false;
}

async function fetchAndPopulatePrimaryValues(dimensionId) {
  const { selectedCompanyID, selectedrsID } = await chrome.storage.local.get(["selectedCompanyID", "selectedrsID"]);

  if (!selectedCompanyID || !selectedrsID) {
    showMessage({
      msg: "Company and Report Suite not configured.",
      type: "error",
    });
    return;
  }

  crPrimaryValueSelect.innerHTML = '<option value="" disabled selected>Loading values...</option>';
  crPrimaryValueSelect.disabled = true;
  crPrimaryValueCustom.style.display = "none";
  crPrimaryValueCustom.value = "";

  chrome.runtime.sendMessage(
    {
      type: "FETCH_DIMENSION_VALUES",
      companyId: selectedCompanyID,
      rsid: selectedrsID,
      dimensionId: dimensionId,
      limit: 50,
    },
    async (response) => {
      if (chrome.runtime.lastError) {
        showMessage({ msg: "Error fetching dimension values.", type: "error" });
        if (globalThis.debugExtension) {
          console.error(chrome.runtime.lastError);
        }
        return;
      }
      if (response.success) {
        const values = response.values || [];
        await chrome.storage.local.set({
          primaryDimensionValues: JSON.stringify(values),
        });

        crPrimaryValueSelect.innerHTML = "";

        // Default option
        const defaultOpt = document.createElement("option");
        defaultOpt.value = "";
        defaultOpt.textContent = "Select a value";
        defaultOpt.disabled = true;
        defaultOpt.selected = true;
        crPrimaryValueSelect.appendChild(defaultOpt);

        values.forEach((v) => {
          const opt = document.createElement("option");
          opt.value = v.value;
          opt.textContent = `${v.value} (${v.count.toLocaleString()})`;
          crPrimaryValueSelect.appendChild(opt);
        });

        // Add "Enter custom value" as last option
        const customOpt = document.createElement("option");
        customOpt.value = "__custom__";
        customOpt.textContent = "-- Enter custom value --";
        crPrimaryValueSelect.appendChild(customOpt);

        crPrimaryValueSelect.disabled = false;

        if (values.length === 0) {
          showMessage({
            msg: "No values found for selected dimension in the last 30 days.",
            type: "info",
          });
        }
      } else {
        showMessage({
          msg: response.error || "Failed to fetch dimension values.",
          type: "error",
        });
        crPrimaryValueSelect.innerHTML = '<option value="" disabled selected>Failed to load</option>';
      }
    },
  );
}

async function fetchAndSaveSecondaryValues(dimensionId) {
  const { selectedCompanyID, selectedrsID } = await chrome.storage.local.get(["selectedCompanyID", "selectedrsID"]);

  if (!selectedCompanyID || !selectedrsID) return;

  // Build segment filter from primary dimension selection
  const primaryDim = crPrimaryDimension.value;
  const primaryMatch = crPrimaryMatch.value;
  const primaryValueFromSelect = crPrimaryValueSelect.value;
  const primaryValueCustom = crPrimaryValueCustom.value.trim();
  const primaryValue = primaryValueFromSelect === "__custom__" ? primaryValueCustom : primaryValueFromSelect;

  let segmentFilter = null;
  if (primaryDim && primaryValue) {
    segmentFilter = {
      dimension: primaryDim,
      match: primaryMatch,
      value: primaryValue,
    };
  }

  // Show a brief loading message
  showMessage({ msg: "Fetching secondary dimension values...", type: "info" });

  chrome.runtime.sendMessage(
    {
      type: "FETCH_DIMENSION_VALUES",
      companyId: selectedCompanyID,
      rsid: selectedrsID,
      dimensionId: dimensionId,
      limit: 50,
      segmentFilter: segmentFilter,
    },
    async (response) => {
      if (chrome.runtime.lastError) {
        if (globalThis.debugExtension) {
          console.error(chrome.runtime.lastError);
        }
        return;
      }
      if (response.success) {
        const values = response.values || [];
        await chrome.storage.local.set({
          secondaryDimensionValues: JSON.stringify(values),
        });
        showMessage({
          msg: `Loaded ${values.length} values for secondary dimension.`,
          type: "success",
        });
      } else {
        showMessage({
          msg: response.error || "Failed to fetch secondary dimension values.",
          type: "error",
        });
      }
    },
  );
}

// ---------- Populate Step 4 on page load ----------

async function populateCustomReportFields() {
  const { customReportConfig } = await chrome.storage.local.get(["customReportConfig"]);

  if (!customReportConfig || !customReportConfig.enabled) {
    step4.style.display = "block";
    return;
  }

  step4.style.display = "block";
  enableCustomReportCheckbox.checked = true;
  customReportConfigDiv.style.display = "block";

  // Ensure custom input is hidden by default
  crPrimaryValueCustom.style.display = "none";
  crPrimaryValueCustom.value = "";

  // Restore match condition first (before values load)
  if (customReportConfig.primaryMatch) {
    crPrimaryMatch.value = customReportConfig.primaryMatch;
  }

  // Load dimensions first
  await loadDimensionsIfNeeded();

  // Wait a tick for dropdown to populate
  await new Promise((r) => setTimeout(r, 100));

  // Restore primary dimension
  if (customReportConfig.primaryDimension?.id) {
    crPrimaryDimension.value = customReportConfig.primaryDimension.id;

    // Populate primary values and wait for completion using a promise wrapper
    await new Promise((resolve) => {
      const { selectedCompanyID, selectedrsID } = {
        selectedCompanyID: null,
        selectedrsID: null,
      };
      chrome.storage.local.get(["selectedCompanyID", "selectedrsID"], (result) => {
        if (!result.selectedCompanyID || !result.selectedrsID) {
          resolve();
          return;
        }
        chrome.runtime.sendMessage(
          {
            type: "FETCH_DIMENSION_VALUES",
            companyId: result.selectedCompanyID,
            rsid: result.selectedrsID,
            dimensionId: customReportConfig.primaryDimension.id,
            limit: 50,
          },
          async (response) => {
            if (chrome.runtime.lastError) {
              if (globalThis.debugExtension) {
                console.error(chrome.runtime.lastError);
              }
              return;
            }
            if (!response?.success) {
              resolve();
              return;
            }
            const values = response.values || [];
            await chrome.storage.local.set({
              primaryDimensionValues: JSON.stringify(values),
            });

            crPrimaryValueSelect.innerHTML = "";

            const defaultOpt = document.createElement("option");
            defaultOpt.value = "";
            defaultOpt.textContent = "Select a value";
            defaultOpt.disabled = true;
            defaultOpt.selected = true;
            crPrimaryValueSelect.appendChild(defaultOpt);

            values.forEach((v) => {
              const opt = document.createElement("option");
              opt.value = v.value;
              opt.textContent = `${v.value} (${v.count.toLocaleString()})`;
              crPrimaryValueSelect.appendChild(opt);
            });

            const customOpt = document.createElement("option");
            customOpt.value = "__custom__";
            customOpt.textContent = "-- Enter custom value --";
            crPrimaryValueSelect.appendChild(customOpt);

            crPrimaryValueSelect.disabled = false;

            // Now restore the saved primary value
            if (customReportConfig.primaryValue) {
              crPrimaryValueSelect.value = customReportConfig.primaryValue;
              if (!crPrimaryValueSelect.value || crPrimaryValueSelect.value === "") {
                // Value not in dropdown — it was a custom value
                crPrimaryValueSelect.value = "__custom__";
                crPrimaryValueCustom.style.display = "block";
                crPrimaryValueCustom.value = customReportConfig.primaryValue;
              } else {
                // Found in dropdown — make sure custom input stays hidden
                crPrimaryValueCustom.style.display = "none";
                crPrimaryValueCustom.value = "";
              }
            }

            resolve();
          },
        );
      });
    });

    // Populate secondary dropdown
    populateSecondaryDimensionDropdown(customReportConfig.primaryDimension.id);
  }

  // Restore secondary dimension
  if (customReportConfig.secondaryDimension?.id) {
    await new Promise((r) => setTimeout(r, 100));
    crSecondaryDimension.value = customReportConfig.secondaryDimension.id;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 👉 Ignore unrelated messages (VERY IMPORTANT)
  if (message.type !== "RECHECK_TOKEN_STATUS" && message.type !== "GET_TOKEN_VALIDITY_OPTIONS_RESPONSE" && message.type !== "AUTHENTICATE_USER_RESPONSE") {
    return;
  }

  (async () => {
    try {
      switch (message.type) {
        case "RECHECK_TOKEN_STATUS": {
          const { credsStored } = await chrome.storage.local.get(["credsStored"]);
          if (credsStored) {
            populateStep2andStep3Fields();
          }
          break;
        }

        case "GET_TOKEN_VALIDITY_OPTIONS_RESPONSE": {
          if (message.success === true) {
            const { selectedCompanyID, selectedrsID, companiesList, rsidsList } = await chrome.storage.local.get(["selectedCompanyID", "selectedrsID", "companiesList", "rsidsList"]);

            let defaultSetting = message.args?.defaultSetting;

            if (selectedCompanyID && selectedrsID) {
              step2.style.display = "block";
              step3.style.display = "block";
              step4.style.display = "block";

              if (companiesList) {
                companySelect.innerHTML = "";

                if (defaultSetting) {
                  let opt = document.createElement("option");
                  opt.value = "";
                  opt.textContent = "Select company";
                  opt.selected = true;
                  opt.disabled = true;
                  companySelect.appendChild(opt);
                }

                let companies = JSON.parse(companiesList);
                companies.forEach((company) => {
                  let opt = document.createElement("option");
                  opt.value = company.globalCompanyId;
                  opt.textContent = `${company.companyName} (${company.globalCompanyId})`;

                  if (selectedCompanyID && selectedCompanyID === company.globalCompanyId && !defaultSetting) {
                    opt.selected = true;
                  }

                  companySelect.appendChild(opt);
                });
              }

              if (rsidsList && !defaultSetting) {
                let rsids = JSON.parse(rsidsList);
                rsidSelect.disabled = false;

                rsids.forEach((suite) => {
                  const opt = document.createElement("option");
                  opt.value = suite.rsid;
                  opt.textContent = `${suite.name} (${suite.rsid})`;

                  if (selectedrsID && selectedrsID === suite.rsid) {
                    opt.selected = true;
                  }

                  rsidSelect.appendChild(opt);
                });
              }

              authBtn.disabled = true;

              let userpasswordElem = document.getElementById("userpassword");
              userpasswordElem.value = "ABCD";
              userpasswordElem.disabled = true;
              userpasswordElem.type = "password";
            } else {
              let resp = await fetchCompaniesData();

              if (resp.success) {
                populateCompaniesAndSuites(resp.companiesData);

                let userpasswordElem = document.getElementById("userpassword");
                userpasswordElem.value = "ABCD";
                userpasswordElem.disabled = true;
                userpasswordElem.type = "password";
              }
            }

            const { pageIdentifierConfig } = await chrome.storage.local.get(["pageIdentifierConfig"]);

            if (pageIdentifierConfig) {
              const cfg = pageIdentifierConfig;

              document.getElementById("pageIdentifierSource").value = cfg.source;
              togglePageIdentifierSource(cfg.source);

              document.getElementById("piUrlType").value = cfg.urlConfig.urlType || "full";
              document.getElementById("piRemoveQuery").checked = !!cfg.urlConfig.removeQuery;
              document.getElementById("piRemoveHash").checked = !!cfg.urlConfig.removeHash;

              document.getElementById("piTitleTrim").checked = !!cfg.titleConfig.trim;
              document.getElementById("piTitleLowercase").checked = !!cfg.titleConfig.lowercase;

              document.getElementById("piWindowPath").value = cfg.windowPathConfig.windowPath || "";

              document.getElementById("piAdobeDimension").value = cfg.adobeDimensionConfig.dimension || "";
              document.getElementById("piAdobeMatch").value = cfg.adobeDimensionConfig.match || "exact";
            }

            if (defaultSetting) {
              document.getElementById("pageIdentifierSource").value = "url";
              document.getElementById("piUrlType").value = "full";
              document.getElementById("piAdobeMatch").value = "exact";
              document.getElementById("piRemoveQuery").checked = true;
              document.getElementById("piRemoveHash").checked = true;
              document.getElementById("piTitleTrim").checked = true;
            }

            validateStep2AndStep3Fields();
            populateCustomReportFields();
          } else {
            handleTokenErrorResponse(message);
          }

          break;
        }

        case "AUTHENTICATE_USER_RESPONSE": {
          if (message.error) {
            showMessage({
              msg: "Error occured while Authenticating: " + message.error,
              type: "error",
            });
            return;
          }

          if (message.success) {
            authBtn.disabled = true;

            showMessage({
              msg: "Authenticated and Credentials fetched!",
              type: "success",
            });

            populateCompaniesAndSuites(message.companiesData);

            await chrome.storage.local.set({ credsStored: true });

            step2.scrollIntoView({ behavior: "smooth", block: "start" });
          }

          break;
        }
      }
    } catch (err) {
      console.error("Options listener error:", err);
    }
  })();

  // ❗ DO NOT return true
});

function sendResponseMessage(type, payload) {
  chrome.runtime.sendMessage({ type, ...payload });
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
