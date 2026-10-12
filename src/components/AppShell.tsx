'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { NAV_COLLAPSE_KEY, navCollapseValue, readNavCollapsed } from '@/domain/nav';
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
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setMenu(false);
  }, [path]);

  useEffect(() => {
    try {
      setCollapsed(readNavCollapsed(localStorage.getItem(NAV_COLLAPSE_KEY)));
    } catch {
      /* private mode */
    }
  }, []);

  function setRail(next: boolean) {
    setCollapsed(next);
    try {
      localStorage.setItem(NAV_COLLAPSE_KEY, navCollapseValue(next));
    } catch {
      /* private mode */
    }
  }

  const groups = ['Operations', 'Administration'] as const;

  const linksNav = (
    <nav className="flex shrink-0 flex-col gap-0.5 overflow-y-auto p-2">
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
  );

  const railToggle = (
    <button
      className={
        collapsed
          ? 'hidden h-28 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-[11px] font-semibold text-muted hover:bg-wash hover:text-ink lg:flex'
          : 'nav-link hidden w-full text-muted lg:flex'
      }
      type="button"
      aria-expanded={!collapsed}
      aria-controls="app-nav"
      onClick={() => setRail(!collapsed)}
    >
      {collapsed ? <span className="[writing-mode:vertical-rl] rotate-180 tracking-[0.16em]">Open</span> : 'Collapse'}
    </button>
  );

  const logout = (compact: boolean) => (
    <form action="/auth/signout" method="post" className={compact ? 'p-2' : 'p-3'}>
      <button
        className={compact ? 'flex h-10 w-full items-center justify-center rounded-lg text-muted hover:bg-wash hover:text-ink' : 'nav-link w-full text-muted'}
        type="submit"
        aria-label="Log Out"
      >
        {compact ? <LogoutMark /> : 'Log Out'}
      </button>
    </form>
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden lg:flex-row">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 lg:hidden">
        <button className="btn px-2.5 py-1 text-xs" type="button" onClick={() => setMenu(true)} aria-expanded={menu} aria-controls="app-nav">
          Menu
        </button>
        <BrandMark />
        <div className="min-w-0 truncate text-xl font-semibold leading-6 tracking-[-0.035em]">GDP Wirestock</div>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>

      {menu && <button className="fixed inset-0 z-30 bg-zinc-900/30 lg:hidden" type="button" aria-label="Close menu" onClick={() => setMenu(false)} />}

      <aside
        id="app-nav"
        className={`fixed inset-y-0 left-0 z-40 flex max-w-[85vw] flex-col border-r border-line bg-surface transition-[width,transform] duration-200 lg:static lg:z-0 lg:max-w-none lg:translate-x-0 ${
          collapsed ? 'lg:w-16' : 'lg:w-72'
        } w-72 ${menu ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {collapsed ? (
          <>
            <div className="hidden border-b border-line px-2 py-5 lg:flex lg:justify-center">
              <BrandMark compact />
            </div>
            <div className="hidden min-h-0 flex-1 items-center justify-center lg:flex">{railToggle}</div>
            <div className="hidden border-t border-line lg:block">{logout(true)}</div>
            <div className="flex h-full flex-col lg:hidden">
              <NavIdentity name={name} email={email} roles={roles} />
              {linksNav}
              <div className="mt-auto border-t border-line">{logout(false)}</div>
            </div>
          </>
        ) : (
          <>
            <NavIdentity name={name} email={email} roles={roles} />
            {linksNav}
            <div className="mt-auto border-t border-line">
              <div className="hidden p-3 pb-0 lg:block">{railToggle}</div>
              {logout(false)}
            </div>
          </>
        )}
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

function NavIdentity({ name, email, roles }: { name: string; email: string; roles: string }) {
  return (
    <div className="border-b border-line px-4 py-5">
      <BrandMark />
      <div className="mt-4 text-[2.1875rem] font-semibold leading-[1.05] tracking-[-0.04em]">GDP Wirestock</div>
      <div className="mt-4 text-[1.375rem] font-semibold leading-7 tracking-[-0.03em]" title={email}>
        Hi {name}
      </div>
      <div className="mt-1 text-sm font-medium leading-5 text-muted">{roles}</div>
    </div>
  );
}

function LogoutMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
        d="M15 7.5V6.2A2.2 2.2 0 0 0 12.8 4H6.2A2.2 2.2 0 0 0 4 6.2v11.6A2.2 2.2 0 0 0 6.2 20h6.6A2.2 2.2 0 0 0 15 17.8v-1.3M10 12h10m0 0-2.4-2.4M20 12l-2.4 2.4"
      />
    </svg>
  );
}
