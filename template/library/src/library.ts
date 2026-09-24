/**
 * The library contract as the app reads it (docs/library-contract.md):
 * manifest.json, events.jsonl and queue.json under public/, polled
 * while an import is under way.
 */
import { useCallback, useEffect, useState } from "react";

export type TokenRole = "surface" | "text";
export type Token = { name: string; value: string; group: string; role?: TokenRole };

export type TypeStyle = {
  name: string;
  family: string;
  size: string;
  weight: number;
  lineHeight: string;
  sample: string;
};

export type ComponentStatus = "found" | "extracting" | "done" | "skipped" | "queued";
export type ComponentCategory = "primitive" | "composite";
export type ComponentState = { name: string; file: string; height: number };
export type Iteration = {
  at: string;
  activity: string;
  screenshot: string;
  diff: string;
  mismatch: number;
};
export type Component = {
  slug: string;
  name: string;
  category: ComponentCategory;
  status: ComponentStatus;
  states: ComponentState[];
  reason?: string;
  screenshot?: string;
  history: Iteration[];
};

/** The product as its live page presents it: the name heads the library. */
export type Product = { name: string; pageUrl: string; pageTitle: string };

export type Manifest = {
  codebase: string | null;
  source: string | null;
  product: Product | null;
  startedAt: string | null;
  completedAt: string | null;
  tokens: Token[];
  type: TypeStyle[];
  components: Component[];
};

export type ActivityEvent = { at: string; component?: string; activity: string };
export type QueueRequest = { slug: string; at: string };

export type Library = {
  manifest: Manifest;
  events: ActivityEvent[];
  requests: QueueRequest[];
};

export type LibraryLoad =
  | { phase: "loading" }
  | { phase: "unreachable" }
  | { phase: "ready"; library: Library; queue: (slug: string) => Promise<QueueOutcome> };

export type QueueOutcome = "queued" | "no-import";

const POLL_MS = 1000;

const fresh = (name: string) => fetch(`${name}?t=${Date.now()}`, { cache: "no-store" });

async function readLibrary(): Promise<Library> {
  const [manifestRes, eventsRes, queueRes] = await Promise.all([
    fresh("manifest.json"),
    fresh("events.jsonl"),
    fresh("queue.json"),
  ]);
  if (!manifestRes.ok) throw new Error(`manifest.json: ${manifestRes.status}`);
  const manifest = (await manifestRes.json()) as Manifest;
  let events: ActivityEvent[] = [];
  if (eventsRes.ok) {
    const text = await eventsRes.text();
    events = text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as ActivityEvent);
  }
  let requests: QueueRequest[] = [];
  if (queueRes.ok) requests = ((await queueRes.json()) as { requests: QueueRequest[] }).requests;
  return { manifest, events, requests };
}

/** Whether anything can still change: the import is running, a
 *  component is still moving, or the user asked for one. */
export function importInProgress({ manifest, requests }: Library): boolean {
  if (manifest.completedAt === null) return true;
  if (requests.length > 0) return true;
  return manifest.components.some((c) => c.status !== "done" && c.status !== "skipped");
}

type Load =
  | { kind: "loading" }
  | { kind: "unreachable" }
  | { kind: "ready"; library: Library };

export function useLibrary(): LibraryLoad {
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  const read = useCallback(async () => {
    try {
      const library = await readLibrary();
      setLoad({ kind: "ready", library });
    } catch {
      setLoad((prev) => {
        if (prev.kind === "ready") return prev;
        return { kind: "unreachable" };
      });
    }
  }, []);

  // One read at once; every later read is scheduled from the last, and
  // only while something can still change. A queue request makes the
  // library busy again, so polling resumes after a finished import.
  useEffect(() => {
    read();
  }, [read]);
  useEffect(() => {
    if (load.kind === "ready" && !importInProgress(load.library)) return;
    const timer = setTimeout(read, POLL_MS);
    return () => clearTimeout(timer);
  }, [load, read]);

  // A published build has no dev server behind it, so the POST fails
  // there; the card then says the import has to be running.
  const queue = useCallback(
    async (slug: string): Promise<QueueOutcome> => {
      try {
        const res = await fetch("queue.json", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug }),
        });
        if (!res.ok) return "no-import";
      } catch {
        return "no-import";
      }
      await read();
      return "queued";
    },
    [read],
  );

  if (load.kind === "ready") return { phase: "ready", library: load.library, queue };
  if (load.kind === "unreachable") return { phase: "unreachable" };
  return { phase: "loading" };
}

/** The latest activity line about one component, or about the whole import. */
export function latestActivity(events: ActivityEvent[], slug?: string): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (slug === undefined || event.component === slug) return event.activity;
  }
  return null;
}

/** What a component's card or page shows right now: one of three looks. */
export type ComponentView =
  | { kind: "shimmer"; activity: string }
  | { kind: "preview"; state: ComponentState }
  | { kind: "skipped"; reason: string; screenshot: string | null };

export function componentView(
  component: Component,
  events: ActivityEvent[],
  requests: QueueRequest[],
): ComponentView {
  const activity = latestActivity(events, component.slug);
  const requested = requests.some((r) => r.slug === component.slug);
  switch (component.status) {
    case "done":
      return { kind: "preview", state: component.states[0] };
    case "skipped":
      if (requested) return { kind: "shimmer", activity: `Queued ${component.name} for the import` };
      return {
        kind: "skipped",
        reason: component.reason ?? "Skipped",
        screenshot: component.screenshot ?? null,
      };
    case "found":
      return { kind: "shimmer", activity: activity ?? `Found ${component.name}` };
    case "queued":
      return { kind: "shimmer", activity: activity ?? `Queued ${component.name}` };
    case "extracting":
      return { kind: "shimmer", activity: activity ?? `Extracting ${component.name}` };
  }
}
