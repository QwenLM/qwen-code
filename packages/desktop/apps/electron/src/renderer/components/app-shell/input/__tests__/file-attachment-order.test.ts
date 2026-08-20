import { describe, expect, it } from 'bun:test';
import { sortFilesForAttachmentInput } from '../file-attachment-order';

function imageFile(name: string, lastModified: number): File {
  return new File(['x'], name, {
    type: 'image/png',
    lastModified,
  });
}

describe('sortFilesForAttachmentInput', () => {
  it('sorts pasted files by natural filename order', () => {
    const image10 = imageFile('image-10.png', 10);
    const image2 = imageFile('image-2.png', 20);
    const image1 = imageFile('image-1.png', 30);

    expect(
      sortFilesForAttachmentInput([image10, image2, image1]).map(
        (file) => file.name,
      ),
    ).toEqual(['image-1.png', 'image-2.png', 'image-10.png']);
  });

  it('uses modified time when clipboard file names are identical', () => {
    const newer = imageFile('image.png', 200);
    const older = imageFile('image.png', 100);

    expect(sortFilesForAttachmentInput([newer, older])).toEqual([older, newer]);
  });
});
