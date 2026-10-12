import { createHash } from "node:crypto";

// Must match StableId in solid-analyzer.cs so review-added findings get the same id in both places.
export function addedFindingId(prefix: string, principle: string, type: string, title: string): string {
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const hash = createHash("sha256").update(`${principle}|${type}|${normalized}`, "utf8").digest("hex");
  return `${prefix}-${hash.slice(0, 6)}`;
}
