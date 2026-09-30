import { MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePreviewThemeControl } from "@/theme";

export function ThemeToggle() {
  const { theme, setTheme } = usePreviewThemeControl();
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
