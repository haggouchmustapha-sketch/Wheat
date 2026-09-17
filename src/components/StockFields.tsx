/**
 * The small form and fact components every Stock screen shares.
 *
 * Components only, so Fast Refresh keeps working; the formatting functions they
 * sit beside live in `stockFormat.ts` for the same reason.
 */

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="stock-card__fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function TextField({ label, value, onChange, type = "text", placeholder }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  const id = `field-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="stock-filters__field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function SelectField({ label, value, onChange, children }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  const id = `select-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="stock-filters__field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>{children}</select>
    </div>
  );
}
