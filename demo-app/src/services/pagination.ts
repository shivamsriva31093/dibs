import { clamp } from "../utils/numbers.ts";

export interface Page<T> {
  items: T[];
  page: number;
  perPage: number;
  total: number;
}

// Pages are numbered from 1.
export function paginate<T>(items: T[], page: number, perPage: number): Page<T> {
  const size = clamp(perPage, 1, 100);
  const start = page * size;
  return { items: items.slice(start, start + size), page, perPage: size, total: items.length };
}
