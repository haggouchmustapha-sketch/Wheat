import packageMetadata from "../package.json";

/** Canonical Wheat product SemVer, derived from package.json for every runtime. */
export const WHEAT_APP_VERSION = packageMetadata.version;

/** Marketing name shown in the interface (e.g. "Wheat 2.0"). */
export const WHEAT_PRODUCT_NAME = "Wheat";

/** Short release label used in headers, the About panel and the update card. */
export const WHEAT_RELEASE_LABEL = `Wheat ${WHEAT_APP_VERSION.split(".").slice(0, 2).join(".")}`;
