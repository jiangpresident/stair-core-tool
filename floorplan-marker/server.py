"""Local-only HTTP application. No external services or image uploads.

Run: python server.py --open
The static editor performs all project/PNG/SVG export in the browser.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import io
import json
import math
import re
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

try:
    from PIL import Image, ImageOps, UnidentifiedImageError
    import numpy  # dependency check before opening browser
    import cv2
except ImportError as exc:
    raise SystemExit('Missing dependency. Run: python -m pip install -r requirements.txt\n' + str(exc))

ROOT = Path(__file__).resolve().parent
MAX_BODY = 30 * 1024 * 1024
MAX_PIXELS = 24_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
VERSION = '0.1.0'


def decode_image(data_url: str) -> Image.Image:
    if not isinstance(data_url, str) or not data_url.startswith('data:image/'):
        raise ValueError('Expected a raster image data URL.')
    header, separator, encoded = data_url.partition(',')
    if not separator or ';base64' not in header:
        raise ValueError('Expected a base64-encoded image.')
    if len(encoded) > MAX_BODY:
        raise ValueError('Image file is too large (maximum 20 MB).')
    try:
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > 20 * 1024 * 1024:
            raise ValueError('Image file is too large (maximum 20 MB).')
        with Image.open(io.BytesIO(raw)) as original:
            if original.format not in {'PNG', 'JPEG', 'WEBP', 'BMP'}:
                raise ValueError('Use PNG, JPEG, WebP or BMP.')
            if original.width * original.height > MAX_PIXELS:
                raise ValueError('Image exceeds 24 million pixels. Resize it first.')
            if min(original.size) < 16:
                raise ValueError('Image is too small (minimum 16 pixels on each side).')
            upright = ImageOps.exif_transpose(original).convert('RGBA')
            background = Image.new('RGBA', upright.size, 'white')
            background.alpha_composite(upright)
            return background.convert('RGB')
    except (binascii.Error, UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError('Invalid or unsupported image.') from exc


def validate_options(value: object) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError('options must be an object.')
    ranges = {'threshold': (30, 250), 'min_wall_length': (8, 500),
              'bridge_gap': (0, 80), 'sensitivity': (0, 1)}
    result = {}
    for key, item in value.items():
        if key not in ranges:
            raise ValueError(f'Unknown option: {key}')
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise ValueError(f'{key} must be a finite number.')
        low, high = ranges[key]
        if not low <= item <= high:
            raise ValueError(f'{key} must be between {low} and {high}.')
        if not math.isfinite(item):
            raise ValueError(f'{key} must be a finite number.')
        result[key] = item
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = 'FloorplanMarker/0.1'

    def log_message(self, fmt, *args):
        # Do not log user-supplied image data.
        print(f'[{time.strftime("%H:%M:%S")}] {fmt % args}')

    def reply(self, code, content, mime='application/json; charset=utf-8'):
        if isinstance(content, (dict, list)):
            content = json.dumps(content, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if isinstance(content, str):
            content = content.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        origin = self.loopback_origin()
        if origin:
            # 只对本机其它端口上的页面（比如 stair-core 平面图工具的 localhost:5173）放行跨源读取；
            # 非本机来源仍然一律拒绝，服务器本身也只监听 127.0.0.1。
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.end_headers()
        try:
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def allowed_host(self):
        host = self.headers.get('Host', '')
        return host in {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}

    def loopback_origin(self):
        """Return the request Origin if it is a loopback page (any port), else None."""
        origin = self.headers.get('Origin', '')
        if re.fullmatch(r'http://(127\.0\.0\.1|localhost)(:\d{1,5})?', origin):
            return origin
        return None

    def do_OPTIONS(self):
        # CORS 预检：本机其它端口的页面用 application/json POST /api/detect 时浏览器会先发 OPTIONS
        if not self.allowed_host() or not self.loopback_origin():
            self.reply(403, {'error': 'Cross-origin requests are not accepted.'})
            return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', self.loopback_origin())
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Vary', 'Origin')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if not self.allowed_host():
            self.reply(403, {'error': 'Use the printed localhost URL.'})
            return
        path = urlparse(self.path).path
        if path == '/api/health':
            self.reply(200, {'ok': True, 'version': VERSION, 'engine': 'local-heuristic', 'external_requests': False})
            return
        routes = {
            '/': (ROOT / 'static/index.html', 'text/html; charset=utf-8'),
            '/index.html': (ROOT / 'static/index.html', 'text/html; charset=utf-8'),
            '/app.js': (ROOT / 'static/app.js', 'text/javascript; charset=utf-8'),
            '/style.css': (ROOT / 'static/style.css', 'text/css; charset=utf-8'),
            '/static/app.js': (ROOT / 'static/app.js', 'text/javascript; charset=utf-8'),
            '/static/style.css': (ROOT / 'static/style.css', 'text/css; charset=utf-8'),
            '/example.png': (ROOT / 'examples/example.png', 'image/png'),
        }
        if path not in routes:
            self.reply(404, {'error': 'Not found.'})
            return
        file, mime = routes[path]
        try:
            self.reply(200, file.read_bytes(), mime)
        except OSError:
            self.reply(404, {'error': 'File not available.'})

    def do_POST(self):
        if not self.allowed_host():
            self.reply(403, {'error': 'Invalid host.'})
            return
        origin = self.headers.get('Origin')
        if origin and not self.loopback_origin():
            self.reply(403, {'error': 'Cross-origin requests are not accepted.'})
            return
        if urlparse(self.path).path != '/api/detect':
            self.reply(404, {'error': 'Not found.'})
            return
        if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
            self.reply(415, {'error': 'Content-Type must be application/json.'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 1 or length > MAX_BODY:
                self.reply(413, {'error': 'Request is empty or too large (maximum 30 MB).'})
                return
            self.connection.settimeout(30)
            body = self.rfile.read(length)
            request = json.loads(body)
            if not isinstance(request, dict):
                raise ValueError('Request must be an object.')
            options = validate_options(request.get('options'))
            image = decode_image(request.get('image'))
        except (ValueError, TypeError, TimeoutError) as exc:
            self.reply(400, {'error': str(exc)})
            return
        if not self.server.detect_lock.acquire(blocking=False):
            self.reply(429, {'error': 'Another image is being processed. Try again shortly.'})
            return
        try:
            from detector import detect
            result = detect(image, options)
            result['width'], result['height'] = image.size
            self.reply(200, result)
        except Exception as exc:
            print(f'Detection error: {type(exc).__name__}: {exc}')
            self.reply(500, {'error': 'Detection failed. Check the local terminal; manual editing is still available.'})
        finally:
            self.server.detect_lock.release()


def make_server(port=8765):
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    server.detect_lock = threading.Lock()
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--open', action='store_true', help='Open your default browser')
    args = parser.parse_args()
    try:
        server = make_server(args.port)
    except OSError as exc:
        raise SystemExit(f'Cannot start on port {args.port}: {exc}\nTry: python server.py --port 8766 --open')
    url = f'http://127.0.0.1:{server.server_port}'
    print(f'Floorplan Marker {VERSION}\nOpen: {url}\nLocal processing only. Ctrl+C to stop.', flush=True)
    if args.open:
        threading.Timer(.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
