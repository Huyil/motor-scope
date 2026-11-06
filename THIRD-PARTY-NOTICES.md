# 第三方组件与许可说明

本仓库自有的源代码与文档（`*.py` / `*.js` / `*.html` / `*.css` / `docs/` /
构建脚本等）按根目录 [LICENSE](LICENSE) 的 **MIT** 许可授权。

下列组件**不属于**该 MIT 授权范围，各自遵循原始许可。它们通过 git submodule
或独立下载提供，**不随主仓源码分发**。

## 组件清单

| 组件 | 位置 | 获取方式 | 许可 |
| --- | --- | --- | --- |
| OpenOCD 配置存档 | `tools/openocd-cfg/` | git submodule | 见该仓库；`cw32l01x-*.cfg` 文件头声明 GPL-2.0-or-later，`lks32mc07x.cfg` 为本项目原创（随本项目协议） |
| WCH 定制版 OpenOCD 源码 | `tools/riscv-openocd-wch/` | git submodule | **GPL-2.0-or-later** |
| RISC-V 预编译二进制 | `tools/openocd-wch-fast/` | 由 `tools/fetch_openocd.py` 从 Release 下载（不入 git） | **GPL-2.0-or-later**（对应源码见上一条 submodule） |
| 标准 OpenOCD 发行版 | `tools/openocd/` | 用户自备（不入 git） | **GPL-2.0-or-later** |
| 便携 Python 运行时 | `runtime/` | 随目录分发（不入 git） | **PSF License** |

## 来源与版本

| 项 | 值 |
| --- | --- |
| ARM 链路 OpenOCD | `openocd-org/openocd` **0.12.0-rc2**（`0.12.0-rc2-g7a1adfbec`） |
| RISC-V 链路 OpenOCD | `Huyil/riscv-openocd-wch`（WCH 定制版，`wlinke` + `sdi`） |
| RISC-V 二进制 Release | `v0.11.0.dev-fastread` |
| 便携 Python | CPython 3.13.3（PSF License） |

## GPL 合规说明

MotorScope 主程序通过 TCP/TCL 端口以**独立进程**方式调用 OpenOCD
（`subprocess.Popen` 拉起、经 `tcl_port` 通信），属于 GPL 的
「单纯聚合（mere aggregation）」，不构成静态链接或衍生作品，
因此 GPL 不延伸至本项目自有代码，自有代码可按 MIT 授权。

分发 OpenOCD 二进制时需同时满足 GPL-2.0-or-later 的义务：

1. 提供**对应源码**（含所有本地修改/补丁）或书面要约；
   `tools/riscv-openocd-wch/` submodule 与 `patches/` 即为对应源码。
2. 保留版权声明与许可证文本（`COPYING`、`AUTHORS`、`LICENSES/`，
   Release 包内的 `COPYING` 已随附）。
3. 不得对 GPL 部分施加额外限制。

## 免责

本文件为工程与合规实践说明，**不构成法律意见**。涉及再分发前，
请自行核实各组件的最新许可条款（尤其是来自 WCH / MounRiver Studio 的
`ch32-riscv.cfg` 等厂商配置，其再分发条款需单独确认）。
