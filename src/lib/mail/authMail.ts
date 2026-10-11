import { sendSesTextEmail, sesConfigured } from './ses';

export async function sendAuthLinkEmail(input: { recipient: string; kind: 'invite' | 'recover'; url: string }): Promise<boolean> {
  if (!sesConfigured()) return false;
  const subject = input.kind === 'invite' ? 'Your GDP account' : 'Reset your GDP password';
  const text =
    input.kind === 'invite'
      ? `You were invited to the Golden Data Program.\n\nSet your password:\n${input.url}\n\nThis link expires in 48 hours.`
      : `Reset your Golden Data Program password:\n${input.url}\n\nIf you did not ask for this, ignore the email. The link expires in 2 hours.`;
  await sendSesTextEmail({ recipient: input.recipient, subject, text });
  return true;
}
