/**
 * Wall-clock formatting, one shape everywhere: a 24-hour clock with
 * seconds for activity lines, and a dated stamp for the import itself.
 * Written by hand rather than from the locale, so two browsers never
 * show the same log in two formats.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** "13:01:40"; "" when the instant is unreadable. */
export function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** "24 Sep 2026, 13:01"; "" when the instant is unreadable. */
export function stamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** "2 min 38 s" between two instants; "" when either is unreadable. */
export function elapsed(fromIso: string, toIso: string): string {
  const seconds = Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000);
  if (Number.isNaN(seconds) || seconds < 0) return "";
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds} s`;
  return `${minutes} min ${seconds % 60} s`;
}
