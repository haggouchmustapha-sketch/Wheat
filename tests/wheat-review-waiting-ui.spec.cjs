/**
 * What is on screen while the shared review runs.
 *
 * The defect these guards exist against was structural, not cosmetic. The
 * review dialog was mounted from `review`, and `review` was only set once the
 * IPC call resolved — so for the whole of a ten-to-twenty-second model answer
 * the hook rendered `null`. A person clicked "Enregistrer", nothing appeared,
 * nothing changed, and the only available reading of that was that Wheat had
 * stopped working. `busy` was returned to callers and no caller used it.
 *
 * There is no DOM harness in this repository — renderer behaviour is covered
 * either by unit-testing the shared rule a screen uses or, for anything that
 * needs a real window, by the Electron specs. So the checks below are source
 * guards, and they are written to fail on the *shape* that caused the fault
 * rather than on the wording of any message: a waiting state that exists, is
 * entered before the first `await`, and is rendered whether or not a result has
 * arrived.
 *
 * What these guards do NOT prove is stated plainly, because a guard that is
 * believed to prove more than it does is worse than none: they do not exercise
 * a real slow provider, do not measure the time to first paint, and do not
 * demonstrate that the window keeps responding. Those need a running
 * application and are not claimed here.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

let hook;
let surface;
let registry;
let preload;

test.beforeAll(() => {
  hook = read("src", "lib", "useWheatReview.tsx");
  surface = read("src", "components", "WheatReview.tsx");
  registry = read("electron", "wheatWorkflowRegistry.ts");
  preload = read("electron", "preload.ts");
});

test.describe("review waiting surface", () => {
  test("a waiting state exists and is rendered independently of a result", () => {
    // The exact regression: `element` must not be reachable only through
    // `review`. A waiting surface that renders when `review` is still null is
    // the whole fix.
    expect(hook).toMatch(/WheatReviewPending/);
    expect(surface).toMatch(/export function WheatReviewPending/);
    // The ternary has to fall through to the pending surface, not to null.
    expect(hook).toMatch(/\)\s*:\s*pending\s*\?\s*\(/);
  });

  test("the waiting state is entered before the first await, not after it", () => {
    // If `setPending` came after the IPC call there would still be a blank
    // window for the whole of it, which is the fault restated.
    const body = hook.slice(hook.indexOf("const request = useCallback"));
    const firstPending = body.indexOf("setPending({");
    const firstAwait = body.indexOf("await ");
    expect(firstPending).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(-1);
    expect(firstPending).toBeLessThan(firstAwait);
  });

  test("the waiting surface names the model rather than only asking for patience", () => {
    expect(hook).toMatch(/getReviewModel/);
    expect(surface).toMatch(/review-pending-model/);
    // And it distinguishes a local model from a remote one, because whether the
    // dossier left the machine is not a detail.
    expect(surface).toMatch(/locality === "LOCAL"/);
  });

  test("a review that runs long says so instead of looking stalled", () => {
    expect(hook).toMatch(/slow: true/);
    expect(surface).toMatch(/review-pending-slow/);
    // Honest waiting: Wheat cannot know how far through a model's answer it is,
    // so the waiting surface must not render a proportion of anything. The
    // check is scoped to the component's own body and ignores prose, otherwise
    // it fails on the comment explaining why there is no progress bar.
    const pending = surface
      .slice(surface.indexOf("export function WheatReviewPending"), surface.indexOf("const OUTCOME_META"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(pending).toMatch(/review-pending-slow/);
    expect(pending).not.toMatch(/progress|percent|%/i);
  });

  test("waiting and deciding are separately addressable, never one class", () => {
    // They are different states, and code (and tests) that ask "is the review
    // dialog still up?" must not be answered "yes" by a review that has not
    // finished reading. Sharing a root class made exactly that mistake.
    const pending = surface.slice(surface.indexOf("export function WheatReviewPending"), surface.indexOf("const OUTCOME_META"));
    expect(pending).toMatch(/className="wt-review-pending"/);
    expect(pending).not.toMatch(/className="[^"]*wt-review/);
    const dialog = surface.slice(surface.indexOf("export function WheatReviewDialog"));
    expect(dialog).toMatch(/className="wt-review"/);
  });

  test("the waiting surface can always be left, and says nothing was written", () => {
    // A modal with no way out is its own kind of frozen application.
    expect(surface).toMatch(/onClose=\{onAbandon\}/);
    expect(surface).toMatch(/Rien n'a été enregistré/);
    expect(hook).toMatch(/abandon\.current/);
  });

  test("a superseded review is discarded rather than shown against new data", () => {
    // The accounting-safety half: an opinion formed on one set of figures must
    // never be attached to another. The ticket is compared before the result is
    // adopted, and the early return happens before any state is set from it.
    expect(hook).toMatch(/ticket\.current \+= 1/);
    expect(hook).toMatch(/if \(ticket\.current !== mine\)/);
    const adopt = hook.indexOf("setReview(result)");
    const guard = hook.indexOf("if (ticket.current !== mine)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(adopt);
  });

  test("two clicks on a slow action share one review instead of starting two", () => {
    expect(hook).toMatch(/inFlight/);
    expect(hook).toMatch(/inFlight\.current\.get\(identity\)/);
    expect(hook).toMatch(/inFlight\.current\.set\(identity/);
    // The entry is removed once settled, so a later, genuine re-review is not
    // answered from a stale promise.
    expect(hook).toMatch(/inFlight\.current\.delete\(identity\)/);
  });

  test("a failing review is a recoverable state, never a silent all-clear and never a wall", () => {
    // The rule the pipeline depends on: a preflight that could not run does not
    // authorise anything, and does not block the domain service either — which
    // re-validates inside its own transaction regardless.
    expect(hook).toMatch(/Contrôle préalable indisponible/);
    const failure = hook.slice(hook.indexOf("} catch (error) {"));
    expect(failure).toMatch(/setPending\(null\)/);
    expect(failure).toMatch(/setBusy\(false\)/);
  });

  test("the model-descriptor channel is a read, and is classified as one", () => {
    // Every renderer channel must be classified or `wheat-workflow-coverage`
    // fails. This one reads which model would answer; it mutates nothing.
    expect(preload).toMatch(/wheat:review:model/);
    expect(registry).toMatch(/exempt\("review\.model", "wheat:review:model"/);
  });

  test("the local-model probe is cached instead of run before every review", () => {
    const main = read("electron", "main.ts");
    expect(main).toMatch(/OLLAMA_DISCOVERY_TTL_MS/);
    expect(main).toMatch(/ollamaDiscoveryCache/);
    // And the review path goes through the cache, not straight at the daemon:
    // the one place that reads the daemon is the cached discovery itself.
    const lookup = main.slice(main.indexOf("async function usableLocalModels"));
    expect(lookup).toMatch(/discoverOllamaModels\(/);
    const selection = main.slice(main.indexOf("async function resolveReviewModelSelection"));
    expect(selection).toMatch(/usableLocalModels\(/);
    expect(selection).not.toMatch(/listOllamaModels\(/);
  });

  test("a model the user chose is never silently replaced by another", () => {
    const main = read("electron", "main.ts");
    const selection = main.slice(main.indexOf("async function resolveReviewModelSelection"));
    // A remote pin is honoured where it points — the fault was that only an
    // `ollama:` prefix was ever consulted.
    expect(selection).toMatch(/pinned\?\.startsWith\(REMOTE_MODEL_PREFIX\)/);
    expect(selection).toMatch(/pinned\?\.startsWith\("ollama:"\)/);
    // An unavailable choice is reported as unavailable, with "EXPLICIT" intact.
    expect(selection).toMatch(/n'est pas disponible/);
    expect(selection).toMatch(/"EXPLICIT"/);
  });

  /* ------------------------------------------- what the wait is allowed to say */

  test("the waiting surface never prints a provider or model identifier", () => {
    // The regression, verbatim: "remote:openrouter:google/gemma-4-26b-a4b-it:free"
    // shown to somebody in the middle of saving an invoice. Which model is
    // answering is not a fact an accountant can act on mid-entry.
    const pending = surface.slice(surface.indexOf("export function WheatReviewPending"), surface.indexOf("const OUTCOME_META"));
    expect(pending).not.toMatch(/\{model\.modelId\}/);
    expect(pending).not.toMatch(/\{model\.provider\}/);
    // Where the reading happens is a different matter and is kept.
    expect(pending).toMatch(/locality === "LOCAL"/);
  });

  test("the stage text names Wheat, not the model", () => {
    const stage = hook.slice(hook.indexOf("function stageFor"));
    expect(stage).toMatch(/Wheat AI/);
    expect(stage).not.toMatch(/model\.modelId/);
  });

  test("the silent all-clear is attributed without naming a model", () => {
    const silent = hook.slice(hook.indexOf("if (result.model.ran)"), hook.indexOf("setFixHandler("));
    expect(silent).toMatch(/Wheat AI/);
    expect(silent).not.toMatch(/model\.modelId|model\.provider/);
  });

  test("identifiers stay reachable, behind a disclosure on the result", () => {
    // Available for diagnosis, never in the running text.
    const dialog = surface.slice(surface.indexOf("function ModelProvenance"));
    expect(dialog).toMatch(/<details/);
    expect(dialog).toMatch(/model\.detail/);
  });

  test("an instant review does not flash a modal, but the wait still starts at once", () => {
    // Both halves matter. `setPending` stays before the first await so nothing
    // is lost between the click and the answer; `visible` gates only the modal,
    // so a review that finishes in milliseconds shows nothing at all.
    const body = hook.slice(hook.indexOf("const request = useCallback"));
    expect(body).toMatch(/visible: false/);
    expect(body).toMatch(/visible: true/);
    expect(hook).toMatch(/pending\.visible \? \(/);
  });

  test("the renderer tells the service when a review was asked for rather than triggered", () => {
    // The service needs the difference: pressing save is not asking for a
    // second opinion, and treating it as one is what made every edit wait.
    expect(hook).toMatch(/requested: options\.always === true/);
  });
});
