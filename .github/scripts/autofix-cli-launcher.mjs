const candidateCli = process.env['AUTOFIX_CANDIDATE_CLI'];
const uid = Number(process.env['AUTOFIX_VERIFY_UID']);
const gid = Number(process.env['AUTOFIX_VERIFY_GID']);

if (!candidateCli || !Number.isInteger(uid) || !Number.isInteger(gid)) {
  throw new Error('Missing isolated candidate CLI configuration');
}

process.setgroups([]);
process.setgid(gid);
process.setuid(uid);

const candidate = await import(candidateCli);
if (typeof candidate.runCliEntryPoint !== 'function') {
  throw new Error('Candidate CLI does not export runCliEntryPoint');
}
await candidate.runCliEntryPoint();
