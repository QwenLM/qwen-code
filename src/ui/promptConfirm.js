export async function promptConfirmOnTty(question) {
    if (!process.stdin.isTTY) {
        // Se não estiver em um terminal, assume "não" para não travar
        return false;
    }
    return await new Promise((resolve) => {
        process.stdout.write(question);
        process.stdin.setEncoding('utf8');
        process.stdin.once('data', (d) => {
            const s = String(d || '')
                .trim()
                .toLowerCase();
            resolve(s === 'y' || s === 'yes' || s === 's' || s === 'sim');
        });
    });
}
//# sourceMappingURL=promptConfirm.js.map