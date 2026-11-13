import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';

// Only the server reads this file. Never expose credentials through VITE_*.
try { loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

function text(value, name) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function absolute(value, name) {
  text(value, name);
  if (!posix.isAbsolute(value) || posix.normalize(value) === '/') throw new Error(`${name} must be an absolute directory or executable path`);
  return posix.normalize(value).replace(/\/$/, '');
}
function executable(value, name) {
  text(value, name);
  if (!value.startsWith('/') && !/^[a-zA-Z0-9._+-]+$/.test(value)) throw new Error(`${name} must be a command name or absolute executable path`);
  return value;
}
function port(value, name) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1024 || Number(value) > 65535) throw new Error(`Invalid ${name}`);
  return Number(value);
}
export function readConnectionConfig(env = process.env) {
  const sshHost = env.TINYLENS_SSH_HOST || 'tinylens-gpu';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(sshHost)) throw new Error('Invalid TINYLENS_SSH_HOST; use an SSH config alias');
  const aiNetwork = env.TINYLENS_AI_NETWORK || 'off';
  if (!['off', 'loopback-proxy'].includes(aiNetwork)) throw new Error('TINYLENS_AI_NETWORK must be off or loopback-proxy');
  const remoteProxyPort = env.TINYLENS_REMOTE_PROXY_PORT || '0';
  return Object.freeze({
    sshHost,
    workspace: absolute(env.TINYLENS_REMOTE_WORKSPACE || '/srv/TinyLensWeb/pipeline', 'TINYLENS_REMOTE_WORKSPACE'),
    dataset: env.TINYLENS_DATASET_PATH ? absolute(env.TINYLENS_DATASET_PATH, 'TINYLENS_DATASET_PATH') : '',
    python: executable(env.TINYLENS_REMOTE_PYTHON || 'python3', 'TINYLENS_REMOTE_PYTHON'),
    codex: executable(env.TINYLENS_REMOTE_CODEX || 'codex', 'TINYLENS_REMOTE_CODEX'),
    codexHome: env.TINYLENS_REMOTE_CODEX_HOME ? absolute(env.TINYLENS_REMOTE_CODEX_HOME, 'TINYLENS_REMOTE_CODEX_HOME') : '',
    aiNetwork, upstreamPort: port(env.TINYLENS_PROXY_PORT || '7897', 'TINYLENS_PROXY_PORT'),
    remoteProxyPort: remoteProxyPort === '0' ? 0 : port(remoteProxyPort, 'TINYLENS_REMOTE_PROXY_PORT'),
  });
}
export const connectionConfig = readConnectionConfig();
export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export function appServerCommand(networkBootstrap = '', config = connectionConfig) {
  const home = config.codexHome ? `export CODEX_HOME=${shellQuote(config.codexHome)} && ` : '';
  return `cd ${shellQuote(config.workspace)} && ${home}${networkBootstrap}exec ${shellQuote(config.codex)} app-server --listen stdio://`;
}
