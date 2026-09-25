/**
 * Wall-clock formatting, one shape everywhere: a 24-hour clock with
 * seconds for activity lines, and a dated stamp for the import itself.
 * Written by hand rather than from the locale, so two browsers never
 * show the same log in two formats. The exception is the import's own
 * moment, which the header spells out in the reader's locale, where
 * reading it the way the reader writes dates is the point.
 */
import { plural } from "./library";

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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago an instant was, for a line read at a glance: "just now",
 * "5 minutes ago", "2 hours ago", "3 days ago"; "" when the instant is
 * unreadable. Coarse on purpose: the exact moment is a click away.
 */
export function ago(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const since = Math.max(0, now - then);
  if (since < MINUTE) return "just now";
  if (since < HOUR) return `${plural(Math.floor(since / MINUTE), "minute")} ago`;
  if (since < DAY) return `${plural(Math.floor(since / HOUR), "hour")} ago`;
  return `${plural(Math.floor(since / DAY), "day")} ago`;
}

/** The instant as the reader's own locale writes it; "" when it is unreadable. */
export function local(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
}
