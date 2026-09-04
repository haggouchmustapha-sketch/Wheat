import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ChevronDown, Loader2, Search, SearchX, X } from "lucide-react";

/**
 * WheatSelect — the single dropdown used across Wheat 2.0.
 *
 * Every list that can grow (accounts, companies, journals, documents, models,
 * periods, counterparties, bank accounts…) gets an integrated search bar,
 * keyboard navigation, a visible focus ring, an explicit selected state and
 * dedicated loading / error / no-result states.
 *
 * It never changes the value handed back to the application: `onChange`
 * receives exactly the `value` string carried by the chosen option, and an
 * optional hidden input keeps native form submission identical.
 *
 * Small selectors (fewer than `SEARCH_THRESHOLD` options) render without the
 * search bar so a two- or three-option choice stays a single click.
 */

const SEARCH_THRESHOLD = 8;

export type WheatSelectOption = {
  /** Submitted value — identical to what the previous <select> emitted. */
  value: string;
  label: string;
  /** Secondary line shown under the label (account class, IBAN, period…). */
  note?: string;
  /** Extra text matched by the search box but not displayed. */
  keywords?: string;
  /** Optional group heading. Options keep their given order inside a group. */
  group?: string;
  disabled?: boolean;
  badge?: ReactNode;
};

export type WheatSelectProps = {
  options: WheatSelectOption[];
  value?: string | null;
  onChange: (value: string) => void;
  id?: string;
  /** Accessible name when no visible <label> is wired through `id`. */
  ariaLabel?: string;
  labelledBy?: string;
  describedBy?: string;
  placeholder?: string;
  searchPlaceholder?: string;
  /** Message shown when the search matches nothing. */
  emptyLabel?: string;
  emptyHint?: string;
  /** Message shown when `options` is empty and nothing is loading. */
  noOptionsLabel?: string;
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  error?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
  allowClear?: boolean;
  clearLabel?: string;
  invalid?: boolean;
  required?: boolean;
  /** Force the search bar on or off. Defaults to `options.length >= 8`. */
  searchable?: boolean;
  /** Rendering cap — the rest stay reachable through the search box. */
  maxVisible?: number;
  className?: string;
  /** Renders a hidden input so existing <form> submissions are unchanged. */
  name?: string;
  footerNote?: string;
  size?: "sm" | "md";
};

/** Combining diacritical marks (U+0300–U+036F), stripped so "société" matches "société". */
const DIACRITICS = new RegExp("[\u0300-\u036f]", "g");

const normalize = (value: string) =>
  value
    .toLocaleLowerCase("fr-FR")
    .normalize("NFD")
    .replace(DIACRITICS, "");

type OptionRow = { key: string; option: WheatSelectOption; index: number };
type Row =
  | { kind: "group"; key: string; label: string; options: OptionRow[] }
  | ({ kind: "option" } & OptionRow);

export function WheatSelect({
  options,
  value,
  onChange,
  id,
  ariaLabel,
  labelledBy,
  describedBy,
  placeholder = "Sélectionner…",
  searchPlaceholder = "Rechercher…",
  emptyLabel = "Aucun résultat",
  emptyHint = "Vérifiez l'orthographe ou effacez la recherche.",
  noOptionsLabel = "Aucune option disponible",
  disabled = false,
  loading = false,
  loadingLabel = "Chargement des options…",
  error = null,
  onRetry,
  retryLabel = "Réessayer",
  allowClear = false,
  clearLabel = "Effacer la sélection",
  invalid = false,
  required = false,
  searchable,
  maxVisible = 120,
  className,
  name,
  footerNote,
  size = "md",
}: WheatSelectProps) {
  const reactId = useId();
  const triggerId = id ?? `wt-select-${reactId}`;
  const panelId = `${triggerId}-panel`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<{ top: number; left: number; width: number; maxHeight: number; above: boolean } | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const showSearch = searchable ?? (options.length >= SEARCH_THRESHOLD || loading || Boolean(error));
  const selected = useMemo(() => options.find((option) => option.value === value) ?? null, [options, value]);

  const filtered = useMemo(() => {
    const needle = normalize(query.trim());
    if (!needle) return options;
    const terms = needle.split(/\s+/).filter(Boolean);
    return options.filter((option) => {
      const haystack = normalize(`${option.label} ${option.note ?? ""} ${option.keywords ?? ""} ${option.value}`);
      return terms.every((term) => haystack.includes(term));
    });
  }, [options, query]);

  const visible = useMemo(() => filtered.slice(0, maxVisible), [filtered, maxVisible]);
  const hiddenCount = filtered.length - visible.length;

  // Grouped options are nested inside a real `role="group"` so assistive
  // technology announces the heading with its members, rather than reading a
  // loose label that happens to precede them.
  const rows = useMemo<Row[]>(() => {
    const output: Row[] = [];
    let current: Extract<Row, { kind: "group" }> | null = null;
    visible.forEach((option, index) => {
      const row: OptionRow = { key: `option-${option.value}-${index}`, option, index };
      if (!option.group) {
        current = null;
        output.push({ kind: "option", ...row });
        return;
      }
      if (!current || current.label !== option.group) {
        current = { kind: "group", key: `group-${option.group}-${index}`, label: option.group, options: [] };
        output.push(current);
      }
      current.options.push(row);
    });
    return output;
  }, [visible]);

  const selectableIndexes = useMemo(
    () => visible.map((option, index) => (option.disabled ? -1 : index)).filter((index) => index >= 0),
    [visible],
  );

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    // Keep a comfortable margin so the panel never sits flush against the
    // window edge, at any window size.
    const viewportPadding = 16;
    const spaceBelow = window.innerHeight - rect.bottom;
    const desired = Math.min(340, Math.max(180, visible.length * 44 + (showSearch ? 52 : 0) + 16));
    const above = spaceBelow < desired + 16 && rect.top > spaceBelow;
    const availableWidth = Math.max(1, window.innerWidth - viewportPadding * 2);
    const width = Math.min(Math.max(rect.width, Math.min(220, availableWidth)), availableWidth);
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
    );
    const availableHeight = above ? rect.top - viewportPadding - 6 : window.innerHeight - rect.bottom - viewportPadding - 6;
    const maxHeight = Math.max(72, Math.min(340, availableHeight));
    const next = {
      top: above ? Math.max(viewportPadding, rect.top - Math.min(desired, maxHeight) - 6) : rect.bottom + 6,
      left,
      width,
      maxHeight,
      above,
    };
    // Only commit a genuinely different box. Re-setting an identical position
    // would re-render the panel on every scroll event, and a panel that keeps
    // re-rendering never settles for an assistive tool — or a click.
    setPosition((current) =>
      current
        && current.top === next.top
        && current.left === next.left
        && current.width === next.width
        && current.maxHeight === next.maxHeight
        && current.above === next.above
        ? current
        : next,
    );
  }, [showSearch, visible.length]);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return undefined;
    const reposition = (event?: Event) => {
      // Scrolling the option list itself must not move the panel.
      if (event && event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      measure();
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, measure]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const initial = value ? visible.findIndex((option) => option.value === value) : -1;
    setActiveIndex(initial >= 0 ? initial : selectableIndexes[0] ?? 0);
    const frame = window.requestAnimationFrame(() => {
      if (showSearch) searchRef.current?.focus();
      else listRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
    // Intentionally keyed on `open` only: reopening re-seeds the highlight.
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const commit = useCallback(
    (option: WheatSelectOption) => {
      if (option.disabled) return;
      onChange(option.value);
      close();
    },
    [onChange, close],
  );

  const moveActive = useCallback(
    (direction: 1 | -1) => {
      if (!selectableIndexes.length) return;
      const currentPosition = selectableIndexes.indexOf(activeIndex);
      const nextPosition =
        currentPosition < 0
          ? direction === 1
            ? 0
            : selectableIndexes.length - 1
          : (currentPosition + direction + selectableIndexes.length) % selectableIndexes.length;
      setActiveIndex(selectableIndexes[nextPosition]);
    },
    [activeIndex, selectableIndexes],
  );

  const onPanelKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveActive(-1);
        break;
      case "Home":
        event.preventDefault();
        if (selectableIndexes.length) setActiveIndex(selectableIndexes[0]);
        break;
      case "End":
        event.preventDefault();
        if (selectableIndexes.length) setActiveIndex(selectableIndexes[selectableIndexes.length - 1]);
        break;
      case "Enter": {
        event.preventDefault();
        const option = visible[activeIndex];
        if (option) commit(option);
        break;
      }
      case "Escape":
        event.preventDefault();
        close();
        break;
      case "Tab":
        close(false);
        break;
      default:
        break;
    }
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
    }
  };

  const renderOption = ({ key, option, index }: OptionRow) => (
    <button
      key={key}
      type="button"
      id={`${panelId}-option-${index}`}
      data-index={index}
      data-value={option.value}
      role="option"
      aria-selected={option.value === value}
      aria-disabled={option.disabled || undefined}
      className={`wt-select__option${index === activeIndex ? " is-active" : ""}`}
      onMouseEnter={() => setActiveIndex(index)}
      onClick={() => commit(option)}
      tabIndex={-1}
    >
      <span className="wt-select__option-text">
        <span className="wt-select__option-label">{option.label}</span>
        {option.note && <span className="wt-select__option-note">{option.note}</span>}
      </span>
      {option.badge && <span className="wt-select__option-badge">{option.badge}</span>}
      {option.value === value && <Check size={15} className="wt-select__option-check" aria-hidden="true" />}
    </button>
  );

  const activeOptionId = open && visible[activeIndex] ? `${panelId}-option-${activeIndex}` : undefined;
  const triggerLabel = selected?.label ?? placeholder;

  const updateQuery = (nextQuery: string) => {
    setQuery(nextQuery);
    const needle = normalize(nextQuery.trim());
    const nextVisible = (needle
      ? options.filter((option) => {
          const terms = needle.split(/\s+/).filter(Boolean);
          const haystack = normalize(`${option.label} ${option.note ?? ""} ${option.keywords ?? ""} ${option.value}`);
          return terms.every((term) => haystack.includes(term));
        })
      : options
    ).slice(0, maxVisible);
    const firstEnabled = nextVisible.findIndex((option) => !option.disabled);
    setActiveIndex(firstEnabled >= 0 ? firstEnabled : 0);
  };

  const panel = open && position ? (
    <div
      ref={panelRef}
      id={panelId}
      // The panel is portalled onto <body>. This marker tells a dialog's focus
      // containment that the panel still belongs to the surface that opened it.
      data-wheat-portal="select"
      className="wt-select__panel"
      style={{ position: "fixed", top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}
      onKeyDown={onPanelKeyDown}
    >
      {showSearch && (
        <div className="wt-select__search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={`${panelId}-list`}
            aria-activedescendant={activeOptionId}
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button
              type="button"
              className="wt-select__search-clear"
              onClick={() => {
                updateQuery("");
                searchRef.current?.focus();
              }}
              aria-label="Effacer la recherche"
            >
              <X size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {/* The state blocks sit beside the listbox rather than replacing it: the
          trigger and the search bar both point at the list through
          `aria-controls`, and that reference must never dangle. An empty
          listbox plus a live status region is what a screen reader expects. */}
      {error ? (
        <div className="wt-select__state wt-select__state--error" role="alert">
          <AlertTriangle size={20} aria-hidden="true" />
          <strong>Chargement impossible</strong>
          <span>{error}</span>
          {onRetry && (
            <button type="button" className="wt-btn wt-btn--secondary wt-btn--sm" onClick={onRetry}>
              {retryLabel}
            </button>
          )}
        </div>
      ) : loading ? (
        <div className="wt-select__state" role="status">
          <Loader2 size={20} className="wt-spin" aria-hidden="true" />
          <span>{loadingLabel}</span>
        </div>
      ) : !options.length ? (
        <div className="wt-select__state" role="status">
          <SearchX size={20} aria-hidden="true" />
          <strong>{noOptionsLabel}</strong>
        </div>
      ) : !visible.length ? (
        <div className="wt-select__state" role="status">
          <SearchX size={20} aria-hidden="true" />
          <strong>{emptyLabel}</strong>
          <span>{emptyHint}</span>
        </div>
      ) : null}

      <ul
        ref={listRef}
        id={`${panelId}-list`}
        className="wt-select__list"
        role="listbox"
        tabIndex={-1}
        aria-label={labelledBy ? undefined : ariaLabel ?? placeholder}
        aria-labelledby={labelledBy}
        aria-activedescendant={activeOptionId}
      >
        {rows.map((row) =>
          row.kind === "group" ? (
            <li key={row.key} role="group" aria-label={row.label}>
              <span className="wt-select__group-label" aria-hidden="true">{row.label}</span>
              {row.options.map(renderOption)}
            </li>
          ) : (
            renderOption(row)
          ),
        )}
      </ul>

      {(hiddenCount > 0 || footerNote) && !loading && !error && (
        <div className="wt-select__foot">
          <span>{footerNote}</span>
          {hiddenCount > 0 && <span>{hiddenCount} autre(s) — affinez la recherche</span>}
        </div>
      )}
    </div>
  ) : null;

  return (
    <div className={className ? `wt-select ${className}` : "wt-select"}>
      <div className="wt-select__control">
        <button
          ref={triggerRef}
          type="button"
          id={triggerId}
          className={`wt-select__trigger${allowClear && selected && !disabled ? " has-clear" : ""}`}
          style={size === "sm" ? { minHeight: "var(--control-height-sm)", fontSize: "var(--text-sm)" } : undefined}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? `${panelId}-list` : undefined}
          aria-label={ariaLabel}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          aria-required={required || undefined}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={onTriggerKeyDown}
        >
          <span className={selected ? "wt-select__value" : "wt-select__value wt-select__value--placeholder"}>
            {loading && !selected ? loadingLabel : triggerLabel}
            {selected?.note && <span className="wt-select__value-note">{selected.note}</span>}
          </span>
          <ChevronDown size={16} className="wt-select__caret" aria-hidden="true" />
        </button>
        {allowClear && selected && !disabled && (
          <button
            type="button"
            className="wt-select__clear"
            aria-label={clearLabel}
            onClick={() => {
              onChange("");
              triggerRef.current?.focus();
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      {name && <input type="hidden" name={name} value={value ?? ""} />}
      {panel && createPortal(panel, document.body)}
    </div>
  );
}
