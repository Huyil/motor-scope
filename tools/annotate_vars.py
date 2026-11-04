#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""annotate_vars.py — 为 profiles/LKS32-FOC 的变量补中文 desc。

desc 持久化在 profiles/LKS32-FOC/annotations.json（生成物之外），
重新导入/重建 signals.json 不会覆盖；signals.json 里也会同步写一份供当前 UI 直接读取。

注释来源（GBK 编码的 Linko 工程源码）：
  - LKS32MC071_FOC_Sensorless_V2.0/3-Software/**/*.{h,c}
  - LKS32MC071DOCBT8_FOC_Sensorless_6N_V2.0/071DO_Software/**/*.h

匹配策略（按优先级）：
  1. DWARF 定位叶子成员所在 struct 类型名 → 该 struct 定义块内的成员注释；
  2. 叶子成员名在整个代码库唯一命中一条注释 → 直接使用；
  3. 同名多条注释且无法消歧 → 不写 desc（禁止编造）。

用法： python3 tools/annotate_vars.py            # 写回（先自行备份）
      python3 tools/annotate_vars.py --check    # 只统计，不写
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

SCOPE_ROOT = Path("/mnt/d/Code/motor-scope")
SIGNALS = SCOPE_ROOT / "profiles/LKS32-FOC/signals.json"
ANNOTATIONS = SCOPE_ROOT / "profiles/LKS32-FOC/annotations.json"
SRC_DIRS = [
    Path("/mnt/d/Code/LKS32/LKS32MC071_FOC_Sensorless_V2.0/3-Software"),
    Path("/mnt/d/Code/LKS32/LKS32MC071DOCBT8_FOC_Sensorless_6N_V2.0/071DO_Software"),
]
AXF = Path("/mnt/d/Code/LKS32/lks07x_Project.axf")

# ---------------------------------------------------------------- 注释抽取

DECL_RE = re.compile(
    r"(?:^|[\s,\(])(\w+)\s*(?:\[[^\]]*\])?\s*(?::\s*\d+)?\s*;"  # name [ [N] ] [: bit] ;
)


def norm(text):
    """中文注释去多余空白。"""
    return re.sub(r"\s+", "", text).strip()


def read_source(path):
    try:
        return path.read_bytes().decode("gbk", errors="replace")
    except OSError:
        return ""


def split_comment(text):
    """从行剩余部分提取尾注释（/* */、/**、/**<、//）。返回 (注释, 剩余)。"""
    text = text.lstrip()
    for pat in (r"/\*\*?<(.+?)\*/", r"/\*+<!?(.+?)\*/", r"/\*(.+?)\*/"):
        m = re.match(pat, text, re.S)
        if m:
            return m.group(1), ""
    if text.startswith("//"):
        return text[2:], ""
    return "", text


def parse_decls(text, lineno_iter, emit):
    """逐行扫描声明行，emit(name, comment)。支持行尾注释与前一行 // 或块注释。"""
    prev_cmt = ""   # 紧邻上一行的连续注释
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        raw = lines[i]
        code, sep, tail = raw.partition(";")
        if sep and DECL_RE.search(code + ";"):
            names = [m.group(1) for m in DECL_RE.finditer(code + ";")]
            cmt, rest = split_comment(tail)
            if not cmt and prev_cmt:
                cmt = prev_cmt
            cmt = norm(cmt)
            for n in names:
                emit(n, cmt)
            prev_cmt = ""
            i += 1
            continue
        # 不含声明：判断是否可累积的注释行
        s = raw.strip()
        if s.startswith("//"):
            prev_cmt = (prev_cmt + " " if prev_cmt else "") + s[2:]
        else:
            m = re.fullmatch(r"/\*+<?(.*)\*+/", s)
            if m and prev_cmt is not None:
                prev_cmt = (prev_cmt + " " if prev_cmt else "") + m.group(1)
            elif not s:
                pass  # 空行：允许注释与声明之间夹一个空行
            else:
                prev_cmt = ""
        i += 1


def collect_structs(text):
    """抽取 struct/union 定义块：{(名字或''): {member: comment}}。"""
    out = {}
    for m in re.finditer(r"\b(?:typedef\s+)?(?:(?:const|volatile|static)\s+)*(?:struct|union)\s*(\w+)?\s*(?:ATTR[^{]*)?\{", text):
        sname = m.group(1) or ""
        start = m.end() - 1
        depth = 0
        end = start
        for j in range(start, len(text)):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    end = j
                    break
        body = text[start + 1:end]
        # typedef struct {...} Xxx; 的名字在 } 后
        if not sname:
            tm = re.match(r"\s*(\w+)\s*[,\[;]", text[end + 1:])
            if tm:
                sname = tm.group(1)
        members = {}
        parse_decls(body, None, lambda n, c: c and members.setdefault(n, c))
        if members:
            out.setdefault(sname, {}).update(members)
    return out


def build_comment_db():
    """返回 (全局 leaf -> comment 唯一命中, leaf -> [comments] 全部, struct 名 -> members)。"""
    leaf_all = defaultdict(list)
    structs = {}
    files = []
    for root in SRC_DIRS:
        files += list(root.rglob("*.h")) + list(root.rglob("*.c"))
    for p in files:
        text = read_source(p)
        for sn, mem in collect_structs(text).items():
            structs.setdefault(sn, {})
            for n, c in mem.items():
                cur = structs[sn].get(n)
                if cur and cur != c:
                    continue  # 冲突保留先见者
                structs[sn].setdefault(n, c)
        parse_decls(text, None, lambda n, c: c and leaf_all[n].append(c))
    leaf_unique = {}
    leaf_multi = {}
    for n, cs in leaf_all.items():
        uq = sorted(set(cs))
        if len(uq) == 1:
            leaf_unique[n] = uq[0]
        elif len(uq) > 1:
            leaf_multi[n] = uq
    return leaf_unique, leaf_multi, structs


# ---------------------------------------------------------------- DWARF 消歧

def dwarf_struct_of_leaf():
    """返回 {完整变量名: 叶子成员所在 struct 类型名}（匿名 struct 记 ''，不可用）。"""
    result = {}
    try:
        from elftools.elf.elffile import ELFFile
    except ImportError:
        return result
    f = open(AXF, "rb")
    elf = ELFFile(f)
    if not elf.has_dwarf_info():
        return result
    dw = elf.get_dwarf_info()

    def resolve_type(die):
        """剥 typedef/cv/数组壳，返回 (结构 DIE, 最后一个 typedef 名)。"""
        seen = set()
        td_name = ""
        while die is not None and die.offset not in seen:
            seen.add(die.offset)
            if die.tag == "DW_TAG_typedef":
                a = die.attributes.get("DW_AT_name")
                if a:
                    td_name = a.value.decode()
            if die.tag in ("DW_TAG_typedef", "DW_TAG_volatile_type", "DW_TAG_const_type", "DW_TAG_array_type"):
                if die.attributes.get("DW_AT_type"):
                    die = die.get_DIE_from_attribute("DW_AT_type")
                else:
                    die = None
            else:
                break
        return die, td_name

    def struct_key(die, td_name):
        die, td2 = resolve_type(die)
        if die is not None and die.tag in ("DW_TAG_structure_type", "DW_TAG_union_type"):
            a = die.attributes.get("DW_AT_name")
            if a:
                return a.value.decode()
            return td2 or td_name  # 匿名 struct → 用 typedef 名
        return None

    # 顶层变量 DIE
    topvars = {}
    for cu in dw.iter_CUs():
        for die in cu.iter_DIEs():
            if die.tag == "DW_TAG_variable" and "DW_AT_declaration" not in die.attributes:
                n = die.attributes.get("DW_AT_name")
                if n:
                    topvars.setdefault(n.value.decode(), die)

    def walk(die, td_name, segs, acc):
        if not segs:
            return
        sname = struct_key(die, td_name)
        if sname is None:
            return
        target = segs[0].split("[")[0]
        child = None
        die, _ = resolve_type(die)
        if die is None:
            return
        for c in die.iter_children():
            if c.tag == "DW_TAG_member":
                n = c.attributes.get("DW_AT_name")
                if n and n.value.decode() == target:
                    child = c
                    break
        if child is None:
            return
        acc = acc + [sname]
        if len(segs) == 1:
            result_full.append(tuple(acc))
            return
        if child.attributes.get("DW_AT_type"):
            walk(child.get_DIE_from_attribute("DW_AT_type"), "", segs[1:], acc)

    result_full = []
    return_placeholder = None
    vars_ = json.loads(SIGNALS.read_text(encoding="utf-8"))["variables"]
    for v in vars_:
        parts = v["name"].split(".")
        top = topvars.get(parts[0].split("[")[0])
        if top is None:
            continue
        result_full.clear()
        if len(parts) == 1:
            # 顶层标量：无名结构链
            continue
        if top.attributes.get("DW_AT_type"):
            walk(top.get_DIE_from_attribute("DW_AT_type"), "", parts[1:], [])
        if result_full:
            # 叶子成员所在 struct 名 = 链上最后一个 struct
            leaf_struct = result_full[0][-1]
            if leaf_struct:
                result[v["name"]] = leaf_struct
    f.close()
    return result


# ---------------------------------------------------------------- 主流程

def main():
    check_only = "--check" in sys.argv
    leaf_unique, leaf_multi, structs = build_comment_db()
    print(f"注释抽取：唯一命中 leaf {len(leaf_unique)} 个，多义 leaf {len(leaf_multi)} 个，"
          f"struct 定义 {len(structs)} 个")

    dw_map = dwarf_struct_of_leaf()
    print(f"DWARF 消歧：解析出 struct 归属的变量 {len(dw_map)} 个")

    data = json.loads(SIGNALS.read_text(encoding="utf-8"))
    variables = data["variables"]
    hit_struct = hit_unique = hit_multi = miss = 0
    for v in variables:
        leaf = v["name"].split(".")[-1]
        desc = None
        sn = dw_map.get(v["name"])
        if sn:
            desc = structs.get(sn, {}).get(leaf)
        if desc:
            hit_struct += 1
        elif leaf in leaf_unique:
            desc = leaf_unique[leaf]
            hit_unique += 1
        elif leaf in leaf_multi:
            hit_multi += 1
        else:
            miss += 1
        if desc and not check_only:
            v["desc"] = desc

    total = len(variables)
    covered = sum(1 for v in variables if v.get("desc"))
    print(f"变量总数 {total}，覆盖 {covered} ({covered * 100 / total:.1f}%) | "
          f"struct 精确 {hit_struct} / 唯一名 {hit_unique} / 多义未解 {hit_multi} / 无注释 {miss}")
    if check_only:
        return

    # 1) 独立注释文件：重建 signals.json 时由 profiles/服务端合并，不会丢
    ann = {}
    if ANNOTATIONS.exists():
        try:
            ann = json.loads(ANNOTATIONS.read_text(encoding="utf-8"))
        except Exception:
            ann = {}
    ann_vars = ann.get("variables") if isinstance(ann.get("variables"), dict) else {}
    for v in variables:
        desc = str(v.get("desc") or "").strip()
        if desc:
            ann_vars[v["name"]] = desc
    ANNOTATIONS.parent.mkdir(parents=True, exist_ok=True)
    ANNOTATIONS.write_text(json.dumps({"version": 1, "variables": dict(sorted(ann_vars.items()))},
                                      ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"注释文件 → {ANNOTATIONS}（{len(ann_vars)} 条）")

    # 2) signals.json 也同步一份，当前服务/前端无需重启即可读到 desc
    bak = SIGNALS.with_suffix(".json.bak-" + __import__("time").strftime("%H%M%S"))
    bak.write_text(SIGNALS.read_text(encoding="utf-8"), encoding="utf-8")
    print(f"备份 → {bak}")
    SIGNALS.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                       encoding="utf-8")
    print(f"写回 → {SIGNALS}")


if __name__ == "__main__":
    main()
