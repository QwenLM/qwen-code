export type LTMatch = {
    message: string;
    shortMessage?: string;
    offset: number;
    length: number;
    replacements?: {
        value: string;
    }[];
    rule?: {
        id?: string;
        ruleId?: string;
        description?: string;
        issueType?: string;
    };
    context?: {
        text: string;
        offset: number;
        length: number;
    };
};
export type LTCheckParams = {
    server?: string;
    text: string;
    language?: string;
    motherTongue?: string;
    enabledRules?: string[];
    disabledRules?: string[];
    level?: 'default' | 'picky';
};
export type LTCheckResponse = {
    matches: LTMatch[];
    language?: {
        name?: string;
        code?: string;
        detected?: boolean;
    };
};
export declare function checkText({ server, text, language, motherTongue, enabledRules, disabledRules, level, }: LTCheckParams): Promise<LTCheckResponse>;
/** Aplica substituições sem quebrar offsets (varre da esquerda p/ direita). */
export declare function applySuggestions(original: string, matches: LTMatch[], strategy?: 'first' | 'best'): {
    text: string;
    changes: number;
};
