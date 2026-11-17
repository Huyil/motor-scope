#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""usb_devices.py 单测：不依赖真实 USB 硬件，用假 WMI/pyusb 数据打桩。"""
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import usb_devices  # noqa: E402


def dev(vid, pid, serial="", desc="", status="OK", instance=""):
    return {"vid": vid, "pid": pid, "serial": serial, "desc": desc,
            "status": status, "instance": instance, "product": desc,
            "manufacturer": "", "bus": None, "address": None}


class LookupTest(unittest.TestCase):
    def test_h7tool_known(self):
        hit = usb_devices._lookup("c251", "f00a", "H7-TOOL CMSIS-DAP")
        self.assertIsNotNone(hit)
        self.assertEqual(hit["name"], "H7-TOOL CMSIS-DAP")
        # H7-TOOL 的 v2(WinUSB) 后端无法 claim，必须用 v1(HID)
        self.assertEqual(hit["iface"], "cmsis-dap-v1.cfg")
        self.assertEqual(hit["transport"], "HID")
        self.assertEqual(hit["arch"], "cw32")

    def test_wchlink_dap(self):
        hit = usb_devices._lookup("1a86", "8012", "WCH-Link")
        self.assertEqual(hit["backend"], "cmsis-dap")
        self.assertEqual(hit["iface"], "cmsis-dap.cfg")

    def test_wchlink_rv_no_iface(self):
        hit = usb_devices._lookup("1a86", "8010", "WCH-Link")
        self.assertEqual(hit["arch"], "riscv")
        self.assertEqual(hit["iface"], "")   # 走 WCH OpenOCD 自带 cfg

    def test_iface_by_name_hint(self):
        hit = usb_devices._lookup("1234", "5678", "My CMSIS-DAP probe")
        self.assertEqual(hit["iface"], "cmsis-dap.cfg")

    def test_unknown(self):
        self.assertIsNone(usb_devices._lookup("dead", "beef", "USB Mouse"))


class WmiAggregateTest(unittest.TestCase):
    """验证 WMI 原始行 -> 聚合出根设备（跳过 MI_xx 子接口）。"""
    def test_mi_children_skipped(self):
        rows = [
            {"instance": "USB\\VID_C251&PID_F00A&MI_00\\6&82379E&0&0000",
             "vid": "c251", "pid": "f00a", "suffix": "&MI_00",
             "desc": "#01 H7-TOOL WinUSB CMSIS-DAP", "status": "OK"},
            {"instance": "USB\\VID_C251&PID_F00A\\002B00313031510537363237",
             "vid": "c251", "pid": "f00a", "suffix": "002B00313031510537363237",
             "desc": "USB Composite Device", "status": "OK"},
            {"instance": "USB\\VID_1A86&PID_8012&MI_00\\8&1AE8&0&0000",
             "vid": "1a86", "pid": "8012", "suffix": "&MI_00",
             "desc": "WCH CMSIS-DAP", "status": "OK"},
            {"instance": "USB\\VID_1A86&PID_8012\\98688F061E06",
             "vid": "1a86", "pid": "8012", "suffix": "98688F061E06",
             "desc": "USB Composite Device", "status": "OK"},
        ]
        with mock.patch.object(usb_devices, "_run_powershell", return_value=rows):
            out = usb_devices._via_wmi()
        self.assertEqual(len(out), 2)
        serials = {d["serial"] for d in out}
        self.assertIn("002B00313031510537363237", serials)
        self.assertIn("98688F061E06", serials)


class EnumerateTest(unittest.TestCase):
    def test_two_same_type_devices_have_distinct_serials(self):
        raw = [
            dev("c251", "f00a", "002B00313031510537363237", "H7-TOOL CMSIS-DAP"),
            dev("1a86", "8012", "98688F061E06", "WCH-Link"),
        ]
        with mock.patch.object(usb_devices, "_enumerate_raw", return_value=(raw, "wmi")):
            out = usb_devices.enumerate_devices(include_all=True)
        self.assertEqual(out["method"], "wmi")
        self.assertEqual(out["count"], 2)
        self.assertEqual(out["total"], 2)
        serials = [d["serial"] for d in out["supported"]]
        self.assertEqual(len(set(serials)), 2)   # 两个设备靠序列号区分
        for d in out["supported"]:
            self.assertTrue(d["supported"])
            self.assertIn("iface", d)
            self.assertIn("key", d)

    def test_default_hides_others(self):
        raw = [dev("c251", "f00a", "AAA", "H7-TOOL"),
               dev("dead", "beef", "", "USB Mouse")]
        with mock.patch.object(usb_devices, "_enumerate_raw", return_value=(raw, "wmi")):
            out = usb_devices.enumerate_devices()
        self.assertNotIn("others", out)
        self.assertEqual(out["count"], 1)

    def test_no_devices(self):
        with mock.patch.object(usb_devices, "_enumerate_raw", return_value=([], "wmi")):
            out = usb_devices.enumerate_devices()
        self.assertTrue(out["ok"])
        self.assertEqual(out["count"], 0)
        self.assertEqual(out["supported"], [])

    def test_unavailable_backend_is_graceful(self):
        with mock.patch.object(usb_devices, "_enumerate_raw", return_value=([], "unavailable")):
            out = usb_devices.enumerate_devices()
        self.assertFalse(out["available"])
        self.assertTrue(out["ok"])          # 不抛异常
        self.assertIn("error", out)
        self.assertEqual(out["supported"], [])

    def test_name_hint_only_device(self):
        raw = [dev("9999", "0001", "XYZ", "My CMSIS-DAP Probe")]
        with mock.patch.object(usb_devices, "_enumerate_raw", return_value=(raw, "sysfs")):
            out = usb_devices.enumerate_devices()
        self.assertEqual(out["count"], 1)
        self.assertEqual(out["supported"][0]["backend"], "cmsis-dap")


class HidEnumerateTest(unittest.TestCase):
    """HID 列表：不依赖真实 HID 硬件，用假 WMI 行打桩。"""

    @staticmethod
    def hid(vid, pid, serial="", name="", instance="", hid_class="HIDClass"):
        return {"vid": vid, "pid": pid, "serial": serial, "name": name,
                "status": "OK", "instance": instance, "hid_class": hid_class,
                "is_collection": "&COL" in instance.upper(),
                "composite": "&MI_" in instance.upper()}

    def test_known_h7tool_and_plain_keyboard(self):
        raw = [
            self.hid("c251", "f00a", "7&682BCBB&0&0000",
                     "符合 HID 标准的供应商定义设备",
                     "HID\\VID_C251&PID_F00A&MI_01\\7&682BCBB&0&0000"),
            self.hid("258a", "0049", "9&10526D0D&0&0004", "HID Keyboard Device",
                     "HID\\VID_258A&PID_0049&MI_01&COL05\\9&10526D0D&0&0004",
                     "Keyboard"),
        ]
        with mock.patch.object(usb_devices, "_enumerate_hid_raw",
                               return_value=(raw, "wmi")):
            out = usb_devices.enumerate_hid()
        self.assertTrue(out["ok"])
        self.assertTrue(out["available"])
        self.assertEqual(out["method"], "wmi")
        self.assertEqual(out["count"], 2)
        self.assertEqual(out["debugger_count"], 1)
        h7 = out["devices"][0]
        self.assertTrue(h7["known"])
        self.assertEqual(h7["debugger"], "H7-TOOL CMSIS-DAP")
        self.assertEqual(h7["iface"], "cmsis-dap-v1.cfg")
        self.assertEqual(h7["transport"], "HID")
        self.assertIn("key", h7)
        kb = out["devices"][1]
        self.assertFalse(kb["known"])
        self.assertEqual(kb["hid_class"], "Keyboard")
        self.assertTrue(kb["is_collection"])

    def test_no_devices(self):
        with mock.patch.object(usb_devices, "_enumerate_hid_raw",
                               return_value=([], "wmi")):
            out = usb_devices.enumerate_hid()
        self.assertTrue(out["ok"])
        self.assertEqual(out["count"], 0)
        self.assertEqual(out["debugger_count"], 0)
        self.assertEqual(out["devices"], [])

    def test_unavailable_backend_is_graceful(self):
        with mock.patch.object(usb_devices, "_enumerate_hid_raw",
                               return_value=([], "unavailable")):
            out = usb_devices.enumerate_hid()
        self.assertFalse(out["available"])
        self.assertTrue(out["ok"])
        self.assertIn("error", out)
        self.assertEqual(out["devices"], [])


if __name__ == "__main__":
    unittest.main()
