/**
 * Routing Config for LiteLLM
 *
 * Default configuration for intelligent routing.
 * Configure your actual models in config.yaml - these are fallback defaults only.
 */

import type { RoutingConfig } from "./types.js";

// Default models (used only when config.yaml is not available)
// Configure your actual models in config.yaml

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  version: "2.0-lite",

  classifier: {
    llmModel: "google/gemini-2.5-flash",
    llmMaxTokens: 10,
    llmTemperature: 0,
    promptTruncationChars: 500,
    cacheTtlMs: 3_600_000,
  },

  scoring: {
    tokenCountThresholds: { simple: 50, complex: 500 },

    codeKeywords: [
      "function", "class", "import", "def", "SELECT", "async", "await",
      "const", "let", "var", "return", "```",
      "函数", "类", "导入", "定义", "查询", "异步", "等待", "常量", "变量", "返回",
      "関数", "クラス", "インポート", "非同期", "定数", "変数",
      "функция", "класс", "импорт", "определ", "запрос", "асинхронный",
      "funktion", "klasse", "importieren", "definieren", "abfrage",
    ],
    reasoningKeywords: [
      "prove", "theorem", "derive", "step by step", "chain of thought",
      "formally", "mathematical", "proof", "logically",
      "证明", "定理", "推导", "逐步", "思维链", "形式化", "数学", "逻辑",
      "証明", "定理", "導出", "ステップバイステップ", "論理的",
      "доказать", "докажи", "теорема", "пошагово", "цепочка рассуждений",
      "beweisen", "theorem", "ableiten", "schritt für schritt",
    ],
    simpleKeywords: [
      "what is", "define", "translate", "hello", "yes or no", "capital of",
      "how old", "who is", "when was",
      "什么是", "定义", "翻译", "你好", "是否", "首都", "多大", "谁是", "何时",
      "とは", "定義", "翻訳", "こんにちは",
      "что такое", "определение", "переведи", "привет", "да или нет",
      "was ist", "definiere", "übersetze", "hallo",
    ],
    technicalKeywords: [
      "algorithm", "optimize", "architecture", "distributed", "kubernetes",
      "microservice", "database", "infrastructure",
      "算法", "优化", "架构", "分布式", "微服务", "数据库", "基础设施",
      "アルゴリズム", "最適化", "アーキテクチャ", "分散", "マイクロサービス",
      "алгоритм", "оптимизаци", "архитектура", "микросервис",
      "algorithmus", "optimieren", "architektur", "verteilt",
    ],
    creativeKeywords: [
      "story", "poem", "compose", "brainstorm", "creative", "imagine", "write a",
      "故事", "诗", "创作", "头脑风暴", "创意", "想象", "写一个",
      "物語", "詩", "作曲", "ブレインストーム", "創造的", "想像",
      "история", "стихотворение", "сочинить", "творческий", "придумай",
      "geschichte", "gedicht", "komponieren", "kreativ",
    ],

    imperativeVerbs: [
      "build", "create", "implement", "design", "develop", "construct",
      "generate", "deploy", "configure", "set up",
      "构建", "创建", "实现", "设计", "开发", "生成", "部署", "配置",
      "построить", "создать", "реализовать", "разработать",
      "erstellen", "bauen", "implementieren", "entwickeln",
    ],
    constraintIndicators: [
      "under", "at most", "at least", "within", "no more than",
      "maximum", "minimum", "limit", "budget",
      "不超过", "至少", "最多", "在内", "最大", "最小", "限制",
      "не более", "максимум", "минимум", "ограничение",
      "höchstens", "mindestens", "maximal", "minimal",
    ],
    outputFormatKeywords: [
      "json", "yaml", "xml", "table", "csv", "markdown", "schema",
      "format as", "structured",
      "表格", "格式化为", "结构化",
      "таблица", "форматировать", "структурированный",
      "tabelle", "formatieren", "strukturiert",
    ],
    referenceKeywords: [
      "above", "below", "previous", "following", "the docs", "the api",
      "the code", "earlier", "attached",
      "上面", "下面", "之前", "接下来", "文档", "代码", "附件",
      "выше", "ниже", "предыдущий", "документация",
      "oben", "unten", "vorherige", "dokumentation",
    ],
    negationKeywords: [
      "don't", "do not", "avoid", "never", "without", "except", "exclude",
      "不要", "避免", "从不", "没有", "除了", "排除",
      "не делай", "нельзя", "избегать", "никогда", "кроме",
      "nicht", "vermeide", "niemals", "ohne", "außer",
    ],
    domainSpecificKeywords: [
      "quantum", "fpga", "vlsi", "risc-v", "asic", "photonics",
      "genomics", "proteomics", "topological", "homomorphic",
      "量子", "光子学", "基因组学", "拓扑", "同态",
      "квантовый", "фотоника", "геномика",
      "quanten", "photonik", "genomik",
    ],

    agenticTaskKeywords: [
      "read file", "read the file", "look at", "check the", "open the",
      "edit", "modify", "update the", "change the", "write to", "create file",
      "execute", "deploy", "install", "npm", "pip", "compile",
      "after that", "and also", "once done", "step 1", "step 2",
      "fix", "debug", "until it works", "iterate", "make sure", "verify", "confirm",
      "读取文件", "查看", "打开", "编辑", "修改", "更新", "创建",
      "执行", "部署", "安装", "第一步", "第二步", "修复", "调试", "确认", "验证",
    ],

    dimensionWeights: {
      tokenCount: 0.08,
      codePresence: 0.15,
      reasoningMarkers: 0.18,
      technicalTerms: 0.1,
      creativeMarkers: 0.05,
      simpleIndicators: 0.02,
      multiStepPatterns: 0.12,
      questionComplexity: 0.05,
      imperativeVerbs: 0.03,
      constraintCount: 0.04,
      outputFormat: 0.03,
      referenceComplexity: 0.02,
      negationComplexity: 0.01,
      domainSpecificity: 0.02,
      agenticTask: 0.04,
    },

    tierBoundaries: {
      simpleMedium: 0.0,
      mediumComplex: 0.3,
      complexReasoning: 0.5,
    },

    confidenceSteepness: 12,
    confidenceThreshold: 0.7,
  },

  // Default tier configs (fallback only - configure actual models in config.yaml)
  // These are used only when config.yaml is not available
  tiers: {
    SIMPLE: {
      primary: "default-model-1",
      fallback: ["default-model-2", "default-model-3"],
    },
    MEDIUM: {
      primary: "default-model-1",
      fallback: ["default-model-2", "default-model-3"],
    },
    COMPLEX: {
      primary: "default-model-2",
      fallback: ["default-model-1", "default-model-3"],
    },
    REASONING: {
      primary: "default-model-2",
      fallback: ["default-model-1"],
    },
  },

  // Eco tier configs - cheapest options (fallback only)
  ecoTiers: {
    SIMPLE: {
      primary: "default-model-1",
      fallback: ["default-model-2"],
    },
    MEDIUM: {
      primary: "default-model-1",
      fallback: ["default-model-2"],
    },
    COMPLEX: {
      primary: "default-model-1",
      fallback: ["default-model-2"],
    },
    REASONING: {
      primary: "default-model-1",
      fallback: ["default-model-2"],
    },
  },

  // Premium tier configs - best quality (fallback only)
  premiumTiers: {
    SIMPLE: {
      primary: "default-model-2",
      fallback: ["default-model-1"],
    },
    MEDIUM: {
      primary: "default-model-2",
      fallback: ["default-model-1"],
    },
    COMPLEX: {
      primary: "default-model-2",
      fallback: ["default-model-1"],
    },
    REASONING: {
      primary: "default-model-2",
      fallback: ["default-model-1"],
    },
  },

  // Agentic tier configs - models good at multi-step tasks (fallback only)
  agenticTiers: {
    SIMPLE: {
      primary: "default-model-1",
      fallback: ["default-model-2"],
    },
    MEDIUM: {
      primary: "default-model-1",
      fallback: ["default-model-2"],
    },
    COMPLEX: {
      primary: "default-model-2",
      fallback: ["default-model-1"],
    },
    REASONING: {
      primary: "default-model-2",
      fallback: ["default-model-1"],
    },
  },

  overrides: {
    maxTokensForceComplex: 100_000,
    structuredOutputMinTier: "MEDIUM",
    ambiguousDefaultTier: "MEDIUM",
    agenticMode: false,
  },
};
