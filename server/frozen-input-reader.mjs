import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./read_frozen_input.py', import.meta.url), 'utf8');

/** Make the same verified FITS reader available to the read-only SSH commands. */
export async function withFrozenInputReader(url) {
  const reader = await readFile(url, 'utf8');
  return `import sys, types
frozen_input_module = types.ModuleType('read_frozen_input')
exec(compile(${JSON.stringify(source)}, 'read_frozen_input.py', 'exec'), frozen_input_module.__dict__)
sys.modules['read_frozen_input'] = frozen_input_module
${reader}`;
}
