export type IngestErrorCode =
  | "invalid_entry"
  | "too_many_files"
  | "too_large"
  | "ratio_exceeded"
  | "no_index_html"
  | "empty_archive";

export class IngestError extends Error {
  constructor(
    message: string,
    readonly code: IngestErrorCode,
  ) {
    super(message);
    this.name = "IngestError";
  }
}
