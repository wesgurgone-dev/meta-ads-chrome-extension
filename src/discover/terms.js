/**
 * Turning a list of ads you already like into search terms that might find
 * more advertisers like them.
 *
 * This is the half no vendor sells. Every Facebook Ad Library scraper, Apify's
 * included, takes a keyword or a page URL; none of them takes an advertiser and
 * returns comparable ones, and Meta's own ads_archive API has no such parameter
 * either. So similarity has to be manufactured: derive terms from the seed ads,
 * search those terms, then score what comes back for how much it looks like the
 * seed. This file is step one, and it is deliberately pure so the ranking can
 * be tested without a browser.
 *
 * The landing-page domain is the strongest niche signal available, and it can
 * only ever be used two ways: as a keyword string on the way out, and as a
 * scoring key on the way back. No search endpoint anywhere filters by it.
 */

/** Suffixes where the registrable name is the third label, not the second. */
const MULTI_SUFFIX = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.au", "net.au", "org.au", "edu.au",
  "co.nz", "com.br", "co.za", "co.jp", "com.sg", "com.mx",
]);

export const registrableDomain = (url) => {
  if (!url) return null;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (err) {
    return null;
  }
  host = host.replace(/^www\./, "");
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  return MULTI_SUFFIX.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
};

/** The brand name inside a domain, which is usually noise as a search term. */
export const domainTokens = (domain) => {
  if (!domain) return [];
  const name = domain.split(".")[0];
  // getyourhyro -> get, your, hyro is not something a splitter can do reliably,
  // so the whole name is one token and overlap is measured on substrings.
  return [name].filter(Boolean);
};

const STOPWORDS = new Set(
  ("the a an and or but if then than that this these those with without for from into onto " +
   "you your yours we our ours us they them their it its is are was were be been being have " +
   "has had do does did will would can could should shall may might must not no yes on off " +
   "in out up down over under again more most some any all each every other new now get got " +
   "just like make made made makes made take takes taken use uses used using help helps " +
   "best better good great top free shop shop now buy order learn more click here today " +
   "only save saving off sale discount code limited time offer while stocks last plus also " +
   "one two three ten per percent day days week weeks month months year years " +
   "sponsored ad ads advert advertisement")
    .split(/\s+/),
);

const words = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9'\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && w.length < 24 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

/**
 * What the seed list is about, as facts rather than as a guess: the advertisers
 * in it, their domains, and the vocabulary their copy shares.
 */
export const seedProfile = (ads) => {
  const advertisers = new Map(); // lowercased name -> display name
  const domains = new Map(); // domain -> count
  const unigrams = new Map();
  const bigrams = new Map();
  const ctas = new Map();

  for (const ad of ads || []) {
    if (!ad) continue;
    if (ad.pageName) advertisers.set(ad.pageName.toLowerCase(), ad.pageName);
    const domain = registrableDomain(ad.linkUrl);
    if (domain) domains.set(domain, (domains.get(domain) || 0) + 1);
    if (ad.ctaType) ctas.set(ad.ctaType, (ctas.get(ad.ctaType) || 0) + 1);

    // The full body, not the synced copy: sync truncates it to 240 characters.
    const text = [ad.title, ad.body, ad.caption, ad.linkDescription]
      .filter(Boolean)
      .join(" ");
    const brand = new Set();
    for (const w of words(ad.pageName)) brand.add(w);
    for (const t of domainTokens(domain)) brand.add(t);

    const tokens = words(text).filter((w) => !brand.has(w) && ![...brand].some((b) => b.includes(w)));
    const seen = new Set();
    for (let i = 0; i < tokens.length; i++) {
      // Count each term once per ad, so one long body cannot outvote the list.
      if (!seen.has(tokens[i])) {
        seen.add(tokens[i]);
        unigrams.set(tokens[i], (unigrams.get(tokens[i]) || 0) + 1);
      }
      if (i + 1 < tokens.length) {
        const pair = `${tokens[i]} ${tokens[i + 1]}`;
        if (!seen.has(pair)) {
          seen.add(pair);
          bigrams.set(pair, (bigrams.get(pair) || 0) + 1);
        }
      }
    }
  }

  return { advertisers, domains, unigrams, bigrams, ctas, size: (ads || []).length };
};

/**
 * Candidate search terms, best first.
 *
 * A term earns its place by appearing across several different ads, not by
 * appearing often in one. Bigrams are weighted above single words because
 * "hydration powder" finds a niche and "hydration" finds a category.
 */
export const deriveTerms = (ads, { limit = 8 } = {}) => {
  const profile = seedProfile(ads);
  const spread = Math.max(1, profile.size);
  const scored = [];

  for (const [term, count] of profile.bigrams)
    if (count > 1 || spread === 1) scored.push({ term, count, weight: count * 2.2 });
  for (const [term, count] of profile.unigrams)
    if (count > 1 || spread === 1) scored.push({ term, count, weight: count });

  // A bigram already covers its own words; keeping both spends two searches on
  // one idea.
  const chosen = [];
  scored.sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term));
  for (const entry of scored) {
    if (chosen.length >= limit) break;
    const covered = chosen.some(
      (c) => c.term.includes(entry.term) || entry.term.includes(c.term),
    );
    if (covered) continue;
    chosen.push(entry);
  }

  return chosen.map((c) => ({
    term: c.term,
    ads: c.count,
    share: Number((c.count / spread).toFixed(2)),
  }));
};

/** The Ad Library URL a term is searched at. */
export const searchUrl = (term, { country = "ALL", activeOnly = true } = {}) => {
  const params = new URLSearchParams({
    active_status: activeOnly ? "active" : "all",
    ad_type: "all",
    country,
    q: term,
    search_type: "keyword_unordered",
    media_type: "all",
  });
  return `https://www.facebook.com/ads/library/?${params}`;
};
