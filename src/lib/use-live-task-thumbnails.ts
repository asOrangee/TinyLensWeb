import { useEffect, useRef, useState } from 'react';
import { parseAgentState } from './agent-types';
import { hasNumericRaster, scaleImagePlane } from './image-scale';
import { selectInputReport } from './input-display';
import { agentTaskUrl, type LiveTask } from './live-tasks';
import { fetchReportedInput } from './use-reported-input';

type Thumbnail = { reportId: string; path: string; src: string };

async function readThumbnail(taskId: string, previous: Thumbnail | undefined, signal: AbortSignal) {
  const response = await fetch(agentTaskUrl('/api/agent/state', taskId), { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('Task state unavailable');
  const report = selectInputReport(parseAgentState(await response.json()).updates);
  if (!report?.id || !report.path) return undefined;
  if (previous?.reportId === report.id && previous.path === report.path) return previous;

  try {
    const input = await fetchReportedInput(taskId, report, signal);
    const data = input.planes[0].numeric;
    if (!hasNumericRaster(data)) return undefined;
    const { src } = await scaleImagePlane(data, 'asinh');
    return { reportId: report.id, path: report.path, src };
  } catch { return undefined; }
}

/** Refresh report identities alongside the task catalog and render only changed inputs. */
export function useLiveTaskThumbnails(tasks: readonly LiveTask[], enabled: boolean) {
  const [thumbnails, setThumbnails] = useState<Record<string, Thumbnail | undefined>>({});
  const pending = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const requests = pending.current;
    return () => { requests.forEach(request => request.abort()); requests.clear(); };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const requests = pending.current;
    for (const task of tasks) {
      if (requests.has(task.id)) continue;
      const controller = new AbortController();
      const previous = thumbnails[task.id];
      requests.set(task.id, controller);
      void readThumbnail(task.id, previous, controller.signal).then(next => {
        if (!controller.signal.aborted && next !== previous) {
          setThumbnails(current => ({ ...current, [task.id]: next }));
        }
      }).catch(() => { /* Keep the last verified thumbnail during a state read failure. */ })
        .finally(() => { if (requests.get(task.id) === controller) requests.delete(task.id); });
    }
  }, [tasks, enabled]);

  return thumbnails;
}
