/**
 * Zero-touch routing, recognition half: which /mmo: job an ordinary chat
 * message asks for, or none (docs/ambient-mode.md, "Routing").
 *
 * Fixed patterns, no model: the same message and folder always give the same
 * answer. Two signals must agree:
 *   - the message: an instruction whose job verb opens it (after "please",
 *     "can you" and the like). Questions, negations, a bare "fix it", small
 *     edits (a typo, lint, a rename) and two different jobs in one message are
 *     never routed;
 *   - the folder: a new folder can only be greenfield; an existing project can
 *     only be one of the seven brownfield jobs. "Existing" is /mmo:greenfield's
 *     own four signals (plugin/commands/greenfield.md, "Mode-detection guard")
 *     plus any source file of its own (repo-kind.mjs).
 * Precision first: a wrong route starts a pipeline nobody asked for; a missed
 * route leaves the chat to the generic orchestrator. Unsure is no route.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoKind } from "./repo-kind.mjs";

export const ROUTABLE_JOBS = new Set(["greenfield", "docs", "bugfix", "feature-extend", "feature-new", "refactor", "test", "deps"]);

// ─── The folder ─────────────────────────────────────────────────────────

/** Stack manifests at the project root: greenfield.md names package.json, pyproject.toml, go.mod "or another stack manifest". */
const MANIFESTS = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "requirements.txt", "setup.py", "setup.cfg", "Pipfile", "mix.exs", "pubspec.yaml", "Package.swift", "deno.json", "CMakeLists.txt"];

/** "existing" when any of /mmo:greenfield's signals of an existing repo holds, or the folder holds a source file of its own; else "new". */
export function folderKind(dir) {
  const src = join(dir, "src");
  try { if (statSync(src).isDirectory() && readdirSync(src).length > 0) return "existing"; } catch { /* no src */ }
  if (MANIFESTS.some((m) => existsSync(join(dir, m)))) return "existing";
  try { if (readdirSync(dir).some((f) => /\.(csproj|sln)$/i.test(f))) return "existing"; } catch { /* unreadable */ }
  try { if (statSync(join(dir, "README.md")).size > 200) return "existing"; } catch { /* no README */ }
  try {
    const tracked = execFileSync("git", ["ls-files"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"], timeout: 3000, maxBuffer: 1 << 20 }).toString();
    if (tracked.trim()) return "existing";
  } catch { /* not a repository, or git is missing: no signal */ }
  return repoKind(dir) === "brownfield" ? "existing" : "new";
}

// ─── The message ────────────────────────────────────────────────────────

/** Openers that turn a request into an instruction ("can you fix …" is "fix …"); stripped one after another. */
const OPENERS = /^(?:(?:hey|hi|hello|ok|okay|so|now|next|then|alright|right|please|pls|kindly|just|quickly)\b[\s,!.]*|(?:can|could|would|will) (?:you|we)(?: please)?\s+|let'?s\s+|let us\s+|i(?:'d| would) like (?:you )?to\s+|i (?:want|need)(?: you)? to\s+|we (?:want|need) to\s+|go ahead and\s+|help me(?: to)?\s+)/;

/** A message that opens like these asks for information, not a job. */
const INFO_OPENERS = /^(?:how|what|why|where|when|which|who|whose|is|are|was|were|does|do|did|should|shall|will|would|could|can|have|has|explain|tell me|describe|show me|summari[sz]e|list|walk me through|compare)\b/;

/** Words that point back at earlier context; an object made only of these is a follow-up, never a new job. */
const DEICTIC = new Set(["it", "this", "that", "these", "those", "them", "everything", "all", "both", "the", "a", "an", "too", "also", "now", "please", "again", "same", "one", "up", "as", "well", "for", "to", "in", "on", "of"]);

/**
 * A job verb followed at once by one of these is a noun ("fix is in the repo",
 * "fix 2 worked fine"): the message talks about a fix, it does not ask for one.
 */
const AUX = new Set(["is", "was", "are", "were", "be", "been", "being", "has", "have", "had", "did", "does", "do", "should", "would", "could", "will", "can", "might", "must", "shall", "may", "worked", "works", "went", "looks", "looked", "seems", "seemed", "sounds", "sounded", "got", "landed"]);

/** Openers that make a question mark polite: "can you fix the test?" is an instruction, "we need to fix it too?" is not. */
const POLITE = /^(?:(?:hey|hi|hello|ok|okay|so|now|next|then|alright|right|please|pls|kindly|just)\b[\s,!.]*)*(?:can|could|would|will) (?:you|we)\b/;

/**
 * Words that continue earlier work: "also …", "… as well", "… too", "… again".
 * Such a message is a follow-up inside a chat that is already working, never a
 * new job (offline audit, 25 Sep).
 */
const FOLLOW_UP = /^also\b|\bas well\b|\b(?:too|again)$/;

/** Objects too small to be a pipeline job. */
const SMALL_EDIT = /\b(typos?|spelling|grammar|formatting|indentation|whitespace|lint(?:ing)?|linter|prettier|eslint|import order|comments?)\b/;

const ART = "(?:a |an )";
const ADJ = "(?:(?:new|simple|small|basic|minimal|full|complete|tiny|production[- ]ready|full[- ]stack)\\s+)*";
const SOME = "(?:[\\w.+#/-]+\\s+){0,6}?";
const APP_NOUN = "(?:app|application|web ?app|website|site|api|backend|back-end|frontend|front-end|service|microservice|server|cli(?: tool)?|command[- ]line tool|tool|bot|dashboard|project|library|sdk|game|prototype|mvp|platform|system|portal|extension)";
// Parts of a project only. A noun that can also be a whole app (api, service, dashboard, backend …) is unsure in an
// existing project: "build an inventory REST API" there may be a new app in the wrong folder (offline audit, 25 Sep).
const SUBSYSTEM = "(?:module|subsystem|feature|endpoint|page|screen|component|integration|webhooks?|queue|worker|cron job|scheduler|admin panel|pipeline)";
const THING = "(?:endpoint|route|api|module|page|screen|component|service|command|form|model|table|class|cli|report|export|import|view|handler|controller|resolver|query)";
const VERSION = "(?:v?\\d[\\w.]*|latest|the latest(?: versions?)?|their latest versions?)";
const PKG = "[\\w@][\\w@/.-]*";
const DEP_WORDS = "(?:(?:npm |pip |python |node |go |js |javascript )?(?:dependencies|deps|packages|libraries|modules))";

/**
 * Each job: the patterns that open an instruction for it, tried in this order
 * (the most specific first, so "add docstrings to X" is docs, not a feature).
 * `object` is the capture that must hold a real subject (not "it", not a typo).
 */
const JOBS = [
  { job: "deps", re: [
    new RegExp(`^(?:upgrade|bump|update) (?:the |our |all |all the |all our )?${DEP_WORDS}(?<object>.*)$`),
    new RegExp(`^(?:upgrade|bump) (?<object>${PKG})(?: from ${VERSION})? to ${VERSION}\\b.*$`),
    new RegExp(`^(?:update|migrate) (?<object>${PKG})(?: from ${VERSION})? to v?\\d[\\w.]*\\b.*$`),
  ], objectOptional: true },
  { job: "test", re: [
    /^(?:write|add|create|backfill|generate|increase|improve|expand)(?: more| some| missing| the)?(?: unit| integration| e2e| end-to-end| regression| api)? (?:tests?|test cases|test coverage|coverage|specs?)(?: for| of| on| to| in| covering)?(?<object>.*)$/,
  ] },
  { job: "docs", re: [
    /^(?:write|add|create|generate|update|improve)(?: the| a| an| some| missing| inline| better)? (?:api docs|docs|documentation|readme|docstrings|adrs?|architecture decision records?|changelog|jsdoc|javadoc|runbook)\b(?<object>.*)$/,
    /^document (?<object>.+)$/,
  ] },
  { job: "bugfix", re: [
    /^(?:fix|debug|resolve|repair|troubleshoot|diagnose and fix|investigate and fix|find and fix) (?<object>.+)$/,
  ] },
  { job: "refactor", re: [
    /^(?:refactor|restructure|reorgani[sz]e|consolidate|deduplicate|de-?dupe|de-duplicate|decouple|modulari[sz]e) (?<object>.+)$/,
    /^extract (?<object>.+?) (?:into|to|out into) (?:a |an |the |one )?(?:shared |common |separate |new |single )?(?:module|util|utility|utils|helper|library|package|file|class|function|service|component)\b.*$/,
  ] },
  { job: "feature-extend", re: [
    new RegExp(`^(?:add|implement|support) (?<object>.+?) (?:to|in|into) (?:the |our )?(?:existing )?(?:[\\w./?{}:-]+\\s+){0,3}${THING}s?\\b.*$`),
    /^extend (?:the |our )?(?:existing )?(?<object>.+?) (?:to support|to handle|to allow|to accept|with)\b.*$/,
  ] },
  { job: "feature-new", re: [
    new RegExp(`^(?:add|build|create|implement|introduce) ${ART}${ADJ}${SOME}${SUBSYSTEM}\\b(?<object>.*)$`),
  ] },
  { job: "greenfield", re: [
    new RegExp(`^(?:build|create|make|scaffold|generate|develop|write|implement|code|set up|setup|bootstrap|spin up|start) (?:me |us )?${ART}${ADJ}${SOME}${APP_NOUN}\\b(?<object>.*)$`),
  ], objectOptional: true },
];

/** What a job may carry in a second clause without becoming two jobs: its own follow-up. */
const COMPANIONS = {
  bugfix: /^(?:add|write)(?: a| an| the)?(?: regression| unit)? tests?\b/,
  deps: /^(?:fix|patch|adapt|update) (?:whatever|what|anything|everything|all)?(?: that)? ?(?:breaks|broke|fails|failed|changed)\b|^(?:fix|patch|adapt)(?: to)? the (?:breakages?|breaking changes?|fallout)\b/,
};

/** A brief pasted as the message: it opens with a heading naming a brief, spec or requirements. */
const BRIEF_HEADING = /^#{1,3}\s+[^\n]*\b(?:brief|spec|specification|requirements|prd|design doc(?:ument)?)\b/i;

function stripOpeners(s) {
  let prev;
  do { prev = s; s = s.replace(OPENERS, "").trim(); } while (s !== prev);
  return s;
}

function realObject(object) {
  const text = (object ?? "").replace(/[`'"(),.!?;:]/g, " ").toLowerCase();
  if (SMALL_EDIT.test(text)) return { ok: false, why: "a small edit (typo, formatting, lint), not a pipeline job" };
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.some((w) => !DEICTIC.has(w))) return { ok: false, why: "no subject of its own (it / this / that): a follow-up, not a new job" };
  return { ok: true };
}

/** Every job one clause could be asking for, in JOBS order (one entry per job, its first matching pattern). */
function clauseJobs(clause) {
  const found = [];
  for (const spec of JOBS) {
    for (const re of spec.re) {
      const m = re.exec(clause);
      if (!m) continue;
      if (clause.split(/\s+/).slice(1, 3).some((w) => AUX.has(w))) break; // the verb is a noun here
      const object = m.groups?.object ?? "";
      // A colon hands over the subject ("fix this bug: TypeError …"): what follows it is the object.
      const colon = clause.indexOf(":");
      const subject = colon >= 0 ? clause.slice(colon + 1) : object;
      const check = spec.objectOptional && !object.trim() ? { ok: true } : realObject(subject || object);
      found.push({ job: spec.job, check });
      break;
    }
  }
  return found;
}

/**
 * The job a clause asks for in this folder: the first match the folder allows.
 * "Build a small Go service" reads as a new app or a new subsystem; only the
 * folder tells them apart (new folder: greenfield; existing project: feature-new).
 */
function pickJob(found, folder) {
  return found.find((f) => (folder === "new") === (f.job === "greenfield")) ?? null;
}

/**
 * The /mmo: job this message asks for in a folder of this kind ("new" or
 * "existing"), or { job: null, reason } when it asks for none or is unsure.
 * `args` is the one-line job description a brownfield command takes; greenfield takes none.
 */
export function routeMessage(message, folder) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return { job: null, reason: "empty message" };
  if (text.startsWith("/")) return { job: null, reason: "a typed command: Claude Code runs it itself" };
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "";

  if (BRIEF_HEADING.test(firstLine.trim())) {
    return folder === "new"
      ? { job: "greenfield", args: "", reason: "a pasted brief in a new folder" }
      : { job: null, reason: "a brief pasted in an existing project: not sure it is a new build" };
  }

  // The request: the first line, up to the first sentence end ("app.py" and "v1.2" are not sentence ends).
  const lower = firstLine.trim().toLowerCase();
  const sentence = /^(.*?)([.!?])(?:\s|$)/.exec(lower);
  const lead = stripOpeners((sentence ? sentence[1] : lower).trim());
  if (!lead) return { job: null, reason: "no instruction" };
  if (INFO_OPENERS.test(lead)) return { job: null, reason: "a question or a request to explain, not a job" };
  if (sentence?.[2] === "?" && !POLITE.test(lower)) return { job: null, reason: "a question: it ends with a question mark and is not a can-you request" };
  if (FOLLOW_UP.test(lead)) return { job: null, reason: "a follow-up to earlier work (also / as well / too / again), not a new job" };

  const clauses = lead.split(/\s*(?:,\s*and then|,\s*then|,\s*and|;|\s+and then|\s+then|\s+and)\s+/).filter(Boolean);
  const found = clauseJobs(clauses[0]);
  if (!found.length) return { job: null, reason: "no job verb opens the message" };
  const first = pickJob(found, folder);
  if (!first) {
    return folder === "new"
      ? { job: null, reason: `a ${found[0].job} job in a folder with no project` }
      : { job: null, reason: "words of a new build in an existing project: not sure which job" };
  }
  if (!first.check.ok) return { job: null, reason: first.check.why };
  for (const clause of clauses.slice(1)) {
    const other = pickJob(clauseJobs(clause), folder);
    if (!other || other.job === first.job) continue;
    if (COMPANIONS[first.job]?.test(clause)) continue;
    return { job: null, reason: `two jobs in one message (${first.job} and ${other.job})` };
  }

  const greenfield = first.job === "greenfield";
  const args = greenfield ? "" : firstLine.trim().replace(/\s+/g, " ").slice(0, 300);
  return { job: first.job, args, reason: `"${lead.slice(0, 60)}" opens a ${first.job} instruction; the folder agrees` };
}
