import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

/**
 * Writes a ZIP archive of local files with the STORE method (no compression: the videos and images are compressed
 * already). Each file is streamed once; its CRC and sizes follow in a data descriptor. Not ZIP64: every file and the
 * archive must stay under 4 GiB, which a deliverables pack does by a wide margin.
 */
export async function writeStoredZip(entries: { name: string; path: string }[], outPath: string, now = new Date()): Promise<number> {
  const out = createWriteStream(outPath);
  let offset = 0;
  const write = (b: Buffer) =>
    new Promise<void>((resolve, reject) => {
      offset += b.length;
      out.write(b, (e) => (e ? reject(e) : resolve()));
    });
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff;
  const date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  const central: Buffer[] = [];
  for (const e of entries) {
    const size = (await stat(e.path)).size;
    if (size >= 0xffffffff) throw new Error(`${e.name} is too large for the pack.`);
    const name = Buffer.from(e.name, 'utf8');
    const start = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    await write(Buffer.concat([local, name]));
    let crc = 0;
    for await (const chunk of createReadStream(e.path)) {
      const b = chunk as Buffer;
      crc = crc32(b, crc);
      await write(b);
    }
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    desc.writeUInt32LE(size, 8);
    desc.writeUInt32LE(size, 12);
    await write(desc);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0808, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc >>> 0, 16);
    c.writeUInt32LE(size, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(start, 42);
    central.push(Buffer.concat([c, name]));
  }
  const cdStart = offset;
  const cd = Buffer.concat(central);
  await write(cd);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(cdStart, 16);
  await write(end);
  await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  return offset;
}
