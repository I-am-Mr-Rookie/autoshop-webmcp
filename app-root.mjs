import { pathToFileURL } from 'node:url';

// Netlify bundles server modules into netlify/functions/app.mjs, so import.meta.url there no longer
// points at the repository root; included files (public/, migrations/) live under the Lambda task root.
export const appRoot = process.env.LAMBDA_TASK_ROOT
  ? pathToFileURL(`${process.env.LAMBDA_TASK_ROOT.replace(/[\\/]+$/, '')}/`)
  : new URL('./', import.meta.url);
