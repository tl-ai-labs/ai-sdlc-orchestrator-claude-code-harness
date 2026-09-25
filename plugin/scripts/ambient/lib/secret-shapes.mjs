/**
 * Extra secret shapes checked before any text leaves the machine for a worker,
 * on top of plugin/scripts/dispatch-sanitize.mjs. Same philosophy as that
 * file: vendor prefixes and explicit assignments with a very low false-positive
 * rate, never a generic entropy detector. A finding ends the job; nothing is
 * redacted and sent anyway.
 */
import { scan as baseScan } from "../../dispatch-sanitize.mjs";

const EXTRA = [
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ["slack-webhook", /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/g],
  ["stripe-key", /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["pypi-token", /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{30,}\b/g],
  ["sendgrid-key", /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g],
  ["twilio-key", /\bSK[0-9a-fA-F]{32}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["url-with-password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]{1,64}:[^\s:@/]{6,}@[^\s/]+/gi],
  ["azure-storage-key", /AccountKey=[A-Za-z0-9+/=]{60,}/g],
  ["gcp-service-account", /"private_key_id"\s*:\s*"[0-9a-f]{40}"/g],
  ["assigned-secret", /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["'][^"'\s]{12,}["']/gi],
];

/** Returns [{ name, line }]. Never returns the matched text. */
export function scanSecrets(text) {
  const findings = baseScan(text).map((f) => ({ name: f.name ?? f.pattern ?? "secret", line: f.line ?? null }));
  for (const [name, re] of EXTRA) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      findings.push({ name, line: text.slice(0, m.index).split("\n").length });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return findings;
}
