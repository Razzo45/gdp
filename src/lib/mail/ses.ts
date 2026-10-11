import 'server-only';

import { SendEmailCommand, SESClient, SendTemplatedEmailCommand } from '@aws-sdk/client-ses';

export type SesTemplateData = Record<string, unknown>;

function read(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function sesClient(): SESClient {
  const region = read('AWS_REGION');
  const accessKeyId = read('AWS_ACCESS_KEY_ID');
  const secretAccessKey = read('AWS_SECRET_ACCESS_KEY');
  return new SESClient({
    region,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    maxAttempts: 1,
  });
}

/** Region + From are required. Keys are optional when the host has an IAM role. */
export function sesConfigured(): boolean {
  return Boolean(read('AWS_REGION') && read('SES_FROM_EMAIL'));
}

export async function sendSesTemplatedEmail(input: {
  recipient: string;
  templateName: string;
  templateData: SesTemplateData;
}): Promise<void> {
  const source = read('SES_FROM_EMAIL');
  if (!sesConfigured() || !source) throw new Error('SES is not configured.');
  const client = sesClient();
  try {
    await client.send(
      new SendTemplatedEmailCommand({
        Source: source,
        Destination: { ToAddresses: [input.recipient] },
        Template: input.templateName,
        TemplateData: JSON.stringify(input.templateData),
      }),
    );
  } finally {
    client.destroy();
  }
}

export async function sendSesTextEmail(input: { recipient: string; subject: string; text: string }): Promise<void> {
  const source = read('SES_FROM_EMAIL');
  if (!sesConfigured() || !source) throw new Error('SES is not configured.');
  const client = sesClient();
  try {
    await client.send(
      new SendEmailCommand({
        Source: source,
        Destination: { ToAddresses: [input.recipient] },
        Message: {
          Subject: { Data: input.subject, Charset: 'UTF-8' },
          Body: { Text: { Data: input.text, Charset: 'UTF-8' } },
        },
      }),
    );
  } finally {
    client.destroy();
  }
}
