# Meta Ads Library Saver (Chrome Extension)

Turn the [Meta Ad Library](https://www.facebook.com/ads/library/) into your own swipe-file tool: capture ads as you browse, save them into lists, download the creatives, and see every stat Meta actually exposes.

## Features

- **Capture from the source, not the DOM.** A page-world interceptor reads the Ad Library's own GraphQL responses, so you get fields the UI hides: HD video URLs, CTA type, destination link, collation (variation) counts, EU reach, and spend/impression ranges where Meta publishes them.
- **Save buttons on every ad card**, matched by Library ID, plus a floating panel with "Save all captured" as you scroll.
- **Dashboard** (extension page): searchable, filterable grid of everything you saved.
  - Create/rename/delete your own **lists** and bulk-add ads to them.
  - Filters: format (video/image/carousel), active status, free-text search across advertiser, copy, CTA, and link.
  - Sorts: recently saved, longest running, newest, advertiser, highest EU reach.
  - Detail view with playable videos, full copy, and every captured field.
  - Export the current view as **JSON or CSV**.
- **Metrics.** A KPI row (ads, advertisers, active, total spend, total impressions, EU reach, saves this week, average days running) plus a metrics panel with saves per day over 30 days, top advertisers, format mix, placements, and spend by currency. Every metric recomputes against the current list, search, and filters, so it describes what you are looking at rather than the whole library.
- **One-click creative downloads** via `chrome.downloads`, organized as `Downloads/MetaAdsLibrary/<advertiser>/<adId>.<ext>` (HD video preferred).
- **Durable thumbnails**: Facebook CDN URLs are signed and expire, so a small preview image is stored at save time; download the media itself to keep it permanently.

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** and select this `meta-ads-extension/` folder.
3. Browse `facebook.com/ads/library`, scroll some results, and hit **Save**.
4. Open the dashboard from the toolbar popup or the floating panel.

No build step; plain MV3 JavaScript. Icons are checked in; regenerate them with `node icons/generate-icons.mjs`.

Run the metrics unit tests with `node tests/metrics.test.cjs`.

## About "spend and efficacy"

Meta does not publish performance data for regular commercial ads. What is public, and what this extension surfaces when present:

| Signal                              | Available for                                         |
| ----------------------------------- | ----------------------------------------------------- |
| Spend range, impressions range      | Political / social-issue ads only                     |
| EU total reach + demographics       | Ads delivered in the EU (DSA transparency)            |
| Funding byline, payer/beneficiary   | Political ads, EU ads                                 |
| Start date / active status          | All ads                                               |
| Collation count (active variations) | Most ads                                              |
| Days running (computed)             | All ads - the classic proxy: winners are kept running |

CTR, ROAS, and conversion data are never public; nothing can reveal them for other advertisers' ads. Likes, comments, shares, and **saves on an ad** are not in the Ad Library either - "saves" in this extension means your own saving activity, which is why those metrics are exact while spend and impressions are ranges.

### How the totals are computed

Meta publishes spend and impressions only as **bounded ranges** (`$100 - $199`, `1K - 5K`), so the extension sums the bounds and shows a total range, never a single invented figure. Three rules keep the totals honest:

- **Coverage is always shown.** Every disclosure-based tile carries a note like `5 of 42 ads`. A spend total drawn from 5 ads must not read like a total across all 42.
- **Currencies are never mixed.** Totals are grouped by currency; a second currency gets its own row in the metrics panel rather than being added to the first.
- **Open-ended ranges stay open-ended.** If any ad reports `10M+`, the total has no knowable ceiling, so it renders as `30M+` rather than a range whose upper bound is just the sum of the ads that happened to have one.

Parsing and aggregation live in `dashboard/metrics.js`, isolated from the UI so they can be unit-tested against the range formats Meta actually emits.

## Notes and limits

- Capture only works while browsing the Ad Library normally; the extension makes no requests of its own to Meta and only parses responses the page already loaded.
- Media URLs expire after a while. Downloads and stored thumbnails persist; the "open in Ad Library" link always works as long as Meta keeps the ad archived.
- All data stays in `chrome.storage.local` on your machine. Nothing is sent anywhere.
- Intended for competitor research and inspiration. Respect Meta's Terms of Service and applicable law when using downloaded creatives; don't republish other people's ads as your own.

## Architecture

```
manifest.json            MV3 manifest
content/interceptor.js   MAIN world: hooks fetch/XHR, parses GraphQL, postMessage
content/content.js       ISOLATED world: card buttons, floating panel, messaging
background.js            service worker: storage (ads + lists), downloads, thumbnails
dashboard/metrics.js     range parsing + aggregation (pure, unit-testable)
dashboard/               saved-ads dashboard (lists, metrics, export)
popup/                   toolbar popup with quick stats
icons/                   generated PNGs + generator script
```

Data flow: `interceptor.js` → `window.postMessage` → `content.js` → `chrome.runtime.sendMessage` → `background.js` → `chrome.storage.local` → dashboard/popup.
