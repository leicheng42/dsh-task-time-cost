import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const root = new URL('../', import.meta.url);
await mkdir(new URL('lib/', root), { recursive: true });
const host = await build({ entryPoints: [fileURLToPath(new URL('src/host/index.ts', root))],
  outfile: fileURLToPath(new URL('lib/index.js', root)),
  platform: 'node', format: 'esm', target: 'node24', bundle: true, sourcemap: true, metafile: true,
  external: ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-typert-protocol'],
});
const client = await build({ entryPoints: [fileURLToPath(new URL('src/client-entry.ts', root))],
  platform: 'browser', format: 'cjs', target: 'es2022', bundle: true, write: false, external: ['react'],
  legalComments: 'eof', minify: true, metafile: true,
});
const code = `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory(require){\nconst module={exports:{}};const exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;\n}});\n// ${manifest.name}@${manifest.version}\n//# sourceURL=${manifest.name}/client.js\n`;
new vm.Script(code, { filename: 'client.js' });
await writeFile(new URL('lib/client.js', root), code, 'utf8');
await mkdir(new URL('artifacts/', root), { recursive: true });
await writeFile(new URL('artifacts/build-metafile.json', root), JSON.stringify({ host: host.metafile, client: client.metafile }, null, 2), 'utf8');
console.log(`Built ${manifest.name}@${manifest.version}: Host ESM and DSH Client factory.`);
