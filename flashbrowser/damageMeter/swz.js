'use strict';

const zlib = require('zlib');

// The game's largest XML file is a few megabytes; Node 12.19 and later stop inflating past this.
const MAX_XML_BYTES = 256 * 1024 * 1024;

/**
 * Unpacks a Dungeon Blitz .swz archive (the client's packed XML: Game.swz, Login.swz).
 *
 * Layout: u32 key, u32 chunk count, then per chunk a u32 length and that many bytes XORed with
 * a rolling key (low byte of the key, which is rotated right by (i & 7) after every byte and
 * carries over from one chunk to the next), each chunk being zlib-compressed UTF-8 XML.
 * Same algorithm as tools/build_catalog.py in the scanner.
 */
function unpackSwz(buf) {
    // Anything else served under the name (an error page, a cut-off download) is refused before
    // its bytes are taken for lengths.
    if (!Buffer.isBuffer(buf) || buf.length < 8) throw new Error('not a .swz file');
    let key = buf.readUInt32BE(0) >>> 0;
    const count = buf.readUInt32BE(4);
    if (count > (buf.length - 8) / 4) throw new Error('not a .swz file');
    let pos = 8;
    const out = [];
    for (let c = 0; c < count; c++) {
        if (pos + 4 > buf.length) throw new Error('not a .swz file');
        const n = buf.readUInt32BE(pos);
        pos += 4;
        if (n > buf.length - pos) throw new Error('not a .swz file');
        const chunk = Buffer.alloc(n);
        for (let j = 0; j < n; j++) {
            chunk[j] = buf[pos + j] ^ (key & 0xff);
            const s = j & 7;
            if (s) {
                key = ((key << (32 - s)) | (key >>> s)) >>> 0;
            }
        }
        pos += n;
        out.push(zlib.inflateSync(chunk, { maxOutputLength: MAX_XML_BYTES }).toString('utf8'));
    }
    return out;
}

/** The chunk whose root element is `root` (e.g. "PlayerPowerTypes"), or ''. */
function chunkByRoot(chunks, root) {
    const re = new RegExp('<' + root + '[\\s>]');
    for (const c of chunks) {
        if (re.test(c.slice(0, 400))) {
            return c;
        }
    }
    return '';
}

module.exports = { unpackSwz, chunkByRoot };
