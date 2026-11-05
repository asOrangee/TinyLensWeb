from __future__ import annotations

from pathlib import Path


ARCHIVE_DIRECTORY_NAME = "_archive"
HISTORICAL_RESULT_MARKERS = ("pipeline.py", "cache", "reviews")


def require_current_lens_result_path(path: Path) -> None:
    require_no_archive_directory_ancestor(path)
    if path.is_symlink():
        raise ValueError("Lens Result Directory must not be a symbolic link")


def require_no_archive_directory_ancestor(path: Path) -> None:
    requested = path.absolute()
    resolved = requested.resolve()
    for candidate in (requested, *requested.parents, resolved, *resolved.parents):
        if candidate.name == ARCHIVE_DIRECTORY_NAME:
            raise ValueError("Archive Directory is read-only")


def resolve_current_lens_result_path(path: Path) -> Path:
    requested = path.absolute()
    require_current_lens_result_path(requested)
    resolved = requested.resolve()
    require_current_lens_result_path(resolved)
    return resolved


def require_lens_local_tree(root: Path) -> None:
    if not root.exists():
        return
    for candidate in root.rglob("*"):
        if candidate.is_symlink():
            raise ValueError("Lens Result Directory must not contain symbolic links")


def require_nonhistorical_lens_result(path: Path) -> None:
    if any((path / name).exists() for name in HISTORICAL_RESULT_MARKERS):
        raise ValueError("historical output root is read-only; choose a new empty output root")


def is_archive_directory(path: Path) -> bool:
    return path.name == ARCHIVE_DIRECTORY_NAME
