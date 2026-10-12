import { sendSesTextEmail, sesConfigured } from './ses';

export async function sendAuthLinkEmail(input: { recipient: string; kind: 'invite' | 'recover'; url: string }): Promise<boolean> {
  if (!sesConfigured()) return false;
  const subject = input.kind === 'invite' ? 'Your GDP Wirestock account' : 'Reset your GDP Wirestock password';
  const text =
    input.kind === 'invite'
      ? `You were invited to GDP Wirestock.\n\nSet your password:\n${input.url}\n\nThis link expires in 48 hours.`
      : `Reset your GDP Wirestock password:\n${input.url}\n\nIf you did not ask for this, ignore the email. The link expires in 2 hours.`;
  await sendSesTextEmail({ recipient: input.recipient, subject, text });
  return true;
}
