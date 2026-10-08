// The generative roles (mapper, mission writer, hands) need a model that writes. Two backends:
//  · claude-code · the operator's local `claude` CLI on their own subscription, fully isolated
//  · openrouter  · an API model, with OPENROUTER_API_KEY
// Isolation for claude-code is required: without it the CLI loads the operator's whole context (CLAUDE.md,
// settings, MCP servers), about 60k tokens per call in a measured case, and that context would leak into the output.

export type Backend = 'claude-code' | 'openrouter';
export const MODELS: Record<Backend, { writer: string; hands: string }> = {
  'claude-code': { writer: 'sonnet', hands: 'haiku' },
  openrouter: { writer: 'anthropic/claude-sonnet-5.5', hands: 'anthropic/claude-haiku-5.5' },
};

export function pickBackend(prefer?: string): Backend {
  if (prefer === 'claude-code' || prefer === 'openrouter') return prefer;
  if (Bun.which('claude')) return 'claude-code';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  throw new Error('No model available for the writing roles: install Claude Code (`claude`) or set OPENROUTER_API_KEY.');
}

export async function generate<T>(backend: Backend, model: string, system: string, prompt: string, schema: object): Promise<T> {
  if (backend === 'claude-code') {
    const proc = Bun.spawn(['claude', '-p', prompt, '--model', model, '--system-prompt', system, '--json-schema', JSON.stringify(schema),
      '--output-format', 'json', '--setting-sources', '', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
      '--disable-slash-commands', '--exclude-dynamic-system-prompt-sections'],
      { cwd: '/tmp', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ANTHROPIC_API_KEY: '' } });
    const raw = await new Response(proc.stdout).text(); await proc.exited;
    let j: any; try { j = JSON.parse(raw); } catch { throw new Error(`claude returned non-JSON: ${raw.slice(0, 300)}`); }
    if (j.is_error || !j.structured_output) throw new Error(`claude failed: ${String(j.result ?? '').slice(0, 300)}`);
    return j.structured_output as T;
  }
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 16000, temperature: 0,
      tools: [{ type: 'function', function: { name: 'answer', description: 'Return the answer.', parameters: schema } }],
      tool_choice: { type: 'function', function: { name: 'answer' } },
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
  });
  const j: any = await r.json();
  const args = j.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) throw new Error(`model returned no answer: ${JSON.stringify(j.error ?? j).slice(0, 300)}`);
  return JSON.parse(args) as T;
}
