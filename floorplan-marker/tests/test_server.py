"""Local server and image-ingestion regression checks.

Run from the project folder: python -m unittest discover -s tests -v
These tests open only an ephemeral loopback port and never use a remote service.
The detector is stubbed to isolate HTTP/schema behavior from vision accuracy.
"""
from __future__ import annotations

import base64
import contextlib
import http.client
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def data_url(image, format='PNG', **save_options):
    buffer = io.BytesIO()
    image.save(buffer, format=format, **save_options)
    return 'data:image/' + format.lower() + ';base64,' + base64.b64encode(buffer.getvalue()).decode('ascii')


class ImageIngestionTests(unittest.TestCase):
    def test_transparent_pixels_are_composited_on_white(self):
        image = Image.new('RGBA', (32, 24), (0, 0, 0, 0))
        image.putpixel((1, 1), (0, 0, 0, 255))
        image.putpixel((2, 2), (0, 0, 0, 128))
        decoded = server.decode_image(data_url(image))
        self.assertEqual(decoded.mode, 'RGB')
        self.assertEqual(decoded.getpixel((0, 0)), (255, 255, 255))
        self.assertEqual(decoded.getpixel((1, 1)), (0, 0, 0))
        self.assertEqual(decoded.getpixel((2, 2)), (127, 127, 127))

    def test_palette_transparency_is_composited(self):
        image = Image.new('P', (16, 16), 0)
        image.putpalette([0, 0, 0, 255, 0, 0] + [0] * 762)
        image.putpixel((1, 1), 1)
        decoded = server.decode_image(data_url(image, transparency=0))
        self.assertEqual(decoded.getpixel((0, 0)), (255, 255, 255))
        self.assertEqual(decoded.getpixel((1, 1)), (255, 0, 0))

    def test_exif_orientation_is_applied(self):
        image = Image.new('RGB', (24, 40), 'white')
        exif = Image.Exif()
        exif[274] = 6  # rotate 90 degrees clockwise for display
        decoded = server.decode_image(data_url(image, 'JPEG', exif=exif))
        self.assertEqual(decoded.size, (40, 24))

    def test_supported_formats(self):
        for format in ('PNG', 'JPEG', 'BMP', 'WEBP'):
            with self.subTest(format=format):
                decoded = server.decode_image(data_url(Image.new('RGB', (20, 30), 'white'), format))
                self.assertEqual(decoded.size, (20, 30))

    def test_invalid_input_fails_cleanly(self):
        for value in (None, 12, {}, '', 'https://example.org/a.png',
                      'data:image/png,abcd', 'data:image/png;base64,??',
                      'data:image/png;base64,aGVsbG8='):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    server.decode_image(value)

    def test_unsupported_raster_format_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'PNG, JPEG, WebP or BMP'):
            server.decode_image(data_url(Image.new('RGB', (32, 32)), 'GIF'))

    def test_minimum_dimensions(self):
        with self.assertRaisesRegex(ValueError, 'too small'):
            server.decode_image(data_url(Image.new('RGB', (15, 32))))
        self.assertEqual(server.decode_image(data_url(Image.new('RGB', (16, 16)))).size, (16, 16))

    def test_pixel_limit_before_expensive_conversion(self):
        # Reduce the constant so the test does not allocate a 24-megapixel image.
        with mock.patch.object(server, 'MAX_PIXELS', 1024):
            with self.assertRaisesRegex(ValueError, '24 million'):
                server.decode_image(data_url(Image.new('RGB', (33, 32))))

    def test_encoded_payload_limit(self):
        with mock.patch.object(server, 'MAX_BODY', 10):
            with self.assertRaisesRegex(ValueError, 'too large'):
                server.decode_image('data:image/png;base64,' + 'A' * 12)


class OptionValidationTests(unittest.TestCase):
    def test_defaults_and_boundaries(self):
        self.assertEqual(server.validate_options(None), {})
        self.assertEqual(server.validate_options({}), {})
        value = {'threshold': 30, 'min_wall_length': 500, 'bridge_gap': 0, 'sensitivity': 1}
        self.assertEqual(server.validate_options(value), value)

    def test_rejects_non_objects_and_unknown_keys(self):
        for value in ([], '', False, {'arbitrary_option': 1}):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    server.validate_options(value)

    def test_rejects_nonfinite_nonnumeric_and_out_of_range_values(self):
        for value in (float('nan'), float('inf'), -float('inf'), True, '120', None, 29, 251, 10**500):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    server.validate_options({'threshold': value})


class LocalHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(cls.temp.name)
        (root / 'static').mkdir()
        (root / 'static' / 'index.html').write_text('<title>Local test</title>', encoding='utf-8')
        (root / 'static' / 'app.js').write_text('const test = true;', encoding='utf-8')
        (root / 'secret.txt').write_text('must not be exposed', encoding='utf-8')
        cls.root_patch = mock.patch.object(server, 'ROOT', root)
        cls.root_patch.start()
        cls.log_patch = mock.patch.object(server.Handler, 'log_message', lambda *_args: None)
        cls.log_patch.start()
        cls.httpd = server.make_server(0)
        cls.port = cls.httpd.server_port
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.valid_image = data_url(Image.new('RGB', (32, 24), 'white'))

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=2)
        cls.log_patch.stop()
        cls.root_patch.stop()
        cls.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def post(self, value, headers=None):
        combined = {'Content-Type': 'application/json'}
        combined.update(headers or {})
        return self.request('POST', '/api/detect', json.dumps(value), combined)

    def assert_error(self, response, status):
        code, headers, body = response
        self.assertEqual(code, status, body.decode('utf-8', errors='replace'))
        self.assertIn('application/json', headers['Content-Type'])
        self.assertTrue(json.loads(body).get('error'))

    def assert_detector_lock_released(self):
        # The client can finish reading just before the server reaches finally.
        acquired = self.httpd.detect_lock.acquire(timeout=1)
        self.assertTrue(acquired, 'Detection lock was not released after the response.')
        if acquired:
            self.httpd.detect_lock.release()

    def test_health_reports_local_engine(self):
        code, headers, body = self.request('GET', '/api/health')
        self.assertEqual(code, 200)
        info = json.loads(body)
        self.assertTrue(info['ok'])
        self.assertFalse(info['external_requests'])
        self.assertEqual(info['engine'], 'local-heuristic')
        self.assertEqual(headers['Cache-Control'], 'no-store')

    def test_static_content_and_mime(self):
        code, headers, body = self.request('GET', '/?test=1')
        self.assertEqual(code, 200)
        self.assertEqual(body, b'<title>Local test</title>')
        self.assertIn('text/html', headers['Content-Type'])
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        code, headers, _ = self.request('GET', '/app.js')
        self.assertEqual(code, 200)
        self.assertIn('text/javascript', headers['Content-Type'])

    def test_missing_route_or_file_and_path_traversal(self):
        for path in ('/missing', '/style.css', '/../secret.txt', '/%2e%2e/secret.txt', '/server.py'):
            with self.subTest(path=path):
                self.assert_error(self.request('GET', path), 404)

    def test_invalid_host_denied(self):
        for method in ('GET', 'POST'):
            with self.subTest(method=method):
                self.assert_error(self.request(method, '/api/health', headers={'Host': 'attacker.example'}), 403)

    def test_localhost_alias_allowed(self):
        response = self.request('GET', '/api/health', headers={'Host': f'localhost:{self.port}'})
        self.assertEqual(response[0], 200)

    def test_cross_origin_post_denied(self):
        self.assert_error(self.post({'image': self.valid_image}, {'Origin': 'https://example.org'}), 403)

    def test_loopback_other_port_origin_allowed_with_cors(self):
        # stair-core 平面图工具跑在本机另一个端口（如 localhost:5173），要能跨源调用 /api/detect
        for origin in ('http://localhost:5173', 'http://127.0.0.1:4173'):
            with self.subTest(origin=origin):
                code, headers, body = self.post({'image': self.valid_image}, {'Origin': origin})
                self.assertEqual(code, 200, body.decode('utf-8', errors='replace'))
                self.assertEqual(headers.get('Access-Control-Allow-Origin'), origin)
                self.assertIn('walls', json.loads(body))

    def test_preflight_allows_loopback_only(self):
        code, headers, _ = self.request('OPTIONS', '/api/detect', headers={
            'Origin': 'http://localhost:5173', 'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type'})
        self.assertEqual(code, 204)
        self.assertEqual(headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173')
        self.assertIn('POST', headers.get('Access-Control-Allow-Methods', ''))
        self.assertIn('Content-Type', headers.get('Access-Control-Allow-Headers', ''))
        self.assert_error(self.request('OPTIONS', '/api/detect', headers={'Origin': 'https://example.org'}), 403)
        self.assert_error(self.request('OPTIONS', '/api/detect', headers={'Origin': 'http://localhost.evil.example:5173'}), 403)

    def test_foreign_origin_gets_no_cors_header(self):
        code, headers, _ = self.request('GET', '/api/health', headers={'Origin': 'https://example.org'})
        self.assertEqual(code, 200)
        self.assertIsNone(headers.get('Access-Control-Allow-Origin'))

    def test_unknown_post_route(self):
        self.assert_error(self.request('POST', '/elsewhere', '{}', {'Content-Type': 'application/json'}), 404)

    def test_post_requires_json(self):
        self.assert_error(self.request('POST', '/api/detect', '{}', {'Content-Type': 'text/plain'}), 415)

    def test_empty_and_oversized_requests(self):
        self.assert_error(self.request('POST', '/api/detect', '', {'Content-Type': 'application/json'}), 413)
        self.assert_error(self.request('POST', '/api/detect', b'{}', {
            'Content-Type': 'application/json', 'Content-Length': str(server.MAX_BODY + 1)}), 413)

    def test_invalid_content_length(self):
        self.assert_error(self.request('POST', '/api/detect', b'{}', {
            'Content-Type': 'application/json', 'Content-Length': 'invalid'}), 400)

    def test_malformed_json_and_wrong_shape(self):
        self.assert_error(self.request('POST', '/api/detect', '{', {'Content-Type': 'application/json'}), 400)
        for value in ([], 3, None, {}, {'image': 'not-an-image'}, {'image': self.valid_image, 'options': []}):
            with self.subTest(value=value):
                self.assert_error(self.post(value), 400)

    def test_huge_json_option_is_rejected_without_dropping_connection(self):
        self.assert_error(self.post({'image': self.valid_image, 'options': {'threshold': 10**500}}), 400)

    def test_busy_detector_returns_retryable_error(self):
        self.httpd.detect_lock.acquire()
        try:
            self.assert_error(self.post({'image': self.valid_image}), 429)
        finally:
            self.httpd.detect_lock.release()

    def test_detection_result_uses_decoded_image_dimensions(self):
        def fake_detect(image, options):
            self.assertEqual(image.mode, 'RGB')
            self.assertEqual(options, {'threshold': 150})
            return {'walls': [], 'doors': [], 'windows': [], 'stairs': [], 'width': 999, 'height': 999}
        fake_module = types.SimpleNamespace(detect=fake_detect)
        with mock.patch.dict(sys.modules, {'detector': fake_module}):
            code, _, body = self.post({'image': self.valid_image, 'options': {'threshold': 150}},
                                      {'Origin': f'http://127.0.0.1:{self.port}'})
        self.assertEqual(code, 200, body)
        result = json.loads(body)
        self.assertEqual((result['width'], result['height']), (32, 24))
        self.assert_detector_lock_released()

    def test_detection_exception_returns_json_and_releases_lock(self):
        fake_module = types.SimpleNamespace(detect=mock.Mock(side_effect=RuntimeError('test failure')))
        with mock.patch.dict(sys.modules, {'detector': fake_module}), contextlib.redirect_stdout(io.StringIO()):
            self.assert_error(self.post({'image': self.valid_image}), 500)
        self.assert_detector_lock_released()


if __name__ == '__main__':
    unittest.main()
