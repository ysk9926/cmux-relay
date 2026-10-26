import { RelayError } from './errors.mjs';

const HOSTS = ['claude', 'codex'];
export function checkHost(value) {
  if (!HOSTS.includes(value)) throw new RelayError('HOST_INVALID', `host must be claude or codex: ${value}`);
  return value;
}

// Explicit input wins. Never guess from the chosen child or a previous owner.
export function resolveHost(explicit, env = {}) {
  if (explicit !== undefined) return checkHost(explicit);
  if (env.RELAY_HOST !== undefined) return checkHost(env.RELAY_HOST);
  const claude = Boolean(env.CLAUDECODE);
  const codex = Boolean(env.CODEX_THREAD_ID);
  if (claude && codex) throw new RelayError('HOST_AMBIGUOUS', 'both host markers are present; pass --host claude|codex');
  return claude ? 'claude' : codex ? 'codex' : null;
}
