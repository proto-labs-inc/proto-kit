import { Shimmer } from "@/components/ai-elements/shimmer";
import { ComponentBlock } from "@/components/ComponentBlock";
import { TokenSwatches } from "@/components/TokenSwatches";
import { TypeSpecimens } from "@/components/TypeSpecimens";
import {
  componentView,
  importInProgress,
  latestActivity,
  type ComponentCategory,
  type Library,
  type QueueOutcome,
} from "@/library";

type Props = { library: Library; queue: (slug: string) => Promise<QueueOutcome> };

const SHELVES: { category: ComponentCategory; title: string }[] = [
  { category: "primitive", title: "Primitives" },
  { category: "composite", title: "Composites" },
];

// The import's own order: type, colours, then the components, which
// stream in beneath the two things they are made of.
export function Overview({ library, queue }: Props) {
  const { manifest, events, requests } = library;
  const started = manifest.startedAt !== null;
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-14 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-medium">{manifest.codebase ?? "Design system"}</h1>
        <StatusLine library={library} />
      </header>

      {!started && (
        <p className="text-sm text-muted-foreground">Nothing imported yet. The import fills this page as it reads your product.</p>
      )}

      {manifest.type.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Type styles</h2>
          <TypeSpecimens styles={manifest.type} />
        </section>
      )}

      {manifest.tokens.length > 0 && (
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-medium text-muted-foreground">Colours</h2>
          <TokenSwatches tokens={manifest.tokens} />
        </section>
      )}

      {SHELVES.map(({ category, title }) => {
        const shelf = manifest.components.filter((c) => c.category === category);
        if (shelf.length === 0) return null;
        return (
          <section key={category} className="flex flex-col gap-6">
            <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
            {shelf.map((component) => (
              <ComponentBlock
                key={component.slug}
                component={component}
                view={componentView(component, events, requests)}
                queue={queue}
              />
            ))}
          </section>
        );
      })}
    </main>
  );
}

function StatusLine({ library }: { library: Library }) {
  const { manifest, events } = library;
  if (importInProgress(library)) {
    const activity = latestActivity(events) ?? "Starting the import";
    return <Shimmer className="text-sm">{activity}</Shimmer>;
  }
  const done = manifest.components.filter((c) => c.status === "done").length;
  const source = manifest.source ? ` from ${manifest.source}` : "";
  return (
    <p className="text-sm text-muted-foreground">
      {done} of {manifest.components.length} components imported{source}
    </p>
  );
}
