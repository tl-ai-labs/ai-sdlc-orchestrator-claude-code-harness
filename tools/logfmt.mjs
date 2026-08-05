/**
 * logfmt.mjs — the actor gutter.
 *
 * ---- WHY A GUTTER AT ALL ---------------------------------------------------
 * A delegated run's single most misread fact is "who actually wrote the code".
 * The report says it in a header and says it again in a footer, and in between
 * a table scrolls past with no marking at all — so a reader who lands in the
 * middle (which, on a screenshare, is everyone) cannot tell the harness from
 * the worker. These four tags put the answer in a fixed left column on every
 * line that has an actor: skim the left edge and the division of labour reads
 * without parsing a single word, which is the entire point of the connector.
 *
 * Fixed width by construction, so whatever follows stays in one column.
 *
 * ---- PROVENANCE ------------------------------------------------------------
 * This vocabulary is the one used by the harness-matrix logs in the studies
 * console, kept identical on purpose: the same run read in either place should
 * use the same four symbols. Only the vocabulary was carried over. The rest of
 * that module describes a lane-based matrix runner — lock lines, watcher
 * blocks, pre-delegation inspection — none of which exists here, and copying it
 * would have imported concepts this repo cannot honour.
 */

/**
 * The four actors a line can belong to.
 *
 * `driver` and `worker` are the two that carry the argument; `handoff` marks
 * the moment between them, which is the one line a reader should stop on. The
 * arrow is intentionally not an ASCII `->`: at a glance the gutter should read
 * as a picture, not as a token to be parsed.
 */
export const ACTOR = {
  driver: "[C]", // Claude Code — the harness. Plans, gates, integrates. Writes no shipped code.
  worker: "[G]", // Gemini via the Antigravity SDK — an agent in the workspace, with tools.
  handoff: "[C→G]", // the delegation itself: a brief on disk, a subprocess, a working directory.
  script: "[·]", // a scripted step of our own — verify, report. No model call, no cost.
};

/**
 * Left gutter for one line.
 *
 * `delegated: false` collapses it to plain indent, because a run with only one
 * actor has nothing to attribute and a column that never changes is noise. The
 * width matches the widest tag (`[C→G]`) so the columns after it line up
 * whichever tag a line carries.
 */
export const gutter = (tag, delegated = true) => (delegated ? `${String(tag).padEnd(5)} ` : "  ");

/** The gutter's own key, for printing once above a block that uses it. */
export const ACTOR_LEGEND = [
  [ACTOR.driver, "Claude Code — the harness: plans, gates, integrates, writes no shipped code"],
  [ACTOR.handoff, "the handoff — a brief written to disk, then a worker subprocess in the workspace"],
  [ACTOR.worker, "the Antigravity SDK worker — an agent with tools, which writes the code"],
];
