import { useState } from "react";
import { ArrowUpRightIcon, ClockIcon, GlobeIcon, RotateCwIcon } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { EVERYTHING, type SendOutcome } from "@/courier";
import { importRequested, type Courier, type Library, type Manifest, type Product } from "@/library";
import { servingCopy } from "@/route";
import { ago, elapsed, local } from "@/time";

type Props = { library: Library; courier: Courier };

/**
 * The one sentence under the product's name, read the way a source
 * line under a title is read: when the import ran, the page it read
 * (its icon inline before its title, the way a browser tab or a chat's
 * sources show a page), and, at the end, the way to run it again. The
 * icon is the way into the detail: hovering it opens the page as a
 * card with its address, the exact moment and how long it took, so the
 * header itself stays a name and a sentence.
 */
export function ImportLine({ library, courier }: Props) {
  const { manifest } = library;
  if (manifest.product === null) return null;
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
      <When manifest={manifest} />
      <PageSource product={manifest.product} manifest={manifest} />
      <Again library={library} courier={courier} />
    </p>
  );
}

/** "Importing" while it runs (the word itself moves), else how long ago it finished. */
function When({ manifest }: { manifest: Manifest }) {
  if (manifest.completedAt === null) {
    return (
      <>
        <Shimmer as="span" className="text-foreground">Importing</Shimmer>
        <span>from</span>
      </>
    );
  }
  return <span>Imported {ago(manifest.completedAt)} from</span>;
}

/**
 * The page the import read, as a link with its icon inline. The card
 * that opens from it says the same page in full: its address, and the
 * import's exact moment, in prose.
 */
function PageSource({ product, manifest }: { product: Product; manifest: Manifest }) {
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={250}
        render={<a href={product.pageUrl} target="_blank" rel="noreferrer" />}
        className="inline-flex items-center gap-1.5 font-medium text-foreground hover:underline"
      >
        <Favicon product={product} className="size-4" />
        {product.pageTitle}
        <ArrowUpRightIcon className="size-3.5 text-muted-foreground" />
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 p-3">
        <div className="flex items-center gap-2">
          <Favicon product={product} className="size-5" />
          <div className="min-w-0">
            <div className="truncate font-medium">{product.pageTitle}</div>
            <div className="truncate text-xs text-muted-foreground">{address(product.pageUrl)}</div>
          </div>
        </div>
        <p className="m-0 mt-2.5 text-xs leading-relaxed text-muted-foreground">{moment(manifest)}</p>
      </HoverCardContent>
    </HoverCard>
  );
}

/** The page's own icon; a globe when the page has none. */
function Favicon({ product, className }: { product: Product; className: string }) {
  if (product.favicon === undefined) return <GlobeIcon className={`${className} shrink-0 text-muted-foreground`} />;
  return <img src={product.favicon} alt="" className={`${className} shrink-0 rounded-[3px]`} />;
}

/** "app.meridian.example/expenses": the address without its scheme. */
function address(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** The import's moment in prose: when it ran and how long it took, or since when it has been running, and the codebase read beside the page. */
function moment(manifest: Manifest): string {
  if (manifest.startedAt === null) return "";
  const beside = manifest.source === null ? "" : `, with the ${manifest.source} codebase beside it`;
  if (manifest.completedAt === null) return `Being read since ${local(manifest.startedAt)}${beside}.`;
  return `Read on ${local(manifest.completedAt)} in ${elapsed(manifest.startedAt, manifest.completedAt)}${beside}.`;
}

type Ask = "idle" | "asking" | SendOutcome;

/**
 * The end of the sentence: the way to run the whole import again, in
 * the same words as "Build it" for one component. Not offered while the
 * import runs, nor on the published copy (nothing is behind it to ask).
 * Once asked and not yet taken, the sentence carries the request and
 * the way out of it.
 */
function Again({ library, courier }: Props) {
  const [ask, setAsk] = useState<Ask>("idle");
  const { manifest, requests } = library;
  const send = async (call: Courier["ask"]) => {
    setAsk("asking");
    setAsk(await call(EVERYTHING));
  };
  if (manifest.completedAt === null || servingCopy() === "published") return null;
  if (importRequested(requests)) {
    return (
      <>
        <Dot />
        <span className="inline-flex items-center gap-1.5 text-foreground">
          <ClockIcon className="size-3.5 shrink-0" />
          Importing again next time your agent runs
        </span>
        <Dot />
        <Action onClick={() => send(courier.withdraw)} busy={ask === "asking"}>
          Cancel
        </Action>
      </>
    );
  }
  return (
    <>
      <Dot />
      <Action onClick={() => send(courier.ask)} busy={ask === "asking"}>
        <RotateCwIcon className="size-3.5 shrink-0" />
        Import again
      </Action>
      {ask === "unreachable" && <span className="text-xs">Only the live library can ask; open it from your agent's session.</span>}
    </>
  );
}

function Dot() {
  return <span aria-hidden="true">·</span>;
}

function Action({ onClick, busy, children }: { onClick: () => void; busy: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1.5 text-foreground underline-offset-4 hover:underline disabled:opacity-50"
    >
      {children}
    </button>
  );
}
