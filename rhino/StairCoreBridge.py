# -*- coding: utf-8 -*-
"""Stair Core Tool ↔ Rhino 桥接脚本（在 Rhino 里运行一次即可，之后一直在后台监听）。

用法：Rhino 命令行输入 ScriptEditor（Rhino 8）或 EditPythonScript（Rhino 7），打开本文件，运行。
      运行后 Rhino 命令行会打印 "StairCore bridge listening on http://127.0.0.1:8790"。
      回到网页的核心筒计算器，"Rhino" 面板点「连接 Rhino」，再点「发送到 Rhino」。

做什么：在本机 127.0.0.1:8790 起一个很小的 HTTP 服务（只监听本机、只接受本机网页和项目的 GitHub Pages 页面的请求）：
  GET  /health → {"ok":true, "rhino":"8.x", "doc":"...", "units":"Millimeters"}
  POST /bake   → 收网页算好的盒子列表（毫米，z 朝上：踏步 / 平台 / 墙 / 门 / 楼板，带楼梯编号），
                 在 StairCore::<名字>::<类别> 图层上烘焙成 Brep 实体，按楼梯编号上色，同名的上一批先删掉（可选）。
几何全部由网页端算好（和网页里的三维模型是同一份数据），这里只负责"盒子 → Brep"和图层/颜色，不做任何规范计算。

兼容 Rhino 8（CPython 3）和 Rhino 7（IronPython 2.7）：不用 f-string，HTTP 模块按版本导入。
"""
import json
import threading

import Rhino
import System
import scriptcontext as sc

try:  # Python 3 (Rhino 8)
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from socketserver import ThreadingMixIn
except ImportError:  # IronPython 2.7 (Rhino 7)
    from BaseHTTPServer import BaseHTTPRequestHandler, HTTPServer
    from SocketServer import ThreadingMixIn

PORT = 8790
STICKY_KEY = "stair_core_bridge_server"
# 允许调用的网页来源：本机开发服务器 / 本机静态文件，以及项目的 GitHub Pages 线上版
ALLOWED_ORIGIN_PREFIXES = ("http://localhost:", "http://127.0.0.1:", "http://localhost", "http://127.0.0.1", "https://jiangpresident.github.io")
STAIR_COLORS = ["#2B5C8A", "#C0703A", "#3E8E6E", "#8A5CB0", "#B8862B", "#5C7F99"]
KIND_COLORS = {"slab": "#C3CCD4", "door": "#E2A33C", "centerWall": "#8E9AA6", "wall": "#9AA6B2"}


def hex_color(h):
    h = h.lstrip("#")
    return System.Drawing.Color.FromArgb(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def ensure_layer(doc, path_parts, color=None):
    """按 ["StairCore", "名字", "step"] 这样的层级确保图层存在，返回图层索引。"""
    parent_id = System.Guid.Empty
    index = -1
    full = ""
    for part in path_parts:
        full = part if not full else full + "::" + part
        index = doc.Layers.FindByFullPath(full, -1)
        if index < 0:
            layer = Rhino.DocObjects.Layer()
            layer.Name = part
            if parent_id != System.Guid.Empty:
                layer.ParentLayerId = parent_id
            if color is not None:
                layer.Color = color
            index = doc.Layers.Add(layer)
        parent_id = doc.Layers[index].Id
    return index


def bake(payload):
    """在 UI 线程里执行：盒子 → Brep。返回 {"added": n, "layers": [...]}。"""
    doc = Rhino.RhinoDoc.ActiveDoc
    name = str(payload.get("name") or "StairCore")
    boxes = payload.get("boxes") or []
    origin = payload.get("origin") or {}
    ox, oy, oz = float(origin.get("x", 0)), float(origin.get("y", 0)), float(origin.get("z", 0))
    # 网页端一律毫米；换算到当前文档单位
    scale = Rhino.RhinoMath.UnitScale(Rhino.UnitSystem.Millimeters, doc.ModelUnitSystem)
    base_index = ensure_layer(doc, ["StairCore", name])
    if payload.get("replace", True):
        # 删掉这个名字下所有子图层上的旧对象（同一批重复发送时不堆叠）
        for obj in list(doc.Objects.FindByLayer(doc.Layers[base_index])):
            doc.Objects.Delete(obj, True)
        for layer in list(doc.Layers):
            if layer.IsDeleted:
                continue
            if layer.ParentLayerId == doc.Layers[base_index].Id:
                for obj in list(doc.Objects.FindByLayer(layer)):
                    doc.Objects.Delete(obj, True)
    group_index = doc.Groups.Add(name + " " + System.DateTime.Now.ToString("HH:mm:ss"))
    added = 0
    layers_used = set()
    for b in boxes:
        kind = str(b.get("kind") or "box")
        stair = int(b.get("stair") or 0)
        x1, x2 = (float(b["x1"]) + ox) * scale, (float(b["x2"]) + ox) * scale
        y1, y2 = (float(b["y1"]) + oy) * scale, (float(b["y2"]) + oy) * scale
        z1, z2 = (float(b["z1"]) + oz) * scale, (float(b["z2"]) + oz) * scale
        if abs(x2 - x1) < 1e-9 or abs(y2 - y1) < 1e-9 or abs(z2 - z1) < 1e-9:
            continue
        box = Rhino.Geometry.Box(Rhino.Geometry.Plane.WorldXY, Rhino.Geometry.Interval(min(x1, x2), max(x1, x2)), Rhino.Geometry.Interval(min(y1, y2), max(y1, y2)), Rhino.Geometry.Interval(min(z1, z2), max(z1, z2)))
        brep = box.ToBrep()
        if brep is None:
            continue
        if kind in ("step", "landing") and stair > 0:
            color = hex_color(STAIR_COLORS[(stair - 1) % len(STAIR_COLORS)])
            if kind == "landing":
                color = System.Drawing.Color.FromArgb(min(255, color.R + 60), min(255, color.G + 60), min(255, color.B + 60))
            layer_name = kind + " #" + str(stair)
        else:
            color = hex_color(KIND_COLORS.get(kind, "#9AA6B2"))
            layer_name = kind
        layer_index = ensure_layer(doc, ["StairCore", name, layer_name], color)
        layers_used.add("StairCore::" + name + "::" + layer_name)
        attr = Rhino.DocObjects.ObjectAttributes()
        attr.LayerIndex = layer_index
        attr.ColorSource = Rhino.DocObjects.ObjectColorSource.ColorFromObject
        attr.ObjectColor = color
        attr.Name = layer_name
        attr.AddToGroup(group_index)
        if doc.Objects.AddBrep(brep, attr) != System.Guid.Empty:
            added += 1
    doc.Views.Redraw()
    return {"ok": True, "added": added, "layers": sorted(layers_used), "units": str(doc.ModelUnitSystem)}


def run_on_ui_thread(fn):
    """HTTP 线程里不能动文档，交给 Rhino 主线程执行并等结果。"""
    result = {}
    done = threading.Event()

    def wrapper():
        try:
            result["value"] = fn()
        except Exception as exc:  # noqa: BLE001
            result["error"] = str(exc)
        finally:
            done.set()

    Rhino.RhinoApp.InvokeOnUiThread(System.Action(wrapper))
    done.wait(60)
    if "error" in result:
        raise RuntimeError(result["error"])
    if "value" not in result:
        raise RuntimeError("Rhino main thread did not respond within 60 s")
    return result["value"]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 不刷屏
        pass

    def _origin_ok(self):
        origin = self.headers.get("Origin") or ""
        return (not origin) or any(origin.startswith(p) for p in ALLOWED_ORIGIN_PREFIXES)

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        origin = self.headers.get("Origin") or ""
        if origin and self._origin_ok():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        if not self._origin_ok():
            self._send(403, {"ok": False, "error": "origin not allowed"})
            return
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if not self._origin_ok():
            self._send(403, {"ok": False, "error": "origin not allowed"})
            return
        if self.path.split("?")[0] == "/health":
            doc = Rhino.RhinoDoc.ActiveDoc
            self._send(200, {
                "ok": True,
                "app": "rhino",
                "rhino": str(Rhino.RhinoApp.Version),
                "doc": (doc.Name or "Untitled") if doc else None,
                "units": str(doc.ModelUnitSystem) if doc else None,
            })
            return
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self._origin_ok():
            self._send(403, {"ok": False, "error": "origin not allowed"})
            return
        if self.path.split("?")[0] != "/bake":
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            if not isinstance(payload, dict) or not isinstance(payload.get("boxes"), list):
                self._send(400, {"ok": False, "error": "payload must contain a boxes array"})
                return
            if str(payload.get("units", "mm")).lower() != "mm":
                self._send(400, {"ok": False, "error": "units must be mm"})
                return
            self._send(200, run_on_ui_thread(lambda: bake(payload)))
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"ok": False, "error": str(exc)})


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def start():
    existing = sc.sticky.get(STICKY_KEY)
    if existing is not None:
        print("StairCore bridge already listening on http://127.0.0.1:%d" % PORT)
        return existing
    server = Server(("127.0.0.1", PORT), Handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.daemon = True
    thread.start()
    sc.sticky[STICKY_KEY] = server
    print("StairCore bridge listening on http://127.0.0.1:%d  (health: /health, bake: POST /bake)" % PORT)
    return server


def stop():
    server = sc.sticky.pop(STICKY_KEY, None)
    if server is not None:
        server.shutdown()
        server.server_close()
        print("StairCore bridge stopped")


if __name__ == "__main__":
    start()
