/**
 * Supabase client for the extension.
 *
 * Two things differ from a web app.
 *
 * Session storage is chrome.storage.local rather than localStorage, because
 * the dashboard and the side panel are separate documents and a session saved
 * in one has to be visible in the other.
 *
 * Sign-in is an emailed six-digit code, not a magic link. A link has to
 * redirect somewhere, which for an extension means registering a redirect URL
 * and handling launchWebAuthFlow; a code needs neither and works the same on
 * every machine. Google OAuth can come later for the people who would rather
 * not type a code, but it needs provider setup that a code does not.
 */
import { createClient } from "@supabase/supabase-js";
import { loadConfig } from "./config.js";

/** chrome.storage.local, shaped the way supabase-js expects. */
const chromeStorage = {
  getItem: async (key) => {
    const got = await chrome.storage.local.get(key);
    return got[key] ?? null;
  },
  setItem: async (key, value) => chrome.storage.local.set({ [key]: value }),
  removeItem: async (key) => chrome.storage.local.remove(key),
};

let client = null;
let clientKey = "";

/** Null when the project has not been configured yet. */
export const getClient = async () => {
  const { url, anonKey } = await loadConfig();
  if (!url || !anonKey) return null;

  const key = `${url}|${anonKey}`;
  if (client && clientKey === key) return client;

  client = createClient(url, anonKey, {
    auth: {
      storage: chromeStorage,
      storageKey: "supabaseSession",
      persistSession: true,
      autoRefreshToken: true,
      // There is no redirect to read a session out of.
      detectSessionInUrl: false,
    },
  });
  clientKey = key;
  return client;
};

export const getSession = async () => {
  const supabase = await getClient();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session || null;
};

export const sendCode = async (email) => {
  const supabase = await getClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured yet." };
  const { error } = await supabase.auth.signInWithOtp({
    email: String(email || "").trim(),
    options: { shouldCreateUser: true },
  });
  return error ? { ok: false, error: error.message } : { ok: true };
};

export const verifyCode = async (email, code) => {
  const supabase = await getClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured yet." };
  const { data, error } = await supabase.auth.verifyOtp({
    email: String(email || "").trim(),
    token: String(code || "").trim(),
    type: "email",
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, session: data.session };
};

export const signOut = async () => {
  const supabase = await getClient();
  if (supabase) await supabase.auth.signOut();
  return { ok: true };
};

/**
 * What actually works right now, reported as three separate facts rather than
 * one "connected" boolean, because they fail independently and the fix for
 * each is different.
 */
export const checkConnection = async () => {
  const { url, anonKey } = await loadConfig();
  if (!url || !anonKey)
    return { configured: false, reachable: false, schema: false, signedIn: false };

  const out = { configured: true, reachable: false, schema: false, signedIn: false };

  try {
    const res = await fetch(`${url}/auth/v1/health`, { headers: { apikey: anonKey } });
    out.reachable = res.ok;
  } catch (err) {
    return { ...out, error: "Could not reach the project." };
  }

  try {
    const res = await fetch(`${url}/rest/v1/teams?select=id&limit=1`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    // 404 with PGRST205 means the tables are not there yet, which is the
    // normal state before schema.sql has been run.
    out.schema = res.status !== 404;
    if (!out.schema) out.error = "Run supabase/schema.sql in the SQL editor.";
  } catch (err) {
    out.error = "Could not query the project.";
  }

  out.signedIn = !!(await getSession());
  return out;
};
