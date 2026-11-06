#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OpenOCD TCL-RPC 客户端 + 进程管理 (MotorScope 的采样后端).

要点:
  * TCL RPC: 连 tcl_port, 每条命令以 0x1a 结束, 返回也以 0x1a 结束.
  * 采样用 Tcl 的 read_memory 原语, 一次命令读多个区域, 不做 halt.
  * 一次 OpenOCD 进程 + 一条长连接; 每次采样只是一次 TCP 往返.

为什么不用 gdb / telnet:
  * gdb 连上会 halt 内核, 电机测试要活体读;
  * telnet 会回显/带提示符, 机器接口用 tcl_port 更干净.
"""
from __future__ import annotations

import os
import socket
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Deque, Dict, Iterable, List, Optional, Sequence, Tuple

DELIM = b"\x1a"
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


class OcdError(RuntimeError):
    pass


class TclClient:
    """OpenOCD tcl_port 的最小同步客户端 (单线程使用, 内部加锁)."""

    def __init__(self, host: str = "127.0.0.1", port: int = 6666,
                 timeout: float = 4.0):
        self.host = host
        self.port = int(port)
        self.timeout = float(timeout)
        self._sock: Optional[socket.socket] = None
        self._buf = b""
        self._lock = threading.Lock()

    @property
    def connected(self) -> bool:
        return self._sock is not None

    def connect(self) -> None:
        self.close()
        try:
            sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        except OSError as exc:
            raise OcdError("连接 TCL %s:%d 失败: %s" % (self.host, self.port, exc))
        sock.settimeout(self.timeout)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self._sock = sock
        self._buf = b""

    def close(self) -> None:
        sock, self._sock = self._sock, None
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass

    def _recv_until(self, marker: bytes, deadline: float) -> bytes:
        while marker not in self._buf:
            remain = deadline - time.monotonic()
            if remain <= 0:
                raise OcdError("OpenOCD TCL 响应超时 (%.1fs)" % self.timeout)
            if self._sock is None:
                raise OcdError("OpenOCD TCL 未连接")
            self._sock.settimeout(max(0.05, remain))
            chunk = self._sock.recv(65536)
            if not chunk:
                raise OcdError("OpenOCD TCL 连接被关闭")
            self._buf += chunk
        data, _, self._buf = self._buf.partition(marker)
        return data

    def command(self, text: str, timeout: Optional[float] = None) -> str:
        with self._lock:
            if self._sock is None:
                raise OcdError("OpenOCD TCL 未连接")
            deadline = time.monotonic() + (timeout or self.timeout)
            try:
                self._sock.sendall(text.encode("utf-8") + DELIM)
            except OSError as exc:
                raise OcdError("发送 TCL 命令失败: %s" % exc)
            data = self._recv_until(DELIM, deadline)
            return data.decode("utf-8", "replace")

    def install_halt_reader(self) -> None:
        """RISC-V: 内存读必须先 halt；一条 Tcl 命令内完成 halt→读→resume。"""
        proc = (
            "proc ms_read_halt {regions} {\n"
            "  catch {halt}\n"
            "  set code [catch {\n"
            "    set out {}\n"
            "    foreach r $regions {\n"
            "      set out [concat $out [read_memory [lindex $r 0] 32 [lindex $r 1]]]\n"
            "    }\n"
            "  } result]\n"
            "  catch {resume}\n"
            "  if {$code} { error $result }\n"
            "  return $out\n"
            "}"
        )
        self.command(proc)

    def read_regions_halt(self, regions: Sequence[Tuple[int, int]]) -> List[int]:
        if not regions:
            return []
        spec = " ".join("{0x%08x %d}" % (int(a), int(n)) for a, n in regions)
        resp = self.command("ms_read_halt {%s}" % spec)
        return _parse_int_list(resp, expect=sum(int(n) for _, n in regions))

    def resume(self) -> None:
        self.command("resume")

    # ---- 采样相关 -------------------------------------------------
    def install_reader(self) -> None:
        """安装批量读内存的 Tcl 过程 (幂等)."""
        proc = (
            "proc ms_read {regions} {\n"
            "  set out {}\n"
            "  foreach r $regions {\n"
            "    set out [concat $out [read_memory [lindex $r 0] 32 [lindex $r 1]]]\n"
            "  }\n"
            "  return $out\n"
            "}"
        )
        self.command(proc)

    def read_words(self, addr: int, count: int) -> List[int]:
        resp = self.command("ms_read {{0x%08x %d}}" % (int(addr), int(count)))
        return _parse_int_list(resp, expect=count)

    def read_regions(self, regions: Sequence[Tuple[int, int]]) -> List[int]:
        """regions: [(word_aligned_addr, word_count), ...] -> 拼接后的 32bit 字列表."""
        if not regions:
            return []
        spec = " ".join("{0x%08x %d}" % (int(a), int(n)) for a, n in regions)
        resp = self.command("ms_read {%s}" % spec)
        total = sum(int(n) for _, n in regions)
        return _parse_int_list(resp, expect=total)

    def write_mem(self, addr: int, size: int, value: int) -> None:
        """写 1/2/4 字节. 调用方保证地址/值合法; 这是唯一会改目标内存的入口."""
        cmd = {1: "mwb", 2: "mwh", 4: "mww"}.get(int(size))
        if cmd is None:
            raise OcdError("不支持写入宽度: %s" % size)
        mask = (1 << (int(size) * 8)) - 1
        self.command("%s 0x%08x 0x%x" % (cmd, int(addr), int(value) & mask))


def _parse_int_list(text: str, expect: Optional[int] = None) -> List[int]:
    raw = text.strip()
    if raw.startswith("{") and raw.endswith("}"):
        raw = raw[1:-1].strip()
    if not raw:
        return []
    out: List[int] = []
    for tok in raw.split():
        tok = tok.strip().strip(",")
        if not tok:
            continue
        try:
            out.append(int(tok, 0))
        except ValueError:
            raise OcdError("无法解析 read_memory 返回值: %r" % text[:200])
    if expect is not None and len(out) != expect:
        raise OcdError("read_memory 返回 %d 个字, 期望 %d 个: %r"
                       % (len(out), expect, text[:200]))
    return out


@dataclass
class OcdPaths:
    exe: str
    scripts: str
    iface: str
    target: str


def _exists(path: str) -> bool:
    return bool(path) and os.path.isfile(path)


def find_openocd(project_dir: str, override: Optional[str] = None) -> Optional[OcdPaths]:
    """按优先级找一套可用的 OpenOCD (exe + 接口/目标 cfg + scripts)."""
    roots: List[str] = []
    if override:
        roots.append(override)
    here = os.path.dirname(os.path.abspath(__file__))
    roots += [
        os.path.join(project_dir, "tools", "openocd"),
        os.path.join(os.path.dirname(os.path.abspath(project_dir)), "tools", "openocd"),
        os.path.join(here, "..", "openocd"),
        r"D:\Code\CW32L012_FLASH_Programming\tools\openocd",
        r"D:\Code\DR2159\tools\openocd",
    ]
    # Windows 大小写/斜杠不敏感; 去重
    seen = set()
    for root in roots:
        root = os.path.abspath(os.path.expanduser(root))
        if root in seen:
            continue
        seen.add(root)
        exe = os.path.join(root, "bin", "openocd.exe" if os.name == "nt" else "openocd")
        if not _exists(exe) and os.name == "nt":
            exe2 = os.path.join(root, "bin", "openocd")
            if _exists(exe2):
                exe = exe2
        scripts = os.path.join(root, "share", "openocd", "scripts")
        iface = os.path.join(scripts, "interface", "cmsis-dap-v1.cfg")
        if not _exists(iface):
            iface = os.path.join(scripts, "interface", "cmsis-dap.cfg")
        target = os.path.join(scripts, "target", "cw32l01x-flm.cfg")
        if _exists(exe) and _exists(iface) and _exists(target):
            return OcdPaths(exe=exe, scripts=scripts, iface=iface, target=target)
    return None


def find_wch_openocd(project_dir: str, override: Optional[str] = None) -> Optional[OcdPaths]:
    """找 WCH/MounRiver 的 RISC-V OpenOCD (wlinke + wch_riscv)."""
    roots: List[str] = []
    if override:
        roots.append(override)
    here = os.path.dirname(os.path.abspath(__file__))
    roots += [
        # 工程内自带的快读版 OpenOCD（tools/openocd-wch-fast）
        os.path.join(project_dir, "tools", "openocd-wch-fast"),
        os.path.join(os.path.dirname(os.path.abspath(project_dir)), "tools", "openocd-wch-fast"),
        os.path.join(here, "..", "openocd-wch-fast"),
        os.path.join(project_dir, "tools", "openocd-wch"),
        os.path.join(os.path.dirname(os.path.abspath(project_dir)), "tools", "openocd-wch"),
        os.path.join(here, "..", "openocd-wch"),
        r"C:\MounRiver\MounRiver_Studio3\resources\app\resources\win32\components\WCH\OpenOCD\OpenOCD",
    ]
    seen = set()
    for root in roots:
        root = os.path.abspath(os.path.expanduser(root))
        if root in seen:
            continue
        seen.add(root)
        exe = os.path.join(root, "bin", "openocd.exe" if os.name == "nt" else "openocd")
        if not _exists(exe) and os.name == "nt":
            exe2 = os.path.join(root, "bin", "openocd")
            if _exists(exe2):
                exe = exe2
        scripts = os.path.join(root, "share", "openocd", "scripts")
        cfg = os.path.join(root, "bin", "wch-riscv.cfg")
        if _exists(exe) and _exists(cfg):
            return OcdPaths(exe=exe, scripts=scripts, iface=cfg, target="")
    return None


def free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])
    finally:
        s.close()


class OcdProcess:
    """启动/持有/关闭一个 openocd 进程, 并保持 TCL 连接."""

    def __init__(self, paths: OcdPaths, port: int = 0, verbose: bool = False):
        self.paths = paths
        self.port = int(port or free_port())
        self.verbose = verbose
        self.proc: Optional[subprocess.Popen] = None
        self.client: Optional[TclClient] = None
        self.log: Deque[str] = deque(maxlen=400)
        self._reader: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._job = _WindowsJob()

    # ---- 日志 -----------------------------------------------------
    def _append_log(self, line: str) -> None:
        line = line.rstrip("\r\n")
        if not line:
            return
        # LKS/长块读时 openocd 会把整块数据回显到 stdout, 截断避免日志爆内存
        if len(line) > 400:
            line = line[:400] + " …(%d chars)" % len(line)
        with self._lock:
            self.log.append(line)
        if self.verbose:
            print("[openocd] " + line, flush=True)

    def log_tail(self, n: int = 40) -> List[str]:
        with self._lock:
            return list(self.log)[-n:]

    # ---- 生命周期 -------------------------------------------------
    def start(self, timeout: float = 15.0, require_cpuid: bool = True) -> TclClient:
        if self.proc is not None:
            raise OcdError("OpenOCD 进程已在运行")
        cmd = [self.paths.exe, "-s", self.paths.scripts, "-f", self.paths.iface]
        if self.paths.target:
            cmd += ["-f", self.paths.target]
        cmd += [
            "-c", "tcl_port %d" % self.port,
            "-c", "telnet_port disabled",
            "-c", "gdb_port disabled",
        ]
        self._append_log("$ " + " ".join(_quote_arg(c) for c in cmd))
        try:
            self.proc = subprocess.Popen(
                cmd,
                cwd=os.path.dirname(self.paths.exe) or None,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=CREATE_NO_WINDOW,
                bufsize=1,
            )
        except OSError as exc:
            raise OcdError("启动 OpenOCD 失败: %s" % exc)

        self._reader = threading.Thread(target=self._reader_loop, name="ocd-log", daemon=True)
        self._reader.start()
        self._job.assign(self.proc)

        deadline = time.monotonic() + timeout
        last_err = ""
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise OcdError("OpenOCD 已退出 (code=%s)\n%s"
                               % (self.proc.returncode, "\n".join(self.log_tail(30))))
            try:
                client = TclClient("127.0.0.1", self.port, timeout=2.0)
                client.connect()
                client.install_reader()
                # 握手: TCL 通了就算成功；CPUID 读不到时按 RISC-V/运行态继续
                cpuid = None
                try:
                    cpuid = client.read_words(0xE000ED00, 1)[0]
                except Exception as exc:
                    if require_cpuid:
                        raise OcdError("CPUID 读取失败: %s" % exc)
                    self._append_log("INFO: CPUID 读取失败（RISC-V 可能在运行），继续: %s" % exc)
                if cpuid == 0:
                    self._append_log("INFO: 目标不是 Cortex-M (CPUID=0)，按 RISC-V / 其它架构继续")
                elif cpuid is not None and cpuid not in (0x410CC200, 0x410CC601):
                    self._append_log("WARN: CPUID=0x%08x (期望 M0=0x410CC200 / M0+=0x410CC601，"
                                     "可能不是 Cortex-M)" % cpuid)
                self.client = client
                self._append_log("TCL 已连接 127.0.0.1:%d, CPUID=%s" % (
                    self.port, "0x%08x" % cpuid if cpuid is not None else "?"))
                return client
            except (OcdError, OSError) as exc:
                last_err = str(exc)
                time.sleep(0.15)
        raise OcdError("连接 OpenOCD TCL 超时 (port %d): %s\n%s"
                       % (self.port, last_err, "\n".join(self.log_tail(30))))

    def _reader_loop(self) -> None:
        proc = self.proc
        if proc is None or proc.stdout is None:
            return
        try:
            for line in proc.stdout:
                self._append_log(line)
        except Exception:
            pass

    def stop(self) -> None:
        guard = 2.0
        if self.client is not None:
            try:
                self.client.close()
            except Exception:
                pass
            self.client = None
        proc, self.proc = self.proc, None
        if proc is None:
            return
        try:
            if proc.poll() is None:
                proc.terminate()
            proc.wait(timeout=guard)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        self._job.close()
        self._append_log("OpenOCD 已关闭")

    @property
    def pid(self) -> Optional[int]:
        return self.proc.pid if self.proc is not None else None

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None


def _quote_arg(arg: str) -> str:
    if not arg or any(c.isspace() for c in arg) or '"' in arg:
        return '"%s"' % arg.replace('"', '\\"')
    return arg


class _WindowsJob:
    """把 openocd 子进程放进 Job Object; 服务器被强杀时子进程也一起死.

    之前实机踩过: 控制台/父进程被 taskkill, openocd 还占着 H7-TOOL,
    下一次连接就是 "CMSIS-DAP command mismatch"。KILL_ON_JOB_CLOSE 兜底。
    """

    def __init__(self):
        self.handle = None
        if os.name != "nt":
            return
        try:
            import ctypes
            from ctypes import wintypes

            class IO_COUNTERS(ctypes.Structure):
                _fields_ = [
                    ("ReadOperationCount", ctypes.c_ulonglong),
                    ("WriteOperationCount", ctypes.c_ulonglong),
                    ("OtherOperationCount", ctypes.c_ulonglong),
                    ("ReadTransferCount", ctypes.c_ulonglong),
                    ("WriteTransferCount", ctypes.c_ulonglong),
                    ("OtherTransferCount", ctypes.c_ulonglong),
                ]

            class BASIC(ctypes.Structure):
                _fields_ = [
                    ("PerProcessUserTimeLimit", ctypes.c_longlong),
                    ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t),
                    ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD),
                ]

            class EXT(ctypes.Structure):
                _fields_ = [
                    ("BasicLimitInformation", BASIC),
                    ("IoInfo", IO_COUNTERS),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t),
                ]

            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.CreateJobObjectW.restype = wintypes.HANDLE
            h = k32.CreateJobObjectW(None, None)
            if not h:
                return
            info = EXT()
            info.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
            if not k32.SetInformationJobObject(h, 9, ctypes.byref(info), ctypes.sizeof(info)):
                k32.CloseHandle(h)
                return
            self.handle = h
        except Exception:
            self.handle = None

    def assign(self, proc) -> None:
        if not self.handle:
            return
        try:
            import ctypes
            from ctypes import wintypes
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            k32.AssignProcessToJobObject(self.handle, wintypes.HANDLE(int(proc._handle)))
        except Exception:
            pass

    def close(self) -> None:
        if not self.handle:
            return
        try:
            import ctypes
            ctypes.WinDLL("kernel32").CloseHandle(self.handle)
        except Exception:
            pass
        self.handle = None


# ---- 采样区域规划 ---------------------------------------------------
@dataclass
class Region:
    addr: int      # word aligned
    words: int
    end: int       # byte end (exclusive)


def plan_regions(spans: Iterable[Tuple[int, int]], max_words: int = 64,
                 max_gap: int = 64, region_cost: Optional[float] = None,
                 word_cost: Optional[float] = None) -> List[Region]:
    """把 (addr, size) 合并成尽量少的 word 读区间.

    合并规则: 下一个地址距当前区间末尾 <= gap_limit 字节, 且总长不超过 max_words 字.

    只按 max_gap 合并会犯一个错: 两个 3 字节的信号隔着 2 KB 时, 合并省下一次
    调试器往返(固定开销), 却要多读 500 个字. 给 region_cost / word_cost
    (ms, 同一单位) 后按代价求盈亏平衡点:
        跨 gap 合并 = 多读 gap/4 字 -> 多花 gap/4*word_cost
        不合并     = 多一次往返      -> 多花 region_cost
    于是 gap_limit = min(max_gap, 4*region_cost/word_cost).
    """
    gap_limit = max(0, int(max_gap))
    if region_cost and word_cost and word_cost > 0:
        by_cost = int(round(float(region_cost) / float(word_cost))) * 4
        gap_limit = min(gap_limit, max(0, by_cost))
    items = sorted((int(a), max(1, int(s))) for a, s in spans)
    regions: List[Region] = []
    cur_addr = cur_end = 0
    for addr, size in items:
        start = addr & ~0x3
        end = (addr + size + 3) & ~0x3
        if regions and start - cur_end <= gap_limit and (end - cur_addr) <= max_words * 4:
            cur_end = max(cur_end, end)
            regions[-1].end = cur_end
            regions[-1].words = (cur_end - cur_addr) // 4
        else:
            cur_addr, cur_end = start, end
            regions.append(Region(cur_addr, (cur_end - cur_addr) // 4, cur_end))
    return regions


def plan_cost(regions: Sequence[Region], region_cost: Optional[float],
              word_cost: Optional[float]) -> Optional[float]:
    """按代价模型估算一轮读取的耗时 (ms); 没有模型时返回 None."""
    if region_cost is None or word_cost is None:
        return None
    return len(regions) * float(region_cost) + \
        sum(r.words for r in regions) * float(word_cost)


def decode_word(word: int, addr: int, region: Region, size: int) -> int:
    off = addr - region.addr
    shift = (off & 0x3) * 8
    if size >= 4:
        return word & 0xFFFFFFFF
    mask = (1 << (size * 8)) - 1
    return (word >> shift) & mask
