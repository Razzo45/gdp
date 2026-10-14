'use client';

import { FilePreviewList } from '@/components/FilePreview';
import type { SharePack } from '@/domain/sharePack';
import { shareFileHref } from '@/domain/sharePack';

export function ViewTaskPage({ pack, token }: { pack: SharePack; token: string }) {
  const hrefFor = (file: { id: string }) => shareFileHref(pack.submissionId, file.id, token);
  const scores = [pack.performance.goldenOutput, pack.performance.aiOutputHumanEval, pack.performance.stabilityScores].filter(Boolean);

  return (
    <div className="h-dvh overflow-y-auto bg-paper text-ink">
      <article className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
        <p className="text-sm text-muted">GDP Wirestock</p>
        <h1 className="mt-2 max-w-xl text-pretty text-2xl font-semibold tracking-tight">
          {titleRepeatsTask(pack.title, pack.task) ? 'View task' : pack.title || 'Task'}
        </h1>

        <Section title="Task" required>
          <p className="whitespace-pre-wrap text-[15px] leading-7">{pack.task || 'No task text was stored.'}</p>
          {pack.fields.length > 0 && (
            <dl className="mt-6 space-y-4">
              {pack.fields.map((field) => (
                <div key={field.key}>
                  <dt className="text-sm font-semibold">{field.label}</dt>
                  <dd className="mt-1 whitespace-pre-wrap text-sm leading-6">{field.text}</dd>
                </div>
              ))}
            </dl>
          )}
        </Section>

        <Section title="Inputs" required>
          <FilePreviewList files={pack.inputs} hrefFor={hrefFor} empty="No input files." />
        </Section>

        <Section title="Golden" required>
          <FilePreviewList files={pack.golden} hrefFor={hrefFor} empty="No golden output." />
        </Section>

        <Section title="AI output">
          <FilePreviewList files={pack.aiOutputs} hrefFor={hrefFor} empty="No AI output files." />
        </Section>

        <Section title="Performance">
          {scores.length === 0 ? (
            <p className="text-sm text-muted">Scores have not been written yet.</p>
          ) : (
            <ul className="space-y-2 text-[15px] leading-7">
              {scores.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Rubric">
          {pack.rubric.length === 0 ? (
            <p className="text-sm text-muted">No rubric seats.</p>
          ) : (
            <ol className="space-y-5">
              {pack.rubric.map((row, index) => (
                <li key={row.id} className="grid grid-cols-[2.5rem_1fr] gap-x-3">
                  <span className="pt-0.5 text-sm tabular-nums text-muted">{index + 1}</span>
                  <div>
                    <p className="text-[15px] leading-6">{row.statement}</p>
                    <p className="mt-1 text-xs text-muted">
                      {row.id}, {row.tag}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Section>

        <p className="mt-14 border-t border-line pt-6 text-sm text-muted">A read-only view of one submission, shared by link. Nothing here can be changed.</p>
      </article>
    </div>
  );
}

function titleRepeatsTask(title: string, task: string): boolean {
  const headline = title.replace(/\s+/g, ' ').trim().toLowerCase();
  const body = task.replace(/\s+/g, ' ').trim().toLowerCase();
  return headline.length > 0 && body.includes(headline);
}

function Section({ title, required, children }: { title: string; required?: boolean; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mb-3 text-lg font-semibold">
        {title}
        {required ? <span className="text-bad">*</span> : null}
      </h2>
      {children}
    </section>
  );
}
