"""Create a portable ZIP without host identities or absolute paths."""
import sys
import zipfile
from pathlib import Path

source = Path(sys.argv[1]).resolve()
destination = Path(sys.argv[2]).resolve()
with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted(source.rglob("*")):
        if path.is_symlink():
            raise RuntimeError("Release tree must not contain symbolic links")
        if not path.is_file():
            continue
        name = (Path(source.name) / path.relative_to(source)).as_posix()
        entry = zipfile.ZipInfo(name, date_time=(2026, 9, 30, 0, 0, 0))
        entry.create_system = 3
        entry.external_attr = (0o100755 if path.suffix in (".command", ".sh") else 0o100644) << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(entry, path.read_bytes())
print("Desktop ZIP prepared.")
