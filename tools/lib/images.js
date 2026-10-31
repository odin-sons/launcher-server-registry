'use strict';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function detectImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  return null;
}

/** Reads the header only; the picture is never decoded. */
function pngInfo(buffer) {
  if (detectImage(buffer) !== 'png') throw new Error('Not a PNG file.');
  let offset = 8;
  let width = null;
  let height = null;
  let animated = false;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    if (offset === 8 && (type !== 'IHDR' || length !== 13)) throw new Error('The first PNG chunk is not a valid IHDR.');
    if (type === 'IHDR') {
      if (offset + 8 + 13 > buffer.length) throw new Error('The PNG header is truncated.');
      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
    }
    if (type === 'acTL') animated = true;
    if (type === 'IDAT' || type === 'IEND') break;
    offset += 12 + length;
  }
  if (width === null || width === 0 || height === 0) throw new Error('The PNG has no valid dimensions.');
  return { format: 'png', width, height, animated };
}

function jpegInfo(buffer) {
  if (detectImage(buffer) !== 'jpeg') throw new Error('Not a JPEG file.');
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > buffer.length) break;
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      if (width === 0 || height === 0) throw new Error('The JPEG has no valid dimensions.');
      return { format: 'jpeg', width, height, animated: false };
    }
    if (marker === 0xda) break;
    offset += 2 + length;
  }
  throw new Error('The JPEG has no frame header.');
}

function imageInfo(buffer) {
  const format = detectImage(buffer);
  if (format === 'png') return pngInfo(buffer);
  if (format === 'jpeg') return jpegInfo(buffer);
  throw new Error('The file is neither a PNG nor a JPEG picture.');
}

module.exports = { detectImage, pngInfo, jpegInfo, imageInfo };
