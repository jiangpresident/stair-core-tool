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

try:  # URL 解码（图层名里可能有中文/空格/::）
    from urllib.parse import unquote as _unquote
except ImportError:
    from urllib import unquote as _unquote

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


def _footprint_points(geo):
    """把一个对象的几何压到 XY 平面，返回顶点列表（Point3d）。Brep / 挤出体 / 网格 / 封闭曲线都认。"""
    pts = []
    if isinstance(geo, Rhino.Geometry.Extrusion):
        geo = geo.ToBrep()
    if isinstance(geo, Rhino.Geometry.Brep):
        for v in geo.Vertices:
            pts.append(v.Location)
        if not pts:  # 没有显式顶点（比如圆柱）就用边上的采样点
            for e in geo.Edges:
                pts.append(e.PointAtStart)
                pts.append(e.PointAtEnd)
    elif isinstance(geo, Rhino.Geometry.Mesh):
        for v in geo.Vertices:
            pts.append(Rhino.Geometry.Point3d(v.X, v.Y, v.Z))
    elif isinstance(geo, Rhino.Geometry.Curve):
        ok, pl = geo.TryGetPolyline()
        if ok:
            pts = list(pl)
        else:
            n = 64
            for i in range(n + 1):
                pts.append(geo.PointAt(geo.Domain.ParameterAt(float(i) / n)))
    return pts


def _convex_hull_xy(points):
    """Andrew 单调链凸包（二维）。"""
    pts = sorted(set((round(p.X, 6), round(p.Y, 6)) for p in points))
    if len(pts) <= 2:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def _min_rect(points):
    """最小面积外接矩形（旋转卡壳：矩形的一条边一定和凸包某条边平行）。
    返回 (center_x, center_y, length, width, angle_deg)，length ≥ width，angle 是长边相对 X 轴的角度。"""
    import math
    hull = _convex_hull_xy(points)
    if len(hull) < 3:
        xs = [p[0] for p in hull] or [0.0]
        ys = [p[1] for p in hull] or [0.0]
        return ((min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0, max(xs) - min(xs), max(ys) - min(ys), 0.0)
    best = None
    for i in range(len(hull)):
        ax, ay = hull[i]
        bx, by = hull[(i + 1) % len(hull)]
        ang = math.atan2(by - ay, bx - ax)
        c, s = math.cos(-ang), math.sin(-ang)
        us = [(p[0] * c - p[1] * s, p[0] * s + p[1] * c) for p in hull]
        minu, maxu = min(u[0] for u in us), max(u[0] for u in us)
        minv, maxv = min(u[1] for u in us), max(u[1] for u in us)
        area = (maxu - minu) * (maxv - minv)
        if best is None or area < best[0] - 1e-9:
            cu, cv = (minu + maxu) / 2.0, (minv + maxv) / 2.0
            # 转回世界坐标
            cx = cu * math.cos(ang) - cv * math.sin(ang)
            cy = cu * math.sin(ang) + cv * math.cos(ang)
            best = (area, cx, cy, maxu - minu, maxv - minv, ang)
    _, cx, cy, du, dv, ang = best
    if du >= dv:
        length, width, a = du, dv, ang
    else:
        length, width, a = dv, du, ang + math.pi / 2
    deg = math.degrees(a) % 180.0
    return (cx, cy, length, width, deg)


def read_cores(layer_path):
    """UI 线程里执行：读某个图层（含子图层）上的长方体，返回毫米单位的平面外接矩形列表。"""
    doc = Rhino.RhinoDoc.ActiveDoc
    to_mm = Rhino.RhinoMath.UnitScale(doc.ModelUnitSystem, Rhino.UnitSystem.Millimeters)
    idx = doc.Layers.FindByFullPath(layer_path, -1)
    if idx < 0:
        return {"ok": False, "error": "layer not found: " + layer_path}
    wanted = set([doc.Layers[idx].Id])
    for layer in doc.Layers:
        if not layer.IsDeleted and layer.ParentLayerId in wanted:
            wanted.add(layer.Id)
    out = []
    for obj in doc.Objects:
        if obj.Attributes.LayerIndex < 0 or doc.Layers[obj.Attributes.LayerIndex].Id not in wanted:
            continue
        geo = obj.Geometry
        pts = _footprint_points(geo)
        if len(pts) < 3:
            continue
        cx, cy, length, width, deg = _min_rect(pts)
        bb = geo.GetBoundingBox(True)
        out.append({
            "id": str(obj.Id),
            "name": obj.Attributes.Name or "",
            "layer": doc.Layers[obj.Attributes.LayerIndex].FullPath,
            "type": geo.GetType().Name,
            "centerX": cx * to_mm, "centerY": cy * to_mm,
            "length": length * to_mm, "width": width * to_mm, "angleDeg": deg,
            "zBottom": bb.Min.Z * to_mm, "height": (bb.Max.Z - bb.Min.Z) * to_mm,
        })
    return {"ok": True, "layer": layer_path, "units": str(doc.ModelUnitSystem), "cores": out}


def list_layers():
    doc = Rhino.RhinoDoc.ActiveDoc
    names = []
    for layer in doc.Layers:
        if layer.IsDeleted:
            continue
        count = len(list(doc.Objects.FindByLayer(layer)))
        names.append({"path": layer.FullPath, "objects": count})
    return {"ok": True, "layers": names}


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
        path, _, query = self.path.partition("?")
        if path == "/health":
            doc = Rhino.RhinoDoc.ActiveDoc
            self._send(200, {
                "ok": True,
                "app": "rhino",
                "rhino": str(Rhino.RhinoApp.Version),
                "doc": (doc.Name or "Untitled") if doc else None,
                "units": str(doc.ModelUnitSystem) if doc else None,
                "features": ["bake", "layers", "cores"],
            })
            return
        try:
            if path == "/layers":
                self._send(200, run_on_ui_thread(list_layers))
                return
            if path == "/cores":
                # ?layer=Core 或 ?layer=Parent::Child（URL 编码）
                params = {}
                for part in query.split("&"):
                    if "=" in part:
                        k, v = part.split("=", 1)
                        params[k] = _unquote(v)
                layer = params.get("layer") or "Core"
                result = run_on_ui_thread(lambda: read_cores(layer))
                self._send(200 if result.get("ok") else 404, result)
                return
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"ok": False, "error": str(exc)})
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
