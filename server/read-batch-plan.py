"""List runnable input directories and bind each target to its current run, if any."""

import json
import os
import re
import sys
from pathlib import Path


LENS_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\Z")
RUN_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")


def current_run(result, lens):
    if result.is_symlink() or (result.exists() and not result.is_dir()):
        raise ValueError(f"{lens.name} 的结果位置不是普通目录。")
    if not result.exists() or not any(result.iterdir()):
        return None
    manifest = result / "run-manifest.json"
    if manifest.is_symlink() or not manifest.is_file() or manifest.stat().st_size > 2 * 1024 * 1024:
        raise ValueError(f"{lens.name} 已有结果目录，但缺少可识别的运行清单。")
    record = json.loads(manifest.read_text(encoding="utf-8"))
    if (not isinstance(record, dict) or record.get("schema_version") != "lens_run_manifest.v1"
            or record.get("lens_dir") != str(lens) or not isinstance(record.get("run_id"), str)
            or not RUN_ID.fullmatch(record["run_id"])):
        raise ValueError(f"{lens.name} 已有运行的输入或标识与本批次不一致。")
    return record["run_id"]


def plan(request):
    source = Path(request["inputDir"])
    if not source.is_dir():
        raise ValueError("服务器上的输入目录不存在。")
    source = source.resolve(strict=True)
    output = Path(request["outputDir"])
    workspace = Path(request["workspace"])
    root = workspace / "output"
    if (not output.is_relative_to(root) or output.resolve() != output
            or "_archive" in output.relative_to(root).parts):
        raise ValueError("输出必须位于服务器 Pipeline 的 output 目录内，且使用实际路径。")
    parent = next(path for path in (output, *output.parents) if path.exists())
    if not parent.is_dir():
        raise ValueError("批次输出位置的上级路径必须是目录。")

    def has_input(lens):
        return lens.is_dir() and (lens / f"{lens.name}.fits").is_file()

    selection = request["selection"]
    if "ids" in selection:
        lenses = [source / lens_id for lens_id in selection["ids"]]
        missing = [lens.name for lens in lenses if not has_input(lens)]
        if missing:
            sample = ", ".join(missing[:8])
            raise ValueError(f"有 {len(missing)} 个 lens 缺少同名 FITS，例如 {sample}。")
    else:
        count, prefix = selection["count"], selection.get("prefix", "")
        lenses = sorted(lens for lens in source.iterdir()
                        if LENS_ID.fullmatch(lens.name) and lens.name.startswith(prefix) and has_input(lens))
        if len(lenses) < count:
            raise ValueError(f"筛选命中 {len(lenses)} 个有效 lens，少于请求的 {count} 个。")
        lenses = lenses[:count]

    targets = []
    for lens in lenses:
        resolved = lens.resolve(strict=True)
        result = output / lens.name
        if resolved.name != lens.name or result.resolve() != result:
            raise ValueError(f"{lens.name} 的输入或输出路径与目录名不一致。")
        if result.is_relative_to(source) or source.is_relative_to(result) or resolved.is_relative_to(result):
            raise ValueError(f"{lens.name} 的结果目录与输入位置重叠。")
        targets.append({"lensId": lens.name, "inputPath": str(resolved), "runId": current_run(result, resolved)})
    return {"inputDir": str(source), "outputDir": str(output), "python": os.path.abspath(sys.executable), "targets": targets}


if __name__ == "__main__":
    try:
        result = {"plan": plan(json.loads(sys.argv[1]))}
    except ValueError as error:
        result = {"error": str(error)}
    except OSError:
        result = {"error": "服务器上的批次目录无法读取。"}
    print(json.dumps(result, ensure_ascii=False))
