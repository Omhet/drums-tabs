// Let Node import the app's source the way Vite does.
//
// The source imports siblings without an extension (`./chart`), which is what
// a bundler expects and what Node's ESM resolver refuses. Node 24 runs
// TypeScript on its own by stripping the types, so the only thing missing is
// the extension -- add it, and the pure parts of the app (the scorer, the
// chart reader) can be unit-tested with `node --test` and no build step.
//
//   node --import ./scripts/ts-resolve.mjs --test scripts/test-*.mjs
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
