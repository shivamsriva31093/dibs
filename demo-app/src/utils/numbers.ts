// Keeps a value between a lower and an upper bound, both included.
export function clamp(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper - 1);
}
