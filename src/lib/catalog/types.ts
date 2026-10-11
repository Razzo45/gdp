/**
 * The Catalog (Wirestock Data Program) as this platform sees it.
 *
 * Inputs and the Golden output are files the Catalog hosts on S3 behind
 * presigned URLs. We never copy them; we read them when a job needs them.
 */

export interface CatalogFile {
  id: string;
  /** Creator-facing filename, extension included when the Catalog supplied one. */
  name: string;
  extension: string;
  /** Best-effort MIME from extension/type; confirmed when bytes are read. */
  mime: string;
  downloadUrl: string | null;
  previewUrl: string | null;
  thumbnailUrl: string | null;
}

export interface CatalogField {
  key: string;
  label: string;
  /** Flattened text for prompts; file references are rendered as names. */
  text: string;
}

export interface CatalogTransition {
  to: string;
  toName: string | null;
  trigger: string;
  action: string;
  noteRequired: boolean;
}

export interface CatalogSubmission {
  id: string;
  projectId: string;
  projectName: string;
  statusId: string | null;
  statusName: string | null;
  title: string;
  /** Project form values exactly as upstream holds them. */
  values: Record<string, unknown>;
  /** Readable task fields for prompts and the brief panel (hidden fields excluded). */
  fields: CatalogField[];
  files: CatalogFile[];
  inputFiles: CatalogFile[];
  goldenFiles: CatalogFile[];
  transitions: CatalogTransition[];
  author: string | null;
}

export interface CatalogStatus {
  id: string;
  name: string | null;
}
