export interface ShareFile {
  id: string;
  name: string;
  mime: string;
  kind: 'input' | 'golden' | 'ai';
}

export interface SharePack {
  submissionId: string;
  title: string;
  task: string;
  fields: { key: string; label: string; text: string }[];
  inputs: ShareFile[];
  golden: ShareFile[];
  aiOutputs: ShareFile[];
  performance: { goldenOutput: string | null; aiOutputHumanEval: string | null; stabilityScores: string | null };
  rubric: { id: string; statement: string; tag: string }[];
}

export function shareFileHref(submissionId: string, fileId: string, token: string): string {
  return `/api/s/${encodeURIComponent(submissionId)}/files/${encodeURIComponent(fileId)}?t=${encodeURIComponent(token)}`;
}
