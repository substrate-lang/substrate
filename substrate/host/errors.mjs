// The error codes (compiler/substrate.sub), and errorOf, which gives a JavaScript error its code.
export const errors = {
  missing: 1, unreachable: 2, refused: 3, timeout: 4, invalid: 5, aborted: 6, denied: 7, inUse: 8, other: 9,
  notGranted: 10, exists: 11,
};

const unreachable = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

export function errorOf(e) {
  if (e.name === 'NotGrantedError') return errors.notGranted;
  if (e.name === 'AbortError') return errors.aborted;
  if (e.name === 'NotFoundError') return errors.missing;
  if (e.name === 'NotAllowedError' || e.name === 'SecurityError') return errors.denied;
  if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return errors.missing;
  if (e.code === 'EACCES' || e.code === 'EPERM') return errors.denied;
  if (e.code === 'EEXIST') return errors.exists;
  if (e.code === 'ECONNREFUSED') return errors.refused;
  if (e.code === 'EADDRINUSE') return errors.inUse;
  if (e.code === 'ECONNRESET' || e.code === 'EPIPE') return errors.aborted;
  if (e.code === 'ETIMEDOUT' || e.name === 'TimeoutError') return errors.timeout;
  if (e.code === 'ERR_INVALID_URL' || e.code === 'EINVAL') return errors.invalid;
  if (unreachable.has(e.code)) return errors.unreachable;
  if (e.cause instanceof Error) return errorOf(e.cause);
  return errors.other;
}

// reasonOf gives an error's message followed by its cause's.
export function reasonOf(e) {
  return e.cause instanceof Error ? `${e.message}: ${reasonOf(e.cause)}` : e.message;
}
