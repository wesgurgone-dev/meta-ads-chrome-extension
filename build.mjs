/**
 * Bundles the React surfaces into plain files Chrome can load.
 *
 * MV3 forbids remote code, so React, OpenGlass UI and our own source are
 * bundled into one IIFE per page and committed. There is no runtime module
 * resolution and nothing is fetched. The content script and the service
 * worker are untouched by this: they stay hand-written and unbundled.
 */
import { build } from "esbuild";
import { readdirSync, statSync } from "node:fs";

const targets = [
  { in: "panel/src/main.jsx", out: "panel/panel.bundle.js" },
  { in: "dashboard/src/main.jsx", out: "dashboard/dashboard.bundle.js" },
];

const exists = (p) => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};

const kb = (p) => (statSync(p).size / 1024).toFixed(1) + "KB";

for (const t of targets) {
  if (!exists(t.in)) {
    console.log(`skip   ${t.in} (not written yet)`);
    continue;
  }
  await build({
    entryPoints: [t.in],
    outfile: t.out,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome114"],
    jsx: "automatic",
    minify: true,
    // No eval and no inline source maps: MV3's CSP rejects both.
    sourcemap: false,
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "none",
    logLevel: "warning",
  });
  const css = t.out.replace(/\.js$/, ".css");
  console.log(
    `built  ${t.out} ${kb(t.out)}` + (exists(css) ? `  + ${css} ${kb(css)}` : ""),
  );
}
