import fs from "node:fs";
import path from "node:path";
import { RuntimeConfig } from "./types";

export function loadConfig(envVar = "CBDC_CONFIG"): RuntimeConfig {
  const configPath = process.env[envVar];
  if (!configPath) {
    throw new Error(
      `Environment variable ${envVar} must point to a runtime config JSON file`,
    );
  }
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Runtime config not found at ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, "utf-8");
  return JSON.parse(raw) as RuntimeConfig;
}
