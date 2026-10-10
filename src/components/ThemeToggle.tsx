'use client';

const KEY = 'gdp-theme';

function current(): 'light' | 'dark' {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function apply(theme: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* ignore quota / private mode */
  }
}

export function ThemeToggle() {
  return (
    <button
      type="button"
      className="btn h-[34px] w-[34px] min-w-[34px] px-0"
      aria-label="Toggle light and dark mode"
      onClick={() => apply(current() === 'dark' ? 'light' : 'dark')}
    >
      <SunIcon className="hidden dark:block" />
      <MoonIcon className="dark:hidden" />
    </button>
  );
}

function SunIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
        d="M12 3.5v1.8M12 18.7v1.8M4.9 4.9l1.3 1.3M17.8 17.8l1.3 1.3M3.5 12h1.8M18.7 12h1.8M4.9 19.1l1.3-1.3M17.8 6.2l1.3-1.3M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"
      />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
        d="M16.6 17.4A7.2 7.2 0 0 1 8.2 6.3 7.2 7.2 0 1 0 16.6 17.4Z"
      />
    </svg>
  );
}
