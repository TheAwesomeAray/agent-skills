import fs from "node:fs";
import path from "node:path";
import type { RegisterItem } from "../types.ts";
import { HarnessError, readJson, writeJson } from "../util.ts";
import { checkSchema } from "../validate.ts";

export const itemsDir = (registerDir: string): string => path.join(registerDir, "items");

export function loadItems(registerDir: string): Map<string, RegisterItem> {
  const items = new Map<string, RegisterItem>();
  const dir = itemsDir(registerDir);
  if (!fs.existsSync(dir)) return items;
  const problems: string[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const item = readJson<RegisterItem>(path.join(dir, file));
    const errors = checkSchema("register-item", item);
    if (errors.length > 0) problems.push(`${file}: ${errors.join("; ")}`);
    else if (`${item.id}.json` !== file) problems.push(`${file}: id '${item.id}' does not match the file name.`);
    else items.set(item.id, item);
  }
  if (problems.length > 0) throw new HarnessError(`Register items are invalid:\n- ${problems.join("\n- ")}`);
  return items;
}

export function saveItem(registerDir: string, item: RegisterItem): void {
  writeJson(path.join(itemsDir(registerDir), `${item.id}.json`), item);
}
