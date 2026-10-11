import './env';
import { prepareFile } from '../src/lib/ai/media';
import { gradeStatements } from '../src/lib/engines/autorater';

/** 1×1 PNG. */
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

async function main() {
  const red = await prepareFile({ id: 'card-1', name: 'card-1.png', mime: 'image/png', bytes: PNG }, 'CONSIDERED OUTPUT');
  const blue = await prepareFile({ id: 'card-2', name: 'card-2.png', mime: 'image/png', bytes: PNG }, 'CONSIDERED OUTPUT');
  const empty = await prepareFile({ id: 'empty', name: 'empty.png', mime: 'image/png', bytes: new Uint8Array() }, 'CONSIDERED OUTPUT');
  console.log('delivery', { red: red.delivery, blue: blue.delivery, empty: empty.delivery });

  const result = await gradeStatements({
    outputs: [red, blue],
    inputs: [],
    taskContext: 'Two 1×1 social cards.',
    statements: [
      { id: 's-all', seat: 1, statement: 'Every card is a PNG image.', tag: 'Format/File', scope: 'output', inputFileIds: [], outputFile: null },
      { id: 's-one', seat: 2, statement: 'card-2.png is attached.', tag: 'Format/File', scope: 'output', inputFileIds: [], outputFile: null },
      { id: 's-no', seat: 3, statement: 'The cards contain a 40-page written report.', tag: 'Content - Structural', scope: 'output', inputFileIds: [], outputFile: null },
    ],
  });
  console.log(JSON.stringify({
    answers: result.answers,
    evidence: result.evidence,
    errors: result.errors,
    usage: result.usage,
    model: result.model,
    filesSeen: result.inventoryByKey,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
