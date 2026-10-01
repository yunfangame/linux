import pathlib
import subprocess
import sys
import tempfile

from debian.deb822 import Deb822


source, destination, version, epoch = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix="fengwo-deb-") as directory:
    subprocess.run(["dpkg-deb", "--raw-extract", source, directory], check=True)
    control = pathlib.Path(directory, "DEBIAN", "control")
    with control.open(encoding="utf-8") as stream:
        fields = Deb822(stream)
    if fields["Package"] != "fengwo-linux" or fields["Version"] != version:
        raise ValueError("Unexpected Debian package identity or version")
    fields["Version"] = f"{int(epoch)}:{version}"
    with control.open("w", encoding="utf-8") as stream:
        fields.dump(stream)
    subprocess.run(
        ["dpkg-deb", "--root-owner-group", "--build", directory, destination],
        check=True,
    )
