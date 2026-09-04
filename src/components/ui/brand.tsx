/**
 * Wheat brand marks.
 *
 * The artwork is the official material from `Wheat Design/`, derived once by
 * `scripts/make-wheat-assets.cjs` into transparent, aspect-ratio-preserving
 * PNGs under `public/brand/`. Nothing here recolours, stretches or redraws
 * the supplied assets — only the rendered box size changes.
 *
 *   main light.png  -> wheat-logo-light.png  (light mode)
 *   Main Dark.png   -> wheat-logo-dark.png   (dark mode)
 *   Wheat AI.png    -> wheat-ai.png          (Wheat AI feature icon)
 */

export function WheatMark({ size = 34, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={className ? `wt-mark ${className}` : "wt-mark"} style={{ width: size, height: size }} aria-hidden="true">
      <img className="wt-mark__light" src="brand/wheat-logo-light.png" alt="" />
      <img className="wt-mark__dark" src="brand/wheat-logo-dark.png" alt="" />
    </span>
  );
}

export function WheatAiMark({ size = 20, className = "", title }: { size?: number; className?: string; title?: string }) {
  return (
    <img
      className={className ? `wt-ai-mark ${className}` : "wt-ai-mark"}
      src="brand/wheat-ai.png"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
    />
  );
}

export function WheatWordmark({ children = "Wheat" }: { children?: string }) {
  return <span className="wheat-wordmark">{children}</span>;
}
