import { describe, expect, it } from "vitest";
import { cacheControlFor, contentTypeFor, shouldFallbackToIndex } from "../../src/lib/serving.js";

describe("contentTypeFor", () => {
  it.each([
    ["index.html", "text/html; charset=utf-8"],
    ["assets/app.js", "text/javascript; charset=utf-8"],
    ["assets/app.mjs", "text/javascript; charset=utf-8"],
    ["assets/app.css", "text/css; charset=utf-8"],
    ["assets/logo.svg", "image/svg+xml"],
    ["assets/photo.webp", "image/webp"],
    ["assets/font.woff2", "font/woff2"],
    ["data.json", "application/json; charset=utf-8"],
  ])("maps %s", (path, expected) => {
    expect(contentTypeFor(path)).toBe(expected);
  });

  it("falls back to an octet stream for unknown types", () => {
    expect(contentTypeFor("weird.xyz")).toBe("application/octet-stream");
  });
});

describe("cacheControlFor", () => {
  it("never caches html", () => {
    expect(cacheControlFor("index.html")).toBe("no-cache");
    expect(cacheControlFor("nested/page.html")).toBe("no-cache");
  });

  it("caches content-hashed assets immutably", () => {
    expect(cacheControlFor("assets/index-DkT3Bq7x.js")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(cacheControlFor("assets/style-a1b2c3d4.css")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("uses a short cache for unhashed non-html files", () => {
    expect(cacheControlFor("favicon.ico")).toBe("public, max-age=3600");
    expect(cacheControlFor("images/logo.png")).toBe("public, max-age=3600");
  });
});

describe("shouldFallbackToIndex", () => {
  const html = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

  it("falls back for an extensionless navigation", () => {
    expect(shouldFallbackToIndex("settings", html)).toBe(true);
    expect(shouldFallbackToIndex("settings/profile", html)).toBe(true);
  });

  it("falls back for an explicit html path", () => {
    expect(shouldFallbackToIndex("about.html", html)).toBe(true);
  });

  it("does NOT fall back for a missing script", () => {
    expect(shouldFallbackToIndex("assets/app.js", html)).toBe(false);
  });

  it("does NOT fall back when html is not accepted", () => {
    expect(shouldFallbackToIndex("settings", "*/*")).toBe(false);
    expect(shouldFallbackToIndex("settings", null)).toBe(false);
  });

  it("does NOT fall back for an image or stylesheet", () => {
    expect(shouldFallbackToIndex("logo.png", html)).toBe(false);
    expect(shouldFallbackToIndex("app.css", html)).toBe(false);
  });
});
