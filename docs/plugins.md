# 插件开发

插件是一个 ESM/CJS 模块文件（或 npm 包），默认导出对象。

## 最小插件

```js
// plugins/hello.mjs
export default {
  name: "hello",
  tools: [
    {
      name: "hello",
      description: "向某人问好",
      mutating: false,
      parameters: {
        type: "object",
        properties: { who: { type: "string", description: "名字" } },
        required: ["who"],
      },
      async run(args, ctx) {
        return `你好，${args.who}!`;
      },
    },
  ],
  commands: [
    {
      name: "hello",
      description: "插件命令示例",
      run(ctx) {
        ctx.print(`hello from plugin, args=${ctx.args.join(" ")}`);
      },
    },
  ],
  async setup(config) {
    // 可选：加载时初始化
  },
};
```

## 注册

在 `.aicoder.json` 中：

```json
{ "plugins": ["./plugins/hello.mjs", "@scope/aicoder-plugin-x"] }
```

- 本地路径支持 `./x`、`./x.mjs`、`./dir/index.js`
- npm 包名从工作目录的 `node_modules` 解析

## 工具命名与权限

- 插件工具注册为 `plugin__<插件名>__<工具名>`
- `mutating` 默认为 `true`，会按写操作走权限确认；只读工具请显式设为 `false`
- 可在 `.aicoder.json` 的 `permissions` 中用该全名配置

## Command 上下文

```ts
interface PluginCommandContext {
  args: string[];   // 命令参数
  workdir: string;  // 工作目录
  print(text: string): void;  // 输出
}
```

在对话中输入 `/命令名 参数...` 即可调用。
