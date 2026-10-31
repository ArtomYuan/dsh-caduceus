/**
 * File logger tests: line format, level filtering, 0600 mode, rotation.
 * Every path is a mkdtemp directory; the real `~/.dsh` is never touched.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_LOG_MAX_FILES,
  FileLogger,
  formatLogLine,
} from '../src/file-logger.js';

function makeDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-caduceus-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('文件日志：行格式固定、目录自动创建、文件权限 0600', (t) => {
  const dir = makeDir(t);
  const filePath = join(dir, 'caduceus', 'caduceus.log');
  const logger = new FileLogger({
    filePath,
    now: () => Date.parse('2026-10-31T21:07:35.123Z'),
  });

  logger.info('hello');

  assert.equal(
    readFileSync(filePath, 'utf8'),
    '2026-10-31T21:07:35.123Z INFO  [caduceus] hello\n',
  );
  assert.equal(statSync(filePath).mode & 0o777, 0o600);
  assert.equal(formatLogLine('2026-10-31T21:07:35.123Z', 'warn', 'caduceus', 'x'),
    '2026-10-31T21:07:35.123Z WARN  [caduceus] x\n');
});

test('文件日志：默认 info 级别过滤 debug；level=debug 时写入 debug', (t) => {
  const dir = makeDir(t);
  const now = () => Date.parse('2026-10-31T21:07:35.123Z');

  const infoLogger = new FileLogger({ filePath: join(dir, 'info.log'), now });
  infoLogger.debug('hidden');
  infoLogger.info('visible info');
  infoLogger.warn('visible warn');
  infoLogger.error('visible error');
  const infoLines = readFileSync(join(dir, 'info.log'), 'utf8').split('\n').filter(Boolean);
  assert.equal(infoLines.length, 3);
  assert.ok(infoLines.every((line) => !line.includes('hidden')));

  const debugLogger = new FileLogger({ filePath: join(dir, 'debug.log'), now, level: 'debug' });
  debugLogger.debug('visible debug');
  assert.match(readFileSync(join(dir, 'debug.log'), 'utf8'), / DEBUG \[caduceus\] visible debug$/m);
});

test('文件日志：超过阈值轮转，最多保留 3 份 .1/.2/.3', (t) => {
  const dir = makeDir(t);
  const filePath = join(dir, 'caduceus.log');
  const logger = new FileLogger({
    filePath,
    maxBytes: 120,
    maxFiles: 3,
    now: () => Date.parse('2026-10-31T21:07:35.123Z'),
  });

  for (let index = 0; index < 20; index += 1) logger.info(`line-${index}-${'x'.repeat(30)}`);

  assert.ok(existsSync(filePath), 'current file must exist');
  for (const suffix of ['1', '2', '3']) {
    assert.ok(existsSync(`${filePath}.${suffix}`), `rotation file .${suffix} missing`);
  }
  assert.ok(!existsSync(`${filePath}.4`), 'must not keep a fourth rotation file');
  assert.deepEqual(readdirSync(dir).sort(), [
    'caduceus.log',
    'caduceus.log.1',
    'caduceus.log.2',
    'caduceus.log.3',
  ]);
  const current = readFileSync(filePath, 'utf8').trim().split('\n');
  assert.ok(current.length >= 1);
  for (const line of current) assert.match(line, /^\d{4}-\d{2}-\d{2}T.* INFO {2}\[caduceus\] line-/);
});

test('默认阈值常量为 5MB / 3 份', () => {
  assert.equal(DEFAULT_LOG_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(DEFAULT_LOG_MAX_FILES, 3);
});
