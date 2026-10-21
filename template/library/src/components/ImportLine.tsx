import { useState } from "react";
import { ClockIcon, RotateCwIcon } from "lucide-react";
import { EVERYTHING, type SendOutcome } from "@/queue-client";
import { importRequested, type RequestQueue, type Library, type Manifest } from "@/library";
import { servingCopy } from "@/route";
import { ago } from "@/time";

type Props = { library: Library; requestQueue: RequestQueue };

/** Import status and the action to run it again. */
export function ImportLine({ library, requestQueue }: Props) {
  const { manifest } = library;
  if (manifest.product === null) return null;
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
      <When manifest={manifest} />
      <Again library={library} requestQueue={requestQueue} />
    </p>
  );
}

/** "Importing" while it runs (with static status text), else how long ago it finished. */
function When({ manifest }: { manifest: Manifest }) {
  if (manifest.completedAt === null) {
    return (
      <span className="text-foreground">Importing</span>
    );
  }
  return <span>Imported {ago(manifest.completedAt)}</span>;
}

type Ask = "idle" | "asking" | SendOutcome;

/**
 * The end of the sentence: the way to run the whole import again, in
 * the same words as "Build it" for one component. Not offered while the
 * import runs, nor on the published copy (nothing is behind it to ask).
 * Once asked and not yet taken, the sentence carries the request and
 * the way out of it.
 */
function Again({ library, requestQueue }: Props) {
  const [ask, setAsk] = useState<Ask>("idle");
  const { manifest, requests } = library;
  const send = async (call: RequestQueue["ask"]) => {
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
        <Action onClick={() => send(requestQueue.withdraw)} busy={ask === "asking"}>
          Cancel
        </Action>
      </>
    );
  }
  return (
    <>
      <Dot />
      <Action onClick={() => send(requestQueue.ask)} busy={ask === "asking"}>
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
