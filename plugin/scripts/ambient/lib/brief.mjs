/**
 * Builds the text a worker is sent, for each job kind. Code builds it; the
 * thinker only supplies the small decided parts (an analysis, specs, one
 * example edit). File content always comes from the snapshot reader, which has
 * already refused symlinks, secret files and secret shapes.
 *
 * The thinker-written parts are validated here, because a vague hand-over is
 * where delegated work goes wrong:
 *   - the bug-fix analysis must carry all nine fields of the measured flow;
 *   - it must DECIDE: wording that leaves a fork open ("either ... or", "not
 *     sure", "TBD") is refused, since the worker would be doing the diagnosis;
 *   - it must not DICTATE: an analysis that already contains the code of the
 *     fix saves nothing and is refused, the thinker should make that edit itself.
 */
import { safeRelPath } from "./deny-paths.mjs";
import { scanSecrets } from "./secret-shapes.mjs";

/** The command that runs the tests, when the thinker named one: the landing step can then run it in the same turn. */
function optionalCommand(value) {
  return typeof value === "string" && value.trim().length >= 3 && value.length <= 400 ? value.trim() : null;
}

export const ANALYSIS_KEYS = ["bug_files", "test_command", "root_cause", "fix_approach", "ruled_out", "change_sites", "constraints", "read_set", "new_identifiers"];
// A fenced block in a field that is supposed to DESCRIBE the work: the thinker has
// already written the code, so handing it over saves nothing (the bug-fix gate has
// judged `fix_approach` this way since the start; creates now use the same detector).
const FENCE = /```[\s\S]*?```/;
// More than this from one file is a module the design should have split, not one file to write.
const MAX_EXPORTS = 20;
const OPEN_FORK = /\b(either\b[^.]{0,80}\bor\b|not sure|unsure|unclear|tbd|to be determined|might be|may be the cause|possibly|i think|probably)\b/i;

// The EDIT jobs' footer (a bug fix, one edit repeated across files): every rule in it
// is about editing files that already exist.
const ANSWER_FORMAT =
  'Answer with ONE JSON object and nothing else: {"edits":[{"path":"...","find":"...","replace":"..."}],"creates":[{"path":"...","content":"..."}]}.\n' +
  "Rules: touch only the files listed as changeable. Each `find` must be copied exactly from the file shown and must occur exactly once in it. " +
  "Do not rename, delete or move files. Do not change tests, lockfiles or configuration. No prose, no markdown.";
// The CREATE jobs' footer (new files from specs, test files from cases). Until 23 Sep
// these jobs carried the edit footer, which lists no changeable files for a create and
// forbids configuration, the very thing a scaffold job commissions. Gemini Flash obeyed
// it and answered {"edits":[]} six times in one chat while Sonnet wrote the files. The
// footer now describes the job: every file above comes back, in full, under creates.
const CREATE_ANSWER_FORMAT =
  'Answer with ONE JSON object and nothing else: {"creates":[{"path":"...","content":"..."}]}.\n' +
  "Rules: every file listed above comes back under `creates` with its full content, exactly the paths given, nothing else. " +
  "Files shown as read only are context, not output. No edits, no prose, no markdown.";

function list(name, value, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min) throw new Error(`brief: ${name} must be a list` + (min ? ` with at least ${min} item` : ""));
  return value;
}

function paths(name, value, opts) {
  return list(name, value, opts).map((p) => {
    const rel = safeRelPath(p);
    if (!rel) throw new Error(`brief: ${name} holds an unsafe path`);
    return rel;
  });
}

function text(name, value, minChars = 1) {
  if (typeof value !== "string" || value.trim().length < minChars) throw new Error(`brief: ${name} must be text of at least ${minChars} characters`);
  return value.trim();
}

function noSecrets(label, value) {
  const found = scanSecrets(value);
  if (found.length) throw new Error(`brief: ${label} holds a secret shape (${found[0].name}); job ended`);
}

/** Validates the nine-field analysis. Returns it normalised, or throws with the first problem. */
export function validateAnalysis(a) {
  if (!a || typeof a !== "object") throw new Error("brief: analysis must be an object");
  const missing = ANALYSIS_KEYS.filter((k) => !(k in a));
  if (missing.length) throw new Error(`brief: analysis is missing ${missing.join(", ")}`);
  const out = {
    bug_files: paths("bug_files", a.bug_files, { min: 1 }),
    test_command: text("test_command", a.test_command, 3),
    root_cause: text("root_cause", a.root_cause, 40),
    fix_approach: text("fix_approach", a.fix_approach, 40),
    ruled_out: list("ruled_out", a.ruled_out).map(String),
    change_sites: list("change_sites", a.change_sites, { min: 1 }).map((c) => ({ path: paths("change_sites.path", [c?.path])[0], what: text("change_sites.what", c?.what, 5) })),
    constraints: list("constraints", a.constraints).map(String),
    read_set: paths("read_set", a.read_set),
    new_identifiers: list("new_identifiers", a.new_identifiers).map(String),
  };
  for (const field of ["root_cause", "fix_approach"]) {
    const m = OPEN_FORK.exec(out[field]);
    if (m) throw new Error(`brief: ${field} leaves a decision open ("${m[0]}"). Decide it, then hand the fix over`);
  }
  const fence = /```[\s\S]*?```/g;
  const dictated = [...out.fix_approach.matchAll(fence)].reduce((n, m) => n + m[0].split("\n").length, 0);
  if (dictated > 12) throw new Error("brief: fix_approach already contains the code of the fix; make that edit yourself, nothing is saved by handing it over");
  if (!out.change_sites.every((c) => out.bug_files.includes(c.path))) throw new Error("brief: every change site must be one of bug_files");
  return out;
}

function fileBlock(f) {
  return `=== FILE ${f.path} ===\n${f.content}\n=== END ${f.path} ===`;
}

/**
 * Each builder returns { declared, show, protectedPaths, testCommand, render(files) }:
 *   declared        files the change may touch
 *   show            files to read from the snapshot and put in the brief
 *   protectedPaths  files the change may never touch (the reproduce test)
 */
export const BUILDERS = {
  fix_from_analysis(args) {
    const a = validateAnalysis(args.analysis);
    const repro = paths("repro_files", args.repro_files ?? [], {});
    const heldOut = new Set(paths("held_out_files", args.held_out_files ?? [], {}));
    noSecrets("the analysis", JSON.stringify(a));
    const show = [...new Set([...a.bug_files, ...a.read_set, ...repro])].filter((p) => !heldOut.has(p));
    return {
      // A bug fix declares the REPRO command, which by contract FAILS on the untouched
      // tree — that failure is the bug. So a failing run here is never the harness's fault.
      declared: a.bug_files, baselineShouldPass: false, show, protectedPaths: [...repro, ...heldOut], testCommand: a.test_command,
      render: (files) => [
        "You are writing the code of a bug fix. The diagnosis is done and is not yours to revisit.",
        `ROOT CAUSE: ${a.root_cause}`, `FIX APPROACH: ${a.fix_approach}`,
        "CHANGE SITES:\n" + a.change_sites.map((c) => `- ${c.path}: ${c.what}`).join("\n"),
        a.ruled_out.length ? "ALREADY RULED OUT:\n" + a.ruled_out.map((r) => `- ${r}`).join("\n") : "",
        a.constraints.length ? "CONSTRAINTS:\n" + a.constraints.map((r) => `- ${r}`).join("\n") : "",
        a.new_identifiers.length ? "NEW NAMES TO USE: " + a.new_identifiers.join(", ") : "",
        `THE FAILING TEST IS RUN WITH: ${a.test_command}`,
        "CHANGEABLE FILES: " + a.bug_files.join(", "),
        ...files.map(fileBlock), ANSWER_FORMAT,
      ].filter(Boolean).join("\n\n"),
    };
  },

  repeat_edit_across_files(args) {
    const files = paths("files", args.files, { min: 2 });
    const ex = args.example ?? {};
    const example = { path: paths("example.path", [ex.path])[0], find: text("example.find", ex.find), replace: typeof ex.replace === "string" ? ex.replace : (() => { throw new Error("brief: example.replace must be text"); })() };
    const instruction = text("instruction", args.instruction, 10);
    noSecrets("the instruction", instruction + example.find + example.replace);
    return {
      // The same edit in more files: the suite is expected to pass before and after.
      declared: files, baselineShouldPass: true, show: files, protectedPaths: [], testCommand: optionalCommand(args.test_command),
      render: (shown) => [
        "Apply ONE already-decided edit to each file below. Do not improve, reformat or fix anything else.",
        `THE EDIT, IN WORDS: ${instruction}`,
        `THE SAME EDIT AS ALREADY MADE IN ${example.path}:\nBEFORE:\n${example.find}\nAFTER:\n${example.replace}`,
        "If a file does not need the edit, leave it out of your answer.",
        "CHANGEABLE FILES: " + files.join(", "), ...shown.map(fileBlock), ANSWER_FORMAT,
      ].join("\n\n"),
    };
  },

  write_files_from_specs(args) {
    // v2's contract (a record written once, a gate that rejects code and open decisions) and
    // The pipeline's 0.7.4 change 4 (the architect writes a SPEC, not the program), brought to create jobs.
    // Pair 11, 23 Sep: with a free-prose "spec" of any length, Opus restated the architecture
    // inside all seven hand-overs — 124,500 chars of specs for 185,175 chars of files. The
    // design now lives in ONE file on disk, which the harness inlines once as read-only, so
    // it is written once and reaches the worker as cheap INPUT instead of dear thinker output
    // repeated per file. Per file the thinker writes only what the design cannot say: the
    // exported names, one behaviour line, and a file whose style to copy.
    // No length cap here on purpose: the cost rule at the door judges whether the specs are
    // small enough to pay for the files they describe (`specChars` below), which a fixed
    // number cannot do — a long behaviour earns its place when the file is long enough.
    const designFile = paths("design_file", [args.design_file])[0];
    const specs = list("specs", args.specs, { min: 1 }).map((s) => ({
      path: paths("specs[].path", [s?.path])[0],
      exports: list("specs[].exports", s?.exports ?? []).map((x) => text("specs[].exports[]", x, 1)),
      behaviour: text("specs[].behaviour", s?.behaviour, 20),
      mirror: s?.mirror == null || s.mirror === "" ? null : paths("specs[].mirror", [s.mirror])[0],
    }));
    for (const s of specs) {
      const open = OPEN_FORK.exec(s.behaviour);
      if (open) throw new Error(`brief: ${s.path} leaves a decision open ("${open[0]}"). Decide it, then hand the file over`);
      if (FENCE.test(s.behaviour)) throw new Error(`brief: ${s.path} already contains the code of the file; write that one yourself, or put the detail in ${designFile}`);
      if (s.exports.length > MAX_EXPORTS) throw new Error(`brief: ${s.path} names ${s.exports.length} exports; more than ${MAX_EXPORTS} is a module the design should split`);
    }
    const context = paths("context_files", args.context_files ?? [], {});
    const mirrors = [...new Set(specs.map((s) => s.mirror).filter(Boolean))];
    const show = [...new Set([designFile, ...mirrors, ...context])];
    noSecrets("the specs", JSON.stringify(specs));
    const entry = (s) => [`${s.path}`, s.exports.length ? `  EXPORTS: ${s.exports.join(", ")}` : null,
      `  BEHAVIOUR: ${s.behaviour}`, s.mirror ? `  MIRROR: ${s.mirror}` : null].filter(Boolean).join("\n");
    return {
      // Every declared path is a file the thinker commissioned, so every one must come back (checkChange `commissioned`).
      // New files: the project is expected to be green before them and green after.
      declared: specs.map((s) => s.path), commissioned: true, baselineShouldPass: true,
      // What the THINKER wrote for this hand-over, which is what the cost rule weighs: the entries
      // only. The design is written once and reused, and the inlined files are read off disk.
      specChars: JSON.stringify(specs).length,
      show, protectedPaths: show, testCommand: optionalCommand(args.test_command),
      designFile,
      render: (shown) => {
        const design = shown.find((f) => f.path === designFile);
        const rest = shown.filter((f) => f.path !== designFile);
        return [
          "Write each NEW file listed below, in full, following the design and the conventions in the files shown. Every file goes under `creates`.",
          design ? `=== DESIGN (read only) ===\n${design.content}` : "",
          "=== FILES TO WRITE ===", specs.map(entry).join("\n\n"),
          rest.length ? "FILES TO FOLLOW FOR STYLE (read only, do not change):" : "", ...rest.map(fileBlock), CREATE_ANSWER_FORMAT,
        ].filter(Boolean).join("\n\n");
      },
    };
  },

  // Every test file of a phase in ONE call (build spec v1.2, row 6): one hand-over for all of them
  // clears the break-even where one file per call never did (pair 7, 23 Sep: fourteen one-file jobs).
  write_tests_from_cases(args) {
    const tests = list("tests", args.tests, { min: 1 }).map((t) => ({
      path: paths("tests[].path", [t?.path])[0],
      cases: list("tests[].cases", t?.cases, { min: 1 }).map((c) => text("tests[].cases[]", c, 8)),
    }));
    const target = paths("target_files", args.target_files, { min: 1 });
    noSecrets("the cases", tests.flatMap((t) => t.cases).join("\n"));
    return {
      // One list of cases per file: every declared test file was commissioned and must come back.
      // New test files: the suite is expected to pass before them (they do not exist yet) and after.
      declared: tests.map((t) => t.path), commissioned: true, baselineShouldPass: true, show: [...new Set([...target, ...(paths("context_files", args.context_files ?? [], {}))])], protectedPaths: target, testCommand: optionalCommand(args.test_command),
      render: (shown) => [
        `Write ${tests.length === 1 ? "the test file" : `these ${tests.length} test files`} for the code shown. One test per case; assert behaviour, not implementation. Every file goes under \`creates\`.`,
        ...tests.map((t) => `Write tests in ${t.path}.\nCASES:\n${t.cases.map((c, i) => `${i + 1}. ${c}`).join("\n")}`),
        args.test_command ? `TESTS ARE RUN WITH: ${text("test_command", args.test_command, 3)}` : "",
        "CODE UNDER TEST (read only, do not change):", ...shown.map(fileBlock), CREATE_ANSWER_FORMAT,
      ].filter(Boolean).join("\n\n"),
    };
  },
};

export const JOB_OF_TOOL = { fix_from_analysis: "bugfix_code", repeat_edit_across_files: "repeat_edit", write_files_from_specs: "boilerplate", write_tests_from_cases: "tests", scout_repo: "scout" };
