/**
 * Builds the browser half as a closure-factory artifact consumed by dsh's
 * module loader. The host half is emitted by `tsc -p tsconfig.json`.
 */
import { readFileSync } from 'node:fs';

const ID = 'dsh-caduceus';
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default {
  entry: { client: 'client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  deps: { neverBundle: ['react'] },
  dts: false,
  sourcemap: true,
  clean: false,
  define: { __CADUCEUS_VERSION__: JSON.stringify(pkg.version) },
  outExtensions: () => ({ js: '.js' }),
  banner:
    `window.__ModuleLoader__.load({\n` +
    `\tid: ${JSON.stringify(ID)},\n` +
    `\tfactory: (require) => {\n` +
    `\t\tvar module = { exports: {} };\n` +
    `\t\tvar exports = module.exports;`,
  footer: `\t\treturn module.exports;\n\t}\n});\n`,
};
