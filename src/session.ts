/**
 * 会话状态管理 - 跟踪澄清流程
 * 
 * 用于多轮对话中的任务澄清状态追踪
 */

export type ClarificationState = {
  status: "clarifying" | "ready" | "completed";
  originalRequest: string;           // 用户原始请求
  questions: string[];               // 已提出的澄清问题
  answers: string[];                 // 用户的回答
  clarifiedSummary?: string;         // 澄清后的需求摘要
  createdAt: number;
  updatedAt: number;
};

// 会话存储（内存，重启后丢失）
const sessions = new Map<string, ClarificationState>();

// 会话过期时间：10 分钟
const SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * 生成会话 ID（基于对话内容哈希）
 */
export function generateSessionId(messages: Array<{ role: string; content: string }>): string {
  // 使用系统提示 + 第一条用户消息作为会话标识
  const systemMsg = messages.find(m => m.role === "system")?.content || "";
  const firstUserMsg = messages.find(m => m.role === "user")?.content || "";
  
  // 简单哈希
  const str = `${systemMsg.slice(0, 100)}|${firstUserMsg.slice(0, 200)}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `session_${Math.abs(hash).toString(36)}`;
}

/**
 * 获取或创建会话
 */
export function getOrCreateSession(sessionId: string, originalRequest: string): ClarificationState {
  const existing = sessions.get(sessionId);
  
  if (existing) {
    // 检查是否过期
    if (Date.now() - existing.updatedAt > SESSION_TTL_MS) {
      sessions.delete(sessionId);
    } else {
      existing.updatedAt = Date.now();
      return existing;
    }
  }
  
  // 创建新会话
  const newSession: ClarificationState = {
    status: "clarifying",
    originalRequest,
    questions: [],
    answers: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  
  sessions.set(sessionId, newSession);
  return newSession;
}

/**
 * 更新会话状态
 */
export function updateSession(sessionId: string, updates: Partial<ClarificationState>): ClarificationState | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  
  Object.assign(session, updates, { updatedAt: Date.now() });
  return session;
}

/**
 * 添加用户回答
 */
export function addAnswer(sessionId: string, answer: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.answers.push(answer);
    session.updatedAt = Date.now();
  }
}

/**
 * 标记会话为就绪（可以交给复杂模型）
 */
export function markReady(sessionId: string, summary: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.status = "ready";
    session.clarifiedSummary = summary;
    session.updatedAt = Date.now();
  }
}

/**
 * 标记会话完成
 */
export function markCompleted(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.status = "completed";
    session.updatedAt = Date.now();
  }
}

/**
 * 获取会话
 */
export function getSession(sessionId: string): ClarificationState | null {
  return sessions.get(sessionId) || null;
}

/**
 * 清理过期会话
 */
export function cleanupExpiredSessions(): number {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [id, session] of sessions.entries()) {
    if (now - session.updatedAt > SESSION_TTL_MS) {
      sessions.delete(id);
      cleaned++;
    }
  }
  
  return cleaned;
}

// 定期清理（每 5 分钟）
setInterval(() => {
  const cleaned = cleanupExpiredSessions();
  if (cleaned > 0) {
    console.log(`[Session] Cleaned ${cleaned} expired sessions`);
  }
}, 5 * 60 * 1000);
