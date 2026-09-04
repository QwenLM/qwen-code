import type {
  ActAndVerifyResult,
  ComputerUse,
  ComputerUseActionResult,
  ComputerUseVerificationResult,
} from "../index.js";

export async function exerciseComputerUseTypes(
  computer: ComputerUse,
  signal: AbortSignal,
): Promise<ActAndVerifyResult> {
  await computer.listApps({ signal });
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
