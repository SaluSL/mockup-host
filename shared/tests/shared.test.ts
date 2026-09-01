import { describe, expect, it } from "vitest";
import { SLUG_PATTERN, mockupBasePath, mockupUrl, slugify } from "../src/index.js";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("My Client Mockup")).toBe("my-client-mockup");
  });

  it("strips punctuation and collapses separators", () => {
    expect(slugify("Acme — v2.1 (final!!)")).toBe("acme-v2-1-final");
  });

  it("trims leading and trailing separators", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  it("produces slugs matching SLUG_PATTERN", () => {
    expect(SLUG_PATTERN.test(slugify("Foo Bar 42"))).toBe(true);
  });

  it("throws when nothing usable remains", () => {
    expect(() => slugify("!!!")).toThrow(/cannot be slugified/);
  });
});

describe("mockup paths", () => {
  it("builds a trailing-slash base path", () => {
    expect(mockupBasePath("abc-123")).toBe("/m/abc-123/");
  });

  it("builds a share url without a trailing slash", () => {
    expect(mockupUrl("https://mockups.example.com", "abc-123")).toBe(
      "https://mockups.example.com/m/abc-123",
    );
  });

  it("does not double a slash from the origin", () => {
    expect(mockupUrl("https://mockups.example.com/", "abc-123")).toBe(
      "https://mockups.example.com/m/abc-123",
    );
  });
});
