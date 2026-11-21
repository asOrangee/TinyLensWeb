import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const taskNameFile = 'task-name.json';
const schema = 'tinylens.task-name.v1';
const maxRecordBytes = 1024;
const suggestionFields = new Set(['kind', 'stage', 'status', 'title', 'message']);

function validName(name) {
  return typeof name === 'string' && name.length > 0 && name.trim() === name
    && [...name].length <= 40
    && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(name);
}

export function readTaskNameSuggestion(report) {
  if (report.kind !== 'note' || report.stage !== 'task_name' || report.status !== 'suggested'
      || report.message !== 'Workbench task name' || !validName(report.title)
      || Object.keys(report).some(key => !suggestionFields.has(key))) {
    throw Error('Invalid workbench task name suggestion.');
  }
  return report.title;
}

export async function readTaskName(directory, taskId, threadId) {
  if (!threadId) return;
  let handle;
  try {
    handle = await open(join(directory, taskNameFile), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxRecordBytes) return;
    const bytes = Buffer.alloc(maxRecordBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxRecordBytes) return;
    const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)));
    if (record?.schema === schema && record.task_id === taskId && record.thread_id === threadId
        && Object.keys(record).length === 4 && validName(record.name)) return record.name;
  } catch {
    // Missing or invalid metadata leaves the existing catalog name visible.
  } finally {
    await handle?.close();
  }
}

export async function writeTaskName(directory, taskId, threadId, name, assertCurrent) {
  const record = JSON.stringify({ schema, task_id: taskId, thread_id: threadId, name }) + '\n';
  if (!validName(name) || !threadId || Buffer.byteLength(record, 'utf8') > maxRecordBytes) {
    throw Error('Invalid workbench task name record.');
  }
  const temporary = join(directory, `.${taskNameFile}.${randomUUID()}`);
  try {
    await writeFile(temporary, record, { mode: 0o600, flag: 'wx' });
    assertCurrent();
    try {
      await link(temporary, join(directory, taskNameFile));
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return false;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
