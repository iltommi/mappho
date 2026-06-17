// Parse GPS and creation date from an MP4/QuickTime file's moov box.
// Only works if moov is in the fetched buffer (fast-start / web-optimised files).
// Falls back to filename date parsing for other layouts.
export function extractMP4Meta(buffer) {
  const view = new DataView(buffer);
  const end  = buffer.byteLength;

  function u8(o)  { return view.getUint8(o); }
  function u32(o) { return view.getUint32(o, false); }
  function u16(o) { return view.getUint16(o, false); }
  function s4(o)  { return String.fromCharCode(u8(o), u8(o+1), u8(o+2), u8(o+3)); }

  function findBox(start, stop, type) {
    let p = start;
    while (p + 8 <= stop) {
      const sz = u32(p);
      if (sz < 8) break;
      if (s4(p + 4) === type) return { ps: p + 8, end: Math.min(p + sz, stop) };
      p += sz;
    }
    return null;
  }

  const moov = findBox(0, end, 'moov');
  if (!moov) return {};

  const result = {};

  // mvhd: creation time in seconds since 1904-01-01 (QuickTime epoch)
  const mvhd = findBox(moov.ps, moov.end, 'mvhd');
  if (mvhd) {
    const ver = u8(mvhd.ps);
    const ct  = ver === 1
      ? Number(view.getBigUint64(mvhd.ps + 4, false))
      : u32(mvhd.ps + 4);
    if (ct > 0) result.ts = (ct - 2082844800) * 1000;
  }

  // udta/©xyz: ISO 6709 GPS string e.g. "+48.8566+002.3522/"
  const udta = findBox(moov.ps, moov.end, 'udta');
  if (udta) {
    let p = udta.ps;
    while (p + 8 <= udta.end) {
      const sz = u32(p);
      if (sz < 8) break;
      // ©xyz = 0xA9 0x78 0x79 0x7A
      if (u8(p+4) === 0xA9 && u8(p+5) === 0x78 && u8(p+6) === 0x79 && u8(p+7) === 0x7A) {
        const textLen = u16(p + 8);
        if (p + 12 + textLen <= end) {
          const str = new TextDecoder().decode(new Uint8Array(buffer, p + 12, textLen));
          const m = str.match(/([+-]\d+\.?\d*)([+-]\d+\.?\d*)/);
          if (m) {
            const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
            if (!isNaN(lat) && !isNaN(lng)) { result.lat = lat; result.lng = lng; }
          }
        }
        break;
      }
      p += sz;
    }
  }

  return result;
}

export const isVideo = name => /\.(mp4|mov|3gp|3gpp)$/i.test(name ?? '');
