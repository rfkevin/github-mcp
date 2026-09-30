export function add(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    throw new TypeError('Two finite numbers are required');
  }
  return left + right;
}
