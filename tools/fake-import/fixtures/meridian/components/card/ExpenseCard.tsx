import styles from "./ExpenseCard.module.css";

export interface ExpenseCardProps {
  merchant?: string;
  amount?: string;
  /** Category, date and card, as one line: "Software & SaaS · Sep 16 · Card ··4921". */
  meta?: string;
  status?: string;
  member?: { initials: string; name: string };
  /** The card as chosen in a list: indigo ring and border. */
  selected?: boolean;
  /** Force the hover lift without a pointer, for a library state. */
  hover?: boolean;
}

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

export function ExpenseCard({
  merchant = "Figma Inc.",
  amount = "$45.00",
  meta = "Software & SaaS · Sep 16 · Card ··4921",
  status = "Pending review",
  member = { initials: "NK", name: "Noor K." },
  selected,
  hover,
}: ExpenseCardProps) {
  return (
    <article className={classes(styles.card, selected && styles.selected, hover && styles.hover)}>
      <div className={styles.row}>
        <span className={styles.merchant}>{merchant}</span>
        <span className={styles.amount}>{amount}</span>
      </div>
      <div className={styles.meta}>{meta}</div>
      <div className={styles.foot}>
        <span className={styles.badge}>{status}</span>
        <span className={styles.who}>
          <span className={styles.avatar}>{member.initials}</span>
          {member.name}
        </span>
      </div>
    </article>
  );
}

export default ExpenseCard;
