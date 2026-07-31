// getPageIdentifiers.js — Injected into the PAGE context (not content script)

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

  window.dispatchEvent(
    new CustomEvent("pageIdentifierWindowPathValue", {
      detail: { pageIdentifier },
    }),
  );
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
      window.dispatchEvent(new CustomEvent("spaNavigationDetected", { detail: { url: newUrl } }));
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
