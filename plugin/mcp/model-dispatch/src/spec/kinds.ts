/**
 * The `kind` vocabulary of a typed build spec: the task types the routing
 * policies and the pipeline skill already use, plus `other`.
 *
 * Why the spec reuses the policy's own words: the policy routes a unit by
 * (phase, task_type). If the spec invented its own labels, some table would
 * have to translate them, and a translation table fitted to one stack is
 * exactly the kind of hand-tuning the design forbids. With the same words,
 * the architect labels each file by meaning and the policy's rules route it
 * unchanged. `other` is the policy's own fallback: an unrecognised task goes
 * to the default rule (Opus in every shipped policy).
 *
 * The list is data, not taste: test/spec.test.mjs fails if any task_type in
 * plugin/config/policies/*.yaml or in the pipeline skill's greenfield table is
 * missing here, so the two cannot drift apart.
 */
export const SPEC_KINDS: readonly string[] = Object.freeze([
  "adr_draft",
  "api_client",
  "controller_handler",
  "docstring",
  "dto",
  "entity",
  "env_docs",
  "env_test_fixture",
  "filter",
  "frontend_config",
  "frontend_html",
  "frontend_util",
  "guard",
  "interceptor",
  "migration",
  "module_wiring",
  "prisma_schema",
  "react_component",
  "react_page",
  "readme_section",
  "seed_data",
  "service_method",
  "test_integration",
  "test_unit",
  "other",
]);

/** The pipeline phases a unit can belong to; each maps to one executor stage. */
export const SPEC_PHASES: readonly string[] = Object.freeze(["codegen", "tests", "docs"]);
