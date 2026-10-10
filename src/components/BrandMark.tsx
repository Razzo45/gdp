/** Official Wirestock Isolation_Mode mark from the guidebook, 82×40. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      alt="Wirestock"
      src="/wirestock-mark.svg"
      width={82}
      height={40}
      className={['dark:invert', className].filter(Boolean).join(' ')}
    />
  );
}
