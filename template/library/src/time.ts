/** Wall-clock formatting shared by the overview and the history reveal. */

export function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** "2 min 38 s" between two instants; "" when either is unreadable. */
export function elapsed(fromIso: string, toIso: string): string {
  const seconds = Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000);
  if (Number.isNaN(seconds) || seconds < 0) return "";
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds} s`;
  return `${minutes} min ${seconds % 60} s`;
}
