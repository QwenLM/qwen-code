# Math Rendering Guide

This document explains how Qwen Code renders mathematical expressions.

## Fractions

### Before (Wrong)
3/4
1/2
5/8

### After (Correct)
½
¼
⅝

For complex fractions, LaTeX is used:
\frac{3}{7}
\frac{5}{9}

## Fractals

### Mandelbrot Set
import { generateMandelbrotSVG } from './lib/math-renderer';

const svg = generateMandelbrotSVG({
  type: 'mandelbrot',
  iterations: 100,
  size: 200
});

### Sierpinski Triangle
import { generateSierpinskiSVG } from './lib/math-renderer';

const svg = generateSierpinskiSVG(200, 5);

## LaTeX Support

All mathematical expressions are automatically converted:

| Input | Output |
|-------|--------|
| 3/4 | \frac{3}{4} |
| x^2 | x^2 |
| sqrt(2) | \sqrt{2} |

## Testing

Run tests with:
npm test -- math-renderer
