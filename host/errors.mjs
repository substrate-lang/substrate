// The value of a failed event, and the one a JavaScript error gets.
export const errors = { missing: 1, unreachable: 2, refused: 3, timeout: 4, invalid: 5, aborted: 6 };

export function errorOf(e) {
  if (e.name === 'AbortError') return errors.aborted;
  if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return errors.missing;
  if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'ECONNREFUSED') return errors.refused;
  if (e.code === 'ETIMEDOUT' || e.name === 'TimeoutError') return errors.timeout;
  if (e.code === 'ERR_INVALID_URL' || e.code === 'EINVAL' || /URL/.test(e.message)) return errors.invalid;
  return errors.unreachable;
}
