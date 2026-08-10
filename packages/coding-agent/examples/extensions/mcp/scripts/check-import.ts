/**
 * Syntax/import smoke check: just import the extension entrypoint to surface
 * any import-time errors (missing paths, typos, wrong SDK surface).
 */
import("../index.ts")
	.then((mod) => {
		console.log("[check] extension loaded:", typeof mod.default);
	})
	.catch((err) => {
		console.error("[check] failed to import extension:", err);
		process.exit(1);
	});
