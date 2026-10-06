// macOS: `#!/usr/bin/env bash` resolves to Homebrew bash 5, which hides bash-3.2-only bugs
// (an empty "${arr[@]}" under `set -u` is "unbound variable" on /bin/bash 3.2). Put a temp
// dir holding `bash` -> /bin/bash FIRST on PATH so scripts and their shebangs run on 3.2.
import { mkdtempSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = (process.platform === 'darwin' && existsSync('/bin/bash'))
  ? (() => { const d = mkdtempSync(join(tmpdir(), 'bash32-')); symlinkSync('/bin/bash', join(d, 'bash')); return d; })()
  : null;

export const BASH = dir ? join(dir, 'bash') : 'bash';
export const bash32Path = (base = process.env.PATH) => (dir ? `${dir}:${base}` : base);
export const PATH_ENV = bash32Path();
export const isBash32 = dir !== null;
