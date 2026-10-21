import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, Loader2Icon } from "lucide-react";
import { ComponentBlock } from "@/components/ComponentBlock";
import { ImportQueue } from "@/components/ImportQueue";
import { ThemeToggle } from "@/components/ThemeToggle";
import { TokenSwatches } from "@/components/TokenSwatches";
import { TypeSpecimens } from "@/components/TypeSpecimens";
import { componentView, importInProgress, tokensFor, type Component, type RequestQueue, type Library } from "@/library";
import { galleryUrl } from "@/route";
import { usePreviewTheme } from "@/theme";

type Props = { library: Library; requestQueue: RequestQueue };

// The import's own order: type styles, colours, then the components in
// the order the import found them, beneath the two things they are made
// of. The three sections are on the page from the start, so nothing is
// inserted above what the user is reading. The import itself lives in
// the rail on the right.
export function Overview({ library, requestQueue }: Props) {
  const { manifest } = library;
  const theme = usePreviewTheme();
  const tokens = tokensFor(manifest, theme);
  const started = manifest.startedAt !== null;
  const justAdded = useArrivals(library);
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-10 md:grid md:grid-cols-[1fr_16rem] md:gap-x-12">
      <div className="flex min-w-0 flex-col gap-14">
        <ThemeToggle manifest={manifest} />

        {!started && (
          <div role="status" aria-label="Loading design system" className="space-y-10">
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Loader2Icon aria-hidden="true" className="size-4 motion-safe:animate-spin" />
                Preparing your design system…
              </p>
              <p className="text-sm text-muted-foreground">Styles and components appear here as they’re imported.</p>
            </div>
            <div aria-hidden="true" className="space-y-14 motion-safe:animate-pulse">
              <div className="space-y-4">
                <div className="h-4 w-24 rounded bg-muted" />
                <div className="h-9 w-2/3 rounded bg-muted" />
                <div className="h-4 w-1/2 rounded bg-muted" />
              </div>
              <div className="space-y-4">
                <div className="h-4 w-20 rounded bg-muted" />
                <div className="flex gap-3">
                  {Array.from({ length: 6 }, (_, index) => <div key={index} className="h-16 min-w-0 flex-1 rounded-md bg-muted" />)}
                </div>
              </div>
              <div className="space-y-4">
                <div className="h-4 w-28 rounded bg-muted" />
                <div className="h-32 rounded-lg bg-muted" />
              </div>
            </div>
          </div>
        )}

        {started && (
          <>
            <Section title="Type styles" count={manifest.type.length} reading="Reading the type styles" reserve="min-h-40">
              <TypeSpecimens styles={manifest.type} />
            </Section>
            <Section title="Colours" count={tokens.length} reading="Reading the colours" reserve="min-h-24">
              <TokenSwatches tokens={tokens} components={manifest.components} theme={theme} />
            </Section>
            <Section title="Components" count={manifest.components.length} reading="Finding the components" reserve="min-h-24" gap="gap-6">
              {manifest.components.map((component) => (
                <ComponentBlock
                  key={component.slug}
                  component={component}
                  library={library}
                  view={componentView(component, library)}
                  requestQueue={requestQueue}
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
  count: number;
  reading: string;
  reserve: string;
  gap?: string;
  children: React.ReactNode;
};

/** A section with its heading and count in place from the start, and
 *  a plain status line until the import fills it. */
function Section({ title, count, reading, reserve, gap = "gap-4", children }: SectionProps) {
  return (
    <section id={title === "Type styles" ? "type-styles" : title === "Colours" ? "colours" : "components"} className={`scroll-mt-8 flex flex-col ${gap}`}>
      <h2 className="flex items-baseline gap-2 text-sm font-medium text-foreground">
        {title}
        <span className="tabular-nums text-muted-foreground">{count}</span>
      </h2>
      {count > 0 ? (
        children
      ) : (
        <div className={reserve}>
          <p className="m-0 text-sm">
            {reading}
          </p>
        </div>
      )}
    </section>
  );
}

/** The way out: what this page is for, and the way back to the gallery when the site said where it is. */
function Footer() {
  const gallery = galleryUrl();
  return (
    <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6 text-sm text-muted-foreground">
      <p className="m-0">Ask your agent for a prototype: it builds from these components.</p>
      {gallery && (
        <a href={gallery} target="_top" className="flex items-center gap-1 hover:text-foreground">
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
