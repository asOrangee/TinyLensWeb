import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./read_attempt_evidence.py', import.meta.url), 'utf8');

export function withAttemptEvidenceReader(reader) {
  return `import sys, types
attempt_module = types.ModuleType('read_attempt_evidence')
exec(compile(${JSON.stringify(source)}, 'read_attempt_evidence.py', 'exec'), attempt_module.__dict__)
sys.modules['read_attempt_evidence'] = attempt_module
${reader}`;
}
