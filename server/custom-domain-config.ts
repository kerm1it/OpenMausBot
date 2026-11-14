import { z } from "zod";

export const customDomainConfigShape = {
  customDomain: z.string().optional(),
  customDomainPort: z.number().int().min(1_024).max(65_534).optional(),
};

export interface CustomDomainConfig {
  /** Set only by the verified domain endpoint, never by a generic config patch. */
  customDomain?: string;
  /** Desktop upstream verified with customDomain; Electron pins it while that domain remains configured. */
  customDomainPort?: number;
}

export function applyCustomDomainConfig(target: CustomDomainConfig, patch: CustomDomainConfig): void {
  if (patch.customDomain !== undefined) target.customDomain = patch.customDomain;
  if (patch.customDomainPort !== undefined) target.customDomainPort = patch.customDomainPort;
}
