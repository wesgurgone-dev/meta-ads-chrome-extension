/**
 * Pin the extension's ID by writing a public key into the manifest.
 *
 * An unpacked extension's ID is derived from the absolute path you loaded it
 * from, so it stays put while the folder does - and changes the moment you move
 * the repo, clone it on another machine, or a colleague loads it from their own
 * path. Anything keyed to the ID breaks when that happens, and the thing that
 * will be keyed to it here is the OAuth redirect
 * (https://<extension-id>.chromiumapp.org/), which has to be registered with
 * Supabase in advance. A registered redirect that only works on one machine is
 * not much of a redirect.
 *
 * Pinning a `key` fixes the ID everywhere, permanently.
 *
 *   node scripts/pin-extension-id.mjs
 *
 * The matching private key is written outside the repository and is NOT needed
 * for development - only for packing a .crx by hand, which this project does
 * not do. Chrome derives the ID from the public half alone.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const keyDir = join(homedir(), ".config", "meta-ads-extension");
const pemPath = join(keyDir, "extension-key.pem");

/**
 * Chrome's ID derivation: the first 16 bytes of the SHA-256 of the DER public
 * key, with each nibble mapped onto a-p rather than 0-f.
 */
const idFromPublicKey = (derBase64) => {
  const digest = createHash("sha256").update(Buffer.from(derBase64, "base64")).digest();
  return [...digest.subarray(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .split("")
    .map((hex) => String.fromCharCode(97 + parseInt(hex, 16)))
    .join("");
};

if (!existsSync(keyDir)) mkdirSync(keyDir, { recursive: true });

if (existsSync(pemPath)) {
  console.log(`Reusing the key already at ${pemPath}`);
} else {
  // Chrome wants RSA-2048, and PKCS#1 is what its own packer produces.
  execFileSync("openssl", ["genrsa", "-out", pemPath, "2048"], { stdio: ["ignore", "ignore", "pipe"] });
  console.log(`Generated a new key at ${pemPath}`);
}

const derBase64 = execFileSync(
  "openssl",
  ["rsa", "-in", pemPath, "-pubout", "-outform", "DER"],
  { stdio: ["ignore", "pipe", "pipe"] },
).toString("base64");

const id = idFromPublicKey(derBase64);

const manifestPath = join(root, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.key === derBase64) {
  console.log("The manifest already carries this key; nothing to do.");
} else {
  // Ordered deliberately: `key` sits next to the other identity fields rather
  // than at the end, where it reads as an afterthought.
  const next = {};
  for (const [k, v] of Object.entries(manifest)) {
    next[k] = v;
    if (k === "version") next.key = derBase64;
  }
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log("Wrote the public key into manifest.json");
}

console.log("");
console.log(`Extension ID (now fixed on every machine): ${id}`);
console.log("");
console.log("Next:");
console.log("  1. chrome://extensions -> reload the extension. The ID becomes the one above.");
console.log("  2. Keep the .pem. It is outside the repo and gitignored anyway; it is only");
console.log("     needed if you ever pack a .crx by hand.");
console.log("  3. If you later publish to the Chrome Web Store, use the key the store");
console.log("     issues instead of this one, or the IDs will not match.");
