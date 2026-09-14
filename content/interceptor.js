/**
 * Runs in the page's MAIN world on facebook.com/ads/library.
 *
 * The Ad Library UI fetches its results from Facebook's GraphQL endpoint.
 * Those responses contain far more data than the page renders (spend,
 * impressions, EU reach, CTA, link URLs, HD video URLs, ...), so instead of
 * scraping the DOM we hook fetch/XHR, parse every GraphQL response, and
 * deep-scan it for ad objects. Normalized ads are handed to the extension's
 * content script via window.postMessage.
 */
(() => {
  "use strict";

  if (window.__malInterceptorInstalled) return;
  window.__malInterceptorInstalled = true;

  const MSG_TYPE = "MAL_ADS_CAPTURED";

  // ---------------------------------------------------------------------
  // Normalization
  // ---------------------------------------------------------------------

  const toEpochMs = (v) => {
    if (v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    // Ad Library timestamps are unix seconds.
    return n < 1e12 ? n * 1000 : n;
  };

  const text = (v) => {
    if (v == null) return null;
    if (typeof v === "string") return v;
    if (typeof v === "object" && typeof v.text === "string") return v.text;
    return null;
  };

  const mediaFromSnapshot = (snap) => {
    const media = [];
    const pushImage = (img) => {
      if (!img) return;
      const url =
        img.original_image_url ||
        img.resized_image_url ||
        img.original_picture_url ||
        null;
      if (!url) return;
      media.push({
        type: "image",
        url,
        previewUrl: img.resized_image_url || url,
      });
    };
    const pushVideo = (vid) => {
      if (!vid) return;
      const hd = vid.video_hd_url || null;
      const sd = vid.video_sd_url || null;
      if (!hd && !sd) return;
      media.push({
        type: "video",
        url: hd || sd,
        hdUrl: hd,
        sdUrl: sd,
        previewUrl: vid.video_preview_image_url || null,
      });
    };

    (snap.images || []).forEach(pushImage);
    (snap.videos || []).forEach(pushVideo);
    (snap.cards || []).forEach((card) => {
      if (card.video_hd_url || card.video_sd_url) pushVideo(card);
      else pushImage(card);
    });

    // De-duplicate by URL.
    const seen = new Set();
    return media.filter((m) => {
      if (seen.has(m.url)) return false;
      seen.add(m.url);
      return true;
    });
  };

  const spendValue = (raw) => {
    if (raw == null) return null;
    if (typeof raw === "string" || typeof raw === "number") return String(raw);
    if (typeof raw === "object") {
      const lower = raw.lower_bound ?? raw.lower ?? null;
      const upper = raw.upper_bound ?? raw.upper ?? null;
      if (lower != null && upper != null) return `${lower} - ${upper}`;
      if (lower != null) return `${lower}+`;
    }
    return null;
  };

  /**
   * Numeric bounds behind a range. Meta publishes spend and impressions only
   * as ranges, so keeping the raw bounds lets the dashboard total them without
   * re-parsing a display string. `upper: null` means open-ended ("10M+").
   */
  const numericBounds = (raw) => {
    if (raw == null || typeof raw !== "object")
      return { lower: null, upper: null };
    const num = (v) => {
      if (v == null) return null;
      const n = Number(String(v).replace(/[,\s]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    return {
      lower: num(raw.lower_bound ?? raw.lower),
      upper: num(raw.upper_bound ?? raw.upper),
    };
  };

  const normalizeAd = (node) => {
    const snap = node.snapshot || {};
    const ad = {
      id: String(node.ad_archive_id),
      pageId: node.page_id != null ? String(node.page_id) : null,
      pageName: node.page_name || snap.page_name || null,
      pageProfilePictureUrl: snap.page_profile_picture_url || null,
      pageLikeCount: snap.page_like_count ?? null,
      pageCategories: snap.page_categories || null,
      startDate: toEpochMs(node.start_date ?? node.ad_delivery_start_time),
      endDate: toEpochMs(node.end_date ?? node.ad_delivery_stop_time),
      isActive:
        node.is_active ??
        (node.active_status ? node.active_status === "ACTIVE" : null),
      platforms: node.publisher_platform || node.publisher_platforms || [],
      displayFormat: snap.display_format || null,
      body: text(snap.body) || text(node.body) || null,
      title: text(snap.title) || null,
      caption: snap.caption || null,
      ctaText: snap.cta_text || null,
      ctaType: snap.cta_type || null,
      linkUrl: snap.link_url || null,
      linkDescription: text(snap.link_description) || null,
      spend: spendValue(node.spend),
      spendLower: numericBounds(node.spend).lower,
      spendUpper: numericBounds(node.spend).upper,
      currency: node.currency || null,
      impressionsText:
        (node.impressions_with_index &&
          node.impressions_with_index.impressions_text) ||
        spendValue(node.impressions) ||
        null,
      impressionsLower: numericBounds(node.impressions).lower,
      impressionsUpper: numericBounds(node.impressions).upper,
      euTotalReach: node.eu_total_reach ?? null,
      reachEstimate: spendValue(node.reach_estimate),
      byline: node.byline || null,
      collationCount: node.collation_count ?? null,
      collationId: node.collation_id != null ? String(node.collation_id) : null,
      categories: node.categories || null,
      entityType: node.entity_type || null,
      media: mediaFromSnapshot(snap),
      capturedAt: Date.now(),
      libraryUrl: `https://www.facebook.com/ads/library/?id=${node.ad_archive_id}`,
    };
    // EU DSA transparency block (age/gender/location breakdown lives here).
    if (node.aaa_info) {
      ad.targetedOrExcludedLocations = node.aaa_info.location_audience || null;
      ad.targetAges = node.aaa_info.age_audience
        ? spendValue(node.aaa_info.age_audience)
        : node.aaa_info.age_range || null;
      ad.genderAudience = node.aaa_info.gender_audience || null;
      ad.euTransparencyTotalReach = node.aaa_info.eu_total_reach ?? null;
      ad.demographicBreakdown =
        node.aaa_info.age_country_gender_reach_breakdown || null;
      ad.payerBeneficiary = node.aaa_info.payer_beneficiary_data || null;
    }
    return ad;
  };

  // Walk any JSON payload and collect objects that look like Ad Library ads.
  const collectAds = (value, out, depth = 0) => {
    if (depth > 30 || value == null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) collectAds(item, out, depth + 1);
      return;
    }
    if (value.ad_archive_id != null && typeof value.snapshot === "object") {
      try {
        out.push(normalizeAd(value));
      } catch (err) {
        // A malformed node should never break capture of its siblings.
      }
      // collated_results can nest more ads inside a matched node.
    }
    for (const key of Object.keys(value))
      collectAds(value[key], out, depth + 1);
  };

  // ---------------------------------------------------------------------
  // Response parsing
  // ---------------------------------------------------------------------

  const parsePayload = (rawText) => {
    if (!rawText || rawText.indexOf("ad_archive_id") === -1) return [];
    const ads = [];
    // GraphQL responses may be a single JSON doc, newline-delimited JSON
    // chunks, or prefixed with the classic "for (;;);" guard.
    const cleaned = rawText.replace(/^for\s*\(;;\);/, "");
    const chunks = cleaned.split("\n").filter((line) => line.trim().length > 1);
    const candidates = chunks.length > 0 ? chunks : [cleaned];
    for (const chunk of candidates) {
      try {
        collectAds(JSON.parse(chunk), ads);
      } catch (err) {
        // Not a JSON chunk; skip.
      }
    }
    return ads;
  };

  const publish = (ads) => {
    if (!ads.length) return;
    try {
      window.postMessage({ type: MSG_TYPE, ads }, window.location.origin);
    } catch (err) {
      // Some ads embed values that fail structured clone; strip via JSON.
      try {
        window.postMessage(
          { type: MSG_TYPE, ads: JSON.parse(JSON.stringify(ads)) },
          window.location.origin,
        );
      } catch (err2) {
        /* give up on this batch */
      }
    }
  };

  const isInterestingUrl = (url) =>
    typeof url === "string" &&
    (url.includes("/api/graphql") || url.includes("/ads/library"));

  // ---------------------------------------------------------------------
  // fetch hook
  // ---------------------------------------------------------------------

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const input = args[0];
    const url = typeof input === "string" ? input : input && input.url;
    const result = origFetch.apply(this, args);
    if (isInterestingUrl(url)) {
      result
        .then((res) => {
          res
            .clone()
            .text()
            .then((body) => publish(parsePayload(body)))
            .catch(() => {});
          return res;
        })
        .catch(() => {});
    }
    return result;
  };

  // ---------------------------------------------------------------------
  // XHR hook
  // ---------------------------------------------------------------------

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__malUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (isInterestingUrl(this.__malUrl)) {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") {
            publish(parsePayload(this.responseText));
          }
        } catch (err) {
          /* ignore */
        }
      });
    }
    return origSend.apply(this, args);
  };

  // Initial page data is server-rendered into <script> tags; scan them once.
  const scanInlineScripts = () => {
    const ads = [];
    for (const script of document.querySelectorAll(
      'script[type="application/json"]',
    )) {
      const body = script.textContent || "";
      if (body.indexOf("ad_archive_id") === -1) continue;
      try {
        collectAds(JSON.parse(body), ads);
      } catch (err) {
        /* ignore */
      }
    }
    publish(ads);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scanInlineScripts, {
      once: true,
    });
  } else {
    scanInlineScripts();
  }
})();
