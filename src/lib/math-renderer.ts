/**
 * Math Renderer for Qwen Code
 * Converts mathematical expressions to proper LaTeX/Unicode format
 */

export interface Fraction {
  numerator: number;
  denominator: number;
}

export interface FractalData {
  type: 'mandelbrot' | 'julia' | 'sierpinski';
  iterations: number;
  size: number;
}

const UNICODE_FRACTIONS: Record<string, string> = {
  '1/2': '½',
  '1/3': '⅓',
  '2/3': '⅔',
  '1/4': '¼',
  '3/4': '¾',
  '1/5': '⅕',
  '2/5': '⅖',
  '3/5': '⅗',
  '4/5': '⅘',
  '1/6': '⅙',
  '5/6': '⅚',
  '1/8': '⅛',
  '3/8': '⅜',
  '5/8': '⅝',
  '7/8': '⅞',
};

export function formatFraction(numerator: number, denominator: number): string {
  if (denominator === 0) {
    return '\\text{undefined}';
  }
  
  if (numerator === 0) {
    return '0';
  }
  
  if (denominator === 1) {
    return numerator.toString();
  }
  
  const isNegative = (numerator < 0) !== (denominator < 0);
  const absNum = Math.abs(numerator);
  const absDen = Math.abs(denominator);
  
  const gcd = computeGCD(absNum, absDen);
  const simplifiedNum = absNum / gcd;
  const simplifiedDen = absDen / gcd;
  
  const key = `${simplifiedNum}/${simplifiedDen}`;
  
  if (UNICODE_FRACTIONS[key]) {
    return isNegative ? '-' + UNICODE_FRACTIONS[key] : UNICODE_FRACTIONS[key];
  }
  
  const sign = isNegative ? '-' : '';
  return `${sign}\\frac{${simplifiedNum}}{${simplifiedDen}}`;
}

function computeGCD(a: number, b: number): number {
  while (b !== 0) {
    const temp = b;
    b = a % b;
    a = temp;
  }
  return a;
}

export function generateMandelbrotSVG(data: FractalData): string {
  const { size, iterations } = data;
  const scale = 3.5 / size;
  
  let svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect width="100%" height="100%" fill="black"/>`;
  
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x0 = (px - size / 2) * scale;
      const y0 = (py - size / 2) * scale;
      
      let x = 0;
      let y = 0;
      let iteration = 0;
      
      while (x * x + y * y <= 4 && iteration < iterations) {
        const xTemp = x * x - y * y + x0;
        y = 2 * x * y + y0;
        x = xTemp;
        iteration++;
      }
      
      if (iteration < iterations) {
        const hue = (iteration * 10) % 360;
        svg += `<rect x="${px}" y="${py}" width="1" height="1" fill="hsl(${hue}, 100%, 50%)"/>`;
      }
    }
  }
  
  svg += '</svg>';
  return svg;
}

export function generateSierpinskiSVG(size: number, iterations: number): string {
  let svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect width="100%" height="100%" fill="white"/>`;
  
  const drawTriangle = (x: number, y: number, s: number, depth: number) => {
    if (depth === 0) {
      svg += `<polygon points="${x},${y + s} ${x + s / 2},${y} ${x + s},${y + s}" fill="black"/>`;
      return;
    }
    
    const half = s / 2;
    drawTriangle(x, y, half, depth - 1);
    drawTriangle(x + half, y, half, depth - 1);
    drawTriangle(x + half / 2, y + half, half, depth - 1);
  };
  
  drawTriangle(0, 0, size, iterations);
  svg += '</svg>';
  return svg;
}

export function convertToLatex(text: string): string {
  text = text.replace(/(\d+)\/(\d+)/g, (match, num, den) => {
    return formatFraction(parseInt(num), parseInt(den));
  });
  
  text = text.replace(/\^(\d+)/g, '^{$1}');
  text = text.replace(/sqrt\(([^)]+)\)/g, '\\sqrt{$1}');
  
  return text;
}

export default {
  formatFraction,
  generateMandelbrotSVG,
  generateSierpinskiSVG,
  convertToLatex,
};
