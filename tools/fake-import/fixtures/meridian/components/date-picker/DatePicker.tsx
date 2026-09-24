import styles from "./DatePicker.module.css";

export interface DatePickerProps {
  /** The month shown, as the header reads it. */
  month?: string;
  /** Day-of-month cells in grid order; days outside the month are dimmed. */
  days?: { day: number; outside?: boolean }[];
  today?: number;
  picked?: number;
}

const DOW = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

const SEPTEMBER_2026 = [
  { day: 31, outside: true },
  ...Array.from({ length: 30 }, (_, i) => ({ day: i + 1 })),
  ...Array.from({ length: 4 }, (_, i) => ({ day: i + 1, outside: true })),
];

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

export function DatePicker({ month = "September 2026", days = SEPTEMBER_2026, today = 24, picked = 16 }: DatePickerProps) {
  return (
    <div className={styles.picker}>
      <div className={styles.head}>
        <span className={styles.arrow}>‹</span>
        <span className={styles.month}>{month}</span>
        <span className={styles.arrow}>›</span>
      </div>
      <div className={styles.grid}>
        {DOW.map((d) => (
          <span key={d} className={styles.dow}>{d}</span>
        ))}
        {days.map((cell, i) => (
          <span
            key={i}
            className={classes(
              styles.day,
              cell.outside && styles.dim,
              !cell.outside && cell.day === today && styles.today,
              !cell.outside && cell.day === picked && styles.picked,
            )}
          >
            {cell.day}
          </span>
        ))}
      </div>
    </div>
  );
}

export default DatePicker;
