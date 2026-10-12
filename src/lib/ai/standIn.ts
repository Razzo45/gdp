import type { z } from 'zod';
import type { MediaPart } from './gemini';

/**
 * Deterministic stand-in for a Gemini JSON call. Used when GEMINI_MOCK=1
 * and the live send comes back free-tier 429 — the request already left;
 * we do not wait for a model body.
 */

export function flattenParts(parts: (string | MediaPart)[]): string {
  return parts
    .map((part) => (typeof part === 'string' ? part : `ATTACHED:${part.label} ${part.kind} ${part.mime}`))
    .join('\n');
}

/** Golden always Yes. AI output: ~30% Yes, stable across stability passes. */
export function mockGradeYes(statementId: string, againstAiOutput: boolean): boolean {
  if (!againstAiOutput) return true;
  let hash = 0;
  for (const char of statementId) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return hash % 10 < 3;
}

function idsIn(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1]!).filter((id, i, all) => all.indexOf(id) === i);
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'check';
}

function mockBank(text: string): unknown {
  const wanted = Number(text.match(/UP TO (\d+) rows/i)?.[1] ?? text.match(/aim for (\d+)/i)?.[1] ?? 3);
  const n = Math.min(8, Math.max(3, wanted || 3));
  const theme = text.match(/theme:\s*(.+)/i)?.[1]?.trim() || 'brief';
  const seed = slug(text.match(/seed_id:\s*(\S+)/i)?.[1] ?? theme);
  const rows = [
    { tag: 'Format/File', claim: 'file-type', statement: `The deliverable is a single PPTX file for the ${theme} ${seed} check.` },
    { tag: 'Content - Semantics', claim: 'states-finding', statement: `The deck states the ${theme} finding required by the ${seed} check.` },
    { tag: 'Visual - Layout', claim: 'title-band', statement: `Each ${theme} slide keeps a clear title band for the ${seed} check.` },
    { tag: 'Format/File', claim: 'count', statement: `The ${theme} pack contains the required slide count for the ${seed} check.` },
    { tag: 'Visual - Branding', claim: 'footer', statement: `The ${theme} footer matches the required confidential line for the ${seed} check.` },
    { tag: 'Content - Exact', claim: 'named-title', statement: `The title slide names the ${theme} review for the ${seed} check.` },
    { tag: 'Visual - Consistency', claim: 'type-lock', statement: `Body type is locked across ${theme} slides for the ${seed} check.` },
    { tag: 'Format/File', claim: 'widescreen', statement: `The ${theme} deck uses a 16:9 page size for the ${seed} check.` },
  ].slice(0, n);
  return {
    rows: rows.map((row) => ({
      claim_key: `${seed}-${row.claim}`,
      statement: row.statement,
      tag: row.tag,
      notes: 'mock stand-in after 429',
    })),
  };
}

function mockVerdicts(text: string): unknown {
  const ids = idsIn(text, /\[([0-9a-f-]{36})\]/gi);
  const deliverable = text.match(/(?:CONSIDERED_OUTPUTS|DELIVERABLE_FILES_PRESENT)[^\n:]*:\s*(.+)/)?.[1] ?? '';
  const againstAi = !/\bgolden/i.test(deliverable);
  return {
    verdicts: ids.map((id) => ({
      id,
      answer: mockGradeYes(id, againstAi) ? 'Yes' : 'No',
      evidence: againstAi ? 'Stand-in grade against the AI output after a free-tier 429.' : 'Stand-in grade against the Golden output after a free-tier 429.',
    })),
  };
}

export function standInValue<T>(input: { system: string; parts: (string | MediaPart)[]; schema: z.ZodType<T> }): T {
  const text = `${input.system}\n${flattenParts(input.parts)}`;
  const system = input.system;
  let raw: unknown;
  if (/rubric autorater/i.test(system)) raw = mockVerdicts(text);
  else if (/List concrete, falsifiable defects/i.test(system) || /"defects"/i.test(system) && /at most 18/i.test(system)) raw = { defects: /\bai[-_]/i.test(text) ? ['Title slide has a spelling error.'] : [] };
  else if (/ONE expert human/i.test(system) || /GRANULAR Precise Boolean/i.test(system)) raw = mockBank(text);
  else if (/write EVERY distinct/i.test(system) || /EXPERT SEED a peer/i.test(system)) {
    raw = {
      seeds: ['Format of the file', 'Required footer line', 'Slide count', 'Title names the review', 'Clear title band'].map((theme) => ({
        theme,
        statement: `The deck satisfies the ${theme} check.`,
        tag: theme.startsWith('Format') ? 'Format/File' : theme.includes('title band') ? 'Visual - Layout' : 'Content - Semantics',
      })),
    };
  } else if (/looking at work somebody delivered/i.test(system) || /Observe, never judge/i.test(system)) {
    raw = { account: [{ file: 'inputs', what: 'Task inputs as text', observed: ['Stand-in observe after a free-tier 429.'] }] };
  } else if (/separates strong work from weak/i.test(system)) {
    const ids = idsIn(text, /^(b\d+):/gm);
    raw = { scores: (ids.length ? ids : ['b1']).map((id) => ({ id, strength: 75 })) };
  } else if (/You are a rubric linter/i.test(system)) {
    const ids = idsIn(text, /^(r\d+)\s*\|/gm);
    raw = { rows: (ids.length ? ids : ['r1']).map((id) => ({ id, overall: 'pass' })) };
  } else if (/rewrite ONE rubric statement/i.test(system)) {
    const statement = text.match(/statement:\s*(.+)/i)?.[1]?.trim() || 'The deliverable matches the brief.';
    raw = { statement, rationale: 'Stand-in rewrite after a free-tier 429.' };
  } else {
    raw = {};
  }
  const parsed = input.schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Mock stand-in did not match the call schema: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  return parsed.data;
}
