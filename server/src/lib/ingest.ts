import { eq } from "drizzle-orm";
import { mockupBasePath } from "@mockups/shared";
import type { Db } from "../db.js";
import { mockups } from "../schema/index.js";
import { detectBasePathWarning } from "./base-path.js";
import { resolveContentRoot } from "./content-root.js";
import { extractZip, type ExtractLimits } from "./extract.js";
import type { Storage } from "./storage.js";

export interface IngestDeps {
  db: Db;
  storage: Storage;
  limits: ExtractLimits;
}

export interface IngestResult {
  fileCount: number;
  sizeBytes: number;
  warning: string | null;
}

/**
 * Everything that can fail happens before commit, so a rejected archive never
 * touches the live directory. The finally clears the staging directory whether
 * the push succeeded (its content root has already moved out) or failed.
 */
export async function ingestZip(
  deps: IngestDeps,
  mockupId: string,
  zipPath: string,
): Promise<IngestResult> {
  const staging = await deps.storage.createStagingDir(mockupId);

  try {
    await extractZip(zipPath, staging, deps.limits);
    const contentRoot = await resolveContentRoot(staging);
    const warning = await detectBasePathWarning(contentRoot, mockupBasePath(mockupId));
    const { fileCount, sizeBytes } = await deps.storage.measure(contentRoot);

    await deps.storage.commit(mockupId, contentRoot);

    deps.db
      .update(mockups)
      .set({
        fileCount,
        sizeBytes,
        basePathWarning: warning,
        lastPushedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(mockups.id, mockupId))
      .run();

    return { fileCount, sizeBytes, warning };
  } finally {
    await deps.storage.discardStaging(staging);
  }
}
