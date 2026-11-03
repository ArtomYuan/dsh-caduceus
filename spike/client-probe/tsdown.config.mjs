const ID = 'caduceus-client-probe';

export default [
  {
    name: `${ID}/host`,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    dts: false,
    sourcemap: false,
    clean: false,
    outExtensions: () => ({ js: '.js' }),
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    deps: { neverBundle: ['react'] },
    dts: false,
    sourcemap: true,
    clean: false,
    outExtensions: () => ({ js: '.js' }),
    banner:
      `window.__ModuleLoader__.load({\n` +
      `\tid: ${JSON.stringify(ID)},\n` +
      `\tfactory: (require) => {\n` +
      `\t\tvar module = { exports: {} };\n` +
      `\t\tvar exports = module.exports;`,
    footer: `\t\treturn module.exports;\n\t}\n});\n`,
  },
];
