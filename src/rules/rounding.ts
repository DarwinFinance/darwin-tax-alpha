// HAND-PORTED (see CHANGES-FROM-UPSTREAM.md). Upstream: packages/domain/src/rounding.ts `truncTo`, `stripFloatNoise`.
//
// The published rules only call `truncTo(value)` with the default 0 decimal places, which upstream computes
// as `Math.trunc(stripFloatNoise(value, 0))`. The decimal-places branch (dp > 0) formats through a shared
// Intl number-format engine that is not part of this repository, so it is refused here rather than copied.

const SIGNIFICANT_DIGITS = 15;

export function stripFloatNoise(value: number, dp: number): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  const intDigits = Math.max(1, Math.floor(Math.log10(Math.abs(value))) + 1);
  if (intDigits + dp >= SIGNIFICANT_DIGITS) return value;
  return Number(value.toPrecision(SIGNIFICANT_DIGITS));
}

export function truncTo(value: number, dp = 0): number {
  if (!Number.isFinite(value)) return value;
  if (dp === 0) return Math.trunc(stripFloatNoise(value, 0));
  throw new Error("truncTo: only dp = 0 is published (see CHANGES-FROM-UPSTREAM.md)");
}
