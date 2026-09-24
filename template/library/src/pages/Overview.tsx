import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, ClockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ComponentBlock } from "@/components/ComponentBlock";
import { ImportedAt } from "@/components/ImportedAt";
import { ImportQueue } from "@/components/ImportQueue";
import { TokenSwatches } from "@/components/TokenSwatches";
import { TypeSpecimens } from "@/components/TypeSpecimens";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { EVERYTHING, type SendOutcome } from "@/courier";
import { componentView, importInProgress, importRequested, queuedSentence, type Component, type Courier, type Library } from "@/library";
import { galleryUrl } from "@/route";

type Props = { library: Library; courier: Courier };

// The import's own order: type styles, colours, then the components in
// the order the import found them, beneath the two things they are made
// of. The three sections are on the page from the start, so nothing is
// inserted above what the user is reading. The import itself lives in
// the rail on the right.
export function Overview({ library, courier }: Props) {
  const { manifest } = library;
  const started = manifest.startedAt !== null;
  const justAdded = useArrivals(library);
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-10 md:grid md:grid-cols-[1fr_16rem] md:gap-x-12">
      <div className="flex min-w-0 flex-col gap-14">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="m-0 text-xl font-medium">{manifest.product?.name ?? "Design system"}</h1>
          {started && (
            <div className="flex items-center gap-3">
              <ImportAgain library={library} courier={courier} />
              <ImportedAt manifest={manifest} />
            </div>
          )}
        </header>

        {!started && (
          <p className="text-sm text-muted-foreground">Nothing imported yet. The import fills this page as it reads your product.</p>
        )}

        {started && (
          <>
            <Section title="Type styles" filled={manifest.type.length > 0} reading="Reading the type styles" reserve="min-h-40">
              <TypeSpecimens styles={manifest.type} />
            </Section>
            <Section title="Colours" filled={manifest.tokens.length > 0} reading="Reading the colours" reserve="min-h-24">
              <TokenSwatches tokens={manifest.tokens} components={manifest.components} />
            </Section>
            <Section title="Components" filled={manifest.components.length > 0} reading="Finding the components" reserve="min-h-24" gap="gap-6">
              {manifest.components.map((component) => (
                <ComponentBlock
                  key={component.slug}
                  component={component}
                  all={manifest.components}
                  view={componentView(component, library)}
                  courier={courier}
                  justAdded={justAdded.has(component.slug)}
                />
              ))}
            </Section>
            <Footer />
          </>
        )}
      </div>
      {started && <ImportQueue library={library} />}
    </main>
  );
}

type SectionProps = {
  title: string;
  filled: boolean;
  reading: string;
  reserve: string;
  gap?: string;
  children: React.ReactNode;
};

/** A section with its heading in place from the start, and the import's line in it until it fills. */
function Section({ title, filled, reading, reserve, gap = "gap-4", children }: SectionProps) {
  return (
    <section className={`flex flex-col ${gap}`}>
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      {filled ? children : <Shimmer className={`${reserve} text-sm`}>{reading}</Shimmer>}
    </section>
  );
}

type Ask = "idle" | "asking" | SendOutcome;

/**
 * Runs the whole import again: the same request as "Queue it", for
 * everything. While the import runs there is nothing to ask for, so the
 * button is there and disabled; once the request is in and nothing has
 * taken it yet, its place carries the queued line and the way out of
 * it, the shape and the words a queued component's block uses.
 */
function ImportAgain({ library, courier }: Props) {
  const [ask, setAsk] = useState<Ask>("idle");
  const { manifest, requests } = library;
  const send = async (call: Courier["ask"]) => {
    setAsk("asking");
    setAsk(await call(EVERYTHING));
  };
  if (manifest.completedAt === null) {
    return (
      <Button size="sm" variant="outline" disabled>
        Import again
      </Button>
    );
  }
  if (importRequested(requests)) {
    return (
      <div className="flex items-center gap-2">
        <ClockIcon className="size-4 shrink-0 text-muted-foreground" />
        <p className="m-0 text-sm font-medium">{queuedSentence(manifest)}</p>
        <Button size="sm" variant="ghost" onClick={() => send(courier.withdraw)} disabled={ask === "asking"}>
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3">
      {ask === "unreachable" && <span className="text-xs text-muted-foreground">Only the live library can ask; open it from your agent's session.</span>}
      <Button size="sm" variant="outline" onClick={() => send(courier.ask)} disabled={ask === "asking"}>
        Import again
      </Button>
    </div>
  );
}

/** The way out: what this page is for, and the way back to the gallery when the site said where it is. */
function Footer() {
  const gallery = galleryUrl();
  return (
    <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6 text-sm text-muted-foreground">
      <p className="m-0">Ask your agent for a prototype: it builds from these components.</p>
      {gallery && (
        <a href={gallery} className="flex items-center gap-1 hover:text-foreground">
          <ArrowLeftIcon className="size-4" /> Back to the gallery
        </a>
      )}
    </footer>
  );
}

/**
 * The components that land where the user can see them: the page
 * scrolls to the first built block once, and to a component that
 * comes back after the user asked for it, marking it just added.
 */
function useArrivals(library: Library): Set<string> {
  const { manifest } = library;
  const running = importInProgress(library);
  const previous = useRef<Map<string, Component["status"]> | null>(null);
  const scrolledToFirst = useRef(false);
  const [justAdded, setJustAdded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const now = new Map(manifest.components.map((c) => [c.slug, c.status]));
    const before = previous.current;
    previous.current = now;
    const anyBuilt = manifest.components.some((c) => c.status === "done");
    if (before === null) {
      // A page opened on a finished library has nothing arriving.
      scrolledToFirst.current = anyBuilt;
      return;
    }
    if (!anyBuilt) {
      // The import started over: the first block will appear again.
      scrolledToFirst.current = false;
      setJustAdded((was) => (was.size === 0 ? was : new Set()));
      return;
    }
    const arrived = manifest.components.filter((c) => c.status === "done" && before.get(c.slug) !== "done");
    if (arrived.length === 0) return;
    const returned = arrived.filter((c) => c.screenshot);
    if (returned.length > 0) {
      setJustAdded((was) => new Set([...was, ...returned.map((c) => c.slug)]));
      scrollTo(returned[0].slug);
      return;
    }
    if (!scrolledToFirst.current && running) {
      scrolledToFirst.current = true;
      scrollTo(arrived[0].slug);
    }
  }, [manifest.components, running]);

  return justAdded;
}

function scrollTo(slug: string) {
  document.getElementById(slug)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
