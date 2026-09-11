import * as vscode from "vscode";

/**
 * AICoder VS Code 扩展
 *
 * 通过终端调用 AICoder CLI，把选中的代码/提示发送给它。
 * 保持轻量：不重复实现 Agent 逻辑，复用命令行。
 */

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("aicoder");
}

function workspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

function baseCommand(): string {
  return cfg().get<string>("command") ?? "npx @191765/aicoder";
}

/** 在终端中运行一次性提问 */
function runPrompt(prompt: string): void {
  const term =
    vscode.window.terminals.find((t) => t.name === "AICoder") ??
    vscode.window.createTerminal({ name: "AICoder", cwd: workspaceCwd() });
  term.show();
  // 转义双引号，避免命令注入
  const safe = prompt.replace(/"/g, '\\"');
  term.sendText(`${baseCommand()} --prompt="${safe}"`);
}

async function ask(): Promise<void> {
  const question = await vscode.window.showInputBox({
    prompt: "向 AICoder 提问",
    placeHolder: "例如：解释这个项目的结构",
  });
  if (!question) return;
  runPrompt(question);
}

function withSelection(prefix: string, template: (code: string, file: string) => string): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("请先打开并选中代码。");
    return;
  }
  const selection = editor.selection;
  const code = editor.document.getText(selection.isEmpty ? undefined : selection);
  if (!code.trim()) {
    vscode.window.showWarningMessage("未选中任何代码。");
    return;
  }
  const file = vscode.workspace.asRelativePath(editor.document.uri);
  runPrompt(template(code, file));
  void prefix;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("aicoder.ask", ask),
    vscode.commands.registerCommand("aicoder.terminal", () => {
      const term =
        vscode.window.terminals.find((t) => t.name === "AICoder") ??
        vscode.window.createTerminal({ name: "AICoder", cwd: workspaceCwd() });
      term.show();
      const tui = cfg().get<boolean>("useTui") ? " --tui" : "";
      term.sendText(`${baseCommand()}${tui}`);
    }),
    vscode.commands.registerCommand("aicoder.startWeb", () => {
      const term =
        vscode.window.terminals.find((t) => t.name === "AICoder Web") ??
        vscode.window.createTerminal({ name: "AICoder Web", cwd: workspaceCwd() });
      term.show();
      term.sendText(`${baseCommand()} web`);
    }),
    vscode.commands.registerCommand("aicoder.explainSelection", () =>
      withSelection("解释", (code, file) =>
        `请解释以下来自 ${file} 的代码，说明其作用和关键逻辑：\n\n\`\`\`\n${code}\n\`\`\``
      )
    ),
    vscode.commands.registerCommand("aicoder.fixSelection", () =>
      withSelection("修复", (code, file) =>
        `请检查并修复以下来自 ${file} 的代码中的问题，给出修改后的完整代码：\n\n\`\`\`\n${code}\n\`\`\``
      )
    )
  );
}

export function deactivate(): void {
  /* 无需清理 */
}
