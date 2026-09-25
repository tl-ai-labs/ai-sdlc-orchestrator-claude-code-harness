/**
 * Strict reading of what a worker returned. The only accepted answer is ONE
 * JSON object with `edits` and/or `creates`. Prose around it, extra keys, the
 * wrong types, or anything oversized ends the job: a worker answer is never
 * "repaired", because a repaired answer is one nobody wrote and nobody checked.
 * The single allowance is a ```json fence around the whole answer, which
 * models add by habit and which carries no content.
 */
const MAX_ANSWER_CHARS = 2_000_000;

export function parseWorkerAnswer(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("answer: empty");
  if (text.length > MAX_ANSWER_CHARS) throw new Error("answer: larger than the limit");
  let body = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(body);
  if (fenced) body = fenced[1];
  let obj;
  try { obj = JSON.parse(body); } catch { throw new Error("answer: not a single JSON object"); }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("answer: not a JSON object");
  const extra = Object.keys(obj).filter((k) => k !== "edits" && k !== "creates");
  if (extra.length) throw new Error(`answer: unexpected key ${extra[0]}`);
  const edits = obj.edits ?? [];
  const creates = obj.creates ?? [];
  if (!Array.isArray(edits) || !Array.isArray(creates)) throw new Error("answer: edits and creates must be lists");
  for (const e of edits) {
    if (!e || typeof e.path !== "string" || typeof e.find !== "string" || typeof e.replace !== "string" || Object.keys(e).length !== 3) throw new Error("answer: an edit must be exactly { path, find, replace }");
  }
  for (const c of creates) {
    if (!c || typeof c.path !== "string" || typeof c.content !== "string" || Object.keys(c).length !== 2) throw new Error("answer: a create must be exactly { path, content }");
  }
  return { edits, creates };
}
