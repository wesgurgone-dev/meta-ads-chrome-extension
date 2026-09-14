# Meta Ads Library Saver (Chrome Extension)

Turn the [Meta Ad Library](https://www.facebook.com/ads/library/) into your own swipe-file tool: capture ads as you browse, save them into lists, download the creatives, and see every stat Meta actually exposes.

## Features

- **Capture from the source, not the DOM.** A page-world interceptor reads the Ad Library's own GraphQL responses, so you get fields the UI hides: HD video URLs, CTA type, destination link, collation (variation) counts, EU reach, and spend/impression ranges where Meta publishes them.
- **Save buttons on every ad card**, matched by Library ID, plus a floating panel with "Save all captured" as you scroll.
- **Dashboard** (extension page): searchable, filterable grid of everything you saved.
  - Create/rename/delete your own **lists** and bulk-add ads to them.
  - Filters: format (video/image/carousel), active status, free-text search across advertiser, copy, CTA, and link.
  - Sorts: recently saved, longest running, newest, advertiser, highest EU reach.
  - Stats strip: ads in view, advertisers, active count, average days running, total EU reach, ads with spend data.
  - Detail view with playable videos, full copy, and every captured field.
  - Export the current view as **JSON or CSV**.
- **One-click creative downloads** via `chrome.downloads`, organized as `Downloads/MetaAdsLibrary/<advertiser>/<adId>.<ext>` (HD video preferred).
- **Durable thumbnails**: Facebook CDN URLs are signed and expire, so a small preview image is stored at save time; download the media itself to keep it permanently.

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** and select this `meta-ads-extension/` folder.
3. Browse `facebook.com/ads/library`, scroll some results, and hit **Save**.
4. Open the dashboard from the toolbar popup or the floating panel.

No build step; plain MV3 JavaScript. Icons are checked in; regenerate them with `node icons/generate-icons.mjs`.

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

CTR, ROAS, and conversion data are never public; nothing can reveal them for other advertisers' ads.

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
dashboard/               saved-ads dashboard (lists, stats, export)
popup/                   toolbar popup with quick stats
icons/                   generated PNGs + generator script
```

Data flow: `interceptor.js` → `window.postMessage` → `content.js` → `chrome.runtime.sendMessage` → `background.js` → `chrome.storage.local` → dashboard/popup.
