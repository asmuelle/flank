/**
 * Deterministic POSIX ustar archive of a bundle (path → content). Fixed
 * metadata (mode 0644, uid/gid 0, mtime 0) and the bundle's sorted path order
 * make the tarball byte-stable — same bundle, same tarball, diffable in
 * object storage. Compression is the delivery layer's choice.
 */

const BLOCK = 512;
const encoder = new TextEncoder();

const writeString = (block: Uint8Array, offset: number, value: string): void => {
  block.set(encoder.encode(value), offset);
};

const writeOctal = (block: Uint8Array, offset: number, length: number, value: number): void => {
  // Octal ASCII, zero-padded, NUL-terminated — the conventional ustar form.
  writeString(block, offset, `${value.toString(8).padStart(length - 1, '0')}\0`);
};

const headerFor = (path: string, size: number): Uint8Array => {
  const name = encoder.encode(path);
  if (name.length > 100) {
    throw new Error(`tar entry name exceeds 100 bytes: ${path}`);
  }
  const block = new Uint8Array(BLOCK);
  block.set(name, 0);
  writeOctal(block, 100, 8, 0o644); // mode
  writeOctal(block, 108, 8, 0); // uid
  writeOctal(block, 116, 8, 0); // gid
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, 0); // mtime — fixed for determinism
  writeString(block, 148, '        '); // checksum field counts as spaces
  writeString(block, 156, '0'); // typeflag: regular file
  writeString(block, 257, 'ustar\0');
  writeString(block, 263, '00');

  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  writeString(block, 148, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return block;
};

export const bundleToTar = (files: ReadonlyMap<string, string>): Uint8Array => {
  const blocks: Uint8Array[] = [];
  for (const [path, content] of files) {
    const data = encoder.encode(content);
    blocks.push(headerFor(path, data.length));
    const padded = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
    padded.set(data, 0);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(BLOCK), new Uint8Array(BLOCK)); // end-of-archive marker

  const total = blocks.reduce((sum, b) => sum + b.length, 0);
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.length;
  }
  return archive;
};
