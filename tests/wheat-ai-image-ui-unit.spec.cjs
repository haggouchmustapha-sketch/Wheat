const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * The Wheat AI image-attachment control and the OCR review picker.
 *
 * The behavioural half is unit-tested through the shared capability rule the
 * renderer uses; the structural half is a source guard, because the value of
 * these rules is precisely that no screen re-implements them locally.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

let capability;

test.beforeAll(() => {
  capability = tsxRequire(path.join(root, "src", "lib", "modelCapability.ts"), __filename);
});

const VISION_PROVIDER_MODEL = { chatReady: true, supportsVision: true, supportsTools: true };
const TEXT_PROVIDER_MODEL = { chatReady: true, supportsVision: false, supportsTools: true };
const VISION_OLLAMA_MODEL = { chatReady: true, supportsVision: true, supportsTools: false };
const TEXT_OLLAMA_MODEL = { chatReady: true, supportsVision: false, supportsTools: false };

test("image upload is offered for a vision-capable model, provider or local", () => {
  expect(capability.modelAcceptsImages(VISION_PROVIDER_MODEL)).toBe(true);
  expect(capability.modelAcceptsImages(VISION_OLLAMA_MODEL)).toBe(true);
});

test("image upload is withheld for a text-only model, provider or local", () => {
  expect(capability.modelAcceptsImages(TEXT_PROVIDER_MODEL)).toBe(false);
  expect(capability.modelAcceptsImages(TEXT_OLLAMA_MODEL)).toBe(false);
});

test("image upload is withheld when no model is selected or the engine is not ready", () => {
  expect(capability.modelAcceptsImages(null)).toBe(false);
  expect(capability.modelAcceptsImages(undefined)).toBe(false);
  expect(capability.modelAcceptsImages({ supportsVision: true })).toBe(false);
  expect(capability.modelAcceptsImages({ chatReady: true })).toBe(false);
  // An unreadable capability reads as "no", never as "probably yes".
  expect(capability.modelAcceptsImages({ chatReady: true, supportsVision: "yes" })).toBe(false);
});

test("changing model changes the answer immediately, with no cached state", () => {
  // The control is derived from the selected row on every render: switching
  // from a vision model to a text-only one flips the answer at once.
  let selected = VISION_OLLAMA_MODEL;
  expect(capability.modelAcceptsImages(selected)).toBe(true);
  selected = TEXT_OLLAMA_MODEL;
  expect(capability.modelAcceptsImages(selected)).toBe(false);
  selected = VISION_PROVIDER_MODEL;
  expect(capability.modelAcceptsImages(selected)).toBe(true);
});

test("OCR review accepts any chat model because it reviews recognised text", () => {
  expect(capability.modelReviewsRecognisedText(TEXT_OLLAMA_MODEL)).toBe(true);
  expect(capability.modelReviewsRecognisedText(TEXT_PROVIDER_MODEL)).toBe(true);
  expect(capability.modelReviewsRecognisedText(null)).toBe(false);
});

/* --------------------------------------------------------- source guards -- */

test("the Wheat AI composer derives the attachment control from the shared rule", () => {
  const source = read("src", "components", "FiscalWorkspace.tsx");
  expect(source).toContain("modelAcceptsImages");
  // A second, local definition of the same rule is how the control and the
  // request boundary drift apart.
  expect(source).not.toMatch(/supportsVision === true/);
  // The control is rendered conditionally, not merely disabled.
  expect(source).toMatch(/\{visionReady && \(/);
});

test("the review-model picker filters on nothing that resembles vision", () => {
  const source = read("src", "components", "WheatAiProviderSettings.tsx");
  const start = source.indexOf("const reviewModelOptions");
  const end = source.indexOf("];", start);
  const options = source.slice(start, end);
  expect(start).toBeGreaterThan(-1);
  // Vision may be *mentioned* as a note on an option, but never used to drop one.
  expect(options).not.toMatch(/filter\([^)]*[Vv]ision/);
  expect(options).not.toMatch(/supportsVision &&/);
});

test("the review card is available without a remote provider configured", () => {
  // Reviewing an invoice with a local Ollama model is the option most Wheat
  // users should take; hiding the whole card behind a provider key made it
  // unreachable for exactly them.
  const source = read("src", "components", "WheatAiProviderSettings.tsx");
  const gateAt = source.indexOf("{configuredCount > 0 && preferences && (");
  const gateClosesAt = source.indexOf("</>", gateAt);
  const cardAt = source.indexOf('title="Relecture IA des documents');

  expect(gateAt).toBeGreaterThan(-1);
  expect(gateClosesAt).toBeGreaterThan(gateAt);
  // The card lives after the configured-provider fragment closes, gated only
  // on preferences having loaded.
  expect(cardAt).toBeGreaterThan(gateClosesAt);
  expect(source.slice(gateAt, gateClosesAt)).not.toContain("Relecture IA des documents");
});

test("no Wheat AI surface injects provider fallback wording into the conversation", () => {
  // Bug: a fallback notice was appended to the assistant's answer, so it was
  // stored as message content, replayed on reopening and fed back as context.
  for (const file of [["electron", "wheatAi.ts"], ["src", "components", "FiscalWorkspace.tsx"]]) {
    const source = read(...file);
    expect(source, file.join("/")).not.toMatch(/a bascul[eé] sur/i);
    expect(source, file.join("/")).not.toMatch(/mod[eè]le\(s\) indisponible/i);
    expect(source, file.join("/")).not.toMatch(/failoverNote/);
  }
});
