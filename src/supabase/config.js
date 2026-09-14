/**
 * Where the project details live.
 *
 * The publishable (anon) key is designed to sit in client code: it carries no
 * privileges of its own, and every row it can reach is decided by the row
 * policies in supabase/schema.sql. With those policies in place an anonymous
 * caller sees nothing at all, because each one requires membership of a team
 * and an anonymous caller has no auth.uid().
 *
 * The service_role key and the database password are a different matter and
 * appear nowhere in this repo or in the built extension.
 *
 * These are defaults. Settings can override both, which is what makes the
 * extension usable against someone else's project without a rebuild.
 */

export const DEFAULT_CONFIG = {
  url: "https://jkshbnmqyyrafszagxiq.supabase.co",
  anonKey: "sb_publishable_rGMOENom61CDmhaiJp3kFg_lfdxVYw3",
};

const KEY = "supabaseConfig";

export const loadConfig = async () => {
  try {
    const stored = await chrome.storage.local.get(KEY);
    const saved = stored[KEY] || {};
    return {
      url: (saved.url || DEFAULT_CONFIG.url || "").replace(/\/+$/, ""),
      anonKey: saved.anonKey || DEFAULT_CONFIG.anonKey || "",
    };
  } catch (err) {
    return { ...DEFAULT_CONFIG };
  }
};

export const saveConfig = async ({ url, anonKey }) => {
  await chrome.storage.local.set({
    [KEY]: { url: (url || "").trim().replace(/\/+$/, ""), anonKey: (anonKey || "").trim() },
  });
};

export const clearConfig = () => chrome.storage.local.remove(KEY);
