from __future__ import annotations

from pathlib import Path

from .configuration import archiveable_run_root


def prepare_full_rerun(output_dir: Path) -> Path:
    if not output_dir.is_dir():
        raise ValueError("current Lens Result Directory does not exist")
    current = archiveable_run_root(output_dir)
    archive_root = current.parent / "_archive"
    if archive_root.is_symlink():
        raise ValueError("Archive Directory must not be a symbolic link")
    if archive_root.exists() and not archive_root.is_dir():
        raise ValueError("Archive Directory must be a directory")
    archive_root.mkdir(exist_ok=True)
    prefix = f"{current.name}_old_"

    archive_numbers = [
        int(entry.name.removeprefix(prefix))
        for entry in archive_root.iterdir()
        if entry.name.startswith(prefix) and entry.name.removeprefix(prefix).isdigit()
    ]
    archive_number = max(archive_numbers, default=-1) + 1
    archive = archive_root / f"{prefix}{archive_number}"
    current.rename(archive)
    return archive
