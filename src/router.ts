import type { Config } from "./config.js";
import type { ModelRoute } from "./configfile.js";

/**
 * 多模型路由
 *
 * 根据任务类型 / 工具名 / 用户输入正则，把请求路由到不同模型。
 * 典型用法：用便宜快速的模型做探索，用强模型做代码编辑。
 */

export interface RouteContext {
  /** 任务类型：explore | edit | test | chat */
  task?: string;
  /** 当前触发的工具名 */
  tool?: string;
  /** 用户输入 */
  input?: string;
}

/** 依据工具名推断任务类型 */
export function inferTaskForTool(tool: string): string {
  switch (tool) {
    case "read_file":
    case "list_dir":
    case "glob":
    case "search":
    case "git_status":
    case "git_diff":
    case "git_log":
    case "git_show":
      return "explore";
    case "lsp_definition":
    case "lsp_references":
    case "lsp_hover":
    case "lsp_diagnostics":
      return "explore";
    case "write_file":
    case "edit_file":
      return "edit";
    case "run_command":
      return "test";
    default:
      return "execute";
  }
}

export class ModelRouter {
  private routes: ModelRoute[];
  private base: Config;

  constructor(base: Config, routes: ModelRoute[]) {
    this.base = base;
    this.routes = routes ?? [];
  }

  get enabled(): boolean {
    return this.routes.length > 0;
  }

  /**
   * 返回命中的路由对应的 Config 覆盖（若无命中返回 base）。
   * 匹配优先级按数组顺序，第一个命中的生效。
   */
  resolve(ctx: RouteContext): Config {
    for (const route of this.routes) {
      if (!route.match) {
        // 无 match 视为默认路由
        if (route.model) return this.applyRoute(route);
        continue;
      }
      if (route.match.task && route.match.task !== ctx.task) continue;
      if (route.match.tool && route.match.tool !== ctx.tool) continue;
      if (route.match.input) {
        try {
          if (!new RegExp(route.match.input, "i").test(ctx.input ?? "")) continue;
        } catch {
          continue;
        }
      }
      if (route.model) return this.applyRoute(route);
    }
    return this.base;
  }

  private applyRoute(route: ModelRoute): Config {
    return {
      ...this.base,
      model: route.model,
      baseURL: route.baseURL ?? this.base.baseURL,
      apiKey: route.apiKey ?? this.base.apiKey,
      temperature: route.temperature ?? this.base.temperature,
    };
  }
}
