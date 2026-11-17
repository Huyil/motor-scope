#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CMSIS-DAP 后端/序列号兜底单测（不依赖真实探针）。"""
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import ocd  # noqa: E402
import scope_server  # noqa: E402


class SerialCaseVariantsTest(unittest.TestCase):
    def test_uppercase_wmi_serial_tries_lowercase(self):
        # Windows PNP 实例后缀大写；Air32 固件上报小写
        out = scope_server._serial_case_variants("000100011A5A5BB6")
        self.assertEqual(out[0], "000100011A5A5BB6")
        self.assertIn("000100011a5a5bb6", out)

    def test_h7_serial_keeps_original_first(self):
        # H7-TOOL 的序列号含大写 B，原样必须优先
        out = scope_server._serial_case_variants("002B00313031510537363237")
        self.assertEqual(out[0], "002B00313031510537363237")

    def test_digits_only_has_one_variant(self):
        self.assertEqual(scope_server._serial_case_variants("1234567890"), ["1234567890"])

    def test_empty_serial(self):
        self.assertEqual(scope_server._serial_case_variants(""), [""])


class IfaceAlternatesTest(unittest.TestCase):
    def test_v2_offers_v1_and_back(self):
        with tempfile.TemporaryDirectory() as d:
            v2 = os.path.join(d, "cmsis-dap.cfg")
            v1 = os.path.join(d, "cmsis-dap-v1.cfg")
            for p in (v2, v1):
                with open(p, "w", encoding="utf-8"):
                    pass
            self.assertEqual(scope_server._cmsis_dap_iface_alternates(v2), [v1])
            self.assertEqual(scope_server._cmsis_dap_iface_alternates(v1), [v2])

    def test_non_cmsis_dap_not_switched(self):
        with tempfile.TemporaryDirectory() as d:
            st = os.path.join(d, "stlink.cfg")
            with open(st, "w", encoding="utf-8"):
                pass
            self.assertEqual(scope_server._cmsis_dap_iface_alternates(st), [])

    def test_missing_alternate_returns_empty(self):
        with tempfile.TemporaryDirectory() as d:
            v2 = os.path.join(d, "cmsis-dap.cfg")
            with open(v2, "w", encoding="utf-8"):
                pass
            self.assertEqual(scope_server._cmsis_dap_iface_alternates(v2), [])


class AdapterRetryableTest(unittest.TestCase):
    def test_probe_level_errors_are_retryable(self):
        for msg in (
            "Error: unable to find a matching CMSIS-DAP device",
            "Error: CMSIS-DAP command CMD_INFO failed.",
            "Error: could not claim interface",
            "LIBUSB_ERROR_NOT_FOUND",
        ):
            self.assertTrue(scope_server._is_adapter_retryable(RuntimeError(msg)), msg)

    def test_target_wiring_errors_are_not_retryable(self):
        for msg in (
            "Error connecting DP: cannot read IDR",
            "CPUID 读取失败: timeout",
            "OpenOCD 不存在: x",
        ):
            self.assertFalse(scope_server._is_adapter_retryable(RuntimeError(msg)), msg)


class AdapterFatalLineTest(unittest.TestCase):
    def test_cmd_info_failure_is_detected_from_log(self):
        p = ocd.OcdProcess(ocd.OcdPaths("ocd", "scripts", "cmsis-dap-v1.cfg", ""))
        p._append_log("Error: CMSIS-DAP command CMD_INFO failed.")
        self.assertIn("CMD_INFO", p._adapter_fatal_line())

    def test_normal_init_is_not_fatal(self):
        p = ocd.OcdProcess(ocd.OcdPaths("ocd", "scripts", "cmsis-dap.cfg", ""))
        p._append_log("Info : CMSIS-DAP: Interface Initialised (SWD)")
        p._append_log("Info : CMSIS-DAP: Interface ready")
        self.assertEqual(p._adapter_fatal_line(), "")


if __name__ == "__main__":
    unittest.main()