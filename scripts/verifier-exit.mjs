/**
 * Geography checks print two kinds of findings. Failures must end the process
 * with a nonzero status. Informational lines are context and must not.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function failureExitCode(failures) {
  return failures > 0 ? 1 : 0;
}

/** True when this module is the process entrypoint, false when a test imports it. */
export function invokedDirectly(metaUrl) {
  const entry = process.argv[1];
  if (!entry || !metaUrl) return false;
  return metaUrl === pathToFileURL(resolve(entry)).href;
}
