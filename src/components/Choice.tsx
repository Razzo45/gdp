'use client';

import { gradeFromKey } from './seatKeys';

/** Segmented Yes/No — Y/N when focused; press again to clear when allowed. */
export function Choice({
  value,
  disabled,
  clearable = true,
  onChange,
  label = 'Verdict',
}: {
  value: boolean | null;
  disabled?: boolean;
  clearable?: boolean;
  onChange: (value: boolean | null) => void;
  label?: string;
}) {
  return (
    <div
      className="choice"
      role="group"
      aria-label={`${label}. Press Y or N`}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(event) => {
        if (disabled) return;
        const next = gradeFromKey(event);
        if (next === null) return;
        event.preventDefault();
        onChange(next);
      }}
    >
      <button
        type="button"
        disabled={disabled}
        aria-pressed={value === true}
        title="Press Y"
        className={`choice-opt ${value === true ? 'choice-yes' : ''}`}
        onClick={() => onChange(value === true && clearable ? null : true)}
      >
        Yes
      </button>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={value === false}
        title="Press N"
        className={`choice-opt ${value === false ? 'choice-no' : ''}`}
        onClick={() => onChange(value === false && clearable ? null : false)}
      >
        No
      </button>
    </div>
  );
}
