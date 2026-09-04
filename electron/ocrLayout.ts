/**
 * Geometry layer for Wheat's document pipeline.
 *
 * Recognition returns text elements with polygons and per-element confidence.
 * Reading order alone destroys what an accounting document actually says: on a
 * two-column totals block the recogniser emits "Total HT", "4 500,00",
 * "T.V.A 20%", "900,00" — but on the invoice next to it the same block comes
 * back as "DEBOURS", "Total HT", "2 555,00", "T.V.A 20%", "5 300,00", because
 * one label lost its value to a line break. Flattened to a string the two are
 * indistinguishable; with coordinates they are not.
 *
 * This module keeps the coordinates and exposes the relations a parser needs —
 * which elements share a row, what sits to the right of a label, which lines
 * form one address block — without knowing anything about accounting. The
 * semantic layer lives in `ocrFieldExtraction.ts`.
 *
 * Documents that carry no geometry at all (a digital PDF text layer, a CSV)
 * still go through here: each text line becomes a row whose elements are the
 * whitespace-separated runs, so every caller works against one model.
 */

export type LayoutBox = { x0: number; y0: number; x1: number; y1: number };

export type LayoutElement = {
  /** Stable within one layout; used to reference evidence from a field. */
  id: string;
  page: number;
  /** Position in the recogniser's reading order, across the whole document. */
  order: number;
  text: string;
  /** Accent-free lowercase form used for every label comparison. */
  normalized: string;
  /** 0-100, straight from the recogniser. */
  confidence: number;
  box: LayoutBox | null;
  /** Index of the row this element was grouped into, within its page. */
  row: number;
};

export type LayoutRow = {
  page: number;
  index: number;
  /** Vertical band of the row's anchor element, not of the whole row. */
  top: number;
  bottom: number;
  elements: LayoutElement[];
  /** Elements joined left to right; what a human reads on that line. */
  text: string;
};

export type LayoutPage = {
  page: number;
  width: number;
  height: number;
  elements: LayoutElement[];
  rows: LayoutRow[];
  /** Median element height; the unit every vertical tolerance is expressed in. */
  lineHeight: number;
  hasGeometry: boolean;
};

export type DocumentLayout = {
  pages: LayoutPage[];
  elements: LayoutElement[];
  rows: LayoutRow[];
  /** Rows joined top to bottom: the document as a human would read it. */
  text: string;
  /** False when nothing carried coordinates and only line order is available. */
  hasGeometry: boolean;
};

export type RecognizedElement = {
  text: string;
  confidence?: number;
  page?: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number } | null;
};

export type RecognizedPage = {
  page: number;
  text: string;
  confidence: number;
  words?: RecognizedElement[];
  width?: number;
  height?: number;
};

/** Combining diacritical marks (U+0300-U+036F). */
const DIACRITICS = new RegExp("[̀-ͯ]", "g");

/** Zero-width and bidirectional control characters an OCR pass can emit. */
const INVISIBLE = new RegExp("[​-‏‪-‮﻿]", "g");

export function normalizeLabel(value: string) {
  return value
    .normalize("NFKD")
    .replace(DIACRITICS, "")
    .replace(INVISIBLE, "")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .trim();
}

/** Label form with every separator removed, so "T.V.A" matches "tva". */
export function compactLabel(value: string) {
  return normalizeLabel(value).replace(/[^a-z0-9]/g, "");
}

export const boxHeight = (box: LayoutBox) => Math.max(1, box.y1 - box.y0);
export const boxWidth = (box: LayoutBox) => Math.max(1, box.x1 - box.x0);
export const centerY = (box: LayoutBox) => (box.y0 + box.y1) / 2;
export const centerX = (box: LayoutBox) => (box.x0 + box.x1) / 2;

/** Shared vertical extent as a fraction of the shorter box. */
export function verticalOverlap(left: LayoutBox, right: LayoutBox) {
  const shared = Math.min(left.y1, right.y1) - Math.max(left.y0, right.y0);
  return shared <= 0 ? 0 : shared / Math.min(boxHeight(left), boxHeight(right));
}

/** Shared horizontal extent as a fraction of the narrower box. */
export function horizontalOverlap(left: LayoutBox, right: LayoutBox) {
  const shared = Math.min(left.x1, right.x1) - Math.max(left.x0, right.x0);
  return shared <= 0 ? 0 : shared / Math.min(boxWidth(left), boxWidth(right));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Groups elements into rows.
 *
 * Each row keeps the band of the element that opened it rather than the union
 * of everything added to it. A growing band chains: on a totals block whose
 * value column sits half a line below its label column, every label and every
 * value ends up in one row and the association that follows becomes
 * meaningless. Measuring against a fixed anchor keeps "Total HT / 4 500,00"
 * one row and "T.V.A 20% / 900,00" the next, which is what the page shows.
 */
function buildRows(page: number, elements: LayoutElement[], lineOf?: Map<LayoutElement, number>): LayoutRow[] {
  const positioned = elements.filter((element) => element.box);
  if (!positioned.length) {
    // Without coordinates the source line is the row. Keeping it — rather than
    // making every element its own row — is what lets a footer that packs ICE,
    // RC, TP and CNSS onto one line still be read as one line.
    const byLine = new Map<number, LayoutElement[]>();
    for (const [index, element] of elements.entries()) {
      const line = lineOf?.get(element) ?? index;
      byLine.set(line, [...(byLine.get(line) ?? []), element]);
    }
    return [...byLine.entries()].sort((left, right) => left[0] - right[0]).map(([, members], index) => {
      for (const member of members) member.row = index;
      return { page, index, top: index, bottom: index, elements: members, text: members.map((member) => member.text).join(" ") };
    });
  }

  const ordered = [...positioned].sort((left, right) => centerY(left.box!) - centerY(right.box!) || left.box!.x0 - right.box!.x0);
  const groups: Array<{ anchor: LayoutBox; members: LayoutElement[] }> = [];
  for (const element of ordered) {
    const box = element.box!;
    const host = groups.find((group) => verticalOverlap(group.anchor, box) >= 0.45);
    if (host) host.members.push(element);
    else groups.push({ anchor: box, members: [element] });
  }

  return groups.map((group, index) => {
    const members = group.members.sort((left, right) => (left.box?.x0 ?? 0) - (right.box?.x0 ?? 0));
    for (const member of members) member.row = index;
    return {
      page,
      index,
      top: group.anchor.y0,
      bottom: group.anchor.y1,
      elements: members,
      text: members.map((member) => member.text).join(" ").replace(/\s+/g, " ").trim(),
    };
  });
}

/**
 * One number, with the thousands spaces it is allowed to contain.
 *
 * A space only continues a number when exactly three digits follow it, which is
 * what separates "75 000.00" (one amount) from "83.33 1100 75 000.00" (a unit
 * price, a quantity and a line total that a greedy pattern would weld into a
 * single meaningless figure).
 */
const NUMBER_RUN = /\d[\d.,']*(?:\s\d{3}(?!\d))*(?:[.,]\d{1,2})?/g;

/**
 * Splits a text-layer line into elements.
 *
 * A digital PDF prints "Montant H.T 75 000.00" as one line: the label and its
 * value are already side by side, and there is no geometry to separate them.
 * Cutting at every number recovers the columns — with one exception, a number
 * immediately followed by a percent sign, which is part of its label ("T.V.A
 * 20%") and not a value of its own.
 */
function splitTextLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  const columns = trimmed.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
  return (columns.length > 1 ? columns : [trimmed]).flatMap(splitNumberRuns);
}

function splitNumberRuns(part: string): string[] {
  const parts: string[] = [];
  let buffer = "";
  let cursor = 0;
  NUMBER_RUN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NUMBER_RUN.exec(part)) !== null) {
    const before = part.slice(cursor, match.index);
    cursor = NUMBER_RUN.lastIndex;
    const after = part.slice(cursor);
    const previous = part[match.index - 1] ?? "";
    // Digits glued to a letter or a separator are one token with what surrounds
    // them: "25/07/2026" is a date, "B26/00741" a delivery-note number and
    // "T.V.A 20%" a rate — cutting any of them at the digits destroys it.
    const bound = /[A-Za-z/-]/.test(previous) || /^\s*%/.test(after) || /^[/-]\d/.test(after);
    if (bound) {
      const percent = /^\s*%/.exec(after);
      buffer += `${before}${match[0]}${percent?.[0] ?? ""}`;
      cursor += percent?.[0].length ?? 0;
      continue;
    }
    buffer += before;
    if (buffer.trim()) parts.push(buffer.trim());
    buffer = "";
    parts.push(match[0].trim());
  }
  const tail = `${buffer}${part.slice(cursor)}`.trim();
  if (tail) parts.push(tail);
  return parts.length ? parts : [part];
}

function elementFrom(page: number, order: number, text: string, confidence: number, box: LayoutBox | null): LayoutElement {
  const cleaned = text.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  return {
    id: `p${page}e${order}`,
    page,
    order,
    text: cleaned,
    normalized: normalizeLabel(cleaned),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence))) : 0,
    box,
    row: -1,
  };
}

/**
 * Builds one layout out of the recognised pages.
 *
 * Pages that carry element boxes keep them. Pages that do not — a PDF text
 * layer, a CSV, a spreadsheet — are turned into rows from their text lines, so
 * a caller never has to ask which kind of document it is holding.
 */
export function buildDocumentLayout(pages: RecognizedPage[]): DocumentLayout {
  const layoutPages: LayoutPage[] = [];
  let order = 0;

  for (const source of pages) {
    const pageNo = Math.max(1, Math.round(source.page) || 1);
    const positioned = (source.words ?? []).filter((word) => word.text?.trim() && word.bbox
      && Number.isFinite(word.bbox.x0) && Number.isFinite(word.bbox.y0)
      && word.bbox.x1 > word.bbox.x0 && word.bbox.y1 > word.bbox.y0);

    const elements: LayoutElement[] = [];
    const lineOf = new Map<LayoutElement, number>();
    if (positioned.length >= 3) {
      for (const word of positioned) {
        const box = { x0: word.bbox!.x0, y0: word.bbox!.y0, x1: word.bbox!.x1, y1: word.bbox!.y1 };
        const element = elementFrom(pageNo, order += 1, word.text, word.confidence ?? source.confidence, box);
        if (element.text) elements.push(element);
      }
    } else {
      for (const [lineNo, line] of source.text.split(/\r?\n/).entries()) {
        for (const part of splitTextLine(line)) {
          const element = elementFrom(pageNo, order += 1, part, source.confidence, null);
          if (!element.text) continue;
          elements.push(element);
          lineOf.set(element, lineNo);
        }
      }
    }

    const rows = buildRows(pageNo, elements, lineOf);
    const boxes = elements.map((element) => element.box).filter((box): box is LayoutBox => Boolean(box));
    layoutPages.push({
      page: pageNo,
      width: source.width ?? (boxes.length ? Math.max(...boxes.map((box) => box.x1)) : 1000),
      height: source.height ?? (boxes.length ? Math.max(...boxes.map((box) => box.y1)) : Math.max(1, rows.length)),
      elements,
      rows,
      lineHeight: median(boxes.map(boxHeight)) || 1,
      hasGeometry: boxes.length > 0,
    });
  }

  const rows = layoutPages.flatMap((page) => page.rows);
  return {
    pages: layoutPages,
    elements: layoutPages.flatMap((page) => page.elements),
    rows,
    text: rows.map((row) => row.text).filter(Boolean).join("\n"),
    hasGeometry: layoutPages.some((page) => page.hasGeometry),
  };
}

export function pageOf(layout: DocumentLayout, element: LayoutElement) {
  return layout.pages.find((page) => page.page === element.page) ?? layout.pages[0];
}

export type LayoutZone = "HEADER" | "BODY" | "FOOTER";

/** Where an element sits on its page; letterheads and footers matter. */
export function zoneOf(layout: DocumentLayout, element: LayoutElement): LayoutZone {
  const page = pageOf(layout, element);
  if (!element.box || !page?.height) {
    const index = layout.rows.findIndex((row) => row.elements.includes(element));
    const ratio = layout.rows.length ? index / layout.rows.length : 0.5;
    return ratio <= 0.22 ? "HEADER" : ratio >= 0.82 ? "FOOTER" : "BODY";
  }
  const ratio = centerY(element.box) / page.height;
  return ratio <= 0.22 ? "HEADER" : ratio >= 0.82 ? "FOOTER" : "BODY";
}

export type ValueRelation = "SAME_ROW" | "RIGHT_OF" | "BELOW";

export type ValueCandidate = {
  element: LayoutElement;
  /** Vertical centre distance expressed in line heights; smaller is better. */
  verticalDistance: number;
  /** Horizontal gap in line heights, measured from the label's right edge. */
  horizontalDistance: number;
  relation: ValueRelation;
};

/**
 * Elements that could be the value of `label`.
 *
 * Three relations are offered, in the order an invoice actually uses them: on
 * the same row, further right on a neighbouring row, or directly underneath in
 * the same column. Each keeps its distances so the caller can weigh a close
 * match against a far one instead of taking the first hit in reading order —
 * which is how "TVA" once ended up holding the HT total printed on the line
 * above it.
 */
export function valueCandidates(
  layout: DocumentLayout,
  label: LayoutElement,
  accept: (element: LayoutElement) => boolean,
  options: { maxVertical?: number; maxHorizontal?: number; includeBelow?: boolean; maxBelow?: number } = {},
): ValueCandidate[] {
  const page = pageOf(layout, label);
  const unit = page?.lineHeight || 1;
  const maxVertical = options.maxVertical ?? 1.6;
  const maxHorizontal = options.maxHorizontal ?? 40;
  const candidates: ValueCandidate[] = [];

  if (!label.box || !page?.hasGeometry) {
    // No geometry: the row is the line, and a value can only follow its label
    // on that line or open the next one.
    const rowIndex = layout.rows.findIndex((row) => row.elements.includes(label));
    const nearby = [layout.rows[rowIndex], layout.rows[rowIndex + 1]];
    for (const [offset, row] of nearby.entries()) {
      if (!row) continue;
      const after = offset === 0 ? row.elements.slice(row.elements.indexOf(label) + 1) : row.elements;
      for (const element of after) {
        if (!accept(element)) continue;
        candidates.push({
          element,
          verticalDistance: offset,
          horizontalDistance: 0,
          relation: offset === 0 ? "SAME_ROW" : "BELOW",
        });
      }
    }
    return candidates;
  }

  const labelBox = label.box;
  for (const element of page.elements) {
    if (element === label || !element.box || !accept(element)) continue;
    const box = element.box;
    const vertical = Math.abs(centerY(box) - centerY(labelBox)) / unit;
    const rightOf = box.x0 >= labelBox.x1 - unit * 0.5;
    const horizontal = (box.x0 - labelBox.x1) / unit;

    if (rightOf && vertical <= maxVertical && horizontal <= maxHorizontal) {
      candidates.push({
        element,
        verticalDistance: vertical,
        horizontalDistance: Math.max(0, horizontal),
        relation: element.row === label.row ? "SAME_ROW" : "RIGHT_OF",
      });
      continue;
    }
    if (options.includeBelow && box.y0 >= labelBox.y1 - unit * 0.3 && horizontalOverlap(box, labelBox) >= 0.25) {
      const below = (centerY(box) - centerY(labelBox)) / unit;
      if (below > 0 && below <= (options.maxBelow ?? 3)) {
        candidates.push({ element, verticalDistance: below, horizontalDistance: 0, relation: "BELOW" });
      }
    }
  }

  return candidates.sort((left, right) =>
    left.verticalDistance - right.verticalDistance || left.horizontalDistance - right.horizontalDistance);
}

/**
 * Grows a block of lines around an anchor element.
 *
 * An address block is not a rectangle the recogniser hands over: it is the
 * company name, the street and the ICE line, printed one under the other in the
 * same column. Growing outwards from an anchor — an identifier, usually — while
 * every added element still overlaps the block's horizontal span keeps the
 * neighbouring column out, which is what separates the customer's ICE from the
 * supplier's on an invoice that prints both.
 */
export function growBlock(
  layout: DocumentLayout,
  anchor: LayoutElement,
  options: { maxGap?: number; minOverlap?: number; maxElements?: number; anchorRelative?: boolean } = {},
): LayoutElement[] {
  const page = pageOf(layout, anchor);
  if (!anchor.box || !page?.hasGeometry) {
    const index = layout.rows.findIndex((row) => row.elements.includes(anchor));
    return layout.rows.slice(Math.max(0, index - 3), index + 2).flatMap((row) => row.elements);
  }

  const unit = page.lineHeight || 1;
  const maxGap = (options.maxGap ?? 4) * unit;
  const minOverlap = options.minOverlap ?? 0.2;
  const maxElements = options.maxElements ?? 12;

  const members = [anchor];
  let span = { ...anchor.box };
  while (members.length < maxElements) {
    // Overlap is measured against the anchor's own column, not the column the
    // block has grown into. Letting the span widen turns one neighbour in the
    // next column into a bridge, and the customer's address block swallows the
    // line-item table that starts underneath it.
    const reference = options.anchorRelative === false ? span : anchor.box;
    const next = page.elements
      .filter((element) => !members.includes(element) && element.box)
      .map((element) => ({
        element,
        gap: Math.max(span.y0 - element.box!.y1, element.box!.y0 - span.y1, 0),
        overlap: horizontalOverlap(element.box!, reference),
      }))
      .filter((entry) => entry.gap <= maxGap && entry.overlap >= minOverlap)
      .sort((left, right) => left.gap - right.gap)[0];
    if (!next) break;
    members.push(next.element);
    span = {
      x0: Math.min(span.x0, next.element.box!.x0),
      y0: Math.min(span.y0, next.element.box!.y0),
      x1: Math.max(span.x1, next.element.box!.x1),
      y1: Math.max(span.y1, next.element.box!.y1),
    };
  }

  return members.sort((left, right) => (left.box?.y0 ?? 0) - (right.box?.y0 ?? 0));
}

/**
 * Grows several blocks at once, letting them compete for the lines between them.
 *
 * Growing one block at a time is wrong whenever a page carries two of them, and
 * an invoice always does: the supplier's footer and the customer's address
 * both reach for the paragraph printed between them, whichever is grown first
 * swallows it, and the two blocks end up merged into a single party holding one
 * company's name and the other's ICE.
 *
 * Here every line is claimed exactly once, by the block that reaches it with
 * the smallest gap, so the boundary falls where the page actually puts it.
 */
export function growCompetingBlocks(
  layout: DocumentLayout,
  anchors: LayoutElement[],
  options: { maxGap?: number; minOverlap?: number; maxElements?: number } = {},
): Map<LayoutElement, LayoutElement[]> {
  const result = new Map<LayoutElement, LayoutElement[]>();
  if (!anchors.length) return result;

  const claimed = new Set<LayoutElement>();
  const spans = new Map<LayoutElement, LayoutBox>();
  for (const anchor of anchors) {
    result.set(anchor, [anchor]);
    claimed.add(anchor);
    if (anchor.box) spans.set(anchor, { ...anchor.box });
  }

  const positioned = anchors.every((anchor) => anchor.box) && layout.pages.some((page) => page.hasGeometry);
  if (!positioned) {
    for (const anchor of anchors) {
      const index = layout.rows.findIndex((row) => row.elements.includes(anchor));
      result.set(anchor, layout.rows.slice(Math.max(0, index - 3), index + 2).flatMap((row) => row.elements));
    }
    return result;
  }

  const minOverlap = options.minOverlap ?? 0.25;
  const maxElements = options.maxElements ?? 12;

  for (;;) {
    let best: { anchor: LayoutElement; element: LayoutElement; gap: number; overlap: number; unit: number } | null = null;
    for (const anchor of anchors) {
      const members = result.get(anchor)!;
      if (members.length >= maxElements) continue;
      const page = pageOf(layout, anchor);
      const unit = page?.lineHeight || 1;
      const maxGap = (options.maxGap ?? 4) * unit;
      const span = spans.get(anchor)!;
      for (const element of page?.elements ?? []) {
        if (claimed.has(element) || !element.box) continue;
        const overlap = horizontalOverlap(element.box, anchor.box!);
        if (overlap < minOverlap) continue;
        const gap = Math.max(span.y0 - element.box.y1, element.box.y0 - span.y1, 0);
        if (gap > maxGap) continue;
        // A line belongs to the column it is aligned with. Once a block has
        // grown down to a row, everything on that row is at distance zero from
        // it, so distance alone would let the letterhead swallow the customer's
        // name printed beside it. A block that overlaps the line better, and
        // can still reach it, has the stronger claim.
        const betterAligned = anchors.some((other) => {
          if (other === anchor || !other.box || other.page !== element.page) return false;
          if ((result.get(other)?.length ?? 0) >= maxElements) return false;
          if (horizontalOverlap(element.box!, other.box) <= overlap) return false;
          const otherSpan = spans.get(other)!;
          const otherGap = Math.max(otherSpan.y0 - element.box!.y1, element.box!.y0 - otherSpan.y1, 0);
          return otherGap <= maxGap;
        });
        if (betterAligned) continue;
        // Two blocks reaching the same line from the same distance — the
        // customer's address sitting between the letterhead and the customer's
        // own ICE — are separated by which column the line is actually aligned
        // with, not by which anchor happened to be considered first.
        const nearer = !best || gap < best.gap - Math.min(unit, best.unit) * 0.25;
        const equallyNear = best && Math.abs(gap - best.gap) <= Math.min(unit, best.unit) * 0.25;
        if (nearer || (equallyNear && overlap > best!.overlap)) best = { anchor, element, gap, overlap, unit };
      }
    }
    if (!best) break;
    claimed.add(best.element);
    result.get(best.anchor)!.push(best.element);
    const span = spans.get(best.anchor)!;
    spans.set(best.anchor, {
      x0: Math.min(span.x0, best.element.box!.x0),
      y0: Math.min(span.y0, best.element.box!.y0),
      x1: Math.max(span.x1, best.element.box!.x1),
      y1: Math.max(span.y1, best.element.box!.y1),
    });
  }

  for (const [anchor, members] of result) {
    result.set(anchor, members.sort((left, right) => (left.box?.y0 ?? left.order) - (right.box?.y0 ?? right.order)));
  }
  return result;
}

/** Union of the boxes of several elements, for evidence highlighting. */
export function unionBox(elements: LayoutElement[]): LayoutBox | null {
  const boxes = elements.map((element) => element.box).filter((box): box is LayoutBox => Boolean(box));
  if (!boxes.length) return null;
  return {
    x0: Math.min(...boxes.map((box) => box.x0)),
    y0: Math.min(...boxes.map((box) => box.y0)),
    x1: Math.max(...boxes.map((box) => box.x1)),
    y1: Math.max(...boxes.map((box) => box.y1)),
  };
}
