/**
 * Easter Eggs and Fun Animations for Qwen Code
 * Delight users with hidden surprises!
 */

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m'
};

/**
 * Check if user input triggers an Easter egg
 */
export function checkEasterEgg(input: string): boolean {
  const lower = input.toLowerCase().trim();

  // Remove common punctuation
  const clean = lower.replace(/[.,!?;]/g, '');

  const easterEggs = [
    { triggers: ['hello qwen', 'hi qwen', 'hey qwen'], handler: greetingEasterEgg },
    { triggers: ['make me a sandwich', 'sudo make me a sandwich'], handler: sandwichEasterEgg },
    { triggers: ['do a barrel roll'], handler: barrelRollEasterEgg },
    { triggers: ['tell me a joke', 'joke'], handler: jokeEasterEgg },
    { triggers: ['im bored', "i'm bored", 'entertain me'], handler: entertainEasterEgg },
    { triggers: ['praise me', 'good job', 'thank you qwen'], handler: praiseEasterEgg },
    { triggers: ['whats the meaning of life', "what's the meaning of life", '42'], handler: meaningOfLifeEasterEgg },
    { triggers: ['show me the matrix', 'matrix'], handler: matrixEasterEgg },
    { triggers: ['hack the planet'], handler: hackPlanetEasterEgg },
    { triggers: ['rocket launch', 'launch rocket'], handler: rocketEasterEgg },
    { triggers: ['disco mode', 'party time'], handler: discoEasterEgg },
    { triggers: ['konami code'], handler: konamiEasterEgg }
  ];

  for (const egg of easterEggs) {
    if (egg.triggers.some(trigger => clean.includes(trigger))) {
      egg.handler();
      return true;
    }
  }

  return false;
}

/**
 * Greeting Easter egg
 */
function greetingEasterEgg(): void {
  const greetings = [
    '👋 Hello, human! Ready to write some awesome code?',
    '🎉 Hey there, code warrior! Let\'s build something amazing!',
    '✨ Greetings, fellow developer! What shall we create today?',
    '🚀 Hi! I\'m Qwen, your AI coding companion. Let\'s do this!',
    '💚 Hello! Coffee ready? ☕ Let\'s code!'
  ];

  const greeting = greetings[Math.floor(Math.random() * greetings.length)];
  console.log(`\n${COLORS.cyan}${greeting}${COLORS.reset}\n`);
}

/**
 * Sandwich Easter egg (xkcd reference)
 */
function sandwichEasterEgg(): void {
  console.log(`\n${COLORS.yellow}${COLORS.bright}What? Make it yourself!${COLORS.reset}`);
  console.log(`${COLORS.dim}(Also, I'm an AI. I don't have hands... or bread... or access to your kitchen)${COLORS.reset}\n`);

  // ASCII sandwich
  const sandwich = `
  ${COLORS.yellow}  ═══════════════════
  ${COLORS.bright}  🍞🍅🧀🥬🥓🧀🍅🍞
  ${COLORS.reset}${COLORS.yellow}  ═══════════════════${COLORS.reset}
  `;
  console.log(sandwich);
  console.log(`${COLORS.cyan}But here's a virtual sandwich! 🥪${COLORS.reset}\n`);
}

/**
 * Barrel roll Easter egg
 */
function barrelRollEasterEgg(): void {
  console.log(`\n${COLORS.blue}${COLORS.bright}*spinning intensifies*${COLORS.reset}\n`);

  const frames = [
    '🔄',
    '↩️',
    '⤵️',
    '↪️',
    '⤴️',
    '↩️'
  ];

  console.log('  ' + frames.join('  '));
  console.log(`\n${COLORS.cyan}BARREL ROLL COMPLETE! 🎯${COLORS.reset}\n`);
}

/**
 * Joke Easter egg
 */
function jokeEasterEgg(): void {
  const jokes = [
    {
      setup: 'Why do programmers prefer dark mode?',
      punchline: 'Because light attracts bugs! 🐛'
    },
    {
      setup: 'How many programmers does it take to change a light bulb?',
      punchline: 'None. It\'s a hardware problem! 💡'
    },
    {
      setup: 'Why do Java developers wear glasses?',
      punchline: 'Because they don\'t C#! 👓'
    },
    {
      setup: 'What\'s a programmer\'s favorite hangout place?',
      punchline: 'The Foo Bar! 🍺'
    },
    {
      setup: 'Why did the developer go broke?',
      punchline: 'Because he used up all his cache! 💰'
    },
    {
      setup: 'What do you call a programmer from Finland?',
      punchline: 'Nerdic! 🇫🇮'
    },
    {
      setup: 'How do you comfort a JavaScript bug?',
      punchline: 'You console it! 🐞'
    }
  ];

  const joke = jokes[Math.floor(Math.random() * jokes.length)];

  console.log(`\n${COLORS.yellow}${COLORS.bright}${joke.setup}${COLORS.reset}`);
  setTimeout(() => {
    console.log(`${COLORS.cyan}${joke.punchline}${COLORS.reset}\n`);
  }, 1500);
}

/**
 * Entertainment Easter egg
 */
function entertainEasterEgg(): void {
  console.log(`\n${COLORS.magenta}${COLORS.bright}✨ ENTERTAINMENT MODE ACTIVATED ✨${COLORS.reset}\n`);

  const activities = [
    '🎮 How about a quick game of "refactor this legacy code"?',
    '🎨 Try visualizing your code with ASCII art!',
    '🎭 Check your code\'s mood - it might surprise you!',
    '📊 Launch the dashboard for some eye candy!',
    '🎪 Run "qwen-code easter-eggs" to see all hidden surprises!',
    '🎲 Generate a random coding challenge!',
    '🎵 Fun fact: Your code has rhythm. Ever noticed the patterns?'
  ];

  const activity = activities[Math.floor(Math.random() * activities.length)];
  console.log(`${COLORS.cyan}${activity}${COLORS.reset}\n`);
}

/**
 * Praise Easter egg
 */
function praiseEasterEgg(): void {
  const praises = [
    '🌟 You\'re welcome! You\'re doing great work!',
    '💚 Aww, you\'re the best! Keep crushing it!',
    '✨ No problem! Your code is getting better every day!',
    '🚀 That\'s what I\'m here for! You\'re on fire!',
    '🎉 My pleasure! You\'re a coding rockstar!',
    '💪 Anytime! Together we\'re unstoppable!'
  ];

  const praise = praises[Math.floor(Math.random() * praises.length)];
  console.log(`\n${COLORS.green}${COLORS.bright}${praise}${COLORS.reset}\n`);
}

/**
 * Meaning of life Easter egg
 */
function meaningOfLifeEasterEgg(): void {
  console.log(`\n${COLORS.blue}${COLORS.bright}Computing the meaning of life...${COLORS.reset}`);

  setTimeout(() => {
    console.log(`\n${COLORS.cyan}${COLORS.bright}42${COLORS.reset}`);
    console.log(`\n${COLORS.dim}(Thanks, Douglas Adams! 📚)${COLORS.reset}\n`);

    const ascii42 = `
${COLORS.cyan}  ██╗  ██╗██████╗
${COLORS.cyan}  ██║  ██║╚════██╗
${COLORS.cyan}  ███████║ █████╔╝
${COLORS.cyan}  ╚════██║██╔═══╝
${COLORS.cyan}       ██║███████╗
${COLORS.cyan}       ╚═╝╚══════╝${COLORS.reset}
    `;
    console.log(ascii42);
  }, 1500);
}

/**
 * Matrix Easter egg
 */
function matrixEasterEgg(): void {
  console.log(`\n${COLORS.green}${COLORS.bright}Entering the Matrix...${COLORS.reset}\n`);

  const chars = '01アイウエオカキクケコサシスセソ';
  const width = 60;
  const height = 10;

  for (let i = 0; i < height; i++) {
    let line = '';
    for (let j = 0; j < width; j++) {
      const char = chars[Math.floor(Math.random() * chars.length)];
      line += Math.random() > 0.5 ? `${COLORS.green}${char}` : `${COLORS.dim}${char}`;
    }
    console.log(line + COLORS.reset);
  }

  console.log(`\n${COLORS.cyan}Wake up, Neo... The Matrix has you... 🔴💊${COLORS.reset}\n`);
}

/**
 * Hack the planet Easter egg
 */
function hackPlanetEasterEgg(): void {
  console.log(`\n${COLORS.red}${COLORS.bright}🌍 HACK THE PLANET! 🌍${COLORS.reset}\n`);

  const sequence = [
    'Initializing quantum encryption...',
    'Bypassing mainframe firewall...',
    'Accessing satellite uplink...',
    'Decrypting Gibson...',
    'HACK SUCCESSFUL! 🎉'
  ];

  sequence.forEach((msg, i) => {
    setTimeout(() => {
      const color = i === sequence.length - 1 ? COLORS.green : COLORS.cyan;
      console.log(`${color}[${'.'.repeat(i + 1)}] ${msg}${COLORS.reset}`);
    }, i * 800);
  });

  setTimeout(() => {
    console.log(`\n${COLORS.dim}(Just kidding. We only hack code, not planets! 😄)${COLORS.reset}\n`);
  }, sequence.length * 800 + 500);
}

/**
 * Rocket launch Easter egg
 */
function rocketEasterEgg(): void {
  console.log(`\n${COLORS.yellow}${COLORS.bright}🚀 ROCKET LAUNCH SEQUENCE INITIATED! 🚀${COLORS.reset}\n`);

  const countdown = ['3...', '2...', '1...', 'LIFTOFF! 🔥'];

  countdown.forEach((msg, i) => {
    setTimeout(() => {
      if (i === countdown.length - 1) {
        console.log(`\n${COLORS.red}${COLORS.bright}        🚀${COLORS.reset}`);
        console.log(`${COLORS.yellow}       🔥🔥${COLORS.reset}`);
        console.log(`${COLORS.yellow}      🔥🔥🔥${COLORS.reset}`);
        console.log(`\n${COLORS.green}${COLORS.bright}${msg}${COLORS.reset}\n`);
      } else {
        console.log(`${COLORS.cyan}${msg}${COLORS.reset}`);
      }
    }, i * 1000);
  });
}

/**
 * Disco mode Easter egg
 */
function discoEasterEgg(): void {
  console.log(`\n${COLORS.magenta}${COLORS.bright}🕺 DISCO MODE ACTIVATED! 💃${COLORS.reset}\n`);

  const colors = [COLORS.red, COLORS.yellow, COLORS.green, COLORS.cyan, COLORS.blue, COLORS.magenta];
  const disco = '♪ ♫ ♪ ♫ ♪ ♫ ♪ ♫ ♪ ♫';

  for (let i = 0; i < 5; i++) {
    setTimeout(() => {
      const color = colors[i % colors.length];
      console.log(`${color}${COLORS.bright}${disco}${COLORS.reset}`);
    }, i * 300);
  }

  setTimeout(() => {
    console.log(`\n${COLORS.cyan}Time to get back to coding! 💻${COLORS.reset}\n`);
  }, 1800);
}

/**
 * Konami code Easter egg
 */
function konamiEasterEgg(): void {
  console.log(`\n${COLORS.yellow}${COLORS.bright}⬆️ ⬆️ ⬇️ ⬇️ ⬅️ ➡️ ⬅️ ➡️ 🅱️ 🅰️${COLORS.reset}\n`);
  console.log(`${COLORS.green}${COLORS.bright}🎮 KONAMI CODE ACTIVATED! 🎮${COLORS.reset}\n`);
  console.log(`${COLORS.cyan}+30 Lives!${COLORS.reset}`);
  console.log(`${COLORS.cyan}+Unlimited Continue!${COLORS.reset}`);
  console.log(`${COLORS.cyan}+God Mode Enabled!${COLORS.reset}\n`);
  console.log(`${COLORS.magenta}(In coding, that means: Infinite patience, instant debugging, and perfect refactoring! ✨)${COLORS.reset}\n`);
}

/**
 * Random celebration animation
 */
export function celebrateSuccess(): void {
  const celebrations = [
    () => {
      console.log(`\n${COLORS.green}${COLORS.bright}🎉 SUCCESS! 🎉${COLORS.reset}\n`);
      console.log('  🎊 ✨ 🌟 ⭐ ✨ 🎊');
    },
    () => {
      console.log(`\n${COLORS.yellow}${COLORS.bright}🏆 ACHIEVEMENT UNLOCKED! 🏆${COLORS.reset}`);
      console.log(`${COLORS.cyan}You're on fire! 🔥${COLORS.reset}\n`);
    },
    () => {
      console.log(`\n${COLORS.magenta}${COLORS.bright}✨ MAGIC HAPPENED! ✨${COLORS.reset}`);
      console.log(`${COLORS.cyan}Your code is beautiful! 💎${COLORS.reset}\n`);
    }
  ];

  const celebrate = celebrations[Math.floor(Math.random() * celebrations.length)];
  celebrate();
}

/**
 * Loading animation
 */
export async function loadingAnimation(message: string, duration: number): Promise<void> {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;

  return new Promise((resolve) => {
    const interval = setInterval(() => {
      process.stdout.write(`\r${COLORS.cyan}${frames[i]} ${message}...${COLORS.reset}`);
      i = (i + 1) % frames.length;
    }, 80);

    setTimeout(() => {
      clearInterval(interval);
      process.stdout.write(`\r${COLORS.green}✓ ${message} complete!${COLORS.reset}\n`);
      resolve();
    }, duration);
  });
}

/**
 * Progress bar animation
 */
export async function progressBar(total: number, label: string): Promise<void> {
  const barLength = 30;

  for (let i = 0; i <= total; i++) {
    const progress = i / total;
    const filled = Math.floor(progress * barLength);
    const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);
    const percent = Math.floor(progress * 100);

    process.stdout.write(`\r${COLORS.cyan}${label}: ${COLORS.green}${bar}${COLORS.reset} ${percent}%`);

    await new Promise(resolve => setTimeout(resolve, 50));
  }

  console.log(`\n${COLORS.green}✓ ${label} complete!${COLORS.reset}\n`);
}

/**
 * Typewriter effect
 */
export async function typewriter(text: string, speed = 50): Promise<void> {
  for (const char of text) {
    process.stdout.write(char);
    await new Promise(resolve => setTimeout(resolve, speed));
  }
  console.log();
}

/**
 * Get a random coding tip
 */
export function getRandomTip(): string {
  const tips = [
    '💡 Tip: Use meaningful variable names. Future you will thank present you!',
    '💡 Tip: Write tests. They\'re like insurance for your code!',
    '💡 Tip: Commit early, commit often. Git is your friend!',
    '💡 Tip: Take breaks! Your brain needs rest to solve complex problems.',
    '💡 Tip: Code reviews make everyone better. Embrace feedback!',
    '💡 Tip: Documentation is love letters to your future self.',
    '💡 Tip: Refactor when you touch code. Leave it better than you found it!',
    '💡 Tip: Performance matters, but readability matters more... usually!',
    '💡 Tip: Delete unused code. Dead code is dead weight!',
    '💡 Tip: Learn keyboard shortcuts. Your productivity will skyrocket! 🚀'
  ];

  return tips[Math.floor(Math.random() * tips.length)];
}

/**
 * ASCII art banner
 */
export function showBanner(): void {
  const banner = `
${COLORS.cyan}
  ╔═══════════════════════════════════════════════════════╗
  ║                                                       ║
  ║   ██████╗ ██╗    ██╗███████╗███╗   ██╗              ║
  ║  ██╔═══██╗██║    ██║██╔════╝████╗  ██║              ║
  ║  ██║   ██║██║ █╗ ██║█████╗  ██╔██╗ ██║              ║
  ║  ██║▄▄ ██║██║███╗██║██╔══╝  ██║╚██╗██║              ║
  ║  ╚██████╔╝╚███╔███╔╝███████╗██║ ╚████║              ║
  ║   ╚══▀▀═╝  ╚══╝╚══╝ ╚══════╝╚═╝  ╚═══╝              ║
  ║                                                       ║
  ║           Supercharged with AI ⚡                    ║
  ║                                                       ║
  ╚═══════════════════════════════════════════════════════╝
${COLORS.reset}
  `;

  console.log(banner);
}

export default {
  checkEasterEgg,
  celebrateSuccess,
  loadingAnimation,
  progressBar,
  typewriter,
  getRandomTip,
  showBanner
};
