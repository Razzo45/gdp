'use client';

import { useState, type FormEvent } from 'react';
import { ROLES, type Role } from '@/db/schema';
import type { UserRow } from '@/lib/services/admin';
import { api } from '../client';

const ROLE_HELP: Record<Role, string> = {
  admin: 'everything, including Settings',
  pm: 'same task view as admin; assign, reassign, unlock, handoff — no Settings',
  rubric_creator: 'claims the next rubric task blind, then Golden, Stability, push',
  reviewer: 'claims the next review task blind, then scores the seated rubric',
};

export function UsersAdmin({ initial, selfId }: { initial: UserRow[]; selfId: string }) {
  const [users, setUsers] = useState(initial);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<Role[]>(['rubric_creator']);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  async function reload() {
    const result = await api<{ users: UserRow[] }>('/api/users');
    setUsers(result.users);
  }

  async function invite(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api('/api/users', { body: { email, roles, displayName: name || undefined } });
      setMessage({ text: `Invite sent to ${email}.` });
      setEmail('');
      setName('');
      await reload();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Invite failed.', bad: true });
    } finally {
      setBusy(false);
    }
  }

  async function patch(userId: string, body: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/users/${userId}`, { method: 'PATCH', body });
      await reload();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Update failed.', bad: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="page-kicker">Wirestock · GDP</p>
        <h1 className="page-title mt-1">Users</h1>
        <p className="mt-1 text-sm text-muted">Add the people who will submit and review work.</p>
      </div>
      <form onSubmit={invite} className="card space-y-2">
        <h2 className="font-medium">Add new user</h2>
        <div className="flex flex-wrap gap-2">
          <input className="input flex-1" type="email" required placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="input flex-1" placeholder="display name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          {ROLES.map((r) => (
            <label key={r} className="inline-flex items-center gap-1" title={ROLE_HELP[r]}>
              <input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles((cur) => (e.target.checked ? [...cur, r] : cur.filter((x) => x !== r)))} />
              {r}
            </label>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <button className="btn btn-primary" disabled={busy} type="submit">
            Add New User
          </button>
          {message && <span className={`text-sm ${message.bad ? 'text-bad' : 'text-ok'}`}>{message.text}</span>}
        </div>
      </form>

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-wash text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">User</th>
              {ROLES.map((r) => (
                <th key={r} className="px-4 py-3" title={ROLE_HELP[r]}>
                  {r.replace('_', ' ')}
                </th>
              ))}
              <th className="px-4 py-3">Active</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {users.map((u) => (
              <tr key={u.id} className={u.isActive ? '' : 'opacity-60'}>
                <td className="px-4 py-3">
                  <div className="font-medium">{u.displayName ?? u.email}</div>
                  <div className="text-xs text-muted">{u.email}</div>
                </td>
                {ROLES.map((r) => (
                  <td key={r} className="px-4 py-3">
                    <input type="checkbox" disabled={busy} checked={u.roles.includes(r)} onChange={(e) => patch(u.id, { roles: e.target.checked ? [...u.roles, r] : u.roles.filter((x) => x !== r) })} />
                  </td>
                ))}
                <td className="px-4 py-3">
                  <input type="checkbox" disabled={busy || u.id === selfId} checked={u.isActive} onChange={(e) => patch(u.id, { isActive: e.target.checked })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
