import { describe, expect, it } from 'vitest';
import { bundleToTar } from './tar';

const decoder = new TextDecoder();

/** Minimal ustar reader for assertions: returns [name, content] pairs. */
const readTar = (archive: Uint8Array): [string, string][] => {
  const entries: [string, string][] = [];
  let offset = 0;
  while (offset < archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, '');
    const size = Number.parseInt(decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, ''), 8);
    const content = decoder.decode(archive.subarray(offset + 512, offset + 512 + size));
    entries.push([name, content]);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
};

describe('bundleToTar', () => {
  const files = new Map([
    ['index.md', '---\ntype: Index\n---\n'],
    ['tables/orders.md', '---\ntype: Table\n---\n\nbody\n'],
  ]);

  it('round-trips names and contents through a ustar reader', () => {
    // Act
    const archive = bundleToTar(files);

    // Assert
    expect(readTar(archive)).toEqual([...files.entries()]);
  });

  it('carries valid header checksums', () => {
    // Arrange
    const archive = bundleToTar(files);
    const header = archive.subarray(0, 512);

    // Act — recompute with the checksum field read as spaces.
    const stored = Number.parseInt(decoder.decode(header.subarray(148, 155)), 8);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) {
      sum += i >= 148 && i < 156 ? 0x20 : header[i];
    }

    // Assert
    expect(stored).toBe(sum);
  });

  it('is byte-deterministic and block-aligned with the end-of-archive marker', () => {
    // Act
    const first = bundleToTar(files);
    const second = bundleToTar(files);

    // Assert
    expect(first).toEqual(second);
    expect(first.length % 512).toBe(0);
    expect(first.subarray(first.length - 1024).every((byte) => byte === 0)).toBe(true);
  });

  it('rejects entry names over 100 bytes', () => {
    // Arrange
    const long = new Map([[`${'a/'.repeat(60)}x.md`, 'content']]);

    // Act & Assert
    expect(() => bundleToTar(long)).toThrow(/100 bytes/);
  });
});
