/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { deflateSync } from 'node:zlib';
import sharp from 'sharp';

export const MEDIA_CASES = [
  'png',
  'jpeg',
  'webp',
  'gif',
  'native-pdf',
  'pdf-text',
  'pdf-render',
  'image-disabled',
  'image-missing',
  'pdf-too-large',
  'lost-start',
  'lost-execute',
] as const;

export type MediaCase = (typeof MEDIA_CASES)[number];

export function pdfFixture(text: boolean, padding = 0): Buffer {
  const stream = text
    ? Buffer.from('BT /F1 4 Tf 5 20 Td (provider media text proof) Tj ET')
    : Buffer.from('q 72 0 0 54 0 0 cm /Im1 Do Q');
  const image = deflateSync(Buffer.alloc(8 * 6 * 3, 93));
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 54] ' +
        '/Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> ' +
        '/Contents 4 0 R >>',
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),
      stream,
      Buffer.from('\nendstream'),
    ]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    Buffer.concat([
      Buffer.from(
        '<< /Type /XObject /Subtype /Image /Width 8 /Height 6 ' +
          '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode ' +
          `/Length ${image.length} >>\nstream\n`,
      ),
      image,
      Buffer.from('\nendstream'),
    ]),
  ];
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  let size = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(size);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from('\nendobj\n'),
    ]);
    chunks.push(chunk);
    size += chunk.length;
  }
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
        offsets
          .slice(1)
          .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
          .join('') +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
        `startxref\n${size}\n%%EOF\n` +
        (padding ? '%' + 'p'.repeat(padding) + '\n' : ''),
    ),
  );
  return Buffer.concat(chunks);
}

export async function mediaFixture(name: MediaCase, replacement = false) {
  if (name.includes('pdf') || name === 'lost-execute') {
    return {
      filename: 'proof.pdf',
      mime: 'application/pdf',
      bytes: pdfFixture(
        name === 'pdf-text',
        (name === 'pdf-too-large'
          ? 600 * 1024
          : name === 'native-pdf' || name === 'lost-execute'
            ? 560 * 1024
            : 0) + (replacement ? 17 : 0),
      ),
    };
  }
  const format = ['jpeg', 'webp', 'gif'].includes(name) ? name : 'png';
  const bytes = await sharp({
    create: {
      width: 8,
      height: 6,
      channels: 3,
      background: replacement ? '#ed2161' : '#2161ed',
    },
  })
    .toFormat(format as 'png' | 'jpeg' | 'webp' | 'gif')
    .toBuffer();
  return { filename: `proof.${format}`, mime: `image/${format}`, bytes };
}
