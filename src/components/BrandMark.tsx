/** Official Wirestock Isolation_Mode mark from the guidebook, 82×40. */
export function BrandMark({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <img
      alt="Wirestock"
      src="/wirestock-mark.svg"
      width={compact ? 36 : 82}
      height={compact ? 18 : 40}
      className={['dark:invert', compact ? 'h-[18px] w-9' : '', className].filter(Boolean).join(' ')}
    />
  );
}
