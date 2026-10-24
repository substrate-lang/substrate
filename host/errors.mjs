// The value of a failed event, and the one a JavaScript error gets.
export const errors = {
  missing: 1, unreachable: 2, refused: 3, timeout: 4, invalid: 5, aborted: 6, denied: 7, inUse: 8,
};

export function errorOf(e) {
  if (e.name === 'AbortError') return errors.aborted;
  if (e.name === 'NotFoundError') return errors.missing;
  if (e.name === 'NotAllowedError' || e.name === 'SecurityError') return errors.denied;
  if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return errors.missing;
  if (e.code === 'EACCES' || e.code === 'EPERM') return errors.denied;
  if (e.code === 'ECONNREFUSED') return errors.refused;
  if (e.code === 'EADDRINUSE') return errors.inUse;
  if (e.code === 'ECONNRESET' || e.code === 'EPIPE') return errors.aborted;
  if (e.code === 'ETIMEDOUT' || e.name === 'TimeoutError') return errors.timeout;
  if (e.code === 'ERR_INVALID_URL' || e.code === 'EINVAL' || /URL/.test(e.message)) return errors.invalid;
  if (e.cause instanceof Error) return errorOf(e.cause);
  return errors.unreachable;
}

// The message, and its cause's.
export function reasonOf(e) {
  return e.cause instanceof Error ? `${e.message}: ${reasonOf(e.cause)}` : e.message;
}
