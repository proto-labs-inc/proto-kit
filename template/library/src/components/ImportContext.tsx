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
import { importInProgress, latestActivity, type Library } from "@/library";
import { clock, elapsed } from "@/time";

/**
 * What the import read, in the header: the AI Elements Context element
 * with the source as its trigger and the import's progress as its ring.
 * Hovering shows the product page, the source, and the times.
 */
export function ImportContext({ library }: { library: Library }) {
  const { manifest, events } = library;
  const settled = manifest.components.filter((c) => c.status === "done" || c.status === "skipped").length;
  const running = importInProgress(library);
  return (
    <Context done={settled} total={manifest.components.length}>
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
          <Footer running={running} activity={latestActivity(events)} />
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

function Footer({ running, activity }: { running: boolean; activity: string | null }) {
  if (!running) return <span className="text-muted-foreground">Import complete</span>;
  return <Shimmer as="span">{activity ?? "Starting the import"}</Shimmer>;
}
