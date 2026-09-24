import styles from "./ExpenseTable.module.css";

export type ExpenseStatus = "approved" | "pending" | "flagged";

export interface ExpenseRow {
  merchant: string;
  member: string;
  category: string;
  status: ExpenseStatus;
  amount: string;
}

export interface ExpenseTableProps {
  rows?: ExpenseRow[];
  /** The row (by index) drawn with the hover background, for a library state. */
  hoverRow?: number;
}

const ROWS: ExpenseRow[] = [
  { merchant: "Figma Inc.", member: "Noor K.", category: "Software", status: "pending", amount: "$45.00" },
  { merchant: "United Airlines", member: "Priya S.", category: "Travel", status: "approved", amount: "$612.40" },
  { merchant: "Blue Bottle Coffee", member: "Marcus T.", category: "Meals", status: "flagged", amount: "$83.15" },
  { merchant: "AWS", member: "Platform", category: "Infrastructure", status: "approved", amount: "$2,940.00" },
  { merchant: "Linear", member: "Eng", category: "Software", status: "approved", amount: "$8.00" },
];

const STATUS_LABEL: Record<ExpenseStatus, string> = { approved: "Approved", pending: "Pending", flagged: "Flagged" };

export function ExpenseTable({ rows = ROWS, hoverRow }: ExpenseTableProps) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Merchant</th>
          <th>Member</th>
          <th>Category</th>
          <th>Status</th>
          <th className={styles.right}>Amount</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={5} className={styles.empty}>
              <strong>No expenses yet</strong>
              Card transactions appear here as they settle.
            </td>
          </tr>
        )}
        {rows.map((row, i) => (
          <tr key={`${row.merchant}-${i}`} className={i === hoverRow ? styles.hover : undefined}>
            <td>{row.merchant}</td>
            <td className={styles.muted}>{row.member}</td>
            <td className={styles.muted}>{row.category}</td>
            <td>
              <span className={`${styles.badge} ${styles[row.status]}`}>{STATUS_LABEL[row.status]}</span>
            </td>
            <td className={styles.amount}>{row.amount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default ExpenseTable;
