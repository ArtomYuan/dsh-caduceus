import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWorkbenchHandler,
  type WorkbenchDeps,
  type WorkbenchRequest,
  type WorkbenchResponse,
} from '../src/workbench.js';
import { DEFAULT_CARD_POLICY } from '../src/card-policy.js';

interface Recorded {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

function call(
  handler: (req: WorkbenchRequest, res: WorkbenchResponse) => Promise<void>,
  req: WorkbenchRequest,
): Promise<Recorded> {
  const out: Recorded = {};
  const res = {
    writeHead(status: number, headers?: Record<string, string>): void {
      out.status = status;
      out.headers = headers;
    },
    end(body?: string): void {
      out.body = body;
    },
  };
  return handler(req, res).then(() => out);
}

function deps(overrides: Partial<WorkbenchDeps> = {}): WorkbenchDeps {
  return {
    version: '9.9.9',
    policy: () => ({ ...DEFAULT_CARD_POLICY, transcript: 'detailed', developerTools: true }),
    sessions: () => ({
      available: true,
      rows: [
        {
          sessionId: 'feishu-1794018257825',
          messages: 20,
          rounds: 1,
          steps: 40,
          totalTokens: 1723236,
          tokensPerSecond: 4.28,
        },
      ],
    }),
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

test('workbench：GET /caduceus/state 返回档位与会话', async () => {
  const handler = createWorkbenchHandler(deps());
  const res = await call(handler, { method: 'GET', url: '/caduceus/state' });
  assert.equal(res.status, 200);
  assert.equal(res.headers?.['cache-control'], 'no-store');
  const payload = JSON.parse(res.body ?? '{}');
  assert.equal(payload.ok, true);
  assert.equal(payload.version, '9.9.9');
  assert.equal(payload.generatedAt, 1_700_000_000_000);
  assert.equal(payload.policy.transcript, 'detailed');
  assert.equal(payload.policy.developerTools, true);
  assert.equal(payload.sessions.length, 1);
  assert.equal(payload.sessions[0].sessionId, 'feishu-1794018257825');
  assert.equal(payload.sessions[0].tokensPerSecond, 4.28);
});

test('workbench：路由根同义、未知路径 404、非 GET 405', async () => {
  const handler = createWorkbenchHandler(deps());
  assert.equal((await call(handler, { url: '/caduceus' })).status, 200);
  assert.equal((await call(handler, { url: '/caduceus/' })).status, 200);
  const missing = await call(handler, { url: '/caduceus/nope' });
  assert.equal(missing.status, 404);
  const wrong = await call(handler, { method: 'POST', url: '/caduceus/state' });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers?.allow, 'GET');
});

test('workbench：会话读取抛错时降级为空列表，档位仍在', async () => {
  const handler = createWorkbenchHandler(
    deps({
      sessions: () => {
        throw new Error('disk gone');
      },
    }),
    '/caduceus',
  );
  const res = await call(handler, { url: '/caduceus/state' });
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body ?? '{}');
  assert.deepEqual(payload.sessions, []);
  assert.equal(payload.sessionsAvailable, false);
  assert.equal(payload.policy.performance, DEFAULT_CARD_POLICY.performance);
});

test('workbench：前缀参数可变，挂载到别的路径也认', async () => {
  const handler = createWorkbenchHandler(deps(), '/x-cad');
  assert.equal((await call(handler, { url: '/x-cad/state' })).status, 200);
  assert.equal((await call(handler, { url: '/caduceus/state' })).status, 404);
});
