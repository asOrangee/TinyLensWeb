import { connectionConfig } from './connection-config.mjs';
import { spawn } from 'node:child_process';
import { posix } from 'node:path';
import { WORKSPACE } from './agent-state.mjs';

const MAX_BYTES = 12 * 1024 * 1024;
const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const permitted = path => [WORKSPACE + '/output/', WORKSPACE + '/tmp/'].some(root => path.startsWith(root));

/** Only transport a specific image that this conversation's AI explicitly reported. */
export function reportedImage(state, updateId) {
  const update = state.updates.find(item => item.id === updateId && item.threadId === state.threadId && item.kind === 'artifact');
  if (!update || typeof update.path !== 'string' || !posix.isAbsolute(update.path) || update.path.includes('\0')) throw new Error('AI has not reported this image.');
  const path = posix.normalize(update.path);
  const type = types[posix.extname(path).toLowerCase()];
  if (!type || !permitted(path)) throw new Error('Only AI-reported images in the pipeline result directories can be displayed.');
  return { path, type };
}

export function validateImage(bytes, type) {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('Image exceeds the display size limit or is empty.');
  const matches = type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : type === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
    : type === 'image/webp' && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!matches) throw new Error('Reported file is not a supported image.');
}

export const REMOTE_IMAGE_READER = `import json,sys
from pathlib import Path
request=json.loads(sys.stdin.readline())
root=Path(request['root']).resolve()
path=Path(request['path']).resolve(strict=True)
allowed=[root/'output',root/'tmp']
if not any(path.is_relative_to(base) for base in allowed):raise ValueError('Image path leaves result directories')
if not path.is_file() or path.stat().st_size>request['limit']:raise ValueError('Image unavailable or too large')
with path.open('rb') as handle:
 data=handle.read(request['limit']+1)
if len(data)>request['limit']:raise ValueError('Image too large')
sys.stdout.buffer.write(data)
`;
const shellQuote = text => "'" + text.replaceAll("'", "'\\''") + "'";

export async function readReportedImage(state, updateId, { spawnProcess = spawn, timeoutMs = 20000 } = {}) {
  const image = reportedImage(state, updateId);
  const bytes = await new Promise((resolve, reject) => {
    const proc = spawnProcess('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', connectionConfig.sshHost, shellQuote(connectionConfig.python) + ' -c ' + shellQuote(REMOTE_IMAGE_READER)], { stdio: ['pipe', 'pipe', 'pipe'] });
    let length = 0, settled = false; const chunks = [];
    const finish = (error, data) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(data); };
    const timer = setTimeout(() => { proc.kill(); finish(new Error('Image transfer timed out.')); }, timeoutMs);
    proc.on('error', error => finish(error));
    proc.stdin.on('error', error => finish(error));
    proc.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > MAX_BYTES) { proc.kill(); finish(new Error('Image exceeds the display size limit.')); }
      else chunks.push(chunk);
    });
    proc.stderr.resume();
    proc.on('close', code => code === 0 ? finish(null, Buffer.concat(chunks)) : finish(new Error('The AI-reported image could not be read from the server.')));
    // Paths are data on stdin, never interpolated into a shell command.
    proc.stdin.end(JSON.stringify({ root: WORKSPACE, path: image.path, limit: MAX_BYTES }) + '\n');
  });
  validateImage(bytes, image.type);
  return { ...image, bytes };
}

export async function serveReportedImage(request, response, state) {
  try {
    const query = new URL(request.url, 'http://localhost').searchParams;
    if ([...query.keys()].some(key => key !== 'updateId') || query.getAll('updateId').length !== 1) throw new Error('An AI image report identifier is required.');
    const image = await readReportedImage(state, query.get('updateId'));
    response.writeHead(200, { 'Content-Type': image.type, 'Content-Length': image.bytes.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
    response.end(image.bytes);
  } catch (error) {
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: error.message }));
  }
}
