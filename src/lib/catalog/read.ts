/**
 * Pure readers over Catalog payloads. Tolerant on purpose: real submissions
 * carry nulls, empty objects and absent names, and a strict schema would
 * blank the page for records the source considers valid.
 */
import { z } from 'zod';
import type { CatalogField, CatalogFile, CatalogStatus, CatalogSubmission, CatalogTransition } from './types';

const Urls = z.object({ download: z.string().optional(), thumbnail: z.string().optional(), preview: z.string().optional() });
const Media = z.object({
  type: z.string().optional(),
  extension: z.string().optional(),
  originalFileName: z.string().nullish(),
  projectSubmissionMediaId: z.string().optional(),
  urls: Urls.optional(),
});
const File = z.object({
  projectSubmissionFileId: z.string().optional(),
  extension: z.string().optional(),
  originalFileName: z.string().nullish(),
  type: z.string().optional(),
  urls: Urls.optional(),
});
const Person = z.object({ email: z.string().optional(), displayName: z.string().optional(), username: z.string().nullish() });

export const SubmissionPayload = z.object({
  projectId: z.string().optional(),
  projectSubmissionId: z.string().optional(),
  submission: z.record(z.string(), z.unknown()).optional(),
  media: z.array(Media).optional(),
  files: z.array(File).optional(),
  user: Person.nullish(),
  contributor: Person.nullish(),
  workflowState: z
    .object({
      statusId: z.string().nullish(),
      transitions: z
        .array(z.object({ destinationSubmissionStatusId: z.string().optional(), note: z.object({ isRequired: z.boolean().optional() }).nullish() }))
        .optional(),
    })
    .optional(),
});

interface SchemaNode {
  title?: string;
  description?: string;
  type?: string;
  format?: string;
  enum?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
}
const SchemaNodeZ: z.ZodType<SchemaNode> = z.lazy(() =>
  z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    type: z.string().optional(),
    format: z.string().optional(),
    enum: z.array(z.string()).optional(),
    properties: z.record(z.string(), SchemaNodeZ).optional(),
    items: SchemaNodeZ.optional(),
    required: z.array(z.string()).optional(),
  }),
);

export const ProjectPayload = z.object({
  projectId: z.string().optional(),
  name: z.string().optional(),
  formSchema: z.object({ properties: z.record(z.string(), SchemaNodeZ).optional(), required: z.array(z.string()).optional() }).optional(),
  workflow: z
    .object({
      statuses: z
        .array(z.object({ statusId: z.string().optional(), name: z.string().optional(), uiSchema: z.record(z.string(), z.unknown()).optional() }))
        .optional(),
      transitions: z
        .array(
          z.object({
            from: z.string().optional(),
            to: z.string().optional(),
            trigger: z.string().optional(),
            displayName: z.string().optional(),
            notes: z.object({ isRequired: z.boolean().optional() }).nullish(),
          }),
        )
        .optional(),
    })
    .optional(),
});

export type ProjectDeclaration = z.infer<typeof ProjectPayload>;

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
  psd: 'image/vnd.adobe.photoshop',
  svg: 'image/svg+xml',
};

export function mimeForExtension(extension: string): string {
  return MIME[extension.toLowerCase()] ?? 'application/octet-stream';
}

function fileName(original: string | null | undefined, extension: string | undefined): { name: string; extension: string } {
  const safe = (original ?? '').trim().replace(/[/\\\u0000-\u001f\u007f]/g, '_');
  const ext = (extension ?? '').trim().replace(/^\./, '').toLowerCase();
  const fromName = safe.match(/\.([a-z0-9]{1,10})$/i)?.[1]?.toLowerCase() ?? '';
  const finalExt = ext || fromName;
  if (safe === '') return { name: finalExt ? `file.${finalExt}` : 'file', extension: finalExt };
  if (!finalExt || safe.toLowerCase().endsWith(`.${finalExt}`)) return { name: safe, extension: finalExt };
  return { name: `${safe}.${finalExt}`, extension: finalExt };
}

function readFiles(body: z.infer<typeof SubmissionPayload>): CatalogFile[] {
  const out: CatalogFile[] = [];
  const seen = new Set<string>();
  for (const entry of body.files ?? []) {
    const id = entry.projectSubmissionFileId ?? '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const { name, extension } = fileName(entry.originalFileName, entry.extension);
    out.push({
      id,
      name,
      extension,
      mime: mimeForExtension(extension),
      downloadUrl: entry.urls?.download ?? null,
      previewUrl: entry.urls?.preview ?? null,
      thumbnailUrl: entry.urls?.thumbnail ?? null,
    });
  }
  for (const entry of body.media ?? []) {
    const id = entry.projectSubmissionMediaId ?? '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const { name, extension } = fileName(entry.originalFileName, entry.extension);
    out.push({
      id,
      name,
      extension,
      mime: mimeForExtension(extension),
      downloadUrl: entry.urls?.download ?? null,
      previewUrl: entry.urls?.preview ?? null,
      thumbnailUrl: entry.urls?.thumbnail ?? null,
    });
  }
  return out;
}

/** `goldenOutput: [{ goldenFile: <id> }]` — the Catalog's authoritative Golden deliverables. */
export function goldenFileIds(values: Record<string, unknown>): string[] {
  const output = values['goldenOutput'];
  if (!Array.isArray(output)) return [];
  const ids: string[] = [];
  for (const entry of output) {
    const id = entry && typeof entry === 'object' ? (entry as Record<string, unknown>)['goldenFile'] : null;
    if (typeof id === 'string' && id.trim() && !ids.includes(id.trim())) ids.push(id.trim());
  }
  return ids;
}

/** `inputFiles: [{ inputFile: <id>, type?: 'Regular input' | 'Distractor' | 'Style reference' }]`. */
export function inputFileEntries(values: Record<string, unknown>, golden: ReadonlySet<string>): { id: string; role: string | null }[] {
  const out: { id: string; role: string | null }[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown, role: string | null) => {
    if (typeof raw !== 'string') return;
    const id = raw.trim();
    if (!/^[0-9a-f-]{20,}$/i.test(id) || golden.has(id) || seen.has(id)) return;
    seen.add(id);
    out.push({ id, role });
  };
  const inputs = values['inputFiles'];
  if (Array.isArray(inputs)) {
    for (const entry of inputs) {
      if (entry && typeof entry === 'object') {
        const row = entry as Record<string, unknown>;
        const role = typeof row['type'] === 'string' && row['type'].trim() ? row['type'].trim() : null;
        add(row['inputFile'], role);
      } else add(entry, null);
    }
  }
  return out;
}

export function inputFileIds(values: Record<string, unknown>, golden: ReadonlySet<string>): string[] {
  return inputFileEntries(values, golden).map((entry) => entry.id);
}

function hiddenKeys(project: ProjectDeclaration | null, statusId: string | null): Set<string> {
  const hidden = new Set<string>();
  const ui = project?.workflow?.statuses?.find((s) => s.statusId === statusId)?.uiSchema;
  if (!ui) return hidden;
  for (const [key, node] of Object.entries(ui)) {
    if (node && typeof node === 'object' && ((node as Record<string, unknown>)['ui:widget'] === 'hidden' || (node as Record<string, unknown>)['hidden'] === true)) hidden.add(key);
  }
  return hidden;
}

const SKIP_FOR_PROMPT = new Set(['goldenOutput', 'rubrics', 'taskPerformance', 'viewTask', 'inputFiles']);

function flatten(value: unknown, node: SchemaNode | undefined, files: Map<string, CatalogFile>): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const file = files.get(value.trim());
    return file ? `[file: ${file.name}]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((row, index) => {
        const text = flatten(row, node?.items, files);
        return text ? `${index + 1}. ${text}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => {
        const child = node?.properties?.[k];
        const text = flatten(v, child, files);
        return text ? `${child?.title ?? k}: ${text}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function readCatalogSubmission(rawSubmission: unknown, rawProject: unknown): CatalogSubmission | null {
  const parsed = SubmissionPayload.safeParse(rawSubmission);
  if (!parsed.success) return null;
  const body = parsed.data;
  const projectParsed = ProjectPayload.safeParse(rawProject);
  const project = projectParsed.success ? projectParsed.data : null;

  const values = { ...(body.submission ?? {}) };
  const files = readFiles(body);
  const byId = new Map(files.map((f) => [f.id, f]));
  const golden = goldenFileIds(values);
  const goldenSet = new Set(golden);
  const inputs = inputFileEntries(values, goldenSet);
  const statusId = body.workflowState?.statusId ?? null;
  const statuses = new Map((project?.workflow?.statuses ?? []).map((s) => [s.statusId ?? '', s.name ?? null]));
  const hidden = hiddenKeys(project, statusId);
  const properties = project?.formSchema?.properties ?? {};
  const order = [...Object.keys(properties), ...Object.keys(values).filter((k) => !(k in properties))];

  const fields: CatalogField[] = [];
  for (const key of order) {
    if (SKIP_FOR_PROMPT.has(key) || hidden.has(key) || !(key in values)) continue;
    const text = flatten(values[key], properties[key], byId).trim();
    if (!text) continue;
    fields.push({ key, label: properties[key]?.title ?? key, text });
  }

  const titleCandidate = ['title', 'taskTitle', 'name', 'prompt', 'instruction', 'description', 'task'].find(
    (k) => typeof values[k] === 'string' && (values[k] as string).trim(),
  );
  const titled = titleCandidate ? (values[titleCandidate] as string).trim() : fields[0]?.text?.trim() ?? '';
  const title = titled.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 140) ?? '';

  const moves = project?.workflow?.transitions ?? [];
  const transitions: CatalogTransition[] = (body.workflowState?.transitions ?? []).flatMap((t) => {
    const to = t.destinationSubmissionStatusId ?? '';
    if (!to) return [];
    const edge = moves.find((m) => m.from === statusId && m.to === to) ?? moves.find((m) => m.to === to);
    return [
      {
        to,
        toName: statuses.get(to) ?? null,
        trigger: edge?.trigger ?? 'next',
        action: edge?.displayName ?? statuses.get(to) ?? 'Move',
        noteRequired: t.note?.isRequired === true || edge?.notes?.isRequired === true,
      },
    ];
  });

  const author = body.user?.displayName?.trim() || body.user?.username?.trim() || body.user?.email?.trim() || null;

  return {
    id: body.projectSubmissionId ?? '',
    projectId: body.projectId ?? project?.projectId ?? '',
    projectName: project?.name ?? '',
    statusId,
    statusName: statusId ? (statuses.get(statusId) ?? null) : null,
    title,
    values,
    fields,
    files,
    inputFiles: inputs.flatMap((entry) => {
      const file = byId.get(entry.id);
      return file ? [{ ...file, role: entry.role }] : [];
    }),
    goldenFiles: golden.map((id) => byId.get(id)).filter((f): f is CatalogFile => f !== undefined),
    transitions,
    author,
  };
}

/** Watch label first — that is what PMs will set when more projects land. */
export function projectDisplayName(watch: { label?: string | null; project?: unknown } | null | undefined): string {
  const label = watch?.label?.trim();
  if (label) return label;
  const name = readProjectStatuses(watch?.project ?? null)?.name.trim();
  return name || 'Project';
}

export function readProjectStatuses(rawProject: unknown): { name: string; statuses: CatalogStatus[] } | null {
  const parsed = ProjectPayload.safeParse(rawProject);
  if (!parsed.success) return null;
  return {
    name: parsed.data.name ?? '',
    statuses: (parsed.data.workflow?.statuses ?? []).flatMap((s) => (s.statusId ? [{ id: s.statusId, name: s.name ?? null }] : [])),
  };
}

/** Declared rubric item properties, or empty when the schema constrains none. */
export function declaredRubricItemFields(rawProject: unknown): Set<string> {
  const parsed = ProjectPayload.safeParse(rawProject);
  const items = parsed.success ? parsed.data.formSchema?.properties?.['rubrics']?.items?.properties : undefined;
  return new Set(items ? Object.keys(items) : []);
}

export function declaredTopLevelFields(rawProject: unknown): Set<string> {
  const parsed = ProjectPayload.safeParse(rawProject);
  return new Set(parsed.success ? Object.keys(parsed.data.formSchema?.properties ?? {}) : []);
}

export function taskPerformanceDeclaration(rawProject: unknown): { declared: Set<string>; required: string[] } {
  const parsed = ProjectPayload.safeParse(rawProject);
  const node = parsed.success ? parsed.data.formSchema?.properties?.['taskPerformance'] : undefined;
  return { declared: new Set(Object.keys(node?.properties ?? {})), required: node?.required ?? [] };
}
