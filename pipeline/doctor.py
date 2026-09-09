"""Environment checks.

The failure this is really built to catch: a torch install that reports
``cuda.is_available() == True`` but has no kernels compiled for this GPU's
architecture. That presents as a pipeline which is mysteriously 30x slower, or
which dies deep inside a model with "no kernel image is available for execution
on the device" -- both of which are expensive to diagnose from the far end.

So we don't trust ``is_available()``. We run an actual CUDA matmul in each tool
environment and check the device's compute capability against the arch list the
wheel was built with.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

# Every model stage lives in its own uv tool environment so their torch/numpy
# pins can't fight. Each needs its own CUDA verification.
TOOL_ENVS = ("audio-separator", "beat-this")

# Probes torch from inside a tool env and reports back as JSON. Deliberately
# runs a real matmul: allocating a tensor succeeds on an unsupported arch, but
# executing a kernel against it does not.
_TORCH_PROBE = """
import json
out = {}
try:
    import torch
    out["torch"] = torch.__version__
    out["cuda_build"] = torch.version.cuda
    out["arch_list"] = torch.cuda.get_arch_list()
    out["available"] = torch.cuda.is_available()
    if out["available"]:
        out["device"] = torch.cuda.get_device_name(0)
        out["capability"] = list(torch.cuda.get_device_capability(0))
        try:
            x = torch.randn(64, 64, device="cuda")
            out["matmul"] = bool((x @ x).sum().isfinite().item())
        except Exception as exc:
            out["matmul"] = False
            out["matmul_error"] = f"{type(exc).__name__}: {exc}"
except Exception as exc:
    out["error"] = f"{type(exc).__name__}: {exc}"
print(json.dumps(out))
"""

_ORT_PROBE = """
import json
out = {}
try:
    import onnxruntime
    out["version"] = onnxruntime.__version__
    out["providers"] = onnxruntime.get_available_providers()
except Exception as exc:
    out["error"] = f"{type(exc).__name__}: {exc}"
print(json.dumps(out))
"""

_AUDIO_IO_PROBE = """
import json
out = {}
try:
    import soundfile
    out["soundfile"] = soundfile.__version__
    out["libsndfile"] = soundfile.__libsndfile_version__
except Exception as exc:
    out["error"] = f"{type(exc).__name__}: {exc}"
print(json.dumps(out))
"""


@dataclass
class Check:
    name: str
    ok: bool
    detail: str
    hint: str | None = None


def _run(cmd: list[str], timeout: int = 120) -> tuple[int, str, str]:
    """Run a command with an argument list. Never uses a shell."""
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
    except FileNotFoundError:
        return 127, "", f"not found: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout}s"
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def _probe_json(python: Path, script: str) -> dict:
    """Run a probe script in another interpreter and parse its JSON line."""
    code, out, err = _run([str(python), "-c", script])
    if code != 0 and not out:
        return {"error": err or f"exit {code}"}
    try:
        return json.loads(out.splitlines()[-1])
    except (ValueError, IndexError):
        return {"error": f"unparseable probe output: {out[:200]!r} {err[:200]!r}"}


def tool_env_python(tool: str) -> Path | None:
    """Locate the interpreter inside a uv tool environment."""
    code, out, _ = _run(["uv", "tool", "dir"])
    if code != 0:
        return None
    root = Path(out) / tool
    for candidate in (root / "Scripts" / "python.exe", root / "bin" / "python"):
        if candidate.exists():
            return candidate
    return None


def check_binary(name: str, args: list[str], label: str | None = None) -> Check:
    label = label or name
    if shutil.which(name) is None:
        return Check(label, False, "not on PATH", f"install {name} and reopen the shell")
    code, out, err = _run([name, *args])
    if code != 0:
        return Check(label, False, (err or out or f"exit {code}").splitlines()[0])
    first = (out or err).splitlines()[0] if (out or err) else "ok"
    return Check(label, True, first[:80])


def check_gpu() -> Check:
    if shutil.which("nvidia-smi") is None:
        return Check("nvidia driver", False, "nvidia-smi not on PATH")
    code, out, err = _run(
        [
            "nvidia-smi",
            "--query-gpu=name,driver_version,memory.total",
            "--format=csv,noheader",
        ]
    )
    if code != 0:
        return Check("nvidia driver", False, err or f"exit {code}")
    return Check("nvidia driver", True, out.splitlines()[0].strip())


def check_torch(tool: str) -> list[Check]:
    """Verify a tool env has a CUDA torch that can actually execute kernels."""
    python = tool_env_python(tool)
    if python is None:
        return [
            Check(
                f"{tool}: env",
                False,
                "tool environment not found",
                f"uv tool install {tool} --python 3.11 --torch-backend=cu128",
            )
        ]

    info = _probe_json(python, _TORCH_PROBE)
    if "error" in info:
        return [Check(f"{tool}: torch", False, info["error"])]

    checks = [
        Check(
            f"{tool}: torch",
            True,
            f"{info['torch']} (built for CUDA {info.get('cuda_build')})",
        )
    ]

    if not info.get("available"):
        checks.append(
            Check(
                f"{tool}: cuda",
                False,
                "torch cannot see the GPU -- this is almost certainly a CPU-only wheel",
                f"uv tool install {tool} --python 3.11 --torch-backend=cu128 --force",
            )
        )
        return checks

    cap = tuple(info.get("capability") or ())
    cap_str = f"sm_{cap[0]}{cap[1]}" if len(cap) == 2 else "unknown"
    arch_list = info.get("arch_list") or []
    checks.append(
        Check(f"{tool}: device", True, f"{info.get('device')} ({cap_str})")
    )

    # The definitive compatibility test: does this wheel ship kernels for this
    # GPU's architecture, and do they actually run?
    arch_ok = any(cap_str in a for a in arch_list)
    if not arch_ok:
        checks.append(
            Check(
                f"{tool}: kernels",
                False,
                f"wheel has no {cap_str} kernels (built for: {', '.join(arch_list) or 'none'})",
                "reinstall with --torch-backend=cu128 or newer",
            )
        )
    elif not info.get("matmul"):
        checks.append(
            Check(
                f"{tool}: kernels",
                False,
                info.get("matmul_error", "CUDA matmul failed"),
                "reinstall with --torch-backend=cu128 or newer",
            )
        )
    else:
        checks.append(
            Check(f"{tool}: kernels", True, f"{cap_str} matmul executed on GPU")
        )
    return checks


def check_audio_io(tool: str) -> Check:
    """Can this tool env actually decode a file?

    ``beat_this`` reports CUDA fine and then dies on the first audio load if it
    has no backend: it tries torchcodec, then soundfile, then madmom, and fails
    with three import errors and a generic "Could not load audio". None of the
    torch checks above catch it, which is exactly the kind of gap this command
    exists to close.
    """
    python = tool_env_python(tool)
    if python is None:
        return Check(f"{tool}: audio i/o", False, "tool environment not found")
    info = _probe_json(python, _AUDIO_IO_PROBE)
    if "error" in info:
        return Check(
            f"{tool}: audio i/o",
            False,
            f"no decoder: {info['error']}",
            f"uv tool install {tool} --python 3.11 --with soundfile --torch-backend=cu128",
        )
    return Check(
        f"{tool}: audio i/o",
        True,
        f"soundfile {info.get('soundfile')} (libsndfile {info.get('libsndfile')})",
    )


def check_onnxruntime(tool: str) -> Check:
    """audio-separator runs some models through onnxruntime, not torch."""
    python = tool_env_python(tool)
    if python is None:
        return Check(f"{tool}: onnxruntime", False, "tool environment not found")
    info = _probe_json(python, _ORT_PROBE)
    if "error" in info:
        return Check(f"{tool}: onnxruntime", False, info["error"])
    providers = info.get("providers", [])
    if "CUDAExecutionProvider" not in providers:
        return Check(
            f"{tool}: onnxruntime",
            False,
            f"no CUDA provider (have: {', '.join(providers)})",
            f'uv tool install "{tool}[gpu]" --python 3.11 --torch-backend=cu128 --force',
        )
    return Check(
        f"{tool}: onnxruntime", True, f"{info.get('version')} with CUDAExecutionProvider"
    )


def run_all() -> list[Check]:
    checks = [
        check_binary("ffmpeg", ["-version"]),
        check_binary("yt-dlp", ["--version"]),
        check_gpu(),
    ]
    for tool in TOOL_ENVS:
        checks.extend(check_torch(tool))
    checks.append(check_audio_io("beat-this"))
    checks.append(check_onnxruntime("audio-separator"))
    return checks
