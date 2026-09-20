import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = process.env.DISPOSABLE_CONTEXT_ROOT || join(homedir(), '.codex', 'disposable-context');
const QUEUE = join(ROOT, 'queue');
const STATES = join(ROOT, 'states');
const LOG = join(ROOT, 'orchestrator.log');
const MAX_WAIT_MS = 15 * 60 * 1000;

mkdirSync(QUEUE, { recursive: true });
mkdirSync(STATES, { recursive: true });

function log(message) {
  try { writeFileSync(LOG, `${new Date().toISOString()} ${message}\n`, { flag: 'a' }); } catch {}
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, path);
}

function clip(value, limit = 4000) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function list(value, limit = 50) {
  return Array.isArray(value) ? value.filter(v => typeof v === 'string').slice(0, limit).map(v => clip(v, 1000)) : [];
}

function extractObjects(text) {
  const objects = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    let depth = 0; let quoted = false; let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const c = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
        continue;
      }
      if (c === '"') quoted = true;
      else if (c === '{') depth += 1;
      else if (c === '}' && --depth === 0) {
        try { objects.push(JSON.parse(text.slice(start, i + 1))); } catch {}
        start = i;
        break;
      }
    }
  }
  return objects;
}

function parseEventClosed(text) {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1]).join('\n');
  const candidates = extractObjects(fenced).reverse();
  for (const candidate of candidates) {
    if (candidate?.type !== 'EVENT_CLOSED') continue;
    const open = Array.isArray(candidate.open_issues) ? candidate.open_issues : candidate.unresolved;
    if (typeof candidate.event_id !== 'string' || !candidate.event_id.trim()) return null;
    if (!Array.isArray(open) || open.length) return null;
    const event = {
      event_id: clip(candidate.event_id, 200),
      goal: clip(candidate.goal || candidate.objective),
      result: clip(candidate.result || candidate.summary),
      evidence: list(candidate.evidence),
      changed_files: list(candidate.changed_files),
      decisions: list(candidate.decisions),
      open_issues: [],
      next_event: clip(candidate.next_event),
      evidence_paths: list(candidate.evidence_paths),
    };
    if (!event.next_event) event._skip = 'no_next_event';
    return event;
  }
  return null;
}

function lastAgentMessage(thread, turnId) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const turn = turnId ? turns.find(t => t.id === turnId) : turns.at(-1);
  if (turnId && !turn) return null;
  const items = Array.isArray(turn?.items) ? turn.items : [];
  return [...items].reverse().find(item => item.type === 'agentMessage' && typeof item.text === 'string')?.text || null;
}

function codexBinary() {
  if (process.env.CODEX_BIN && existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  if (process.platform === 'win32') {
    const root = join(homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
    if (existsSync(root)) {
      const dirs = readdirSync(root, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name).sort().reverse();
      for (const dir of dirs) {
        const candidate = join(root, dir, 'codex.exe');
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return 'codex';
}

class AppServer {
  constructor() {
    this.pending = new Map();
    this.nextId = 1;
    this.completed = new Map();
    this.buffer = '';
    this.proc = spawn(codexBinary(), ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc.stdout.on('data', chunk => this.consume(chunk.toString()));
    this.proc.stderr.on('data', chunk => log(`app-server: ${chunk.toString().trim()}`));
  }
  consume(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/); this.buffer = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id); this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message || 'app-server error'));
        else entry.resolve(message.result);
      } else if (message.method === 'turn/completed') {
        this.completed.set(message.params?.threadId, message.params);
      } else if (message.id !== undefined && message.method) {
        // Background turns cannot display approval UI. Deny requests rather than leaving a stuck worker.
        this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'background disposable-context turn cannot request approval' } })}\n`);
      }
    }
  }
  request(method, params, timeout = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timeout`)); }, timeout);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async waitThreadReady(threadId) {
    const started = Date.now();
    while (Date.now() - started < 120000) {
      const result = await this.request('thread/read', { threadId, includeTurns: false });
      const status = result?.thread?.status?.type;
      if (status === 'idle') return;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('new thread did not become ready before timeout');
  }
  async waitCompleted(threadId, turnId) {
    const started = Date.now();
    while (Date.now() - started < MAX_WAIT_MS) {
      if (this.completed.has(threadId)) return this.completed.get(threadId);
      const result = await this.request('thread/read', { threadId, includeTurns: true });
      const turn = result?.thread?.turns?.find(item => item.id === turnId);
      if (turn && turn.status !== 'inProgress') return { threadId, turn };
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('new turn did not complete before timeout');
  }
  close() { try { this.proc.kill(); } catch {} }
}

function statePath(sourceThreadId, eventId) {
  const key = Buffer.from(eventId).toString('base64url').slice(0, 180);
  return join(STATES, sourceThreadId, `${key}.json`);
}

async function run(payload) {
  const sourceThreadId = payload.session_id || payload.thread_id || process.env.CODEX_THREAD_ID;
  const turnId = payload.turn_id;
  if (!sourceThreadId) return;
  const server = new AppServer();
  try {
    await server.request('initialize', {
      clientInfo: { name: 'disposable-context', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    server.proc.stdin.write('{"jsonrpc":"2.0","method":"initialized","params":{}}\n');
    let thread;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const result = await server.request('thread/read', { threadId: sourceThreadId, includeTurns: true });
      thread = result?.thread;
      const text = lastAgentMessage(thread, turnId);
      const event = text && parseEventClosed(text);
      if (event) {
        const path = statePath(sourceThreadId, event.event_id);
        if (existsSync(path)) return;
        const base = {
          version: 'STATE_V1', event_id: event.event_id, source_thread_id: sourceThreadId,
          goal: event.goal, result: event.result, evidence: event.evidence,
          changed_files: event.changed_files, decisions: event.decisions,
          open_issues: event.open_issues, next_event: event.next_event,
          evidence_paths: event.evidence_paths, created_at: new Date().toISOString(), status: 'closed'
        };
        atomicWrite(path, base);
        if (event._skip || !event.next_event) return;
        if (process.env.DISPOSABLE_CONTEXT_DRY_RUN === '1') {
          log(`dry-run: would start a new thread for event ${event.event_id}`);
          return;
        }
        const newThread = await server.request('thread/start', {
          projectId: thread.projectId ?? null,
          cwd: thread.cwd || payload.cwd || process.cwd(),
          model: thread.model || null,
          modelProvider: thread.modelProvider || null,
          historyMode: 'paginated',
          ephemeral: false,
          threadSource: 'user'
        });
        const newId = newThread?.thread?.id;
        if (!newId) throw new Error('thread/start did not return an id');
        atomicWrite(path, { ...base, new_thread_id: newId, status: 'started' });
        const handoff = [
          '这是一个新的阶段性任务线程。不要回读旧对话，除非状态中的证据路径明确要求。',
          '交接状态（STATE_V1）：', JSON.stringify({ ...base, new_thread_id: newId }),
          '', '下一事件：', event.next_event,
          '', '完成这个事件且有下一步时，再按协议输出 EVENT_CLOSED JSON。'
        ].join('\n');
        await server.waitThreadReady(newId);
        let turn;
        let completion;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          turn = await server.request('turn/start', {
            threadId: newId,
            cwd: thread.cwd || payload.cwd || process.cwd(),
            model: thread.model || null,
            input: [{ type: 'text', text: handoff }]
          });
          atomicWrite(path, { ...base, new_thread_id: newId, new_turn_id: turn?.turn?.id || null, status: 'running' });
          completion = await server.waitCompleted(newId, turn?.turn?.id);
          if (completion?.turn?.status === 'completed') break;
          log(`new turn ${turn?.turn?.id || 'unknown'} ended as ${completion?.turn?.status || 'unknown'}; retry ${attempt + 1}/2`);
          await server.waitThreadReady(newId);
        }
        atomicWrite(path, {
          ...base,
          new_thread_id: newId,
          new_turn_id: turn?.turn?.id || null,
          status: completion?.turn?.status === 'completed' ? 'completed' : 'interrupted'
        });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    log(`no EVENT_CLOSED in thread ${sourceThreadId}`);
  } catch (error) {
    log(`rotation failed for ${sourceThreadId}: ${error.stack || error.message}`);
  } finally { server.close(); }
}

async function main() {
  if (process.argv[2] === '--self-test') {
    const event = parseEventClosed('done\n```json\n{"type":"EVENT_CLOSED","event_id":"evt_test","result":"ok","evidence":[],"changed_files":[],"decisions":[],"open_issues":[],"next_event":"next"}\n```');
    const ignored = parseEventClosed('{"type":"EVENT_CLOSED","event_id":"evt_unfenced","open_issues":[],"next_event":"next"}');
    if (!event || event.event_id !== 'evt_test' || event.next_event !== 'next' || ignored) throw new Error('EVENT_CLOSED parser self-test failed');
    console.log('disposable-context self-test: ok');
    return;
  }
  if (process.argv[2] === '--worker') {
    const file = process.argv[3];
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    try { await run(payload); } finally { try { unlinkSync(file); } catch {} }
    return;
  }
  let payload; try { payload = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, '')); } catch { return; }
  if (payload.hook_event_name === 'UserPromptSubmit') {
    console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: '阶段性次抛协议：只有当前事件已完成、open_issues 为空且存在下一事件时，才在回复末尾输出一个 fenced JSON：{"type":"EVENT_CLOSED","event_id":"...","goal":"...","result":"...","evidence":[],"changed_files":[],"decisions":[],"open_issues":[],"next_event":"...","evidence_paths":[]}。普通回复不要输出。'
    } }));
    return;
  }
  if (payload.hook_event_name !== 'Stop' || payload.stop_hook_active) return;
  const file = join(QUEUE, `${Date.now()}-${process.pid}.json`);
  atomicWrite(file, payload);
  const child = spawn(process.execPath, [process.argv[1], '--worker', file], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

main().catch(error => log(error.stack || error.message));

