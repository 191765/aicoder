/** 终端主题 */
export interface Theme {
  name: string;
  reset: string;
  dim: string;
  bold: string;
  accent: string;
  success: string;
  warn: string;
  error: string;
  user: string;
  tool: string;
  border: string;
}

const ansi = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

export const THEMES: Record<string, Theme> = {
  dark: {
    name: "dark",
    ...ansi,
    accent: "\x1b[36m",
    success: "\x1b[32m",
    warn: "\x1b[33m",
    error: "\x1b[31m",
    user: "\x1b[32m",
    tool: "\x1b[33m",
    border: "\x1b[90m",
  },
  light: {
    name: "light",
    ...ansi,
    accent: "\x1b[34m",
    success: "\x1b[32m",
    warn: "\x1b[33m",
    error: "\x1b[31m",
    user: "\x1b[34m",
    tool: "\x1b[35m",
    border: "\x1b[90m",
  },
  plain: {
    name: "plain",
    reset: "",
    dim: "",
    bold: "",
    accent: "",
    success: "",
    warn: "",
    error: "",
    user: "",
    tool: "",
    border: "",
  },
};

export function getTheme(name?: string): Theme {
  return THEMES[name ?? "dark"] ?? THEMES.dark!;
}
