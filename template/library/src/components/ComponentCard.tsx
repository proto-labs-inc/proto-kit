import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckIcon, CircleDashedIcon, CircleSlashIcon, ClockIcon, ImageIcon, LoaderCircleIcon } from "lucide-react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Crisp } from "@/components/ProductCrop";
import { Rendered } from "@/components/Rendered";
import { skipHeading, type Component, type ComponentView, type Courier } from "@/library";
import { href } from "@/route";
import type { SendOutcome } from "@/courier";

/**
 * One component on the overview, as a card: the component itself above,
 * its name and where it is below. A built component renders from its own
 * module in its default state. One the import has not built yet sits in
 * the same frame as the product's own picture of it, taken at twice its
 * size, so the page reads as the product's components either way; a
 * quiet mark in the corner says it is a picture, and hovering offers to
 * build it. A component being read has a light passing over its picture,
 * and when it is built the picture develops into the real thing.
 * Everything about why and how lives on the component's page.
 */

type Props = {
  component: Component;
  view: ComponentView;
  courier: Courier;
  justAdded: boolean;
};

type Ask = "idle" | "asking" | SendOutcome;

export function ComponentCard({ component, view, courier, justAdded }: Props) {
  const [ask, setAsk] = useState<Ask>("idle");
  const send = async (call: Courier["ask"]) => {
    setAsk("asking");
    setAsk(await call(component.slug));
  };
  const picture = view.kind !== "preview";
  return (
    <motion.article
      id={component.slug}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className={`group relative flex scroll-mt-8 flex-col overflow-hidden rounded-xl bg-card ring-1 transition-shadow hover:shadow-md ${justAdded ? "ring-2 ring-emerald-500/60" : "ring-foreground/10"}`}
    >
      <a href={href.component(component.slug)} className="absolute inset-0 z-10" aria-label={`Open ${component.name}`} />
      <div className="relative flex h-44 items-center justify-center overflow-hidden bg-white p-5">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={view.kind === "preview" ? "rendered" : "picture"}
            className="flex max-h-full max-w-full items-center justify-center"
            initial={{ opacity: 0, filter: "blur(10px)", scale: 0.98 }}
            animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
            exit={{ opacity: 0, filter: "blur(6px)" }}
            transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
          >
            <Preview component={component} view={view} />
          </motion.div>
        </AnimatePresence>
        {view.kind === "working" && <Light />}
        {picture && view.kind !== "working" && (
          <span className="absolute top-2.5 left-3 flex items-center gap-1 text-[11px] text-muted-foreground">
            <ImageIcon className="size-3" /> Picture
          </span>
        )}
      </div>
      <footer className="flex min-h-11 items-center gap-2 border-t border-border px-3.5 py-2.5 text-sm">
        <Mark view={view} />
        <span className="min-w-0 flex-1 truncate font-medium">{component.name}</span>
        <Aside component={component} view={view} ask={ask} onAsk={() => send(courier.ask)} onWithdraw={() => send(courier.withdraw)} />
      </footer>
    </motion.article>
  );
}

function Preview({ component, view }: { component: Component; view: ComponentView }) {
  if (view.kind === "preview") {
    return <Rendered name={component.name} module={component.module} state={view.state} />;
  }
  if (view.screenshot !== null) return <Crisp src={view.screenshot} alt={`${component.name} in the product`} />;
  // Nothing to show yet: the frame waits at its size.
  return <span className="block h-16 w-40 rounded-md bg-muted" />;
}

/** A light passing over the picture while the import reads it. */
function Light() {
  return (
    <motion.span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 w-1/3"
      style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.7), transparent)" }}
      initial={{ left: "-35%" }}
      animate={{ left: "110%" }}
      transition={{ duration: 1.6, repeat: Infinity, repeatDelay: 0.5, ease: "easeInOut" }}
    />
  );
}

const MARK = "size-3.5 shrink-0";

function Mark({ view }: { view: ComponentView }) {
  switch (view.kind) {
    case "working":
      return <LoaderCircleIcon className={`${MARK} animate-spin text-foreground`} />;
    case "preview":
      return <CheckIcon className={`${MARK} text-emerald-600`} strokeWidth={2.5} />;
    case "pending":
      return <ClockIcon className={`${MARK} text-muted-foreground`} />;
    case "skipped":
      return <CircleSlashIcon className={`${MARK} text-muted-foreground`} />;
  }
}

/** The card's right edge: how many states a built component has, the
 *  import's latest word on one it is reading, and for one it has not
 *  built, the way to ask for it (or to take the ask back). */
function Aside({
  component,
  view,
  ask,
  onAsk,
  onWithdraw,
}: {
  component: Component;
  view: ComponentView;
  ask: Ask;
  onAsk: () => void;
  onWithdraw: () => void;
}) {
  const quiet = "shrink-0 text-xs text-muted-foreground";
  switch (view.kind) {
    case "preview": {
      const count = component.states.length;
      return <span className={quiet}>{count === 1 ? "1 state" : `${count} states`}</span>;
    }
    case "working":
      return (
        <Shimmer as="span" className="max-w-[55%] truncate text-xs">
          {view.activity}
        </Shimmer>
      );
    case "pending":
      if (!view.withdrawable) return <span className={quiet}>Queued</span>;
      return (
        <button type="button" className={`${quiet} relative z-20 hover:text-foreground`} onClick={onWithdraw} disabled={ask === "asking"}>
          Queued · Cancel
        </button>
      );
    case "skipped": {
      if (ask === "unreachable") return <span className={quiet}>Ask from your agent&apos;s session</span>;
      return (
        <span className="relative z-20 flex shrink-0 items-center gap-2 text-xs">
          <span className="text-muted-foreground group-hover:hidden" title={`${skipHeading(view.skipKind)}: ${view.reason}`}>
            Not built yet
          </span>
          <button
            type="button"
            className="hidden items-center gap-1 font-medium text-foreground group-hover:flex"
            onClick={onAsk}
            disabled={ask === "asking"}
          >
            <CircleDashedIcon className="size-3" /> Build it
          </button>
        </span>
      );
    }
  }
}
