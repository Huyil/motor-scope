# 第三方组件与许可说明

本仓库自有的源代码与文档（`*.py` / `*.js` / `*.html` / `*.css` / `docs/` /
构建脚本等）按根目录 [LICENSE](LICENSE) 的 **MIT** 许可授权。

下列组件**不属于**该 MIT 授权范围，各自遵循原始许可。

> **发行包（Release zip）说明**：发行包可能包含下表列出的 GPL 二进制，
> 但它们与 MIT 部分**明确分层**，MIT 仅覆盖本项目自有代码。
> 主仓 git 不跟踪这些二进制（见 `.gitignore`），发行包由
> `tools/package_release.py` 组装并在打包前做合规自检。

## 组件清单

| 组件 | 位置 | 获取方式 | 许可 |
| --- | --- | --- | --- |
| OpenOCD 配置存档 | `tools/openocd-cfg/` | git submodule | 见该仓库；`cw32l01x-*.cfg` 文件头声明 GPL-2.0-or-later，`lks32mc07x.cfg` 为本项目原创（随本项目协议） |
| WCH 定制版 OpenOCD 源码 | `tools/riscv-openocd-wch/` | git submodule / 发行包内 | **GPL-2.0-or-later** |
| RISC-V 预编译二进制 | `tools/openocd-wch-fast/` | 发行包内 / `tools/fetch_openocd.py` 下载 | **GPL-2.0-or-later**（对应源码见上一条） |
| 标准 OpenOCD 发行版 | `tools/openocd/` | 发行包内 / 用户自备 | **GPL-2.0-or-later** |
| 便携 Python 运行时 | `runtime/` | 随目录分发（不入 git） | **PSF License** |

## 来源与版本

| 项 | 值 |
| --- | --- |
| ARM 链路 OpenOCD | [`openocd-org/openocd`](https://github.com/openocd-org/openocd) **0.12.0-rc2**，git describe `0.12.0-rc2-g7a1adfbec`（commit `7a1adfbec`，上游 tag `v0.12.0-rc2` = `62cdf7a1`） |
| RISC-V 链路 OpenOCD | [`Huyil/riscv-openocd-wch`](https://github.com/Huyil/riscv-openocd-wch)（WCH 定制版，`wlinke` + `sdi`，分支 `wch-linke-sdi`） |
| RISC-V 二进制 Release | [`v0.11.0.dev-fastread`](https://github.com/Huyil/riscv-openocd-wch/releases/tag/v0.11.0.dev-fastread) |
| 便携 Python | CPython 3.13.3（PSF License） |

## 文档与数据来源

| 内容 | 来源 | 说明 |
| --- | --- | --- |
| `web/mcu/LKS32MC07x.info.json` 的寄存器描述 | **LKS32MC07x 用户手册 v1.69** | 401 个寄存器 / 1515 个位域的中文说明摘录，**版权归 Linko / 厂商所有**，此处仅作技术参考与检索用途，不构成对该文档的再授权 |
| `web/mcu/LKS32MC07x.json` 等寄存器表 | 厂商 SVD / 头文件解析生成 | 地址、位域定义属事实性数据；结构按本项目的 JSON schema 重新组织 |
| `web/mcu/CW32L01x.json` | 厂商头文件 + AXF DWARF + SVD 交叉核对 | 同上 |
| `web/mcu/CH32V203*.json` | 厂商 CMSIS-SVD 解析 | 同上 |

> 寄存器地址、位域偏移等信息属功能性事实，通常不受著作权保护；但手册中的
> **中文描述文字**版权归厂商。若版权方有异议，可删除
> `LKS32MC07x.info.json` 中对应的 `full` 字段（`static` 短描述可保留），
> 程序功能不受影响（`load_reginfo()` 会退化为空表）。

## GPL 合规说明

MotorScope 主程序通过 TCP/TCL 端口以**独立进程**方式调用 OpenOCD
（`subprocess.Popen` 拉起、经 `tcl_port` 通信），属于 GPL 的
「单纯聚合（mere aggregation）」，不构成静态链接或衍生作品，
因此 GPL 不延伸至本项目自有代码，自有代码可按 MIT 授权。

**边界确认**（本项目实际做法）：

- 不静态链接 `libopenocd.a` / `openocd.lib`
- 不使用 `ctypes.CDLL` 加载 OpenOCD 内部符号
- 不复制 OpenOCD 源码进自有 `*.py` / `*.js`
- 仅通过命令行参数 + TCP 端口 + 文本协议交互

分发 OpenOCD 二进制时需同时满足 GPL-2.0-or-later 的义务：

1. **提供对应源码**（含所有本地修改/补丁）或书面要约：
   - 标准 OpenOCD 0.12.0-rc2：<https://github.com/openocd-org/openocd>（commit `7a1adfbec`）
   - RISC-V 定制版：源码已随发行包提供（`tools/riscv-openocd-wch/`），
     补丁见 `tools/openocd-wch-fast/patches/`（`01-wch-block-read.patch`、`02-build-compat.patch`）
2. **保留版权声明与许可证文本**：`tools/openocd/COPYING`、`tools/openocd/LICENSES/`、
   `tools/openocd-wch-fast/COPYING` 均已随包提供（含 GPL-2.0 全文 355 行）。
3. **不得对 GPL 部分施加额外限制**（不要声明「整个包仅 MIT」）。

## 免责

本文件为工程与合规实践说明，**不构成法律意见**。涉及正式再分发前，
请自行核实各组件的最新许可条款（尤其是来自 WCH / MounRiver Studio 的
`ch32-riscv.cfg` 等厂商配置，其再分发条款需单独确认）。
