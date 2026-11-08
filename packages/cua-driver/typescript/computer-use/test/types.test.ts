import { createCua, type RuntimeOutput } from '../runtime.js';
import { ComputerUse } from '../index.js';
async function useRuntime(output: RuntimeOutput) {
  const computer = await ComputerUse.create();
  const cua = createCua(output, { computer });
  const app = await cua.getApp('Editor');
  const text: string = await app.getAXState({ forceFull: true, maxTextChars: 20000, emit: false });
  const action: void = await app.click(1, { key: ['shift'] });
  await app.setValue(2, text);
  await app.typeText('你好');
  await app.getScreenshot();
  await app.drag({ fromX: 1, fromY: 2, toX: 3, toY: 4 });
  // @ts-expect-error Native targeting belongs to the driver.
  await app.click(1, { pid: 1 });
  // @ts-expect-error App state is rendered text.
  text.elements;
  await computer.close();
  return action;
}
void useRuntime;
