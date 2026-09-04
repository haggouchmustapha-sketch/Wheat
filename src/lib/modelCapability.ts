/**
 * What the renderer is allowed to offer for a given Wheat AI model.
 *
 * The main process decides what a model can actually do — Ollama's own
 * `capabilities`, OpenRouter's `input_modalities` — and ships that verdict to
 * the renderer as flags on the model row. This module is the single place the
 * interface reads them, so "is the image button visible" and "will the request
 * be accepted" cannot drift apart into two different answers.
 *
 * The rule is deliberately conservative: an absent or unreadable capability
 * reads as "no", never as "probably yes". A control that is absent teaches the
 * user which models take images; a control that is present and then fails
 * teaches them nothing.
 */

/** The subset of a Wheat AI model row the capability rules depend on. */
export type WheatAiModelRow = {
  chatReady?: boolean;
  supportsVision?: boolean;
  supportsTools?: boolean;
} | null | undefined;

/**
 * True when the selected model can be sent an image.
 *
 * `false` for no selection at all, for a model whose engine is not ready, and
 * for any model whose provider has not declared image input.
 */
export function modelAcceptsImages(model: WheatAiModelRow): boolean {
  return model?.chatReady === true && model?.supportsVision === true;
}

/**
 * True when a model can be used to re-read recognised OCR text.
 *
 * The review sends the recognised **text**, never the page images, so any model
 * that can hold a conversation qualifies. Requiring vision here would filter out
 * every ordinary chat model and leave the review picker empty — which is exactly
 * what a capability check in the wrong place looks like from the outside.
 */
export function modelReviewsRecognisedText(model: WheatAiModelRow): boolean {
  return Boolean(model);
}
