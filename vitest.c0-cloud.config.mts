import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// CC-3 C0 cloud rerun: same scenarios as vitest.config.mts, real remote D1 databases.
// Requires Cloudflare authentication (npx wrangler login, or CLOUDFLARE_API_TOKEN with D1 Edit).
export default defineConfig({
	test: {
		include: ["test/collab-store/c0/*.spec.ts"],
		setupFiles: ["test/collab-store/c0/cloud-setup.ts"],
		// One shared remote database: files must not run in parallel.
		fileParallelism: false,
		// Every statement crosses the network: the local 5 s default is too short.
		testTimeout: 900_000,
		hookTimeout: 900_000,
	},
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./test/collab-store/c0/wrangler.cloud.jsonc" },
		}),
	],
});
