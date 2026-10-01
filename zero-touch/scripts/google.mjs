/**
 * Is this computer connected to Google (for Flash 3.8)? The mmo plugin's own rule, copied.
 *
 * mmo already answers this in plugin/scripts/verify-setup.mjs, and answers it well (read 1 Oct 2026): a value that
 * is only an unexpanded placeholder does not count; a credential file is opened and read, and must hold the fields a
 * real login has; a Google Cloud project name on its own is not a login ("a project ID says where to bill, not who
 * is asking"); an explicit GOOGLE_APPLICATION_CREDENTIALS that cannot be used is "broken", because the Google library
 * does not fall back from it. Zero-touch carries no mmo code (Claude Code copies each plugin on its own), so the rule
 * is copied here function for function; tools/test/zero-touch-google.test.mjs runs both on the same cases and fails
 * if they ever disagree.
 *
 * Two checks:
 *   googleState(env)      offline and instant, at every chat start and before a workflow starts
 *   onlineCheck(env)      one real request, only when settings that use Flash are saved: for the gcloud login file,
 *                         `gcloud auth application-default print-access-token` (the application-default login is the
 *                         one the model server signs with), at most 3 seconds. Skipped when there is no gcloud, or
 *                         when the login is an API key or a service-account file (the offline check covers those).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Copied from plugin/scripts/verify-setup.mjs (keep in step; the test compares them) ───

export function isUnexpandedPlaceholder(value) {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(String(value ?? "").trim());
}

export function usableEnv(env = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const trimmed = String(value).trim();
    if (trimmed === "" || isUnexpandedPlaceholder(trimmed)) continue;
    out[key] = value;
  }
  return out;
}

export const CREDENTIAL_REQUIRED_FIELDS = {
  authorized_user: ["client_id", "client_secret", "refresh_token"],
  service_account: ["client_email", "private_key"],
  external_account: ["audience", "subject_token_type", "token_url"],
  impersonated_service_account: ["service_account_impersonation_url", "source_credentials"],
};

export function inspectCredentialFile(path, { exists = existsSync, read = readFileSync } = {}) {
  if (!path) return { present: false, usable: false, type: null, detail: null };
  if (!exists(path)) return { present: false, usable: false, type: null, detail: `${path} does not exist` };
  let parsed;
  try {
    parsed = JSON.parse(read(path, "utf8"));
  } catch (err) {
    return { present: true, usable: false, type: null, detail: `${path} is not valid JSON (${err.message})` };
  }
  const type = typeof parsed?.type === "string" ? parsed.type.trim() : null;
  if (!type) return { present: true, usable: false, type: null, detail: `${path} has no "type" field, so no Google auth library can tell what kind of credential it is` };
  const required = CREDENTIAL_REQUIRED_FIELDS[type];
  if (!required) return { present: true, usable: true, type, detail: `credential type '${type}' is not one this check knows how to verify` };
  const missing = required.filter((field) => !parsed[field]);
  if (missing.length > 0) return { present: true, usable: false, type, detail: `${path} is a '${type}' credential but is missing ${missing.join(", ")}` };
  return { present: true, usable: true, type, detail: null };
}

export function vertexCredentialState({ env = {}, serviceAccountFile = null, adcFile = null } = {}) {
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    if (serviceAccountFile?.usable) return { state: "credential", source: "GOOGLE_APPLICATION_CREDENTIALS", detail: serviceAccountFile.detail };
    return {
      state: "broken",
      source: "GOOGLE_APPLICATION_CREDENTIALS",
      detail: serviceAccountFile?.detail ?? `GOOGLE_APPLICATION_CREDENTIALS points at ${env.GOOGLE_APPLICATION_CREDENTIALS}, which cannot be read`,
    };
  }
  if (adcFile?.usable) return { state: "credential", source: "gcloud ADC file", detail: adcFile.detail };
  if (adcFile?.present) return { state: "broken", source: "gcloud ADC file", detail: adcFile.detail };
  if (env.GOOGLE_CLOUD_PROJECT) return { state: "project-only", source: "GOOGLE_CLOUD_PROJECT", detail: null };
  return { state: "none", source: null, detail: null };
}

export function hasGeminiCredentials({ env = {}, vertex = null } = {}) {
  return Boolean(env.GEMINI_API_KEY || vertex?.state === "credential");
}

// ─── Zero-touch's use of it ──────────────────────────────────────────────

/** Where gcloud writes its login file (verify-setup.mjs adcPath), under the HOME this process was given. */
export function adcPath(env = process.env) {
  return join(env.HOME && env.HOME.trim() ? env.HOME : homedir(), ".config", "gcloud", "application_default_credentials.json");
}

/**
 * The offline answer: { connected, state, source, detail }.
 *   state "key"          an API key (GEMINI_API_KEY): connected
 *   state "credential"   a complete login file: connected
 *   state "broken"       a login is configured but cannot be used: not connected, and the person is told why
 *   state "project-only" a project name without a login: not connected
 *   state "none"         nothing: not connected
 */
export function googleState(env = process.env) {
  const real = usableEnv(env);
  const serviceAccountFile = real.GOOGLE_APPLICATION_CREDENTIALS ? inspectCredentialFile(real.GOOGLE_APPLICATION_CREDENTIALS) : null;
  const adcFile = inspectCredentialFile(adcPath(env));
  const vertex = vertexCredentialState({ env: real, serviceAccountFile, adcFile });
  if (real.GEMINI_API_KEY) return { connected: true, state: "key", source: "GEMINI_API_KEY", detail: null };
  return { connected: hasGeminiCredentials({ env: real, vertex }), state: vertex.state, source: vertex.source, detail: vertex.detail };
}

/**
 * The one real check, when settings that use Flash are saved: "works", "refused" (with gcloud's first line) or
 * "unknown" (nothing to test with: no gcloud, or a login this test does not cover). Never throws.
 */
export function onlineCheck(env = process.env, { run = spawnSync } = {}) {
  const s = googleState(env);
  if (!s.connected) return { result: "refused", detail: s.detail };
  if (s.state !== "credential" || s.source !== "gcloud ADC file") return { result: "unknown", detail: null };
  try {
    const r = run("gcloud", ["auth", "application-default", "print-access-token"], { encoding: "utf8", timeout: 3000, env, stdio: ["ignore", "pipe", "pipe"] });
    if (r.error) return { result: "unknown", detail: null };
    if (r.status === 0 && String(r.stdout ?? "").trim()) return { result: "works", detail: null };
    return { result: "refused", detail: String(r.stderr ?? "").trim().split("\n").find(Boolean)?.slice(0, 200) ?? null };
  } catch {
    return { result: "unknown", detail: null };
  }
}
