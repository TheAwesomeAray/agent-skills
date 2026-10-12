import { HarnessError } from "../util.ts";
import { github } from "./github.ts";
import type { Host } from "./host.ts";

const hosts: Record<string, Host> = { github };

export function getHost(name: string): Host {
  const host = hosts[name];
  if (!host) throw new HarnessError(`Unknown git host '${name}'. Available: ${Object.keys(hosts).join(", ")}`);
  return host;
}
