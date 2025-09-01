/**
 * Music Generator for QwenMusic
 * Converts code analysis into musical compositions
 */

export interface MusicGenerationOptions {
  style: string;
  tempo?: number;
  key?: string;
  duration: number;
  outputFormat: string;
}

export interface GeneratedMusic {
  metadata: {
    title: string;
    style: string;
    key: string;
    tempo: number;
    duration: number;
    timeSignature: string;
  };
  tracks: MusicTrack[];
  instruments: string[];
  chordProgressions: string[];
  rhythmPatterns: string[];
  sourceFiles: number;
  functionCount: number;
  variableCount: number;
  complexityScore: number;
  measures: number;
}

export interface MusicTrack {
  name: string;
  instrument: string;
  notes: MusicNote[];
  volume: number;
  pan: number;
}

export interface MusicNote {
  pitch: string;
  start: number;
  duration: number;
  velocity: number;
}

export class MusicGenerator {
  private readonly SCALES = {
    'C major': ['C', 'D', 'E', 'F', 'G', 'A', 'B'],
    'G major': ['G', 'A', 'B', 'C', 'D', 'E', 'F#'],
    'D major': ['D', 'E', 'F#', 'G', 'A', 'B', 'C#'],
    'A major': ['A', 'B', 'C#', 'D', 'E', 'F#', 'G#'],
    'E major': ['E', 'F#', 'G#', 'A', 'B', 'C#', 'D#'],
    'F major': ['F', 'G', 'A', 'Bb', 'C', 'D', 'E'],
    'Bb major': ['Bb', 'C', 'D', 'Eb', 'F', 'G', 'A'],
    'A minor': ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
    'E minor': ['E', 'F#', 'G', 'A', 'B', 'C', 'D'],
    'B minor': ['B', 'C#', 'D', 'E', 'F#', 'G', 'A']
  };

  private readonly CHORD_PROGRESSIONS = {
    classical: ['I', 'V', 'vi', 'IV', 'I', 'IV', 'V', 'I'],
    jazz: ['IIM7', 'V7', 'IM7', 'VIM7', 'IIM7', 'V7', 'IM7'],
    electronic: ['i', 'VI', 'III', 'VII', 'i', 'VI', 'III', 'VII'],
    ambient: ['I', 'iii', 'vi', 'IV', 'I', 'iii', 'vi', 'IV'],
    rock: ['I', 'VII', 'IV', 'I', 'V', 'IV', 'I']
  };

  private readonly INSTRUMENTS = {
    classical: ['piano', 'violin', 'cello', 'flute', 'oboe'],
    jazz: ['piano', 'trumpet', 'saxophone', 'double_bass', 'drums'],
    electronic: ['synthesizer', 'drum_machine', 'bass_synth', 'pad', 'arp'],
    ambient: ['pad', 'strings', 'bell', 'choir', 'atmosphere'],
    rock: ['electric_guitar', 'bass_guitar', 'drums', 'keyboard'],
    auto: ['synthesizer', 'piano', 'strings', 'bass']
  };

  async generate(analysis: any, options: MusicGenerationOptions): Promise<GeneratedMusic> {
    console.log(`🎼 Generating ${options.style} music...`);

    const scale = this.SCALES[options.key as keyof typeof this.SCALES] || this.SCALES['C major'];
    const chordProgression = this.CHORD_PROGRESSIONS[options.style as keyof typeof this.CHORD_PROGRESSIONS] || this.CHORD_PROGRESSIONS.electronic;
    const instruments = this.INSTRUMENTS[options.style as keyof typeof this.INSTRUMENTS] || this.INSTRUMENTS.auto;

    const tempo = options.tempo || this.calculateTempoFromComplexity(analysis.complexity.cyclomatic);
    const measures = Math.ceil((options.duration * tempo) / (60 * 4)); // 4/4 time signature

    // Create tracks based on code structure
    const tracks: MusicTrack[] = [];

    // Main melody track (based on functions)
    tracks.push(this.createMelodyTrack(analysis, scale, tempo, options.duration, instruments[0]));

    // Harmony track (based on variables and objects)
    tracks.push(this.createHarmonyTrack(analysis, scale, chordProgression, tempo, options.duration, instruments[1]));

    // Rhythm track (based on control structures)
    tracks.push(this.createRhythmTrack(analysis, tempo, options.duration, instruments[2] || 'drums'));

    // Bass track (based on file structure)
    tracks.push(this.createBassTrack(analysis, scale, tempo, options.duration, instruments[3] || 'bass'));

    // Ambient track (based on comments)
    if (analysis.commentLines > 0) {
      tracks.push(this.createAmbientTrack(analysis, scale, tempo, options.duration, instruments[4] || 'pad'));
    }

    const music: GeneratedMusic = {
      metadata: {
        title: `Code Symphony - ${path.basename(analysis.projectPath)}`,
        style: options.style,
        key: options.key || 'C major',
        tempo,
        duration: options.duration,
        timeSignature: '4/4'
      },
      tracks,
      instruments,
      chordProgressions: chordProgression,
      rhythmPatterns: this.generateRhythmPatterns(analysis),
      sourceFiles: analysis.files.length,
      functionCount: analysis.functionCount,
      variableCount: analysis.variableCount,
      complexityScore: analysis.complexity.cyclomatic,
      measures
    };

    return music;
  }

  private createMelodyTrack(analysis: any, scale: string[], tempo: number, duration: number, instrument: string): MusicTrack {
    const notes: MusicNote[] = [];
    const noteDuration = 60 / tempo; // Quarter note duration in seconds
    let currentTime = 0;

    // Generate melody based on function patterns
    const functionComplexity = analysis.functionCount || 1;
    const noteInterval = Math.max(0.25, Math.min(1, functionComplexity / 10));

    while (currentTime < duration) {
      const scaleIndex = Math.floor(Math.random() * scale.length);
      const octave = 4 + Math.floor(Math.random() * 2); // Octaves 4-5
      const pitch = scale[scaleIndex] + octave;
      
      // Vary note duration based on code complexity
      const noteDur = noteDuration * (0.5 + Math.random());
      
      // Vary velocity based on function importance
      const velocity = 0.5 + (Math.random() * 0.5);

      notes.push({
        pitch,
        start: currentTime,
        duration: noteDur,
        velocity
      });

      currentTime += noteDuration * noteInterval;
    }

    return {
      name: 'Function Melody',
      instrument,
      notes,
      volume: 0.8,
      pan: 0
    };
  }

  private createHarmonyTrack(analysis: any, scale: string[], chordProgression: string[], tempo: number, duration: number, instrument: string): MusicTrack {
    const notes: MusicNote[] = [];
    const chordDuration = (60 / tempo) * 4; // Whole note duration
    let currentTime = 0;
    let chordIndex = 0;

    while (currentTime < duration) {
      // Generate chord based on progression and variable patterns
      const chord = this.generateChord(scale, chordProgression[chordIndex % chordProgression.length]);
      
      chord.forEach((pitch, index) => {
        notes.push({
          pitch: pitch + '3', // Lower octave for harmony
          start: currentTime + (index * 0.1), // Slight arpeggio effect
          duration: chordDuration * 0.9,
          velocity: 0.4 + (analysis.variableCount / 100) * 0.3
        });
      });

      currentTime += chordDuration;
      chordIndex++;
    }

    return {
      name: 'Variable Harmony',
      instrument,
      notes,
      volume: 0.6,
      pan: -0.3
    };
  }

  private createRhythmTrack(analysis: any, tempo: number, duration: number, instrument: string): MusicTrack {
    const notes: MusicNote[] = [];
    const beatDuration = 60 / tempo / 4; // Sixteenth note duration
    let currentTime = 0;

    // Generate rhythm based on control structures
    const rhythmDensity = Math.min(1, analysis.controlStructures / 20);
    const beatPattern = this.generateBeatPattern(rhythmDensity);

    while (currentTime < duration) {
      beatPattern.forEach((beat, index) => {
        if (beat && currentTime + (index * beatDuration) < duration) {
          notes.push({
            pitch: 'C2', // Kick drum
            start: currentTime + (index * beatDuration),
            duration: beatDuration * 0.5,
            velocity: 0.8
          });
        }
      });

      currentTime += beatDuration * beatPattern.length;
    }

    return {
      name: 'Control Rhythm',
      instrument,
      notes,
      volume: 0.7,
      pan: 0
    };
  }

  private createBassTrack(analysis: any, scale: string[], tempo: number, duration: number, instrument: string): MusicTrack {
    const notes: MusicNote[] = [];
    const noteDuration = (60 / tempo) * 2; // Half note duration
    let currentTime = 0;

    // Generate bass line based on file structure
    const fileComplexity = analysis.files.length;
    const bassPattern = this.generateBassPattern(scale, fileComplexity);

    while (currentTime < duration) {
      bassPattern.forEach((pitch, index) => {
        if (currentTime + (index * noteDuration) < duration) {
          notes.push({
            pitch: pitch + '2', // Low octave
            start: currentTime + (index * noteDuration),
            duration: noteDuration * 0.8,
            velocity: 0.6
          });
        }
      });

      currentTime += noteDuration * bassPattern.length;
    }

    return {
      name: 'File Structure Bass',
      instrument,
      notes,
      volume: 0.8,
      pan: 0.3
    };
  }

  private createAmbientTrack(analysis: any, scale: string[], tempo: number, duration: number, instrument: string): MusicTrack {
    const notes: MusicNote[] = [];
    
    // Generate ambient textures based on comments
    const commentDensity = analysis.commentDensity;
    const ambientNotes = Math.ceil(commentDensity * 20);

    for (let i = 0; i < ambientNotes; i++) {
      const startTime = Math.random() * duration;
      const scaleIndex = Math.floor(Math.random() * scale.length);
      const octave = 5 + Math.floor(Math.random() * 2); // Higher octaves
      const pitch = scale[scaleIndex] + octave;
      
      notes.push({
        pitch,
        start: startTime,
        duration: 2 + Math.random() * 4, // Long, sustained notes
        velocity: 0.2 + Math.random() * 0.3
      });
    }

    return {
      name: 'Comment Ambience',
      instrument,
      notes,
      volume: 0.3,
      pan: Math.random() * 2 - 1 // Random panning
    };
  }

  private generateChord(scale: string[], chordType: string): string[] {
    // Simplified chord generation
    const root = scale[0];
    const third = scale[2];
    const fifth = scale[4];
    
    switch (chordType) {
      case 'I':
      case 'IM7':
        return [root, third, fifth];
      case 'V':
      case 'V7':
        return [scale[4], scale[6] || scale[0], scale[1]];
      case 'vi':
      case 'VIM7':
        return [scale[5], scale[0], scale[2]];
      case 'IV':
        return [scale[3], scale[5], scale[0]];
      default:
        return [root, third, fifth];
    }
  }

  private generateBeatPattern(density: number): boolean[] {
    const pattern: boolean[] = [];
    const patternLength = 16; // 16th notes in a measure
    
    for (let i = 0; i < patternLength; i++) {
      // Always hit on beats 1 and 3 (index 0, 8)
      if (i === 0 || i === 8) {
        pattern.push(true);
      }
      // Add additional hits based on density
      else if (Math.random() < density) {
        pattern.push(true);
      } else {
        pattern.push(false);
      }
    }
    
    return pattern;
  }

  private generateBassPattern(scale: string[], complexity: number): string[] {
    const pattern: string[] = [];
    const patternLength = Math.min(8, Math.max(2, Math.floor(complexity / 5)));
    
    for (let i = 0; i < patternLength; i++) {
      // Use root and fifth primarily, with some passing tones
      if (i % 2 === 0) {
        pattern.push(scale[0]); // Root
      } else {
        pattern.push(scale[4] || scale[1]); // Fifth or second
      }
    }
    
    return pattern;
  }

  private generateRhythmPatterns(analysis: any): string[] {
    const patterns = [];
    
    if (analysis.controlStructures > 5) {
      patterns.push('Complex polyrhythm');
    } else if (analysis.controlStructures > 2) {
      patterns.push('Moderate syncopation');
    } else {
      patterns.push('Simple steady beat');
    }
    
    if (analysis.asyncPatterns > analysis.syncPatterns) {
      patterns.push('Overlapping rhythms');
    }
    
    return patterns;
  }

  private calculateTempoFromComplexity(complexity: number): number {
    // Map complexity to musical tempo
    if (complexity < 2) return 60;  // Largo
    if (complexity < 5) return 80;  // Andante
    if (complexity < 8) return 100; // Moderato
    if (complexity < 12) return 120; // Allegro
    return 140; // Presto
  }
}

// Helper function for path operations
const path = {
  basename: (filePath: string): string => {
    return filePath.split('/').pop() || filePath;
  }
};