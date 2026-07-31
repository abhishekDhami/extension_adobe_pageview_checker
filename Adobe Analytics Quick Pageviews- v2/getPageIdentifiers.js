// getPageIdentifiers.js — Injected into the PAGE context (not content script)
// Communicates with the content script via guarded CustomEvents (bridge secret).

function getBridgeSecret() {
  return window.__aaPvBridgeSecret || null;
}

function dispatchGuardedEvent(name, detail) {
  const bridgeSecret = getBridgeSecret();
  if (!bridgeSecret) return;
  window.dispatchEvent(
    new CustomEvent(name, {
      detail: { ...detail, bridgeSecret },
    }),
  );
}

// =====================
// Page Identifier Fetch
// =====================
window.addEventListener("fetchPageWindowPathIdentifiers", (e) => {
  function getValueByPath(obj, path) {
    const keys = [];
    const regex = /(?:^|\.)\s*([a-zA-Z_$][\w$]*)|(?:\[\s*['"](.+?)['"]\s*\])|(?:\[\s*(\d+)\s*\])/g;
    let match;
    while ((match = regex.exec(path)) !== null) {
      keys.push(match[1] || match[2] || match[3]);
    }
    if (keys.length === 0) {
      keys.push(...path.split("."));
    }
    return keys.reduce((o, k) => o?.[k], obj);
  }

  const pageIdentifier = { ...e.detail };
  const value = getValueByPath(window, pageIdentifier.windowPath);
  pageIdentifier.value = value;

  dispatchGuardedEvent("pageIdentifierWindowPathValue", { pageIdentifier });
});

// =====================
// SPA Navigation Detection
// =====================
(function () {
  let lastUrl = location.href;

  function notifyNavigation() {
    const newUrl = location.href;
    if (newUrl !== lastUrl) {
      lastUrl = newUrl;
      dispatchGuardedEvent("spaNavigationDetected", { url: newUrl });
    }
  }

  const originalPushState = history.pushState;
  history.pushState = function () {
    originalPushState.apply(this, arguments);
    notifyNavigation();
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function () {
    originalReplaceState.apply(this, arguments);
    notifyNavigation();
  };

  window.addEventListener("popstate", () => {
    setTimeout(notifyNavigation, 50);
  });

  setInterval(() => {
    notifyNavigation();
  }, 2000);
})();
