export const MOCKUP_PATH_PREFIX = "/m";
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") throw new Error(`"${input}" cannot be slugified`);
  return slug;
}

export function mockupBasePath(id: string): string {
  return `${MOCKUP_PATH_PREFIX}/${id}/`;
}

export function mockupUrl(origin: string, id: string): string {
  return `${origin.replace(/\/+$/, "")}${MOCKUP_PATH_PREFIX}/${id}`;
}

export interface MockupSummary {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  lastPushedAt: string | null;
  sizeBytes: number;
  fileCount: number;
  basePathWarning: string | null;
}

export interface ResolveMockupRequest {
  slug: string;
  name?: string;
}

export interface ResolveMockupResponse {
  mockup: MockupSummary;
  basePath: string;
  url: string;
}

export interface PushResponse {
  mockup: MockupSummary;
  url: string;
  warning: string | null;
}

export interface ErrorResponse {
  error: string;
}
