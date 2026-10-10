'use client';

import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '@/components/client';

type Mode = 'signin' | 'forgot' | 'reset';

export interface LocalUser {
  email: string;
  name: string;
  roles: string[];
}

export function LoginForm({ localUsers, localPassword }: { localUsers: LocalUser[] | null; localPassword: string | null }) {
  const params = useSearchParams();
  const [mode, setMode] = useState<Mode>(params.get('reset') === '1' ? 'reset' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(localPassword ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(params.get('error') === 'link' ? 'That link is invalid or has expired.' : null);
  const [ok, setOk] = useState(false);
  const next = params.get('next') ?? '/';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      if (mode === 'signin') {
        await api('/api/auth/signin', { body: { email, password } });
        window.location.href = next.startsWith('/') && !next.startsWith('//') ? next : '/';
        return;
      }
      if (mode === 'forgot') {
        await api('/api/auth/recover', { body: { email } });
        setOk(true);
        setMessage('If that address has an account, a reset link is on its way.');
        return;
      }
      await api('/api/auth/password', { body: { password } });
      window.location.href = '/';
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function quickSignIn(user: LocalUser) {
    setBusy(true);
    setMessage(null);
    try {
      await api('/api/auth/signin', { body: { email: user.email, password: localPassword } });
      window.location.href = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card flex flex-col gap-3">
      {localUsers && (
        <div className="flex flex-col gap-1">
          {localUsers.length === 0 && <p className="text-sm text-warn">No users yet — run `npm run db:seed`.</p>}
          {localUsers.map((u) => (
            <button key={u.email} type="button" className="btn justify-between text-left" disabled={busy} onClick={() => quickSignIn(u)}>
              <span>
                <span className="font-medium">{u.name}</span> <span className="text-xs text-muted">{u.email}</span>
              </span>
              <span className="text-xs text-quiet">{u.roles.join(', ') || 'no roles'}</span>
            </button>
          ))}
          <p className="mt-1 text-xs text-quiet">Shared password: {localPassword}</p>
        </div>
      )}
      {mode !== 'reset' && (
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
      )}
      {mode !== 'forgot' && (
        <label className="flex flex-col gap-1 text-sm">
          {mode === 'reset' ? 'New password (10+ characters)' : 'Password'}
          <input className="input" type="password" autoComplete={mode === 'reset' ? 'new-password' : 'current-password'} required minLength={mode === 'reset' ? 10 : 1} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
      )}
      {message && <p className={`text-sm ${ok ? 'text-ok' : 'text-bad'}`}>{message}</p>}
      <button className="btn btn-primary justify-center" disabled={busy} type="submit">
        {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : mode === 'forgot' ? 'Send reset link' : 'Set password'}
      </button>
      <div className="flex justify-between text-xs text-muted">
        {mode === 'signin' ? (
          <button type="button" className="underline" onClick={() => setMode('forgot')}>
            Forgot password?
          </button>
        ) : (
          <button type="button" className="underline" onClick={() => setMode('signin')}>
            Back to sign in
          </button>
        )}
      </div>
    </form>
  );
}
