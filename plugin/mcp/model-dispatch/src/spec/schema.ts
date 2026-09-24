/**
 * JSON Schemas of the typed build spec, and the small validator that checks a
 * value against them.
 *
 * The spec is handed over in SECTIONS (submit_spec_section): the header first
 * (stack, commands, decisions, shared data model and API), then the units in
 * batches. A section is checked on arrival, so a refusal costs one section,
 * not the whole plan — a single-reply spec on TeamBoard spent about 70% of its
 * cost re-sending (probes/s3-architect-spec in the task folder: reply 1 hit
 * the 64k output ceiling, reply 2 was refused by the schema).
 *
 * Structure does the checking, never word scans or character counts: exports
 * are typed (name / kind / params / returns), every text field is ONE line, a
 * decision holds ONE chosen value with the rejected options kept apart, and
 * references must resolve. No size is bounded (see the note below the imports).
 * No field has a character limit: in step 3 a 160-character
 * cap on `choice` refused four real decisions (168-182 characters) and cost a
 * whole re-send, and a longer line costs only its own tokens.
 *
 * The validator covers exactly the JSON Schema keywords these schemas use
 * (type, required, properties, additionalProperties: false, enum, minLength,
 * maxLength, pattern, items, minItems, maxItems, minimum, maximum). It is
 * written here rather than pulled from a library because the server declares
 * no JSON Schema dependency, and its error messages name the exact path.
 */
/** The pipeline phases a unit can belong to; each maps to one executor stage. */
export const SPEC_PHASES: readonly string[] = Object.freeze(["codegen", "tests", "docs"]);

type Schema = Record<string, any>;

/*
 * No size is bounded by a number taken from our own runs (24 Sep). The file-length cap was
 * 8,192 tokens / (11.7 tokens per line × 1.3) = 538 lines, with the tokens per line measured on
 * Python only; the units-per-call cap was the architect's speed on one brief, sized to a
 * five-minute cache. Now a typist answer cut off at its output limit goes to the typist with the
 * larger limit (executor/run.ts), and the architect keeps a one-hour cache like the orchestrator
 * (agents/architect.md), so neither bound is needed.
 */

/** One line of text: not empty, no line break. */
const line: Schema = { type: "string", minLength: 1, pattern: "^[^\\n\\r]+$" };
const UNIT_ID = { type: "string", pattern: "^U[0-9]{2,4}$" };

export const SPEC_HEADER_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["stack", "commands", "decisions", "shared"],
  properties: {
    stack: { type: "array", items: line, description: "The fixed stack, one short item each (runtime, frameworks, libraries, test tools)." },
    commands: {
      type: "array",
      description: "Commands the checks run, e.g. the back-end and front-end test commands, with the working directory of each.",
      items: { type: "object", additionalProperties: false, required: ["name", "run", "cwd"], properties: { name: line, run: line, cwd: line } },
    },
    decisions: {
      type: "array",
      description: "Every design decision a file writer would otherwise guess. ONE chosen value each; rejected options go in `rejected`, never in `choice`.",
      items: { type: "object", additionalProperties: false, required: ["topic", "choice", "reason"], properties: { topic: line, choice: line, rejected: { type: "array", items: line }, reason: line } },
    },
    shared: {
      type: "object", additionalProperties: false, required: ["conventions", "data_model", "api"],
      description: "What every file writer needs; sent first in every brief.",
      properties: {
        conventions: { type: "array", items: line },
        data_model: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["name", "fields"], properties: {
            name: line,
            fields: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "type"], properties: { name: line, type: line, constraints: line } } },
          } },
        },
        api: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["method", "path", "access", "request", "response", "success_status", "error_statuses"], properties: {
            method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
            path: line, access: line, request: line, response: line,
            success_status: { type: "integer", minimum: 100, maximum: 599 },
            error_statuses: { type: "array", items: { type: "integer", minimum: 400, maximum: 599 } },
          } },
        },
      },
    },
  },
};

export const SPEC_UNIT_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "path", "phase", "import_line", "exports", "behaviour", "depends_on", "style_from", "covers", "tests", "approx_lines"],
  properties: {
    id: UNIT_ID,
    path: { type: "string", pattern: "^[A-Za-z0-9_.][A-Za-z0-9_./-]*$", description: "Relative to the code directory; no leading slash, no '..'." },
    phase: { type: "string", enum: [...SPEC_PHASES] },
    // Optional free text for the design table only (24 Sep): never a list to pick from, never refused, never
    // routed on — who types a file depends on its stage and the policy alone, whatever its language.
    kind: { ...line, description: "Optional: a few words on what kind of file this is, for the design table only." },
    // How other files import this one (24 Sep smoke: "exports app" meant two different things to two typists,
    // and three repair rounds followed). Written by the architect in the project's own language; code only
    // carries it — into this file's brief, every dependent's brief, the shared index and design.md — and never
    // parses it, so no language rule is involved.
    import_line: { type: "string", pattern: "^[^\\n\\r]*$", description: "The exact line another file of this project writes to import this file, in the project's own language, as written by a file at the project root (a file elsewhere adjusts only the relative path). Empty when no other file imports this file." },
    exports: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["name", "params", "returns"], properties: {
        name: { type: "string", pattern: "^[A-Za-z_$][A-Za-z0-9_$]*(\\.[A-Za-z_$][A-Za-z0-9_$]*)*$", description: "The name other files use: a top-level name, or Class.method for a member." },
        kind: { ...line, description: "Optional: function, class, trait, ... — whatever the language calls it." },
        params: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "type"], properties: { name: line, type: line } } },
        returns: line,
      } },
    },
    behaviour: { ...line, description: "One line: what the file does." },
    depends_on: { type: "array", items: UNIT_ID },
    style_from: {
      type: "object", additionalProperties: false, required: ["reason"],
      description: "An EARLIER unit whose style this file copies, with the reason; or no unit and the reason there is none.",
      properties: { unit: UNIT_ID, reason: line },
    },
    covers: { type: "array", items: { type: "string", pattern: "^(FR|NFR|AC)-[0-9]+(\\.[0-9]+)?$" } },
    tests: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["name", "given", "expect"], properties: { name: line, given: line, expect: line } },
    },
    approx_lines: { type: "integer", minimum: 1, description: "The file's estimated length in lines; an estimate for the brief and the design table, not a bound." },
  },
};

export const SPEC_UNITS_SECTION_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["units"],
  properties: { units: { type: "array", minItems: 1, items: SPEC_UNIT_SCHEMA } },
};

/** One problem found by `validate`, with the JSON path it applies to. */
export interface SchemaError {
  path: string;
  message: string;
}

/** Checks `value` against `schema`; returns every problem found (empty = valid). */
export function validate(schema: Schema, value: unknown, path = ""): SchemaError[] {
  const errors: SchemaError[] = [];
  const at = path || "/";
  const t = schema.type;
  if (t === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [{ path: at, message: "must be an object" }];
    const v = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in v)) errors.push({ path: at, message: `is missing required field '${k}'` });
    for (const [k, sub] of Object.entries(v)) {
      const s = schema.properties?.[k];
      if (!s) {
        if (schema.additionalProperties === false) errors.push({ path: `${path}/${k}`, message: "is not an allowed field" });
        continue;
      }
      errors.push(...validate(s, sub, `${path}/${k}`));
    }
    return errors;
  }
  if (t === "array") {
    if (!Array.isArray(value)) return [{ path: at, message: "must be an array" }];
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path: at, message: `must have at least ${schema.minItems} item(s)` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path: at, message: `must have at most ${schema.maxItems} items (has ${value.length})` });
    value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}/${i}`)));
    return errors;
  }
  if (t === "string") {
    if (typeof value !== "string") return [{ path: at, message: "must be a string" }];
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path: at, message: `must not be empty` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path: at, message: `must be at most ${schema.maxLength} characters (has ${value.length})` });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push({ path: at, message: `must match ${schema.pattern}` });
    if (schema.enum !== undefined && !schema.enum.includes(value)) errors.push({ path: at, message: `must be one of: ${schema.enum.join(", ")}` });
    return errors;
  }
  if (t === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) return [{ path: at, message: "must be an integer" }];
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path: at, message: `must be ≥ ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path: at, message: `must be ≤ ${schema.maximum}` });
    return errors;
  }
  throw new Error(`validate: unsupported schema type '${t}' at ${at}`);
}
