# my-agent

跑在终端里的最小 agent。核心只有一件事：让模型能调用工具，把执行结果送回去，再由模型决定下一步。

## 环境

- Node.js >= 22.19（可以直接运行 `.ts`，不需要额外编译）
- 任意 OpenAI 兼容接口的 Key（Kimi、DeepSeek 都试过）

## 运行

```bash
pnpm install
```

在项目根目录创建 `.env`，写入对应家的 key：

```
KIMI_API_KEY=你的key
# 或者 DEEPSEEK_API_KEY=你的key
```

内置了 kimi 和 deepseek 两家的地址和模型名，`PROVIDER` 一行切换，默认 kimi：

```
PROVIDER=deepseek
```

key 各家放各的，切换时不用动。想换型号或自建端点，再用 `MODEL` / `BASE_URL` 覆盖。

启动：

```bash
pnpm dev
```

## 用法

启动后直接输入问题，`/exit` 退出。

试试：

```
读一下 package.json，讲讲这个项目
```

终端里出现 `[工具] read_file(...)`，说明模型确实发起了工具调用，而不是自己编了答案。

每圈请求都会打印 token 用量，工具调得越多，后面几圈的输入越大。

## 结构

目前只有一个文件 `src/index.ts`，按顺序分六段：

1. 配置：模型名、接口地址、步数上限
2. 消息类型：`Message` / `ToolCall` / `Tool`
3. 工具定义：`read_file` / `write_file` / `edit_file` / `run_shell` 和注册表
4. `chat`：发一次请求
5. `runTool`：执行一次工具调用
6. `runTurn`：一轮对话的循环，`main` 是终端入口

## 几个取舍

- **单文件**：先看清完整闭环，等工具多了再按职责拆开。
- **非流式**：一次拿完整回复，代码简单；代价是长回答要等全部返回。
- **工具错误转成文本**：不抛异常，让模型看到错误后自己调整参数重试。
- **消息只在内存**：退出即清空，适合验证链路，不适合复盘。

## 待办

- 消息落盘，支持重放
- 上下文裁剪，避免历史无限增长
- 请求超时和重试
