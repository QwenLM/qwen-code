import { LTMatch } from './ltClient.js';
export type LTPolicy = 'off' | 'confirm' | 'auto-first' | 'auto-best';
export type LTOptions = {
    enabled: boolean;
    policy: LTPolicy;
    server: string;
    language: string;
    motherTongue?: string;
    rulesOn?: string[];
    rulesOff?: string[];
    level?: 'default' | 'picky';
};
export type LTResult = {
    original: string;
    corrected: string;
    changes: number;
    matches: LTMatch[];
    applied: boolean;
    policy: LTPolicy;
};
export declare function preprocessUserInput(raw: string, opts: LTOptions, confirmFn?: (orig: string, corrected: string, matches: LTMatch[]) => Promise<boolean>): Promise<LTResult>;
