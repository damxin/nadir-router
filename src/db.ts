/**
 * SQLite Database for Request Tracking
 * 
 * Stores request history for analytics and optimization.
 */

import Database from "better-sqlite3";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Database path
const DB_DIR = join(__dirname, "..", "data");
const DB_PATH = join(DB_DIR, "analytics.db");

// Ensure data directory exists
if (!existsSync(DB_DIR)) {
  mkdirSync(DB_DIR, { recursive: true });
}

// Initialize database
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma("journal_mode = WAL");

// Create tables
db.exec(`
  -- Request records table
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
    
    -- Request features
    prompt_hash TEXT,
    prompt_length INTEGER,
    system_prompt_length INTEGER,
    
    -- Routing decision
    profile TEXT,
    score REAL,
    predicted_tier TEXT,
    selected_model TEXT,
    fallback_used BOOLEAN DEFAULT 0,
    
    -- Performance metrics
    latency_ms INTEGER,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    reasoning_tokens INTEGER,
    
    -- Status
    success BOOLEAN DEFAULT 1,
    error_type TEXT,
    
    -- User feedback (optional)
    user_rating INTEGER,
    feedback_notes TEXT
  );
  
  -- Model performance stats (aggregated)
  CREATE TABLE IF NOT EXISTS model_stats (
    model TEXT PRIMARY KEY,
    total_requests INTEGER DEFAULT 0,
    total_success INTEGER DEFAULT 0,
    total_failures INTEGER DEFAULT 0,
    total_prompt_tokens INTEGER DEFAULT 0,
    total_completion_tokens INTEGER DEFAULT 0,
    total_latency_ms INTEGER DEFAULT 0,
    last_updated TEXT DEFAULT CURRENT_TIMESTAMP
  );
  
  -- Tier performance stats (aggregated)
  CREATE TABLE IF NOT EXISTS tier_stats (
    tier TEXT,
    profile TEXT,
    total_requests INTEGER DEFAULT 0,
    total_success INTEGER DEFAULT 0,
    avg_score REAL DEFAULT 0,
    avg_latency_ms REAL DEFAULT 0,
    avg_tokens REAL DEFAULT 0,
    last_updated TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tier, profile)
  );
  
  -- Create indexes for faster queries
  CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
  CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(selected_model);
  CREATE INDEX IF NOT EXISTS idx_requests_tier ON requests(predicted_tier);
  CREATE INDEX IF NOT EXISTS idx_requests_profile ON requests(profile);
`);

// Prepared statements
const insertRequest = db.prepare(`
  INSERT INTO requests (
    prompt_hash, prompt_length, system_prompt_length,
    profile, score, predicted_tier, selected_model, fallback_used,
    latency_ms, prompt_tokens, completion_tokens, total_tokens, reasoning_tokens,
    success, error_type
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateModelStats = db.prepare(`
  INSERT INTO model_stats (model, total_requests, total_success, total_failures, 
    total_prompt_tokens, total_completion_tokens, total_latency_ms, last_updated)
  VALUES (?, 1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(model) DO UPDATE SET
    total_requests = total_requests + 1,
    total_success = total_success + ?,
    total_failures = total_failures + ?,
    total_prompt_tokens = total_prompt_tokens + ?,
    total_completion_tokens = total_completion_tokens + ?,
    total_latency_ms = total_latency_ms + ?,
    last_updated = CURRENT_TIMESTAMP
`);

const updateTierStats = db.prepare(`
  INSERT INTO tier_stats (tier, profile, total_requests, total_success, 
    avg_score, avg_latency_ms, avg_tokens, last_updated)
  VALUES (?, ?, 1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(tier, profile) DO UPDATE SET
    total_requests = total_requests + 1,
    total_success = total_success + ?,
    avg_score = (avg_score * (total_requests - 1) + ?) / total_requests,
    avg_latency_ms = (avg_latency_ms * (total_requests - 1) + ?) / total_requests,
    avg_tokens = (avg_tokens * (total_requests - 1) + ?) / total_requests,
    last_updated = CURRENT_TIMESTAMP
`);

/**
 * Request record type
 */
export type RequestRecord = {
  promptHash: string;
  promptLength: number;
  systemPromptLength: number;
  profile: string;
  score: number;
  predictedTier: string;
  selectedModel: string;
  fallbackUsed: boolean;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  success: boolean;
  errorType?: string;
};

/**
 * Record a request
 */
export function recordRequest(record: RequestRecord): void {
  try {
    insertRequest.run(
      record.promptHash,
      record.promptLength,
      record.systemPromptLength,
      record.profile,
      record.score,
      record.predictedTier,
      record.selectedModel,
      record.fallbackUsed ? 1 : 0,
      record.latencyMs,
      record.promptTokens,
      record.completionTokens,
      record.totalTokens,
      record.reasoningTokens,
      record.success ? 1 : 0,
      record.errorType || null
    );

    // Update model stats
    updateModelStats.run(
      record.selectedModel,
      record.success ? 1 : 0,
      record.success ? 0 : 1,
      record.promptTokens,
      record.completionTokens,
      record.latencyMs
    );

    // Update tier stats
    updateTierStats.run(
      record.predictedTier,
      record.profile,
      record.success ? 1 : 0,
      record.score,
      record.latencyMs,
      record.totalTokens
    );
  } catch (err) {
    console.error("[DB] Failed to record request:", err);
  }
}

/**
 * Get overall statistics
 */
export function getOverallStats(): {
  totalRequests: number;
  successRate: number;
  avgLatency: number;
  avgTokens: number;
  dataPoints: number;
} {
  const result = db.prepare(`
    SELECT 
      COUNT(*) as total_requests,
      AVG(CASE WHEN success = 1 THEN 100 ELSE 0 END) as success_rate,
      AVG(latency_ms) as avg_latency,
      AVG(total_tokens) as avg_tokens
    FROM requests
  `).get() as any;

  return {
    totalRequests: result?.total_requests || 0,
    successRate: result?.success_rate || 0,
    avgLatency: result?.avg_latency || 0,
    avgTokens: result?.avg_tokens || 0,
    dataPoints: result?.total_requests || 0,
  };
}

/**
 * Get model performance stats
 */
export function getModelStats(): Array<{
  model: string;
  totalRequests: number;
  successRate: number;
  avgLatency: number;
  avgPromptTokens: number;
  avgCompletionTokens: number;
}> {
  return db.prepare(`
    SELECT 
      model,
      total_requests,
      ROUND(total_success * 100.0 / NULLIF(total_requests, 0), 1) as success_rate,
      ROUND(total_latency_ms * 1.0 / NULLIF(total_requests, 0), 0) as avg_latency,
      ROUND(total_prompt_tokens * 1.0 / NULLIF(total_requests, 0), 0) as avg_prompt_tokens,
      ROUND(total_completion_tokens * 1.0 / NULLIF(total_requests, 0), 0) as avg_completion_tokens
    FROM model_stats
    WHERE total_requests > 0
    ORDER BY total_requests DESC
  `).all() as any[];
}

/**
 * Get tier performance stats
 */
export function getTierStats(): Array<{
  tier: string;
  profile: string;
  totalRequests: number;
  successRate: number;
  avgScore: number;
  avgLatency: number;
  avgTokens: number;
}> {
  return db.prepare(`
    SELECT 
      tier,
      profile,
      total_requests,
      ROUND(total_success * 100.0 / NULLIF(total_requests, 0), 1) as success_rate,
      ROUND(avg_score, 2) as avg_score,
      ROUND(avg_latency_ms, 0) as avg_latency,
      ROUND(avg_tokens, 0) as avg_tokens
    FROM tier_stats
    WHERE total_requests > 0
    ORDER BY profile, tier
  `).all() as any[];
}

/**
 * Get recent requests
 */
export function getRecentRequests(limit: number = 100): Array<{
  timestamp: string;
  profile: string;
  predicted_tier: string;
  selected_model: string;
  latency_ms: number;
  total_tokens: number;
  success: number;
}> {
  return db.prepare(`
    SELECT 
      timestamp, profile, predicted_tier, selected_model,
      latency_ms, total_tokens, success
    FROM requests
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit) as any[];
}

/**
 * Simple hash for prompt (privacy-friendly)
 */
export function hashPrompt(prompt: string): string {
  let hash = 0;
  for (let i = 0; i < prompt.length; i++) {
    const char = prompt.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

/**
 * Close database connection
 */
export function closeDatabase(): void {
  db.close();
}

// Export database for direct queries if needed
export { db };
