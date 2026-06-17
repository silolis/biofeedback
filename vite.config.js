import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

import { cloudflare } from "@cloudflare/vite-plugin";

// Bundles index.html + src/styles.css + the src/*.js modules (app entry → state, signal,
// feedback, search + estimators-core) into ONE self-contained dist/index.html — keeps the
// "just open the file" property of the original single-page app while letting the source
// live in real, importable modules.
//
//   npm run dev     local dev server with hot reload (needed: ES modules don't load from file://)
//   npm run build   emit the single-file dist/index.html
//
// The offline tools (tools/estimators.mjs, tools/reanalyze.mjs) import src/estimators-core.mjs
// directly via Node and are not part of this build.
export default defineConfig({
  plugins: [viteSingleFile(), cloudflare()],
  build: {
    target: 'esnext',            // personal tool on an evergreen browser — no legacy transpile
    cssCodeSplit: false,
    assetsInlineLimit: 100000000, // inline everything; no external asset references
    outDir: 'dist',
    emptyOutDir: true,
  },
});