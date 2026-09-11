/**
 * 示例插件：演示工具与命令。
 *
 * 使用方式：在 .aicoder.json 中加入
 *   { "plugins": ["./examples/plugins/hello.mjs"] }
 */
export default {
  name: "hello",

  tools: [
    {
      name: "hello",
      description: "向某人问好",
      mutating: false,
      parameters: {
        type: "object",
        properties: {
          who: { type: "string", description: "名字" },
        },
        required: ["who"],
      },
      async run(args) {
        const name = typeof args.who === "string" ? args.who : "world";
        return `你好，${name}! 这是来自插件工具的问候。`;
      },
    },
    {
      name: "word_count",
      description: "统计一段文本的词数（写操作示例，默认需确认）",
      mutating: true,
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "要统计的文本" },
        },
        required: ["text"],
      },
      async run(args) {
        const text = typeof args.text === "string" ? args.text : "";
        const words = text.trim() ? text.trim().split(/\s+/).length : 0;
        return `词数: ${words}`;
      },
    },
  ],

  commands: [
    {
      name: "hello",
      description: "打招呼命令",
      run(ctx) {
        const who = ctx.args[0] ?? "world";
        ctx.print(`hello, ${who}! (workdir=${ctx.workdir})`);
      },
    },
  ],

  async setup() {
    // 可选：初始化逻辑
  },
};
