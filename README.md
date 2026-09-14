# Meta Ads Library Saver (Chrome Extension)

Turn the [Meta Ad Library](https://www.facebook.com/ads/library/) into a shared swipe file: capture ads as you browse, file them into colour-coded lists, share a space with your team, and keep the library across devices.

## Features

- **Native save controls.** A Save split-button and Download button are inserted into each ad card as their own full-width row, styled to match Facebook's controls, rather than floating over the creative.
- **Save straight into a list.** The caret beside Save opens a menu of your spaces and colour-coded lists, so an ad goes where it belongs in one click.
- **Side panel, opened from the toolbar button.** Clicking the extension icon slides out a workspace on the Ad Library itself, with Home, Saved, Lists and Account views: what is on the page and save-all, live counts, recently saved ads, and one-click pinning of the list new saves default to. There is no floating on-page button, and no popup: off the Ad Library the toolbar button opens the dashboard instead. The full dashboard is a footer link rather than the only place anything happens.
- **Spaces.** Keep separate libraries (per client, per project). Every space has its own lists, metrics, and exports.
- **Team spaces.** Create a team space to get a join code, export it as a space file, and teammates merge it into the same space. Everyone's lists combine and saves are attributed by name.
- **Colour-coded lists.** Eight label colours, editable per list; the colour shows in the sidebar, on each ad card, and in the save menu.
- **Cross-device sync.** Opt in and the library follows your Chrome profile to your other machines. No separate account to create.
- **Capture from the source, not the DOM.** A page-world interceptor reads the Ad Library's own GraphQL responses, so you get fields the UI hides: HD video URLs, CTA type, destination link, and variation counts.
- **Metrics** for the current space and filters: saves per day, top advertisers, format mix, placements, and (in a team space) who contributed what.
- **Downloads** organized as `Downloads/MetaAdsLibrary/<advertiser>/<adId>.<ext>`, HD video preferred.
- **Export** the current view as JSON or CSV.

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** and select this `meta-ads-extension/` folder.
3. Browse `facebook.com/ads/library`, scroll some results, and hit **Save** on any ad.

No build step; plain MV3 JavaScript. Icons are checked in; regenerate with `node icons/generate-icons.mjs`. Run the unit tests with `node tests/metrics.test.cjs`.

## Teams: how sharing actually works

Team spaces work **without a server and without accounts**:

1. One person creates a team space. It gets a six-character join code (e.g. `GZGH6X`).
2. They hit **Export space file** and send the `.json` to the team.
3. Teammates use **Join / merge from file**. Lists and ads merge into one space, matched on the join code, so importing repeatedly accumulates rather than duplicating.

The trade-off is that this is a **snapshot, not live sync**: re-export after adding ads. Live multi-user sync would need a hosted backend (Supabase, Firebase, or similar), which means an account, keys, and your saved research leaving your machines. That is a deliberate decision rather than a default.

## Cross-device sync

Sync is off by default. Turn it on in **Settings**, and the library rides the Chrome profile you are already signed into, so there is no separate login to build or maintain.

Chrome caps extension sync at about 100KB, which is real and worth knowing:

- Thumbnails and media URLs are **not** synced. Signed Facebook CDN links expire anyway, so they are worthless on another device; the Ad Library link always works.
- Ad copy is truncated for sync.
- Roughly 200 ads fit. Beyond that the most recent are synced and the Settings panel says so rather than silently dropping them.

Local storage on each device is unlimited; only the synced slice is capped.

## What this does not show, and why

Meta publishes spend and impression ranges **only for ads in the "Issues, Elections or Politics" category**, and audience reach only for ads delivered in the EU under DSA transparency. For ordinary commercial ads (the competitor research most people are doing here) those fields do not exist anywhere in the Ad Library, so no tool can produce them.

Earlier versions showed spend and impression tiles that read "not disclosed" on essentially every real search. Those have been removed. Spend, impressions, and EU reach still appear in an ad's detail view **when Meta actually published them**, and nowhere otherwise.

What is public and genuinely useful:

| Signal                      | Available for                                        |
| --------------------------- | ---------------------------------------------------- |
| Start date, active status   | All ads                                              |
| Days running (computed)     | All ads. The classic proxy: winners are kept running |
| Variation count (collation) | Most ads                                             |
| Creative format, placements | All ads                                              |
| Spend / impressions ranges  | Political and social-issue ads only                  |
| EU reach and demographics   | Ads delivered in the EU                              |

CTR, ROAS, conversions, and an ad's social save count are never public.

## Notes and limits

- Capture works while you browse normally. The extension makes no requests of its own to Meta and only parses responses the page already loaded.
- Media URLs expire. Downloads and stored thumbnails persist; the Ad Library link keeps working.
- Data stays in `chrome.storage.local`, plus `chrome.storage.sync` if you enable sync. Nothing goes to any third-party server.
- Field names in Meta's GraphQL responses are not a public contract and do get renamed. If capture goes quiet, that is the likely cause, and the fix is localized to `normalizeAd` in `content/interceptor.js`.
- For competitor research and inspiration. Respect Meta's Terms of Service and applicable law when using downloaded creatives.

## Architecture

```
manifest.json            MV3 manifest
content/interceptor.js   MAIN world: hooks fetch/XHR, parses GraphQL, postMessage
content/content.js       ISOLATED world: card action row, save menu, side panel
background.js            service worker: spaces/lists/ads, downloads, team bundles, sync
dashboard/metrics.js     aggregation (pure, unit-tested)
dashboard/               spaces, colour-coded lists, metrics, team and sync UI
tests/                   node tests for the metrics module
```

Storage shape: `spaces` hold `lists`, lists hold ad ids, and `ads` are stored once and referenced, so the same ad in two lists is one record.

The panel carries one continuous dot grid across its whole surface; the rail, header, footer and content blocks are translucent with a slight backdrop blur so the texture stays unbroken behind them.

Two layout notes worth keeping. First: the action row is anchored to the **card**, never to one of Facebook's buttons. The last `role="button"` in a card is "See summary details" on some cards and the "Shop now" CTA on others, so anchoring to it put the row above the creative on some cards and squeezed it into the CTA's narrow row on others. `findCardRoot` instead climbs from the Library ID text until the subtree mentions a second ad (meaning it has stepped out into the results grid) and keeps the outermost element still describing exactly one ad. The row is appended there, so it is always the card's last row: full width, below the creative and any CTA, flush with the card's bottom edge.

Second, and more important: **decoration does not depend on the network capture matching the card.** The number a card prints is not always the archive id of the node the interceptor captured - collated cards ("3 ads use this creative and text") nest their creatives under different ids - and requiring a match meant that when the two sets did not intersect, _no card was decorated at all_. Cards are now found from the DOM (short text nodes carrying a 12-20 digit id), and the richer GraphQL record is used when its id matches, with an ad assembled from the card itself as the fallback. That fallback carries the advertiser, the creative URLs on screen and the library link, so Save and Download still work. The panel's Account view shows a detection readout (cards found, cards decorated, ids matched) so a future mismatch is visible rather than silent.

Third: that walk must never return null. An earlier version rejected any card whose root was a horizontal flex row, which on the live site matched real cards and silently dropped the controls from every one of them. It now prefers a column/block root, falls back to a horizontal one (forcing `flex-wrap` so the row still lands on its own line), and finally falls back to the nearest ancestor holding the creative. A row in a slightly awkward place beats no row at all.
