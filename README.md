# Meta Ads Library Saver (Chrome Extension)

Turn the [Meta Ad Library](https://www.facebook.com/ads/library/) into a shared swipe file: capture ads as you browse, file them into colour-coded lists, share a space with your team, and keep the library across devices.

## Features

- **Native save controls.** A Save split-button and Download button are inserted into each ad card as their own full-width row, styled to match Facebook's controls, rather than floating over the creative.
- **Save straight into a list.** The caret beside Save opens a menu of your spaces and colour-coded lists, so an ad goes where it belongs in one click.
- **A real browser side panel**, docked beside the page rather than floating over it. The toolbar button opens it on any tab, including `chrome://` pages and the Web Store, because Chrome owns the surface rather than the extension injecting one. Home, Saved, Lists and Account, with a **Go to Ad Library** button that hides itself once the tab is already there.
- **Side panel, opened from the toolbar button.** Clicking the extension icon slides out a workspace on the Ad Library itself, with Home, Saved, Lists and Account views: what is on the page and save-all, live counts, recently saved ads, and one-click pinning of the list new saves default to. There is no floating on-page button, and no popup: off the Ad Library the toolbar button opens the dashboard instead. The full dashboard is a footer link rather than the only place anything happens.
- **Personal / Team switch** in the panel header, so the whole workspace swaps between your own library and a joined team space in one tap.
- **Spaces.** Keep separate libraries (per client, per project). Every space has its own lists, metrics, and exports.
- **Team spaces.** Create a team space to get a join code, export it as a space file, and teammates merge it into the same space. Everyone's lists combine and saves are attributed by name.
- **Colour-coded lists.** Eight label colours, editable per list; the colour shows in the sidebar, on each ad card, and in the save menu.
- **Cross-device sync.** Opt in and the library follows your Chrome profile to your other machines. No separate account to create.
- **Capture from the source, not the DOM.** A page-world interceptor reads the Ad Library's own GraphQL responses, so you get fields the UI hides: HD video URLs, CTA type, destination link, and variation counts.
- **Metrics**, collapsed by default so the grid leads, for the current space and filters: saves per day, top advertisers, format mix, placements, and (in a team space) who contributed what.
- **Downloads at full resolution**, filed by list: `Downloads/MetaAdsLibrary/<list>/<advertiser>-<adId>.<ext>`. Switch to a folder per advertiser, or no subfolders, in Settings.
- **Detail view that stays on screen.** Ad creatives are mostly 9:16; at the modal's full width that is around 1450px tall, so the creative is capped and letterboxed and the record below it stays reachable.
- **Export** the current view as JSON or CSV.

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** and select this `meta-ads-extension/` folder.
3. Browse `facebook.com/ads/library`, scroll some results, and hit **Save** on any ad.

The side panel and the dashboard are React, bundled by esbuild into one
committed IIFE per page (`pnpm`-free: `npm install && node build.mjs`). React is
there for one reason, OpenGlass UI's SVG/SDF refraction, which needs its runtime
to generate a displacement map per surface. The content script and the service
worker are deliberately **not** bundled and stay hand-written: they are the
parts that run inside Facebook's page. Icons are checked in; regenerate with `node icons/generate-icons.mjs`. The mark is a stack of three cards, a swipe file: the front card carries the brand ramp, the two behind it are flat lilac at decreasing opacity, on a transparent background. Generated PNGs, the panel header and both dashboard marks are the same artwork, and a test fails if any of them drifts back to the old blue. Type is Helvetica throughout, weights 400/500/700 only (Helvetica has no real 600, so it would synthesise), with negative tracking applied at the body level and on every control that sets its own font shorthand, plus reduced tracking on uppercase micro-labels. Run the unit tests with `node tests/metrics.test.cjs`.

## Look

The ground is one gradient ramp, used everywhere:

```
#070707  0%     #4510e8  50%     #ed0cdd  71%     #ffc41d  86%     #ffffff 100%
```

It is not painted as a ramp. Each stop is pulled out into its own oversized
radial blob, the whole thing is blurred hard, and a scrim sits on top: enough
to keep type legible, not so much that four distinct colours collapse into one
purple. The panel and the dashboard share that ground exactly, same blobs, same
blur, same scrim; they drifted apart once when one was retuned and the other
was not, so a test now compares the two computed grounds directly. Grain over the scrim and again, fainter, on the glass hides the banding
a gradient this large would otherwise show, and gives the blur something to
work on so the two surfaces meet without a hard synthetic line.

Above the ground there is exactly one material, and it is thin: at most 0.26
alpha, so the ramp reads straight through it. What makes it a material rather
than a tint is the 42px blur and the 200% saturation behind it, plus a bright
top edge and a specular sheen down the top-left. The glass itself carries no
grain; grain is a property of the ground, and the blur pulls it through. Nor
does the glass cast a drop shadow, which at this thinness only darkened
whatever sat below it. Nothing is opaque and no glass stacks on glass, which is
where legibility collapses. Text never sits directly on the ramp: section labels
and empty states carry their own strip of material, because the ramp is vivid by
design and vivid is unreadable.

Type is SF Pro Display where it exists. Apple's font is licensed for Apple
platforms and is **not** redistributed here: the stack asks for it by name, then
falls back to `-apple-system`, Inter, and Helvetica. Tracking is size-specific,
tight on headings and near zero on body, because one `letter-spacing` value is
wrong somewhere.

Motion is minimal and lives on the press rather than the release. Both themes
share the ramp; the theme changes the scrim and the material, not the artwork.
`prefers-reduced-transparency` drops the blur and the grain for solid surfaces,
`prefers-contrast: more` firms up the edges, and `prefers-reduced-motion`
removes the press transforms.

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

## Download quality

The `<video>` element on the Ad Library page plays a downscaled variant, often a `blob:` MSE stream that cannot be fetched at all. The full-resolution file is `video_hd_url` in the GraphQL response, and the unresized still is `original_image_url`.

Those two are joined by matching the card's creative against the captured records: Facebook's CDN URLs carry signed, short-lived query parameters that differ between the page copy and the API copy, so the URL **path** is the stable identity. A card decorated from the DOM before the network capture arrives is upgraded in place once its record turns up, otherwise it would keep downloading the playback copy.

If no HD source was captured for an ad, the download falls back to the page copy and the toast says so, rather than quietly handing you a low-resolution file.

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
content/content.js       ISOLATED world: card action row and save menu only
panel/                   the browser side panel: its own page, its own look
background.js            service worker: spaces/lists/ads, downloads, team bundles, sync
dashboard/metrics.js     aggregation (pure, unit-tested)
dashboard/               spaces, colour-coded lists, metrics, team and sync UI
tests/                   node tests for metrics, playwright tests for the panel
```

The panel is a real side panel, so it cannot read the page. What is on screen
comes from the content script over `GET_PAGE_ADS`, and a tab with no content
script simply never answers, which the panel reads as "nothing here" rather
than as an error.

Storage shape: `spaces` hold `lists`, lists hold ad ids, and `ads` are stored once and referenced, so the same ad in two lists is one record.

The dot grid is the **full dashboard's** signature and appears nowhere else; over Facebook's own page the panel is plain liquid glass, where the texture fought with the blurred content behind it.

The panel is one continuous sheet: a translucent pane that blurs and saturates the page behind it, with a specular sheen down the top-left and an inner highlight edge. Interior areas (rail, header, footer, cards, stat tiles, mini cards) paint **no fill of their own** and are defined by hairlines and spacing, so the panel never reads as panels stacked inside a panel. Only the active nav tab is tinted, because that is state rather than decoration.

Light and dark are chosen under Settings (Match system / Light / Dark) and apply to both the dashboard and the panel. The dashboard swaps tokens on `:root`; the panel uses a class, because it follows the extension's setting rather than the OS. The per-card action row deliberately ignores the setting: it sits inside Facebook's card and has to match Facebook. Saved ads render as mini cards, the dashboard's card anatomy at panel scale: creative, status and format badges, advertiser, longevity, list colour, and a full-width Download; the creative and the advertiser name open the ad in the Ad Library.

Two layout notes worth keeping. First: the action row is anchored to the **card**, never to one of Facebook's buttons. The last `role="button"` in a card is "See summary details" on some cards and the "Shop now" CTA on others, so anchoring to it put the row above the creative on some cards and squeezed it into the CTA's narrow row on others. `findCardRoot` instead climbs from the Library ID text until the subtree mentions a second ad (meaning it has stepped out into the results grid) and keeps the outermost element still describing exactly one ad. The row is appended there, so it is always the card's last row: full width, below the creative and any CTA, flush with the card's bottom edge.

Second: **decoration must not wait for a trigger.** It used to run only when the interceptor delivered a capture or the DOM mutated, so on a page whose results were already rendered before the content script loaded (the normal case), nothing ever kicked off the first pass. It now runs on boot and sweeps a few times over the first seconds, with the observer handling everything after that.

Third, and most important: **decoration does not depend on the network capture matching the card.** The number a card prints is not always the archive id of the node the interceptor captured - collated cards ("3 ads use this creative and text") nest their creatives under different ids - and requiring a match meant that when the two sets did not intersect, _no card was decorated at all_. Cards are now found from the DOM (short text nodes carrying a 12-20 digit id), and the richer GraphQL record is used when its id matches, with an ad assembled from the card itself as the fallback. That fallback carries the advertiser, the creative URLs on screen and the library link, so Save and Download still work. The panel's Account view shows a detection readout (cards found, cards decorated, ids matched) so a future mismatch is visible rather than silent.

Fourth: that walk must never return null. An earlier version rejected any card whose root was a horizontal flex row, which on the live site matched real cards and silently dropped the controls from every one of them. It now prefers a column/block root, falls back to a horizontal one (forcing `flex-wrap` so the row still lands on its own line), and finally falls back to the nearest ancestor holding the creative. A row in a slightly awkward place beats no row at all.
