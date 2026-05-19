import { readFile } from 'node:fs/promises';
import path from 'node:path';

let cached: string | undefined;

// Reads zer0-persona.md from the project root once per process and serves it
// from memory thereafter. Filename uses lowercase + suffix to avoid colliding
// with zer0.md (the architecture document) on case-insensitive filesystems
// like Windows/macOS-default.
export async function loadPersona(): Promise<string> {
  if (cached) return cached;
  const file = path.join(process.cwd(), 'zer0-persona.md');
  cached = await readFile(file, 'utf8');
  return cached;
}
