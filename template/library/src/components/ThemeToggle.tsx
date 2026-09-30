import { MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hasImportedThemePair, type Manifest } from "@/library";
import { usePreviewThemeControl } from "@/theme";

export function ThemeToggle({ manifest }: { manifest: Manifest }) {
  const { theme, setTheme } = usePreviewThemeControl();
  if (!hasImportedThemePair(manifest)) return null;

  const next = theme === "light" ? "dark" : "light";
  const Icon = next === "dark" ? MoonIcon : SunIcon;

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => setTheme(next)}
      aria-label={`Use ${next} theme`}
      className="shrink-0 gap-1.5 text-muted-foreground hover:text-foreground"
    >
      <Icon aria-hidden />
      {next === "dark" ? "Dark" : "Light"}
    </Button>
  );
}
