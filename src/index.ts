import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'
const BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '')
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
  // 注意这是 JSON 字符串，不是对象，需要自己解析。
  function: { name: string; arguments: string }
}

interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<string> | string
}

interface ChatReply {
  content: string | null
  tool_calls?: ToolCall[]
}

const echoTool: Tool = {
  name: 'echo',
  description: '原样返回传入的文本。用来验证“模型调用工具、结果回到模型”这条链路。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要回显的文本' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  execute(args) {
    const text = typeof args.text === 'string' ? args.text : ''
    return `echo: ${text}`
  },
}

const tools: Tool[] = [echoTool]

// execute 是函数，不能序列化，也不能发给模型。
const toolSchemas = tools.map(tool => ({
  type: 'function' as const,
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}))

async function chat(messages: Message[]): Promise<ChatReply> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (apiKey === undefined || apiKey === '') {
    throw new Error('缺少 DEEPSEEK_API_KEY：在项目根目录的 .env 里写入 DEEPSEEK_API_KEY=你的key')
  }

  // 每次请求都带完整历史，模型本身不保存状态。
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
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

  const data = (await response.json()) as { choices?: { message?: ChatReply }[] }
  const reply = data.choices?.[0]?.message
  if (reply === undefined) {
    throw new Error('模型返回中没有 message')
  }
  return reply
}

// 所有失败都转成文本返回，让模型看到错误后自己决定下一步。
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

  // 一次 step 对应一次模型请求。
  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const reply = await chat(messages)

    // 助手消息要先入日志，后面的 tool 结果靠它里面的 id 配对。
    messages.push({
      role: 'assistant',
      content: reply.content ?? '',
      tool_calls: reply.tool_calls,
    })

    if (reply.tool_calls === undefined || reply.tool_calls.length === 0) {
      return reply.content ?? ''
    }

    for (const call of reply.tool_calls) {
      const result = await runTool(call)
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
    }
  }

  throw new Error(`超过 ${MAX_STEPS} 步仍未结束，已中断本轮`)
}

const SYSTEM_PROMPT = '你是运行在终端里的最小 agent。用户要求回显文本时必须调用 echo 工具；其他情况直接回答，保持简短。'

async function main(): Promise<void> {
  if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY === '') {
    console.error('缺少 DEEPSEEK_API_KEY：在项目根目录的 .env 里写入 DEEPSEEK_API_KEY=你的key，然后重新启动。')
    process.exitCode = 1
    return
  }

  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }]
  const rl = createInterface({ input: stdin, output: stdout })

  console.log('最小 agent 已启动。输入 /exit 退出。')
  while (true) {
    const line = (await rl.question('\n你 > ')).trim()
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
