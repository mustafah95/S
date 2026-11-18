// Bundles the server into a single file for release packages: dist/server/main.js (+ migrations, swagger-ui assets).
// No compiler or node_modules is needed on the restaurant server — only Node.js.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = import.meta.dirname;
const out = join(here, 'dist', 'server');
rmSync(join(here, 'dist'), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(here, 'src/main.ts')],
  outfile: join(out, 'main.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['pg-native'],
  // CommonJS output keeps __dirname/__filename for dependencies; ESM-style import.meta.url is shimmed.
  define: { 'import.meta.url': '__sofiaImportMetaUrl', 'import.meta.dirname': '__dirname' },
  banner: { js: "const __sofiaImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  legalComments: 'external',
  sourcemap: false,
  logLevel: 'warning',
});

// The bundle is CommonJS; mark the folder so Node does not treat main.js as ESM.
writeFileSync(join(out, 'package.json'), JSON.stringify({ type: 'commonjs', private: true }, null, 2));
cpSync(join(here, 'migrations'), join(out, 'migrations'), { recursive: true });
const require = createRequire(import.meta.url);
const swaggerUi = dirname(require.resolve('@fastify/swagger-ui/package.json'));
// @fastify/swagger-ui reads its assets relative to __dirname, which is the bundle folder after bundling.
cpSync(join(swaggerUi, 'static'), join(out, 'static'), { recursive: true });
// PDF reports: Arabic fonts + logo, and PDFKit's built-in font metrics (it reads __dirname/data/*.afm at start-up).
cpSync(join(here, 'assets'), join(out, 'assets'), { recursive: true });
cpSync(join(dirname(require.resolve('pdfkit/package.json')), 'js', 'data'), join(out, 'data'), { recursive: true });
console.log(`Server bundle written to ${out}`);
