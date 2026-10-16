// Compile le serveur en UN SEUL fichier (dist/server.mjs) contenant toutes ses
// dépendances : sur Pterodactyl, aucun « npm install » n'est nécessaire,
// il suffit de copier le dossier dist/.
import { build } from 'esbuild';

await build({
  entryPoints: ['server/src/index.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // Certaines dépendances utilisent encore « require » : on le fournit en ESM.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  legalComments: 'none',
  logLevel: 'info',
});
