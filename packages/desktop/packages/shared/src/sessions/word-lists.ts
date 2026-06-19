/**
 * Word Lists for Human-Readable Session IDs
 *
 * Curated fallback lists for sessions created without a prompt/title hint.
 */

/**
 * Adjectives: Short, positive/neutral, easy to spell
 * ~100 words for good variety
 */
export const ADJECTIVES = [
  // Nature/Weather
  'bright', 'calm', 'clear', 'cool', 'crisp', 'fresh', 'gentle', 'golden', 'misty', 'sunny',
  'warm', 'wild', 'windy', 'frosty', 'mild', 'soft', 'swift', 'quiet', 'silent', 'still',

  // Colors (abstract)
  'azure', 'coral', 'amber', 'jade', 'ruby', 'ivory', 'onyx', 'pearl', 'silver', 'copper',

  // Qualities
  'bold', 'brave', 'clever', 'eager', 'fair', 'fleet', 'grand', 'keen', 'noble', 'proud',
  'quick', 'sharp', 'smart', 'steady', 'strong', 'true', 'vivid', 'wise', 'witty', 'zesty',

  // Size/Shape
  'broad', 'deep', 'high', 'long', 'tall', 'vast', 'wide', 'slim', 'lean', 'agile',

  // Texture/Feel
  'smooth', 'light', 'airy', 'sleek', 'polished', 'refined', 'pure', 'prime', 'fine', 'neat',

  // Energy/Motion
  'active', 'brisk', 'lively', 'nimble', 'rapid', 'ready', 'spry', 'vital', 'dynamic', 'fluid',

  // Time/State
  'early', 'first', 'fresh', 'new', 'prime', 'young', 'alert', 'awake', 'aware', 'focal',

  // Abstract positive
  'apt', 'deft', 'fit', 'apt', 'lucid', 'open', 'plain', 'safe', 'snug', 'tidy',
] as const;

/**
 * Nouns: Nature-themed, concrete, memorable
 * ~200 words for variety (100 adj × 200 noun = 20,000 combos/day)
 */
export const NOUNS = [
  // Landscape
  'canyon', 'cliff', 'coast', 'cove', 'creek', 'delta', 'dune', 'field', 'fjord', 'forest',
  'glade', 'glen', 'gorge', 'grove', 'harbor', 'heath', 'hill', 'island', 'lagoon', 'lake',
  'marsh', 'meadow', 'mesa', 'moor', 'mountain', 'oasis', 'ocean', 'pass', 'peak', 'plain',
  'plateau', 'pond', 'prairie', 'ravine', 'reef', 'ridge', 'river', 'shore', 'spring', 'stream',
  'summit', 'swamp', 'trail', 'valley', 'vista', 'waterfall', 'woods', 'bay', 'beach', 'bluff',

  // Sky/Space
  'aurora', 'cloud', 'comet', 'cosmos', 'dawn', 'dusk', 'eclipse', 'galaxy', 'halo', 'horizon',
  'meteor', 'moon', 'nebula', 'nova', 'orbit', 'pulsar', 'quasar', 'rainbow', 'sky', 'star',
  'storm', 'sun', 'sunset', 'thunder', 'twilight', 'zenith', 'breeze', 'gust', 'mist', 'frost',

  // Animals
  'bear', 'crane', 'crow', 'deer', 'dove', 'eagle', 'elk', 'falcon', 'finch', 'fox',
  'hawk', 'heron', 'horse', 'lark', 'lion', 'lynx', 'otter', 'owl', 'panther', 'puma',
  'raven', 'robin', 'salmon', 'seal', 'shark', 'sparrow', 'stag', 'swan', 'tiger', 'trout',
  'whale', 'wolf', 'wren', 'badger', 'beaver', 'bison', 'bobcat', 'coyote', 'dolphin', 'gecko',

  // Plants
  'aspen', 'bamboo', 'birch', 'bloom', 'blossom', 'bonsai', 'branch', 'cedar', 'cherry', 'clover',
  'cypress', 'elm', 'fern', 'flower', 'grove', 'hazel', 'holly', 'ivy', 'jasmine', 'laurel',
  'leaf', 'lily', 'lotus', 'maple', 'moss', 'oak', 'olive', 'orchid', 'palm', 'pine',
  'poplar', 'reed', 'rose', 'sage', 'sequoia', 'spruce', 'thistle', 'tulip', 'vine', 'willow',

  // Elements/Materials
  'amber', 'bronze', 'carbon', 'chrome', 'cobalt', 'copper', 'coral', 'crystal', 'diamond', 'ember',
  'flint', 'garnet', 'gem', 'glass', 'gold', 'granite', 'iron', 'jade', 'jasper', 'marble',
  'nickel', 'obsidian', 'opal', 'pearl', 'quartz', 'ruby', 'sand', 'sapphire', 'silver', 'slate',
  'steel', 'stone', 'titanium', 'topaz', 'zinc', 'basalt', 'clay', 'cobble', 'pebble', 'boulder',

  // Water features
  'brook', 'cascade', 'channel', 'current', 'eddy', 'falls', 'flood', 'flow', 'fountain', 'geyser',
  'glacier', 'inlet', 'rapids', 'ripple', 'shoal', 'spray', 'surge', 'tide', 'torrent', 'wave',
] as const;

export type Adjective = typeof ADJECTIVES[number];
export type Noun = typeof NOUNS[number];
