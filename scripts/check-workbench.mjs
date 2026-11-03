#!/usr/bin/env node
/**
 * Static workbench-package self-check. Run after `npm run build`; exits non-zero
 * with the exact missing item so an install gate can fail loudly.
 */
import { existsSync, readFileSync } from 'node:fs';

let passed = 0;
const failures = [];
const pass = (label) => {
  passed += 1;
  console.log(`ok - ${label}`);
};
const fail = (label, detail) => {
  failures.push(detail === undefined ? label : `${label}: ${detail}`);
  console.log(`not ok - ${label}${detail === undefined ? '' : ` (${detail})`}`);
};

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;
const required = [
  ['dsh.bundle.patch', pkg.dsh?.bundle?.patch, './cordis.patch.yml'],
  ['dsh.client.platform', pkg.dsh?.client?.platform, 'web'],
  ['exports["./client"]', pkg.exports?.['./client']?.default, './lib/client.js'],
];
for (const [label, actual, expected] of required) {
  if (actual === expected) pass(label);
  else fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

if (existsSync('lib/client.js')) {
  const source = readFileSync('lib/client.js', 'utf8');
  const first = source.trimStart().split('\n')[0];
  if (first === 'window.__ModuleLoader__.load({') pass('lib/client.js closure-factory first line');
  else fail('lib/client.js closure-factory first line', `got ${JSON.stringify(first)}`);
  if (source.includes(version)) pass(`lib/client.js embeds version ${version}`);
  else fail('lib/client.js embeds version', `missing ${version}; run npm run build`);
} else {
  fail('lib/client.js exists', 'run npm run build first');
}

const readme = readFileSync('README.md', 'utf8');
for (const heading of ['## Install', '## Configure', '## Commands', '## Limitations']) {
  if (readme.includes(heading)) pass(`README has ${heading}`);
  else fail(`README has ${heading}`);
}

const workbench = readFileSync('docs/WORKBENCH.md', 'utf8');
for (const heading of [
  '## 1. 包协议',
  '## 2. 安装 / 卸载',
  '## 3. 权限与已知限制',
  '## 4. 验收清单',
  '## 5. 状态语义',
]) {
  if (workbench.includes(heading)) pass(`WORKBENCH has ${heading}`);
  else fail(`WORKBENCH has ${heading}`);
}
if (workbench.includes(`当前版本：${version}`)) pass(`WORKBENCH version ${version}`);
else fail(`WORKBENCH version ${version}`, 'current version marker missing');

const clientSource = existsSync('lib/client.js') ? readFileSync('lib/client.js', 'utf8') : '';
const locations = [
  ['package.json', version],
  ['lib/client.js', clientSource.includes(version) ? version : undefined],
  ['docs/WORKBENCH.md', workbench.includes(`当前版本：${version}`) ? version : undefined],
];
for (const [file, found] of locations) {
  if (found !== undefined) pass(`version consistent in ${file}`);
  else fail(`version consistent in ${file}`, `missing ${version}`);
}
if (locations.some(([, found]) => found === undefined)) {
  fail('version three places', 'package.json / lib/client.js / docs/WORKBENCH.md differ');
}

console.log(`\ncheck-workbench: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error('\nMissing items:');
  for (const item of failures) console.error(`- ${item}`);
  process.exit(1);
}
