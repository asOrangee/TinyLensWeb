import { spawnSync } from 'node:child_process';
import { connectionConfig as config, shellQuote } from '../server/connection-config.mjs';

if (!process.argv.includes('--remote')) {
  console.log(`Node ${process.versions.node}; SSH target: ${config.sshHost}; pipeline: ${config.workspace}`);
  console.log('Run pnpm doctor --remote to check SSH, Python imports, the Pipeline Release and M0 grid policy, and Codex.');
} else {
  const python = `import importlib
from pathlib import Path
import tomllib

for name in ['numpy', 'astropy', 'PIL', 'matplotlib', 'photutils', 'pydantic', 'scipy', 'jax', 'TinyLensGpu', 'lens_agent']:
    importlib.import_module(name)
    print(name + ': import OK')

from lens_agent.configuration import EffectiveConfig, PIPELINE_RELEASE_ID

expected_release = 'source-reconstruction.v1'
config = EffectiveConfig()
if PIPELINE_RELEASE_ID != expected_release or config.pipeline_release_id != expected_release:
    raise SystemExit(
        f'Pipeline Release mismatch: code={PIPELINE_RELEASE_ID}, default={config.pipeline_release_id}, '
        f'expected={expected_release}'
    )

from lens_agent.modeling.source_grid import next_source_grid_level, source_grid_spec

sizes = (100, 120, 140, 160, 180, 200)
pixel_scale = 0.010
level = config.settings.source_grid_level
for expected_level, size in enumerate(sizes):
    if level != expected_level:
        raise SystemExit(f'M0 grid level mismatch: got {level}, expected {expected_level}')
    grid = source_grid_spec(center_x=0.0, center_y=0.0, level=level)
    if grid['nsrc'] != size or grid['pixel_scale_arcsec'] != pixel_scale:
        raise SystemExit(
            f"M0 grid mismatch at level {level}: got {grid['nsrc']} px at {grid['pixel_scale_arcsec']} arcsec/px, "
            f'expected {size} px at {pixel_scale:.3f} arcsec/px'
        )
    level = next_source_grid_level(level)
if level is not None:
    raise SystemExit(f'M0 grid policy continues to level {level} after the expected maximum of {sizes[-1]} px')
print(f'Pipeline Release: {expected_release}')
print(f'M0 grid: {sizes[0]} to {sizes[-1]} px at {pixel_scale:.3f} arcsec/px in steps of 20')

for path in Path('.codex/agents').glob('*.toml'):
    role = tomllib.loads(path.read_text())
    if role.get('model') == 'YOUR_MODEL_ID':
        raise SystemExit('Configure model IDs with scripts/configure_agents.py first')
print('Role configuration: OK')`;
  const home = config.codexHome ? `export CODEX_HOME=${shellQuote(config.codexHome)} && ` : '';
  const command = `cd ${shellQuote(config.workspace)} && ${home}env CUDA_VISIBLE_DEVICES= JAX_PLATFORMS=cpu PYTHONDONTWRITEBYTECODE=1 ${shellQuote(config.python)} -B -c ${shellQuote(python)} && ${shellQuote(config.codex)} --version && ${shellQuote(config.codex)} app-server --help`;
  const result = spawnSync('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', config.sshHost, command], {stdio:'inherit', timeout:60000});
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
