import type { Token } from "@/library";

export function TokenSwatches({ tokens }: { tokens: Token[] }) {
  const groups = new Map<string, Token[]>();
  for (const token of tokens) {
    const list = groups.get(token.group) ?? [];
    list.push(token);
    groups.set(token.group, list);
  }
  return (
    <div className="flex flex-col gap-6">
      {[...groups].map(([group, list]) => (
        <div key={group}>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group}</h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3">
            {list.map((token) => (
              <div key={token.name} className="flex flex-col gap-1.5">
                <div
                  className="h-12 rounded-lg ring-1 ring-foreground/10"
                  style={{ background: token.value }}
                  title={token.value}
                />
                <div className="text-xs leading-tight">
                  <div className="font-medium">{token.name}</div>
                  <div className="text-muted-foreground">
                    {token.value}
                    {token.role && <span className="ml-1">· {token.role}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
