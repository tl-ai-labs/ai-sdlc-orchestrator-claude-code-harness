/**
 * Regression tests for environment sanitation.
 *
 * Background: plugin.json declares the MCP server's environment as `"${VAR}"` pass-throughs
 * from the host. When the host never exported the variable, the placeholder arrives at this
 * process verbatim — the literal string `${GOOGLE_CLOUD_PROJECT}`, which is truthy and
 * therefore indistinguishable from a real value to every consumer downstream. On 2026-08-04
 * that made selectGeminiBackend throw on an unrecognised GEMINI_BACKEND, killed every
 * mechanical-tier dispatch, and turned a mixed-tier run into an all-premium one.
 *
 * These tests pin three things: what counts as unusable, that only the declared variables
 * are ever touched, and that legitimate values which merely resemble a placeholder survive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isUnusableEnvValue,
  sanitizePluginEnv,
  PLUGIN_DECLARED_ENV,
  UNEXPANDED_PLACEHOLDER,
} from "../dist/env.js";

test("an unexpanded placeholder is unusable", () => {
  assert.equal(isUnusableEnvValue("${GOOGLE_CLOUD_PROJECT}"), true);
  assert.equal(isUnusableEnvValue("${GEMINI_BACKEND}"), true);
  assert.equal(isUnusableEnvValue("${_PRIVATE_VAR9}"), true);
  // Surrounding whitespace must not hide it.
  assert.equal(isUnusableEnvValue("  ${GEMINI_API_KEY}  "), true);
});

test("absent and empty values are unusable", () => {
  assert.equal(isUnusableEnvValue(undefined), true);
  assert.equal(isUnusableEnvValue(""), true);
  assert.equal(isUnusableEnvValue("   "), true);
});

test("a real value containing a dollar sign is left alone", () => {
  // The regex is anchored at both ends precisely so these survive. A passphrase or a
  // path that happens to contain `${...}` is a legitimate value, not a placeholder.
  assert.equal(isUnusableEnvValue("ai-studies-console"), false);
  assert.equal(isUnusableEnvValue("/Users/x/creds.json"), false);
  assert.equal(isUnusableEnvValue("p$${weird}word"), false);
  assert.equal(isUnusableEnvValue("prefix-${VAR}"), false);
  assert.equal(isUnusableEnvValue("${VAR}-suffix"), false);
  assert.equal(isUnusableEnvValue("${not a var name}"), false);
  assert.equal(isUnusableEnvValue("$VAR"), false);
});

test("sanitize deletes the placeholders and reports their names", () => {
  const env = {
    GOOGLE_CLOUD_PROJECT: "${GOOGLE_CLOUD_PROJECT}",
    GEMINI_BACKEND: "${GEMINI_BACKEND}",
    GOOGLE_CLOUD_LOCATION: "asia-south1",
  };
  const removed = sanitizePluginEnv(env);

  assert.deepEqual(removed, ["GOOGLE_CLOUD_PROJECT", "GEMINI_BACKEND"]);
  assert.equal("GOOGLE_CLOUD_PROJECT" in env, false, "must be absent, not empty-string");
  assert.equal("GEMINI_BACKEND" in env, false);
  assert.equal(env.GOOGLE_CLOUD_LOCATION, "asia-south1", "a real value must survive");
});

test("after sanitation an unset variable is genuinely absent", () => {
  // This is the property the whole fix rests on: `key in env` is false, so every
  // consumer's existing "not set" branch runs — the backend selector falls through to
  // the ADC file, and the project resolver reads the quota project out of it.
  const env = { GOOGLE_CLOUD_PROJECT: "${GOOGLE_CLOUD_PROJECT}" };
  sanitizePluginEnv(env);
  assert.equal(env.GOOGLE_CLOUD_PROJECT, undefined);
  assert.equal(Object.keys(env).length, 0);
});

test("variables outside the declared set are never touched", () => {
  // Deleting arbitrary empty variables would be overreach — plenty are legitimately
  // empty, and tools we shell out to may depend on them.
  const env = {
    PATH: "/usr/bin",
    SOME_OTHER_VAR: "${SOME_OTHER_VAR}",
    LEGITIMATELY_EMPTY: "",
    GEMINI_API_KEY: "${GEMINI_API_KEY}",
  };
  const removed = sanitizePluginEnv(env);

  assert.deepEqual(removed, ["GEMINI_API_KEY"]);
  assert.equal(env.SOME_OTHER_VAR, "${SOME_OTHER_VAR}");
  assert.equal(env.LEGITIMATELY_EMPTY, "");
  assert.equal(env.PATH, "/usr/bin");
});

test("a clean environment is returned unchanged", () => {
  const env = { GOOGLE_CLOUD_PROJECT: "ai-studies-console", GOOGLE_CLOUD_LOCATION: "global" };
  assert.deepEqual(sanitizePluginEnv(env), []);
  assert.equal(env.GOOGLE_CLOUD_PROJECT, "ai-studies-console");
});

test("every variable plugin.json declares is covered", () => {
  // If a pass-through is added to plugin.json without being added here, it keeps the
  // old broken behaviour silently. This asserts the list we sanitize is the list we ship.
  assert.deepEqual([...PLUGIN_DECLARED_ENV].sort(), [
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GEMINI_BACKEND",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_PROJECT",
  ]);
});

test("the placeholder pattern is anchored", () => {
  assert.equal(UNEXPANDED_PLACEHOLDER.test("${A}"), true);
  assert.equal(UNEXPANDED_PLACEHOLDER.test("x${A}"), false);
  assert.equal(UNEXPANDED_PLACEHOLDER.test("${A}x"), false);
  // A leading digit is not a valid shell identifier, so it is not a placeholder we emit.
  assert.equal(UNEXPANDED_PLACEHOLDER.test("${9A}"), false);
});
