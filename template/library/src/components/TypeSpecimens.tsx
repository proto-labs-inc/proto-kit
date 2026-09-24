import type { TypeStyle } from "@/library";

export function TypeSpecimens({ styles }: { styles: TypeStyle[] }) {
  return (
    <div className="flex flex-col divide-y divide-border">
      {styles.map((style) => (
        <div key={style.name} className="grid gap-1 py-4 md:grid-cols-[10rem_1fr] md:gap-6">
          <div className="text-xs leading-relaxed text-muted-foreground">
            <div className="font-medium text-foreground">{style.name}</div>
            <div>
              {style.family} {style.weight}
            </div>
            <div>
              {style.size} / {style.lineHeight}
            </div>
          </div>
          <p
            className="m-0"
            style={{
              fontFamily: `"${style.family}", ui-sans-serif, system-ui, sans-serif`,
              fontSize: style.size,
              fontWeight: style.weight,
              lineHeight: style.lineHeight,
            }}
          >
            {style.sample}
          </p>
        </div>
      ))}
    </div>
  );
}
