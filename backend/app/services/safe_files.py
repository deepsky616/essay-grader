"""지역 자료 파일을 경로 바꾸기 공격 없이 제한된 크기로 읽는다."""

import os
from pathlib import Path
import stat


def read_safe_regular_file(
    raw_path: str,
    *,
    root: Path,
    max_bytes: int,
) -> bytes:
    """지정된 뿌리 폴더 안의 링크가 아닌 일반 파일만 읽는다."""
    path = Path(raw_path)
    descriptor: int | None = None
    try:
        root_meta = os.lstat(root)
        path_meta = os.lstat(path)
        resolved_root = root.resolve(strict=True)
        resolved_parent = path.parent.resolve(strict=True)
        if (
            not stat.S_ISDIR(root_meta.st_mode)
            or stat.S_ISLNK(root_meta.st_mode)
            or not stat.S_ISREG(path_meta.st_mode)
            or stat.S_ISLNK(path_meta.st_mode)
            or not resolved_parent.is_relative_to(resolved_root)
            or not 1 <= path_meta.st_size <= max_bytes
        ):
            raise OSError

        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        flags |= getattr(os, "O_CLOEXEC", 0)
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_ino != path_meta.st_ino
            or opened.st_dev != path_meta.st_dev
            or opened.st_size != path_meta.st_size
        ):
            raise OSError

        chunks: list[bytes] = []
        remaining = opened.st_size
        while remaining:
            chunk = os.read(descriptor, min(remaining, 1024 * 1024))
            if not chunk:
                raise OSError
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)
    except OSError:
        raise RuntimeError("지역 파일을 안전하게 읽지 못했습니다.") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
