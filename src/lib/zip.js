// Jednoduchý ZIP (zápis i čtení) bez další knihovny.
//
// Zápis: soubory se buď jen uloží (PDF, obrázky — ty už jsou zkomprimované),
// nebo zkomprimují (JSON s daty), pokud to prohlížeč umí (CompressionStream).
// Čtení: najde obsah ZIPu, rozbalí jednotlivé soubory a ověří kontrolní
// součet (CRC32) — tím se záloha po vytvoření sama zkontroluje.
//
// Limity klasického ZIPu: max. 65 535 souborů a 4 GB — pro zálohu aplikace
// víc než dost; při překročení se vyhodí srozumitelná chyba.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, prev = 0) {
  let c = (prev ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export const canCompress = () => typeof CompressionStream !== 'undefined';

async function streamThrough(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

async function deflateRaw(bytes) {
  try { return await streamThrough(bytes, new CompressionStream('deflate-raw')); }
  catch (e) { return null; } // prohlížeč 'deflate-raw' nezná → uloží se bez komprese
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('Tento prohlížeč neumí rozbalit komprimovaný soubor v záloze.');
  return streamThrough(bytes, new DecompressionStream('deflate-raw'));
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

const MAX_U32 = 0xFFFFFFFF;

// Sestavuje ZIP po částech; výsledek je Blob.
export class ZipWriter {
  constructor() {
    this.parts = [];      // Uint8Array části souboru v pořadí
    this.central = [];    // záznamy pro obsah ZIPu
    this.offset = 0;
    this.names = new Set();
    this.when = dosDateTime(new Date());
  }

  // data: Uint8Array | string; compress: zkusit komprimovat
  async add(name, data, { compress = false } = {}) {
    if (this.names.has(name)) throw new Error(`Soubor „${name}“ je v záloze dvakrát.`);
    this.names.add(name);
    const raw = typeof data === 'string' ? enc.encode(data) : data;
    const crc = crc32(raw);
    let method = 0;
    let body = raw;
    if (compress && canCompress() && raw.length > 256) {
      const z = await deflateRaw(raw);
      if (z && z.length < raw.length) { method = 8; body = z; }
    }
    if (raw.length > MAX_U32 || body.length > MAX_U32 || this.offset > MAX_U32) {
      throw new Error('Záloha je větší než 4 GB — odškrtněte část souborů a zálohujte je zvlášť.');
    }
    if (this.central.length >= 65535) throw new Error('Záloha má víc než 65 535 souborů — zálohujte po částech.');
    const nameBytes = enc.encode(name);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true);          // názvy v UTF-8 (diakritika)
    h.setUint16(8, method, true);
    h.setUint16(10, this.when.time, true);
    h.setUint16(12, this.when.date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, body.length, true);
    h.setUint32(22, raw.length, true);
    h.setUint16(26, nameBytes.length, true);
    h.setUint16(28, 0, true);
    this.central.push({ nameBytes, method, crc, csize: body.length, usize: raw.length, offset: this.offset });
    this.parts.push(new Uint8Array(h.buffer), nameBytes, body);
    this.offset += 30 + nameBytes.length + body.length;
  }

  finish() {
    const cdStart = this.offset;
    let cdSize = 0;
    for (const e of this.central) {
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, e.method, true);
      c.setUint16(12, this.when.time, true);
      c.setUint16(14, this.when.date, true);
      c.setUint32(16, e.crc, true);
      c.setUint32(20, e.csize, true);
      c.setUint32(24, e.usize, true);
      c.setUint16(28, e.nameBytes.length, true);
      // 30 extra, 32 komentář, 34 disk, 36 interní atributy = 0
      c.setUint32(38, 0, true);
      c.setUint32(42, e.offset, true);
      this.parts.push(new Uint8Array(c.buffer), e.nameBytes);
      cdSize += 46 + e.nameBytes.length;
    }
    if (cdStart + cdSize > MAX_U32) throw new Error('Záloha je větší než 4 GB — odškrtněte část souborů a zálohujte je zvlášť.');
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.central.length, true);
    end.setUint16(10, this.central.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, cdStart, true);
    this.parts.push(new Uint8Array(end.buffer));
    const blob = new Blob(this.parts, { type: 'application/zip' });
    this.parts = [];
    return blob;
  }
}

async function readRange(blob, start, len) {
  return new Uint8Array(await blob.slice(start, start + len).arrayBuffer());
}

// Přečte obsah ZIPu. Vrací { entries: [{name, method, crc, csize, usize, offset}], read(name) }.
export async function openZip(blob) {
  const tailLen = Math.min(blob.size, 22 + 65535);
  const tail = await readRange(blob, blob.size - tailLen, tailLen);
  const tv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Soubor není platný ZIP (chybí jeho obsah) — nejspíš je poškozený nebo neúplný.');
  const count = tv.getUint16(eocd + 10, true);
  const cdSize = tv.getUint32(eocd + 12, true);
  const cdOffset = tv.getUint32(eocd + 16, true);
  const cd = await readRange(blob, cdOffset, cdSize);
  const v = new DataView(cd.buffer);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('Obsah ZIPu je poškozený.');
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nLen = v.getUint16(p + 28, true);
    const xLen = v.getUint16(p + 30, true);
    const cLen = v.getUint16(p + 32, true);
    const offset = v.getUint32(p + 42, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nLen));
    entries.push({ name, method, crc, csize, usize, offset });
    p += 46 + nLen + xLen + cLen;
  }
  const byName = new Map(entries.map(e => [e.name, e]));

  // Vrátí rozbalená data a ověří kontrolní součet.
  async function read(nameOrEntry) {
    const e = typeof nameOrEntry === 'string' ? byName.get(nameOrEntry) : nameOrEntry;
    if (!e) throw new Error(`V záloze chybí soubor „${nameOrEntry}“.`);
    const lh = await readRange(blob, e.offset, 30);
    const lv = new DataView(lh.buffer);
    if (lv.getUint32(0, true) !== 0x04034b50) throw new Error(`Soubor „${e.name}“ v záloze je poškozený.`);
    const start = e.offset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
    const body = await readRange(blob, start, e.csize);
    let raw;
    if (e.method === 0) raw = body;
    else if (e.method === 8) raw = await inflateRaw(body);
    else throw new Error(`Soubor „${e.name}“ používá neznámou kompresi.`);
    if (raw.length !== e.usize || crc32(raw) !== e.crc) throw new Error(`Soubor „${e.name}“ v záloze je poškozený (nesedí kontrolní součet).`);
    return raw;
  }

  return { entries, has: (n) => byName.has(n), read, readText: async (n) => dec.decode(await read(n)) };
}
