import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { readFile, writeFile } from 'node:fs/promises'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

const providers: Record<string, { baseUrl: string; model: string }> = {
  kimi: { baseUrl: 'https://api.kimi.com/coding/v1', model: 'k3.1-pro-highspeed' },
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
}
const PROVIDER = process.env.PROVIDER ?? 'kimi'
const preset = providers[PROVIDER]
if (preset === undefined) {
  throw new Error(`没有 ${PROVIDER} 这家，在 providers 里加一下`)
}

const MODEL = process.env.MODEL ?? preset.model
const BASE_URL = (process.env.BASE_URL ?? preset.baseUrl).replace(/\/$/, '')
// API_KEY 优先，没有再按 provider 找
const API_KEY = process.env.API_KEY ?? process.env[`${PROVIDER.toUpperCase()}_API_KEY`]
// 防止模型反复调用工具停不下来。
const MAX_STEPS = 8

type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  // tool_call_id 必须指回对应的那次调用，否则接口会拒绝整个请求。
  | { role: 'tool'; content: string; tool_call_id: string }

interface ToolCall {
  id: string
  type: 'function'
  // arguments 是 JSON 字符串，不是对象，得自己 parse
  function: { name: string; arguments: string }
}

interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<string> | string
}

interface Usage {
  prompt_tokens: number
  completion_tokens: number
}

interface ChatReply {
  content: string | null
  tool_calls?: ToolCall[]
  usage?: Usage
}

const readFileTool: Tool = {
  name: 'read_file',
  description: '读取本地文件内容',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  execute(args) {
    const path = typeof args.path === 'string' ? args.path : ''
    return readFile(path, 'utf8')
  },
}

const writeFileTool: Tool = {
  name: 'write_file',
  description: '把内容写入本地文件（不存在则创建，存在则覆盖）',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '要写入的完整内容' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async execute(args) {
    const path = typeof args.path === 'string' ? args.path : ''
    const content = typeof args.content === 'string' ? args.content : ''
    await writeFile(path, content, 'utf8')
    return `已写入 ${path}（${content.length} 字符）`
  },
}

const editFileTool: Tool = {
  name: 'edit_file',
  description: '把文件里的一段原文替换成新文本，原文必须唯一匹配',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要被替换的原文，必须在文件中唯一出现' },
      new_string: { type: 'string', description: '替换成的新文本' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  async execute(args) {
    const path = typeof args.path === 'string' ? args.path : ''
    const oldString = typeof args.old_string === 'string' ? args.old_string : ''
    const newString = typeof args.new_string === 'string' ? args.new_string : ''
    const content = await readFile(path, 'utf8')
    const count = content.split(oldString).length - 1
    if (count === 0) {
      throw new Error('old_string 在文件里不存在，先 read_file 看看实际内容')
    }
    // 多处匹配时不知道模型想改哪处，宁可报错让它给更长的原文
    if (count > 1) {
      throw new Error(`old_string 匹配到 ${count} 处，把原文写长一点保证唯一`)
    }
    await writeFile(path, content.replace(oldString, newString), 'utf8')
    return `已修改 ${path}`
  },
}

const runShellTool: Tool = {
  name: 'run_shell',
  description: '在 shell 里执行命令并返回输出',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  async execute(args) {
    const command = typeof args.command === 'string' ? args.command : ''
    // 命令卡住不能拖死整个 agent，10 秒够跑大多数测试了
    const { stdout, stderr } = await execAsync(command, { timeout: 10_000 })
    return [stdout, stderr].filter(Boolean).join('\n') || '(无输出)'
  },
}

const tools: Tool[] = [readFileTool, writeFileTool, editFileTool, runShellTool]

// 给模型的只有 schema，execute 留在本地
const toolSchemas = tools.map(tool => ({
  type: 'function' as const,
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}))

async function chat(messages: Message[]): Promise<ChatReply> {
  if (API_KEY === undefined || API_KEY === '') {
    throw new Error(`缺少 key：在 .env 里写 ${PROVIDER.toUpperCase()}_API_KEY=你的key`)
  }

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: toolSchemas,
      tool_choice: 'auto',
    }),
  })

  if (!response.ok) {
    throw new Error(`模型请求失败 ${response.status}: ${await response.text()}`)
  }

  const data = (await response.json()) as {
    choices?: { message?: ChatReply }[]
    usage?: Usage
  }
  const reply = data.choices?.[0]?.message
  if (reply === undefined) {
    throw new Error('模型返回中没有 message')
  }
  reply.usage = data.usage
  return reply
}

// 错误不往上抛，转成文本让模型自己看着办
async function runTool(call: ToolCall): Promise<string> {
  const { name } = call.function
  console.log(`  [工具] ${name}(${call.function.arguments})`)

  const tool = tools.find(item => item.name === name)
  if (tool === undefined) {
    return `错误：不存在名为 ${name} 的工具`
  }

  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>
  } catch {
    return `错误：工具参数不是合法 JSON：${call.function.arguments}`
  }

  try {
    return await tool.execute(args)
  } catch (error) {
    return `错误：${error instanceof Error ? error.message : String(error)}`
  }
}

async function runTurn(messages: Message[], input: string): Promise<string> {
  messages.push({ role: 'user', content: input })

  let promptTotal = 0
  let completionTotal = 0

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const reply = await chat(messages)

    if (reply.usage !== undefined) {
      promptTotal += reply.usage.prompt_tokens
      completionTotal += reply.usage.completion_tokens
      console.log(
        `  [tokens] 第${step}圈 输入${reply.usage.prompt_tokens} / 输出${reply.usage.completion_tokens}`,
      )
    }

    // assistant 先入历史，tool 结果要靠它里面的 id 配对
    messages.push({
      role: 'assistant',
      content: reply.content ?? '',
      tool_calls: reply.tool_calls,
    })

    if (reply.tool_calls === undefined || reply.tool_calls.length === 0) {
      console.log(
        `  [tokens] 本轮共${promptTotal + completionTotal}（输入${promptTotal} / 输出${completionTotal}）`,
      )
      return reply.content ?? ''
    }

    for (const call of reply.tool_calls) {
      const result = await runTool(call)
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
    }
  }

  throw new Error(`超过 ${MAX_STEPS} 步仍未结束，已中断本轮`)
}

const SYSTEM_PROMPT = '你是运行在终端里的最小 agent。读文件用 read_file，新建或整文件重写用 write_file，改文件里的一段用 edit_file，跑命令用 run_shell。其他情况直接回答，保持简短。'

async function main(): Promise<void> {
  if (API_KEY === undefined || API_KEY === '') {
    console.error(`缺少 key：在 .env 里写 ${PROVIDER.toUpperCase()}_API_KEY=你的key，然后重新启动。`)
    process.exitCode = 1
    return
  }

  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }]
  const rl = createInterface({ input: stdin, output: stdout })

  console.log(`最小 agent 已启动（${PROVIDER} / ${MODEL}）。输入 /exit 退出。`)
  while (true) {
    // 管道喂输入时 EOF 会把 readline 关掉，question 直接炸，退出去就好
    const line = await rl.question('\n你 > ').then(text => text.trim()).catch(() => null)
    if (line === null) break
    if (line === '') continue
    if (line === '/exit') break

    try {
      const answer = await runTurn(messages, line)
      console.log(`\n助手 > ${answer || '(空回复)'}`)
    } catch (error) {
      console.error(`\n出错了：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  rl.close()
}

await main()
