/**
 * Auto-Optimizer for Routing Decisions
 * 
 * Analyzes historical data and suggests/implements optimizations.
 * Runs periodically (e.g., every hour) within the nadir-router service.
 */

import { db } from "./db.js";

// Optimization thresholds
const MIN_DATA_POINTS = 50;        // Minimum requests before optimization
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;  // Check every 12 hours

// Optimization result type
export type OptimizationResult = {
  timestamp: string;
  dataPoints: number;
  sufficient: boolean;
  recommendations: string[];
  autoApplied: boolean;
  changes?: {
    tierBoundaries?: Record<string, [number, number]>;
    weights?: Record<string, number>;
  };
};

/**
 * Get current data statistics
 */
function getDataStats() {
  const overall = db.prepare(`
    SELECT 
      COUNT(*) as total,
      AVG(latency_ms) as avg_latency,
      AVG(total_tokens) as avg_tokens,
      AVG(CASE WHEN success = 1 THEN 100 ELSE 0 END) as success_rate
    FROM requests
  `).get() as any;

  const byTier = db.prepare(`
    SELECT 
      predicted_tier as tier,
      COUNT(*) as count,
      AVG(latency_ms) as avg_latency,
      AVG(total_tokens) as avg_tokens,
      AVG(score) as avg_score,
      AVG(CASE WHEN success = 1 THEN 100 ELSE 0 END) as success_rate
    FROM requests
    WHERE predicted_tier != 'UNKNOWN'
    GROUP BY predicted_tier
    ORDER BY avg_score DESC
  `).all() as any[];

  const byModel = db.prepare(`
    SELECT 
      selected_model as model,
      COUNT(*) as count,
      AVG(latency_ms) as avg_latency,
      AVG(total_tokens) as avg_tokens,
      AVG(CASE WHEN success = 1 THEN 100 ELSE 0 END) as success_rate
    FROM requests
    GROUP BY selected_model
    ORDER BY count DESC
    LIMIT 10
  `).all() as any[];

  return { overall, byTier, byModel };
}

/**
 * Generate optimization recommendations
 */
function generateRecommendations(stats: ReturnType<typeof getDataStats>): string[] {
  const recommendations: string[] = [];

  // Check if we have enough data
  if (stats.overall.total < MIN_DATA_POINTS) {
    recommendations.push(
      `数据量不足 (${stats.overall.total}/${MIN_DATA_POINTS})，继续收集中...`
    );
    return recommendations;
  }

  // Analyze tier performance
  const tierStats = stats.byTier;
  
  // Check for tier imbalance
  const tierCounts = tierStats.reduce((acc, t) => {
    acc[t.tier] = t.count;
    return acc;
  }, {} as Record<string, number>);

  const totalTiered = Object.values(tierCounts).reduce((a, b) => a + b, 0);
  
  // If SIMPLE tier is >70%, might be missing complex routing
  if (tierCounts.SIMPLE && tierCounts.SIMPLE / totalTiered > 0.7) {
    recommendations.push(
      `⚠️ SIMPLE tier 占比过高 (${(tierCounts.SIMPLE / totalTiered * 100).toFixed(0)}%)，` +
      `可能需要降低 MEDIUM tier 边界分数`
    );
  }

  // If REASONING tier is rarely used
  if (!tierCounts.REASONING || tierCounts.REASONING / totalTiered < 0.05) {
    recommendations.push(
      `ℹ️ REASONING tier 使用率低，可考虑降低 REASONING 边界分数`
    );
  }

  // Check model performance
  const modelStats = stats.byModel;
  const slowModels = modelStats.filter((m: any) => m.avg_latency > 5000);
  if (slowModels.length > 0) {
    recommendations.push(
      `⚠️ 高延迟模型: ${slowModels.map((m: any) => `${m.model}(${m.avg_latency.toFixed(0)}ms)`).join(', ')}`
    );
  }

  // Check success rates
  const lowSuccessModels = modelStats.filter((m: any) => m.success_rate < 95);
  if (lowSuccessModels.length > 0) {
    recommendations.push(
      `⚠️ 低成功率模型: ${lowSuccessModels.map((m: any) => `${m.model}(${m.success_rate.toFixed(0)}%)`).join(', ')}`
    );
  }

  // Overall stats
  recommendations.push(
    `✅ 总体: ${stats.overall.total} 请求, ` +
    `成功率 ${stats.overall.success_rate?.toFixed(1) || 0}%, ` +
    `平均延迟 ${stats.overall.avg_latency?.toFixed(0) || 0}ms`
  );

  return recommendations;
}

/**
 * Run optimization check
 */
export function runOptimization(): OptimizationResult {
  const stats = getDataStats();
  const recommendations = generateRecommendations(stats);
  const sufficient = stats.overall.total >= MIN_DATA_POINTS;

  const result: OptimizationResult = {
    timestamp: new Date().toISOString(),
    dataPoints: stats.overall.total,
    sufficient,
    recommendations,
    autoApplied: false,
  };

  // Log recommendations
  console.log(`[Optimizer] === 优化分析 ===`);
  console.log(`[Optimizer] 数据点: ${result.dataPoints}`);
  for (const rec of recommendations) {
    console.log(`[Optimizer] ${rec}`);
  }

  // TODO: Auto-apply optimizations when data is sufficient
  // For now, just log recommendations

  return result;
}

/**
 * Start periodic optimization checks
 */
let optimizationTimer: ReturnType<typeof setInterval> | null = null;

export function startOptimizer(): void {
  if (optimizationTimer) {
    console.log("[Optimizer] Already running");
    return;
  }

  console.log("[Optimizer] Starting periodic optimization checks");
  console.log(`[Optimizer] Check interval: ${CHECK_INTERVAL_MS / 60000} minutes`);
  console.log(`[Optimizer] Minimum data points: ${MIN_DATA_POINTS}`);

  // Run first check after 30 seconds
  setTimeout(() => {
    runOptimization();
  }, 30_000);

  // Then run periodically
  optimizationTimer = setInterval(() => {
    runOptimization();
  }, CHECK_INTERVAL_MS);
}

export function stopOptimizer(): void {
  if (optimizationTimer) {
    clearInterval(optimizationTimer);
    optimizationTimer = null;
    console.log("[Optimizer] Stopped");
  }
}
