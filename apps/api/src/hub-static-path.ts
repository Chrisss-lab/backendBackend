import { existsSync } from "fs";
import { join, resolve } from "path";

/**
 * Where Next static export writes files (`npm run build -w apps/web` → apps/web/out).
 * Tries repo-relative paths for different cwd / compiled __dirname layouts.
 */
export function resolveWebOutDir(): string | null {
  const candidates = [
    resolve(process.cwd(), "apps", "web", "out"),
    resolve(process.cwd(), "web", "out"),
    // apps/api/dist/main.js
    resolve(__dirname, "..", "..", "web", "out"),
    // apps/api/dist/modules/app.module.js
    resolve(__dirname, "..", "..", "..", "web", "out")
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return null;
}
