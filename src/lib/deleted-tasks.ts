export function parseDeletedTaskIds(raw: string | null, validId: (id: string) => boolean): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === 'string' && validId(id)))]
      : [];
  } catch { return []; }
}

export const hideTask = (deleted: string[], id: string) => deleted.includes(id) ? deleted : [...deleted, id];
export const restoreTask = (deleted: string[], id: string) => deleted.filter(value => value !== id);
