"""
PATCH cho io_EDM/edm/types.py

Mục đích:
  - Chẩn đoán lỗi `KeyError: 'model::RootNode'` xảy ra khi đọc materials
  - In ra vị trí byte + hex dump ngay tại điểm lỗi để xác định cấu trúc file
  - Tự bỏ qua entry lạ thay vì crash (cho phép import tiếp phần còn lại)
  - Bổ sung một số material entry mà DCS World mới có thể dùng

CÁCH ÁP DỤNG:
  1. Mở file:
       C:\\Users\\Admin\\AppData\\Roaming\\Blender Foundation\\Blender\\2.79\\scripts\\addons\\io_EDM\\edm\\types.py
  2. THAY hai chỗ sau bằng nội dung trong file này:
       - Khối `_material_entry_lookup = { ... }` (khoảng dòng 727-739)
       - Phương thức `Material.read` (khoảng dòng 783-793)
  3. Mở file Blender, thử Import lại -> xem cửa sổ Console hệ thống
       (Window -> Toggle System Console)
"""

# ============================================================
# 1) BẢNG TRA MATERIAL ENTRY — bổ sung các loại có thể có
# ============================================================
_material_entry_lookup = {
    "BLENDING":                     lambda x: x.read_uchar(),
    "CULLING":                      lambda x: x.read_uchar(),
    "DEPTH_BIAS":                   lambda x: x.read_uint(),
    "TEXTURE_COORDINATES_CHANNELS": _read_texture_coordinates_channels,
    "MATERIAL_NAME":                lambda x: x.read_string(),
    "NAME":                         lambda x: x.read_string(),
    "SHADOWS":                      lambda x: ShadowSettings(x.read_uchar()),
    "VERTEX_FORMAT":                _read_material_VertexFormat,
    "UNIFORMS":                     read_propertyset,
    "ANIMATED_UNIFORMS":            _read_animateduniforms,
    "TEXTURES":                     lambda x: x.read_list(_read_material_texture),

    # --- Các entry quan sát thấy trong EDM mới (bổ sung phòng hờ) ---
    # Nếu file của bạn dùng các tên khác, hex dump sẽ cho biết.
    "TWO_SIDED":                    lambda x: x.read_uchar(),
    "DECAL":                        lambda x: x.read_uchar(),
    "OPACITY":                      lambda x: x.read_float(),
    "DRAW_DEPTH":                   lambda x: x.read_uchar(),
}


# ============================================================
# 2) Material.read — phiên bản có DEBUG + fail-safe
# ============================================================
class Material(object):
    def __init__(self):
        self.blending = 0
        self.culling = 0
        self.depth_bias = 0
        self.texture_coordinates_channels = None
        self.material_name = ""
        self.name = ""
        self.shadows = ShadowSettings()
        self.vertex_format = None
        self.uniforms = {}
        self.animated_uniforms = {}
        self.textures = []

    @classmethod
    def read(cls, stream):
        self = cls()
        props = OrderedDict()

        start_pos = stream.tell()
        count = stream.read_uint()

        # ---- Sanity check số lượng property ----
        # Material bình thường có 6-12 entries. > 64 chắc chắn sai.
        if count > 64:
            print("=" * 70)
            print("[EDM-DEBUG] Số lượng property bất thường: {}".format(count))
            print("[EDM-DEBUG] Đọc từ vị trí byte: 0x{:X} ({} dec)".format(
                start_pos, start_pos))
            _hex_dump_around(stream, start_pos, before=32, after=64)
            print("=" * 70)
            raise IOError(
                "Material property count = {} (>64). "
                "File EDM có vẻ lệch vị trí — cấu trúc RootNode "
                "có thể có field mới chưa được parse.".format(count)
            )

        for i in range(count):
            name_pos = stream.tell()
            try:
                name = stream.read_string()
            except Exception as e:
                print("[EDM-DEBUG] Đọc tên property thứ {} lỗi tại 0x{:X}: {}"
                      .format(i, name_pos, e))
                _hex_dump_around(stream, name_pos, before=16, after=80)
                raise

            if name not in _material_entry_lookup:
                print("=" * 70)
                print("[EDM-DEBUG] Material entry KHÔNG NHẬN DIỆN: {!r}"
                      .format(name))
                print("[EDM-DEBUG] Vị trí: 0x{:X}  (entry thứ {}/{})"
                      .format(name_pos, i + 1, count))
                print("[EDM-DEBUG] Các property đã đọc thành công: {}"
                      .format(list(props.keys())))
                _hex_dump_around(stream, name_pos, before=16, after=80)
                print("=" * 70)
                # Dừng đọc thay vì crash — để các bước import sau còn chạy được
                # Comment dòng raise nếu muốn cho qua:
                raise KeyError(
                    "Unknown material entry '{}' at 0x{:X}. "
                    "Hãy gửi tên này cho dev để bổ sung _material_entry_lookup."
                    .format(name, name_pos)
                )

            value_pos = stream.tell()
            try:
                props[name] = _material_entry_lookup[name](stream)
            except Exception as e:
                print("[EDM-DEBUG] Đọc giá trị của {!r} lỗi tại 0x{:X}: {}"
                      .format(name, value_pos, e))
                _hex_dump_around(stream, value_pos, before=16, after=80)
                raise

        for k, v in props.items():
            setattr(self, k.lower(), v)
        self.props = props
        return self


# ============================================================
# 3) Hàm tiện ích hex-dump — dán vào đầu file types.py
# ============================================================
def _hex_dump_around(stream, position, before=16, after=64):
    """In hex dump quanh một vị trí byte trong stream để debug.
    KHÔNG làm thay đổi vị trí con trỏ stream sau khi gọi."""
    saved = stream.tell()
    try:
        start = max(0, position - before)
        stream.seek(start)
        length = before + after
        data = stream.read(length)

        print("[EDM-DEBUG] Hex dump từ 0x{:X} ({} byte):".format(start, len(data)))
        for offset in range(0, len(data), 16):
            chunk = data[offset:offset + 16]
            hex_part = " ".join("{:02X}".format(b) for b in chunk)
            ascii_part = "".join(
                chr(b) if 32 <= b < 127 else "." for b in chunk
            )
            marker = " <<<" if start + offset <= position < start + offset + 16 else ""
            print("  0x{:08X}  {:<48s}  |{}|{}".format(
                start + offset, hex_part, ascii_part, marker
            ))
    finally:
        stream.seek(saved)
