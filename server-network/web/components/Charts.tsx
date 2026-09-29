'use client';
import type { ReactNode } from 'react';

export interface Bar {
  key: string;
  label: ReactNode;
  value: number;
  /** CSS class setting the bar color (tone-*). */
  tone?: string;
  onClick?: () => void;
}

/** Horizontal bars with the value printed next to each (readable without the graphic). */
export function BarList({ bars, empty = 'No data', max }: { bars: Bar[]; empty?: string; max?: number }) {
  const top = max ?? Math.max(1, ...bars.map((b) => b.value));
  if (!bars.length) return <p className="muted small">{empty}</p>;
  return (
    <ul className="bars">
      {bars.map((b) => {
        const inner = (
          <>
            <span className="bar-label">{b.label}</span>
            <span className="bar-track" aria-hidden>
              <span className={`bar-fill ${b.tone ?? 'tone-accent'}`} style={{ width: `${b.value ? Math.max(2, (b.value / top) * 100) : 0}%` }} />
            </span>
            <span className="bar-value">{b.value}</span>
          </>
        );
        return (
          <li key={b.key}>
            {b.onClick ? (
              <button type="button" className="bar-row bar-row-btn" onClick={b.onClick}>
                {inner}
              </button>
            ) : (
              <div className="bar-row">{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One 100% bar split into segments, with a legend carrying the numbers. */
export function StackedBar({ segments, label }: { segments: Bar[]; label: string }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  return (
    <div className="stacked">
      <div className="stacked-track" role="img" aria-label={`${label}: ${segments.map((s) => `${typeof s.label === 'string' ? s.label : s.key} ${s.value}`).join(', ')}`}>
        {total === 0 ? <span className="stacked-empty" /> : segments.filter((s) => s.value > 0).map((s) => <span key={s.key} className={`stacked-seg ${s.tone ?? 'tone-accent'}`} style={{ width: `${(s.value / total) * 100}%` }} />)}
      </div>
      <ul className="legend">
        {segments.map((s) => (
          <li key={s.key}>
            <span className={`legend-swatch ${s.tone ?? 'tone-accent'}`} aria-hidden />
            {s.label} <strong>{s.value}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}
