/**
 * Shaping what travels to the Catalog. Pure.
 *
 *  - rubric rows become `{ id: s001, statement, question, tag, answer }`
 *    filtered to the properties the project declares;
 *  - `taskPerformance` carries three ASCII sentences;
 *  - outbound human text is converted to ASCII where the upstream requires it,
 *    while ids, enums and file references are never rewritten.
 */
import { deliveryId, FAMILY_LABELS, seatsInDisplayOrder, type Family } from '@/domain/rubric';
import { pct } from '@/components/format';
import { STABILITY_MAX_SPREAD_POINTS } from '@/domain/gates';
import { declaredRubricItemFields, taskPerformanceDeclaration } from './read';

const replacements: Record<string, string> = {
  'ß': 'ss', 'ẞ': 'SS', 'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE', 'ø': 'o', 'Ø': 'O', 'ł': 'l', 'Ł': 'L',
  'đ': 'd', 'Đ': 'D', 'ð': 'd', 'Ð': 'D', 'þ': 'th', 'Þ': 'Th', 'ı': 'i', 'ħ': 'h', 'Ħ': 'H',
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", 'ʼ': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"', '«': '"', '»': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  '•': '-', '·': '-', '…': '...', '©': '(c)', '®': '(R)', '™': '(TM)',
};

/** Outbound copy only: no trimming, no whitespace collapsing. */
export function catalogAsciiText(text: string): string {
  return [...text]
    .map((character) => {
      if (character in replacements) return replacements[character]!;
      if (/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u.test(character)) return ' ';
      if (/[\u0085\u2028\u2029]/u.test(character)) return '\n';
      if (/\p{Script=Latin}/u.test(character)) {
        return character.normalize('NFKD').replace(/\p{Mark}/gu, '').replace(/[^\x20-\x7e]/g, '');
      }
      return /^[\x20-\x7e\t\r\n]$/.test(character) ? character : '';
    })
    .join('');
}

export interface DeliveryRow {
  id?: string;
  statement: string;
  family: Family;
  position?: number;
  /** The Golden verdict ("Yes"/"No"); every row is Yes once the gate passes. */
  answer: 'Yes' | 'No';
}

export function catalogRubricItems(rows: readonly DeliveryRow[], project: unknown): { ok: true; items: Record<string, string>[] } | { ok: false; error: string } {
  const declared = declaredRubricItemFields(project);
  const wanted = declared.size === 0 ? new Set(['question', 'answer']) : declared;
  const wording = wanted.has('statement') || wanted.has('question');
  if (!wording || !wanted.has('answer')) {
    return {
      ok: false,
      error: `This project's rubric fields (${[...wanted].sort().join(', ')}) cannot carry ${wording ? 'a verdict' : 'a statement'}, so the rubric was not sent.`,
    };
  }
  const ordered = seatsInDisplayOrder(rows.map((row, index) => ({ ...row, id: row.id ?? String(index), position: row.position ?? index })));
  const items = ordered.map((row, index) => {
    const item: Record<string, string> = {};
    if (wanted.has('id')) item['id'] = deliveryId(index);
    if (wanted.has('statement')) item['statement'] = catalogAsciiText(row.statement);
    if (wanted.has('question')) item['question'] = catalogAsciiText(row.statement);
    if (wanted.has('tag')) item['tag'] = FAMILY_LABELS[row.family];
    item['answer'] = row.answer;
    return item;
  });
  return { ok: true, items };
}

export interface PerformanceSummaryInput {
  goldenPercent: number | null;
  calibrationPercent: number | null;
  stabilityScores: number[] | null;
}

const ascii = (text: string) => catalogAsciiText(text).replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();

export function taskPerformanceSummaries(input: PerformanceSummaryInput): Record<string, string | null> {
  const golden = input.goldenPercent === null ? null : `Golden output score: ${pct(input.goldenPercent)}.`;
  const human = input.calibrationPercent === null ? null : `AI output human evaluation score: ${pct(input.calibrationPercent)}.`;
  let stability: string | null = null;
  if (input.stabilityScores && input.stabilityScores.length === 3 && input.stabilityScores.every(Number.isFinite)) {
    const spread = Math.max(...input.stabilityScores) - Math.min(...input.stabilityScores);
    const runs = input.stabilityScores.map((s, i) => `Run ${i + 1} ${pct(s)}`).join(', ');
    const rounded = Math.round(spread * 10) / 10;
    const verdict = spread <= STABILITY_MAX_SPREAD_POINTS ? 'within' : 'outside';
    stability = `Stability runs: ${runs}. Maximum drift between runs: ${rounded} percentage points. Result: ${verdict} the ${STABILITY_MAX_SPREAD_POINTS} percentage point limit.`;
  }
  return { goldenOutput: golden, aiOutputHumanEval: human, stabilityScores: stability };
}

/**
 * The `taskPerformance` object to write, or null when any required part is
 * missing — their schema requires all three together, and a placeholder
 * would report a result nobody produced. Properties they hold that we do not
 * write are preserved.
 */
export function catalogTaskPerformance(input: PerformanceSummaryInput, project: unknown, existing: unknown): Record<string, unknown> | null {
  const { declared, required } = taskPerformanceDeclaration(project);
  const summaries = taskPerformanceSummaries(input);
  const wanted = declared.size === 0 ? new Set(Object.keys(summaries)) : declared;
  const written: Record<string, string> = {};
  for (const field of Object.keys(summaries)) {
    if (!wanted.has(field)) continue;
    const text = ascii(summaries[field] ?? '');
    if (text === '') return null;
    written[field] = text;
  }
  if (Object.keys(written).length === 0) return null;
  const kept = existing && typeof existing === 'object' && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {};
  const merged = { ...kept, ...written };
  for (const field of required) {
    const value = merged[field];
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  }
  return merged;
}

/** Display name for a Catalog upload; the extension is a protected token. */
export function catalogUploadFilename(name: string, extension: string): { ok: true; fileName: string } | { ok: false; error: string } {
  if (!/^[a-z0-9]{1,20}$/i.test(extension)) return { ok: false, error: 'Use an ASCII alphanumeric file extension.' };
  const exported = catalogAsciiText(name).replace(/[\t\r\n/\\]/g, '').trim();
  const suffix = name.match(/\.([a-z0-9]{1,20})$/i)?.[0] ?? '';
  if (name.trim() !== '' && exported.replace(/\.[a-z0-9]{1,20}$/i, '').trim() === '') {
    return { ok: false, error: 'ASCII conversion leaves the file name empty.' };
  }
  if (exported.length > 255) return { ok: false, error: 'The file name exceeds 255 characters after ASCII conversion.' };
  return { ok: true, fileName: suffix && !exported.endsWith(suffix) ? `${exported}${suffix}` : exported };
}
