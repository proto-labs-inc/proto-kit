import styles from "./Input.module.css";

export interface InputProps {
  label?: string;
  value?: string;
  /** The line under the field: a hint, or the error's message when `error` is set. */
  hint?: string;
  /** Force the focus ring without focus, for a library state. */
  focused?: boolean;
  error?: boolean;
  disabled?: boolean;
}

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

export function Input({
  label = "Merchant",
  value = "Figma Inc.",
  hint = "As it appears on the receipt",
  focused,
  error,
  disabled,
}: InputProps) {
  return (
    <label className={classes(styles.field, error && styles.error)}>
      <span className={styles.label}>{label}</span>
      <input className={classes(styles.input, focused && styles.focused)} defaultValue={value} disabled={disabled} />
      <span className={styles.hint}>{hint}</span>
    </label>
  );
}

export default Input;
