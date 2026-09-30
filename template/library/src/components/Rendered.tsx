import { Component as ReactComponent, Suspense, lazy, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import type { ComponentState } from "@/library";
import { MODULES } from "@/modules";

/**
 * An imported component, rendered live from its module with a state's
 * props (no iframe: the module's stylesheet is scoped, so the product's
 * styles stay inside it). Modules live at src/components/<slug>/<Slug>.tsx
 * and are found by src/modules.ts, so a new component needs no registry
 * edit; each is imported lazily, so only the components the page shows
 * are loaded and a half-authored one never breaks the page.
 */

const loaded = new Map<string, ComponentType<Record<string, unknown>>>();

function componentFor(module: string): ComponentType<Record<string, unknown>> | null {
  const key = `/${module}`;
  const load = MODULES[key];
  if (!load) return null;
  let component = loaded.get(key);
  if (!component) {
    component = lazy(load);
    loaded.set(key, component);
  }
  return component;
}

type Props = { name: string; module: string | undefined; state: ComponentState };

export function Rendered({ name, module, state }: Props) {
  if (!module) return <Missing what={`${name} has no module yet`} />;
  const Imported = componentFor(module);
  if (!Imported) return <Missing what={`${module} is not in the app`} />;
  return (
    <Boundary key={`${module}:${state.name}`} name={name}>
      <Suspense fallback={<span data-loading={module}><Shimmer className="text-sm">{`Loading ${name}`}</Shimmer></span>}>
        <Imported {...state.props} />
      </Suspense>
    </Boundary>
  );
}

function Missing({ what }: { what: string }) {
  return <p className="m-0 text-sm text-muted-foreground">{what}</p>;
}

type BoundaryState = { error: Error | null };

/** A component that throws shows its error in its own block, not a blank page. */
class Boundary extends ReactComponent<{ name: string; children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.name} threw while rendering`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return <p className="m-0 text-sm text-muted-foreground">{this.props.name} threw while rendering: {this.state.error.message}</p>;
    }
    return this.props.children;
  }
}
