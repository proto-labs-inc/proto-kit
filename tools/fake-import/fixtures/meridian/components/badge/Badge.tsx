import styles from "./Badge.module.css";

export type BadgeTone = "approved" | "pending" | "flagged" | "reimbursed";

export interface BadgeProps {
  tone?: BadgeTone;
  children?: string;
}

const LABELS: Record<BadgeTone, string> = {
  approved: "Approved",
  pending: "Pending review",
  flagged: "Flagged",
  reimbursed: "Reimbursed",
};

export function Badge({ tone = "approved", children }: BadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[tone]}`}>
      <span className={styles.dot} aria-hidden="true" />
      {children ?? LABELS[tone]}
    </span>
  );
}

export default Badge;
