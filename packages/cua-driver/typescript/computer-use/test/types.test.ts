import type {
  ActAndVerifyResult,
  ComputerUse,
  ComputerUseActionResult,
  ComputerUseVerificationResult,
  ObserveWindowOptions,
} from "../index.js";

const invalidObservationOptions: ObserveWindowOptions = {
  pid: 42,
  windowId: 7,
  // @ts-expect-error revision cursors are owned by ComputerUse
  baseRevisionId: "l_manual:r1",
};
void invalidObservationOptions;

const invalidRevisionId: ObserveWindowOptions = {
  pid: 42,
  windowId: 7,
  // @ts-expect-error revision cursors are owned by ComputerUse
  revisionId: "l_manual:r2",
};
void invalidRevisionId;

const invalidObservationRevision: ObserveWindowOptions = {
  pid: 42,
  windowId: 7,
  // @ts-expect-error the native revision request is internal to ComputerUse
  observationRevision: { baseRevisionId: "l_manual:r1" },
};
void invalidObservationRevision;

const invalidLineageId: ObserveWindowOptions = {
  pid: 42,
  windowId: 7,
  // @ts-expect-error lineage state is owned by ComputerUse
  lineageId: "l_manual",
};
void invalidLineageId;

export async function exerciseComputerUseTypes(
  computer: ComputerUse,
  signal: AbortSignal,
): Promise<ActAndVerifyResult> {
  await computer.listApps({ signal });
  const observation = await computer.observeWindow({
    pid: 42,
    windowId: 7,
    disableDiff: false,
    includeScreenshot: true,
    signal,
  });
  observation.screenshot?.images.at(0)?.dataBase64;
  observation.elements.at(0)?.automation_id;
  observation.diagnostics.selectedBytes;
  observation.diagnostics.captureComplete;
  // @ts-expect-error revision identifiers are not public observation fields
  observation.revisionId;
  // @ts-expect-error base revision identifiers are not public observation fields
  observation.baseRevisionId;
  // @ts-expect-error lineage identifiers are not public observation fields
  observation.lineageId;
  // @ts-expect-error raw native payloads are not public observation fields
  observation.structured;
  const result = await computer.actAndVerify({
    action: () =>
      computer.click({
        pid: 42,
        windowId: 7,
        x: 10,
        y: 20,
        deliveryMode: "foreground",
        signal,
      }),
    verify: (_action: ComputerUseActionResult) =>
      computer.verifyState({
        pid: 42,
        windowId: 7,
        expect: [{ element: { token: "rv1:l_a:1", selected: true } }],
        signal,
      }),
  });
  const verification: ComputerUseVerificationResult = result.verification;
  verification.verification?.predicates.at(0);
  result.action.action?.evidence?.at(0);
  (await computer.sessionInfo()).expiresInSeconds;
  computer.connectionGeneration;
  return result;
}
