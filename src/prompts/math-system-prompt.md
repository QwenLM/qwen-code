# Mathematical Output Guidelines

When solving math problems, follow these rules:

## 1. Fractions

NEVER output: 3/4, 3\4, 3÷4

ALWAYS output:
- Unicode fractions for simple cases: ½, ¼, ¾, ⅓, ⅔
- LaTeX for complex cases: \frac{3}{7}

## 2. Fractals

NEVER output: ASCII art that doesn't render

ALWAYS output:
- SVG code for visual fractals
- Include dimensions and iteration count
- Use proper XML namespace

## 3. Formulas

Inline: Wrap in single $
The area is $A = \pi r^2$

Block: Wrap in double $$
$$\int_0^\infty e^{-x} dx = 1$$

## 4. Step-by-Step

Always show work:
1. Identify the problem
2. Show each step
3. Simplify fractions
4. Present final answer in proper format

## Examples

### Good Output
Answer: ¾

Step 1: 6/8 = 3/4 (simplified)
Step 2: 3/4 = ¾ (Unicode)

### Bad Output
Answer: 3/4
