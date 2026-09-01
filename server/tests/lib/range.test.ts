import { describe, expect, it } from "vitest";
import { parseRange } from "../../src/lib/range.js";

describe("parseRange", () => {
  it("returns null when no range is requested", () => {
    expect(parseRange(undefined, 1000)).toBeNull();
  });

  it("parses a closed range", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
  });

  it("parses an open-ended range", () => {
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
  });

  it("parses a suffix range", () => {
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("clamps an end beyond the file size", () => {
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("clamps a suffix longer than the file", () => {
    expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("rejects a start beyond the file size", () => {
    expect(parseRange("bytes=2000-", 1000)).toBe("invalid");
  });

  it("rejects an inverted range", () => {
    expect(parseRange("bytes=500-100", 1000)).toBe("invalid");
  });

  it("ignores unsupported units", () => {
    expect(parseRange("items=0-10", 1000)).toBeNull();
  });

  it("ignores multi-range requests rather than mishandling them", () => {
    expect(parseRange("bytes=0-10,20-30", 1000)).toBeNull();
  });

  it("treats a zero-length file as unsatisfiable", () => {
    expect(parseRange("bytes=0-", 0)).toBe("invalid");
  });
});
