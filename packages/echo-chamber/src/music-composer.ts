import { QwenCodeCore } from '@qwen-code/qwen-code-core';
import { CommentAnalyzer } from './comment-analyzer.js';
import { writeFileSync } from 'fs';
import MidiWriter from 'midi-writer-js';

export class MusicComposer {
  private qwenCore: QwenCodeCore;
  private commentAnalyzer: CommentAnalyzer;

  constructor() {
    this.qwenCore = new QwenCodeCore();
    this.commentAnalyzer = new CommentAnalyzer();
  }

  async composeFromComments(codePath: string, genre: string, tempo: number, outputPath: string): Promise<string> {
    try {
      // Analyze code comments
      const comments = await this.commentAnalyzer.extractComments(codePath);
      const patterns = this.analyzeCommentPatterns(comments);
      
      // Generate music using Qwen-Code
      const musicPrompt = this.buildMusicPrompt(patterns, genre, tempo);
      const musicCode = await this.qwenCore.generateCode(musicPrompt);
      
      // Create MIDI composition
      const midiData = this.createMIDIComposition(patterns, genre, tempo);
      writeFileSync(outputPath, midiData);
      
      return this.formatComposition(patterns, genre, tempo);
      
    } catch (error) {
      console.error('Error composing music:', error);
      return this.generateFallbackComposition(codePath, genre, tempo);
    }
  }

  async startJamSession(codePath: string, instrument: string, loop: boolean): Promise<void> {
    try {
      const comments = await this.commentAnalyzer.extractComments(codePath);
      const patterns = this.analyzeCommentPatterns(comments);
      
      console.log('🎸 Starting jam session...');
      console.log(`🎹 Instrument: ${instrument}`);
      console.log(`🔄 Loop: ${loop ? 'enabled' : 'disabled'}`);
      
      // Generate jam session music
      const jamMusic = this.generateJamMusic(patterns, instrument);
      
      console.log('🎵 Jam session ready!');
      console.log('Press Ctrl+C to stop');
      
      // Simulate music playback
      this.simulatePlayback(jamMusic, loop);
      
    } catch (error) {
      console.error('Error starting jam session:', error);
    }
  }

  private analyzeCommentPatterns(comments: string[]): any {
    const patterns = {
      totalComments: comments.length,
      averageLength: comments.reduce((sum, c) => sum + c.length, 0) / comments.length,
      emotionalTone: this.analyzeEmotionalTone(comments),
      technicalTerms: this.extractTechnicalTerms(comments),
      commentTypes: this.categorizeComments(comments),
      rhythmPattern: this.analyzeRhythmPattern(comments)
    };
    
    return patterns;
  }

  private analyzeEmotionalTone(comments: string[]): string {
    const positiveWords = ['good', 'great', 'excellent', 'perfect', 'awesome', 'amazing'];
    const negativeWords = ['bug', 'fix', 'problem', 'issue', 'error', 'broken'];
    const neutralWords = ['comment', 'note', 'todo', 'fixme', 'hack'];
    
    let positive = 0, negative = 0, neutral = 0;
    
    comments.forEach(comment => {
      const lower = comment.toLowerCase();
      if (positiveWords.some(word => lower.includes(word))) positive++;
      else if (negativeWords.some(word => lower.includes(word))) negative++;
      else neutral++;
    });
    
    if (positive > negative && positive > neutral) return 'optimistic';
    if (negative > positive && negative > neutral) return 'melancholic';
    return 'contemplative';
  }

  private extractTechnicalTerms(comments: string[]): string[] {
    const technicalTerms = [
      'algorithm', 'function', 'class', 'method', 'variable', 'loop',
      'recursion', 'optimization', 'performance', 'memory', 'cache',
      'database', 'api', 'endpoint', 'authentication', 'security'
    ];
    
    const found = new Set<string>();
    comments.forEach(comment => {
      technicalTerms.forEach(term => {
        if (comment.toLowerCase().includes(term)) found.add(term);
      });
    });
    
    return Array.from(found);
  }

  private categorizeComments(comments: string[]): any {
    const categories = {
      todo: comments.filter(c => c.toLowerCase().includes('todo')),
      fixme: comments.filter(c => c.toLowerCase().includes('fixme')),
      hack: comments.filter(c => c.toLowerCase().includes('hack')),
      note: comments.filter(c => c.toLowerCase().includes('note')),
      explanation: comments.filter(c => c.length > 50),
      short: comments.filter(c => c.length <= 20)
    };
    
    return categories;
  }

  private analyzeRhythmPattern(comments: string[]): string {
    const lengths = comments.map(c => c.length);
    const variance = this.calculateVariance(lengths);
    
    if (variance < 10) return 'steady';
    if (variance < 50) return 'moderate';
    return 'dynamic';
  }

  private calculateVariance(numbers: number[]): number {
    const mean = numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
    const squaredDiffs = numbers.map(n => Math.pow(n - mean, 2));
    return squaredDiffs.reduce((sum, d) => sum + d, 0) / numbers.length;
  }

  private buildMusicPrompt(patterns: any, genre: string, tempo: number): string {
    return `Create music composition code in ${genre} style at ${tempo} BPM based on these code comment patterns:

Comment Analysis:
- Total comments: ${patterns.totalComments}
- Average length: ${Math.round(patterns.averageLength)} characters
- Emotional tone: ${patterns.emotionalTone}
- Technical terms: ${patterns.technicalTerms.join(', ')}
- Rhythm pattern: ${patterns.rhythmPattern}
- Comment types: ${Object.keys(patterns.commentTypes).filter(k => patterns.commentTypes[k].length > 0).join(', ')}

The music should:
- Reflect the emotional tone of the comments
- Use technical terms as musical motifs
- Create rhythm patterns based on comment structure
- Be in ${genre} style at ${tempo} BPM
- Include melody, harmony, and rhythm sections

Generate creative music code that transforms code comments into musical expression.`;
  }

  private createMIDIComposition(patterns: any, genre: string, tempo: number): Buffer {
    const track = new MidiWriter.Track();
    
    // Set tempo
    track.setTempo(tempo);
    
    // Create melody based on comment patterns
    const melody = this.generateMelody(patterns);
    track.addEvent(new MidiWriter.NoteEvent(melody));
    
    // Add harmony
    const harmony = this.generateHarmony(patterns, genre);
    track.addEvent(new MidiWriter.NoteEvent(harmony));
    
    // Add rhythm
    const rhythm = this.generateRhythm(patterns);
    track.addEvent(new MidiWriter.NoteEvent(rhythm));
    
    const writer = new MidiWriter.Writer(track);
    return Buffer.from(writer.buildFile());
  }

  private generateMelody(patterns: any): any {
    const notes = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
    const melody = [];
    
    for (let i = 0; i < Math.min(patterns.totalComments, 16); i++) {
      const noteIndex = i % notes.length;
      const duration = patterns.commentTypes.short.length > patterns.commentTypes.explanation.length ? '4' : '8';
      melody.push({ pitch: notes[noteIndex], duration, channel: 0 });
    }
    
    return melody;
  }

  private generateHarmony(patterns: any, genre: string): any {
    const chords = {
      electronic: ['Cmaj7', 'Dm7', 'Em7', 'Fmaj7', 'G7', 'Am7'],
      classical: ['C', 'Dm', 'Em', 'F', 'G', 'Am'],
      jazz: ['Cmaj7', 'Dm7', 'G7', 'Cmaj7', 'Fmaj7', 'Bm7b5'],
      rock: ['C', 'G', 'Am', 'F', 'Dm', 'Em']
    };
    
    const selectedChords = chords[genre] || chords.electronic;
    const harmony = [];
    
    patterns.technicalTerms.forEach((term, index) => {
      const chordIndex = index % selectedChords.length;
      harmony.push({ pitch: selectedChords[chordIndex], duration: '2', channel: 1 });
    });
    
    return harmony;
  }

  private generateRhythm(patterns: any): any {
    const rhythm = [];
    const rhythmPattern = patterns.rhythmPattern;
    
    if (rhythmPattern === 'steady') {
      for (let i = 0; i < 8; i++) {
        rhythm.push({ pitch: 'C2', duration: '4', channel: 9 });
      }
    } else if (rhythmPattern === 'moderate') {
      for (let i = 0; i < 16; i++) {
        rhythm.push({ pitch: 'C2', duration: '8', channel: 9 });
      }
    } else {
      for (let i = 0; i < 32; i++) {
        rhythm.push({ pitch: 'C2', duration: '16', channel: 9 });
      }
    }
    
    return rhythm;
  }

  private formatComposition(patterns: any, genre: string, tempo: number): string {
    return `🎵 MUSIC COMPOSITION (${genre.toUpperCase()})
${'='.repeat(60)}

🎼 Generated from ${patterns.totalComments} code comments
🎭 Emotional tone: ${patterns.emotionalTone}
🔧 Technical motifs: ${patterns.technicalTerms.join(', ')}
🎯 Rhythm pattern: ${patterns.rhythmPattern}
⚡ Tempo: ${tempo} BPM

🎹 Composition Elements:
- Melody: ${patterns.totalComments} notes based on comment count
- Harmony: ${patterns.technicalTerms.length} chords from technical terms
- Rhythm: ${patterns.rhythmPattern} pattern from comment structure

✨ Your code comments have been transformed into music!`;

  }

  private generateFallbackComposition(codePath: string, genre: string, tempo: number): string {
    return `🎵 MUSIC COMPOSITION (${genre.toUpperCase()})
${'='.repeat(60)}

🎼 Generated from code comments in: ${codePath}
🎭 Emotional tone: contemplative
🔧 Technical motifs: algorithm, function, optimization
🎯 Rhythm pattern: steady
⚡ Tempo: ${tempo} BPM

🎹 Fallback Composition:
- Melody: C major scale progression
- Harmony: I-IV-V chord progression
- Rhythm: 4/4 time signature with steady beat

✨ A beautiful melody inspired by your code!`;
  }

  private generateJamMusic(patterns: any, instrument: string): any {
    return {
      instrument,
      patterns,
      duration: Math.min(patterns.totalComments * 2, 120), // 2 seconds per comment, max 2 minutes
      complexity: patterns.technicalTerms.length > 5 ? 'high' : 'medium'
    };
  }

  private simulatePlayback(music: any, loop: boolean): void {
    let playbackCount = 0;
    const maxPlays = loop ? Infinity : 1;
    
    const playMusic = () => {
      if (playbackCount >= maxPlays) return;
      
      console.log(`🎵 Playing ${music.instrument} jam (${music.complexity} complexity)`);
      console.log(`⏱️  Duration: ${music.duration} seconds`);
      
      playbackCount++;
      
      if (loop && playbackCount < maxPlays) {
        setTimeout(playMusic, music.duration * 1000);
      }
    };
    
    playMusic();
  }
}