/**
 * Ranking the advertisers a keyword sweep turned up.
 *
 * A keyword search does not return competitors; it returns everyone who used
 * the word. Search "hydration powder" and you get the brands, their resellers,
 * three marketplaces, an affiliate comparison site and a gym. Ranking is what
 * turns that into an answer, and it is the part most likely to regress
 * silently, which is why it is pure and tested.
 *
 * Every component is bounded, so no single signal can dominate, and the total
 * is deterministic: the same hits in a different order rank identically.
 */
import { registrableDomain } from "./terms.js";

/** Places that sell everyone's product, so matching on a term means nothing. */
const MARKETPLACES = new Set([
  "amazon.com", "amazon.com.au", "amazon.co.uk", "ebay.com", "ebay.com.au",
  "etsy.com", "walmart.com", "target.com", "aliexpress.com", "temu.com",
  "wish.com", "catch.com.au", "kogan.com", "thewarehouse.co.nz",
  "iherb.com", "chemistwarehouse.com.au", "woolworths.com.au", "coles.com.au",
]);

/** Domains whose whole business is talking about other people's products. */
const AGGREGATOR = /(coupon|discount|deals?|voucher|promo|review|compare|comparison|affiliate|blog|directory)/i;

const median = (nums) => {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const daysRunning = (ad, now) => {
  if (!ad || !ad.startDate) return 0;
  const end = ad.endDate || now;
  return Math.max(0, Math.round((end - ad.startDate) / 86400000));
};

/** Overlap between two brand names, as a fraction of the shorter one. */
export const tokenOverlap = (a, b) => {
  if (!a || !b) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.includes(short)) return 1;
  let best = 0;
  for (let n = Math.min(short.length, 8); n >= 4; n--) {
    for (let i = 0; i + n <= short.length; i++) {
      if (long.includes(short.slice(i, i + n))) {
        best = Math.max(best, n / short.length);
        break;
      }
    }
    if (best) break;
  }
  return best;
};

/**
 * Fold the per-term hits into one row per advertiser.
 *
 * `hits` is [{ term, ads: [normalisedAd] }] - what each search actually
 * returned. `seed` is the seedProfile() of the list being matched against.
 */
export const clusterAdvertisers = (hits, seed, { now = Date.now() } = {}) => {
  const rows = new Map();

  for (const hit of hits || []) {
    for (const ad of hit.ads || []) {
      if (!ad || !ad.pageName) continue;
      const key = (ad.pageId && String(ad.pageId)) || ad.pageName.toLowerCase();
      let row = rows.get(key);
      if (!row) {
        row = {
          key,
          pageName: ad.pageName,
          pageId: ad.pageId || null,
          domains: new Map(),
          terms: new Set(),
          adIds: new Set(),
          activeCount: 0,
          days: [],
          sample: ad,
        };
        rows.set(key, row);
      }
      row.terms.add(hit.term);
      if (ad.id) row.adIds.add(ad.id);
      if (ad.isActive === true) row.activeCount += 1;
      row.days.push(daysRunning(ad, now));
      const domain = registrableDomain(ad.linkUrl);
      if (domain) row.domains.set(domain, (row.domains.get(domain) || 0) + 1);
    }
  }

  const seedDomains = [...(seed?.domains?.keys() || [])];
  const seedNames = new Set([...(seed?.advertisers?.keys() || [])]);

  const out = [];
  for (const row of rows.values()) {
    const domain =
      [...row.domains.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ||
      null;
    const isSeed =
      seedNames.has(row.pageName.toLowerCase()) ||
      (domain ? seedDomains.includes(domain) : false);

    const reasons = [];

    // How many different seed terms surfaced them. The strongest signal: one
    // term is a coincidence, three is a niche.
    const termScore = Math.min(3, row.terms.size) * 2;
    if (row.terms.size > 1) reasons.push(`matched ${row.terms.size} of your terms`);

    // How much their brand looks like one of yours. Weak on its own, useful as
    // a tiebreak between two advertisers with identical term coverage.
    let overlap = 0;
    for (const sd of seedDomains)
      overlap = Math.max(overlap, tokenOverlap(sd.split(".")[0], (domain || "").split(".")[0]));
    const overlapScore = overlap * 1.5;

    // Volume, flattened hard: running 200 ads is not ten times the signal of
    // running 20, it is mostly a bigger budget.
    const adCount = row.adIds.size;
    const volumeScore = Math.min(3, Math.log2(1 + adCount));

    // Longevity is the closest thing to a performance signal the Ad Library
    // gives away: nobody keeps paying for an ad that does not work.
    const days = median(row.days);
    const longevityScore = Math.min(2, days / 45);
    if (days >= 45) reasons.push(`ads running ${Math.round(days)} days`);

    let penalty = 0;
    if (domain && MARKETPLACES.has(domain)) {
      penalty += 6;
      reasons.push("a marketplace, not a competitor");
    } else if (domain && AGGREGATOR.test(domain)) {
      penalty += 3;
      reasons.push("looks like a review or deals site");
    }
    if (isSeed) reasons.push("already in your list");

    out.push({
      key: row.key,
      pageName: row.pageName,
      pageId: row.pageId,
      domain,
      terms: [...row.terms].sort(),
      adCount,
      activeCount: row.activeCount,
      medianDays: Math.round(days),
      isSeed,
      reasons,
      score: Number(
        Math.max(0, termScore + overlapScore + volumeScore + longevityScore - penalty).toFixed(2),
      ),
      libraryUrl: row.pageId
        ? `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&view_all_page_id=${row.pageId}`
        : `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&q=${encodeURIComponent(row.pageName)}&search_type=keyword_unordered`,
    });
  }

  // Name is the final tiebreak so the same input always ranks the same way.
  out.sort(
    (a, b) =>
      b.score - a.score ||
      b.terms.length - a.terms.length ||
      a.pageName.localeCompare(b.pageName),
  );
  return out;
};

/** What to show: the seed's own advertisers are dropped, everything else stays. */
export const rankCompetitors = (hits, seed, opts) =>
  clusterAdvertisers(hits, seed, opts).filter((r) => !r.isSeed);
