import { formatFraction, generateMandelbrotSVG, convertToLatex } from './math-renderer';

describe('Math Renderer', () => {
  describe('formatFraction', () => {
    it('should return Unicode fraction for simple cases', () => {
      expect(formatFraction(1, 2)).toBe('½');
      expect(formatFraction(1, 4)).toBe('¼');
      expect(formatFraction(3, 4)).toBe('¾');
    });
    
    it('should return LaTeX for complex fractions', () => {
      expect(formatFraction(3, 7)).toBe('\\frac{3}{7}');
      expect(formatFraction(5, 9)).toBe('\\frac{5}{9}');
    });
    
    it('should handle zero numerator', () => {
      expect(formatFraction(0, 5)).toBe('0');
    });
    
    it('should handle denominator of 1', () => {
      expect(formatFraction(5, 1)).toBe('5');
    });
    
    it('should handle zero denominator', () => {
      expect(formatFraction(5, 0)).toBe('\\text{undefined}');
    });
    
    it('should handle negative fractions', () => {
      expect(formatFraction(-1, 2)).toBe('-½');
      expect(formatFraction(1, -2)).toBe('-½');
    });
    
    it('should simplify fractions', () => {
      expect(formatFraction(2, 4)).toBe('½');
      expect(formatFraction(6, 8)).toBe('¾');
    });
  });
  
  describe('generateMandelbrotSVG', () => {
    it('should return valid SVG string', () => {
      const svg = generateMandelbrotSVG({ type: 'mandelbrot', iterations: 100, size: 50 });
      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    });
  });
  
  describe('convertToLatex', () => {
    it('should convert fractions to LaTeX', () => {
      expect(convertToLatex('3/4')).toBe('\\frac{3}{4}');
    });
    
    it('should convert powers', () => {
      expect(convertToLatex('x^2')).toBe('x^{2}');
    });
    
    it('should convert square roots', () => {
      expect(convertToLatex('sqrt(2)')).toBe('\\sqrt{2}');
    });
  });
});
