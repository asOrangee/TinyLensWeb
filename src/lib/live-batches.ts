const batchApi = '/api/agent/batches';

export type BatchSummary = {
  id: string; name: string; createdAt: string; size: number; inputDir: string; outputDir: string;
  parallelism: number; paused: boolean; compatible: boolean;
};

export type BatchJobStatus = 'queued' | 'starting' | 'running' | 'waiting_gpu' | 'waiting_user' | 'unconfirmed'
  | 'accepted' | 'human_review' | 'attention' | 'incomplete' | 'removed';

export type BatchJob = {
  taskId: string; lensId: string; runPath: string; existing: boolean; canOpen: boolean; status: BatchJobStatus;
  stage?: string; stageStatus?: string; updatedAt?: string; message?: string; delivered?: true;
};

export type Batch = BatchSummary & { jobs: BatchJob[]; retryableStartCount?: number };
export type BatchPlan = {
  id: string; status: 'preview' | 'submitted'; inputDir: string; outputDir: string;
  parallelism: number; targets: { lensId: string; existing: boolean }[]; message?: string;
};

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function parseBatchPlan(value: unknown): BatchPlan | undefined {
  if (!record(value) || typeof value.id !== 'string' || !/^batch-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.id)
      || (value.status !== 'preview' && value.status !== 'submitted') || typeof value.inputDir !== 'string' || typeof value.outputDir !== 'string'
      || typeof value.parallelism !== 'number' || !Number.isSafeInteger(value.parallelism) || value.parallelism < 1
      || !Array.isArray(value.targets) || !value.targets.length || value.targets.length > 500
      || !value.targets.every(target => record(target) && typeof target.lensId === 'string' && typeof target.existing === 'boolean')) return undefined;
  return { id: value.id, status: value.status, inputDir: value.inputDir, outputDir: value.outputDir, parallelism: value.parallelism,
    targets: value.targets.map(({ lensId, existing }) => ({ lensId, existing })), message: typeof value.message === 'string' ? value.message : undefined };
}

export async function batchFetch<T>(path = '', { data, signal }: { data?: object; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(batchApi + path, { signal, cache: 'no-store',
    ...(data && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
  if (response.status === 404 && path === '') throw Error('当前 AI 桥接未加载批次功能。请在现有任务结束后重启 pnpm agent:server。');
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) throw Error(payload?.error || `批次服务暂不可用（${response.status}）。`);
  return payload;
}
