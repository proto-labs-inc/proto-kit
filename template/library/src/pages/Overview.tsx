import { ComponentBlock } from "@/components/ComponentBlock";
import { ImportContext } from "@/components/ImportContext";
import { ImportQueue } from "@/components/ImportQueue";
import { TokenSwatches } from "@/components/TokenSwatches";
import { TypeSpecimens } from "@/components/TypeSpecimens";
import { componentView, type Library, type QueueOutcome } from "@/library";

type Props = { library: Library; queue: (slug: string) => Promise<QueueOutcome> };

// The import's own order: type, colours, then the components in the
// order the import found them, streaming in beneath the two things
// they are made of. The import itself lives in the rail on the right.
export function Overview({ library, queue }: Props) {
  const { manifest, events, requests } = library;
  const started = manifest.startedAt !== null;
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-10 md:grid md:grid-cols-[1fr_16rem] md:gap-x-12">
      <div className="flex min-w-0 flex-col gap-14">
        <header className="flex min-h-9 items-center justify-between gap-4">
          <h1 className="text-xl font-medium">{manifest.product?.name ?? "Library"}</h1>
          {started && <ImportContext library={library} />}
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

        {manifest.components.length > 0 && (
          <section className="flex flex-col gap-6">
            <h2 className="text-sm font-medium text-muted-foreground">Components</h2>
            {manifest.components.map((component) => (
              <ComponentBlock
                key={component.slug}
                component={component}
                view={componentView(component, events, requests)}
                queue={queue}
              />
            ))}
          </section>
        )}
      </div>
      {started && <ImportQueue library={library} />}
    </main>
  );
}
