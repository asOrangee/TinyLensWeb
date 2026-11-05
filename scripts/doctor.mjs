import { spawnSync } from 'node:child_process';
import { connectionConfig as config, shellQuote } from '../server/connection-config.mjs';

if (!process.argv.includes('--remote')) {
  console.log(`Node ${process.versions.node}; SSH target: ${config.sshHost}; pipeline: ${config.workspace}`);
  console.log('Run pnpm doctor --remote to check SSH, Python imports and Codex without starting an AI turn or a science stage.');
} else {
  const python = `import importlib,sys\nfrom pathlib import Path\nimport tomllib\nfor name in ['numpy','astropy','PIL','matplotlib','photutils','pydantic','scipy','jax','TinyLensGpu','lens_agent']:\n importlib.import_module(name)\n print(name+': import OK')\nfor p in Path('.codex/agents').glob('*.toml'):\n c=tomllib.loads(p.read_text())\n if c.get('model')=='YOUR_MODEL_ID':raise SystemExit('Configure model IDs with scripts/configure_agents.py first')\nprint('Role configuration: OK')`;
  const home = config.codexHome ? `export CODEX_HOME=${shellQuote(config.codexHome)} && ` : '';
  const command = `cd ${shellQuote(config.workspace)} && ${home}env CUDA_VISIBLE_DEVICES= JAX_PLATFORMS=cpu PYTHONDONTWRITEBYTECODE=1 ${shellQuote(config.python)} -B -c ${shellQuote(python)} && ${shellQuote(config.codex)} --version && ${shellQuote(config.codex)} app-server --help`;
  const result = spawnSync('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', config.sshHost, command], {stdio:'inherit', timeout:60000});
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
