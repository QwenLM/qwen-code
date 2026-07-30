import fs from 'node:fs';

const head = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

const rows = [];
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  rows.push({ name, ok, detail });
  ok ? pass++ : fail++;
};

check(
  'head/drain: SIGTERM landed inside the admitted batch (measured, not assumed)',
  head.sigtermDelay < head.naturalMs &&
    head.timings.sigtermToRaceDoneMs > 0 &&
    head.timings.raceDoneAt > head.timings.sigtermAt,
  `natural=${head.naturalMs}ms sigtermAt=+${head.sigtermDelay}ms sigtermToRaceDone=${head.timings.sigtermToRaceDoneMs}ms`,
);
check(
  'head/drain: the admitted batch still completed after SIGTERM',
  head.race.status === 200 && head.race.json.archived.count === 100,
  JSON.stringify(head.race),
);
check(
  'head/drain: its 100 transcripts really reached the archive directory',
  head.movedRace === 100 && head.stillActiveRace === 0,
  `moved=${head.movedRace} stillActive=${head.stillActiveRace}`,
);
check(
  'head/drain: maintenance admitted after SIGTERM is refused 503 daemon_draining',
  head.late.status === 503 &&
    head.late.json.code === 'daemon_draining' &&
    head.late.json.errorKind === 'daemon_draining',
  JSON.stringify(head.late),
);
check(
  'head/drain: the refused request mutated nothing',
  head.lateStillActive === true,
  `transcript still active = ${head.lateStillActive}`,
);
check(
  'head/drain: the process exited only after the admitted batch responded',
  head.timings.raceDoneBeforeExit === true,
  JSON.stringify(head.timings),
);

check(
  'base/drain: CONTROL — base accepts maintenance after SIGTERM and deletes the transcript (expected red)',
  base.late.status === 200 &&
    base.late.json.removed?.length === 1 &&
    base.lateStillActive === false,
  JSON.stringify(base.late),
);

for (const r of rows) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(`      ${r.detail}`);
}
console.log(`\npass=${pass} fail=${fail} total=${pass + fail}`);
console.log(
  `note: batch-of-100 archive latency head=${head.naturalMs}ms base=${base.naturalMs}ms ` +
    `(delta=${head.naturalMs - base.naturalMs}ms, ${((head.naturalMs - base.naturalMs) / 100).toFixed(1)}ms/session)`,
);
fs.writeFileSync(
  process.argv[4],
  JSON.stringify(
    {
      pass,
      fail,
      total: pass + fail,
      rows,
      latency: { headMs: head.naturalMs, baseMs: base.naturalMs },
    },
    null,
    2,
  ),
);
process.exit(fail === 0 ? 0 : 1);
