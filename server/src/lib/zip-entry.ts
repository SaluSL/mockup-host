export type EntryValidation =
  | { ok: true; path: string; kind: "file" | "directory" }
  | { ok: false; reason: string };

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function validateEntryName(rawName: string): EntryValidation {
  if (rawName === "") return { ok: false, reason: "entry name is empty" };
  if (CONTROL_CHARS.test(rawName)) {
    return { ok: false, reason: "entry name contains a control character" };
  }
  if (rawName.includes("\\")) {
    return { ok: false, reason: "entry name contains a backslash" };
  }
  if (rawName.startsWith("/")) {
    return { ok: false, reason: "entry name is an absolute path" };
  }

  const kind: "file" | "directory" = rawName.endsWith("/") ? "directory" : "file";

  // Reject `..` per segment rather than resolving and checking containment:
  // a resolved path can be walked back inside the target through a symlinked
  // intermediate directory, and no legitimate build output needs `..`.
  const parts: string[] = [];
  for (const segment of rawName.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return { ok: false, reason: "entry name contains a traversal segment" };
    parts.push(segment);
  }

  if (parts.length === 0) return { ok: false, reason: "entry name is empty after normalization" };
  return { ok: true, path: parts.join("/"), kind };
}

export function isRegularFileMode(externalFileAttributes: number): boolean {
  const mode = (externalFileAttributes >>> 16) & 0xffff;
  if (mode === 0) return true;
  return (mode & S_IFMT) === S_IFREG;
}
