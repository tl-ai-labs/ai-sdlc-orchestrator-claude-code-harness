/**
 * Session memory for the caller-supplied project root.
 *
 * `project_root` is what lets the loader prefer a repo-local
 * `routing-policy.yaml` over the shipped preset, and the policy cache is keyed
 * on it — so a caller that omits it keys differently from one that passed it,
 * misses, and reloads the preset instead. Remembering the first root supplied
 * keeps every later call on the same policy without depending on each call site
 * to pass the argument. One server process serves one project, so the
 * remembered value cannot cross projects.
 */

let remembered: string | undefined;

/** Record `supplied` when present; return the root to resolve with. */
export function resolveProjectRoot(supplied?: string): string | undefined {
  if (supplied) remembered = supplied;
  return supplied ?? remembered;
}

/** Test seam: forget the recorded root between cases. */
export function resetProjectRootMemory(): void {
  remembered = undefined;
}
