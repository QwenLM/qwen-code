import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';

export async function migrateMemory({ selective = false, dryRun = false }: { selective?: boolean, dryRun?: boolean } = {}): Promise<void> {
  try {
    // Source: global memory file
    const globalPath = path.join(homedir(), '.qwen', 'QWEN.md');
    
    // Destination: project memory file
    const projectPath = path.join(process.cwd(), 'QWEN.md');
    
    // Check if source file exists
    try {
      await fs.access(globalPath, fs.constants.R_OK);
    } catch {
      console.error(`Source file not found: ${globalPath}`);
      return;
    }
    
    // Check if destination file exists
    try {
      await fs.access(projectPath, fs.constants.R_OK);
      if (selective) {
        console.log(`Project-specific memory file already exists at ${projectPath}. Skipping migration.`);
        return;
      }
    } catch {
      // Project-specific file doesn't exist, create it
      console.log(`Project-specific memory file does not exist. Creating at ${projectPath}.`);
    }
    
    // If dryRun is true, only log what would be done
    if (dryRun) {
      console.log(`Would migrate memories from ${globalPath} to ${projectPath}.`);
      return;
    }
    
    // Create project-specific memory file with the same content as global
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    const globalContent = await fs.readFile(globalPath, 'utf-8');
    await fs.writeFile(projectPath, globalContent, 'utf-8');
    
    console.log(`Successfully migrated memories from ${globalPath} to ${projectPath}.`);
  } catch (error) {
    console.error(`Error during migration: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Export for CLI usage
export { migrateMemory };