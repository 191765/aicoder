import type { Config } from "./config.js";
import { estimateCost } from "./observability.js";

/**
 * 成本预算强制执行
 *
 * 在会话 / 用户 / 全局层面实时累计花费，超支时阻断后续 LLM 调用。
 * 与 observability 的用量统计互补：后者用于展示，这里用于强制。
 */

export type BudgetScope = "session" | "user" | "global";

export interface BudgetLimit {
  scope: BudgetScope;
  limitUsd: number;
}

export interface BudgetState {
  sessionSpent: number;
  globalSpent: number;
  userSpent: Map<string, number>;
  limits: BudgetLimit[];
}

let state: BudgetState = {
  sessionSpent: 0,
  globalSpent: 0,
  userSpent: new Map(),
  limits: [],
};

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export function initBudget(config: Config): void {
  const limits: BudgetLimit[] = [];
  if (config.costBudget?.sessionUsd !== undefined) {
    limits.push({ scope: "session", limitUsd: config.costBudget.sessionUsd });
  }
  if (config.costBudget?.globalUsd !== undefined) {
    limits.push({ scope: "global", limitUsd: config.costBudget.globalUsd });
  }
  state = {
    sessionSpent: 0,
    globalSpent: 0,
    userSpent: new Map(),
    limits,
  };
}

export function resetSessionBudget(): void {
  state.sessionSpent = 0;
}

/**
 * 记录一次花费并按预算检查。
 * @throws BudgetExceededError 当任一作用域超支时
 */
export function chargeBudget(
  model: string,
  inputTokens: number,
  outputTokens: number,
  user?: string,
  userQuotaUsd?: number
): number {
  const cost = estimateCost(model, inputTokens, outputTokens);
  state.sessionSpent += cost;
  state.globalSpent += cost;
  if (user) state.userSpent.set(user, (state.userSpent.get(user) ?? 0) + cost);

  for (const l of state.limits) {
    if (l.scope === "session" && state.sessionSpent > l.limitUsd) {
      throw new BudgetExceededError(
        `会话预算超支：$${state.sessionSpent.toFixed(4)} / $${l.limitUsd}`
      );
    }
    if (l.scope === "global" && state.globalSpent > l.limitUsd) {
      throw new BudgetExceededError(
        `全局预算超支：$${state.globalSpent.toFixed(4)} / $${l.limitUsd}`
      );
    }
  }

  if (user && userQuotaUsd !== undefined) {
    const spent = state.userSpent.get(user) ?? 0;
    if (spent > userQuotaUsd) {
      throw new BudgetExceededError(
        `用户 ${user} 配额超支：$${spent.toFixed(4)} / $${userQuotaUsd}`
      );
    }
  }

  return cost;
}

export function budgetStatus(): {
  sessionSpent: number;
  globalSpent: number;
  limits: BudgetLimit[];
} {
  return {
    sessionSpent: state.sessionSpent,
    globalSpent: state.globalSpent,
    limits: state.limits,
  };
}

/** 检查是否已超支（不产生花费），供请求入口预检 */
export function isOverBudget(): { over: boolean; reason?: string } {
  for (const l of state.limits) {
    if (l.scope === "session" && state.sessionSpent > l.limitUsd) {
      return { over: true, reason: `会话预算超支 ($${state.sessionSpent.toFixed(4)})` };
    }
    if (l.scope === "global" && state.globalSpent > l.limitUsd) {
      return { over: true, reason: `全局预算超支 ($${state.globalSpent.toFixed(4)})` };
    }
  }
  return { over: false };
}
