/**
 * Load the built client artifact the way the web shell does: evaluate it against
 * a fake `window.__ModuleLoader__`, run its factory with a fake `require`, then
 * invoke the plugin apply and its registered slot component.
 *
 * This verifies the artifact contract, not full dsh web discovery. Discovery
 * needs a host Loader row, which would require a profile change (out of scope).
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
assert.equal(pkg.dsh?.client?.platform, 'web');
assert.equal(pkg.exports?.['./client']?.default, './lib/client.js');

let registration;
const fakeWindow = {
  __ModuleLoader__: {
    load(def) {
      registration = def;
    },
  },
};
new Function('window', readFileSync('./lib/client.js', 'utf8'))(fakeWindow);
assert.equal(registration.id, 'caduceus-client-probe');
assert.equal(typeof registration.factory, 'function');

const react = {
  createElement(type, props, ...children) {
    return { type, props, children };
  },
};
const moduleExports = registration.factory((specifier) => {
  if (specifier === 'react') return react;
  throw new Error(`unexpected require: ${specifier}`);
});
assert.equal(typeof moduleExports.apply, 'function');
assert.deepEqual(moduleExports.inject, ['slots']);

let registered;
const ctx = {
  effect(callback) {
    callback();
  },
  slots: {
    register(spec, component) {
      registered = { spec, component };
      return () => {};
    },
  },
};
moduleExports.apply(ctx);
assert.equal(registered.spec.name, 'shell.overlay');
const element = registered.component();
assert.equal(element.children[0], 'caduceus client probe');
assert.equal(element.props.style.position, 'fixed');

console.log(JSON.stringify({
  artifact: registration.id,
  manifest: { dshClient: pkg.dsh.client, clientExport: pkg.exports['./client'].default },
  inject: moduleExports.inject,
  slot: registered.spec.name,
  label: element.children[0],
  position: element.props.style.position,
}, null, 2));
