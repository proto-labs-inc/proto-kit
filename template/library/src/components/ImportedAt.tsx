import { ExternalLinkIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Manifest } from "@/library";
import { ago, local } from "@/time";

/**
 * When the import ran, beside the button that runs it again: one muted
 * line, coarse enough to read without stopping ("Imported 2 hours ago"),
 * and the detail behind it for whoever wants it. The line is the
 * popover's trigger, so the header stays a name and an action.
 */
export function ImportedAt({ manifest }: { manifest: Manifest }) {
  return (
    <Popover>
      <PopoverTrigger className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
        {line(manifest)}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-xs">
        <Page manifest={manifest} />
        <div className="flex flex-col gap-1.5">
          <Row label="Source">{manifest.source ?? "Not yet known"}</Row>
          <Moment manifest={manifest} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The trigger's own words: what the import is doing, or how long ago it finished. */
function line(manifest: Manifest): string {
  if (manifest.completedAt === null) return "Importing now";
  return `Imported ${ago(manifest.completedAt)}`;
}

/** The page the import read, as the way back to it. */
function Page({ manifest }: { manifest: Manifest }) {
  if (manifest.product === null) return <p className="m-0 text-muted-foreground">Waiting for the product page</p>;
  return (
    <a
      href={manifest.product.pageUrl}
      target="_blank"
      rel="noreferrer"
      className="flex flex-col gap-0.5 hover:underline"
    >
      <span className="flex items-center gap-1 font-medium">
        {manifest.product.pageTitle}
        <ExternalLinkIcon className="size-3 text-muted-foreground" />
      </span>
      <span className="truncate text-muted-foreground">{manifest.product.pageUrl}</span>
    </a>
  );
}

/** The exact moment, in the reader's locale: when it finished, or when it started and is still going. */
function Moment({ manifest }: { manifest: Manifest }) {
  if (manifest.startedAt === null) return null;
  if (manifest.completedAt === null) return <Row label="Running since">{local(manifest.startedAt)}</Row>;
  return <Row label="Imported">{local(manifest.completedAt)}</Row>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate">{children}</span>
    </div>
  );
}
