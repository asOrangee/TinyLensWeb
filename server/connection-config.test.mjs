import test from 'node:test';
import assert from 'node:assert/strict';
import { readConnectionConfig, appServerCommand } from './connection-config.mjs';

test('deployment settings accept SSH aliases and correctly quote remote paths', () => {
  const config = readConnectionConfig({ TINYLENS_SSH_HOST: 'user@compute', TINYLENS_REMOTE_WORKSPACE: "/srv/lens user's/pipeline", TINYLENS_REMOTE_CODEX: '/opt/codex bin/codex', TINYLENS_REMOTE_CODEX_HOME: '/srv/private ai' });
  assert.equal(config.sshHost, 'user@compute');
  assert.match(appServerCommand('', config), /lens user'\\''s/);
  assert.match(appServerCommand('', config), /export CODEX_HOME='\/srv\/private ai'/);
  assert.match(appServerCommand('', config), /exec '\/opt\/codex bin\/codex' app-server/);
});
test('settings reject SSH flags, shell fragments, relative workspaces and invalid ports', () => {
  for (const env of [{TINYLENS_SSH_HOST:'-oProxyCommand=x'}, {TINYLENS_SSH_HOST:'host;id'}, {TINYLENS_REMOTE_WORKSPACE:'relative'}, {TINYLENS_REMOTE_PYTHON:'python3;id'}, {TINYLENS_REMOTE_WORKSPACE:'/tmp/\nsecret'}, {TINYLENS_REMOTE_PROXY_PORT:'1'}, {TINYLENS_PROXY_PORT:'70000'}, {TINYLENS_AI_NETWORK:'automatic'}]) assert.throws(() => readConnectionConfig(env));
  assert.equal(readConnectionConfig({}).dataset, '');
});
