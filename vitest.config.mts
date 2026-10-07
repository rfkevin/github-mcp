import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { include: ['test/**/*.spec.ts'] },
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			// CC-3 C0: local D1 databases for the gate scenarios only (no production binding).
			miniflare: { d1Databases: { COLLAB_DB: "collab-c0", COLLAB_DB_RESTORE: "collab-c0-restore" } },
		}),
	],
});
