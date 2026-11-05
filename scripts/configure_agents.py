"""Configure only model IDs/reasoning in the shipped scientific role files."""
import argparse
import json
import re
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', required=True, help='Your provider model ID (must support tools and images)')
    parser.add_argument('--review-model', help='Optional different model for inspector/synthesis')
    parser.add_argument('--effort', choices=['minimal', 'low', 'medium', 'high', 'xhigh'], default='medium')
    parser.add_argument('--pipeline', type=Path, default=Path(__file__).resolve().parents[1] / 'pipeline')
    args = parser.parse_args()
    for value in [args.model, args.review_model or args.model]:
        if not value.strip() or any(ord(c) < 32 for c in value):
            parser.error('Model IDs must be nonempty text without control characters')
    directory = args.pipeline / '.codex' / 'agents'
    files = sorted(directory.glob('*.toml'))
    if len(files) != 9:
        parser.error('Expected the nine shipped scientific role files')
    for path in files:
        model = (args.review_model or args.model) if path.stem in ['system-inspector', 'preflight-synthesis-expert'] else args.model
        content = path.read_text(encoding='utf-8')
        content = re.sub(r'^model = .*$', lambda _: 'model = ' + json.dumps(model), content, count=1, flags=re.M)
        content = re.sub(r'^model_reasoning_effort = .*$', 'model_reasoning_effort = ' + json.dumps(args.effort), content, count=1, flags=re.M)
        path.write_text(content, encoding='utf-8')
    print(f'Configured {len(files)} roles. Scientific instructions and API credentials were not changed.')


if __name__ == '__main__':
    main()
