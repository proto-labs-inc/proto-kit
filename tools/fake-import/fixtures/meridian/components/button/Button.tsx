import type { ReactNode } from "react";
import styles from "./Button.module.css";

export interface ButtonProps {
  /** The four looks Meridian's buttons come in; primary is the default. */
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "sm";
  /** Force the hover look without a pointer, for a library state. */
  hover?: boolean;
  disabled?: boolean;
  /** Replaces the label with a spinner and disables the button. */
  loading?: boolean;
  children?: ReactNode;
}

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

export function Button({ variant = "primary", size = "md", hover, disabled, loading, children = "Approve expense" }: ButtonProps) {
  return (
    <button
      type="button"
      className={classes(styles.button, styles[variant], size === "sm" && styles.sm, hover && styles.hover, loading && styles.loading)}
      disabled={disabled || loading}
    >
      {loading && <span className={styles.spinner} aria-hidden="true" />}
      <span className={styles.label}>{children}</span>
    </button>
  );
}

export default Button;
