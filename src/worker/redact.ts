/**
 * CREDENTIAL REDACTION. Secrets never reach the database.
 *
 * Any header or query parameter whose NAME looks like a credential has its
 * value replaced with REDACTED in the stored trial input. Reproduction
 * (same run, or a later run of a file target that still holds the secret)
 * restores the real value from the target just before executing.
 *
 * Also: `${ENV_NAME}` references in a target's header values are expanded
 * from the environment at load time, so a committed target file never has
 * to contain a key.
 */
import type { TrialInput } from './http.js';
import type { TargetConfig } from './target.js';

export const REDACTED = '[redacted]';
export const SECRET_HEADER = /^(authorization|cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-token|x-api-token|proxy-authorization)$|token|secret|passw/i;
export const SECRET_PARAM = /^(api[-_]?key|apikey|key|token|access[-_]?token|auth|secret|password|passwd|sig|signature|client[-_]?secret)$/i;

export function isSecretHeader(name: string): boolean {
  return SECRET_HEADER.test(name);
}
export function isSecretParam(name: string): boolean {
  return SECRET_PARAM.test(name);
}

/** A copy of the input with credential VALUES replaced. Pure. */
export function redactInput(input: TrialInput): TrialInput {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k] = v !== '' && isSecretHeader(k) ? REDACTED : v;
  const query: [string, string][] = input.query.map(([k, v]) => [k, v !== '' && isSecretParam(k) ? REDACTED : v]);
  return { ...input, headers, query };
}

/** The secrets a target holds, keyed "header:<name>" / "query:<name>", from its headers and known-good values. */
export function secretsOf(target: TargetConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(target.headers ?? {})) if (isSecretHeader(k)) out[`header:${k.toLowerCase()}`] = v;
  for (const values of [...Object.values(target.baseline ?? {}), ...Object.values(target.optional_values ?? {})]) {
    for (const [k, v] of Object.entries(values)) if (isSecretParam(k)) out[`query:${k}`] = v;
  }
  return out;
}

/**
 * Put real values back into a stored (redacted) input. Redacted values with
 * no matching secret stay redacted: the request will then fail as a bad
 * credential rather than succeed by accident, and the mismatch surfaces in
 * reproduction, which is the honest outcome.
 */
export function restoreInput(input: TrialInput, secrets: Record<string, string>): TrialInput {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k] = v === REDACTED ? (secrets[`header:${k.toLowerCase()}`] ?? v) : v;
  const query: [string, string][] = input.query.map(([k, v]) => [k, v === REDACTED ? (secrets[`query:${k}`] ?? v) : v]);
  return { ...input, headers, query };
}

/**
 * Expand ${ENV} references in target header values and in baseline /
 * optional values (credentials are often query parameters). Unset variables
 * throw: a silent empty credential would be a misleading run.
 */
export function expandEnvInTarget(target: TargetConfig, env: NodeJS.ProcessEnv = process.env): TargetConfig {
  const expand = (where: string, v: string) =>
    v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
      const val = env[name];
      if (val === undefined || val === '') throw new Error(`target ${where} references ${name}, which is not set in the environment`);
      return val;
    });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(target.headers ?? {})) headers[k] = expand(`header "${k}"`, v);
  const mapValues = (m: Record<string, Record<string, string>> | undefined, label: string) => {
    const out: Record<string, Record<string, string>> = {};
    for (const [p, values] of Object.entries(m ?? {})) {
      out[p] = {};
      for (const [k, v] of Object.entries(values)) out[p][k] = expand(`${label} "${k}"`, v);
    }
    return out;
  };
  return { ...target, headers, baseline: mapValues(target.baseline, 'baseline value'), optional_values: mapValues(target.optional_values, 'optional value') };
}
