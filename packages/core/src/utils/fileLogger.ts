import fs from 'fs';
import path from 'path';
import os from 'os';
import { GenerateContentResponseUsageMetadata } from '@google/genai';

const usageDataPath = path.join(os.homedir(), '.qwen', 'usage-analytics.json');

export interface UsageData {
    timestamp: number;
    command: string;
    tokens: number;
}

export function logUsageData(command: string, usageMetadata?: GenerateContentResponseUsageMetadata): void {
    if (!usageMetadata) {
        return;
    }

    const usageData: UsageData = {
        timestamp: Date.now(),
        command,
        tokens: usageMetadata.totalTokenCount || 0,
    };

    let allUsageData: UsageData[] = [];
    try {
        if (fs.existsSync(usageDataPath)) {
            const fileContent = fs.readFileSync(usageDataPath, 'utf-8');
            allUsageData = JSON.parse(fileContent);
        }
    } catch (error) {
        // Ignore errors, we'll just create a new file
    }

    allUsageData.push(usageData);

    try {
        fs.mkdirSync(path.dirname(usageDataPath), { recursive: true });
        fs.writeFileSync(usageDataPath, JSON.stringify(allUsageData, null, 2));
    } catch (error) {
        // Ignore errors
    }
}
