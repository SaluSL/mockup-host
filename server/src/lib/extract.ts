import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { IngestError } from "./errors.js";
import { isRegularFileMode, validateEntryName } from "./zip-entry.js";

export interface ExtractLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxRatio: number;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxFiles: 20000,
  maxTotalBytes: 1_073_741_824,
  maxRatio: 100,
};

/**
 * yauzl validates entry names itself and emits a plain Error for traversal or
 * absolute paths before our own validator sees them. That is a welcome second
 * layer, but callers distinguish rejections by IngestError code, so its name
 * errors are translated rather than left to surface as generic failures.
 */
function asIngestError(error: unknown): unknown {
  if (error instanceof IngestError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid relative path|invalid characters|absolute path|invalid comment/i.test(message)) {
    return new IngestError(`Rejected archive entry: ${message}`, "invalid_entry");
  }
  return error;
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) reject(err ?? new Error("could not open archive"));
      else resolve(zip);
    });
  });
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) reject(err ?? new Error("could not read entry"));
      else resolve(stream);
    });
  });
}

/** Counts bytes as they pass and aborts the moment a cap is crossed. */
function guard(check: (bytesSoFar: number) => void): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      try {
        check(seen);
      } catch (error) {
        cb(error as Error);
        return;
      }
      cb(null, chunk);
    },
  });
}

export async function extractZip(
  zipPath: string,
  destDir: string,
  limits: ExtractLimits,
): Promise<{ fileCount: number; totalBytes: number }> {
  const compressedBytes = (await stat(zipPath)).size;
  const ratioCap = compressedBytes * limits.maxRatio;
  const zip = await openZip(zipPath);

  let fileCount = 0;
  let totalBytes = 0;

  await mkdir(destDir, { recursive: true });

  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", (error: unknown) => reject(asIngestError(error)));
      zip.on("end", resolve);
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          try {
            const validation = validateEntryName(entry.fileName);
            if (!validation.ok) {
              throw new IngestError(
                `Rejected archive entry "${entry.fileName}": ${validation.reason}`,
                "invalid_entry",
              );
            }

            if (validation.kind === "directory") {
              await mkdir(join(destDir, validation.path), { recursive: true });
              zip.readEntry();
              return;
            }

            if (!isRegularFileMode(entry.externalFileAttributes)) {
              throw new IngestError(
                `Rejected archive entry "${entry.fileName}": not a regular file`,
                "invalid_entry",
              );
            }

            fileCount += 1;
            if (fileCount > limits.maxFiles) {
              throw new IngestError(
                `Archive contains more than ${limits.maxFiles} files`,
                "too_many_files",
              );
            }

            const target = join(destDir, validation.path);
            await mkdir(dirname(target), { recursive: true });

            const startedAt = totalBytes;
            const source = await openEntryStream(zip, entry);
            await pipeline(
              source,
              guard((bytesSoFar) => {
                const running = startedAt + bytesSoFar;
                if (running > limits.maxTotalBytes) {
                  throw new IngestError(
                    `Archive expands beyond ${limits.maxTotalBytes} bytes`,
                    "too_large",
                  );
                }
                if (running > ratioCap) {
                  throw new IngestError(
                    `Archive compression ratio exceeds ${limits.maxRatio}:1`,
                    "ratio_exceeded",
                  );
                }
              }),
              createWriteStream(target),
            );
            totalBytes = startedAt + (await stat(target)).size;

            zip.readEntry();
          } catch (error) {
            zip.close();
            reject(asIngestError(error));
          }
        })();
      });

      zip.readEntry();
    });
  } finally {
    zip.close();
  }

  if (fileCount === 0) {
    throw new IngestError("Archive contains no files", "empty_archive");
  }

  return { fileCount, totalBytes };
}
