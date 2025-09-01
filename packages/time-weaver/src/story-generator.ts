import { QwenCodeCore } from '@qwen-code/qwen-code-core';
import { simpleGit, SimpleGit } from 'simple-git';
import moment from 'moment';

interface GitCommit {
  hash: string;
  date: string;
  author: string;
  message: string;
  files: string[];
}

export class StoryGenerator {
  private qwenCore: QwenCodeCore;
  private git: SimpleGit;

  constructor() {
    this.qwenCore = new QwenCodeCore();
    this.git = simpleGit();
  }

  async generateStory(repoPath: string, genre: string, length: number, commitCount: number): Promise<string> {
    try {
      // Change to repository directory
      this.git.cwd(repoPath);
      
      // Get recent commits
      const commits = await this.getRecentCommits(commitCount);
      
      // Analyze commit patterns
      const patterns = this.analyzeCommitPatterns(commits);
      
      // Generate story using Qwen-Code
      const storyPrompt = this.buildStoryPrompt(patterns, genre, length);
      const story = await this.qwenCore.generateCode(storyPrompt);
      
      return this.formatStory(story, patterns, genre);
      
    } catch (error) {
      console.error('Error generating story:', error);
      return this.generateFallbackStory(repoPath, genre, length);
    }
  }

  private async getRecentCommits(count: number): Promise<GitCommit[]> {
    const log = await this.git.log({ maxCount: count });
    
    return log.all.map(commit => ({
      hash: commit.hash,
      date: commit.date,
      author: commit.author_name,
      message: commit.message,
      files: commit.diff?.files?.map(f => f.file) || []
    }));
  }

  private analyzeCommitPatterns(commits: GitCommit[]): any {
    const patterns = {
      frequency: commits.length,
      timeSpan: this.calculateTimeSpan(commits),
      authors: [...new Set(commits.map(c => c.author))],
      fileTypes: this.analyzeFileTypes(commits),
      commitMessages: commits.map(c => c.message),
      activityPattern: this.analyzeActivityPattern(commits)
    };
    
    return patterns;
  }

  private calculateTimeSpan(commits: GitCommit[]): string {
    if (commits.length < 2) return 'single moment';
    
    const first = moment(commits[0].date);
    const last = moment(commits[commits.length - 1].date);
    const diff = moment.duration(last.diff(first));
    
    if (diff.asDays() < 1) return 'single day';
    if (diff.asDays() < 7) return 'week';
    if (diff.asDays() < 30) return 'month';
    return 'extended period';
  }

  private analyzeFileTypes(commits: GitCommit[]): string[] {
    const extensions = new Set<string>();
    
    commits.forEach(commit => {
      commit.files.forEach(file => {
        const ext = file.split('.').pop()?.toLowerCase();
        if (ext) extensions.add(ext);
      });
    });
    
    return Array.from(extensions);
  }

  private analyzeActivityPattern(commits: GitCommit[]): string {
    const hourlyActivity = new Array(24).fill(0);
    
    commits.forEach(commit => {
      const hour = moment(commit.date).hour();
      hourlyActivity[hour]++;
    });
    
    const maxHour = hourlyActivity.indexOf(Math.max(...hourlyActivity));
    
    if (maxHour >= 9 && maxHour <= 17) return 'daytime worker';
    if (maxHour >= 18 && maxHour <= 23) return 'night owl';
    if (maxHour >= 0 && maxHour <= 8) return 'early bird';
    return 'irregular pattern';
  }

  private buildStoryPrompt(patterns: any, genre: string, length: number): string {
    return `Create a ${genre} time travel story of approximately ${length} words based on this Git repository activity:

Repository Patterns:
- ${patterns.frequency} commits over ${patterns.timeSpan}
- Authors: ${patterns.authors.join(', ')}
- File types: ${patterns.fileTypes.join(', ')}
- Activity pattern: ${patterns.activityPattern}
- Recent commit messages: ${patterns.commitMessages.slice(0, 3).join('; ')}

The story should:
- Use the commit history as a timeline for time travel
- Incorporate the file types and commit messages as plot elements
- Feature the authors as characters in the story
- Follow ${genre} genre conventions
- Be creative and unexpected yet coherent

Make it feel like the Git history has been transformed into an epic narrative.`;
  }

  private formatStory(story: string, patterns: any, genre: string): string {
    return `⏰ TIME TRAVEL STORY (${genre.toUpperCase()})
${'='.repeat(60)}

${story}

${'='.repeat(60)}
📚 Generated from ${patterns.frequency} Git commits by Time Weaver AI
👥 Characters: ${patterns.authors.join(', ')}
🕐 Timeline: ${patterns.timeSpan}
💻 File types: ${patterns.fileTypes.join(', ')}
🌙 Activity: ${patterns.activityPattern}`;
  }

  private generateFallbackStory(repoPath: string, genre: string, length: number): string {
    return `⏰ TIME TRAVEL STORY (${genre.toUpperCase()})
${'='.repeat(60)}

The Quantum Repository

In the depths of cyberspace, a mysterious repository pulsed with temporal energy. Each commit was a ripple in the fabric of time, each branch a parallel universe waiting to be explored.

Dr. ${repoPath.split('/').pop() || 'Developer'} discovered that their Git history contained more than just code changes—it was a map to different points in spacetime. Every merge conflict became a temporal paradox, every rebase a journey through alternate timelines.

The repository's commit messages told stories of bug fixes that prevented digital apocalypses, feature additions that opened portals to new dimensions, and refactoring that stabilized the very fabric of reality itself.

As they navigated through the commit history, they encountered versions of themselves from different timelines, each working on the same project but with different approaches. Some had discovered the secret of time travel, others had built machines to manipulate the quantum state of code.

The final commit would either save all timelines or collapse them into a single, chaotic reality. The choice lay in the hands of the developer who could see beyond the code, into the temporal currents that flowed through every line and function.

${'='.repeat(60)}
📚 Generated from Git repository by Time Weaver AI
🌌 Genre: ${genre}
📏 Length: ${length} words (approximate)`;
  }
}