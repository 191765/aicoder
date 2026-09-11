import type { Config } from "./config.js";

/**
 * 团队 / 多用户
 *
 * 在 .aicoder.json 的 users 中配置每个用户的令牌与配额：
 * {
 *   "users": [
 *     { "name": "alice", "token": "tok-alice", "quotaUsd": 5, "allowedTools": ["read_file","search"] }
 *   ]
 * }
 *
 * 网页端通过 Bearer token 识别用户；未在 users 中但匹配 AICODER_TOKEN 的视为管理员。
 */

export interface UserConfig {
  name: string;
  token: string;
  /** 费用配额（美元），超出后拒绝新请求 */
  quotaUsd?: number;
  /** 允许使用的工具白名单（为空则不限制） */
  allowedTools?: string[];
  /** 是否可执行写操作 */
  allowWrite?: boolean;
}

export interface User {
  name: string;
  token: string;
  quotaUsd?: number;
  allowedTools?: string[];
  allowWrite: boolean;
  isAdmin: boolean;
}

export class UserRegistry {
  private byToken = new Map<string, User>();
  private usage = new Map<string, number>();

  constructor(config: Config) {
    for (const u of config.users ?? []) {
      this.byToken.set(u.token, {
        name: u.name,
        token: u.token,
        quotaUsd: u.quotaUsd,
        allowedTools: u.allowedTools,
        allowWrite: u.allowWrite ?? true,
        isAdmin: false,
      });
    }
  }

  /** 根据令牌识别用户；未知令牌若等于管理员令牌则给管理员身份 */
  identify(token: string | undefined, adminToken: string | undefined): User | null {
    if (!token) return null;
    const u = this.byToken.get(token);
    if (u) return u;
    if (adminToken && token === adminToken) {
      return {
        name: "admin",
        token,
        allowWrite: true,
        isAdmin: true,
      };
    }
    return null;
  }

  /** 记录用户花费并返回是否超额 */
  charge(name: string, costUsd: number, quotaUsd?: number): boolean {
    const spent = (this.usage.get(name) ?? 0) + costUsd;
    this.usage.set(name, spent);
    return quotaUsd !== undefined && spent > quotaUsd;
  }

  spent(name: string): number {
    return this.usage.get(name) ?? 0;
  }

  /** 检查工具是否被该用户允许 */
  toolAllowed(user: User, toolName: string): boolean {
    if (!user.allowedTools || user.allowedTools.length === 0) return true;
    return user.allowedTools.some(
      (p) => p === toolName || (p.endsWith("*") && toolName.startsWith(p.slice(0, -1)))
    );
  }

  listUsers(): Array<{ name: string; quotaUsd?: number; spent: number }> {
    return [...this.byToken.values()].map((u) => ({
      name: u.name,
      quotaUsd: u.quotaUsd,
      spent: this.spent(u.name),
    }));
  }
}

export function createUserRegistry(config: Config): UserRegistry {
  return new UserRegistry(config);
}
