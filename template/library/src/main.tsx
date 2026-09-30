import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PreviewThemeProvider } from "./theme";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PreviewThemeProvider>
      <App />
    </PreviewThemeProvider>
  </StrictMode>,
);
