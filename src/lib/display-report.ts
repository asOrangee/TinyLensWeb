import type { AgentUpdate } from './agent-types';

export const namedDisplaySchema = 'tinylens.stage-display.v3';
export const isNamedDisplaySchema = (schema?: string) => schema === namedDisplaySchema || schema === 'tinylens.stage-display.v2';
export const isNamedDisplayDirectory = (path?: string) => /\/display\/?$/.test(path ?? '');
export const isPublishedDisplayReport = (update: AgentUpdate) => update.kind === 'artifact' && !!update.id
  && (isNamedDisplayDirectory(update.path) || update.path?.endsWith('/display-manifest.json') === true);
