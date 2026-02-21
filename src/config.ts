/**
 * Configuration loader for nadir-router
 * Loads config from config.yaml or environment variables
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";
export type Profile = "auto" | "eco" | "premium" | "free";

export type TierConfig = {
  primary: string;
  fallback: string[];
};

export type ModelConfig = {
  context_window: number;
};

export type Config = {
  server: {
    port: number;
    host: string;
  };
  litellm: {
    base_url: string;
    api_key: string;
    timeout_ms: number;
  };
  models: Record<string, ModelConfig>;
  routing: Record<Profile, Record<Tier, TierConfig>>;
  logging: {
    level: string;
  };
};

// Default config path
const DEFAULT_CONFIG_PATH = join(__dirname, "..", "config.yaml");

/**
 * Load configuration from YAML file
 */
function loadConfigFromYaml(path: string): Config | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const content = readFileSync(path, "utf-8");
    return yaml.load(content) as Config;
  } catch (err) {
    console.error(`[Config] Failed to load config from ${path}:`, err);
    return null;
  }
}

/**
 * Get configuration
 * Priority: CONFIG_PATH env > default config.yaml > environment variables > hardcoded defaults
 */
export function getConfig(): Config {
  // Try loading from YAML file
  const configPath = process.env.NADIR_CONFIG || DEFAULT_CONFIG_PATH;
  const yamlConfig = loadConfigFromYaml(configPath);

  if (yamlConfig) {
    // Override with environment variables if set
    if (process.env.LITELLM_BASE_URL) {
      yamlConfig.litellm.base_url = process.env.LITELLM_BASE_URL;
    }
    if (process.env.LITELLM_API_KEY) {
      yamlConfig.litellm.api_key = process.env.LITELLM_API_KEY;
    }
    if (process.env.PORT) {
      yamlConfig.server.port = parseInt(process.env.PORT, 10);
    }
    return yamlConfig;
  }

  // Fallback to environment variables with defaults
  console.warn("[Config] No config.yaml found, using environment variables and defaults");

  return {
    server: {
      port: parseInt(process.env.PORT || "8856", 10),
      host: "127.0.0.1",
    },
    litellm: {
      base_url: process.env.LITELLM_BASE_URL || "https://ccrcode.littlensy.top/v1",
      api_key: process.env.LITELLM_API_KEY || "sk-OgeKkrC6rA9Dl-WieQcPEQ",
      timeout_ms: 180000,
    },
    models: {
      "doubao-seed-code": { context_window: 128000 },
      "modelglm-5": { context_window: 200000 },
      "deepseek-v3.2": { context_window: 64000 },
    },
    routing: {
      auto: {
        SIMPLE: { primary: "doubao-seed-code", fallback: ["modelglm-5"] },
        MEDIUM: { primary: "doubao-seed-code", fallback: ["modelglm-5"] },
        COMPLEX: { primary: "modelglm-5", fallback: ["doubao-seed-code"] },
        REASONING: { primary: "modelglm-5", fallback: ["doubao-seed-code"] },
      },
      eco: {
        SIMPLE: { primary: "doubao-seed-code", fallback: [] },
        MEDIUM: { primary: "doubao-seed-code", fallback: [] },
        COMPLEX: { primary: "doubao-seed-code", fallback: [] },
        REASONING: { primary: "doubao-seed-code", fallback: [] },
      },
      premium: {
        SIMPLE: { primary: "modelglm-5", fallback: ["doubao-seed-code"] },
        MEDIUM: { primary: "modelglm-5", fallback: ["doubao-seed-code"] },
        COMPLEX: { primary: "modelglm-5", fallback: ["doubao-seed-code"] },
        REASONING: { primary: "modelglm-5", fallback: ["doubao-seed-code"] },
      },
      free: {
        SIMPLE: { primary: "doubao-seed-code", fallback: [] },
        MEDIUM: { primary: "doubao-seed-code", fallback: [] },
        COMPLEX: { primary: "doubao-seed-code", fallback: [] },
        REASONING: { primary: "doubao-seed-code", fallback: [] },
      },
    },
    logging: {
      level: "info",
    },
  };
}

// Singleton config instance
let _config: Config | null = null;

/**
 * Get singleton config instance
 */
export function getGlobalConfig(): Config {
  if (!_config) {
    _config = getConfig();
  }
  return _config;
}
