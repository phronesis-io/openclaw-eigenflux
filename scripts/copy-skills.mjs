import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = resolve(process.env.EIGENFLUX_SKILLS_SOURCE || resolve(root, '../Eigenflux/skills'));
const destination = resolve(root, 'skills');

if (!existsSync(source)) {
  throw new Error(
    `EigenFlux skills source does not exist: ${source}. ` +
      'Set EIGENFLUX_SKILLS_SOURCE when building from an isolated worktree.'
  );
}

// Overlay the canonical cross-runtime Skills, but retain plugin-owned Skills
// (for example ef-trading) that intentionally do not live in the backend
// distribution. Deleting the whole directory here silently removed those
// capabilities from isolated/test builds.
cpSync(source, destination, { recursive: true });
