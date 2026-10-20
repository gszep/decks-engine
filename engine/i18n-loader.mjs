// Keyed slides (data-i18n) are empty HTML: engine/i18n.js fills their text from
// the catalogs. A slide written without that script renders blank wherever the
// editor isn't hydrating it (presentation mode, public view, PDF export), so the
// loader is ensured, exactly once, at every place a slide is served or stored.
export const I18N_LOADER = '<script src="../../../engine/i18n.js"></script>';

const HAS_LOADER = /<script\b[^>]*\bsrc=["'][^"']*\bengine\/i18n\.js(?:[?#][^"']*)?["'][^>]*>/i;

export const withI18nLoader = (html) => {
  const source = String(html);
  if (!/\bdata-i18n=/.test(source) || HAS_LOADER.test(source)) return source;
  if (/<\/head>/i.test(source)) return source.replace(/<\/head>/i, `${I18N_LOADER}</head>`);
  if (/<body[\s>]/i.test(source)) return source.replace(/<body[\s>]/i, (body) => `${I18N_LOADER}${body}`);
  return `${I18N_LOADER}${source}`;
};
