import type { ProviderDef } from "./types";
import { resendDef } from "./resend";

// type → ProviderDef 注册表。未来新增厂商在此追加一行。
export const registry = new Map<string, ProviderDef>([
  ["resend", resendDef],
  // ["ses", sesDef],
]);

export function getProviderDef(type: string): ProviderDef | undefined {
  return registry.get(type);
}

export function listProviderDefs(): ProviderDef[] {
  return [...registry.values()];
}
