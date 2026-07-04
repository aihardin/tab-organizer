import struct
import zlib
import os

def make_png(size, bg, fg):
    inset = size // 5
    pixels = []
    for y in range(size):
        row = []
        for x in range(size):
            if inset <= x < size - inset and inset <= y < size - inset:
                row.append(fg)
            else:
                row.append(bg)
        pixels.append(row)

    raw = b''
    for row in pixels:
        raw += b'\x00'
        for r, g, b in row:
            raw += bytes([r, g, b])

    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n' +
        chunk(b'IHDR', ihdr) +
        chunk(b'IDAT', zlib.compress(raw)) +
        chunk(b'IEND', b'')
    )

bg = (99, 102, 241)
fg = (199, 210, 254)

for size in [16, 48, 128]:
    data = make_png(size, bg, fg)
    path = os.path.join(os.path.dirname(__file__), 'icon' + str(size) + '.png')
    with open(path, 'wb') as f:
        f.write(data)
    print('Written: ' + path)
