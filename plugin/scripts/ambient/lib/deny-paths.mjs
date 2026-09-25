/**
 * Paths a worker may never be shown, and paths a worker's change may never
 * touch. Two separate lists because the risks differ: the first keeps secrets
 * on the machine, the second keeps a worker from changing the rules it is
 * judged by (test config, lockfiles, CI, agent instructions, the policy).
 */

/** Never read into a brief. Matched against the repo-relative path, any depth. */
export const SECRET_FILE_PATTERNS = [
  /(^|\/)\.env(\..*)?$/i, /(^|\/)\.envrc$/, /(^|\/)\.netrc$/, /(^|\/)\.npmrc$/, /(^|\/)\.pypirc$/,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)(credentials|secrets?)(\.[a-z0-9]+)?$/i, /(^|\/)service[-_]?account.*\.json$/i,
  /(^|\/)\.aws\//, /(^|\/)\.ssh\//, /(^|\/)\.gnupg\//, /(^|\/)\.docker\/config\.json$/, /(^|\/)terraform\.tfstate/,
];

/** Never changed by a worker job, whatever the declared file list says. */
export const HARD_DENY_PATTERNS = [
  /(^|\/)\.git\//, /(^|\/)\.claude\//, /(^|\/)CLAUDE\.md$/, /(^|\/)AGENTS\.md$/, /(^|\/)\.github\//, /(^|\/)\.husky\//,
  /(^|\/)\.envrc$/, /(^|\/)\.env(\..*)?$/i, /(^|\/)\.mcp\.json$/, /(^|\/)\.sdlc\//, /(^|\/)\.vscode\//, /(^|\/)\.idea\//,
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/,
  /(^|\/)(jest|vitest|playwright|karma|cypress|wdio)\.config\.[cm]?[jt]s$/, /(^|\/)\.mocharc(\.[a-z]+)?$/,
  /(^|\/)(pytest\.ini|tox\.ini|conftest\.py|setup\.cfg|noxfile\.py)$/, /(^|\/)\.gitlab-ci\.yml$/, /(^|\/)Jenkinsfile$/,
];

export function isSecretFile(rel) {
  return SECRET_FILE_PATTERNS.some((re) => re.test(rel));
}

export function isHardDenied(rel) {
  return HARD_DENY_PATTERNS.some((re) => re.test(rel));
}

/**
 * A repo-relative path that is safe to join: no absolute path, no `..`, no
 * empty or dot segments, no backslashes, no control characters.
 */
export function safeRelPath(p) {
  if (typeof p !== "string" || !p || p.length > 400 || p.startsWith("/") || /[\\\x00-\x1f]/.test(p)) return null;
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) return null;
  return parts.join("/");
}

/** Same small glob dialect the write-contract hook uses: `**`, `*`, `?`. */
export function globToRegExp(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\x00")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\x00/g, ".*");
  return new RegExp("^" + re + "$");
}
