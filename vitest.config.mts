import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { include: ['test/**/*.spec.ts'] },
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			// CC-3 C0: local D1 databases for the gate scenarios only (no production binding).
			// CC-3 C2: COLLAB_DB_C2 carries the canonical C1 schema for the store tests
			// (COLLAB_DB keeps the frozen C0 proto schema, incompatible with 0001_init.sql).
			// CC-3 C6: COLLAB_DB_C6_RESTORE is an empty canonical database for the export -> import -> export proof.
			miniflare: { d1Databases: { COLLAB_DB: "collab-c0", COLLAB_DB_RESTORE: "collab-c0-restore", COLLAB_DB_C2: "collab-c2", COLLAB_DB_C6_RESTORE: "collab-c6-restore" } },
		}),
	],
});
