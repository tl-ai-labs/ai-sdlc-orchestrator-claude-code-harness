/**
 * Actor gutter for the delegated-run report. A fixed 5-char left column lets
 * a reader see who wrote each line without parsing text — the single most
 * misread fact in a delegated run is "who actually wrote the code".
 *
 * Vocabulary is kept identical to the harness-matrix logs in the studies
 * console. Only the vocabulary was carried over.
 */

export const ACTOR = {
  driver: "[C]",    // Claude Code — the harness. Plans, gates, integrates.
  worker: "[G]",    // Gemini via Antigravity SDK — an agent in the workspace.
  handoff: "[C→G]", // The delegation itself: brief + subprocess + workdir.
  script: "[·]",    // A scripted step of our own — verify, report.
};

/**
 * `delegated: false` collapses to plain indent — a run with one actor has
 * nothing to attribute. Width matches the widest tag (`[C→G]`).
 */
export const gutter = (tag, delegated = true) => (delegated ? `${String(tag).padEnd(5)} ` : "  ");

export const ACTOR_LEGEND = [
  [ACTOR.driver, "Claude Code — the harness: plans, gates, integrates, writes no shipped code"],
  [ACTOR.handoff, "the handoff — a brief written to disk, then a worker subprocess in the workspace"],
  [ACTOR.worker, "the Antigravity SDK worker — an agent with tools, which writes the code"],
];
