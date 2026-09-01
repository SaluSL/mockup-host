export type ParsedRange = { start: number; end: number } | "invalid" | null;

export function parseRange(header: string | undefined, size: number): ParsedRange {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  if (size === 0) return "invalid";

  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return "invalid";

  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return "invalid";

  return { start, end };
}
