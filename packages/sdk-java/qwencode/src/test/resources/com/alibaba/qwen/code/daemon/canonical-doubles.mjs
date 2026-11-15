/* global console */
// Regenerates canonical-doubles.txt, the JSON.stringify oracle that
// JsonSupportTest checks JsonSupport.encode against:
//   node canonical-doubles.mjs > canonical-doubles.txt
// Each line is a double's raw 64-bit pattern (hex) and the exact text
// JSON.stringify renders for it. The PRNG is seeded, so the file is stable.
const view = new DataView(new ArrayBuffer(8));
const MASK = 0xffffffffffffffffn;
let state = 0x9e3779b97f4a7c15n;
function next64() {
  // xorshift64*
  state ^= state >> 12n;
  state ^= (state << 25n) & MASK;
  state ^= state >> 27n;
  return (state * 0x2545f4914f6cdd1dn) & MASK;
}
function fromBits(bits) {
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}
function toBits(value) {
  view.setFloat64(0, value);
  return view.getBigUint64(0);
}
function line(value) {
  if (!Number.isFinite(value)) return;
  const hex = toBits(value).toString(16).padStart(16, '0');
  console.log(`${hex} ${JSON.stringify(value)}`);
}
function between(lowExp, highExp) {
  // A random mantissa in [2^lowExp, 2^highExp), random sign.
  const exponent = lowExp + Number(next64() % BigInt(highExp - lowExp));
  const biased = BigInt(exponent + 1023);
  const mantissa = next64() & 0xfffffffffffffn;
  const sign = (next64() & 1n) << 63n;
  return fromBits(sign | (biased << 52n) | mantissa);
}
// Every binade's power of two and its lower neighbour: the rounding
// interval is asymmetric there, which is where "closest" matters.
for (let e = -1074; e <= 1023; e++) {
  const power = 2 ** e;
  line(power);
  const below = fromBits(toBits(power) - 1n);
  if (below > 0) line(below);
}
// Subnormals: raw mantissas with a zero exponent field.
for (let i = 0; i < 500; i++) {
  line(fromBits(next64() & 0xfffffffffffffn));
}
// Magnitude bands: the plain/exponent switches at 1e-6 and 1e21, the
// 2^53 integer bound, and the whole normal range.
const bands = [
  [-1022, -20], // tiny normals (exponent form)
  [-20, -1], // 1e-6 switch and plain fractions
  [-1, 53], // ordinary values below 2^53
  [53, 70], // integers past 2^53 up to and past 1e21
  [70, 1024], // huge
];
for (const [low, high] of bands) {
  for (let i = 0; i < 1000; i++) line(between(low, high));
}
// Uniform over all bit patterns.
for (let i = 0; i < 1000; i++) line(fromBits(next64()));
// Signed zeros: JSON.stringify renders -0 as 0, the one notation boundary
// that no loop above reaches (they clear or randomize the sign elsewhere).
line(0);
line(-0);
