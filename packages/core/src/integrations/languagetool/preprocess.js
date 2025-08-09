import { checkText, applySuggestions } from './ltClient.js';
export async function preprocessUserInput(raw, opts, 
// se quiser perguntar ao usuário: passe um callback (opcional)
confirmFn) {
    const safeOpts = {
        enabled: opts.enabled ?? false,
        policy: opts.policy ?? 'off',
        server: opts.server ?? 'http://localhost:8081',
        language: opts.language ?? 'pt-BR',
        motherTongue: opts.motherTongue,
        rulesOn: opts.rulesOn,
        rulesOff: opts.rulesOff,
        level: opts.level ?? 'default',
    };
    if (!safeOpts.enabled || safeOpts.policy === 'off' || !raw.trim()) {
        return {
            original: raw,
            corrected: raw,
            changes: 0,
            matches: [],
            applied: false,
            policy: safeOpts.policy,
        };
    }
    const res = await checkText({
        server: safeOpts.server,
        text: raw,
        language: safeOpts.language,
        motherTongue: safeOpts.motherTongue,
        enabledRules: safeOpts.rulesOn,
        disabledRules: safeOpts.rulesOff,
        level: safeOpts.level,
    });
    const strategy = safeOpts.policy === 'auto-best' ? 'best' : 'first';
    const { text: corrected, changes } = applySuggestions(raw, res.matches ?? [], strategy);
    // Sem mudanças -> nada a fazer
    if (!changes) {
        return {
            original: raw,
            corrected: raw,
            changes: 0,
            matches: res.matches ?? [],
            applied: false,
            policy: safeOpts.policy,
        };
    }
    // confirmar?
    if (safeOpts.policy === 'confirm' && confirmFn) {
        const ok = await confirmFn(raw, corrected, res.matches ?? []);
        return {
            original: raw,
            corrected: ok ? corrected : raw,
            changes: ok ? changes : 0,
            matches: res.matches ?? [],
            applied: !!ok,
            policy: safeOpts.policy,
        };
    }
    // auto
    return {
        original: raw,
        corrected,
        changes,
        matches: res.matches ?? [],
        applied: true,
        policy: safeOpts.policy,
    };
}
//# sourceMappingURL=preprocess.js.map