/** Typed arguments and same-application serialization; all target state lives in the driver. */
export class ComputerUseApp {
  #computer;
  #selector;
  #tail = Promise.resolve();
  constructor(computer, selector, name) {
    this.#computer = computer;
    this.#selector = selector;
    this.name = name;
  }
  call(name, args = {}, options = {}) {
    const pending = this.#tail.catch(() => {}).then(() =>
      this.#computer.appCall(name, { ...args, app: this.#selector }, options));
    this.#tail = pending;
    return pending;
  }
}
