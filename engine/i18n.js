/* decks i18n loader — include in each slide's <head>:
 *   <script src="../../../engine/i18n.js"></script>
 *
 * All locales are equal: text lives ONLY in slides/i18n/<locale>.js catalogs
 * (the single source of truth); the slide HTML holds structure and empty
 * [data-i18n] elements. The locale comes from ?lang=<id> or falls back to the
 * <html lang> attribute. Catalogs define window.I18N and window.I18N_META.
 *
 * Works over file:// (build) and http:// (design harness). The exposed
 * setI18nLocale() swaps catalogs in place so presentation language changes do
 * not reload the slide document.
 */
(() => {
  let sequence = 0;
  const apply = () => {
    const first = !window.__i18nOriginals;
    if (first) window.__i18nOriginals = {};
    for (const el of document.querySelectorAll("[data-i18n]")) {
      const key = el.getAttribute("data-i18n"), text = window.I18N && window.I18N[key];
      if (text == null) continue;
      if (first) window.__i18nOriginals[key] = el.innerHTML;
      el.innerHTML = text;
    }
  };

  window.setI18nLocale = (lang) => new Promise((resolve, reject) => {
    const current = ++sequence;
    document.documentElement.setAttribute("lang", lang);
    const script = document.createElement("script");
    const previewCatalog = new URLSearchParams(location.search).get("catalogUrl");
    script.src = previewCatalog || new URL(`i18n/${encodeURIComponent(lang)}.js`, document.baseURI);
    script.setAttribute("data-i18n-catalog", "");
    script.onload = () => {
      if (current !== sequence) { script.remove(); resolve(false); return; }
      const finish = () => {
        apply();
        for (const old of document.querySelectorAll("script[data-i18n-catalog]")) if (old !== script) old.remove();
        resolve(true);
      };
      document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", finish, { once: true }) : finish();
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });

  const initial = new URLSearchParams(location.search).get("lang")
    || document.documentElement.getAttribute("lang") || "en";
  window.setI18nLocale(initial);
})();
