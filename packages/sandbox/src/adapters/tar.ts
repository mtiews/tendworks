/*
 * Just enough of the ustar format to move single regular files through the
 * container archive endpoint.
 */

const block = 512;
const padded = (size: number) => Math.ceil(size / block) * block;

/** A tar archive holding one regular file called `name` (no directories). */
export function tarSingleFile(name: string, content: Uint8Array, mode = 0o644): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  if (nameBytes.length === 0 || nameBytes.length > 100 || name.includes("/")) throw new Error(`invalid file name for tar: ${name}`);

  const header = new Uint8Array(block);
  const put = (offset: number, value: string) => header.set(new TextEncoder().encode(value), offset);
  const octal = (offset: number, length: number, value: number) => put(offset, value.toString(8).padStart(length - 1, "0") + "\0");

  header.set(nameBytes, 0);
  octal(100, 8, mode);
  octal(108, 8, 0); // uid, the receiver assigns the owner
  octal(116, 8, 0); // gid
  octal(124, 12, content.length);
  octal(136, 12, Math.floor(Date.now() / 1000));
  put(148, "        "); // checksum placeholder
  put(156, "0");
  put(257, "ustar\0");
  put(263, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  put(148, checksum.toString(8).padStart(6, "0") + "\0 ");

  const archive = new Uint8Array(block + padded(content.length) + 2 * block);
  archive.set(header, 0);
  archive.set(content, block);
  return archive;
}

export type TarEntry = { type: "file"; content: Uint8Array } | { type: "other"; typeflag: string };

/** The first real entry of a tar archive, skipping pax extension headers. */
export function firstTarEntry(archive: Uint8Array): TarEntry {
  for (let offset = 0; offset + block <= archive.length; ) {
    const header = archive.subarray(offset, offset + block);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(new TextDecoder().decode(header.subarray(124, 136)).replace(/\0.*$/s, "").trim() || "0", 8);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + block;
    if (typeflag === "x" || typeflag === "g") {
      offset = dataStart + padded(size);
      continue;
    }
    if (typeflag === "0" || typeflag === "\0") return { type: "file", content: archive.slice(dataStart, dataStart + size) };
    return { type: "other", typeflag };
  }
  throw new Error("empty tar archive");
}
