import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
describe("product analytics removal", () => {
  it("does not ship an analytics client or daily snapshot entry point", () => {
    const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    expect(pkg.dependencies).not.toHaveProperty("posthog-js");
    for (const file of ["src/lib/analytics.ts", "src/hooks/use-usage-snapshot.ts"]) expect(existsSync(new URL(file, root))).toBe(false);
    const app = readFileSync(new URL("src/App.tsx", root), "utf8");
    expect(app).not.toMatch(/initAnalytics|useUsageSnapshot|AppNotices/);
  });
});
