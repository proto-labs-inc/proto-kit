import type { ComponentState } from "@/library";

/** One component state, framed: the product's styles stay inside. */
export function StateFrame({ state, title }: { state: ComponentState; title: string }) {
  return (
    <iframe
      src={state.file}
      title={`${title}: ${state.name}`}
      style={{ height: state.height }}
      className="block w-full rounded-lg bg-white"
      loading="lazy"
    />
  );
}
