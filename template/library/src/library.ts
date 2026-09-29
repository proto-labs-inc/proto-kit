/**
 * The library contract as the app reads it (docs/library-contract.md):
 * manifest.json, events.jsonl and queue.json under public/, polled
 * while an import is under way.
 */
import { useCallback, useEffect, useState } from "react";
import { EVERYTHING, ask, withdraw, type SendOutcome } from "./courier";

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
/** Why a component was skipped: what the not-built strip groups by. */
export type SkipKind = "could-not-isolate" | "did-not-match" | "not-tried";
/** One named look of a component: the props that produce it. The first is the default. */
export type ComponentState = { name: string; props: Record<string, unknown> };
export type Pass = {
  at: string;
  activity: string;
  screenshot: string;
  diff: string;
  mismatch: number;
};
export type Component = {
  slug: string;
  name: string;
  status: ComponentStatus;
  /** The component's module, relative to the app root: src/components/<slug>/<Slug>.tsx; set once done. */
  module?: string;
  /** Every state the product shows, the default first, each name used once; as many as it has. */
  states: ComponentState[];
  /** The names of the manifest tokens the component uses; filled once done. */
  tokens: string[];
  /** One sentence on why the import made no pass for it, when it made none. */
  unverified?: string;
  skipKind?: SkipKind;
  reason?: string;
  /** The component cropped from the product at 2x; set when skipped and kept from then on. */
  screenshot?: string;
  history: Pass[];
};

/** The product as its live page presents it: the name heads the library,
 *  and the page (its title, its icon) is the sentence under it. The icon
 *  is a path under public/, present only when the page has one. */
export type Product = { name: string; pageUrl: string; pageTitle: string; favicon?: string };

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

/** The product's heading face, from the first type style the import
 *  read (the import lists them largest first): what the library's own
 *  title is set in, so the page opens in the product's voice. Null until
 *  a type style has landed. */
export function headingStyle(manifest: Manifest): { family: string; weight: number } | null {
  const first = manifest.type[0];
  if (!first) return null;
  return { family: first.family, weight: first.weight };
}

export type ActivityEvent = { at: string; component?: string; activity: string };
export type QueueRequest = { slug: string; at: string };

export type Library = {
  manifest: Manifest;
  events: ActivityEvent[];
  requests: QueueRequest[];
};

/** What the pages can ask the import for; each call re-reads the library afterwards. */
export type Courier = {
  ask: (slug: string) => Promise<SendOutcome>;
  withdraw: (slug: string) => Promise<SendOutcome>;
};

export type LibraryLoad =
  | { phase: "loading" }
  | { phase: "unreachable" }
  | { phase: "ready"; library: Library; courier: Courier };

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

export const settled = (component: Component) => component.status === "done" || component.status === "skipped";

/** Whether anything can still change: the import is running, a
 *  component is still moving, or the user asked for something. */
export function importInProgress({ manifest, requests }: Library): boolean {
  if (manifest.completedAt === null) return true;
  if (requests.length > 0) return true;
  return manifest.components.some((c) => !settled(c));
}

export const requested = (requests: QueueRequest[], slug: string) => requests.some((r) => r.slug === slug);

/** Whether the user asked for the whole import again and nothing has taken it yet. */
export const importRequested = (requests: QueueRequest[]) => requested(requests, EVERYTHING);

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
  // only while something can still change. A request makes the library
  // busy again, so polling resumes after a finished import.
  useEffect(() => {
    read();
  }, [read]);
  useEffect(() => {
    if (load.kind === "ready" && !importInProgress(load.library)) return;
    const timer = setTimeout(read, POLL_MS);
    return () => clearTimeout(timer);
  }, [load, read]);

  const courier = useCallback(
    (send: (slug: string) => Promise<SendOutcome>) => async (slug: string) => {
      const outcome = await send(slug);
      if (outcome === "sent") await read();
      return outcome;
    },
    [read],
  );

  if (load.kind === "ready") return { phase: "ready", library: load.library, courier: { ask: courier(ask), withdraw: courier(withdraw) } };
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

/**
 * A component's activity as the user reads it: the import's own lines
 * for it, and the user's request, which the import records only once it
 * takes it, so until then the request itself is the line.
 */
export function activityFor(component: Component, { events, requests }: Library): ActivityEvent[] {
  const own = events.filter((e) => e.component === component.slug);
  const request = requests.find((r) => r.slug === component.slug);
  if (!request) return own;
  return [...own, { at: request.at, component: component.slug, activity: `You asked for ${component.name} to be built again` }].sort(
    (a, b) => a.at.localeCompare(b.at),
  );
}

/** What a component's block or page shows right now. */
export type ComponentView =
  /** Found or being read; the product crop shows when the component has one from an earlier skip. */
  | { kind: "working"; activity: string; screenshot: string | null }
  /** Asked for and not yet built: the one sentence says who builds it and when. */
  | { kind: "pending"; sentence: string; screenshot: string | null; reason: string | null; skipKind: SkipKind | null; withdrawable: boolean }
  | { kind: "skipped"; reason: string; skipKind: SkipKind; screenshot: string | null }
  | { kind: "preview"; state: ComponentState };

const NEXT = "Queued: the import builds this next.";
const NEXT_RUN = "Queued: your agent builds this next time it runs.";

/**
 * What something queued is waiting for, in the one wording the whole
 * page uses: the running import takes it next, and a finished one
 * leaves it to the agent's next run. A component's block and the queue
 * rail read it from here, so they never drift apart.
 */
export function queuedSentence(manifest: Manifest): string {
  if (manifest.completedAt === null) return NEXT;
  return NEXT_RUN;
}

export function componentView(component: Component, library: Library): ComponentView {
  const { manifest, events, requests } = library;
  const activity = latestActivity(events, component.slug);
  const screenshot = component.screenshot ?? null;
  switch (component.status) {
    case "done":
      return { kind: "preview", state: component.states[0] };
    case "skipped":
      if (requested(requests, component.slug)) {
        return { kind: "pending", sentence: queuedSentence(manifest), screenshot, reason: component.reason ?? null, skipKind: component.skipKind ?? null, withdrawable: true };
      }
      return { kind: "skipped", reason: component.reason ?? "Skipped", skipKind: component.skipKind ?? "not-tried", screenshot };
    case "queued":
      return { kind: "pending", sentence: NEXT, screenshot, reason: component.reason ?? null, skipKind: component.skipKind ?? null, withdrawable: false };
    case "found":
      return { kind: "working", activity: activity ?? `Found ${component.name}`, screenshot };
    case "extracting":
      return { kind: "working", activity: activity ?? `Reading ${component.name} on the live page`, screenshot };
  }
}

/** The heading the not-built strip gives a skip of each kind. */
export function skipHeading(kind: SkipKind): string {
  switch (kind) {
    case "could-not-isolate":
      return "Could not be built on its own";
    case "did-not-match":
      return "Not identical to the product yet";
    case "not-tried":
      return "Not tried this run";
  }
}

/**
 * A component that was skipped and then built after the user asked:
 * says so, and says when it came back with fewer states or fewer
 * checks than the components built in the first run.
 */
export function rebuiltNote(component: Component, all: Component[]): string | null {
  if (component.status !== "done" || !component.screenshot) return null;
  const others = all.filter((c) => c.status === "done" && c.slug !== component.slug && !c.screenshot);
  const parts: string[] = [];
  if (others.length > 0) {
    const fewestStates = Math.min(...others.map((c) => c.states.length));
    const fewestPasses = Math.min(...others.map((c) => c.history.length));
    if (component.states.length < fewestStates) parts.push(`with ${plural(component.states.length, "state")} where the others have ${fewestStates} or more`);
    if (component.history.length < fewestPasses) parts.push(`checked ${times(component.history.length)} where the others were checked ${fewestPasses} or more`);
  }
  if (parts.length === 0) return "Rebuilt after you asked, checked like the others.";
  return `Rebuilt after you asked, ${parts.join(" and ")}.`;
}

export function plural(n: number, word: string): string {
  if (n === 1) return `1 ${word}`;
  return `${n} ${word}s`;
}

function times(n: number): string {
  if (n === 1) return "once";
  return `${n} times`;
}

export function pixelsDiffer(mismatch: number): string {
  if (mismatch === 0) return "Matches the product";
  return `${mismatch.toLocaleString("en-GB")} pixels differ from the product`;
}
