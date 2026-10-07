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
			miniflare: { d1Databases: { COLLAB_DB: "collab-c0", COLLAB_DB_RESTORE: "collab-c0-restore", COLLAB_DB_C2: "collab-c2" } },
		}),
	],
});
