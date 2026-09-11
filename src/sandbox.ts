import type { Config } from "./config.js";

/**
 * 执行沙箱（最佳努力）
 *
 * 跨平台无法真正隔离，但可显著降低风险：
 *  - 环境变量白名单：只透传必要变量，避免泄露密钥给子进程
 *  - 输出大小与执行超时限制
 *  - 可选网络禁用（Linux: unshare -n；其它平台给出提示）
 *  - 工作目录限定
 *
 * 强烈建议在生产环境把 AICoder 运行在容器/虚拟机中（见 Dockerfile）。
 */

export interface SandboxConfig {
  enabled: boolean;
  /** 允许透传的环境变量名（其余被清除） */
  envAllowlist: string[];
  /** 禁用网络（尽力而为） */
  noNetwork: boolean;
  /** 最大输出字节数 */
  maxOutputBytes: number;
}

const DEFAULT_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "ComSpec",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
];

let sandbox: SandboxConfig = {
  enabled: false,
  envAllowlist: DEFAULT_ALLOWLIST,
  noNetwork: false,
  maxOutputBytes: 20_000,
};

export function initSandbox(config: Config): void {
  const s = config.sandbox;
  sandbox = {
    enabled: s?.enabled ?? false,
    envAllowlist: s?.envAllowlist?.length ? s.envAllowlist : DEFAULT_ALLOWLIST,
    noNetwork: s?.noNetwork ?? false,
    maxOutputBytes: s?.maxOutputBytes ?? 20_000,
  };
}

/** 构造受限的环境变量集合 */
export function sandboxEnv(): NodeJS.ProcessEnv {
  if (!sandbox.enabled) return { ...process.env };
  const env: NodeJS.ProcessEnv = {};
  for (const key of sandbox.envAllowlist) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // 显式屏蔽常见密钥
  for (const k of Object.keys(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k) && !sandbox.envAllowlist.includes(k)) {
      delete env[k];
    }
  }
  return env;
}

export interface SandboxCommand {
  shell: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  maxOutputBytes: number;
}

/** 根据平台与配置包装命令 */
export function wrapCommand(command: string): SandboxCommand {
  const isWin = process.platform === "win32";

  if (sandbox.enabled && sandbox.noNetwork && !isWin) {
    // 尽力用 unshare -n 断网（无权限时会失败，调用方会得到错误输出）
    return {
      shell: "unshare",
      args: ["-n", "/bin/sh", "-c", command],
      env: sandboxEnv(),
      maxOutputBytes: sandbox.maxOutputBytes,
    };
  }
  const shell = isWin ? "powershell.exe" : "/bin/sh";
  const args = isWin
    ? ["-NoProfile", "-NonInteractive", "-Command", `${command}; exit $LASTEXITCODE`]
    : ["-c", command];
  return {
    shell,
    args,
    env: sandboxEnv(),
    maxOutputBytes: sandbox.maxOutputBytes,
  };
}

export function sandboxStatus(): { enabled: boolean; noNetwork: boolean } {
  return { enabled: sandbox.enabled, noNetwork: sandbox.noNetwork };
}
