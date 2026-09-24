import { ExternalLinkIcon } from "lucide-react";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextTrigger,
} from "@/components/ai-elements/context";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { coverage, latestActivity, progress, type Library } from "@/library";
import { clock, elapsed } from "@/time";

/**
 * What the import read, in the header: the AI Elements Context element
 * with the source as its trigger and the import's progress as its ring.
 * Hovering shows the product page, the source, and the times.
 */
export function ImportContext({ library }: { library: Library }) {
  const { manifest, events } = library;
  const running = manifest.completedAt === null;
  return (
    <Context {...progress(library)}>
      <ContextTrigger className="-mr-2">{manifest.source ?? "Import"}</ContextTrigger>
      <ContextContent align="end" className="w-80">
        <ContextContentHeader>
          {manifest.product ? (
            <a
              href={manifest.product.pageUrl}
              target="_blank"
              rel="noreferrer"
              className="flex flex-col gap-0.5 text-xs hover:underline"
            >
              <span className="flex items-center gap-1 font-medium">
                {manifest.product.pageTitle}
                <ExternalLinkIcon className="size-3 text-muted-foreground" />
              </span>
              <span className="truncate text-muted-foreground">{manifest.product.pageUrl}</span>
            </a>
          ) : (
            <p className="text-xs text-muted-foreground">Waiting for the product page</p>
          )}
        </ContextContentHeader>
        <ContextContentBody className="flex flex-col gap-1.5 text-xs">
          <Row label="Source">{manifest.source ?? "Not yet known"}</Row>
          <Row label="Started">{manifest.startedAt ? clock(manifest.startedAt) : "Not yet"}</Row>
          <Finished startedAt={manifest.startedAt} completedAt={manifest.completedAt} />
        </ContextContentBody>
        <ContextContentFooter>
          {running ? <Shimmer as="span">{latestActivity(events) ?? "Starting the import"}</Shimmer> : <span className="text-muted-foreground">{coverage(library)}</span>}
        </ContextContentFooter>
      </ContextContent>
    </Context>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate">{children}</span>
    </div>
  );
}

function Finished({ startedAt, completedAt }: { startedAt: string | null; completedAt: string | null }) {
  if (startedAt === null) return null;
  if (completedAt === null) return <Row label="Running for">{elapsed(startedAt, new Date().toISOString())}</Row>;
  return (
    <Row label="Finished">
      {clock(completedAt)}, {elapsed(startedAt, completedAt)}
    </Row>
  );
}
