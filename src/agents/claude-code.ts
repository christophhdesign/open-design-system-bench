import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import type { AgentAdapter, AgentGenerateRequest, AgentGenerateResult } from '../types.ts';
import { looksLikeUsageLimit } from './errors.ts';

// Tools the generating agent may use inside the fixture workspace. No Bash,
// no web access: runs stay hermetic and cheap; graders do the verification.
const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'Edit', 'Write', 'MultiEdit', 'TodoWrite'];
const DISALLOWED_TOOLS = ['WebSearch', 'WebFetch', 'Bash', 'Task', 'NotebookEdit'];

interface StreamResultEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  result?: string;
}

export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude-code',

  detect() {
    return new Promise((resolve) => {
      execFile('claude', ['--version'], { timeout: 15_000 }, (err, stdout) => {
        if (err) resolve({ ok: false, error: err.message });
        else resolve({ ok: true, version: stdout.trim() });
      });
    });
  },

  async generate(req: AgentGenerateRequest): Promise<AgentGenerateResult> {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      req.model,
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      [...ALLOWED_TOOLS, ...(req.extraAllowedTools ?? [])].join(','),
      '--disallowedTools',
      DISALLOWED_TOOLS.join(','),
      // Never load project/user MCP servers into a benchmark cell.
      '--strict-mcp-config',
    ];
    for (const dir of req.addDirs) args.push('--add-dir', dir);
    if (req.appendSystemPrompt) args.push('--append-system-prompt', req.appendSystemPrompt);
    if (req.mcpConfigPath) args.push('--mcp-config', req.mcpConfigPath);

    const startedAt = Date.now();
    const transcript = createWriteStream(req.transcriptPath);

    return await new Promise<AgentGenerateResult>((resolve) => {
      // Own process group so a timeout can kill claude and any children it spawned.
      const child = spawn('claude', args, {
        cwd: req.workspaceDir,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let timedOut = false;
      let settled = false;
      let resultEvent: StreamResultEvent | undefined;
      let stderrTail = '';
      let lineBuf = '';

      const killTree = (signal: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree('SIGTERM');
        setTimeout(() => killTree('SIGKILL'), 5_000).unref();
      }, req.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        transcript.write(text);
        lineBuf += text;
        let nl: number;
        while ((nl = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, nl).trim();
          lineBuf = lineBuf.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          try {
            const evt = JSON.parse(line) as StreamResultEvent;
            if (evt.type === 'result') resultEvent = evt;
          } catch {
            // non-JSON diagnostic line interleaved in stdout — ignore
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4_000);
        transcript.write(chunk);
      });

      const settle = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        transcript.end();
        const ok = !timedOut && exitCode === 0 && !resultEvent?.is_error;
        const resultText = resultEvent?.result ?? (ok ? undefined : stderrTail || undefined);
        const errorKind: AgentGenerateResult['errorKind'] = ok
          ? undefined
          : looksLikeUsageLimit(resultText) || looksLikeUsageLimit(stderrTail)
            ? 'usage-limit'
            : 'other';
        resolve({
          ok,
          timedOut,
          exitCode,
          durationMs: resultEvent?.duration_ms ?? Date.now() - startedAt,
          costUsd: resultEvent?.total_cost_usd,
          numTurns: resultEvent?.num_turns,
          transcriptPath: req.transcriptPath,
          resultText,
          errorKind,
        });
      };

      child.on('error', () => settle(null));
      child.on('close', (code) => settle(code));

      child.stdin.write(req.prompt);
      child.stdin.end();
    });
  },
};
