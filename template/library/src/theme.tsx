import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";

export const INTERNAL_PREVIEW_THEME_PARAM = "__protoTheme";
export type PreviewTheme = "light" | "dark";

type ThemeContextValue = {
  theme: PreviewTheme;
  setTheme: (theme: PreviewTheme) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  setTheme: () => undefined,
});

function systemTheme(): PreviewTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function initialTheme(): PreviewTheme {
  const value = new URLSearchParams(window.location.search).get(INTERNAL_PREVIEW_THEME_PARAM);
  if (value === "light" || value === "dark") return value;
  return systemTheme();
}

function paintTheme(theme: PreviewTheme) {
  const root = document.documentElement;
  root.dataset.protoTheme = theme;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

export function PreviewThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<PreviewTheme>(() => initialTheme());

  const chooseTheme = useCallback((next: PreviewTheme) => {
    setTheme(next);
    const url = new URL(window.location.href);
    url.searchParams.set(INTERNAL_PREVIEW_THEME_PARAM, next);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  useLayoutEffect(() => paintTheme(theme), [theme]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemTheme = () => {
      const value = new URLSearchParams(window.location.search).get(INTERNAL_PREVIEW_THEME_PARAM);
      if (value !== "light" && value !== "dark") setTheme(systemTheme());
    };
    media.addEventListener("change", onSystemTheme);
    return () => media.removeEventListener("change", onSystemTheme);
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme: chooseTheme }}>{children}</ThemeContext.Provider>;
}

export function usePreviewTheme(): PreviewTheme {
  return useContext(ThemeContext).theme;
}

export function usePreviewThemeControl(): ThemeContextValue {
  return useContext(ThemeContext);
}
