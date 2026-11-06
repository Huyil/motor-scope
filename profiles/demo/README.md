# 仿真演示符号表

这里的 `*.signals.json` 只用于**仿真模式演示**：

- 变量名取 `SimSource` 能识别的名字（`motor.over.current` 等），所以连仿真后能立刻加波看到曲线；
- 地址是假地址，**不指向任何真实外设**；
- `profiles/<机型>/signals.json` 缺失时，服务端会自动回退到这里，并在日志里提示「演示符号表」。

**实机使用前必须重建**：导入真实固件的 AXF（UI「导入 AXF」或 `POST /api/catalog/import`），或用「重建当前机型符号」按钮。

重新生成：`python tools/make_demo_profiles.py`
