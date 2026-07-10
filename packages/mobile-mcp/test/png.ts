import { test, expect } from '@playwright/test';
import { PNG } from '../src/png';

test.describe('png', () => {
  test('should be able to parse png', () => {
    const buffer =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=';
    const png = new PNG(Buffer.from(buffer, 'base64'));
    expect(png.getDimensions().width).toBe(1);
    expect(png.getDimensions().height).toBe(1);
  });

  test('should be able to detect an invalid png', () => {
    const buffer = btoa('IAMADUCKIAMADUCKIAMADUCKIAMADUCKIAMADUCK');
    const png = new PNG(Buffer.from(buffer, 'base64'));
    expect(() => png.getDimensions()).toThrow();
  });
});
