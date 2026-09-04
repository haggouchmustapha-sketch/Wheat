import {
  forwardRef,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { useAccessibleDialog } from "../../lib/useAccessibleDialog";
import { issueExplanation, issueMessage, type WheatIssue } from "../../lib/wheatIssues";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  HelpCircle,
  Info,
  Inbox,
  Lightbulb,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";

/**
 * Wheat 2.0 UI kit.
 *
 * Every screen composes from these primitives so spacing, hierarchy, focus
 * behaviour, semantic feedback and the light/dark identity stay identical
 * across the whole application. All styling lives in `src/styles/*.css` and
 * resolves through the design tokens — nothing here hard-codes a colour.
 */

/* ------------------------------------------------------------------ Buttons */

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "soft"
  | "danger"
  | "danger-outline"
  | "link";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  busy?: boolean;
  block?: boolean;
  icon?: ReactNode;
  trailingIcon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", busy = false, block = false, icon, trailingIcon, className, children, disabled, type = "button", ...rest },
  ref,
) {
  const classes = [
    "wt-btn",
    `wt-btn--${variant}`,
    size !== "md" ? `wt-btn--${size}` : "",
    block ? "wt-btn--block" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button ref={ref} type={type} className={classes} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <span className="wt-btn__spinner" aria-hidden="true" /> : icon}
      {children}
      {!busy && trailingIcon}
    </button>
  );
});

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  bordered?: boolean;
  size?: "sm" | "md";
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, bordered = false, size = "md", className, children, type = "button", ...rest },
  ref,
) {
  const classes = ["wt-icon-btn", bordered ? "wt-icon-btn--bordered" : "", size === "sm" ? "wt-icon-btn--sm" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button ref={ref} type={type} className={classes} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
});

/* ------------------------------------------------------------------- Badges */

export type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

export function Badge({ tone = "neutral", children, dot = false }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`wt-badge wt-badge--${tone}`}>
      {dot && <span className="wt-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------- Cards */

export function Card({
  title,
  note,
  icon,
  actions,
  children,
  footer,
  flush = false,
  accent = false,
  className,
  id,
}: {
  title?: ReactNode;
  note?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  accent?: boolean;
  className?: string;
  id?: string;
}) {
  const headingId = useId();
  return (
    <section
      id={id}
      className={["wt-card", accent ? "wt-card--accent" : "", className ?? ""].filter(Boolean).join(" ")}
      aria-labelledby={title ? headingId : undefined}
    >
      {(title || actions) && (
        <header className="wt-card__head">
          {icon && <span className="wt-card__icon">{icon}</span>}
          <div className="wt-card__head-text">
            {title && (
              <h3 className="wt-card__title" id={headingId}>
                {title}
              </h3>
            )}
            {note && <p className="wt-card__note">{note}</p>}
          </div>
          {actions && <div className="wt-card__head-actions">{actions}</div>}
        </header>
      )}
      {children !== undefined && <div className={flush ? "wt-card__body wt-card__body--flush" : "wt-card__body"}>{children}</div>}
      {footer && <footer className="wt-card__foot">{footer}</footer>}
    </section>
  );
}

export function Section({
  title,
  note,
  actions,
  children,
  id,
}: {
  title: ReactNode;
  note?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  const headingId = useId();
  return (
    <section className="wt-section" id={id} aria-labelledby={headingId}>
      <div className="wt-section__head">
        <div className="wt-section__heading">
          <h2 className="wt-section__title" id={headingId}>
            {title}
          </h2>
          {note && <p className="wt-card__note">{note}</p>}
        </div>
        {actions && <div className="wt-row">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------- Fields */

export function Field({
  label,
  hint,
  error,
  required = false,
  optional = false,
  htmlFor,
  tip,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  optional?: boolean;
  htmlFor?: string;
  tip?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={["wt-field", className ?? ""].filter(Boolean).join(" ")}>
      {/* The required marker, the "facultatif" hint and the tooltip sit beside
          the <label>, never inside it: anything inside would be folded into the
          control's accessible name and read out with every field. */}
      <span className="wt-field__label-row">
        <label className="wt-field__label" htmlFor={htmlFor}>
          {label}
        </label>
        {required && (
          <span className="wt-field__required" aria-hidden="true">
            *
          </span>
        )}
        {optional && <span className="wt-field__optional">facultatif</span>}
        {tip && <InfoTip text={tip} />}
      </span>
      {children}
      {hint && !error && <span className="wt-field__hint">{hint}</span>}
      {error && (
        <span className="wt-field__error" role="alert">
          <AlertCircle size={13} aria-hidden="true" />
          {error}
        </span>
      )}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="wt-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="wt-switch__track">
        <span className="wt-switch__thumb" />
      </span>
      <span className="wt-checkbox__text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
    </button>
  );
}

/* ---------------------------------------------------------------- Help / tips */

/**
 * A single-sentence plain-language explanation attached to accounting
 * terminology. Wheat keeps the correct term and explains it here rather than
 * replacing it with an approximation.
 */
export function InfoTip({ text, align = "center" }: { text: string; align?: "center" | "end" }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span
      className="wt-tip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="wt-tip__button"
        aria-label={text}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
      >
        <HelpCircle size={14} aria-hidden="true" />
      </button>
      {open && (
        <span className={align === "end" ? "wt-tip__bubble wt-tip__bubble--end" : "wt-tip__bubble"} id={id} role="tooltip">
          {text}
        </span>
      )}
    </span>
  );
}

/**
 * The small information affordance beside anything Wheat refuses, questions or
 * repaired on its own.
 *
 * The primary message stays one short line - an accountant scanning a list of
 * rejected rows should not have to read a paragraph per row. Everything the
 * check already knew (the offending value, the rule, the remedy) sits behind
 * this control, reachable by hover, by keyboard focus and by click, so it works
 * outside a mouse as well.
 */
export function IssueInfo({ issue }: { issue: WheatIssue }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const explanation = issueExplanation(issue);
  return (
    <span
      className="wt-tip wt-issue__info"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="wt-tip__button"
        aria-label={`Explication : ${issue.message}`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
      >
        <Info size={14} aria-hidden="true" />
      </button>
      {open && (
        <span className="wt-tip__bubble wt-tip__bubble--issue" id={id} role="tooltip">
          {explanation}
          {issue.technical && (
            <span className="wt-issue__technical">Détail technique : {issue.technical}</span>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * A list of checked findings. Deliberately the only way a screen renders a set
 * of blockers or review points, so the explanation affordance can never be
 * present on one screen and missing on the next.
 */
export function IssueList({ issues, emptyText }: { issues: WheatIssue[]; emptyText?: string }) {
  if (!issues.length) return emptyText ? <p className="wt-hint">{emptyText}</p> : null;
  return (
    <ul className="wt-issue-list">
      {issues.map((issue, index) => (
        <li className="wt-issue" key={`${issue.code}-${issue.context ?? ""}-${index}`}>
          <span className="wt-issue__message">{issueMessage(issue)}</span>
          <IssueInfo issue={issue} />
        </li>
      ))}
    </ul>
  );
}

export function Explainer({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="wt-explainer">
      {icon ?? <Lightbulb size={16} aria-hidden="true" />}
      <div>{children}</div>
    </div>
  );
}

/** Collapsed "how this screen works" help — always visible, never required. */
export function HelpDisclosure({ summary, children, defaultOpen = false }: { summary: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="wt-disclosure" open={defaultOpen}>
      <summary>
        <ChevronRight size={15} aria-hidden="true" />
        {summary}
      </summary>
      <div className="wt-disclosure__content">{children}</div>
    </details>
  );
}

/* ---------------------------------------------------------------- Callouts */

export function Callout({
  tone = "info",
  title,
  children,
  actions,
  icon,
  className,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  const fallbackIcon =
    tone === "danger" ? <AlertCircle size={17} /> : tone === "warning" ? <AlertTriangle size={17} /> : tone === "success" ? <CheckCircle2 size={17} /> : <Info size={17} />;
  return (
    <div className={`wt-callout wt-callout--${tone}${className ? ` ${className}` : ""}`} role={tone === "danger" ? "alert" : undefined}>
      {icon ?? fallbackIcon}
      <div className="wt-callout__body">
        {title && <span className="wt-callout__title">{title}</span>}
        {children}
        {actions && <div className="wt-callout__actions">{actions}</div>}
      </div>
    </div>
  );
}

/* ----------------------------------------------------- Empty/loading/error */

export function EmptyState({
  icon,
  title,
  text,
  actions,
  tone = "neutral",
}: {
  icon?: ReactNode;
  title: ReactNode;
  text?: ReactNode;
  actions?: ReactNode;
  tone?: "neutral" | "brand";
}) {
  return (
    <div className={tone === "brand" ? "wt-state wt-state--brand" : "wt-state"}>
      <span className="wt-state__icon">{icon ?? <Inbox size={22} aria-hidden="true" />}</span>
      <h3 className="wt-state__title">{title}</h3>
      {text && <p className="wt-state__text">{text}</p>}
      {actions && <div className="wt-state__actions">{actions}</div>}
    </div>
  );
}

export function LoadingState({ label = "Chargement…", rows = 0 }: { label?: string; rows?: number }) {
  if (rows > 0) {
    return (
      <div className="wt-stack wt-stack--tight" role="status" aria-live="polite" aria-busy="true">
        <span className="wt-visually-hidden">{label}</span>
        {Array.from({ length: rows }).map((_, index) => (
          <span key={index} className="wt-skeleton wt-skeleton--line" />
        ))}
      </div>
    );
  }
  return (
    <div className="wt-loading" role="status" aria-live="polite">
      <span className="wt-loading__spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/**
 * Error state. `cause` explains *why* it happened and `fix` says what the user
 * can do about it — never a bare stack trace.
 */
export function ErrorState({
  title = "Cette action n'a pas abouti",
  cause,
  fix,
  onRetry,
  retryLabel = "Réessayer",
  actions,
}: {
  title?: ReactNode;
  cause?: ReactNode;
  fix?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="wt-state wt-state--error" role="alert">
      <span className="wt-state__icon">
        <AlertTriangle size={22} aria-hidden="true" />
      </span>
      <h3 className="wt-state__title">{title}</h3>
      {cause && <p className="wt-state__text">{cause}</p>}
      {fix && <p className="wt-state__text">{fix}</p>}
      <div className="wt-state__actions">
        {onRetry && (
          <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={onRetry}>
            {retryLabel}
          </Button>
        )}
        {actions}
      </div>
    </div>
  );
}

export function InlineLoading({ label }: { label: string }) {
  return (
    <span className="wt-row" role="status" aria-live="polite" style={{ gap: "var(--space-4)", color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
      <Loader2 size={14} className="wt-spin" aria-hidden="true" />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------- Stats */

export function Stat({
  label,
  value,
  note,
  tip,
  delta,
  icon,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  tip?: string;
  delta?: { direction: "up" | "down"; text: string };
  icon?: ReactNode;
}) {
  return (
    <div className="wt-stat">
      <span className="wt-stat__label">
        {icon}
        {label}
        {tip && <InfoTip text={tip} />}
      </span>
      <span className="wt-stat__value">{value}</span>
      {delta && <span className={`wt-stat__delta wt-stat__delta--${delta.direction}`}>{delta.text}</span>}
      {note && <span className="wt-stat__note">{note}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ Dialogs */

/**
 * Modal dialog with a focus trap, Escape-to-close and a restored focus target.
 * Every dialog states its purpose in `note` so a confirmation never asks the
 * user to guess what is about to happen.
 */
export function Dialog({
  title,
  note,
  icon,
  size = "md",
  onClose,
  children,
  footer,
  footerNote,
  labelledBy,
  closeLabel = "Fermer",
  className,
}: {
  title: ReactNode;
  note?: ReactNode;
  icon?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  footerNote?: ReactNode;
  labelledBy?: string;
  closeLabel?: string;
  className?: string;
}) {
  const titleId = useId();
  // Escape, focus containment, focus restoration and scroll locking come from
  // the same helper every other Wheat modal uses. Keeping a second, private
  // implementation here meant two independent dialog stacks: with the shared
  // review surface open over an entry form, both handled Escape and the one
  // registered first won — the form closed and the review stayed up.
  const dialogRef = useAccessibleDialog<HTMLDivElement>(onClose);

  return (
    <div className="wt-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        className={`wt-dialog${size !== "md" ? ` wt-dialog--${size}` : ""}${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? titleId}
        tabIndex={-1}
      >
        <header className="wt-dialog__head">
          {icon && <span className="wt-card__icon">{icon}</span>}
          <div className="wt-dialog__head-text">
            <h2 className="wt-dialog__title" id={titleId}>
              {title}
            </h2>
            {note && <p className="wt-dialog__note">{note}</p>}
          </div>
          <IconButton label={closeLabel} onClick={onClose}>
            <X size={17} aria-hidden="true" />
          </IconButton>
        </header>
        <div className="wt-dialog__body">{children}</div>
        {(footer || footerNote) && (
          <footer className="wt-dialog__foot">
            {footerNote && <span className="wt-dialog__foot-note">{footerNote}</span>}
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

/** Confirmation dialog: says what will happen, to what, and whether it is reversible. */
export function ConfirmDialog({
  title,
  question,
  consequence,
  reversible,
  confirmLabel = "Confirmer",
  cancelLabel = "Annuler",
  tone = "primary",
  busy = false,
  onConfirm,
  onClose,
  children,
}: {
  title: ReactNode;
  question: ReactNode;
  consequence?: ReactNode;
  reversible?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog
      title={title}
      note={question}
      size="sm"
      onClose={onClose}
      footerNote={reversible}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} busy={busy} onClick={() => void onConfirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {consequence && <Callout tone={tone === "danger" ? "danger" : "info"}>{consequence}</Callout>}
      {children}
    </Dialog>
  );
}

/* --------------------------------------------------------------- Page shell */

export type GuideItem = { icon: ReactNode; title: string; text: string };

/**
 * Every Wheat page opens with the same three answers:
 *   1. what this screen is for (`purpose`)
 *   2. what the primary action is (`actions`, first button)
 *   3. what else lives here (`guide`) and what to do next (`nextStep`)
 */
export function PageHeader({
  icon,
  title,
  purpose,
  actions,
  meta,
  guide,
  help,
}: {
  icon?: ReactNode;
  title: ReactNode;
  purpose: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  guide?: GuideItem[];
  help?: { summary: string; content: ReactNode };
}) {
  return (
    <header className="wt-page-header">
      <div className="wt-page-header__top">
        {icon && <span className="wt-page-header__icon">{icon}</span>}
        <div className="wt-page-header__text">
          <h1 className="wt-page-header__title">{title}</h1>
          <p className="wt-page-header__purpose">{purpose}</p>
          {meta && <div className="wt-page-header__meta">{meta}</div>}
        </div>
        {actions && <div className="wt-page-header__actions">{actions}</div>}
      </div>
      {guide && guide.length > 0 && (
        <div className="wt-guide">
          {guide.map((item) => (
            <div className="wt-guide__item" key={item.title}>
              {item.icon}
              <span className="wt-guide__item-text">
                <strong>{item.title}</strong>
                <span>{item.text}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {help && <HelpDisclosure summary={help.summary}>{help.content}</HelpDisclosure>}
    </header>
  );
}

export function NextStep({
  title,
  text,
  action,
  icon,
}: {
  title: ReactNode;
  text: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="wt-nextstep">
      <span className="wt-nextstep__icon">{icon ?? <ArrowRight size={18} aria-hidden="true" />}</span>
      <span className="wt-nextstep__text">
        <strong>{title}</strong>
        <span>{text}</span>
      </span>
      {action}
    </div>
  );
}

/** Large, labelled entry point for a feature — used so nothing hides in a menu. */
export function FeatureTile({
  icon,
  title,
  description,
  cta,
  onClick,
  disabled = false,
  badge,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  cta: string;
  onClick: () => void;
  disabled?: boolean;
  badge?: ReactNode;
}) {
  return (
    <button type="button" className="wt-feature" onClick={onClick} disabled={disabled}>
      <span className="wt-feature__head">
        {icon}
        <strong>{title}</strong>
        {badge}
      </span>
      <span className="wt-feature__desc">{description}</span>
      <span className="wt-feature__cta">
        {cta}
        <ArrowRight size={14} aria-hidden="true" />
      </span>
    </button>
  );
}

/* --------------------------------------------------------------------- Tabs */

export type TabItem = { id: string; label: string; note?: string; icon?: ReactNode; count?: number };

export function Tabs({
  items,
  value,
  onChange,
  ariaLabel,
  variant = "underline",
}: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  variant?: "underline" | "cards";
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = items.findIndex((item) => item.id === value);
    if (index < 0) return;
    let next: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    onChange(items[next].id);
    listRef.current?.querySelectorAll<HTMLElement>("[role='tab']")[next]?.focus();
  };

  return (
    <div
      ref={listRef}
      className={variant === "cards" ? "wt-tabs wt-tabs--cards" : "wt-tabs"}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          id={`wt-tab-${item.id}`}
          aria-selected={item.id === value}
          aria-controls={`wt-tabpanel-${item.id}`}
          tabIndex={item.id === value ? 0 : -1}
          className="wt-tab"
          onClick={() => onChange(item.id)}
        >
          {item.icon}
          <span>
            {item.label}
            {variant === "cards" && item.note && <small>{item.note}</small>}
          </span>
          {typeof item.count === "number" && <span className="wt-tab__count">{item.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`wt-tabpanel-${id}`} aria-labelledby={`wt-tab-${id}`} tabIndex={0} className="wt-stack">
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------- Search */

export function SearchInput({
  value,
  onChange,
  placeholder = "Rechercher…",
  ariaLabel,
  onEnter,
  trailing,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  onEnter?: () => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="wt-search">
      <SearchGlyph />
      <input
        type="search"
        value={value}
        aria-label={ariaLabel ?? placeholder}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onEnter) onEnter();
        }}
      />
      {value && (
        <IconButton label="Effacer la recherche" size="sm" onClick={() => onChange("")}>
          <X size={14} aria-hidden="true" />
        </IconButton>
      )}
      {trailing}
    </div>
  );
}

function SearchGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

/* -------------------------------------------------------------------- Table */

export function TableWrap({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="wt-table-wrap table-wrap" role={label ? "region" : undefined} aria-label={label} tabIndex={label ? 0 : undefined}>
      {children}
    </div>
  );
}

export { AlertTriangle as WheatAlertIcon };
