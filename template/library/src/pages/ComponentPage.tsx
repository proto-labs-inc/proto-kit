import { useState } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { MatchedView } from "@/components/MatchedView";
import { NotBuilt } from "@/components/NotBuilt";
import { ProductCrop } from "@/components/ProductCrop";
import { Rendered } from "@/components/Rendered";
import { componentView, rebuiltNote, type Component, type ComponentView, type Courier, type Library, type Token } from "@/library";
import { href } from "@/route";

type Props = {
  slug: string;
  /** The state the address names, or null for the default. */
  state: string | null;
  library: Library;
  courier: Courier;
};

export function ComponentPage({ slug, state, library, courier }: Props) {
  const { manifest } = library;
  const component = manifest.components.find((c) => c.slug === slug);
  if (!component) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10 text-sm text-muted-foreground">
        <a href={href.overview()} className="hover:underline">Design system</a> has no component called {slug}.
      </main>
    );
  }
  const view = componentView(component, library);
  const moving = view.kind === "working";
  const note = rebuiltNote(component, manifest.components);
  return (
    <main className="mx-auto grid max-w-5xl gap-10 px-6 py-10 md:grid-cols-[1fr_12rem]">
      <div className="flex min-w-0 flex-col gap-8">
        <header className="flex flex-col gap-3">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink href={href.overview()}>Design system</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{component.name}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <h1 className="text-2xl font-medium">{component.name}</h1>
          {note && <p className="m-0 text-sm text-muted-foreground">{note}</p>}
        </header>
        <States component={component} view={view} state={state} courier={courier} />
        {component.tokens.length > 0 && <Colours component={component} tokens={manifest.tokens} />}
        <MatchedView component={component} library={library} moving={moving} />
      </div>
      <SubNavigation components={manifest.components} current={slug} />
    </main>
  );
}

type StatesProps = { component: Component; view: ComponentView; state: string | null; courier: Courier };

/**
 * The component in each of its states, one tab per state and the state
 * in the address, so "look at the empty table" can be sent; a component
 * with one state shows it without a tab strip. A component that is not
 * built shows the product's own crop and the strip that says why.
 */
function States({ component, view, state, courier }: StatesProps) {
  const [comparing, setComparing] = useState(false);
  if (view.kind !== "preview") {
    return (
      <div className="flex flex-col gap-2">
        <Frame>
          {view.kind === "working" && view.screenshot === null ? (
            <div className="flex h-40 items-center justify-center bg-muted/60">
              <Shimmer className="text-sm">{view.activity}</Shimmer>
            </div>
          ) : (
            <ProductCrop name={component.name} screenshot={view.screenshot} />
          )}
        </Frame>
        <NotBuilt component={component} view={view} courier={courier} />
      </div>
    );
  }
  const names = component.states.map((s) => s.name);
  let current = names[0];
  if (state !== null && names.includes(state)) current = state;
  const show = (name: string) => {
    window.location.hash = href.component(component.slug, name);
  };
  return (
    <div className="flex flex-col gap-4">
      <Tabs value={current} onValueChange={(value) => show(String(value))} className="gap-4">
        {names.length > 1 && (
          <TabsList variant="line">
            {names.map((name) => (
              <TabsTrigger key={name} value={name}>{name}</TabsTrigger>
            ))}
          </TabsList>
        )}
        {component.states.map((look) => (
          <TabsContent key={look.name} value={look.name}>
            <Frame>
              <div className="p-5">
                <Rendered name={component.name} module={component.module} state={look} />
              </div>
            </Frame>
          </TabsContent>
        ))}
      </Tabs>
      {component.screenshot && (
        <div className="flex flex-col gap-2">
          <button type="button" className="self-start text-sm text-muted-foreground hover:text-foreground" onClick={() => setComparing((was) => !was)}>
            {comparing ? "Hide the product's own" : "Compare with the product"}
          </button>
          {comparing && (
            <Frame>
              <ProductCrop name={component.name} screenshot={component.screenshot} />
            </Frame>
          )}
        </div>
      )}
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="overflow-hidden rounded-xl bg-white ring-1 ring-foreground/10">{children}</div>;
}

/** The colours the component is made of, from the palette, each a swatch with its name. */
function Colours({ component, tokens }: { component: Component; tokens: Token[] }) {
  const used = component.tokens.map((name) => tokens.find((t) => t.name === name)).filter((t): t is Token => t !== undefined);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">Colours it uses</h2>
      <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-xs">
        {used.map((token) => (
          <li key={token.name} className="flex items-center gap-2">
            <span className="size-4 rounded ring-1 ring-foreground/10" style={{ background: token.value }} />
            <span className="font-medium">{token.name}</span>
            <span className="text-muted-foreground">{token.value}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SubNavigation({ components, current }: { components: Component[]; current: string }) {
  return (
    <nav className="hidden flex-col gap-1 text-sm md:flex">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Components</span>
      <ScrollArea className="max-h-[70vh]">
        <div className="flex flex-col gap-1">
          {components.map((c) => (
            <a key={c.slug} href={href.component(c.slug)} className={linkClass(c.slug === current)}>{c.name}</a>
          ))}
        </div>
      </ScrollArea>
    </nav>
  );
}

function linkClass(active: boolean): string {
  if (active) return "text-foreground";
  return "text-muted-foreground hover:text-foreground";
}
