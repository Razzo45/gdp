'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { BrandMark } from './BrandMark';
import { ThemeToggle } from './ThemeToggle';

export interface NavLink {
  href: string;
  label: string;
  group: 'Operations' | 'Administration';
}

export function AppShell({
  name,
  email,
  roles,
  links,
  children,
}: {
  name: string;
  email: string;
  roles: string;
  links: NavLink[];
  children: ReactNode;
}) {
  const path = usePathname();
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    setMenu(false);
  }, [path]);

  const groups = ['Operations', 'Administration'] as const;

  const nav = (
    <>
      <div className="border-b border-line px-4 py-5">
        <BrandMark />
        <div className="page-kicker mt-4">Wirestock</div>
        <div className="mt-1 text-sm font-semibold tracking-[-0.025em]">GDP Evaluation</div>
        <div className="mt-3 truncate text-xs text-muted" title={email}>
          {name}
        </div>
        <div className="truncate text-[11px] text-quiet">{roles}</div>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {groups.map((group) => {
          const items = links.filter((link) => link.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="mb-3">
              <p className="page-kicker px-2 pb-1 pt-2 first:pt-1">{group}</p>
              {items.map((link) => {
                const active =
                  link.href === '/'
                    ? path === '/'
                    : link.href === '/submissions'
                      ? path === '/submissions' || (path.startsWith('/submissions/') && !path.startsWith('/submissions/claims'))
                      : link.href.startsWith('/settings')
                        ? path.startsWith('/settings')
                        : path === link.href || path.startsWith(`${link.href}/`);
                return (
                  <Link key={link.href} href={link.href} className={`nav-link ${active ? 'nav-link-active' : ''}`}>
                    {link.label}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>
      <form action="/auth/signout" method="post" className="border-t border-line p-3">
        <button className="nav-link w-full text-muted" type="submit">
          Log Out
        </button>
      </form>
    </>
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden lg:flex-row">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 lg:hidden">
        <button className="btn px-2.5 py-1 text-xs" type="button" onClick={() => setMenu(true)} aria-expanded={menu} aria-controls="app-nav">
          Menu
        </button>
        <BrandMark />
        <div className="min-w-0 truncate text-sm font-semibold tracking-[-0.025em]">GDP</div>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>

      {menu && <button className="fixed inset-0 z-30 bg-zinc-900/30 lg:hidden" type="button" aria-label="Close menu" onClick={() => setMenu(false)} />}

      <aside
        id="app-nav"
        className={`fixed inset-y-0 left-0 z-40 flex w-60 max-w-[85vw] flex-col border-r border-line bg-surface transition-transform lg:static lg:z-0 lg:max-w-none lg:translate-x-0 ${menu ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {nav}
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="hidden h-12 shrink-0 items-center justify-end border-b border-line bg-surface px-4 lg:flex">
          <ThemeToggle />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </main>
    </div>
  );
}
