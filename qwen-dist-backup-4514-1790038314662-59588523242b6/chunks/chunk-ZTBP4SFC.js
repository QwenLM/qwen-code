// Force strict mode and setup for ESM
"use strict";
import {
  require_react
} from "./chunk-5QWWOFGG.js";
import {
  eastAsianWidth,
  isFullWidth,
  isWide
} from "./chunk-QHTIBUWB.js";
import {
  stripAnsi
} from "./chunk-TWPJO254.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __commonJS,
  __export,
  __name,
  __require,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// node_modules/ink/node_modules/signal-exit/signals.js
var require_signals = __commonJS({
  "node_modules/ink/node_modules/signal-exit/signals.js"(exports, module) {
    init_esbuild_shims();
    module.exports = [
      "SIGABRT",
      "SIGALRM",
      "SIGHUP",
      "SIGINT",
      "SIGTERM"
    ];
    if (process.platform !== "win32") {
      module.exports.push(
        "SIGVTALRM",
        "SIGXCPU",
        "SIGXFSZ",
        "SIGUSR2",
        "SIGTRAP",
        "SIGSYS",
        "SIGQUIT",
        "SIGIOT"
        // should detect profiler and enable/disable accordingly.
        // see #21
        // 'SIGPROF'
      );
    }
    if (process.platform === "linux") {
      module.exports.push(
        "SIGIO",
        "SIGPOLL",
        "SIGPWR",
        "SIGSTKFLT",
        "SIGUNUSED"
      );
    }
  }
});

// node_modules/ink/node_modules/signal-exit/index.js
var require_signal_exit = __commonJS({
  "node_modules/ink/node_modules/signal-exit/index.js"(exports, module) {
    init_esbuild_shims();
    var process14 = globalThis.process;
    var processOk = /* @__PURE__ */ __name(function(process15) {
      return process15 && typeof process15 === "object" && typeof process15.removeListener === "function" && typeof process15.emit === "function" && typeof process15.reallyExit === "function" && typeof process15.listeners === "function" && typeof process15.kill === "function" && typeof process15.pid === "number" && typeof process15.on === "function";
    }, "processOk");
    if (!processOk(process14)) {
      module.exports = function() {
        return function() {
        };
      };
    } else {
      assert = __require("assert");
      signals = require_signals();
      isWin = /^win/i.test(process14.platform);
      EE = __require("events");
      if (typeof EE !== "function") {
        EE = EE.EventEmitter;
      }
      if (process14.__signal_exit_emitter__) {
        emitter = process14.__signal_exit_emitter__;
      } else {
        emitter = process14.__signal_exit_emitter__ = new EE();
        emitter.count = 0;
        emitter.emitted = {};
      }
      if (!emitter.infinite) {
        emitter.setMaxListeners(Infinity);
        emitter.infinite = true;
      }
      module.exports = function(cb, opts) {
        if (!processOk(globalThis.process)) {
          return function() {
          };
        }
        assert.equal(typeof cb, "function", "a callback must be provided for exit handler");
        if (loaded === false) {
          load();
        }
        var ev = "exit";
        if (opts && opts.alwaysLast) {
          ev = "afterexit";
        }
        var remove = /* @__PURE__ */ __name(function() {
          emitter.removeListener(ev, cb);
          if (emitter.listeners("exit").length === 0 && emitter.listeners("afterexit").length === 0) {
            unload();
          }
        }, "remove");
        emitter.on(ev, cb);
        return remove;
      };
      unload = /* @__PURE__ */ __name(function unload2() {
        if (!loaded || !processOk(globalThis.process)) {
          return;
        }
        loaded = false;
        signals.forEach(function(sig) {
          try {
            process14.removeListener(sig, sigListeners[sig]);
          } catch (er) {
          }
        });
        process14.emit = originalProcessEmit;
        process14.reallyExit = originalProcessReallyExit;
        emitter.count -= 1;
      }, "unload");
      module.exports.unload = unload;
      emit = /* @__PURE__ */ __name(function emit2(event, code, signal) {
        if (emitter.emitted[event]) {
          return;
        }
        emitter.emitted[event] = true;
        emitter.emit(event, code, signal);
      }, "emit");
      sigListeners = {};
      signals.forEach(function(sig) {
        sigListeners[sig] = /* @__PURE__ */ __name(function listener() {
          if (!processOk(globalThis.process)) {
            return;
          }
          var listeners = process14.listeners(sig);
          if (listeners.length === emitter.count) {
            unload();
            emit("exit", null, sig);
            emit("afterexit", null, sig);
            if (isWin && sig === "SIGHUP") {
              sig = "SIGINT";
            }
            process14.kill(process14.pid, sig);
          }
        }, "listener");
      });
      module.exports.signals = function() {
        return signals;
      };
      loaded = false;
      load = /* @__PURE__ */ __name(function load2() {
        if (loaded || !processOk(globalThis.process)) {
          return;
        }
        loaded = true;
        emitter.count += 1;
        signals = signals.filter(function(sig) {
          try {
            process14.on(sig, sigListeners[sig]);
            return true;
          } catch (er) {
            return false;
          }
        });
        process14.emit = processEmit;
        process14.reallyExit = processReallyExit;
      }, "load");
      module.exports.load = load;
      originalProcessReallyExit = process14.reallyExit;
      processReallyExit = /* @__PURE__ */ __name(function processReallyExit2(code) {
        if (!processOk(globalThis.process)) {
          return;
        }
        process14.exitCode = code || /* istanbul ignore next */
        0;
        emit("exit", process14.exitCode, null);
        emit("afterexit", process14.exitCode, null);
        originalProcessReallyExit.call(process14, process14.exitCode);
      }, "processReallyExit");
      originalProcessEmit = process14.emit;
      processEmit = /* @__PURE__ */ __name(function processEmit2(ev, arg) {
        if (ev === "exit" && processOk(globalThis.process)) {
          if (arg !== void 0) {
            process14.exitCode = arg;
          }
          var ret = originalProcessEmit.apply(this, arguments);
          emit("exit", process14.exitCode, null);
          emit("afterexit", process14.exitCode, null);
          return ret;
        } else {
          return originalProcessEmit.apply(this, arguments);
        }
      }, "processEmit");
    }
    var assert;
    var signals;
    var isWin;
    var EE;
    var emitter;
    var unload;
    var emit;
    var sigListeners;
    var loaded;
    var load;
    var originalProcessReallyExit;
    var processReallyExit;
    var originalProcessEmit;
    var processEmit;
  }
});

// node_modules/react-reconciler/cjs/react-reconciler-constants.production.js
var require_react_reconciler_constants_production = __commonJS({
  "node_modules/react-reconciler/cjs/react-reconciler-constants.production.js"(exports) {
    "use strict";
    init_esbuild_shims();
    exports.ConcurrentRoot = 1;
    exports.ContinuousEventPriority = 8;
    exports.DefaultEventPriority = 32;
    exports.DiscreteEventPriority = 2;
    exports.IdleEventPriority = 268435456;
    exports.LegacyRoot = 0;
    exports.NoEventPriority = 0;
  }
});

// node_modules/react-reconciler/constants.js
var require_constants = __commonJS({
  "node_modules/react-reconciler/constants.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    if (true) {
      module.exports = require_react_reconciler_constants_production();
    } else {
      module.exports = null;
    }
  }
});

// node_modules/scheduler/cjs/scheduler.production.js
var require_scheduler_production = __commonJS({
  "node_modules/scheduler/cjs/scheduler.production.js"(exports) {
    "use strict";
    init_esbuild_shims();
    function push(heap, node) {
      var index = heap.length;
      heap.push(node);
      a: for (; 0 < index; ) {
        var parentIndex = index - 1 >>> 1, parent = heap[parentIndex];
        if (0 < compare(parent, node))
          heap[parentIndex] = node, heap[index] = parent, index = parentIndex;
        else break a;
      }
    }
    __name(push, "push");
    function peek(heap) {
      return 0 === heap.length ? null : heap[0];
    }
    __name(peek, "peek");
    function pop(heap) {
      if (0 === heap.length) return null;
      var first = heap[0], last = heap.pop();
      if (last !== first) {
        heap[0] = last;
        a: for (var index = 0, length = heap.length, halfLength = length >>> 1; index < halfLength; ) {
          var leftIndex = 2 * (index + 1) - 1, left = heap[leftIndex], rightIndex = leftIndex + 1, right = heap[rightIndex];
          if (0 > compare(left, last))
            rightIndex < length && 0 > compare(right, left) ? (heap[index] = right, heap[rightIndex] = last, index = rightIndex) : (heap[index] = left, heap[leftIndex] = last, index = leftIndex);
          else if (rightIndex < length && 0 > compare(right, last))
            heap[index] = right, heap[rightIndex] = last, index = rightIndex;
          else break a;
        }
      }
      return first;
    }
    __name(pop, "pop");
    function compare(a, b) {
      var diff2 = a.sortIndex - b.sortIndex;
      return 0 !== diff2 ? diff2 : a.id - b.id;
    }
    __name(compare, "compare");
    exports.unstable_now = void 0;
    if ("object" === typeof performance && "function" === typeof performance.now) {
      localPerformance = performance;
      exports.unstable_now = function() {
        return localPerformance.now();
      };
    } else {
      localDate = Date, initialTime = localDate.now();
      exports.unstable_now = function() {
        return localDate.now() - initialTime;
      };
    }
    var localPerformance;
    var localDate;
    var initialTime;
    var taskQueue = [];
    var timerQueue = [];
    var taskIdCounter = 1;
    var currentTask = null;
    var currentPriorityLevel = 3;
    var isPerformingWork = false;
    var isHostCallbackScheduled = false;
    var isHostTimeoutScheduled = false;
    var needsPaint = false;
    var localSetTimeout = "function" === typeof setTimeout ? setTimeout : null;
    var localClearTimeout = "function" === typeof clearTimeout ? clearTimeout : null;
    var localSetImmediate = "undefined" !== typeof setImmediate ? setImmediate : null;
    function advanceTimers(currentTime) {
      for (var timer = peek(timerQueue); null !== timer; ) {
        if (null === timer.callback) pop(timerQueue);
        else if (timer.startTime <= currentTime)
          pop(timerQueue), timer.sortIndex = timer.expirationTime, push(taskQueue, timer);
        else break;
        timer = peek(timerQueue);
      }
    }
    __name(advanceTimers, "advanceTimers");
    function handleTimeout(currentTime) {
      isHostTimeoutScheduled = false;
      advanceTimers(currentTime);
      if (!isHostCallbackScheduled)
        if (null !== peek(taskQueue))
          isHostCallbackScheduled = true, isMessageLoopRunning || (isMessageLoopRunning = true, schedulePerformWorkUntilDeadline());
        else {
          var firstTimer = peek(timerQueue);
          null !== firstTimer && requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
        }
    }
    __name(handleTimeout, "handleTimeout");
    var isMessageLoopRunning = false;
    var taskTimeoutID = -1;
    var frameInterval = 5;
    var startTime = -1;
    function shouldYieldToHost() {
      return needsPaint ? true : exports.unstable_now() - startTime < frameInterval ? false : true;
    }
    __name(shouldYieldToHost, "shouldYieldToHost");
    function performWorkUntilDeadline() {
      needsPaint = false;
      if (isMessageLoopRunning) {
        var currentTime = exports.unstable_now();
        startTime = currentTime;
        var hasMoreWork = true;
        try {
          a: {
            isHostCallbackScheduled = false;
            isHostTimeoutScheduled && (isHostTimeoutScheduled = false, localClearTimeout(taskTimeoutID), taskTimeoutID = -1);
            isPerformingWork = true;
            var previousPriorityLevel = currentPriorityLevel;
            try {
              b: {
                advanceTimers(currentTime);
                for (currentTask = peek(taskQueue); null !== currentTask && !(currentTask.expirationTime > currentTime && shouldYieldToHost()); ) {
                  var callback = currentTask.callback;
                  if ("function" === typeof callback) {
                    currentTask.callback = null;
                    currentPriorityLevel = currentTask.priorityLevel;
                    var continuationCallback = callback(
                      currentTask.expirationTime <= currentTime
                    );
                    currentTime = exports.unstable_now();
                    if ("function" === typeof continuationCallback) {
                      currentTask.callback = continuationCallback;
                      advanceTimers(currentTime);
                      hasMoreWork = true;
                      break b;
                    }
                    currentTask === peek(taskQueue) && pop(taskQueue);
                    advanceTimers(currentTime);
                  } else pop(taskQueue);
                  currentTask = peek(taskQueue);
                }
                if (null !== currentTask) hasMoreWork = true;
                else {
                  var firstTimer = peek(timerQueue);
                  null !== firstTimer && requestHostTimeout(
                    handleTimeout,
                    firstTimer.startTime - currentTime
                  );
                  hasMoreWork = false;
                }
              }
              break a;
            } finally {
              currentTask = null, currentPriorityLevel = previousPriorityLevel, isPerformingWork = false;
            }
            hasMoreWork = void 0;
          }
        } finally {
          hasMoreWork ? schedulePerformWorkUntilDeadline() : isMessageLoopRunning = false;
        }
      }
    }
    __name(performWorkUntilDeadline, "performWorkUntilDeadline");
    var schedulePerformWorkUntilDeadline;
    if ("function" === typeof localSetImmediate)
      schedulePerformWorkUntilDeadline = /* @__PURE__ */ __name(function() {
        localSetImmediate(performWorkUntilDeadline);
      }, "schedulePerformWorkUntilDeadline");
    else if ("undefined" !== typeof MessageChannel) {
      channel = new MessageChannel(), port = channel.port2;
      channel.port1.onmessage = performWorkUntilDeadline;
      schedulePerformWorkUntilDeadline = /* @__PURE__ */ __name(function() {
        port.postMessage(null);
      }, "schedulePerformWorkUntilDeadline");
    } else
      schedulePerformWorkUntilDeadline = /* @__PURE__ */ __name(function() {
        localSetTimeout(performWorkUntilDeadline, 0);
      }, "schedulePerformWorkUntilDeadline");
    var channel;
    var port;
    function requestHostTimeout(callback, ms) {
      taskTimeoutID = localSetTimeout(function() {
        callback(exports.unstable_now());
      }, ms);
    }
    __name(requestHostTimeout, "requestHostTimeout");
    exports.unstable_IdlePriority = 5;
    exports.unstable_ImmediatePriority = 1;
    exports.unstable_LowPriority = 4;
    exports.unstable_NormalPriority = 3;
    exports.unstable_Profiling = null;
    exports.unstable_UserBlockingPriority = 2;
    exports.unstable_cancelCallback = function(task) {
      task.callback = null;
    };
    exports.unstable_forceFrameRate = function(fps) {
      0 > fps || 125 < fps ? console.error(
        "forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"
      ) : frameInterval = 0 < fps ? Math.floor(1e3 / fps) : 5;
    };
    exports.unstable_getCurrentPriorityLevel = function() {
      return currentPriorityLevel;
    };
    exports.unstable_next = function(eventHandler) {
      switch (currentPriorityLevel) {
        case 1:
        case 2:
        case 3:
          var priorityLevel = 3;
          break;
        default:
          priorityLevel = currentPriorityLevel;
      }
      var previousPriorityLevel = currentPriorityLevel;
      currentPriorityLevel = priorityLevel;
      try {
        return eventHandler();
      } finally {
        currentPriorityLevel = previousPriorityLevel;
      }
    };
    exports.unstable_requestPaint = function() {
      needsPaint = true;
    };
    exports.unstable_runWithPriority = function(priorityLevel, eventHandler) {
      switch (priorityLevel) {
        case 1:
        case 2:
        case 3:
        case 4:
        case 5:
          break;
        default:
          priorityLevel = 3;
      }
      var previousPriorityLevel = currentPriorityLevel;
      currentPriorityLevel = priorityLevel;
      try {
        return eventHandler();
      } finally {
        currentPriorityLevel = previousPriorityLevel;
      }
    };
    exports.unstable_scheduleCallback = function(priorityLevel, callback, options) {
      var currentTime = exports.unstable_now();
      "object" === typeof options && null !== options ? (options = options.delay, options = "number" === typeof options && 0 < options ? currentTime + options : currentTime) : options = currentTime;
      switch (priorityLevel) {
        case 1:
          var timeout = -1;
          break;
        case 2:
          timeout = 250;
          break;
        case 5:
          timeout = 1073741823;
          break;
        case 4:
          timeout = 1e4;
          break;
        default:
          timeout = 5e3;
      }
      timeout = options + timeout;
      priorityLevel = {
        id: taskIdCounter++,
        callback,
        priorityLevel,
        startTime: options,
        expirationTime: timeout,
        sortIndex: -1
      };
      options > currentTime ? (priorityLevel.sortIndex = options, push(timerQueue, priorityLevel), null === peek(taskQueue) && priorityLevel === peek(timerQueue) && (isHostTimeoutScheduled ? (localClearTimeout(taskTimeoutID), taskTimeoutID = -1) : isHostTimeoutScheduled = true, requestHostTimeout(handleTimeout, options - currentTime))) : (priorityLevel.sortIndex = timeout, push(taskQueue, priorityLevel), isHostCallbackScheduled || isPerformingWork || (isHostCallbackScheduled = true, isMessageLoopRunning || (isMessageLoopRunning = true, schedulePerformWorkUntilDeadline())));
      return priorityLevel;
    };
    exports.unstable_shouldYield = shouldYieldToHost;
    exports.unstable_wrapCallback = function(callback) {
      var parentPriorityLevel = currentPriorityLevel;
      return function() {
        var previousPriorityLevel = currentPriorityLevel;
        currentPriorityLevel = parentPriorityLevel;
        try {
          return callback.apply(this, arguments);
        } finally {
          currentPriorityLevel = previousPriorityLevel;
        }
      };
    };
  }
});

// node_modules/scheduler/index.js
var require_scheduler = __commonJS({
  "node_modules/scheduler/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    if (true) {
      module.exports = require_scheduler_production();
    } else {
      module.exports = null;
    }
  }
});

// node_modules/react-reconciler/cjs/react-reconciler.production.js
var require_react_reconciler_production = __commonJS({
  "node_modules/react-reconciler/cjs/react-reconciler.production.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    module.exports = function($$$config) {
      function createFiber(tag, pendingProps, key, mode) {
        return new FiberNode(tag, pendingProps, key, mode);
      }
      __name(createFiber, "createFiber");
      function noop2() {
      }
      __name(noop2, "noop");
      function formatProdErrorMessage(code) {
        var url = "https://react.dev/errors/" + code;
        if (1 < arguments.length) {
          url += "?args[]=" + encodeURIComponent(arguments[1]);
          for (var i = 2; i < arguments.length; i++)
            url += "&args[]=" + encodeURIComponent(arguments[i]);
        }
        return "Minified React error #" + code + "; visit " + url + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
      }
      __name(formatProdErrorMessage, "formatProdErrorMessage");
      function getNearestMountedFiber(fiber) {
        var node = fiber, nearestMounted = fiber;
        if (fiber.alternate) for (; node.return; ) node = node.return;
        else {
          fiber = node;
          do
            node = fiber, 0 !== (node.flags & 4098) && (nearestMounted = node.return), fiber = node.return;
          while (fiber);
        }
        return 3 === node.tag ? nearestMounted : null;
      }
      __name(getNearestMountedFiber, "getNearestMountedFiber");
      function assertIsMounted(fiber) {
        if (getNearestMountedFiber(fiber) !== fiber)
          throw Error(formatProdErrorMessage(188));
      }
      __name(assertIsMounted, "assertIsMounted");
      function findCurrentFiberUsingSlowPath(fiber) {
        var alternate = fiber.alternate;
        if (!alternate) {
          alternate = getNearestMountedFiber(fiber);
          if (null === alternate) throw Error(formatProdErrorMessage(188));
          return alternate !== fiber ? null : fiber;
        }
        for (var a = fiber, b = alternate; ; ) {
          var parentA = a.return;
          if (null === parentA) break;
          var parentB = parentA.alternate;
          if (null === parentB) {
            b = parentA.return;
            if (null !== b) {
              a = b;
              continue;
            }
            break;
          }
          if (parentA.child === parentB.child) {
            for (parentB = parentA.child; parentB; ) {
              if (parentB === a) return assertIsMounted(parentA), fiber;
              if (parentB === b) return assertIsMounted(parentA), alternate;
              parentB = parentB.sibling;
            }
            throw Error(formatProdErrorMessage(188));
          }
          if (a.return !== b.return) a = parentA, b = parentB;
          else {
            for (var didFindChild = false, child$0 = parentA.child; child$0; ) {
              if (child$0 === a) {
                didFindChild = true;
                a = parentA;
                b = parentB;
                break;
              }
              if (child$0 === b) {
                didFindChild = true;
                b = parentA;
                a = parentB;
                break;
              }
              child$0 = child$0.sibling;
            }
            if (!didFindChild) {
              for (child$0 = parentB.child; child$0; ) {
                if (child$0 === a) {
                  didFindChild = true;
                  a = parentB;
                  b = parentA;
                  break;
                }
                if (child$0 === b) {
                  didFindChild = true;
                  b = parentB;
                  a = parentA;
                  break;
                }
                child$0 = child$0.sibling;
              }
              if (!didFindChild) throw Error(formatProdErrorMessage(189));
            }
          }
          if (a.alternate !== b) throw Error(formatProdErrorMessage(190));
        }
        if (3 !== a.tag) throw Error(formatProdErrorMessage(188));
        return a.stateNode.current === a ? fiber : alternate;
      }
      __name(findCurrentFiberUsingSlowPath, "findCurrentFiberUsingSlowPath");
      function findCurrentHostFiberImpl(node) {
        var tag = node.tag;
        if (5 === tag || 26 === tag || 27 === tag || 6 === tag) return node;
        for (node = node.child; null !== node; ) {
          tag = findCurrentHostFiberImpl(node);
          if (null !== tag) return tag;
          node = node.sibling;
        }
        return null;
      }
      __name(findCurrentHostFiberImpl, "findCurrentHostFiberImpl");
      function findCurrentHostFiberWithNoPortalsImpl(node) {
        var tag = node.tag;
        if (5 === tag || 26 === tag || 27 === tag || 6 === tag) return node;
        for (node = node.child; null !== node; ) {
          if (4 !== node.tag && (tag = findCurrentHostFiberWithNoPortalsImpl(node), null !== tag))
            return tag;
          node = node.sibling;
        }
        return null;
      }
      __name(findCurrentHostFiberWithNoPortalsImpl, "findCurrentHostFiberWithNoPortalsImpl");
      function getIteratorFn(maybeIterable) {
        if (null === maybeIterable || "object" !== typeof maybeIterable)
          return null;
        maybeIterable = MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL] || maybeIterable["@@iterator"];
        return "function" === typeof maybeIterable ? maybeIterable : null;
      }
      __name(getIteratorFn, "getIteratorFn");
      function getComponentNameFromType(type) {
        if (null == type) return null;
        if ("function" === typeof type)
          return type.$$typeof === REACT_CLIENT_REFERENCE ? null : type.displayName || type.name || null;
        if ("string" === typeof type) return type;
        switch (type) {
          case REACT_FRAGMENT_TYPE:
            return "Fragment";
          case REACT_PROFILER_TYPE:
            return "Profiler";
          case REACT_STRICT_MODE_TYPE:
            return "StrictMode";
          case REACT_SUSPENSE_TYPE:
            return "Suspense";
          case REACT_SUSPENSE_LIST_TYPE:
            return "SuspenseList";
          case REACT_ACTIVITY_TYPE:
            return "Activity";
        }
        if ("object" === typeof type)
          switch (type.$$typeof) {
            case REACT_PORTAL_TYPE:
              return "Portal";
            case REACT_CONTEXT_TYPE:
              return type.displayName || "Context";
            case REACT_CONSUMER_TYPE:
              return (type._context.displayName || "Context") + ".Consumer";
            case REACT_FORWARD_REF_TYPE:
              var innerType = type.render;
              type = type.displayName;
              type || (type = innerType.displayName || innerType.name || "", type = "" !== type ? "ForwardRef(" + type + ")" : "ForwardRef");
              return type;
            case REACT_MEMO_TYPE:
              return innerType = type.displayName || null, null !== innerType ? innerType : getComponentNameFromType(type.type) || "Memo";
            case REACT_LAZY_TYPE:
              innerType = type._payload;
              type = type._init;
              try {
                return getComponentNameFromType(type(innerType));
              } catch (x) {
              }
          }
        return null;
      }
      __name(getComponentNameFromType, "getComponentNameFromType");
      function createCursor(defaultValue2) {
        return { current: defaultValue2 };
      }
      __name(createCursor, "createCursor");
      function pop(cursor) {
        0 > index$jscomp$0 || (cursor.current = valueStack[index$jscomp$0], valueStack[index$jscomp$0] = null, index$jscomp$0--);
      }
      __name(pop, "pop");
      function push(cursor, value) {
        index$jscomp$0++;
        valueStack[index$jscomp$0] = cursor.current;
        cursor.current = value;
      }
      __name(push, "push");
      function clz32Fallback(x) {
        x >>>= 0;
        return 0 === x ? 32 : 31 - (log$1(x) / LN2 | 0) | 0;
      }
      __name(clz32Fallback, "clz32Fallback");
      function getHighestPriorityLanes(lanes) {
        var pendingSyncLanes = lanes & 42;
        if (0 !== pendingSyncLanes) return pendingSyncLanes;
        switch (lanes & -lanes) {
          case 1:
            return 1;
          case 2:
            return 2;
          case 4:
            return 4;
          case 8:
            return 8;
          case 16:
            return 16;
          case 32:
            return 32;
          case 64:
            return 64;
          case 128:
            return 128;
          case 256:
          case 512:
          case 1024:
          case 2048:
          case 4096:
          case 8192:
          case 16384:
          case 32768:
          case 65536:
          case 131072:
            return lanes & 261888;
          case 262144:
          case 524288:
          case 1048576:
          case 2097152:
            return lanes & 3932160;
          case 4194304:
          case 8388608:
          case 16777216:
          case 33554432:
            return lanes & 62914560;
          case 67108864:
            return 67108864;
          case 134217728:
            return 134217728;
          case 268435456:
            return 268435456;
          case 536870912:
            return 536870912;
          case 1073741824:
            return 0;
          default:
            return lanes;
        }
      }
      __name(getHighestPriorityLanes, "getHighestPriorityLanes");
      function getNextLanes(root, wipLanes, rootHasPendingCommit) {
        var pendingLanes = root.pendingLanes;
        if (0 === pendingLanes) return 0;
        var nextLanes = 0, suspendedLanes = root.suspendedLanes, pingedLanes = root.pingedLanes;
        root = root.warmLanes;
        var nonIdlePendingLanes = pendingLanes & 134217727;
        0 !== nonIdlePendingLanes ? (pendingLanes = nonIdlePendingLanes & ~suspendedLanes, 0 !== pendingLanes ? nextLanes = getHighestPriorityLanes(pendingLanes) : (pingedLanes &= nonIdlePendingLanes, 0 !== pingedLanes ? nextLanes = getHighestPriorityLanes(pingedLanes) : rootHasPendingCommit || (rootHasPendingCommit = nonIdlePendingLanes & ~root, 0 !== rootHasPendingCommit && (nextLanes = getHighestPriorityLanes(rootHasPendingCommit))))) : (nonIdlePendingLanes = pendingLanes & ~suspendedLanes, 0 !== nonIdlePendingLanes ? nextLanes = getHighestPriorityLanes(nonIdlePendingLanes) : 0 !== pingedLanes ? nextLanes = getHighestPriorityLanes(pingedLanes) : rootHasPendingCommit || (rootHasPendingCommit = pendingLanes & ~root, 0 !== rootHasPendingCommit && (nextLanes = getHighestPriorityLanes(rootHasPendingCommit))));
        return 0 === nextLanes ? 0 : 0 !== wipLanes && wipLanes !== nextLanes && 0 === (wipLanes & suspendedLanes) && (suspendedLanes = nextLanes & -nextLanes, rootHasPendingCommit = wipLanes & -wipLanes, suspendedLanes >= rootHasPendingCommit || 32 === suspendedLanes && 0 !== (rootHasPendingCommit & 4194048)) ? wipLanes : nextLanes;
      }
      __name(getNextLanes, "getNextLanes");
      function checkIfRootIsPrerendering(root, renderLanes2) {
        return 0 === (root.pendingLanes & ~(root.suspendedLanes & ~root.pingedLanes) & renderLanes2);
      }
      __name(checkIfRootIsPrerendering, "checkIfRootIsPrerendering");
      function computeExpirationTime(lane, currentTime) {
        switch (lane) {
          case 1:
          case 2:
          case 4:
          case 8:
          case 64:
            return currentTime + 250;
          case 16:
          case 32:
          case 128:
          case 256:
          case 512:
          case 1024:
          case 2048:
          case 4096:
          case 8192:
          case 16384:
          case 32768:
          case 65536:
          case 131072:
          case 262144:
          case 524288:
          case 1048576:
          case 2097152:
            return currentTime + 5e3;
          case 4194304:
          case 8388608:
          case 16777216:
          case 33554432:
            return -1;
          case 67108864:
          case 134217728:
          case 268435456:
          case 536870912:
          case 1073741824:
            return -1;
          default:
            return -1;
        }
      }
      __name(computeExpirationTime, "computeExpirationTime");
      function claimNextRetryLane() {
        var lane = nextRetryLane;
        nextRetryLane <<= 1;
        0 === (nextRetryLane & 62914560) && (nextRetryLane = 4194304);
        return lane;
      }
      __name(claimNextRetryLane, "claimNextRetryLane");
      function createLaneMap(initial) {
        for (var laneMap = [], i = 0; 31 > i; i++) laneMap.push(initial);
        return laneMap;
      }
      __name(createLaneMap, "createLaneMap");
      function markRootUpdated$1(root, updateLane) {
        root.pendingLanes |= updateLane;
        268435456 !== updateLane && (root.suspendedLanes = 0, root.pingedLanes = 0, root.warmLanes = 0);
      }
      __name(markRootUpdated$1, "markRootUpdated$1");
      function markRootFinished(root, finishedLanes, remainingLanes, spawnedLane, updatedLanes, suspendedRetryLanes) {
        var previouslyPendingLanes = root.pendingLanes;
        root.pendingLanes = remainingLanes;
        root.suspendedLanes = 0;
        root.pingedLanes = 0;
        root.warmLanes = 0;
        root.expiredLanes &= remainingLanes;
        root.entangledLanes &= remainingLanes;
        root.errorRecoveryDisabledLanes &= remainingLanes;
        root.shellSuspendCounter = 0;
        var entanglements = root.entanglements, expirationTimes = root.expirationTimes, hiddenUpdates = root.hiddenUpdates;
        for (remainingLanes = previouslyPendingLanes & ~remainingLanes; 0 < remainingLanes; ) {
          var index$5 = 31 - clz32(remainingLanes), lane = 1 << index$5;
          entanglements[index$5] = 0;
          expirationTimes[index$5] = -1;
          var hiddenUpdatesForLane = hiddenUpdates[index$5];
          if (null !== hiddenUpdatesForLane)
            for (hiddenUpdates[index$5] = null, index$5 = 0; index$5 < hiddenUpdatesForLane.length; index$5++) {
              var update = hiddenUpdatesForLane[index$5];
              null !== update && (update.lane &= -536870913);
            }
          remainingLanes &= ~lane;
        }
        0 !== spawnedLane && markSpawnedDeferredLane(root, spawnedLane, 0);
        0 !== suspendedRetryLanes && 0 === updatedLanes && 0 !== root.tag && (root.suspendedLanes |= suspendedRetryLanes & ~(previouslyPendingLanes & ~finishedLanes));
      }
      __name(markRootFinished, "markRootFinished");
      function markSpawnedDeferredLane(root, spawnedLane, entangledLanes) {
        root.pendingLanes |= spawnedLane;
        root.suspendedLanes &= ~spawnedLane;
        var spawnedLaneIndex = 31 - clz32(spawnedLane);
        root.entangledLanes |= spawnedLane;
        root.entanglements[spawnedLaneIndex] = root.entanglements[spawnedLaneIndex] | 1073741824 | entangledLanes & 261930;
      }
      __name(markSpawnedDeferredLane, "markSpawnedDeferredLane");
      function markRootEntangled(root, entangledLanes) {
        var rootEntangledLanes = root.entangledLanes |= entangledLanes;
        for (root = root.entanglements; rootEntangledLanes; ) {
          var index$6 = 31 - clz32(rootEntangledLanes), lane = 1 << index$6;
          lane & entangledLanes | root[index$6] & entangledLanes && (root[index$6] |= entangledLanes);
          rootEntangledLanes &= ~lane;
        }
      }
      __name(markRootEntangled, "markRootEntangled");
      function getBumpedLaneForHydration(root, renderLanes2) {
        var renderLane = renderLanes2 & -renderLanes2;
        renderLane = 0 !== (renderLane & 42) ? 1 : getBumpedLaneForHydrationByLane(renderLane);
        return 0 !== (renderLane & (root.suspendedLanes | renderLanes2)) ? 0 : renderLane;
      }
      __name(getBumpedLaneForHydration, "getBumpedLaneForHydration");
      function getBumpedLaneForHydrationByLane(lane) {
        switch (lane) {
          case 2:
            lane = 1;
            break;
          case 8:
            lane = 4;
            break;
          case 32:
            lane = 16;
            break;
          case 256:
          case 512:
          case 1024:
          case 2048:
          case 4096:
          case 8192:
          case 16384:
          case 32768:
          case 65536:
          case 131072:
          case 262144:
          case 524288:
          case 1048576:
          case 2097152:
          case 4194304:
          case 8388608:
          case 16777216:
          case 33554432:
            lane = 128;
            break;
          case 268435456:
            lane = 134217728;
            break;
          default:
            lane = 0;
        }
        return lane;
      }
      __name(getBumpedLaneForHydrationByLane, "getBumpedLaneForHydrationByLane");
      function lanesToEventPriority(lanes) {
        lanes &= -lanes;
        return 2 < lanes ? 8 < lanes ? 0 !== (lanes & 134217727) ? 32 : 268435456 : 8 : 2;
      }
      __name(lanesToEventPriority, "lanesToEventPriority");
      function setIsStrictModeForDevtools(newIsStrictMode) {
        "function" === typeof log && unstable_setDisableYieldValue(newIsStrictMode);
        if (injectedHook && "function" === typeof injectedHook.setStrictMode)
          try {
            injectedHook.setStrictMode(rendererID, newIsStrictMode);
          } catch (err) {
          }
      }
      __name(setIsStrictModeForDevtools, "setIsStrictModeForDevtools");
      function is(x, y) {
        return x === y && (0 !== x || 1 / x === 1 / y) || x !== x && y !== y;
      }
      __name(is, "is");
      function describeBuiltInComponentFrame(name) {
        if (void 0 === prefix)
          try {
            throw Error();
          } catch (x) {
            var match = x.stack.trim().match(/\n( *(at )?)/);
            prefix = match && match[1] || "";
            suffix = -1 < x.stack.indexOf("\n    at") ? " (<anonymous>)" : -1 < x.stack.indexOf("@") ? "@unknown:0:0" : "";
          }
        return "\n" + prefix + name + suffix;
      }
      __name(describeBuiltInComponentFrame, "describeBuiltInComponentFrame");
      function describeNativeComponentFrame(fn, construct) {
        if (!fn || reentry) return "";
        reentry = true;
        var previousPrepareStackTrace = Error.prepareStackTrace;
        Error.prepareStackTrace = void 0;
        try {
          var RunInRootFrame = {
            DetermineComponentFrameRoot: /* @__PURE__ */ __name(function() {
              try {
                if (construct) {
                  var Fake = /* @__PURE__ */ __name(function() {
                    throw Error();
                  }, "Fake");
                  Object.defineProperty(Fake.prototype, "props", {
                    set: /* @__PURE__ */ __name(function() {
                      throw Error();
                    }, "set")
                  });
                  if ("object" === typeof Reflect && Reflect.construct) {
                    try {
                      Reflect.construct(Fake, []);
                    } catch (x) {
                      var control = x;
                    }
                    Reflect.construct(fn, [], Fake);
                  } else {
                    try {
                      Fake.call();
                    } catch (x$8) {
                      control = x$8;
                    }
                    fn.call(Fake.prototype);
                  }
                } else {
                  try {
                    throw Error();
                  } catch (x$9) {
                    control = x$9;
                  }
                  (Fake = fn()) && "function" === typeof Fake.catch && Fake.catch(function() {
                  });
                }
              } catch (sample) {
                if (sample && control && "string" === typeof sample.stack)
                  return [sample.stack, control.stack];
              }
              return [null, null];
            }, "DetermineComponentFrameRoot")
          };
          RunInRootFrame.DetermineComponentFrameRoot.displayName = "DetermineComponentFrameRoot";
          var namePropDescriptor = Object.getOwnPropertyDescriptor(
            RunInRootFrame.DetermineComponentFrameRoot,
            "name"
          );
          namePropDescriptor && namePropDescriptor.configurable && Object.defineProperty(
            RunInRootFrame.DetermineComponentFrameRoot,
            "name",
            { value: "DetermineComponentFrameRoot" }
          );
          var _RunInRootFrame$Deter = RunInRootFrame.DetermineComponentFrameRoot(), sampleStack = _RunInRootFrame$Deter[0], controlStack = _RunInRootFrame$Deter[1];
          if (sampleStack && controlStack) {
            var sampleLines = sampleStack.split("\n"), controlLines = controlStack.split("\n");
            for (namePropDescriptor = RunInRootFrame = 0; RunInRootFrame < sampleLines.length && !sampleLines[RunInRootFrame].includes("DetermineComponentFrameRoot"); )
              RunInRootFrame++;
            for (; namePropDescriptor < controlLines.length && !controlLines[namePropDescriptor].includes(
              "DetermineComponentFrameRoot"
            ); )
              namePropDescriptor++;
            if (RunInRootFrame === sampleLines.length || namePropDescriptor === controlLines.length)
              for (RunInRootFrame = sampleLines.length - 1, namePropDescriptor = controlLines.length - 1; 1 <= RunInRootFrame && 0 <= namePropDescriptor && sampleLines[RunInRootFrame] !== controlLines[namePropDescriptor]; )
                namePropDescriptor--;
            for (; 1 <= RunInRootFrame && 0 <= namePropDescriptor; RunInRootFrame--, namePropDescriptor--)
              if (sampleLines[RunInRootFrame] !== controlLines[namePropDescriptor]) {
                if (1 !== RunInRootFrame || 1 !== namePropDescriptor) {
                  do
                    if (RunInRootFrame--, namePropDescriptor--, 0 > namePropDescriptor || sampleLines[RunInRootFrame] !== controlLines[namePropDescriptor]) {
                      var frame = "\n" + sampleLines[RunInRootFrame].replace(" at new ", " at ");
                      fn.displayName && frame.includes("<anonymous>") && (frame = frame.replace("<anonymous>", fn.displayName));
                      return frame;
                    }
                  while (1 <= RunInRootFrame && 0 <= namePropDescriptor);
                }
                break;
              }
          }
        } finally {
          reentry = false, Error.prepareStackTrace = previousPrepareStackTrace;
        }
        return (previousPrepareStackTrace = fn ? fn.displayName || fn.name : "") ? describeBuiltInComponentFrame(previousPrepareStackTrace) : "";
      }
      __name(describeNativeComponentFrame, "describeNativeComponentFrame");
      function describeFiber(fiber, childFiber) {
        switch (fiber.tag) {
          case 26:
          case 27:
          case 5:
            return describeBuiltInComponentFrame(fiber.type);
          case 16:
            return describeBuiltInComponentFrame("Lazy");
          case 13:
            return fiber.child !== childFiber && null !== childFiber ? describeBuiltInComponentFrame("Suspense Fallback") : describeBuiltInComponentFrame("Suspense");
          case 19:
            return describeBuiltInComponentFrame("SuspenseList");
          case 0:
          case 15:
            return describeNativeComponentFrame(fiber.type, false);
          case 11:
            return describeNativeComponentFrame(fiber.type.render, false);
          case 1:
            return describeNativeComponentFrame(fiber.type, true);
          case 31:
            return describeBuiltInComponentFrame("Activity");
          default:
            return "";
        }
      }
      __name(describeFiber, "describeFiber");
      function getStackByFiberInDevAndProd(workInProgress2) {
        try {
          var info = "", previous = null;
          do
            info += describeFiber(workInProgress2, previous), previous = workInProgress2, workInProgress2 = workInProgress2.return;
          while (workInProgress2);
          return info;
        } catch (x) {
          return "\nError generating stack: " + x.message + "\n" + x.stack;
        }
      }
      __name(getStackByFiberInDevAndProd, "getStackByFiberInDevAndProd");
      function createCapturedValueAtFiber(value, source) {
        if ("object" === typeof value && null !== value) {
          var existing = CapturedStacks.get(value);
          if (void 0 !== existing) return existing;
          source = {
            value,
            source,
            stack: getStackByFiberInDevAndProd(source)
          };
          CapturedStacks.set(value, source);
          return source;
        }
        return {
          value,
          source,
          stack: getStackByFiberInDevAndProd(source)
        };
      }
      __name(createCapturedValueAtFiber, "createCapturedValueAtFiber");
      function pushTreeFork(workInProgress2, totalChildren) {
        forkStack[forkStackIndex++] = treeForkCount;
        forkStack[forkStackIndex++] = treeForkProvider;
        treeForkProvider = workInProgress2;
        treeForkCount = totalChildren;
      }
      __name(pushTreeFork, "pushTreeFork");
      function pushTreeId(workInProgress2, totalChildren, index) {
        idStack[idStackIndex++] = treeContextId;
        idStack[idStackIndex++] = treeContextOverflow;
        idStack[idStackIndex++] = treeContextProvider;
        treeContextProvider = workInProgress2;
        var baseIdWithLeadingBit = treeContextId;
        workInProgress2 = treeContextOverflow;
        var baseLength = 32 - clz32(baseIdWithLeadingBit) - 1;
        baseIdWithLeadingBit &= ~(1 << baseLength);
        index += 1;
        var length = 32 - clz32(totalChildren) + baseLength;
        if (30 < length) {
          var numberOfOverflowBits = baseLength - baseLength % 5;
          length = (baseIdWithLeadingBit & (1 << numberOfOverflowBits) - 1).toString(32);
          baseIdWithLeadingBit >>= numberOfOverflowBits;
          baseLength -= numberOfOverflowBits;
          treeContextId = 1 << 32 - clz32(totalChildren) + baseLength | index << baseLength | baseIdWithLeadingBit;
          treeContextOverflow = length + workInProgress2;
        } else
          treeContextId = 1 << length | index << baseLength | baseIdWithLeadingBit, treeContextOverflow = workInProgress2;
      }
      __name(pushTreeId, "pushTreeId");
      function pushMaterializedTreeId(workInProgress2) {
        null !== workInProgress2.return && (pushTreeFork(workInProgress2, 1), pushTreeId(workInProgress2, 1, 0));
      }
      __name(pushMaterializedTreeId, "pushMaterializedTreeId");
      function popTreeContext(workInProgress2) {
        for (; workInProgress2 === treeForkProvider; )
          treeForkProvider = forkStack[--forkStackIndex], forkStack[forkStackIndex] = null, treeForkCount = forkStack[--forkStackIndex], forkStack[forkStackIndex] = null;
        for (; workInProgress2 === treeContextProvider; )
          treeContextProvider = idStack[--idStackIndex], idStack[idStackIndex] = null, treeContextOverflow = idStack[--idStackIndex], idStack[idStackIndex] = null, treeContextId = idStack[--idStackIndex], idStack[idStackIndex] = null;
      }
      __name(popTreeContext, "popTreeContext");
      function restoreSuspendedTreeContext(workInProgress2, suspendedContext) {
        idStack[idStackIndex++] = treeContextId;
        idStack[idStackIndex++] = treeContextOverflow;
        idStack[idStackIndex++] = treeContextProvider;
        treeContextId = suspendedContext.id;
        treeContextOverflow = suspendedContext.overflow;
        treeContextProvider = workInProgress2;
      }
      __name(restoreSuspendedTreeContext, "restoreSuspendedTreeContext");
      function pushHostContainer(fiber, nextRootInstance) {
        push(rootInstanceStackCursor, nextRootInstance);
        push(contextFiberStackCursor, fiber);
        push(contextStackCursor, null);
        fiber = getRootHostContext(nextRootInstance);
        pop(contextStackCursor);
        push(contextStackCursor, fiber);
      }
      __name(pushHostContainer, "pushHostContainer");
      function popHostContainer() {
        pop(contextStackCursor);
        pop(contextFiberStackCursor);
        pop(rootInstanceStackCursor);
      }
      __name(popHostContainer, "popHostContainer");
      function pushHostContext(fiber) {
        null !== fiber.memoizedState && push(hostTransitionProviderCursor, fiber);
        var context = contextStackCursor.current, nextContext = getChildHostContext(context, fiber.type);
        context !== nextContext && (push(contextFiberStackCursor, fiber), push(contextStackCursor, nextContext));
      }
      __name(pushHostContext, "pushHostContext");
      function popHostContext(fiber) {
        contextFiberStackCursor.current === fiber && (pop(contextStackCursor), pop(contextFiberStackCursor));
        hostTransitionProviderCursor.current === fiber && (pop(hostTransitionProviderCursor), isPrimaryRenderer ? HostTransitionContext._currentValue = NotPendingTransition : HostTransitionContext._currentValue2 = NotPendingTransition);
      }
      __name(popHostContext, "popHostContext");
      function throwOnHydrationMismatch(fiber) {
        var error = Error(
          formatProdErrorMessage(
            418,
            1 < arguments.length && void 0 !== arguments[1] && arguments[1] ? "text" : "HTML",
            ""
          )
        );
        queueHydrationError(createCapturedValueAtFiber(error, fiber));
        throw HydrationMismatchException;
      }
      __name(throwOnHydrationMismatch, "throwOnHydrationMismatch");
      function prepareToHydrateHostInstance(fiber, hostContext) {
        if (!supportsHydration) throw Error(formatProdErrorMessage(175));
        hydrateInstance(
          fiber.stateNode,
          fiber.type,
          fiber.memoizedProps,
          hostContext,
          fiber
        ) || throwOnHydrationMismatch(fiber, true);
      }
      __name(prepareToHydrateHostInstance, "prepareToHydrateHostInstance");
      function popToNextHostParent(fiber) {
        for (hydrationParentFiber = fiber.return; hydrationParentFiber; )
          switch (hydrationParentFiber.tag) {
            case 5:
            case 31:
            case 13:
              rootOrSingletonContext = false;
              return;
            case 27:
            case 3:
              rootOrSingletonContext = true;
              return;
            default:
              hydrationParentFiber = hydrationParentFiber.return;
          }
      }
      __name(popToNextHostParent, "popToNextHostParent");
      function popHydrationState(fiber) {
        if (!supportsHydration || fiber !== hydrationParentFiber) return false;
        if (!isHydrating) return popToNextHostParent(fiber), isHydrating = true, false;
        var tag = fiber.tag;
        supportsSingletons ? 3 !== tag && 27 !== tag && (5 !== tag || shouldDeleteUnhydratedTailInstances(fiber.type) && !shouldSetTextContent(fiber.type, fiber.memoizedProps)) && nextHydratableInstance && throwOnHydrationMismatch(fiber) : 3 !== tag && (5 !== tag || shouldDeleteUnhydratedTailInstances(fiber.type) && !shouldSetTextContent(fiber.type, fiber.memoizedProps)) && nextHydratableInstance && throwOnHydrationMismatch(fiber);
        popToNextHostParent(fiber);
        if (13 === tag) {
          if (!supportsHydration) throw Error(formatProdErrorMessage(316));
          fiber = fiber.memoizedState;
          fiber = null !== fiber ? fiber.dehydrated : null;
          if (!fiber) throw Error(formatProdErrorMessage(317));
          nextHydratableInstance = getNextHydratableInstanceAfterSuspenseInstance(fiber);
        } else if (31 === tag) {
          fiber = fiber.memoizedState;
          fiber = null !== fiber ? fiber.dehydrated : null;
          if (!fiber) throw Error(formatProdErrorMessage(317));
          nextHydratableInstance = getNextHydratableInstanceAfterActivityInstance(fiber);
        } else
          nextHydratableInstance = supportsSingletons && 27 === tag ? getNextHydratableSiblingAfterSingleton(
            fiber.type,
            nextHydratableInstance
          ) : hydrationParentFiber ? getNextHydratableSibling(fiber.stateNode) : null;
        return true;
      }
      __name(popHydrationState, "popHydrationState");
      function resetHydrationState() {
        supportsHydration && (nextHydratableInstance = hydrationParentFiber = null, isHydrating = false);
      }
      __name(resetHydrationState, "resetHydrationState");
      function upgradeHydrationErrorsToRecoverable() {
        var queuedErrors = hydrationErrors;
        null !== queuedErrors && (null === workInProgressRootRecoverableErrors ? workInProgressRootRecoverableErrors = queuedErrors : workInProgressRootRecoverableErrors.push.apply(
          workInProgressRootRecoverableErrors,
          queuedErrors
        ), hydrationErrors = null);
        return queuedErrors;
      }
      __name(upgradeHydrationErrorsToRecoverable, "upgradeHydrationErrorsToRecoverable");
      function queueHydrationError(error) {
        null === hydrationErrors ? hydrationErrors = [error] : hydrationErrors.push(error);
      }
      __name(queueHydrationError, "queueHydrationError");
      function pushProvider(providerFiber, context, nextValue) {
        isPrimaryRenderer ? (push(valueCursor, context._currentValue), context._currentValue = nextValue) : (push(valueCursor, context._currentValue2), context._currentValue2 = nextValue);
      }
      __name(pushProvider, "pushProvider");
      function popProvider(context) {
        var currentValue = valueCursor.current;
        isPrimaryRenderer ? context._currentValue = currentValue : context._currentValue2 = currentValue;
        pop(valueCursor);
      }
      __name(popProvider, "popProvider");
      function scheduleContextWorkOnParentPath(parent, renderLanes2, propagationRoot) {
        for (; null !== parent; ) {
          var alternate = parent.alternate;
          (parent.childLanes & renderLanes2) !== renderLanes2 ? (parent.childLanes |= renderLanes2, null !== alternate && (alternate.childLanes |= renderLanes2)) : null !== alternate && (alternate.childLanes & renderLanes2) !== renderLanes2 && (alternate.childLanes |= renderLanes2);
          if (parent === propagationRoot) break;
          parent = parent.return;
        }
      }
      __name(scheduleContextWorkOnParentPath, "scheduleContextWorkOnParentPath");
      function propagateContextChanges(workInProgress2, contexts, renderLanes2, forcePropagateEntireTree) {
        var fiber = workInProgress2.child;
        null !== fiber && (fiber.return = workInProgress2);
        for (; null !== fiber; ) {
          var list = fiber.dependencies;
          if (null !== list) {
            var nextFiber = fiber.child;
            list = list.firstContext;
            a: for (; null !== list; ) {
              var dependency = list;
              list = fiber;
              for (var i = 0; i < contexts.length; i++)
                if (dependency.context === contexts[i]) {
                  list.lanes |= renderLanes2;
                  dependency = list.alternate;
                  null !== dependency && (dependency.lanes |= renderLanes2);
                  scheduleContextWorkOnParentPath(
                    list.return,
                    renderLanes2,
                    workInProgress2
                  );
                  forcePropagateEntireTree || (nextFiber = null);
                  break a;
                }
              list = dependency.next;
            }
          } else if (18 === fiber.tag) {
            nextFiber = fiber.return;
            if (null === nextFiber) throw Error(formatProdErrorMessage(341));
            nextFiber.lanes |= renderLanes2;
            list = nextFiber.alternate;
            null !== list && (list.lanes |= renderLanes2);
            scheduleContextWorkOnParentPath(nextFiber, renderLanes2, workInProgress2);
            nextFiber = null;
          } else nextFiber = fiber.child;
          if (null !== nextFiber) nextFiber.return = fiber;
          else
            for (nextFiber = fiber; null !== nextFiber; ) {
              if (nextFiber === workInProgress2) {
                nextFiber = null;
                break;
              }
              fiber = nextFiber.sibling;
              if (null !== fiber) {
                fiber.return = nextFiber.return;
                nextFiber = fiber;
                break;
              }
              nextFiber = nextFiber.return;
            }
          fiber = nextFiber;
        }
      }
      __name(propagateContextChanges, "propagateContextChanges");
      function propagateParentContextChanges(current, workInProgress2, renderLanes2, forcePropagateEntireTree) {
        current = null;
        for (var parent = workInProgress2, isInsidePropagationBailout = false; null !== parent; ) {
          if (!isInsidePropagationBailout) {
            if (0 !== (parent.flags & 524288)) isInsidePropagationBailout = true;
            else if (0 !== (parent.flags & 262144)) break;
          }
          if (10 === parent.tag) {
            var currentParent = parent.alternate;
            if (null === currentParent) throw Error(formatProdErrorMessage(387));
            currentParent = currentParent.memoizedProps;
            if (null !== currentParent) {
              var context = parent.type;
              objectIs(parent.pendingProps.value, currentParent.value) || (null !== current ? current.push(context) : current = [context]);
            }
          } else if (parent === hostTransitionProviderCursor.current) {
            currentParent = parent.alternate;
            if (null === currentParent) throw Error(formatProdErrorMessage(387));
            currentParent.memoizedState.memoizedState !== parent.memoizedState.memoizedState && (null !== current ? current.push(HostTransitionContext) : current = [HostTransitionContext]);
          }
          parent = parent.return;
        }
        null !== current && propagateContextChanges(
          workInProgress2,
          current,
          renderLanes2,
          forcePropagateEntireTree
        );
        workInProgress2.flags |= 262144;
      }
      __name(propagateParentContextChanges, "propagateParentContextChanges");
      function checkIfContextChanged(currentDependencies) {
        for (currentDependencies = currentDependencies.firstContext; null !== currentDependencies; ) {
          var context = currentDependencies.context;
          if (!objectIs(
            isPrimaryRenderer ? context._currentValue : context._currentValue2,
            currentDependencies.memoizedValue
          ))
            return true;
          currentDependencies = currentDependencies.next;
        }
        return false;
      }
      __name(checkIfContextChanged, "checkIfContextChanged");
      function prepareToReadContext(workInProgress2) {
        currentlyRenderingFiber$1 = workInProgress2;
        lastContextDependency = null;
        workInProgress2 = workInProgress2.dependencies;
        null !== workInProgress2 && (workInProgress2.firstContext = null);
      }
      __name(prepareToReadContext, "prepareToReadContext");
      function readContext(context) {
        return readContextForConsumer(currentlyRenderingFiber$1, context);
      }
      __name(readContext, "readContext");
      function readContextDuringReconciliation(consumer, context) {
        null === currentlyRenderingFiber$1 && prepareToReadContext(consumer);
        return readContextForConsumer(consumer, context);
      }
      __name(readContextDuringReconciliation, "readContextDuringReconciliation");
      function readContextForConsumer(consumer, context) {
        var value = isPrimaryRenderer ? context._currentValue : context._currentValue2;
        context = { context, memoizedValue: value, next: null };
        if (null === lastContextDependency) {
          if (null === consumer) throw Error(formatProdErrorMessage(308));
          lastContextDependency = context;
          consumer.dependencies = { lanes: 0, firstContext: context };
          consumer.flags |= 524288;
        } else lastContextDependency = lastContextDependency.next = context;
        return value;
      }
      __name(readContextForConsumer, "readContextForConsumer");
      function createCache() {
        return {
          controller: new AbortControllerLocal(),
          data: /* @__PURE__ */ new Map(),
          refCount: 0
        };
      }
      __name(createCache, "createCache");
      function releaseCache(cache3) {
        cache3.refCount--;
        0 === cache3.refCount && scheduleCallback$2(NormalPriority, function() {
          cache3.controller.abort();
        });
      }
      __name(releaseCache, "releaseCache");
      function noop$1() {
      }
      __name(noop$1, "noop$1");
      function ensureRootIsScheduled(root) {
        root !== lastScheduledRoot && null === root.next && (null === lastScheduledRoot ? firstScheduledRoot = lastScheduledRoot = root : lastScheduledRoot = lastScheduledRoot.next = root);
        mightHavePendingSyncWork = true;
        didScheduleMicrotask || (didScheduleMicrotask = true, scheduleImmediateRootScheduleTask());
      }
      __name(ensureRootIsScheduled, "ensureRootIsScheduled");
      function flushSyncWorkAcrossRoots_impl(syncTransitionLanes, onlyLegacy) {
        if (!isFlushingWork && mightHavePendingSyncWork) {
          isFlushingWork = true;
          do {
            var didPerformSomeWork = false;
            for (var root = firstScheduledRoot; null !== root; ) {
              if (!onlyLegacy)
                if (0 !== syncTransitionLanes) {
                  var pendingLanes = root.pendingLanes;
                  if (0 === pendingLanes) var JSCompiler_inline_result = 0;
                  else {
                    var suspendedLanes = root.suspendedLanes, pingedLanes = root.pingedLanes;
                    JSCompiler_inline_result = (1 << 31 - clz32(42 | syncTransitionLanes) + 1) - 1;
                    JSCompiler_inline_result &= pendingLanes & ~(suspendedLanes & ~pingedLanes);
                    JSCompiler_inline_result = JSCompiler_inline_result & 201326741 ? JSCompiler_inline_result & 201326741 | 1 : JSCompiler_inline_result ? JSCompiler_inline_result | 2 : 0;
                  }
                  0 !== JSCompiler_inline_result && (didPerformSomeWork = true, performSyncWorkOnRoot(root, JSCompiler_inline_result));
                } else
                  JSCompiler_inline_result = workInProgressRootRenderLanes, JSCompiler_inline_result = getNextLanes(
                    root,
                    root === workInProgressRoot ? JSCompiler_inline_result : 0,
                    null !== root.cancelPendingCommit || root.timeoutHandle !== noTimeout
                  ), 0 === (JSCompiler_inline_result & 3) || checkIfRootIsPrerendering(root, JSCompiler_inline_result) || (didPerformSomeWork = true, performSyncWorkOnRoot(root, JSCompiler_inline_result));
              root = root.next;
            }
          } while (didPerformSomeWork);
          isFlushingWork = false;
        }
      }
      __name(flushSyncWorkAcrossRoots_impl, "flushSyncWorkAcrossRoots_impl");
      function processRootScheduleInImmediateTask() {
        processRootScheduleInMicrotask();
      }
      __name(processRootScheduleInImmediateTask, "processRootScheduleInImmediateTask");
      function processRootScheduleInMicrotask() {
        mightHavePendingSyncWork = didScheduleMicrotask = false;
        var syncTransitionLanes = 0;
        0 !== currentEventTransitionLane && shouldAttemptEagerTransition() && (syncTransitionLanes = currentEventTransitionLane);
        for (var currentTime = now(), prev = null, root = firstScheduledRoot; null !== root; ) {
          var next = root.next, nextLanes = scheduleTaskForRootDuringMicrotask(root, currentTime);
          if (0 === nextLanes)
            root.next = null, null === prev ? firstScheduledRoot = next : prev.next = next, null === next && (lastScheduledRoot = prev);
          else if (prev = root, 0 !== syncTransitionLanes || 0 !== (nextLanes & 3))
            mightHavePendingSyncWork = true;
          root = next;
        }
        0 !== pendingEffectsStatus && 5 !== pendingEffectsStatus || flushSyncWorkAcrossRoots_impl(syncTransitionLanes, false);
        0 !== currentEventTransitionLane && (currentEventTransitionLane = 0);
      }
      __name(processRootScheduleInMicrotask, "processRootScheduleInMicrotask");
      function scheduleTaskForRootDuringMicrotask(root, currentTime) {
        for (var suspendedLanes = root.suspendedLanes, pingedLanes = root.pingedLanes, expirationTimes = root.expirationTimes, lanes = root.pendingLanes & -62914561; 0 < lanes; ) {
          var index$3 = 31 - clz32(lanes), lane = 1 << index$3, expirationTime = expirationTimes[index$3];
          if (-1 === expirationTime) {
            if (0 === (lane & suspendedLanes) || 0 !== (lane & pingedLanes))
              expirationTimes[index$3] = computeExpirationTime(lane, currentTime);
          } else expirationTime <= currentTime && (root.expiredLanes |= lane);
          lanes &= ~lane;
        }
        currentTime = workInProgressRoot;
        suspendedLanes = workInProgressRootRenderLanes;
        suspendedLanes = getNextLanes(
          root,
          root === currentTime ? suspendedLanes : 0,
          null !== root.cancelPendingCommit || root.timeoutHandle !== noTimeout
        );
        pingedLanes = root.callbackNode;
        if (0 === suspendedLanes || root === currentTime && (2 === workInProgressSuspendedReason || 9 === workInProgressSuspendedReason) || null !== root.cancelPendingCommit)
          return null !== pingedLanes && null !== pingedLanes && cancelCallback$1(pingedLanes), root.callbackNode = null, root.callbackPriority = 0;
        if (0 === (suspendedLanes & 3) || checkIfRootIsPrerendering(root, suspendedLanes)) {
          currentTime = suspendedLanes & -suspendedLanes;
          if (currentTime === root.callbackPriority) return currentTime;
          null !== pingedLanes && cancelCallback$1(pingedLanes);
          switch (lanesToEventPriority(suspendedLanes)) {
            case 2:
            case 8:
              suspendedLanes = UserBlockingPriority;
              break;
            case 32:
              suspendedLanes = NormalPriority$1;
              break;
            case 268435456:
              suspendedLanes = IdlePriority;
              break;
            default:
              suspendedLanes = NormalPriority$1;
          }
          pingedLanes = performWorkOnRootViaSchedulerTask.bind(null, root);
          suspendedLanes = scheduleCallback$3(suspendedLanes, pingedLanes);
          root.callbackPriority = currentTime;
          root.callbackNode = suspendedLanes;
          return currentTime;
        }
        null !== pingedLanes && null !== pingedLanes && cancelCallback$1(pingedLanes);
        root.callbackPriority = 2;
        root.callbackNode = null;
        return 2;
      }
      __name(scheduleTaskForRootDuringMicrotask, "scheduleTaskForRootDuringMicrotask");
      function performWorkOnRootViaSchedulerTask(root, didTimeout) {
        if (0 !== pendingEffectsStatus && 5 !== pendingEffectsStatus)
          return root.callbackNode = null, root.callbackPriority = 0, null;
        var originalCallbackNode = root.callbackNode;
        if (flushPendingEffects() && root.callbackNode !== originalCallbackNode)
          return null;
        var workInProgressRootRenderLanes$jscomp$0 = workInProgressRootRenderLanes;
        workInProgressRootRenderLanes$jscomp$0 = getNextLanes(
          root,
          root === workInProgressRoot ? workInProgressRootRenderLanes$jscomp$0 : 0,
          null !== root.cancelPendingCommit || root.timeoutHandle !== noTimeout
        );
        if (0 === workInProgressRootRenderLanes$jscomp$0) return null;
        performWorkOnRoot(root, workInProgressRootRenderLanes$jscomp$0, didTimeout);
        scheduleTaskForRootDuringMicrotask(root, now());
        return null != root.callbackNode && root.callbackNode === originalCallbackNode ? performWorkOnRootViaSchedulerTask.bind(null, root) : null;
      }
      __name(performWorkOnRootViaSchedulerTask, "performWorkOnRootViaSchedulerTask");
      function performSyncWorkOnRoot(root, lanes) {
        if (flushPendingEffects()) return null;
        performWorkOnRoot(root, lanes, true);
      }
      __name(performSyncWorkOnRoot, "performSyncWorkOnRoot");
      function scheduleImmediateRootScheduleTask() {
        supportsMicrotasks ? scheduleMicrotask(function() {
          0 !== (executionContext & 6) ? scheduleCallback$3(
            ImmediatePriority,
            processRootScheduleInImmediateTask
          ) : processRootScheduleInMicrotask();
        }) : scheduleCallback$3(
          ImmediatePriority,
          processRootScheduleInImmediateTask
        );
      }
      __name(scheduleImmediateRootScheduleTask, "scheduleImmediateRootScheduleTask");
      function requestTransitionLane() {
        if (0 === currentEventTransitionLane) {
          var actionScopeLane = currentEntangledLane;
          0 === actionScopeLane && (actionScopeLane = nextTransitionUpdateLane, nextTransitionUpdateLane <<= 1, 0 === (nextTransitionUpdateLane & 261888) && (nextTransitionUpdateLane = 256));
          currentEventTransitionLane = actionScopeLane;
        }
        return currentEventTransitionLane;
      }
      __name(requestTransitionLane, "requestTransitionLane");
      function entangleAsyncAction(transition, thenable) {
        if (null === currentEntangledListeners) {
          var entangledListeners = currentEntangledListeners = [];
          currentEntangledPendingCount = 0;
          currentEntangledLane = requestTransitionLane();
          currentEntangledActionThenable = {
            status: "pending",
            value: void 0,
            then: /* @__PURE__ */ __name(function(resolve) {
              entangledListeners.push(resolve);
            }, "then")
          };
        }
        currentEntangledPendingCount++;
        thenable.then(pingEngtangledActionScope, pingEngtangledActionScope);
        return thenable;
      }
      __name(entangleAsyncAction, "entangleAsyncAction");
      function pingEngtangledActionScope() {
        if (0 === --currentEntangledPendingCount && null !== currentEntangledListeners) {
          null !== currentEntangledActionThenable && (currentEntangledActionThenable.status = "fulfilled");
          var listeners = currentEntangledListeners;
          currentEntangledListeners = null;
          currentEntangledLane = 0;
          currentEntangledActionThenable = null;
          for (var i = 0; i < listeners.length; i++) (0, listeners[i])();
        }
      }
      __name(pingEngtangledActionScope, "pingEngtangledActionScope");
      function chainThenableValue(thenable, result) {
        var listeners = [], thenableWithOverride = {
          status: "pending",
          value: null,
          reason: null,
          then: /* @__PURE__ */ __name(function(resolve) {
            listeners.push(resolve);
          }, "then")
        };
        thenable.then(
          function() {
            thenableWithOverride.status = "fulfilled";
            thenableWithOverride.value = result;
            for (var i = 0; i < listeners.length; i++) (0, listeners[i])(result);
          },
          function(error) {
            thenableWithOverride.status = "rejected";
            thenableWithOverride.reason = error;
            for (error = 0; error < listeners.length; error++)
              (0, listeners[error])(void 0);
          }
        );
        return thenableWithOverride;
      }
      __name(chainThenableValue, "chainThenableValue");
      function peekCacheFromPool() {
        var cacheResumedFromPreviousRender = resumedCache.current;
        return null !== cacheResumedFromPreviousRender ? cacheResumedFromPreviousRender : workInProgressRoot.pooledCache;
      }
      __name(peekCacheFromPool, "peekCacheFromPool");
      function pushTransition(offscreenWorkInProgress, prevCachePool) {
        null === prevCachePool ? push(resumedCache, resumedCache.current) : push(resumedCache, prevCachePool.pool);
      }
      __name(pushTransition, "pushTransition");
      function getSuspendedCache() {
        var cacheFromPool = peekCacheFromPool();
        return null === cacheFromPool ? null : {
          parent: isPrimaryRenderer ? CacheContext._currentValue : CacheContext._currentValue2,
          pool: cacheFromPool
        };
      }
      __name(getSuspendedCache, "getSuspendedCache");
      function shallowEqual(objA, objB) {
        if (objectIs(objA, objB)) return true;
        if ("object" !== typeof objA || null === objA || "object" !== typeof objB || null === objB)
          return false;
        var keysA = Object.keys(objA), keysB = Object.keys(objB);
        if (keysA.length !== keysB.length) return false;
        for (keysB = 0; keysB < keysA.length; keysB++) {
          var currentKey = keysA[keysB];
          if (!hasOwnProperty.call(objB, currentKey) || !objectIs(objA[currentKey], objB[currentKey]))
            return false;
        }
        return true;
      }
      __name(shallowEqual, "shallowEqual");
      function isThenableResolved(thenable) {
        thenable = thenable.status;
        return "fulfilled" === thenable || "rejected" === thenable;
      }
      __name(isThenableResolved, "isThenableResolved");
      function trackUsedThenable(thenableState2, thenable, index) {
        index = thenableState2[index];
        void 0 === index ? thenableState2.push(thenable) : index !== thenable && (thenable.then(noop$1, noop$1), thenable = index);
        switch (thenable.status) {
          case "fulfilled":
            return thenable.value;
          case "rejected":
            throw thenableState2 = thenable.reason, checkIfUseWrappedInAsyncCatch(thenableState2), thenableState2;
          default:
            if ("string" === typeof thenable.status) thenable.then(noop$1, noop$1);
            else {
              thenableState2 = workInProgressRoot;
              if (null !== thenableState2 && 100 < thenableState2.shellSuspendCounter)
                throw Error(formatProdErrorMessage(482));
              thenableState2 = thenable;
              thenableState2.status = "pending";
              thenableState2.then(
                function(fulfilledValue) {
                  if ("pending" === thenable.status) {
                    var fulfilledThenable = thenable;
                    fulfilledThenable.status = "fulfilled";
                    fulfilledThenable.value = fulfilledValue;
                  }
                },
                function(error) {
                  if ("pending" === thenable.status) {
                    var rejectedThenable = thenable;
                    rejectedThenable.status = "rejected";
                    rejectedThenable.reason = error;
                  }
                }
              );
            }
            switch (thenable.status) {
              case "fulfilled":
                return thenable.value;
              case "rejected":
                throw thenableState2 = thenable.reason, checkIfUseWrappedInAsyncCatch(thenableState2), thenableState2;
            }
            suspendedThenable = thenable;
            throw SuspenseException;
        }
      }
      __name(trackUsedThenable, "trackUsedThenable");
      function resolveLazy(lazyType) {
        try {
          var init = lazyType._init;
          return init(lazyType._payload);
        } catch (x) {
          if (null !== x && "object" === typeof x && "function" === typeof x.then)
            throw suspendedThenable = x, SuspenseException;
          throw x;
        }
      }
      __name(resolveLazy, "resolveLazy");
      function getSuspendedThenable() {
        if (null === suspendedThenable) throw Error(formatProdErrorMessage(459));
        var thenable = suspendedThenable;
        suspendedThenable = null;
        return thenable;
      }
      __name(getSuspendedThenable, "getSuspendedThenable");
      function checkIfUseWrappedInAsyncCatch(rejectedReason) {
        if (rejectedReason === SuspenseException || rejectedReason === SuspenseActionException)
          throw Error(formatProdErrorMessage(483));
      }
      __name(checkIfUseWrappedInAsyncCatch, "checkIfUseWrappedInAsyncCatch");
      function unwrapThenable(thenable) {
        var index = thenableIndexCounter$1;
        thenableIndexCounter$1 += 1;
        null === thenableState$1 && (thenableState$1 = []);
        return trackUsedThenable(thenableState$1, thenable, index);
      }
      __name(unwrapThenable, "unwrapThenable");
      function coerceRef(workInProgress2, element) {
        element = element.props.ref;
        workInProgress2.ref = void 0 !== element ? element : null;
      }
      __name(coerceRef, "coerceRef");
      function throwOnInvalidObjectTypeImpl(returnFiber, newChild) {
        if (newChild.$$typeof === REACT_LEGACY_ELEMENT_TYPE)
          throw Error(formatProdErrorMessage(525));
        returnFiber = Object.prototype.toString.call(newChild);
        throw Error(
          formatProdErrorMessage(
            31,
            "[object Object]" === returnFiber ? "object with keys {" + Object.keys(newChild).join(", ") + "}" : returnFiber
          )
        );
      }
      __name(throwOnInvalidObjectTypeImpl, "throwOnInvalidObjectTypeImpl");
      function createChildReconciler(shouldTrackSideEffects) {
        function deleteChild(returnFiber, childToDelete) {
          if (shouldTrackSideEffects) {
            var deletions = returnFiber.deletions;
            null === deletions ? (returnFiber.deletions = [childToDelete], returnFiber.flags |= 16) : deletions.push(childToDelete);
          }
        }
        __name(deleteChild, "deleteChild");
        function deleteRemainingChildren(returnFiber, currentFirstChild) {
          if (!shouldTrackSideEffects) return null;
          for (; null !== currentFirstChild; )
            deleteChild(returnFiber, currentFirstChild), currentFirstChild = currentFirstChild.sibling;
          return null;
        }
        __name(deleteRemainingChildren, "deleteRemainingChildren");
        function mapRemainingChildren(currentFirstChild) {
          for (var existingChildren = /* @__PURE__ */ new Map(); null !== currentFirstChild; )
            null !== currentFirstChild.key ? existingChildren.set(currentFirstChild.key, currentFirstChild) : existingChildren.set(currentFirstChild.index, currentFirstChild), currentFirstChild = currentFirstChild.sibling;
          return existingChildren;
        }
        __name(mapRemainingChildren, "mapRemainingChildren");
        function useFiber(fiber, pendingProps) {
          fiber = createWorkInProgress(fiber, pendingProps);
          fiber.index = 0;
          fiber.sibling = null;
          return fiber;
        }
        __name(useFiber, "useFiber");
        function placeChild(newFiber, lastPlacedIndex, newIndex) {
          newFiber.index = newIndex;
          if (!shouldTrackSideEffects)
            return newFiber.flags |= 1048576, lastPlacedIndex;
          newIndex = newFiber.alternate;
          if (null !== newIndex)
            return newIndex = newIndex.index, newIndex < lastPlacedIndex ? (newFiber.flags |= 67108866, lastPlacedIndex) : newIndex;
          newFiber.flags |= 67108866;
          return lastPlacedIndex;
        }
        __name(placeChild, "placeChild");
        function placeSingleChild(newFiber) {
          shouldTrackSideEffects && null === newFiber.alternate && (newFiber.flags |= 67108866);
          return newFiber;
        }
        __name(placeSingleChild, "placeSingleChild");
        function updateTextNode(returnFiber, current, textContent, lanes) {
          if (null === current || 6 !== current.tag)
            return current = createFiberFromText(textContent, returnFiber.mode, lanes), current.return = returnFiber, current;
          current = useFiber(current, textContent);
          current.return = returnFiber;
          return current;
        }
        __name(updateTextNode, "updateTextNode");
        function updateElement(returnFiber, current, element, lanes) {
          var elementType = element.type;
          if (elementType === REACT_FRAGMENT_TYPE)
            return updateFragment(
              returnFiber,
              current,
              element.props.children,
              lanes,
              element.key
            );
          if (null !== current && (current.elementType === elementType || "object" === typeof elementType && null !== elementType && elementType.$$typeof === REACT_LAZY_TYPE && resolveLazy(elementType) === current.type))
            return current = useFiber(current, element.props), coerceRef(current, element), current.return = returnFiber, current;
          current = createFiberFromTypeAndProps(
            element.type,
            element.key,
            element.props,
            null,
            returnFiber.mode,
            lanes
          );
          coerceRef(current, element);
          current.return = returnFiber;
          return current;
        }
        __name(updateElement, "updateElement");
        function updatePortal(returnFiber, current, portal, lanes) {
          if (null === current || 4 !== current.tag || current.stateNode.containerInfo !== portal.containerInfo || current.stateNode.implementation !== portal.implementation)
            return current = createFiberFromPortal(portal, returnFiber.mode, lanes), current.return = returnFiber, current;
          current = useFiber(current, portal.children || []);
          current.return = returnFiber;
          return current;
        }
        __name(updatePortal, "updatePortal");
        function updateFragment(returnFiber, current, fragment, lanes, key) {
          if (null === current || 7 !== current.tag)
            return current = createFiberFromFragment(
              fragment,
              returnFiber.mode,
              lanes,
              key
            ), current.return = returnFiber, current;
          current = useFiber(current, fragment);
          current.return = returnFiber;
          return current;
        }
        __name(updateFragment, "updateFragment");
        function createChild(returnFiber, newChild, lanes) {
          if ("string" === typeof newChild && "" !== newChild || "number" === typeof newChild || "bigint" === typeof newChild)
            return newChild = createFiberFromText(
              "" + newChild,
              returnFiber.mode,
              lanes
            ), newChild.return = returnFiber, newChild;
          if ("object" === typeof newChild && null !== newChild) {
            switch (newChild.$$typeof) {
              case REACT_ELEMENT_TYPE:
                return lanes = createFiberFromTypeAndProps(
                  newChild.type,
                  newChild.key,
                  newChild.props,
                  null,
                  returnFiber.mode,
                  lanes
                ), coerceRef(lanes, newChild), lanes.return = returnFiber, lanes;
              case REACT_PORTAL_TYPE:
                return newChild = createFiberFromPortal(
                  newChild,
                  returnFiber.mode,
                  lanes
                ), newChild.return = returnFiber, newChild;
              case REACT_LAZY_TYPE:
                return newChild = resolveLazy(newChild), createChild(returnFiber, newChild, lanes);
            }
            if (isArrayImpl(newChild) || getIteratorFn(newChild))
              return newChild = createFiberFromFragment(
                newChild,
                returnFiber.mode,
                lanes,
                null
              ), newChild.return = returnFiber, newChild;
            if ("function" === typeof newChild.then)
              return createChild(returnFiber, unwrapThenable(newChild), lanes);
            if (newChild.$$typeof === REACT_CONTEXT_TYPE)
              return createChild(
                returnFiber,
                readContextDuringReconciliation(returnFiber, newChild),
                lanes
              );
            throwOnInvalidObjectTypeImpl(returnFiber, newChild);
          }
          return null;
        }
        __name(createChild, "createChild");
        function updateSlot(returnFiber, oldFiber, newChild, lanes) {
          var key = null !== oldFiber ? oldFiber.key : null;
          if ("string" === typeof newChild && "" !== newChild || "number" === typeof newChild || "bigint" === typeof newChild)
            return null !== key ? null : updateTextNode(returnFiber, oldFiber, "" + newChild, lanes);
          if ("object" === typeof newChild && null !== newChild) {
            switch (newChild.$$typeof) {
              case REACT_ELEMENT_TYPE:
                return newChild.key === key ? updateElement(returnFiber, oldFiber, newChild, lanes) : null;
              case REACT_PORTAL_TYPE:
                return newChild.key === key ? updatePortal(returnFiber, oldFiber, newChild, lanes) : null;
              case REACT_LAZY_TYPE:
                return newChild = resolveLazy(newChild), updateSlot(returnFiber, oldFiber, newChild, lanes);
            }
            if (isArrayImpl(newChild) || getIteratorFn(newChild))
              return null !== key ? null : updateFragment(returnFiber, oldFiber, newChild, lanes, null);
            if ("function" === typeof newChild.then)
              return updateSlot(
                returnFiber,
                oldFiber,
                unwrapThenable(newChild),
                lanes
              );
            if (newChild.$$typeof === REACT_CONTEXT_TYPE)
              return updateSlot(
                returnFiber,
                oldFiber,
                readContextDuringReconciliation(returnFiber, newChild),
                lanes
              );
            throwOnInvalidObjectTypeImpl(returnFiber, newChild);
          }
          return null;
        }
        __name(updateSlot, "updateSlot");
        function updateFromMap(existingChildren, returnFiber, newIdx, newChild, lanes) {
          if ("string" === typeof newChild && "" !== newChild || "number" === typeof newChild || "bigint" === typeof newChild)
            return existingChildren = existingChildren.get(newIdx) || null, updateTextNode(returnFiber, existingChildren, "" + newChild, lanes);
          if ("object" === typeof newChild && null !== newChild) {
            switch (newChild.$$typeof) {
              case REACT_ELEMENT_TYPE:
                return existingChildren = existingChildren.get(
                  null === newChild.key ? newIdx : newChild.key
                ) || null, updateElement(returnFiber, existingChildren, newChild, lanes);
              case REACT_PORTAL_TYPE:
                return existingChildren = existingChildren.get(
                  null === newChild.key ? newIdx : newChild.key
                ) || null, updatePortal(returnFiber, existingChildren, newChild, lanes);
              case REACT_LAZY_TYPE:
                return newChild = resolveLazy(newChild), updateFromMap(
                  existingChildren,
                  returnFiber,
                  newIdx,
                  newChild,
                  lanes
                );
            }
            if (isArrayImpl(newChild) || getIteratorFn(newChild))
              return existingChildren = existingChildren.get(newIdx) || null, updateFragment(returnFiber, existingChildren, newChild, lanes, null);
            if ("function" === typeof newChild.then)
              return updateFromMap(
                existingChildren,
                returnFiber,
                newIdx,
                unwrapThenable(newChild),
                lanes
              );
            if (newChild.$$typeof === REACT_CONTEXT_TYPE)
              return updateFromMap(
                existingChildren,
                returnFiber,
                newIdx,
                readContextDuringReconciliation(returnFiber, newChild),
                lanes
              );
            throwOnInvalidObjectTypeImpl(returnFiber, newChild);
          }
          return null;
        }
        __name(updateFromMap, "updateFromMap");
        function reconcileChildrenArray(returnFiber, currentFirstChild, newChildren, lanes) {
          for (var resultingFirstChild = null, previousNewFiber = null, oldFiber = currentFirstChild, newIdx = currentFirstChild = 0, nextOldFiber = null; null !== oldFiber && newIdx < newChildren.length; newIdx++) {
            oldFiber.index > newIdx ? (nextOldFiber = oldFiber, oldFiber = null) : nextOldFiber = oldFiber.sibling;
            var newFiber = updateSlot(
              returnFiber,
              oldFiber,
              newChildren[newIdx],
              lanes
            );
            if (null === newFiber) {
              null === oldFiber && (oldFiber = nextOldFiber);
              break;
            }
            shouldTrackSideEffects && oldFiber && null === newFiber.alternate && deleteChild(returnFiber, oldFiber);
            currentFirstChild = placeChild(newFiber, currentFirstChild, newIdx);
            null === previousNewFiber ? resultingFirstChild = newFiber : previousNewFiber.sibling = newFiber;
            previousNewFiber = newFiber;
            oldFiber = nextOldFiber;
          }
          if (newIdx === newChildren.length)
            return deleteRemainingChildren(returnFiber, oldFiber), isHydrating && pushTreeFork(returnFiber, newIdx), resultingFirstChild;
          if (null === oldFiber) {
            for (; newIdx < newChildren.length; newIdx++)
              oldFiber = createChild(returnFiber, newChildren[newIdx], lanes), null !== oldFiber && (currentFirstChild = placeChild(
                oldFiber,
                currentFirstChild,
                newIdx
              ), null === previousNewFiber ? resultingFirstChild = oldFiber : previousNewFiber.sibling = oldFiber, previousNewFiber = oldFiber);
            isHydrating && pushTreeFork(returnFiber, newIdx);
            return resultingFirstChild;
          }
          for (oldFiber = mapRemainingChildren(oldFiber); newIdx < newChildren.length; newIdx++)
            nextOldFiber = updateFromMap(
              oldFiber,
              returnFiber,
              newIdx,
              newChildren[newIdx],
              lanes
            ), null !== nextOldFiber && (shouldTrackSideEffects && null !== nextOldFiber.alternate && oldFiber.delete(
              null === nextOldFiber.key ? newIdx : nextOldFiber.key
            ), currentFirstChild = placeChild(
              nextOldFiber,
              currentFirstChild,
              newIdx
            ), null === previousNewFiber ? resultingFirstChild = nextOldFiber : previousNewFiber.sibling = nextOldFiber, previousNewFiber = nextOldFiber);
          shouldTrackSideEffects && oldFiber.forEach(function(child) {
            return deleteChild(returnFiber, child);
          });
          isHydrating && pushTreeFork(returnFiber, newIdx);
          return resultingFirstChild;
        }
        __name(reconcileChildrenArray, "reconcileChildrenArray");
        function reconcileChildrenIterator(returnFiber, currentFirstChild, newChildren, lanes) {
          if (null == newChildren) throw Error(formatProdErrorMessage(151));
          for (var resultingFirstChild = null, previousNewFiber = null, oldFiber = currentFirstChild, newIdx = currentFirstChild = 0, nextOldFiber = null, step = newChildren.next(); null !== oldFiber && !step.done; newIdx++, step = newChildren.next()) {
            oldFiber.index > newIdx ? (nextOldFiber = oldFiber, oldFiber = null) : nextOldFiber = oldFiber.sibling;
            var newFiber = updateSlot(returnFiber, oldFiber, step.value, lanes);
            if (null === newFiber) {
              null === oldFiber && (oldFiber = nextOldFiber);
              break;
            }
            shouldTrackSideEffects && oldFiber && null === newFiber.alternate && deleteChild(returnFiber, oldFiber);
            currentFirstChild = placeChild(newFiber, currentFirstChild, newIdx);
            null === previousNewFiber ? resultingFirstChild = newFiber : previousNewFiber.sibling = newFiber;
            previousNewFiber = newFiber;
            oldFiber = nextOldFiber;
          }
          if (step.done)
            return deleteRemainingChildren(returnFiber, oldFiber), isHydrating && pushTreeFork(returnFiber, newIdx), resultingFirstChild;
          if (null === oldFiber) {
            for (; !step.done; newIdx++, step = newChildren.next())
              step = createChild(returnFiber, step.value, lanes), null !== step && (currentFirstChild = placeChild(
                step,
                currentFirstChild,
                newIdx
              ), null === previousNewFiber ? resultingFirstChild = step : previousNewFiber.sibling = step, previousNewFiber = step);
            isHydrating && pushTreeFork(returnFiber, newIdx);
            return resultingFirstChild;
          }
          for (oldFiber = mapRemainingChildren(oldFiber); !step.done; newIdx++, step = newChildren.next())
            step = updateFromMap(
              oldFiber,
              returnFiber,
              newIdx,
              step.value,
              lanes
            ), null !== step && (shouldTrackSideEffects && null !== step.alternate && oldFiber.delete(null === step.key ? newIdx : step.key), currentFirstChild = placeChild(step, currentFirstChild, newIdx), null === previousNewFiber ? resultingFirstChild = step : previousNewFiber.sibling = step, previousNewFiber = step);
          shouldTrackSideEffects && oldFiber.forEach(function(child) {
            return deleteChild(returnFiber, child);
          });
          isHydrating && pushTreeFork(returnFiber, newIdx);
          return resultingFirstChild;
        }
        __name(reconcileChildrenIterator, "reconcileChildrenIterator");
        function reconcileChildFibersImpl(returnFiber, currentFirstChild, newChild, lanes) {
          "object" === typeof newChild && null !== newChild && newChild.type === REACT_FRAGMENT_TYPE && null === newChild.key && (newChild = newChild.props.children);
          if ("object" === typeof newChild && null !== newChild) {
            switch (newChild.$$typeof) {
              case REACT_ELEMENT_TYPE:
                a: {
                  for (var key = newChild.key; null !== currentFirstChild; ) {
                    if (currentFirstChild.key === key) {
                      key = newChild.type;
                      if (key === REACT_FRAGMENT_TYPE) {
                        if (7 === currentFirstChild.tag) {
                          deleteRemainingChildren(
                            returnFiber,
                            currentFirstChild.sibling
                          );
                          lanes = useFiber(
                            currentFirstChild,
                            newChild.props.children
                          );
                          lanes.return = returnFiber;
                          returnFiber = lanes;
                          break a;
                        }
                      } else if (currentFirstChild.elementType === key || "object" === typeof key && null !== key && key.$$typeof === REACT_LAZY_TYPE && resolveLazy(key) === currentFirstChild.type) {
                        deleteRemainingChildren(
                          returnFiber,
                          currentFirstChild.sibling
                        );
                        lanes = useFiber(currentFirstChild, newChild.props);
                        coerceRef(lanes, newChild);
                        lanes.return = returnFiber;
                        returnFiber = lanes;
                        break a;
                      }
                      deleteRemainingChildren(returnFiber, currentFirstChild);
                      break;
                    } else deleteChild(returnFiber, currentFirstChild);
                    currentFirstChild = currentFirstChild.sibling;
                  }
                  newChild.type === REACT_FRAGMENT_TYPE ? (lanes = createFiberFromFragment(
                    newChild.props.children,
                    returnFiber.mode,
                    lanes,
                    newChild.key
                  ), lanes.return = returnFiber, returnFiber = lanes) : (lanes = createFiberFromTypeAndProps(
                    newChild.type,
                    newChild.key,
                    newChild.props,
                    null,
                    returnFiber.mode,
                    lanes
                  ), coerceRef(lanes, newChild), lanes.return = returnFiber, returnFiber = lanes);
                }
                return placeSingleChild(returnFiber);
              case REACT_PORTAL_TYPE:
                a: {
                  for (key = newChild.key; null !== currentFirstChild; ) {
                    if (currentFirstChild.key === key)
                      if (4 === currentFirstChild.tag && currentFirstChild.stateNode.containerInfo === newChild.containerInfo && currentFirstChild.stateNode.implementation === newChild.implementation) {
                        deleteRemainingChildren(
                          returnFiber,
                          currentFirstChild.sibling
                        );
                        lanes = useFiber(
                          currentFirstChild,
                          newChild.children || []
                        );
                        lanes.return = returnFiber;
                        returnFiber = lanes;
                        break a;
                      } else {
                        deleteRemainingChildren(returnFiber, currentFirstChild);
                        break;
                      }
                    else deleteChild(returnFiber, currentFirstChild);
                    currentFirstChild = currentFirstChild.sibling;
                  }
                  lanes = createFiberFromPortal(newChild, returnFiber.mode, lanes);
                  lanes.return = returnFiber;
                  returnFiber = lanes;
                }
                return placeSingleChild(returnFiber);
              case REACT_LAZY_TYPE:
                return newChild = resolveLazy(newChild), reconcileChildFibersImpl(
                  returnFiber,
                  currentFirstChild,
                  newChild,
                  lanes
                );
            }
            if (isArrayImpl(newChild))
              return reconcileChildrenArray(
                returnFiber,
                currentFirstChild,
                newChild,
                lanes
              );
            if (getIteratorFn(newChild)) {
              key = getIteratorFn(newChild);
              if ("function" !== typeof key)
                throw Error(formatProdErrorMessage(150));
              newChild = key.call(newChild);
              return reconcileChildrenIterator(
                returnFiber,
                currentFirstChild,
                newChild,
                lanes
              );
            }
            if ("function" === typeof newChild.then)
              return reconcileChildFibersImpl(
                returnFiber,
                currentFirstChild,
                unwrapThenable(newChild),
                lanes
              );
            if (newChild.$$typeof === REACT_CONTEXT_TYPE)
              return reconcileChildFibersImpl(
                returnFiber,
                currentFirstChild,
                readContextDuringReconciliation(returnFiber, newChild),
                lanes
              );
            throwOnInvalidObjectTypeImpl(returnFiber, newChild);
          }
          return "string" === typeof newChild && "" !== newChild || "number" === typeof newChild || "bigint" === typeof newChild ? (newChild = "" + newChild, null !== currentFirstChild && 6 === currentFirstChild.tag ? (deleteRemainingChildren(returnFiber, currentFirstChild.sibling), lanes = useFiber(currentFirstChild, newChild), lanes.return = returnFiber, returnFiber = lanes) : (deleteRemainingChildren(returnFiber, currentFirstChild), lanes = createFiberFromText(newChild, returnFiber.mode, lanes), lanes.return = returnFiber, returnFiber = lanes), placeSingleChild(returnFiber)) : deleteRemainingChildren(returnFiber, currentFirstChild);
        }
        __name(reconcileChildFibersImpl, "reconcileChildFibersImpl");
        return function(returnFiber, currentFirstChild, newChild, lanes) {
          try {
            thenableIndexCounter$1 = 0;
            var firstChildFiber = reconcileChildFibersImpl(
              returnFiber,
              currentFirstChild,
              newChild,
              lanes
            );
            thenableState$1 = null;
            return firstChildFiber;
          } catch (x) {
            if (x === SuspenseException || x === SuspenseActionException) throw x;
            var fiber = createFiber(29, x, null, returnFiber.mode);
            fiber.lanes = lanes;
            fiber.return = returnFiber;
            return fiber;
          } finally {
          }
        };
      }
      __name(createChildReconciler, "createChildReconciler");
      function finishQueueingConcurrentUpdates() {
        for (var endIndex = concurrentQueuesIndex, i = concurrentlyUpdatedLanes = concurrentQueuesIndex = 0; i < endIndex; ) {
          var fiber = concurrentQueues[i];
          concurrentQueues[i++] = null;
          var queue = concurrentQueues[i];
          concurrentQueues[i++] = null;
          var update = concurrentQueues[i];
          concurrentQueues[i++] = null;
          var lane = concurrentQueues[i];
          concurrentQueues[i++] = null;
          if (null !== queue && null !== update) {
            var pending = queue.pending;
            null === pending ? update.next = update : (update.next = pending.next, pending.next = update);
            queue.pending = update;
          }
          0 !== lane && markUpdateLaneFromFiberToRoot(fiber, update, lane);
        }
      }
      __name(finishQueueingConcurrentUpdates, "finishQueueingConcurrentUpdates");
      function enqueueUpdate$1(fiber, queue, update, lane) {
        concurrentQueues[concurrentQueuesIndex++] = fiber;
        concurrentQueues[concurrentQueuesIndex++] = queue;
        concurrentQueues[concurrentQueuesIndex++] = update;
        concurrentQueues[concurrentQueuesIndex++] = lane;
        concurrentlyUpdatedLanes |= lane;
        fiber.lanes |= lane;
        fiber = fiber.alternate;
        null !== fiber && (fiber.lanes |= lane);
      }
      __name(enqueueUpdate$1, "enqueueUpdate$1");
      function enqueueConcurrentHookUpdate(fiber, queue, update, lane) {
        enqueueUpdate$1(fiber, queue, update, lane);
        return getRootForUpdatedFiber(fiber);
      }
      __name(enqueueConcurrentHookUpdate, "enqueueConcurrentHookUpdate");
      function enqueueConcurrentRenderForLane(fiber, lane) {
        enqueueUpdate$1(fiber, null, null, lane);
        return getRootForUpdatedFiber(fiber);
      }
      __name(enqueueConcurrentRenderForLane, "enqueueConcurrentRenderForLane");
      function markUpdateLaneFromFiberToRoot(sourceFiber, update, lane) {
        sourceFiber.lanes |= lane;
        var alternate = sourceFiber.alternate;
        null !== alternate && (alternate.lanes |= lane);
        for (var isHidden2 = false, parent = sourceFiber.return; null !== parent; )
          parent.childLanes |= lane, alternate = parent.alternate, null !== alternate && (alternate.childLanes |= lane), 22 === parent.tag && (sourceFiber = parent.stateNode, null === sourceFiber || sourceFiber._visibility & 1 || (isHidden2 = true)), sourceFiber = parent, parent = parent.return;
        return 3 === sourceFiber.tag ? (parent = sourceFiber.stateNode, isHidden2 && null !== update && (isHidden2 = 31 - clz32(lane), sourceFiber = parent.hiddenUpdates, alternate = sourceFiber[isHidden2], null === alternate ? sourceFiber[isHidden2] = [update] : alternate.push(update), update.lane = lane | 536870912), parent) : null;
      }
      __name(markUpdateLaneFromFiberToRoot, "markUpdateLaneFromFiberToRoot");
      function getRootForUpdatedFiber(sourceFiber) {
        if (50 < nestedUpdateCount)
          throw nestedUpdateCount = 0, rootWithNestedUpdates = null, Error(formatProdErrorMessage(185));
        for (var parent = sourceFiber.return; null !== parent; )
          sourceFiber = parent, parent = sourceFiber.return;
        return 3 === sourceFiber.tag ? sourceFiber.stateNode : null;
      }
      __name(getRootForUpdatedFiber, "getRootForUpdatedFiber");
      function initializeUpdateQueue(fiber) {
        fiber.updateQueue = {
          baseState: fiber.memoizedState,
          firstBaseUpdate: null,
          lastBaseUpdate: null,
          shared: { pending: null, lanes: 0, hiddenCallbacks: null },
          callbacks: null
        };
      }
      __name(initializeUpdateQueue, "initializeUpdateQueue");
      function cloneUpdateQueue(current, workInProgress2) {
        current = current.updateQueue;
        workInProgress2.updateQueue === current && (workInProgress2.updateQueue = {
          baseState: current.baseState,
          firstBaseUpdate: current.firstBaseUpdate,
          lastBaseUpdate: current.lastBaseUpdate,
          shared: current.shared,
          callbacks: null
        });
      }
      __name(cloneUpdateQueue, "cloneUpdateQueue");
      function createUpdate(lane) {
        return { lane, tag: 0, payload: null, callback: null, next: null };
      }
      __name(createUpdate, "createUpdate");
      function enqueueUpdate(fiber, update, lane) {
        var updateQueue = fiber.updateQueue;
        if (null === updateQueue) return null;
        updateQueue = updateQueue.shared;
        if (0 !== (executionContext & 2)) {
          var pending = updateQueue.pending;
          null === pending ? update.next = update : (update.next = pending.next, pending.next = update);
          updateQueue.pending = update;
          update = getRootForUpdatedFiber(fiber);
          markUpdateLaneFromFiberToRoot(fiber, null, lane);
          return update;
        }
        enqueueUpdate$1(fiber, updateQueue, update, lane);
        return getRootForUpdatedFiber(fiber);
      }
      __name(enqueueUpdate, "enqueueUpdate");
      function entangleTransitions(root, fiber, lane) {
        fiber = fiber.updateQueue;
        if (null !== fiber && (fiber = fiber.shared, 0 !== (lane & 4194048))) {
          var queueLanes = fiber.lanes;
          queueLanes &= root.pendingLanes;
          lane |= queueLanes;
          fiber.lanes = lane;
          markRootEntangled(root, lane);
        }
      }
      __name(entangleTransitions, "entangleTransitions");
      function enqueueCapturedUpdate(workInProgress2, capturedUpdate) {
        var queue = workInProgress2.updateQueue, current = workInProgress2.alternate;
        if (null !== current && (current = current.updateQueue, queue === current)) {
          var newFirst = null, newLast = null;
          queue = queue.firstBaseUpdate;
          if (null !== queue) {
            do {
              var clone = {
                lane: queue.lane,
                tag: queue.tag,
                payload: queue.payload,
                callback: null,
                next: null
              };
              null === newLast ? newFirst = newLast = clone : newLast = newLast.next = clone;
              queue = queue.next;
            } while (null !== queue);
            null === newLast ? newFirst = newLast = capturedUpdate : newLast = newLast.next = capturedUpdate;
          } else newFirst = newLast = capturedUpdate;
          queue = {
            baseState: current.baseState,
            firstBaseUpdate: newFirst,
            lastBaseUpdate: newLast,
            shared: current.shared,
            callbacks: current.callbacks
          };
          workInProgress2.updateQueue = queue;
          return;
        }
        workInProgress2 = queue.lastBaseUpdate;
        null === workInProgress2 ? queue.firstBaseUpdate = capturedUpdate : workInProgress2.next = capturedUpdate;
        queue.lastBaseUpdate = capturedUpdate;
      }
      __name(enqueueCapturedUpdate, "enqueueCapturedUpdate");
      function suspendIfUpdateReadFromEntangledAsyncAction() {
        if (didReadFromEntangledAsyncAction) {
          var entangledActionThenable = currentEntangledActionThenable;
          if (null !== entangledActionThenable) throw entangledActionThenable;
        }
      }
      __name(suspendIfUpdateReadFromEntangledAsyncAction, "suspendIfUpdateReadFromEntangledAsyncAction");
      function processUpdateQueue(workInProgress$jscomp$0, props, instance$jscomp$0, renderLanes2) {
        didReadFromEntangledAsyncAction = false;
        var queue = workInProgress$jscomp$0.updateQueue;
        hasForceUpdate = false;
        var firstBaseUpdate = queue.firstBaseUpdate, lastBaseUpdate = queue.lastBaseUpdate, pendingQueue = queue.shared.pending;
        if (null !== pendingQueue) {
          queue.shared.pending = null;
          var lastPendingUpdate = pendingQueue, firstPendingUpdate = lastPendingUpdate.next;
          lastPendingUpdate.next = null;
          null === lastBaseUpdate ? firstBaseUpdate = firstPendingUpdate : lastBaseUpdate.next = firstPendingUpdate;
          lastBaseUpdate = lastPendingUpdate;
          var current = workInProgress$jscomp$0.alternate;
          null !== current && (current = current.updateQueue, pendingQueue = current.lastBaseUpdate, pendingQueue !== lastBaseUpdate && (null === pendingQueue ? current.firstBaseUpdate = firstPendingUpdate : pendingQueue.next = firstPendingUpdate, current.lastBaseUpdate = lastPendingUpdate));
        }
        if (null !== firstBaseUpdate) {
          var newState = queue.baseState;
          lastBaseUpdate = 0;
          current = firstPendingUpdate = lastPendingUpdate = null;
          pendingQueue = firstBaseUpdate;
          do {
            var updateLane = pendingQueue.lane & -536870913, isHiddenUpdate = updateLane !== pendingQueue.lane;
            if (isHiddenUpdate ? (workInProgressRootRenderLanes & updateLane) === updateLane : (renderLanes2 & updateLane) === updateLane) {
              0 !== updateLane && updateLane === currentEntangledLane && (didReadFromEntangledAsyncAction = true);
              null !== current && (current = current.next = {
                lane: 0,
                tag: pendingQueue.tag,
                payload: pendingQueue.payload,
                callback: null,
                next: null
              });
              a: {
                var workInProgress2 = workInProgress$jscomp$0, update = pendingQueue;
                updateLane = props;
                var instance = instance$jscomp$0;
                switch (update.tag) {
                  case 1:
                    workInProgress2 = update.payload;
                    if ("function" === typeof workInProgress2) {
                      newState = workInProgress2.call(
                        instance,
                        newState,
                        updateLane
                      );
                      break a;
                    }
                    newState = workInProgress2;
                    break a;
                  case 3:
                    workInProgress2.flags = workInProgress2.flags & -65537 | 128;
                  case 0:
                    workInProgress2 = update.payload;
                    updateLane = "function" === typeof workInProgress2 ? workInProgress2.call(instance, newState, updateLane) : workInProgress2;
                    if (null === updateLane || void 0 === updateLane) break a;
                    newState = assign({}, newState, updateLane);
                    break a;
                  case 2:
                    hasForceUpdate = true;
                }
              }
              updateLane = pendingQueue.callback;
              null !== updateLane && (workInProgress$jscomp$0.flags |= 64, isHiddenUpdate && (workInProgress$jscomp$0.flags |= 8192), isHiddenUpdate = queue.callbacks, null === isHiddenUpdate ? queue.callbacks = [updateLane] : isHiddenUpdate.push(updateLane));
            } else
              isHiddenUpdate = {
                lane: updateLane,
                tag: pendingQueue.tag,
                payload: pendingQueue.payload,
                callback: pendingQueue.callback,
                next: null
              }, null === current ? (firstPendingUpdate = current = isHiddenUpdate, lastPendingUpdate = newState) : current = current.next = isHiddenUpdate, lastBaseUpdate |= updateLane;
            pendingQueue = pendingQueue.next;
            if (null === pendingQueue)
              if (pendingQueue = queue.shared.pending, null === pendingQueue)
                break;
              else
                isHiddenUpdate = pendingQueue, pendingQueue = isHiddenUpdate.next, isHiddenUpdate.next = null, queue.lastBaseUpdate = isHiddenUpdate, queue.shared.pending = null;
          } while (1);
          null === current && (lastPendingUpdate = newState);
          queue.baseState = lastPendingUpdate;
          queue.firstBaseUpdate = firstPendingUpdate;
          queue.lastBaseUpdate = current;
          null === firstBaseUpdate && (queue.shared.lanes = 0);
          workInProgressRootSkippedLanes |= lastBaseUpdate;
          workInProgress$jscomp$0.lanes = lastBaseUpdate;
          workInProgress$jscomp$0.memoizedState = newState;
        }
      }
      __name(processUpdateQueue, "processUpdateQueue");
      function callCallback(callback, context) {
        if ("function" !== typeof callback)
          throw Error(formatProdErrorMessage(191, callback));
        callback.call(context);
      }
      __name(callCallback, "callCallback");
      function commitCallbacks(updateQueue, context) {
        var callbacks = updateQueue.callbacks;
        if (null !== callbacks)
          for (updateQueue.callbacks = null, updateQueue = 0; updateQueue < callbacks.length; updateQueue++)
            callCallback(callbacks[updateQueue], context);
      }
      __name(commitCallbacks, "commitCallbacks");
      function pushHiddenContext(fiber, context) {
        fiber = entangledRenderLanes;
        push(prevEntangledRenderLanesCursor, fiber);
        push(currentTreeHiddenStackCursor, context);
        entangledRenderLanes = fiber | context.baseLanes;
      }
      __name(pushHiddenContext, "pushHiddenContext");
      function reuseHiddenContextOnStack() {
        push(prevEntangledRenderLanesCursor, entangledRenderLanes);
        push(currentTreeHiddenStackCursor, currentTreeHiddenStackCursor.current);
      }
      __name(reuseHiddenContextOnStack, "reuseHiddenContextOnStack");
      function popHiddenContext() {
        entangledRenderLanes = prevEntangledRenderLanesCursor.current;
        pop(currentTreeHiddenStackCursor);
        pop(prevEntangledRenderLanesCursor);
      }
      __name(popHiddenContext, "popHiddenContext");
      function pushPrimaryTreeSuspenseHandler(handler) {
        var current = handler.alternate;
        push(suspenseStackCursor, suspenseStackCursor.current & 1);
        push(suspenseHandlerStackCursor, handler);
        null === shellBoundary && (null === current || null !== currentTreeHiddenStackCursor.current ? shellBoundary = handler : null !== current.memoizedState && (shellBoundary = handler));
      }
      __name(pushPrimaryTreeSuspenseHandler, "pushPrimaryTreeSuspenseHandler");
      function pushDehydratedActivitySuspenseHandler(fiber) {
        push(suspenseStackCursor, suspenseStackCursor.current);
        push(suspenseHandlerStackCursor, fiber);
        null === shellBoundary && (shellBoundary = fiber);
      }
      __name(pushDehydratedActivitySuspenseHandler, "pushDehydratedActivitySuspenseHandler");
      function pushOffscreenSuspenseHandler(fiber) {
        22 === fiber.tag ? (push(suspenseStackCursor, suspenseStackCursor.current), push(suspenseHandlerStackCursor, fiber), null === shellBoundary && (shellBoundary = fiber)) : reuseSuspenseHandlerOnStack(fiber);
      }
      __name(pushOffscreenSuspenseHandler, "pushOffscreenSuspenseHandler");
      function reuseSuspenseHandlerOnStack() {
        push(suspenseStackCursor, suspenseStackCursor.current);
        push(suspenseHandlerStackCursor, suspenseHandlerStackCursor.current);
      }
      __name(reuseSuspenseHandlerOnStack, "reuseSuspenseHandlerOnStack");
      function popSuspenseHandler(fiber) {
        pop(suspenseHandlerStackCursor);
        shellBoundary === fiber && (shellBoundary = null);
        pop(suspenseStackCursor);
      }
      __name(popSuspenseHandler, "popSuspenseHandler");
      function findFirstSuspended(row) {
        for (var node = row; null !== node; ) {
          if (13 === node.tag) {
            var state = node.memoizedState;
            if (null !== state && (state = state.dehydrated, null === state || isSuspenseInstancePending(state) || isSuspenseInstanceFallback(state)))
              return node;
          } else if (19 === node.tag && ("forwards" === node.memoizedProps.revealOrder || "backwards" === node.memoizedProps.revealOrder || "unstable_legacy-backwards" === node.memoizedProps.revealOrder || "together" === node.memoizedProps.revealOrder)) {
            if (0 !== (node.flags & 128)) return node;
          } else if (null !== node.child) {
            node.child.return = node;
            node = node.child;
            continue;
          }
          if (node === row) break;
          for (; null === node.sibling; ) {
            if (null === node.return || node.return === row) return null;
            node = node.return;
          }
          node.sibling.return = node.return;
          node = node.sibling;
        }
        return null;
      }
      __name(findFirstSuspended, "findFirstSuspended");
      function throwInvalidHookError() {
        throw Error(formatProdErrorMessage(321));
      }
      __name(throwInvalidHookError, "throwInvalidHookError");
      function areHookInputsEqual(nextDeps, prevDeps) {
        if (null === prevDeps) return false;
        for (var i = 0; i < prevDeps.length && i < nextDeps.length; i++)
          if (!objectIs(nextDeps[i], prevDeps[i])) return false;
        return true;
      }
      __name(areHookInputsEqual, "areHookInputsEqual");
      function renderWithHooks(current, workInProgress2, Component, props, secondArg, nextRenderLanes) {
        renderLanes = nextRenderLanes;
        currentlyRenderingFiber = workInProgress2;
        workInProgress2.memoizedState = null;
        workInProgress2.updateQueue = null;
        workInProgress2.lanes = 0;
        ReactSharedInternals.H = null === current || null === current.memoizedState ? HooksDispatcherOnMount : HooksDispatcherOnUpdate;
        shouldDoubleInvokeUserFnsInHooksDEV = false;
        nextRenderLanes = Component(props, secondArg);
        shouldDoubleInvokeUserFnsInHooksDEV = false;
        didScheduleRenderPhaseUpdateDuringThisPass && (nextRenderLanes = renderWithHooksAgain(
          workInProgress2,
          Component,
          props,
          secondArg
        ));
        finishRenderingHooks(current);
        return nextRenderLanes;
      }
      __name(renderWithHooks, "renderWithHooks");
      function finishRenderingHooks(current) {
        ReactSharedInternals.H = ContextOnlyDispatcher;
        var didRenderTooFewHooks = null !== currentHook && null !== currentHook.next;
        renderLanes = 0;
        workInProgressHook = currentHook = currentlyRenderingFiber = null;
        didScheduleRenderPhaseUpdate = false;
        thenableIndexCounter = 0;
        thenableState = null;
        if (didRenderTooFewHooks) throw Error(formatProdErrorMessage(300));
        null === current || didReceiveUpdate || (current = current.dependencies, null !== current && checkIfContextChanged(current) && (didReceiveUpdate = true));
      }
      __name(finishRenderingHooks, "finishRenderingHooks");
      function renderWithHooksAgain(workInProgress2, Component, props, secondArg) {
        currentlyRenderingFiber = workInProgress2;
        var numberOfReRenders = 0;
        do {
          didScheduleRenderPhaseUpdateDuringThisPass && (thenableState = null);
          thenableIndexCounter = 0;
          didScheduleRenderPhaseUpdateDuringThisPass = false;
          if (25 <= numberOfReRenders) throw Error(formatProdErrorMessage(301));
          numberOfReRenders += 1;
          workInProgressHook = currentHook = null;
          if (null != workInProgress2.updateQueue) {
            var children = workInProgress2.updateQueue;
            children.lastEffect = null;
            children.events = null;
            children.stores = null;
            null != children.memoCache && (children.memoCache.index = 0);
          }
          ReactSharedInternals.H = HooksDispatcherOnRerender;
          children = Component(props, secondArg);
        } while (didScheduleRenderPhaseUpdateDuringThisPass);
        return children;
      }
      __name(renderWithHooksAgain, "renderWithHooksAgain");
      function TransitionAwareHostComponent() {
        var dispatcher = ReactSharedInternals.H, maybeThenable = dispatcher.useState()[0];
        maybeThenable = "function" === typeof maybeThenable.then ? useThenable(maybeThenable) : maybeThenable;
        dispatcher = dispatcher.useState()[0];
        (null !== currentHook ? currentHook.memoizedState : null) !== dispatcher && (currentlyRenderingFiber.flags |= 1024);
        return maybeThenable;
      }
      __name(TransitionAwareHostComponent, "TransitionAwareHostComponent");
      function checkDidRenderIdHook() {
        var didRenderIdHook = 0 !== localIdCounter;
        localIdCounter = 0;
        return didRenderIdHook;
      }
      __name(checkDidRenderIdHook, "checkDidRenderIdHook");
      function bailoutHooks(current, workInProgress2, lanes) {
        workInProgress2.updateQueue = current.updateQueue;
        workInProgress2.flags &= -2053;
        current.lanes &= ~lanes;
      }
      __name(bailoutHooks, "bailoutHooks");
      function resetHooksOnUnwind(workInProgress2) {
        if (didScheduleRenderPhaseUpdate) {
          for (workInProgress2 = workInProgress2.memoizedState; null !== workInProgress2; ) {
            var queue = workInProgress2.queue;
            null !== queue && (queue.pending = null);
            workInProgress2 = workInProgress2.next;
          }
          didScheduleRenderPhaseUpdate = false;
        }
        renderLanes = 0;
        workInProgressHook = currentHook = currentlyRenderingFiber = null;
        didScheduleRenderPhaseUpdateDuringThisPass = false;
        thenableIndexCounter = localIdCounter = 0;
        thenableState = null;
      }
      __name(resetHooksOnUnwind, "resetHooksOnUnwind");
      function mountWorkInProgressHook() {
        var hook = {
          memoizedState: null,
          baseState: null,
          baseQueue: null,
          queue: null,
          next: null
        };
        null === workInProgressHook ? currentlyRenderingFiber.memoizedState = workInProgressHook = hook : workInProgressHook = workInProgressHook.next = hook;
        return workInProgressHook;
      }
      __name(mountWorkInProgressHook, "mountWorkInProgressHook");
      function updateWorkInProgressHook() {
        if (null === currentHook) {
          var nextCurrentHook = currentlyRenderingFiber.alternate;
          nextCurrentHook = null !== nextCurrentHook ? nextCurrentHook.memoizedState : null;
        } else nextCurrentHook = currentHook.next;
        var nextWorkInProgressHook = null === workInProgressHook ? currentlyRenderingFiber.memoizedState : workInProgressHook.next;
        if (null !== nextWorkInProgressHook)
          workInProgressHook = nextWorkInProgressHook, currentHook = nextCurrentHook;
        else {
          if (null === nextCurrentHook) {
            if (null === currentlyRenderingFiber.alternate)
              throw Error(formatProdErrorMessage(467));
            throw Error(formatProdErrorMessage(310));
          }
          currentHook = nextCurrentHook;
          nextCurrentHook = {
            memoizedState: currentHook.memoizedState,
            baseState: currentHook.baseState,
            baseQueue: currentHook.baseQueue,
            queue: currentHook.queue,
            next: null
          };
          null === workInProgressHook ? currentlyRenderingFiber.memoizedState = workInProgressHook = nextCurrentHook : workInProgressHook = workInProgressHook.next = nextCurrentHook;
        }
        return workInProgressHook;
      }
      __name(updateWorkInProgressHook, "updateWorkInProgressHook");
      function createFunctionComponentUpdateQueue() {
        return { lastEffect: null, events: null, stores: null, memoCache: null };
      }
      __name(createFunctionComponentUpdateQueue, "createFunctionComponentUpdateQueue");
      function useThenable(thenable) {
        var index = thenableIndexCounter;
        thenableIndexCounter += 1;
        null === thenableState && (thenableState = []);
        thenable = trackUsedThenable(thenableState, thenable, index);
        index = currentlyRenderingFiber;
        null === (null === workInProgressHook ? index.memoizedState : workInProgressHook.next) && (index = index.alternate, ReactSharedInternals.H = null === index || null === index.memoizedState ? HooksDispatcherOnMount : HooksDispatcherOnUpdate);
        return thenable;
      }
      __name(useThenable, "useThenable");
      function use(usable) {
        if (null !== usable && "object" === typeof usable) {
          if ("function" === typeof usable.then) return useThenable(usable);
          if (usable.$$typeof === REACT_CONTEXT_TYPE) return readContext(usable);
        }
        throw Error(formatProdErrorMessage(438, String(usable)));
      }
      __name(use, "use");
      function useMemoCache(size) {
        var memoCache = null, updateQueue = currentlyRenderingFiber.updateQueue;
        null !== updateQueue && (memoCache = updateQueue.memoCache);
        if (null == memoCache) {
          var current = currentlyRenderingFiber.alternate;
          null !== current && (current = current.updateQueue, null !== current && (current = current.memoCache, null != current && (memoCache = {
            data: current.data.map(function(array) {
              return array.slice();
            }),
            index: 0
          })));
        }
        null == memoCache && (memoCache = { data: [], index: 0 });
        null === updateQueue && (updateQueue = createFunctionComponentUpdateQueue(), currentlyRenderingFiber.updateQueue = updateQueue);
        updateQueue.memoCache = memoCache;
        updateQueue = memoCache.data[memoCache.index];
        if (void 0 === updateQueue)
          for (updateQueue = memoCache.data[memoCache.index] = Array(size), current = 0; current < size; current++)
            updateQueue[current] = REACT_MEMO_CACHE_SENTINEL;
        memoCache.index++;
        return updateQueue;
      }
      __name(useMemoCache, "useMemoCache");
      function basicStateReducer(state, action) {
        return "function" === typeof action ? action(state) : action;
      }
      __name(basicStateReducer, "basicStateReducer");
      function updateReducer(reducer) {
        var hook = updateWorkInProgressHook();
        return updateReducerImpl(hook, currentHook, reducer);
      }
      __name(updateReducer, "updateReducer");
      function updateReducerImpl(hook, current, reducer) {
        var queue = hook.queue;
        if (null === queue) throw Error(formatProdErrorMessage(311));
        queue.lastRenderedReducer = reducer;
        var baseQueue = hook.baseQueue, pendingQueue = queue.pending;
        if (null !== pendingQueue) {
          if (null !== baseQueue) {
            var baseFirst = baseQueue.next;
            baseQueue.next = pendingQueue.next;
            pendingQueue.next = baseFirst;
          }
          current.baseQueue = baseQueue = pendingQueue;
          queue.pending = null;
        }
        pendingQueue = hook.baseState;
        if (null === baseQueue) hook.memoizedState = pendingQueue;
        else {
          current = baseQueue.next;
          var newBaseQueueFirst = baseFirst = null, newBaseQueueLast = null, update = current, didReadFromEntangledAsyncAction$51 = false;
          do {
            var updateLane = update.lane & -536870913;
            if (updateLane !== update.lane ? (workInProgressRootRenderLanes & updateLane) === updateLane : (renderLanes & updateLane) === updateLane) {
              var revertLane = update.revertLane;
              if (0 === revertLane)
                null !== newBaseQueueLast && (newBaseQueueLast = newBaseQueueLast.next = {
                  lane: 0,
                  revertLane: 0,
                  gesture: null,
                  action: update.action,
                  hasEagerState: update.hasEagerState,
                  eagerState: update.eagerState,
                  next: null
                }), updateLane === currentEntangledLane && (didReadFromEntangledAsyncAction$51 = true);
              else if ((renderLanes & revertLane) === revertLane) {
                update = update.next;
                revertLane === currentEntangledLane && (didReadFromEntangledAsyncAction$51 = true);
                continue;
              } else
                updateLane = {
                  lane: 0,
                  revertLane: update.revertLane,
                  gesture: null,
                  action: update.action,
                  hasEagerState: update.hasEagerState,
                  eagerState: update.eagerState,
                  next: null
                }, null === newBaseQueueLast ? (newBaseQueueFirst = newBaseQueueLast = updateLane, baseFirst = pendingQueue) : newBaseQueueLast = newBaseQueueLast.next = updateLane, currentlyRenderingFiber.lanes |= revertLane, workInProgressRootSkippedLanes |= revertLane;
              updateLane = update.action;
              shouldDoubleInvokeUserFnsInHooksDEV && reducer(pendingQueue, updateLane);
              pendingQueue = update.hasEagerState ? update.eagerState : reducer(pendingQueue, updateLane);
            } else
              revertLane = {
                lane: updateLane,
                revertLane: update.revertLane,
                gesture: update.gesture,
                action: update.action,
                hasEagerState: update.hasEagerState,
                eagerState: update.eagerState,
                next: null
              }, null === newBaseQueueLast ? (newBaseQueueFirst = newBaseQueueLast = revertLane, baseFirst = pendingQueue) : newBaseQueueLast = newBaseQueueLast.next = revertLane, currentlyRenderingFiber.lanes |= updateLane, workInProgressRootSkippedLanes |= updateLane;
            update = update.next;
          } while (null !== update && update !== current);
          null === newBaseQueueLast ? baseFirst = pendingQueue : newBaseQueueLast.next = newBaseQueueFirst;
          if (!objectIs(pendingQueue, hook.memoizedState) && (didReceiveUpdate = true, didReadFromEntangledAsyncAction$51 && (reducer = currentEntangledActionThenable, null !== reducer)))
            throw reducer;
          hook.memoizedState = pendingQueue;
          hook.baseState = baseFirst;
          hook.baseQueue = newBaseQueueLast;
          queue.lastRenderedState = pendingQueue;
        }
        null === baseQueue && (queue.lanes = 0);
        return [hook.memoizedState, queue.dispatch];
      }
      __name(updateReducerImpl, "updateReducerImpl");
      function rerenderReducer(reducer) {
        var hook = updateWorkInProgressHook(), queue = hook.queue;
        if (null === queue) throw Error(formatProdErrorMessage(311));
        queue.lastRenderedReducer = reducer;
        var dispatch = queue.dispatch, lastRenderPhaseUpdate = queue.pending, newState = hook.memoizedState;
        if (null !== lastRenderPhaseUpdate) {
          queue.pending = null;
          var update = lastRenderPhaseUpdate = lastRenderPhaseUpdate.next;
          do
            newState = reducer(newState, update.action), update = update.next;
          while (update !== lastRenderPhaseUpdate);
          objectIs(newState, hook.memoizedState) || (didReceiveUpdate = true);
          hook.memoizedState = newState;
          null === hook.baseQueue && (hook.baseState = newState);
          queue.lastRenderedState = newState;
        }
        return [newState, dispatch];
      }
      __name(rerenderReducer, "rerenderReducer");
      function updateSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) {
        var fiber = currentlyRenderingFiber, hook = updateWorkInProgressHook(), isHydrating$jscomp$0 = isHydrating;
        if (isHydrating$jscomp$0) {
          if (void 0 === getServerSnapshot)
            throw Error(formatProdErrorMessage(407));
          getServerSnapshot = getServerSnapshot();
        } else getServerSnapshot = getSnapshot();
        var snapshotChanged = !objectIs(
          (currentHook || hook).memoizedState,
          getServerSnapshot
        );
        snapshotChanged && (hook.memoizedState = getServerSnapshot, didReceiveUpdate = true);
        hook = hook.queue;
        updateEffect(subscribeToStore.bind(null, fiber, hook, subscribe), [
          subscribe
        ]);
        if (hook.getSnapshot !== getSnapshot || snapshotChanged || null !== workInProgressHook && workInProgressHook.memoizedState.tag & 1) {
          fiber.flags |= 2048;
          pushSimpleEffect(
            9,
            { destroy: void 0 },
            updateStoreInstance.bind(
              null,
              fiber,
              hook,
              getServerSnapshot,
              getSnapshot
            ),
            null
          );
          if (null === workInProgressRoot) throw Error(formatProdErrorMessage(349));
          isHydrating$jscomp$0 || 0 !== (renderLanes & 127) || pushStoreConsistencyCheck(fiber, getSnapshot, getServerSnapshot);
        }
        return getServerSnapshot;
      }
      __name(updateSyncExternalStore, "updateSyncExternalStore");
      function pushStoreConsistencyCheck(fiber, getSnapshot, renderedSnapshot) {
        fiber.flags |= 16384;
        fiber = { getSnapshot, value: renderedSnapshot };
        getSnapshot = currentlyRenderingFiber.updateQueue;
        null === getSnapshot ? (getSnapshot = createFunctionComponentUpdateQueue(), currentlyRenderingFiber.updateQueue = getSnapshot, getSnapshot.stores = [fiber]) : (renderedSnapshot = getSnapshot.stores, null === renderedSnapshot ? getSnapshot.stores = [fiber] : renderedSnapshot.push(fiber));
      }
      __name(pushStoreConsistencyCheck, "pushStoreConsistencyCheck");
      function updateStoreInstance(fiber, inst, nextSnapshot, getSnapshot) {
        inst.value = nextSnapshot;
        inst.getSnapshot = getSnapshot;
        checkIfSnapshotChanged(inst) && forceStoreRerender(fiber);
      }
      __name(updateStoreInstance, "updateStoreInstance");
      function subscribeToStore(fiber, inst, subscribe) {
        return subscribe(function() {
          checkIfSnapshotChanged(inst) && forceStoreRerender(fiber);
        });
      }
      __name(subscribeToStore, "subscribeToStore");
      function checkIfSnapshotChanged(inst) {
        var latestGetSnapshot = inst.getSnapshot;
        inst = inst.value;
        try {
          var nextValue = latestGetSnapshot();
          return !objectIs(inst, nextValue);
        } catch (error) {
          return true;
        }
      }
      __name(checkIfSnapshotChanged, "checkIfSnapshotChanged");
      function forceStoreRerender(fiber) {
        var root = enqueueConcurrentRenderForLane(fiber, 2);
        null !== root && scheduleUpdateOnFiber(root, fiber, 2);
      }
      __name(forceStoreRerender, "forceStoreRerender");
      function mountStateImpl(initialState) {
        var hook = mountWorkInProgressHook();
        if ("function" === typeof initialState) {
          var initialStateInitializer = initialState;
          initialState = initialStateInitializer();
          if (shouldDoubleInvokeUserFnsInHooksDEV) {
            setIsStrictModeForDevtools(true);
            try {
              initialStateInitializer();
            } finally {
              setIsStrictModeForDevtools(false);
            }
          }
        }
        hook.memoizedState = hook.baseState = initialState;
        hook.queue = {
          pending: null,
          lanes: 0,
          dispatch: null,
          lastRenderedReducer: basicStateReducer,
          lastRenderedState: initialState
        };
        return hook;
      }
      __name(mountStateImpl, "mountStateImpl");
      function updateOptimisticImpl(hook, current, passthrough, reducer) {
        hook.baseState = passthrough;
        return updateReducerImpl(
          hook,
          currentHook,
          "function" === typeof reducer ? reducer : basicStateReducer
        );
      }
      __name(updateOptimisticImpl, "updateOptimisticImpl");
      function dispatchActionState(fiber, actionQueue, setPendingState, setState, payload) {
        if (isRenderPhaseUpdate(fiber)) throw Error(formatProdErrorMessage(485));
        fiber = actionQueue.action;
        if (null !== fiber) {
          var actionNode = {
            payload,
            action: fiber,
            next: null,
            isTransition: true,
            status: "pending",
            value: null,
            reason: null,
            listeners: [],
            then: /* @__PURE__ */ __name(function(listener) {
              actionNode.listeners.push(listener);
            }, "then")
          };
          null !== ReactSharedInternals.T ? setPendingState(true) : actionNode.isTransition = false;
          setState(actionNode);
          setPendingState = actionQueue.pending;
          null === setPendingState ? (actionNode.next = actionQueue.pending = actionNode, runActionStateAction(actionQueue, actionNode)) : (actionNode.next = setPendingState.next, actionQueue.pending = setPendingState.next = actionNode);
        }
      }
      __name(dispatchActionState, "dispatchActionState");
      function runActionStateAction(actionQueue, node) {
        var action = node.action, payload = node.payload, prevState = actionQueue.state;
        if (node.isTransition) {
          var prevTransition = ReactSharedInternals.T, currentTransition = {};
          ReactSharedInternals.T = currentTransition;
          try {
            var returnValue = action(prevState, payload), onStartTransitionFinish = ReactSharedInternals.S;
            null !== onStartTransitionFinish && onStartTransitionFinish(currentTransition, returnValue);
            handleActionReturnValue(actionQueue, node, returnValue);
          } catch (error) {
            onActionError(actionQueue, node, error);
          } finally {
            null !== prevTransition && null !== currentTransition.types && (prevTransition.types = currentTransition.types), ReactSharedInternals.T = prevTransition;
          }
        } else
          try {
            prevTransition = action(prevState, payload), handleActionReturnValue(actionQueue, node, prevTransition);
          } catch (error$55) {
            onActionError(actionQueue, node, error$55);
          }
      }
      __name(runActionStateAction, "runActionStateAction");
      function handleActionReturnValue(actionQueue, node, returnValue) {
        null !== returnValue && "object" === typeof returnValue && "function" === typeof returnValue.then ? returnValue.then(
          function(nextState) {
            onActionSuccess(actionQueue, node, nextState);
          },
          function(error) {
            return onActionError(actionQueue, node, error);
          }
        ) : onActionSuccess(actionQueue, node, returnValue);
      }
      __name(handleActionReturnValue, "handleActionReturnValue");
      function onActionSuccess(actionQueue, actionNode, nextState) {
        actionNode.status = "fulfilled";
        actionNode.value = nextState;
        notifyActionListeners(actionNode);
        actionQueue.state = nextState;
        actionNode = actionQueue.pending;
        null !== actionNode && (nextState = actionNode.next, nextState === actionNode ? actionQueue.pending = null : (nextState = nextState.next, actionNode.next = nextState, runActionStateAction(actionQueue, nextState)));
      }
      __name(onActionSuccess, "onActionSuccess");
      function onActionError(actionQueue, actionNode, error) {
        var last = actionQueue.pending;
        actionQueue.pending = null;
        if (null !== last) {
          last = last.next;
          do
            actionNode.status = "rejected", actionNode.reason = error, notifyActionListeners(actionNode), actionNode = actionNode.next;
          while (actionNode !== last);
        }
        actionQueue.action = null;
      }
      __name(onActionError, "onActionError");
      function notifyActionListeners(actionNode) {
        actionNode = actionNode.listeners;
        for (var i = 0; i < actionNode.length; i++) (0, actionNode[i])();
      }
      __name(notifyActionListeners, "notifyActionListeners");
      function actionStateReducer(oldState, newState) {
        return newState;
      }
      __name(actionStateReducer, "actionStateReducer");
      function mountActionState(action, initialStateProp) {
        if (isHydrating) {
          var ssrFormState = workInProgressRoot.formState;
          if (null !== ssrFormState) {
            a: {
              var JSCompiler_inline_result = currentlyRenderingFiber;
              if (isHydrating) {
                if (nextHydratableInstance) {
                  var markerInstance = canHydrateFormStateMarker(
                    nextHydratableInstance,
                    rootOrSingletonContext
                  );
                  if (markerInstance) {
                    nextHydratableInstance = getNextHydratableSibling(markerInstance);
                    JSCompiler_inline_result = isFormStateMarkerMatching(markerInstance);
                    break a;
                  }
                }
                throwOnHydrationMismatch(JSCompiler_inline_result);
              }
              JSCompiler_inline_result = false;
            }
            JSCompiler_inline_result && (initialStateProp = ssrFormState[0]);
          }
        }
        ssrFormState = mountWorkInProgressHook();
        ssrFormState.memoizedState = ssrFormState.baseState = initialStateProp;
        JSCompiler_inline_result = {
          pending: null,
          lanes: 0,
          dispatch: null,
          lastRenderedReducer: actionStateReducer,
          lastRenderedState: initialStateProp
        };
        ssrFormState.queue = JSCompiler_inline_result;
        ssrFormState = dispatchSetState.bind(
          null,
          currentlyRenderingFiber,
          JSCompiler_inline_result
        );
        JSCompiler_inline_result.dispatch = ssrFormState;
        JSCompiler_inline_result = mountStateImpl(false);
        var setPendingState = dispatchOptimisticSetState.bind(
          null,
          currentlyRenderingFiber,
          false,
          JSCompiler_inline_result.queue
        );
        JSCompiler_inline_result = mountWorkInProgressHook();
        markerInstance = {
          state: initialStateProp,
          dispatch: null,
          action,
          pending: null
        };
        JSCompiler_inline_result.queue = markerInstance;
        ssrFormState = dispatchActionState.bind(
          null,
          currentlyRenderingFiber,
          markerInstance,
          setPendingState,
          ssrFormState
        );
        markerInstance.dispatch = ssrFormState;
        JSCompiler_inline_result.memoizedState = action;
        return [initialStateProp, ssrFormState, false];
      }
      __name(mountActionState, "mountActionState");
      function updateActionState(action) {
        var stateHook = updateWorkInProgressHook();
        return updateActionStateImpl(stateHook, currentHook, action);
      }
      __name(updateActionState, "updateActionState");
      function updateActionStateImpl(stateHook, currentStateHook, action) {
        currentStateHook = updateReducerImpl(
          stateHook,
          currentStateHook,
          actionStateReducer
        )[0];
        stateHook = updateReducer(basicStateReducer)[0];
        if ("object" === typeof currentStateHook && null !== currentStateHook && "function" === typeof currentStateHook.then)
          try {
            var state = useThenable(currentStateHook);
          } catch (x) {
            if (x === SuspenseException) throw SuspenseActionException;
            throw x;
          }
        else state = currentStateHook;
        currentStateHook = updateWorkInProgressHook();
        var actionQueue = currentStateHook.queue, dispatch = actionQueue.dispatch;
        action !== currentStateHook.memoizedState && (currentlyRenderingFiber.flags |= 2048, pushSimpleEffect(
          9,
          { destroy: void 0 },
          actionStateActionEffect.bind(null, actionQueue, action),
          null
        ));
        return [state, dispatch, stateHook];
      }
      __name(updateActionStateImpl, "updateActionStateImpl");
      function actionStateActionEffect(actionQueue, action) {
        actionQueue.action = action;
      }
      __name(actionStateActionEffect, "actionStateActionEffect");
      function rerenderActionState(action) {
        var stateHook = updateWorkInProgressHook(), currentStateHook = currentHook;
        if (null !== currentStateHook)
          return updateActionStateImpl(stateHook, currentStateHook, action);
        updateWorkInProgressHook();
        stateHook = stateHook.memoizedState;
        currentStateHook = updateWorkInProgressHook();
        var dispatch = currentStateHook.queue.dispatch;
        currentStateHook.memoizedState = action;
        return [stateHook, dispatch, false];
      }
      __name(rerenderActionState, "rerenderActionState");
      function pushSimpleEffect(tag, inst, create3, deps) {
        tag = { tag, create: create3, deps, inst, next: null };
        inst = currentlyRenderingFiber.updateQueue;
        null === inst && (inst = createFunctionComponentUpdateQueue(), currentlyRenderingFiber.updateQueue = inst);
        create3 = inst.lastEffect;
        null === create3 ? inst.lastEffect = tag.next = tag : (deps = create3.next, create3.next = tag, tag.next = deps, inst.lastEffect = tag);
        return tag;
      }
      __name(pushSimpleEffect, "pushSimpleEffect");
      function updateRef() {
        return updateWorkInProgressHook().memoizedState;
      }
      __name(updateRef, "updateRef");
      function mountEffectImpl(fiberFlags, hookFlags, create3, deps) {
        var hook = mountWorkInProgressHook();
        currentlyRenderingFiber.flags |= fiberFlags;
        hook.memoizedState = pushSimpleEffect(
          1 | hookFlags,
          { destroy: void 0 },
          create3,
          void 0 === deps ? null : deps
        );
      }
      __name(mountEffectImpl, "mountEffectImpl");
      function updateEffectImpl(fiberFlags, hookFlags, create3, deps) {
        var hook = updateWorkInProgressHook();
        deps = void 0 === deps ? null : deps;
        var inst = hook.memoizedState.inst;
        null !== currentHook && null !== deps && areHookInputsEqual(deps, currentHook.memoizedState.deps) ? hook.memoizedState = pushSimpleEffect(hookFlags, inst, create3, deps) : (currentlyRenderingFiber.flags |= fiberFlags, hook.memoizedState = pushSimpleEffect(
          1 | hookFlags,
          inst,
          create3,
          deps
        ));
      }
      __name(updateEffectImpl, "updateEffectImpl");
      function mountEffect(create3, deps) {
        mountEffectImpl(8390656, 8, create3, deps);
      }
      __name(mountEffect, "mountEffect");
      function updateEffect(create3, deps) {
        updateEffectImpl(2048, 8, create3, deps);
      }
      __name(updateEffect, "updateEffect");
      function useEffectEventImpl(payload) {
        currentlyRenderingFiber.flags |= 4;
        var componentUpdateQueue = currentlyRenderingFiber.updateQueue;
        if (null === componentUpdateQueue)
          componentUpdateQueue = createFunctionComponentUpdateQueue(), currentlyRenderingFiber.updateQueue = componentUpdateQueue, componentUpdateQueue.events = [payload];
        else {
          var events = componentUpdateQueue.events;
          null === events ? componentUpdateQueue.events = [payload] : events.push(payload);
        }
      }
      __name(useEffectEventImpl, "useEffectEventImpl");
      function updateEvent(callback) {
        var ref = updateWorkInProgressHook().memoizedState;
        useEffectEventImpl({ ref, nextImpl: callback });
        return function() {
          if (0 !== (executionContext & 2))
            throw Error(formatProdErrorMessage(440));
          return ref.impl.apply(void 0, arguments);
        };
      }
      __name(updateEvent, "updateEvent");
      function updateInsertionEffect(create3, deps) {
        return updateEffectImpl(4, 2, create3, deps);
      }
      __name(updateInsertionEffect, "updateInsertionEffect");
      function updateLayoutEffect(create3, deps) {
        return updateEffectImpl(4, 4, create3, deps);
      }
      __name(updateLayoutEffect, "updateLayoutEffect");
      function imperativeHandleEffect(create3, ref) {
        if ("function" === typeof ref) {
          create3 = create3();
          var refCleanup = ref(create3);
          return function() {
            "function" === typeof refCleanup ? refCleanup() : ref(null);
          };
        }
        if (null !== ref && void 0 !== ref)
          return create3 = create3(), ref.current = create3, function() {
            ref.current = null;
          };
      }
      __name(imperativeHandleEffect, "imperativeHandleEffect");
      function updateImperativeHandle(ref, create3, deps) {
        deps = null !== deps && void 0 !== deps ? deps.concat([ref]) : null;
        updateEffectImpl(
          4,
          4,
          imperativeHandleEffect.bind(null, create3, ref),
          deps
        );
      }
      __name(updateImperativeHandle, "updateImperativeHandle");
      function mountDebugValue() {
      }
      __name(mountDebugValue, "mountDebugValue");
      function updateCallback(callback, deps) {
        var hook = updateWorkInProgressHook();
        deps = void 0 === deps ? null : deps;
        var prevState = hook.memoizedState;
        if (null !== deps && areHookInputsEqual(deps, prevState[1]))
          return prevState[0];
        hook.memoizedState = [callback, deps];
        return callback;
      }
      __name(updateCallback, "updateCallback");
      function updateMemo(nextCreate, deps) {
        var hook = updateWorkInProgressHook();
        deps = void 0 === deps ? null : deps;
        var prevState = hook.memoizedState;
        if (null !== deps && areHookInputsEqual(deps, prevState[1]))
          return prevState[0];
        prevState = nextCreate();
        if (shouldDoubleInvokeUserFnsInHooksDEV) {
          setIsStrictModeForDevtools(true);
          try {
            nextCreate();
          } finally {
            setIsStrictModeForDevtools(false);
          }
        }
        hook.memoizedState = [prevState, deps];
        return prevState;
      }
      __name(updateMemo, "updateMemo");
      function mountDeferredValueImpl(hook, value, initialValue) {
        if (void 0 === initialValue || 0 !== (renderLanes & 1073741824) && 0 === (workInProgressRootRenderLanes & 261930))
          return hook.memoizedState = value;
        hook.memoizedState = initialValue;
        hook = requestDeferredLane();
        currentlyRenderingFiber.lanes |= hook;
        workInProgressRootSkippedLanes |= hook;
        return initialValue;
      }
      __name(mountDeferredValueImpl, "mountDeferredValueImpl");
      function updateDeferredValueImpl(hook, prevValue, value, initialValue) {
        if (objectIs(value, prevValue)) return value;
        if (null !== currentTreeHiddenStackCursor.current)
          return hook = mountDeferredValueImpl(hook, value, initialValue), objectIs(hook, prevValue) || (didReceiveUpdate = true), hook;
        if (0 === (renderLanes & 42) || 0 !== (renderLanes & 1073741824) && 0 === (workInProgressRootRenderLanes & 261930))
          return didReceiveUpdate = true, hook.memoizedState = value;
        hook = requestDeferredLane();
        currentlyRenderingFiber.lanes |= hook;
        workInProgressRootSkippedLanes |= hook;
        return prevValue;
      }
      __name(updateDeferredValueImpl, "updateDeferredValueImpl");
      function startTransition(fiber, queue, pendingState, finishedState, callback) {
        var previousPriority = getCurrentUpdatePriority();
        setCurrentUpdatePriority(
          0 !== previousPriority && 8 > previousPriority ? previousPriority : 8
        );
        var prevTransition = ReactSharedInternals.T, currentTransition = {};
        ReactSharedInternals.T = currentTransition;
        dispatchOptimisticSetState(fiber, false, queue, pendingState);
        try {
          var returnValue = callback(), onStartTransitionFinish = ReactSharedInternals.S;
          null !== onStartTransitionFinish && onStartTransitionFinish(currentTransition, returnValue);
          if (null !== returnValue && "object" === typeof returnValue && "function" === typeof returnValue.then) {
            var thenableForFinishedState = chainThenableValue(
              returnValue,
              finishedState
            );
            dispatchSetStateInternal(
              fiber,
              queue,
              thenableForFinishedState,
              requestUpdateLane(fiber)
            );
          } else
            dispatchSetStateInternal(
              fiber,
              queue,
              finishedState,
              requestUpdateLane(fiber)
            );
        } catch (error) {
          dispatchSetStateInternal(
            fiber,
            queue,
            { then: /* @__PURE__ */ __name(function() {
            }, "then"), status: "rejected", reason: error },
            requestUpdateLane()
          );
        } finally {
          setCurrentUpdatePriority(previousPriority), null !== prevTransition && null !== currentTransition.types && (prevTransition.types = currentTransition.types), ReactSharedInternals.T = prevTransition;
        }
      }
      __name(startTransition, "startTransition");
      function ensureFormComponentIsStateful(formFiber) {
        var existingStateHook = formFiber.memoizedState;
        if (null !== existingStateHook) return existingStateHook;
        existingStateHook = {
          memoizedState: NotPendingTransition,
          baseState: NotPendingTransition,
          baseQueue: null,
          queue: {
            pending: null,
            lanes: 0,
            dispatch: null,
            lastRenderedReducer: basicStateReducer,
            lastRenderedState: NotPendingTransition
          },
          next: null
        };
        var initialResetState = {};
        existingStateHook.next = {
          memoizedState: initialResetState,
          baseState: initialResetState,
          baseQueue: null,
          queue: {
            pending: null,
            lanes: 0,
            dispatch: null,
            lastRenderedReducer: basicStateReducer,
            lastRenderedState: initialResetState
          },
          next: null
        };
        formFiber.memoizedState = existingStateHook;
        formFiber = formFiber.alternate;
        null !== formFiber && (formFiber.memoizedState = existingStateHook);
        return existingStateHook;
      }
      __name(ensureFormComponentIsStateful, "ensureFormComponentIsStateful");
      function useHostTransitionStatus() {
        return readContext(HostTransitionContext);
      }
      __name(useHostTransitionStatus, "useHostTransitionStatus");
      function updateId() {
        return updateWorkInProgressHook().memoizedState;
      }
      __name(updateId, "updateId");
      function updateRefresh() {
        return updateWorkInProgressHook().memoizedState;
      }
      __name(updateRefresh, "updateRefresh");
      function refreshCache(fiber) {
        for (var provider = fiber.return; null !== provider; ) {
          switch (provider.tag) {
            case 24:
            case 3:
              var lane = requestUpdateLane();
              fiber = createUpdate(lane);
              var root = enqueueUpdate(provider, fiber, lane);
              null !== root && (scheduleUpdateOnFiber(root, provider, lane), entangleTransitions(root, provider, lane));
              provider = { cache: createCache() };
              fiber.payload = provider;
              return;
          }
          provider = provider.return;
        }
      }
      __name(refreshCache, "refreshCache");
      function dispatchReducerAction(fiber, queue, action) {
        var lane = requestUpdateLane();
        action = {
          lane,
          revertLane: 0,
          gesture: null,
          action,
          hasEagerState: false,
          eagerState: null,
          next: null
        };
        isRenderPhaseUpdate(fiber) ? enqueueRenderPhaseUpdate(queue, action) : (action = enqueueConcurrentHookUpdate(fiber, queue, action, lane), null !== action && (scheduleUpdateOnFiber(action, fiber, lane), entangleTransitionUpdate(action, queue, lane)));
      }
      __name(dispatchReducerAction, "dispatchReducerAction");
      function dispatchSetState(fiber, queue, action) {
        var lane = requestUpdateLane();
        dispatchSetStateInternal(fiber, queue, action, lane);
      }
      __name(dispatchSetState, "dispatchSetState");
      function dispatchSetStateInternal(fiber, queue, action, lane) {
        var update = {
          lane,
          revertLane: 0,
          gesture: null,
          action,
          hasEagerState: false,
          eagerState: null,
          next: null
        };
        if (isRenderPhaseUpdate(fiber)) enqueueRenderPhaseUpdate(queue, update);
        else {
          var alternate = fiber.alternate;
          if (0 === fiber.lanes && (null === alternate || 0 === alternate.lanes) && (alternate = queue.lastRenderedReducer, null !== alternate))
            try {
              var currentState = queue.lastRenderedState, eagerState = alternate(currentState, action);
              update.hasEagerState = true;
              update.eagerState = eagerState;
              if (objectIs(eagerState, currentState))
                return enqueueUpdate$1(fiber, queue, update, 0), null === workInProgressRoot && finishQueueingConcurrentUpdates(), false;
            } catch (error) {
            } finally {
            }
          action = enqueueConcurrentHookUpdate(fiber, queue, update, lane);
          if (null !== action)
            return scheduleUpdateOnFiber(action, fiber, lane), entangleTransitionUpdate(action, queue, lane), true;
        }
        return false;
      }
      __name(dispatchSetStateInternal, "dispatchSetStateInternal");
      function dispatchOptimisticSetState(fiber, throwIfDuringRender, queue, action) {
        action = {
          lane: 2,
          revertLane: requestTransitionLane(),
          gesture: null,
          action,
          hasEagerState: false,
          eagerState: null,
          next: null
        };
        if (isRenderPhaseUpdate(fiber)) {
          if (throwIfDuringRender) throw Error(formatProdErrorMessage(479));
        } else
          throwIfDuringRender = enqueueConcurrentHookUpdate(
            fiber,
            queue,
            action,
            2
          ), null !== throwIfDuringRender && scheduleUpdateOnFiber(throwIfDuringRender, fiber, 2);
      }
      __name(dispatchOptimisticSetState, "dispatchOptimisticSetState");
      function isRenderPhaseUpdate(fiber) {
        var alternate = fiber.alternate;
        return fiber === currentlyRenderingFiber || null !== alternate && alternate === currentlyRenderingFiber;
      }
      __name(isRenderPhaseUpdate, "isRenderPhaseUpdate");
      function enqueueRenderPhaseUpdate(queue, update) {
        didScheduleRenderPhaseUpdateDuringThisPass = didScheduleRenderPhaseUpdate = true;
        var pending = queue.pending;
        null === pending ? update.next = update : (update.next = pending.next, pending.next = update);
        queue.pending = update;
      }
      __name(enqueueRenderPhaseUpdate, "enqueueRenderPhaseUpdate");
      function entangleTransitionUpdate(root, queue, lane) {
        if (0 !== (lane & 4194048)) {
          var queueLanes = queue.lanes;
          queueLanes &= root.pendingLanes;
          lane |= queueLanes;
          queue.lanes = lane;
          markRootEntangled(root, lane);
        }
      }
      __name(entangleTransitionUpdate, "entangleTransitionUpdate");
      function applyDerivedStateFromProps(workInProgress2, ctor, getDerivedStateFromProps, nextProps) {
        ctor = workInProgress2.memoizedState;
        getDerivedStateFromProps = getDerivedStateFromProps(nextProps, ctor);
        getDerivedStateFromProps = null === getDerivedStateFromProps || void 0 === getDerivedStateFromProps ? ctor : assign({}, ctor, getDerivedStateFromProps);
        workInProgress2.memoizedState = getDerivedStateFromProps;
        0 === workInProgress2.lanes && (workInProgress2.updateQueue.baseState = getDerivedStateFromProps);
      }
      __name(applyDerivedStateFromProps, "applyDerivedStateFromProps");
      function checkShouldComponentUpdate(workInProgress2, ctor, oldProps, newProps, oldState, newState, nextContext) {
        workInProgress2 = workInProgress2.stateNode;
        return "function" === typeof workInProgress2.shouldComponentUpdate ? workInProgress2.shouldComponentUpdate(newProps, newState, nextContext) : ctor.prototype && ctor.prototype.isPureReactComponent ? !shallowEqual(oldProps, newProps) || !shallowEqual(oldState, newState) : true;
      }
      __name(checkShouldComponentUpdate, "checkShouldComponentUpdate");
      function callComponentWillReceiveProps(workInProgress2, instance, newProps, nextContext) {
        workInProgress2 = instance.state;
        "function" === typeof instance.componentWillReceiveProps && instance.componentWillReceiveProps(newProps, nextContext);
        "function" === typeof instance.UNSAFE_componentWillReceiveProps && instance.UNSAFE_componentWillReceiveProps(newProps, nextContext);
        instance.state !== workInProgress2 && classComponentUpdater.enqueueReplaceState(instance, instance.state, null);
      }
      __name(callComponentWillReceiveProps, "callComponentWillReceiveProps");
      function resolveClassComponentProps(Component, baseProps) {
        var newProps = baseProps;
        if ("ref" in baseProps) {
          newProps = {};
          for (var propName in baseProps)
            "ref" !== propName && (newProps[propName] = baseProps[propName]);
        }
        if (Component = Component.defaultProps) {
          newProps === baseProps && (newProps = assign({}, newProps));
          for (var propName$57 in Component)
            void 0 === newProps[propName$57] && (newProps[propName$57] = Component[propName$57]);
        }
        return newProps;
      }
      __name(resolveClassComponentProps, "resolveClassComponentProps");
      function logUncaughtError(root, errorInfo) {
        try {
          var onUncaughtError = root.onUncaughtError;
          onUncaughtError(errorInfo.value, { componentStack: errorInfo.stack });
        } catch (e) {
          setTimeout(function() {
            throw e;
          });
        }
      }
      __name(logUncaughtError, "logUncaughtError");
      function logCaughtError(root, boundary, errorInfo) {
        try {
          var onCaughtError = root.onCaughtError;
          onCaughtError(errorInfo.value, {
            componentStack: errorInfo.stack,
            errorBoundary: 1 === boundary.tag ? boundary.stateNode : null
          });
        } catch (e) {
          setTimeout(function() {
            throw e;
          });
        }
      }
      __name(logCaughtError, "logCaughtError");
      function createRootErrorUpdate(root, errorInfo, lane) {
        lane = createUpdate(lane);
        lane.tag = 3;
        lane.payload = { element: null };
        lane.callback = function() {
          logUncaughtError(root, errorInfo);
        };
        return lane;
      }
      __name(createRootErrorUpdate, "createRootErrorUpdate");
      function createClassErrorUpdate(lane) {
        lane = createUpdate(lane);
        lane.tag = 3;
        return lane;
      }
      __name(createClassErrorUpdate, "createClassErrorUpdate");
      function initializeClassErrorUpdate(update, root, fiber, errorInfo) {
        var getDerivedStateFromError = fiber.type.getDerivedStateFromError;
        if ("function" === typeof getDerivedStateFromError) {
          var error = errorInfo.value;
          update.payload = function() {
            return getDerivedStateFromError(error);
          };
          update.callback = function() {
            logCaughtError(root, fiber, errorInfo);
          };
        }
        var inst = fiber.stateNode;
        null !== inst && "function" === typeof inst.componentDidCatch && (update.callback = function() {
          logCaughtError(root, fiber, errorInfo);
          "function" !== typeof getDerivedStateFromError && (null === legacyErrorBoundariesThatAlreadyFailed ? legacyErrorBoundariesThatAlreadyFailed = /* @__PURE__ */ new Set([this]) : legacyErrorBoundariesThatAlreadyFailed.add(this));
          var stack = errorInfo.stack;
          this.componentDidCatch(errorInfo.value, {
            componentStack: null !== stack ? stack : ""
          });
        });
      }
      __name(initializeClassErrorUpdate, "initializeClassErrorUpdate");
      function throwException(root, returnFiber, sourceFiber, value, rootRenderLanes) {
        sourceFiber.flags |= 32768;
        if (null !== value && "object" === typeof value && "function" === typeof value.then) {
          returnFiber = sourceFiber.alternate;
          null !== returnFiber && propagateParentContextChanges(
            returnFiber,
            sourceFiber,
            rootRenderLanes,
            true
          );
          sourceFiber = suspenseHandlerStackCursor.current;
          if (null !== sourceFiber) {
            switch (sourceFiber.tag) {
              case 31:
              case 13:
                return null === shellBoundary ? renderDidSuspendDelayIfPossible() : null === sourceFiber.alternate && 0 === workInProgressRootExitStatus && (workInProgressRootExitStatus = 3), sourceFiber.flags &= -257, sourceFiber.flags |= 65536, sourceFiber.lanes = rootRenderLanes, value === noopSuspenseyCommitThenable ? sourceFiber.flags |= 16384 : (returnFiber = sourceFiber.updateQueue, null === returnFiber ? sourceFiber.updateQueue = /* @__PURE__ */ new Set([value]) : returnFiber.add(value), attachPingListener(root, value, rootRenderLanes)), false;
              case 22:
                return sourceFiber.flags |= 65536, value === noopSuspenseyCommitThenable ? sourceFiber.flags |= 16384 : (returnFiber = sourceFiber.updateQueue, null === returnFiber ? (returnFiber = {
                  transitions: null,
                  markerInstances: null,
                  retryQueue: /* @__PURE__ */ new Set([value])
                }, sourceFiber.updateQueue = returnFiber) : (sourceFiber = returnFiber.retryQueue, null === sourceFiber ? returnFiber.retryQueue = /* @__PURE__ */ new Set([value]) : sourceFiber.add(value)), attachPingListener(root, value, rootRenderLanes)), false;
            }
            throw Error(formatProdErrorMessage(435, sourceFiber.tag));
          }
          attachPingListener(root, value, rootRenderLanes);
          renderDidSuspendDelayIfPossible();
          return false;
        }
        if (isHydrating)
          return returnFiber = suspenseHandlerStackCursor.current, null !== returnFiber ? (0 === (returnFiber.flags & 65536) && (returnFiber.flags |= 256), returnFiber.flags |= 65536, returnFiber.lanes = rootRenderLanes, value !== HydrationMismatchException && (root = Error(formatProdErrorMessage(422), { cause: value }), queueHydrationError(
            createCapturedValueAtFiber(root, sourceFiber)
          ))) : (value !== HydrationMismatchException && (returnFiber = Error(formatProdErrorMessage(423), {
            cause: value
          }), queueHydrationError(
            createCapturedValueAtFiber(returnFiber, sourceFiber)
          )), root = root.current.alternate, root.flags |= 65536, rootRenderLanes &= -rootRenderLanes, root.lanes |= rootRenderLanes, value = createCapturedValueAtFiber(value, sourceFiber), rootRenderLanes = createRootErrorUpdate(
            root.stateNode,
            value,
            rootRenderLanes
          ), enqueueCapturedUpdate(root, rootRenderLanes), 4 !== workInProgressRootExitStatus && (workInProgressRootExitStatus = 2)), false;
        var wrapperError = Error(formatProdErrorMessage(520), { cause: value });
        wrapperError = createCapturedValueAtFiber(wrapperError, sourceFiber);
        null === workInProgressRootConcurrentErrors ? workInProgressRootConcurrentErrors = [wrapperError] : workInProgressRootConcurrentErrors.push(wrapperError);
        4 !== workInProgressRootExitStatus && (workInProgressRootExitStatus = 2);
        if (null === returnFiber) return true;
        value = createCapturedValueAtFiber(value, sourceFiber);
        sourceFiber = returnFiber;
        do {
          switch (sourceFiber.tag) {
            case 3:
              return sourceFiber.flags |= 65536, root = rootRenderLanes & -rootRenderLanes, sourceFiber.lanes |= root, root = createRootErrorUpdate(sourceFiber.stateNode, value, root), enqueueCapturedUpdate(sourceFiber, root), false;
            case 1:
              if (returnFiber = sourceFiber.type, wrapperError = sourceFiber.stateNode, 0 === (sourceFiber.flags & 128) && ("function" === typeof returnFiber.getDerivedStateFromError || null !== wrapperError && "function" === typeof wrapperError.componentDidCatch && (null === legacyErrorBoundariesThatAlreadyFailed || !legacyErrorBoundariesThatAlreadyFailed.has(
                wrapperError
              ))))
                return sourceFiber.flags |= 65536, rootRenderLanes &= -rootRenderLanes, sourceFiber.lanes |= rootRenderLanes, rootRenderLanes = createClassErrorUpdate(rootRenderLanes), initializeClassErrorUpdate(
                  rootRenderLanes,
                  root,
                  sourceFiber,
                  value
                ), enqueueCapturedUpdate(sourceFiber, rootRenderLanes), false;
          }
          sourceFiber = sourceFiber.return;
        } while (null !== sourceFiber);
        return false;
      }
      __name(throwException, "throwException");
      function reconcileChildren(current, workInProgress2, nextChildren, renderLanes2) {
        workInProgress2.child = null === current ? mountChildFibers(workInProgress2, null, nextChildren, renderLanes2) : reconcileChildFibers(
          workInProgress2,
          current.child,
          nextChildren,
          renderLanes2
        );
      }
      __name(reconcileChildren, "reconcileChildren");
      function updateForwardRef(current, workInProgress2, Component, nextProps, renderLanes2) {
        Component = Component.render;
        var ref = workInProgress2.ref;
        if ("ref" in nextProps) {
          var propsWithoutRef = {};
          for (var key in nextProps)
            "ref" !== key && (propsWithoutRef[key] = nextProps[key]);
        } else propsWithoutRef = nextProps;
        prepareToReadContext(workInProgress2);
        nextProps = renderWithHooks(
          current,
          workInProgress2,
          Component,
          propsWithoutRef,
          ref,
          renderLanes2
        );
        key = checkDidRenderIdHook();
        if (null !== current && !didReceiveUpdate)
          return bailoutHooks(current, workInProgress2, renderLanes2), bailoutOnAlreadyFinishedWork(current, workInProgress2, renderLanes2);
        isHydrating && key && pushMaterializedTreeId(workInProgress2);
        workInProgress2.flags |= 1;
        reconcileChildren(current, workInProgress2, nextProps, renderLanes2);
        return workInProgress2.child;
      }
      __name(updateForwardRef, "updateForwardRef");
      function updateMemoComponent(current, workInProgress2, Component, nextProps, renderLanes2) {
        if (null === current) {
          var type = Component.type;
          if ("function" === typeof type && !shouldConstruct(type) && void 0 === type.defaultProps && null === Component.compare)
            return workInProgress2.tag = 15, workInProgress2.type = type, updateSimpleMemoComponent(
              current,
              workInProgress2,
              type,
              nextProps,
              renderLanes2
            );
          current = createFiberFromTypeAndProps(
            Component.type,
            null,
            nextProps,
            workInProgress2,
            workInProgress2.mode,
            renderLanes2
          );
          current.ref = workInProgress2.ref;
          current.return = workInProgress2;
          return workInProgress2.child = current;
        }
        type = current.child;
        if (!checkScheduledUpdateOrContext(current, renderLanes2)) {
          var prevProps = type.memoizedProps;
          Component = Component.compare;
          Component = null !== Component ? Component : shallowEqual;
          if (Component(prevProps, nextProps) && current.ref === workInProgress2.ref)
            return bailoutOnAlreadyFinishedWork(
              current,
              workInProgress2,
              renderLanes2
            );
        }
        workInProgress2.flags |= 1;
        current = createWorkInProgress(type, nextProps);
        current.ref = workInProgress2.ref;
        current.return = workInProgress2;
        return workInProgress2.child = current;
      }
      __name(updateMemoComponent, "updateMemoComponent");
      function updateSimpleMemoComponent(current, workInProgress2, Component, nextProps, renderLanes2) {
        if (null !== current) {
          var prevProps = current.memoizedProps;
          if (shallowEqual(prevProps, nextProps) && current.ref === workInProgress2.ref)
            if (didReceiveUpdate = false, workInProgress2.pendingProps = nextProps = prevProps, checkScheduledUpdateOrContext(current, renderLanes2))
              0 !== (current.flags & 131072) && (didReceiveUpdate = true);
            else
              return workInProgress2.lanes = current.lanes, bailoutOnAlreadyFinishedWork(current, workInProgress2, renderLanes2);
        }
        return updateFunctionComponent(
          current,
          workInProgress2,
          Component,
          nextProps,
          renderLanes2
        );
      }
      __name(updateSimpleMemoComponent, "updateSimpleMemoComponent");
      function updateOffscreenComponent(current, workInProgress2, renderLanes2, nextProps) {
        var nextChildren = nextProps.children, prevState = null !== current ? current.memoizedState : null;
        null === current && null === workInProgress2.stateNode && (workInProgress2.stateNode = {
          _visibility: 1,
          _pendingMarkers: null,
          _retryCache: null,
          _transitions: null
        });
        if ("hidden" === nextProps.mode) {
          if (0 !== (workInProgress2.flags & 128)) {
            prevState = null !== prevState ? prevState.baseLanes | renderLanes2 : renderLanes2;
            if (null !== current) {
              nextProps = workInProgress2.child = current.child;
              for (nextChildren = 0; null !== nextProps; )
                nextChildren = nextChildren | nextProps.lanes | nextProps.childLanes, nextProps = nextProps.sibling;
              nextProps = nextChildren & ~prevState;
            } else nextProps = 0, workInProgress2.child = null;
            return deferHiddenOffscreenComponent(
              current,
              workInProgress2,
              prevState,
              renderLanes2,
              nextProps
            );
          }
          if (0 !== (renderLanes2 & 536870912))
            workInProgress2.memoizedState = { baseLanes: 0, cachePool: null }, null !== current && pushTransition(
              workInProgress2,
              null !== prevState ? prevState.cachePool : null
            ), null !== prevState ? pushHiddenContext(workInProgress2, prevState) : reuseHiddenContextOnStack(), pushOffscreenSuspenseHandler(workInProgress2);
          else
            return nextProps = workInProgress2.lanes = 536870912, deferHiddenOffscreenComponent(
              current,
              workInProgress2,
              null !== prevState ? prevState.baseLanes | renderLanes2 : renderLanes2,
              renderLanes2,
              nextProps
            );
        } else
          null !== prevState ? (pushTransition(workInProgress2, prevState.cachePool), pushHiddenContext(workInProgress2, prevState), reuseSuspenseHandlerOnStack(workInProgress2), workInProgress2.memoizedState = null) : (null !== current && pushTransition(workInProgress2, null), reuseHiddenContextOnStack(), reuseSuspenseHandlerOnStack(workInProgress2));
        reconcileChildren(current, workInProgress2, nextChildren, renderLanes2);
        return workInProgress2.child;
      }
      __name(updateOffscreenComponent, "updateOffscreenComponent");
      function bailoutOffscreenComponent(current, workInProgress2) {
        null !== current && 22 === current.tag || null !== workInProgress2.stateNode || (workInProgress2.stateNode = {
          _visibility: 1,
          _pendingMarkers: null,
          _retryCache: null,
          _transitions: null
        });
        return workInProgress2.sibling;
      }
      __name(bailoutOffscreenComponent, "bailoutOffscreenComponent");
      function deferHiddenOffscreenComponent(current, workInProgress2, nextBaseLanes, renderLanes2, remainingChildLanes) {
        var JSCompiler_inline_result = peekCacheFromPool();
        JSCompiler_inline_result = null === JSCompiler_inline_result ? null : {
          parent: isPrimaryRenderer ? CacheContext._currentValue : CacheContext._currentValue2,
          pool: JSCompiler_inline_result
        };
        workInProgress2.memoizedState = {
          baseLanes: nextBaseLanes,
          cachePool: JSCompiler_inline_result
        };
        null !== current && pushTransition(workInProgress2, null);
        reuseHiddenContextOnStack();
        pushOffscreenSuspenseHandler(workInProgress2);
        null !== current && propagateParentContextChanges(current, workInProgress2, renderLanes2, true);
        workInProgress2.childLanes = remainingChildLanes;
        return null;
      }
      __name(deferHiddenOffscreenComponent, "deferHiddenOffscreenComponent");
      function mountActivityChildren(workInProgress2, nextProps) {
        nextProps = mountWorkInProgressOffscreenFiber(
          { mode: nextProps.mode, children: nextProps.children },
          workInProgress2.mode
        );
        nextProps.ref = workInProgress2.ref;
        workInProgress2.child = nextProps;
        nextProps.return = workInProgress2;
        return nextProps;
      }
      __name(mountActivityChildren, "mountActivityChildren");
      function retryActivityComponentWithoutHydrating(current, workInProgress2, renderLanes2) {
        reconcileChildFibers(workInProgress2, current.child, null, renderLanes2);
        current = mountActivityChildren(
          workInProgress2,
          workInProgress2.pendingProps
        );
        current.flags |= 2;
        popSuspenseHandler(workInProgress2);
        workInProgress2.memoizedState = null;
        return current;
      }
      __name(retryActivityComponentWithoutHydrating, "retryActivityComponentWithoutHydrating");
      function updateActivityComponent(current, workInProgress2, renderLanes2) {
        var nextProps = workInProgress2.pendingProps, didSuspend = 0 !== (workInProgress2.flags & 128);
        workInProgress2.flags &= -129;
        if (null === current) {
          if (isHydrating) {
            if ("hidden" === nextProps.mode)
              return current = mountActivityChildren(workInProgress2, nextProps), workInProgress2.lanes = 536870912, bailoutOffscreenComponent(null, current);
            pushDehydratedActivitySuspenseHandler(workInProgress2);
            (current = nextHydratableInstance) ? (current = canHydrateActivityInstance(
              current,
              rootOrSingletonContext
            ), null !== current && (workInProgress2.memoizedState = {
              dehydrated: current,
              treeContext: null !== treeContextProvider ? { id: treeContextId, overflow: treeContextOverflow } : null,
              retryLane: 536870912,
              hydrationErrors: null
            }, renderLanes2 = createFiberFromDehydratedFragment(current), renderLanes2.return = workInProgress2, workInProgress2.child = renderLanes2, hydrationParentFiber = workInProgress2, nextHydratableInstance = null)) : current = null;
            if (null === current) throw throwOnHydrationMismatch(workInProgress2);
            workInProgress2.lanes = 536870912;
            return null;
          }
          return mountActivityChildren(workInProgress2, nextProps);
        }
        var prevState = current.memoizedState;
        if (null !== prevState) {
          var dehydrated = prevState.dehydrated;
          pushDehydratedActivitySuspenseHandler(workInProgress2);
          if (didSuspend)
            if (workInProgress2.flags & 256)
              workInProgress2.flags &= -257, workInProgress2 = retryActivityComponentWithoutHydrating(
                current,
                workInProgress2,
                renderLanes2
              );
            else if (null !== workInProgress2.memoizedState)
              workInProgress2.child = current.child, workInProgress2.flags |= 128, workInProgress2 = null;
            else throw Error(formatProdErrorMessage(558));
          else if (didReceiveUpdate || propagateParentContextChanges(
            current,
            workInProgress2,
            renderLanes2,
            false
          ), didSuspend = 0 !== (renderLanes2 & current.childLanes), didReceiveUpdate || didSuspend) {
            nextProps = workInProgressRoot;
            if (null !== nextProps && (dehydrated = getBumpedLaneForHydration(nextProps, renderLanes2), 0 !== dehydrated && dehydrated !== prevState.retryLane))
              throw prevState.retryLane = dehydrated, enqueueConcurrentRenderForLane(current, dehydrated), scheduleUpdateOnFiber(nextProps, current, dehydrated), SelectiveHydrationException;
            renderDidSuspendDelayIfPossible();
            workInProgress2 = retryActivityComponentWithoutHydrating(
              current,
              workInProgress2,
              renderLanes2
            );
          } else
            current = prevState.treeContext, supportsHydration && (nextHydratableInstance = getFirstHydratableChildWithinActivityInstance(dehydrated), hydrationParentFiber = workInProgress2, isHydrating = true, hydrationErrors = null, rootOrSingletonContext = false, null !== current && restoreSuspendedTreeContext(workInProgress2, current)), workInProgress2 = mountActivityChildren(workInProgress2, nextProps), workInProgress2.flags |= 4096;
          return workInProgress2;
        }
        current = createWorkInProgress(current.child, {
          mode: nextProps.mode,
          children: nextProps.children
        });
        current.ref = workInProgress2.ref;
        workInProgress2.child = current;
        current.return = workInProgress2;
        return current;
      }
      __name(updateActivityComponent, "updateActivityComponent");
      function markRef(current, workInProgress2) {
        var ref = workInProgress2.ref;
        if (null === ref)
          null !== current && null !== current.ref && (workInProgress2.flags |= 4194816);
        else {
          if ("function" !== typeof ref && "object" !== typeof ref)
            throw Error(formatProdErrorMessage(284));
          if (null === current || current.ref !== ref)
            workInProgress2.flags |= 4194816;
        }
      }
      __name(markRef, "markRef");
      function updateFunctionComponent(current, workInProgress2, Component, nextProps, renderLanes2) {
        prepareToReadContext(workInProgress2);
        Component = renderWithHooks(
          current,
          workInProgress2,
          Component,
          nextProps,
          void 0,
          renderLanes2
        );
        nextProps = checkDidRenderIdHook();
        if (null !== current && !didReceiveUpdate)
          return bailoutHooks(current, workInProgress2, renderLanes2), bailoutOnAlreadyFinishedWork(current, workInProgress2, renderLanes2);
        isHydrating && nextProps && pushMaterializedTreeId(workInProgress2);
        workInProgress2.flags |= 1;
        reconcileChildren(current, workInProgress2, Component, renderLanes2);
        return workInProgress2.child;
      }
      __name(updateFunctionComponent, "updateFunctionComponent");
      function replayFunctionComponent(current, workInProgress2, nextProps, Component, secondArg, renderLanes2) {
        prepareToReadContext(workInProgress2);
        workInProgress2.updateQueue = null;
        nextProps = renderWithHooksAgain(
          workInProgress2,
          Component,
          nextProps,
          secondArg
        );
        finishRenderingHooks(current);
        Component = checkDidRenderIdHook();
        if (null !== current && !didReceiveUpdate)
          return bailoutHooks(current, workInProgress2, renderLanes2), bailoutOnAlreadyFinishedWork(current, workInProgress2, renderLanes2);
        isHydrating && Component && pushMaterializedTreeId(workInProgress2);
        workInProgress2.flags |= 1;
        reconcileChildren(current, workInProgress2, nextProps, renderLanes2);
        return workInProgress2.child;
      }
      __name(replayFunctionComponent, "replayFunctionComponent");
      function updateClassComponent(current, workInProgress2, Component, nextProps, renderLanes2) {
        prepareToReadContext(workInProgress2);
        if (null === workInProgress2.stateNode) {
          var context = emptyContextObject, contextType = Component.contextType;
          "object" === typeof contextType && null !== contextType && (context = readContext(contextType));
          context = new Component(nextProps, context);
          workInProgress2.memoizedState = null !== context.state && void 0 !== context.state ? context.state : null;
          context.updater = classComponentUpdater;
          workInProgress2.stateNode = context;
          context._reactInternals = workInProgress2;
          context = workInProgress2.stateNode;
          context.props = nextProps;
          context.state = workInProgress2.memoizedState;
          context.refs = {};
          initializeUpdateQueue(workInProgress2);
          contextType = Component.contextType;
          context.context = "object" === typeof contextType && null !== contextType ? readContext(contextType) : emptyContextObject;
          context.state = workInProgress2.memoizedState;
          contextType = Component.getDerivedStateFromProps;
          "function" === typeof contextType && (applyDerivedStateFromProps(
            workInProgress2,
            Component,
            contextType,
            nextProps
          ), context.state = workInProgress2.memoizedState);
          "function" === typeof Component.getDerivedStateFromProps || "function" === typeof context.getSnapshotBeforeUpdate || "function" !== typeof context.UNSAFE_componentWillMount && "function" !== typeof context.componentWillMount || (contextType = context.state, "function" === typeof context.componentWillMount && context.componentWillMount(), "function" === typeof context.UNSAFE_componentWillMount && context.UNSAFE_componentWillMount(), contextType !== context.state && classComponentUpdater.enqueueReplaceState(
            context,
            context.state,
            null
          ), processUpdateQueue(workInProgress2, nextProps, context, renderLanes2), suspendIfUpdateReadFromEntangledAsyncAction(), context.state = workInProgress2.memoizedState);
          "function" === typeof context.componentDidMount && (workInProgress2.flags |= 4194308);
          nextProps = true;
        } else if (null === current) {
          context = workInProgress2.stateNode;
          var unresolvedOldProps = workInProgress2.memoizedProps, oldProps = resolveClassComponentProps(Component, unresolvedOldProps);
          context.props = oldProps;
          var oldContext = context.context, contextType$jscomp$0 = Component.contextType;
          contextType = emptyContextObject;
          "object" === typeof contextType$jscomp$0 && null !== contextType$jscomp$0 && (contextType = readContext(contextType$jscomp$0));
          var getDerivedStateFromProps = Component.getDerivedStateFromProps;
          contextType$jscomp$0 = "function" === typeof getDerivedStateFromProps || "function" === typeof context.getSnapshotBeforeUpdate;
          unresolvedOldProps = workInProgress2.pendingProps !== unresolvedOldProps;
          contextType$jscomp$0 || "function" !== typeof context.UNSAFE_componentWillReceiveProps && "function" !== typeof context.componentWillReceiveProps || (unresolvedOldProps || oldContext !== contextType) && callComponentWillReceiveProps(
            workInProgress2,
            context,
            nextProps,
            contextType
          );
          hasForceUpdate = false;
          var oldState = workInProgress2.memoizedState;
          context.state = oldState;
          processUpdateQueue(workInProgress2, nextProps, context, renderLanes2);
          suspendIfUpdateReadFromEntangledAsyncAction();
          oldContext = workInProgress2.memoizedState;
          unresolvedOldProps || oldState !== oldContext || hasForceUpdate ? ("function" === typeof getDerivedStateFromProps && (applyDerivedStateFromProps(
            workInProgress2,
            Component,
            getDerivedStateFromProps,
            nextProps
          ), oldContext = workInProgress2.memoizedState), (oldProps = hasForceUpdate || checkShouldComponentUpdate(
            workInProgress2,
            Component,
            oldProps,
            nextProps,
            oldState,
            oldContext,
            contextType
          )) ? (contextType$jscomp$0 || "function" !== typeof context.UNSAFE_componentWillMount && "function" !== typeof context.componentWillMount || ("function" === typeof context.componentWillMount && context.componentWillMount(), "function" === typeof context.UNSAFE_componentWillMount && context.UNSAFE_componentWillMount()), "function" === typeof context.componentDidMount && (workInProgress2.flags |= 4194308)) : ("function" === typeof context.componentDidMount && (workInProgress2.flags |= 4194308), workInProgress2.memoizedProps = nextProps, workInProgress2.memoizedState = oldContext), context.props = nextProps, context.state = oldContext, context.context = contextType, nextProps = oldProps) : ("function" === typeof context.componentDidMount && (workInProgress2.flags |= 4194308), nextProps = false);
        } else {
          context = workInProgress2.stateNode;
          cloneUpdateQueue(current, workInProgress2);
          contextType = workInProgress2.memoizedProps;
          contextType$jscomp$0 = resolveClassComponentProps(Component, contextType);
          context.props = contextType$jscomp$0;
          getDerivedStateFromProps = workInProgress2.pendingProps;
          oldState = context.context;
          oldContext = Component.contextType;
          oldProps = emptyContextObject;
          "object" === typeof oldContext && null !== oldContext && (oldProps = readContext(oldContext));
          unresolvedOldProps = Component.getDerivedStateFromProps;
          (oldContext = "function" === typeof unresolvedOldProps || "function" === typeof context.getSnapshotBeforeUpdate) || "function" !== typeof context.UNSAFE_componentWillReceiveProps && "function" !== typeof context.componentWillReceiveProps || (contextType !== getDerivedStateFromProps || oldState !== oldProps) && callComponentWillReceiveProps(
            workInProgress2,
            context,
            nextProps,
            oldProps
          );
          hasForceUpdate = false;
          oldState = workInProgress2.memoizedState;
          context.state = oldState;
          processUpdateQueue(workInProgress2, nextProps, context, renderLanes2);
          suspendIfUpdateReadFromEntangledAsyncAction();
          var newState = workInProgress2.memoizedState;
          contextType !== getDerivedStateFromProps || oldState !== newState || hasForceUpdate || null !== current && null !== current.dependencies && checkIfContextChanged(current.dependencies) ? ("function" === typeof unresolvedOldProps && (applyDerivedStateFromProps(
            workInProgress2,
            Component,
            unresolvedOldProps,
            nextProps
          ), newState = workInProgress2.memoizedState), (contextType$jscomp$0 = hasForceUpdate || checkShouldComponentUpdate(
            workInProgress2,
            Component,
            contextType$jscomp$0,
            nextProps,
            oldState,
            newState,
            oldProps
          ) || null !== current && null !== current.dependencies && checkIfContextChanged(current.dependencies)) ? (oldContext || "function" !== typeof context.UNSAFE_componentWillUpdate && "function" !== typeof context.componentWillUpdate || ("function" === typeof context.componentWillUpdate && context.componentWillUpdate(nextProps, newState, oldProps), "function" === typeof context.UNSAFE_componentWillUpdate && context.UNSAFE_componentWillUpdate(
            nextProps,
            newState,
            oldProps
          )), "function" === typeof context.componentDidUpdate && (workInProgress2.flags |= 4), "function" === typeof context.getSnapshotBeforeUpdate && (workInProgress2.flags |= 1024)) : ("function" !== typeof context.componentDidUpdate || contextType === current.memoizedProps && oldState === current.memoizedState || (workInProgress2.flags |= 4), "function" !== typeof context.getSnapshotBeforeUpdate || contextType === current.memoizedProps && oldState === current.memoizedState || (workInProgress2.flags |= 1024), workInProgress2.memoizedProps = nextProps, workInProgress2.memoizedState = newState), context.props = nextProps, context.state = newState, context.context = oldProps, nextProps = contextType$jscomp$0) : ("function" !== typeof context.componentDidUpdate || contextType === current.memoizedProps && oldState === current.memoizedState || (workInProgress2.flags |= 4), "function" !== typeof context.getSnapshotBeforeUpdate || contextType === current.memoizedProps && oldState === current.memoizedState || (workInProgress2.flags |= 1024), nextProps = false);
        }
        context = nextProps;
        markRef(current, workInProgress2);
        nextProps = 0 !== (workInProgress2.flags & 128);
        context || nextProps ? (context = workInProgress2.stateNode, Component = nextProps && "function" !== typeof Component.getDerivedStateFromError ? null : context.render(), workInProgress2.flags |= 1, null !== current && nextProps ? (workInProgress2.child = reconcileChildFibers(
          workInProgress2,
          current.child,
          null,
          renderLanes2
        ), workInProgress2.child = reconcileChildFibers(
          workInProgress2,
          null,
          Component,
          renderLanes2
        )) : reconcileChildren(current, workInProgress2, Component, renderLanes2), workInProgress2.memoizedState = context.state, current = workInProgress2.child) : current = bailoutOnAlreadyFinishedWork(
          current,
          workInProgress2,
          renderLanes2
        );
        return current;
      }
      __name(updateClassComponent, "updateClassComponent");
      function mountHostRootWithoutHydrating(current, workInProgress2, nextChildren, renderLanes2) {
        resetHydrationState();
        workInProgress2.flags |= 256;
        reconcileChildren(current, workInProgress2, nextChildren, renderLanes2);
        return workInProgress2.child;
      }
      __name(mountHostRootWithoutHydrating, "mountHostRootWithoutHydrating");
      function mountSuspenseOffscreenState(renderLanes2) {
        return { baseLanes: renderLanes2, cachePool: getSuspendedCache() };
      }
      __name(mountSuspenseOffscreenState, "mountSuspenseOffscreenState");
      function getRemainingWorkInPrimaryTree(current, primaryTreeDidDefer, renderLanes2) {
        current = null !== current ? current.childLanes & ~renderLanes2 : 0;
        primaryTreeDidDefer && (current |= workInProgressDeferredLane);
        return current;
      }
      __name(getRemainingWorkInPrimaryTree, "getRemainingWorkInPrimaryTree");
      function updateSuspenseComponent(current, workInProgress2, renderLanes2) {
        var nextProps = workInProgress2.pendingProps, showFallback = false, didSuspend = 0 !== (workInProgress2.flags & 128), JSCompiler_temp;
        (JSCompiler_temp = didSuspend) || (JSCompiler_temp = null !== current && null === current.memoizedState ? false : 0 !== (suspenseStackCursor.current & 2));
        JSCompiler_temp && (showFallback = true, workInProgress2.flags &= -129);
        JSCompiler_temp = 0 !== (workInProgress2.flags & 32);
        workInProgress2.flags &= -33;
        if (null === current) {
          if (isHydrating) {
            showFallback ? pushPrimaryTreeSuspenseHandler(workInProgress2) : reuseSuspenseHandlerOnStack(workInProgress2);
            (current = nextHydratableInstance) ? (current = canHydrateSuspenseInstance(
              current,
              rootOrSingletonContext
            ), null !== current && (workInProgress2.memoizedState = {
              dehydrated: current,
              treeContext: null !== treeContextProvider ? { id: treeContextId, overflow: treeContextOverflow } : null,
              retryLane: 536870912,
              hydrationErrors: null
            }, renderLanes2 = createFiberFromDehydratedFragment(current), renderLanes2.return = workInProgress2, workInProgress2.child = renderLanes2, hydrationParentFiber = workInProgress2, nextHydratableInstance = null)) : current = null;
            if (null === current) throw throwOnHydrationMismatch(workInProgress2);
            isSuspenseInstanceFallback(current) ? workInProgress2.lanes = 32 : workInProgress2.lanes = 536870912;
            return null;
          }
          var nextPrimaryChildren = nextProps.children;
          nextProps = nextProps.fallback;
          if (showFallback)
            return reuseSuspenseHandlerOnStack(workInProgress2), showFallback = workInProgress2.mode, nextPrimaryChildren = mountWorkInProgressOffscreenFiber(
              { mode: "hidden", children: nextPrimaryChildren },
              showFallback
            ), nextProps = createFiberFromFragment(
              nextProps,
              showFallback,
              renderLanes2,
              null
            ), nextPrimaryChildren.return = workInProgress2, nextProps.return = workInProgress2, nextPrimaryChildren.sibling = nextProps, workInProgress2.child = nextPrimaryChildren, nextProps = workInProgress2.child, nextProps.memoizedState = mountSuspenseOffscreenState(renderLanes2), nextProps.childLanes = getRemainingWorkInPrimaryTree(
              current,
              JSCompiler_temp,
              renderLanes2
            ), workInProgress2.memoizedState = SUSPENDED_MARKER, bailoutOffscreenComponent(null, nextProps);
          pushPrimaryTreeSuspenseHandler(workInProgress2);
          return mountSuspensePrimaryChildren(workInProgress2, nextPrimaryChildren);
        }
        var prevState = current.memoizedState;
        if (null !== prevState && (nextPrimaryChildren = prevState.dehydrated, null !== nextPrimaryChildren)) {
          if (didSuspend)
            workInProgress2.flags & 256 ? (pushPrimaryTreeSuspenseHandler(workInProgress2), workInProgress2.flags &= -257, workInProgress2 = retrySuspenseComponentWithoutHydrating(
              current,
              workInProgress2,
              renderLanes2
            )) : null !== workInProgress2.memoizedState ? (reuseSuspenseHandlerOnStack(workInProgress2), workInProgress2.child = current.child, workInProgress2.flags |= 128, workInProgress2 = null) : (reuseSuspenseHandlerOnStack(workInProgress2), nextPrimaryChildren = nextProps.fallback, showFallback = workInProgress2.mode, nextProps = mountWorkInProgressOffscreenFiber(
              { mode: "visible", children: nextProps.children },
              showFallback
            ), nextPrimaryChildren = createFiberFromFragment(
              nextPrimaryChildren,
              showFallback,
              renderLanes2,
              null
            ), nextPrimaryChildren.flags |= 2, nextProps.return = workInProgress2, nextPrimaryChildren.return = workInProgress2, nextProps.sibling = nextPrimaryChildren, workInProgress2.child = nextProps, reconcileChildFibers(
              workInProgress2,
              current.child,
              null,
              renderLanes2
            ), nextProps = workInProgress2.child, nextProps.memoizedState = mountSuspenseOffscreenState(renderLanes2), nextProps.childLanes = getRemainingWorkInPrimaryTree(
              current,
              JSCompiler_temp,
              renderLanes2
            ), workInProgress2.memoizedState = SUSPENDED_MARKER, workInProgress2 = bailoutOffscreenComponent(null, nextProps));
          else if (pushPrimaryTreeSuspenseHandler(workInProgress2), isSuspenseInstanceFallback(nextPrimaryChildren))
            JSCompiler_temp = getSuspenseInstanceFallbackErrorDetails(nextPrimaryChildren).digest, nextProps = Error(formatProdErrorMessage(419)), nextProps.stack = "", nextProps.digest = JSCompiler_temp, queueHydrationError({ value: nextProps, source: null, stack: null }), workInProgress2 = retrySuspenseComponentWithoutHydrating(
              current,
              workInProgress2,
              renderLanes2
            );
          else if (didReceiveUpdate || propagateParentContextChanges(
            current,
            workInProgress2,
            renderLanes2,
            false
          ), JSCompiler_temp = 0 !== (renderLanes2 & current.childLanes), didReceiveUpdate || JSCompiler_temp) {
            JSCompiler_temp = workInProgressRoot;
            if (null !== JSCompiler_temp && (nextProps = getBumpedLaneForHydration(
              JSCompiler_temp,
              renderLanes2
            ), 0 !== nextProps && nextProps !== prevState.retryLane))
              throw prevState.retryLane = nextProps, enqueueConcurrentRenderForLane(current, nextProps), scheduleUpdateOnFiber(JSCompiler_temp, current, nextProps), SelectiveHydrationException;
            isSuspenseInstancePending(nextPrimaryChildren) || renderDidSuspendDelayIfPossible();
            workInProgress2 = retrySuspenseComponentWithoutHydrating(
              current,
              workInProgress2,
              renderLanes2
            );
          } else
            isSuspenseInstancePending(nextPrimaryChildren) ? (workInProgress2.flags |= 192, workInProgress2.child = current.child, workInProgress2 = null) : (current = prevState.treeContext, supportsHydration && (nextHydratableInstance = getFirstHydratableChildWithinSuspenseInstance(
              nextPrimaryChildren
            ), hydrationParentFiber = workInProgress2, isHydrating = true, hydrationErrors = null, rootOrSingletonContext = false, null !== current && restoreSuspendedTreeContext(workInProgress2, current)), workInProgress2 = mountSuspensePrimaryChildren(
              workInProgress2,
              nextProps.children
            ), workInProgress2.flags |= 4096);
          return workInProgress2;
        }
        if (showFallback)
          return reuseSuspenseHandlerOnStack(workInProgress2), nextPrimaryChildren = nextProps.fallback, showFallback = workInProgress2.mode, prevState = current.child, didSuspend = prevState.sibling, nextProps = createWorkInProgress(prevState, {
            mode: "hidden",
            children: nextProps.children
          }), nextProps.subtreeFlags = prevState.subtreeFlags & 65011712, null !== didSuspend ? nextPrimaryChildren = createWorkInProgress(
            didSuspend,
            nextPrimaryChildren
          ) : (nextPrimaryChildren = createFiberFromFragment(
            nextPrimaryChildren,
            showFallback,
            renderLanes2,
            null
          ), nextPrimaryChildren.flags |= 2), nextPrimaryChildren.return = workInProgress2, nextProps.return = workInProgress2, nextProps.sibling = nextPrimaryChildren, workInProgress2.child = nextProps, bailoutOffscreenComponent(null, nextProps), nextProps = workInProgress2.child, nextPrimaryChildren = current.child.memoizedState, null === nextPrimaryChildren ? nextPrimaryChildren = mountSuspenseOffscreenState(renderLanes2) : (showFallback = nextPrimaryChildren.cachePool, null !== showFallback ? (prevState = isPrimaryRenderer ? CacheContext._currentValue : CacheContext._currentValue2, showFallback = showFallback.parent !== prevState ? { parent: prevState, pool: prevState } : showFallback) : showFallback = getSuspendedCache(), nextPrimaryChildren = {
            baseLanes: nextPrimaryChildren.baseLanes | renderLanes2,
            cachePool: showFallback
          }), nextProps.memoizedState = nextPrimaryChildren, nextProps.childLanes = getRemainingWorkInPrimaryTree(
            current,
            JSCompiler_temp,
            renderLanes2
          ), workInProgress2.memoizedState = SUSPENDED_MARKER, bailoutOffscreenComponent(current.child, nextProps);
        pushPrimaryTreeSuspenseHandler(workInProgress2);
        renderLanes2 = current.child;
        current = renderLanes2.sibling;
        renderLanes2 = createWorkInProgress(renderLanes2, {
          mode: "visible",
          children: nextProps.children
        });
        renderLanes2.return = workInProgress2;
        renderLanes2.sibling = null;
        null !== current && (JSCompiler_temp = workInProgress2.deletions, null === JSCompiler_temp ? (workInProgress2.deletions = [current], workInProgress2.flags |= 16) : JSCompiler_temp.push(current));
        workInProgress2.child = renderLanes2;
        workInProgress2.memoizedState = null;
        return renderLanes2;
      }
      __name(updateSuspenseComponent, "updateSuspenseComponent");
      function mountSuspensePrimaryChildren(workInProgress2, primaryChildren) {
        primaryChildren = mountWorkInProgressOffscreenFiber(
          { mode: "visible", children: primaryChildren },
          workInProgress2.mode
        );
        primaryChildren.return = workInProgress2;
        return workInProgress2.child = primaryChildren;
      }
      __name(mountSuspensePrimaryChildren, "mountSuspensePrimaryChildren");
      function mountWorkInProgressOffscreenFiber(offscreenProps, mode) {
        offscreenProps = createFiber(22, offscreenProps, null, mode);
        offscreenProps.lanes = 0;
        return offscreenProps;
      }
      __name(mountWorkInProgressOffscreenFiber, "mountWorkInProgressOffscreenFiber");
      function retrySuspenseComponentWithoutHydrating(current, workInProgress2, renderLanes2) {
        reconcileChildFibers(workInProgress2, current.child, null, renderLanes2);
        current = mountSuspensePrimaryChildren(
          workInProgress2,
          workInProgress2.pendingProps.children
        );
        current.flags |= 2;
        workInProgress2.memoizedState = null;
        return current;
      }
      __name(retrySuspenseComponentWithoutHydrating, "retrySuspenseComponentWithoutHydrating");
      function scheduleSuspenseWorkOnFiber(fiber, renderLanes2, propagationRoot) {
        fiber.lanes |= renderLanes2;
        var alternate = fiber.alternate;
        null !== alternate && (alternate.lanes |= renderLanes2);
        scheduleContextWorkOnParentPath(fiber.return, renderLanes2, propagationRoot);
      }
      __name(scheduleSuspenseWorkOnFiber, "scheduleSuspenseWorkOnFiber");
      function initSuspenseListRenderState(workInProgress2, isBackwards, tail, lastContentRow, tailMode, treeForkCount2) {
        var renderState = workInProgress2.memoizedState;
        null === renderState ? workInProgress2.memoizedState = {
          isBackwards,
          rendering: null,
          renderingStartTime: 0,
          last: lastContentRow,
          tail,
          tailMode,
          treeForkCount: treeForkCount2
        } : (renderState.isBackwards = isBackwards, renderState.rendering = null, renderState.renderingStartTime = 0, renderState.last = lastContentRow, renderState.tail = tail, renderState.tailMode = tailMode, renderState.treeForkCount = treeForkCount2);
      }
      __name(initSuspenseListRenderState, "initSuspenseListRenderState");
      function updateSuspenseListComponent(current, workInProgress2, renderLanes2) {
        var nextProps = workInProgress2.pendingProps, revealOrder = nextProps.revealOrder, tailMode = nextProps.tail;
        nextProps = nextProps.children;
        var suspenseContext = suspenseStackCursor.current, shouldForceFallback = 0 !== (suspenseContext & 2);
        shouldForceFallback ? (suspenseContext = suspenseContext & 1 | 2, workInProgress2.flags |= 128) : suspenseContext &= 1;
        push(suspenseStackCursor, suspenseContext);
        reconcileChildren(current, workInProgress2, nextProps, renderLanes2);
        nextProps = isHydrating ? treeForkCount : 0;
        if (!shouldForceFallback && null !== current && 0 !== (current.flags & 128))
          a: for (current = workInProgress2.child; null !== current; ) {
            if (13 === current.tag)
              null !== current.memoizedState && scheduleSuspenseWorkOnFiber(current, renderLanes2, workInProgress2);
            else if (19 === current.tag)
              scheduleSuspenseWorkOnFiber(current, renderLanes2, workInProgress2);
            else if (null !== current.child) {
              current.child.return = current;
              current = current.child;
              continue;
            }
            if (current === workInProgress2) break a;
            for (; null === current.sibling; ) {
              if (null === current.return || current.return === workInProgress2)
                break a;
              current = current.return;
            }
            current.sibling.return = current.return;
            current = current.sibling;
          }
        switch (revealOrder) {
          case "forwards":
            renderLanes2 = workInProgress2.child;
            for (revealOrder = null; null !== renderLanes2; )
              current = renderLanes2.alternate, null !== current && null === findFirstSuspended(current) && (revealOrder = renderLanes2), renderLanes2 = renderLanes2.sibling;
            renderLanes2 = revealOrder;
            null === renderLanes2 ? (revealOrder = workInProgress2.child, workInProgress2.child = null) : (revealOrder = renderLanes2.sibling, renderLanes2.sibling = null);
            initSuspenseListRenderState(
              workInProgress2,
              false,
              revealOrder,
              renderLanes2,
              tailMode,
              nextProps
            );
            break;
          case "backwards":
          case "unstable_legacy-backwards":
            renderLanes2 = null;
            revealOrder = workInProgress2.child;
            for (workInProgress2.child = null; null !== revealOrder; ) {
              current = revealOrder.alternate;
              if (null !== current && null === findFirstSuspended(current)) {
                workInProgress2.child = revealOrder;
                break;
              }
              current = revealOrder.sibling;
              revealOrder.sibling = renderLanes2;
              renderLanes2 = revealOrder;
              revealOrder = current;
            }
            initSuspenseListRenderState(
              workInProgress2,
              true,
              renderLanes2,
              null,
              tailMode,
              nextProps
            );
            break;
          case "together":
            initSuspenseListRenderState(
              workInProgress2,
              false,
              null,
              null,
              void 0,
              nextProps
            );
            break;
          default:
            workInProgress2.memoizedState = null;
        }
        return workInProgress2.child;
      }
      __name(updateSuspenseListComponent, "updateSuspenseListComponent");
      function bailoutOnAlreadyFinishedWork(current, workInProgress2, renderLanes2) {
        null !== current && (workInProgress2.dependencies = current.dependencies);
        workInProgressRootSkippedLanes |= workInProgress2.lanes;
        if (0 === (renderLanes2 & workInProgress2.childLanes))
          if (null !== current) {
            if (propagateParentContextChanges(
              current,
              workInProgress2,
              renderLanes2,
              false
            ), 0 === (renderLanes2 & workInProgress2.childLanes))
              return null;
          } else return null;
        if (null !== current && workInProgress2.child !== current.child)
          throw Error(formatProdErrorMessage(153));
        if (null !== workInProgress2.child) {
          current = workInProgress2.child;
          renderLanes2 = createWorkInProgress(current, current.pendingProps);
          workInProgress2.child = renderLanes2;
          for (renderLanes2.return = workInProgress2; null !== current.sibling; )
            current = current.sibling, renderLanes2 = renderLanes2.sibling = createWorkInProgress(current, current.pendingProps), renderLanes2.return = workInProgress2;
          renderLanes2.sibling = null;
        }
        return workInProgress2.child;
      }
      __name(bailoutOnAlreadyFinishedWork, "bailoutOnAlreadyFinishedWork");
      function checkScheduledUpdateOrContext(current, renderLanes2) {
        if (0 !== (current.lanes & renderLanes2)) return true;
        current = current.dependencies;
        return null !== current && checkIfContextChanged(current) ? true : false;
      }
      __name(checkScheduledUpdateOrContext, "checkScheduledUpdateOrContext");
      function attemptEarlyBailoutIfNoScheduledUpdate(current, workInProgress2, renderLanes2) {
        switch (workInProgress2.tag) {
          case 3:
            pushHostContainer(
              workInProgress2,
              workInProgress2.stateNode.containerInfo
            );
            pushProvider(workInProgress2, CacheContext, current.memoizedState.cache);
            resetHydrationState();
            break;
          case 27:
          case 5:
            pushHostContext(workInProgress2);
            break;
          case 4:
            pushHostContainer(
              workInProgress2,
              workInProgress2.stateNode.containerInfo
            );
            break;
          case 10:
            pushProvider(
              workInProgress2,
              workInProgress2.type,
              workInProgress2.memoizedProps.value
            );
            break;
          case 31:
            if (null !== workInProgress2.memoizedState)
              return workInProgress2.flags |= 128, pushDehydratedActivitySuspenseHandler(workInProgress2), null;
            break;
          case 13:
            var state$82 = workInProgress2.memoizedState;
            if (null !== state$82) {
              if (null !== state$82.dehydrated)
                return pushPrimaryTreeSuspenseHandler(workInProgress2), workInProgress2.flags |= 128, null;
              if (0 !== (renderLanes2 & workInProgress2.child.childLanes))
                return updateSuspenseComponent(
                  current,
                  workInProgress2,
                  renderLanes2
                );
              pushPrimaryTreeSuspenseHandler(workInProgress2);
              current = bailoutOnAlreadyFinishedWork(
                current,
                workInProgress2,
                renderLanes2
              );
              return null !== current ? current.sibling : null;
            }
            pushPrimaryTreeSuspenseHandler(workInProgress2);
            break;
          case 19:
            var didSuspendBefore = 0 !== (current.flags & 128);
            state$82 = 0 !== (renderLanes2 & workInProgress2.childLanes);
            state$82 || (propagateParentContextChanges(
              current,
              workInProgress2,
              renderLanes2,
              false
            ), state$82 = 0 !== (renderLanes2 & workInProgress2.childLanes));
            if (didSuspendBefore) {
              if (state$82)
                return updateSuspenseListComponent(
                  current,
                  workInProgress2,
                  renderLanes2
                );
              workInProgress2.flags |= 128;
            }
            didSuspendBefore = workInProgress2.memoizedState;
            null !== didSuspendBefore && (didSuspendBefore.rendering = null, didSuspendBefore.tail = null, didSuspendBefore.lastEffect = null);
            push(suspenseStackCursor, suspenseStackCursor.current);
            if (state$82) break;
            else return null;
          case 22:
            return workInProgress2.lanes = 0, updateOffscreenComponent(
              current,
              workInProgress2,
              renderLanes2,
              workInProgress2.pendingProps
            );
          case 24:
            pushProvider(workInProgress2, CacheContext, current.memoizedState.cache);
        }
        return bailoutOnAlreadyFinishedWork(current, workInProgress2, renderLanes2);
      }
      __name(attemptEarlyBailoutIfNoScheduledUpdate, "attemptEarlyBailoutIfNoScheduledUpdate");
      function beginWork(current, workInProgress2, renderLanes2) {
        if (null !== current)
          if (current.memoizedProps !== workInProgress2.pendingProps)
            didReceiveUpdate = true;
          else {
            if (!checkScheduledUpdateOrContext(current, renderLanes2) && 0 === (workInProgress2.flags & 128))
              return didReceiveUpdate = false, attemptEarlyBailoutIfNoScheduledUpdate(
                current,
                workInProgress2,
                renderLanes2
              );
            didReceiveUpdate = 0 !== (current.flags & 131072) ? true : false;
          }
        else
          didReceiveUpdate = false, isHydrating && 0 !== (workInProgress2.flags & 1048576) && pushTreeId(workInProgress2, treeForkCount, workInProgress2.index);
        workInProgress2.lanes = 0;
        switch (workInProgress2.tag) {
          case 16:
            a: {
              var props = workInProgress2.pendingProps;
              current = resolveLazy(workInProgress2.elementType);
              workInProgress2.type = current;
              if ("function" === typeof current)
                shouldConstruct(current) ? (props = resolveClassComponentProps(current, props), workInProgress2.tag = 1, workInProgress2 = updateClassComponent(
                  null,
                  workInProgress2,
                  current,
                  props,
                  renderLanes2
                )) : (workInProgress2.tag = 0, workInProgress2 = updateFunctionComponent(
                  null,
                  workInProgress2,
                  current,
                  props,
                  renderLanes2
                ));
              else {
                if (void 0 !== current && null !== current) {
                  var $$typeof = current.$$typeof;
                  if ($$typeof === REACT_FORWARD_REF_TYPE) {
                    workInProgress2.tag = 11;
                    workInProgress2 = updateForwardRef(
                      null,
                      workInProgress2,
                      current,
                      props,
                      renderLanes2
                    );
                    break a;
                  } else if ($$typeof === REACT_MEMO_TYPE) {
                    workInProgress2.tag = 14;
                    workInProgress2 = updateMemoComponent(
                      null,
                      workInProgress2,
                      current,
                      props,
                      renderLanes2
                    );
                    break a;
                  }
                }
                workInProgress2 = getComponentNameFromType(current) || current;
                throw Error(formatProdErrorMessage(306, workInProgress2, ""));
              }
            }
            return workInProgress2;
          case 0:
            return updateFunctionComponent(
              current,
              workInProgress2,
              workInProgress2.type,
              workInProgress2.pendingProps,
              renderLanes2
            );
          case 1:
            return props = workInProgress2.type, $$typeof = resolveClassComponentProps(
              props,
              workInProgress2.pendingProps
            ), updateClassComponent(
              current,
              workInProgress2,
              props,
              $$typeof,
              renderLanes2
            );
          case 3:
            a: {
              pushHostContainer(
                workInProgress2,
                workInProgress2.stateNode.containerInfo
              );
              if (null === current) throw Error(formatProdErrorMessage(387));
              var nextProps = workInProgress2.pendingProps;
              $$typeof = workInProgress2.memoizedState;
              props = $$typeof.element;
              cloneUpdateQueue(current, workInProgress2);
              processUpdateQueue(workInProgress2, nextProps, null, renderLanes2);
              var nextState = workInProgress2.memoizedState;
              nextProps = nextState.cache;
              pushProvider(workInProgress2, CacheContext, nextProps);
              nextProps !== $$typeof.cache && propagateContextChanges(
                workInProgress2,
                [CacheContext],
                renderLanes2,
                true
              );
              suspendIfUpdateReadFromEntangledAsyncAction();
              nextProps = nextState.element;
              if (supportsHydration && $$typeof.isDehydrated)
                if ($$typeof = {
                  element: nextProps,
                  isDehydrated: false,
                  cache: nextState.cache
                }, workInProgress2.updateQueue.baseState = $$typeof, workInProgress2.memoizedState = $$typeof, workInProgress2.flags & 256) {
                  workInProgress2 = mountHostRootWithoutHydrating(
                    current,
                    workInProgress2,
                    nextProps,
                    renderLanes2
                  );
                  break a;
                } else if (nextProps !== props) {
                  props = createCapturedValueAtFiber(
                    Error(formatProdErrorMessage(424)),
                    workInProgress2
                  );
                  queueHydrationError(props);
                  workInProgress2 = mountHostRootWithoutHydrating(
                    current,
                    workInProgress2,
                    nextProps,
                    renderLanes2
                  );
                  break a;
                } else
                  for (supportsHydration && (nextHydratableInstance = getFirstHydratableChildWithinContainer(
                    workInProgress2.stateNode.containerInfo
                  ), hydrationParentFiber = workInProgress2, isHydrating = true, hydrationErrors = null, rootOrSingletonContext = true), renderLanes2 = mountChildFibers(
                    workInProgress2,
                    null,
                    nextProps,
                    renderLanes2
                  ), workInProgress2.child = renderLanes2; renderLanes2; )
                    renderLanes2.flags = renderLanes2.flags & -3 | 4096, renderLanes2 = renderLanes2.sibling;
              else {
                resetHydrationState();
                if (nextProps === props) {
                  workInProgress2 = bailoutOnAlreadyFinishedWork(
                    current,
                    workInProgress2,
                    renderLanes2
                  );
                  break a;
                }
                reconcileChildren(current, workInProgress2, nextProps, renderLanes2);
              }
              workInProgress2 = workInProgress2.child;
            }
            return workInProgress2;
          case 26:
            if (supportsResources)
              return markRef(current, workInProgress2), null === current ? (renderLanes2 = getResource(
                workInProgress2.type,
                null,
                workInProgress2.pendingProps,
                null
              )) ? workInProgress2.memoizedState = renderLanes2 : isHydrating || (workInProgress2.stateNode = createHoistableInstance(
                workInProgress2.type,
                workInProgress2.pendingProps,
                rootInstanceStackCursor.current,
                workInProgress2
              )) : workInProgress2.memoizedState = getResource(
                workInProgress2.type,
                current.memoizedProps,
                workInProgress2.pendingProps,
                current.memoizedState
              ), null;
          case 27:
            if (supportsSingletons)
              return pushHostContext(workInProgress2), null === current && supportsSingletons && isHydrating && (props = workInProgress2.stateNode = resolveSingletonInstance(
                workInProgress2.type,
                workInProgress2.pendingProps,
                rootInstanceStackCursor.current,
                contextStackCursor.current,
                false
              ), hydrationParentFiber = workInProgress2, rootOrSingletonContext = true, nextHydratableInstance = getFirstHydratableChildWithinSingleton(
                workInProgress2.type,
                props,
                nextHydratableInstance
              )), reconcileChildren(
                current,
                workInProgress2,
                workInProgress2.pendingProps.children,
                renderLanes2
              ), markRef(current, workInProgress2), null === current && (workInProgress2.flags |= 4194304), workInProgress2.child;
          case 5:
            if (null === current && isHydrating) {
              validateHydratableInstance(
                workInProgress2.type,
                workInProgress2.pendingProps,
                contextStackCursor.current
              );
              if ($$typeof = props = nextHydratableInstance)
                props = canHydrateInstance(
                  props,
                  workInProgress2.type,
                  workInProgress2.pendingProps,
                  rootOrSingletonContext
                ), null !== props ? (workInProgress2.stateNode = props, hydrationParentFiber = workInProgress2, nextHydratableInstance = getFirstHydratableChild(props), rootOrSingletonContext = false, $$typeof = true) : $$typeof = false;
              $$typeof || throwOnHydrationMismatch(workInProgress2);
            }
            pushHostContext(workInProgress2);
            $$typeof = workInProgress2.type;
            nextProps = workInProgress2.pendingProps;
            nextState = null !== current ? current.memoizedProps : null;
            props = nextProps.children;
            shouldSetTextContent($$typeof, nextProps) ? props = null : null !== nextState && shouldSetTextContent($$typeof, nextState) && (workInProgress2.flags |= 32);
            null !== workInProgress2.memoizedState && ($$typeof = renderWithHooks(
              current,
              workInProgress2,
              TransitionAwareHostComponent,
              null,
              null,
              renderLanes2
            ), isPrimaryRenderer ? HostTransitionContext._currentValue = $$typeof : HostTransitionContext._currentValue2 = $$typeof);
            markRef(current, workInProgress2);
            reconcileChildren(current, workInProgress2, props, renderLanes2);
            return workInProgress2.child;
          case 6:
            if (null === current && isHydrating) {
              validateHydratableTextInstance(
                workInProgress2.pendingProps,
                contextStackCursor.current
              );
              if (current = renderLanes2 = nextHydratableInstance)
                renderLanes2 = canHydrateTextInstance(
                  renderLanes2,
                  workInProgress2.pendingProps,
                  rootOrSingletonContext
                ), null !== renderLanes2 ? (workInProgress2.stateNode = renderLanes2, hydrationParentFiber = workInProgress2, nextHydratableInstance = null, current = true) : current = false;
              current || throwOnHydrationMismatch(workInProgress2);
            }
            return null;
          case 13:
            return updateSuspenseComponent(current, workInProgress2, renderLanes2);
          case 4:
            return pushHostContainer(
              workInProgress2,
              workInProgress2.stateNode.containerInfo
            ), props = workInProgress2.pendingProps, null === current ? workInProgress2.child = reconcileChildFibers(
              workInProgress2,
              null,
              props,
              renderLanes2
            ) : reconcileChildren(current, workInProgress2, props, renderLanes2), workInProgress2.child;
          case 11:
            return updateForwardRef(
              current,
              workInProgress2,
              workInProgress2.type,
              workInProgress2.pendingProps,
              renderLanes2
            );
          case 7:
            return reconcileChildren(
              current,
              workInProgress2,
              workInProgress2.pendingProps,
              renderLanes2
            ), workInProgress2.child;
          case 8:
            return reconcileChildren(
              current,
              workInProgress2,
              workInProgress2.pendingProps.children,
              renderLanes2
            ), workInProgress2.child;
          case 12:
            return reconcileChildren(
              current,
              workInProgress2,
              workInProgress2.pendingProps.children,
              renderLanes2
            ), workInProgress2.child;
          case 10:
            return props = workInProgress2.pendingProps, pushProvider(workInProgress2, workInProgress2.type, props.value), reconcileChildren(
              current,
              workInProgress2,
              props.children,
              renderLanes2
            ), workInProgress2.child;
          case 9:
            return $$typeof = workInProgress2.type._context, props = workInProgress2.pendingProps.children, prepareToReadContext(workInProgress2), $$typeof = readContext($$typeof), props = props($$typeof), workInProgress2.flags |= 1, reconcileChildren(current, workInProgress2, props, renderLanes2), workInProgress2.child;
          case 14:
            return updateMemoComponent(
              current,
              workInProgress2,
              workInProgress2.type,
              workInProgress2.pendingProps,
              renderLanes2
            );
          case 15:
            return updateSimpleMemoComponent(
              current,
              workInProgress2,
              workInProgress2.type,
              workInProgress2.pendingProps,
              renderLanes2
            );
          case 19:
            return updateSuspenseListComponent(
              current,
              workInProgress2,
              renderLanes2
            );
          case 31:
            return updateActivityComponent(current, workInProgress2, renderLanes2);
          case 22:
            return updateOffscreenComponent(
              current,
              workInProgress2,
              renderLanes2,
              workInProgress2.pendingProps
            );
          case 24:
            return prepareToReadContext(workInProgress2), props = readContext(CacheContext), null === current ? ($$typeof = peekCacheFromPool(), null === $$typeof && ($$typeof = workInProgressRoot, nextProps = createCache(), $$typeof.pooledCache = nextProps, nextProps.refCount++, null !== nextProps && ($$typeof.pooledCacheLanes |= renderLanes2), $$typeof = nextProps), workInProgress2.memoizedState = {
              parent: props,
              cache: $$typeof
            }, initializeUpdateQueue(workInProgress2), pushProvider(workInProgress2, CacheContext, $$typeof)) : (0 !== (current.lanes & renderLanes2) && (cloneUpdateQueue(current, workInProgress2), processUpdateQueue(workInProgress2, null, null, renderLanes2), suspendIfUpdateReadFromEntangledAsyncAction()), $$typeof = current.memoizedState, nextProps = workInProgress2.memoizedState, $$typeof.parent !== props ? ($$typeof = { parent: props, cache: props }, workInProgress2.memoizedState = $$typeof, 0 === workInProgress2.lanes && (workInProgress2.memoizedState = workInProgress2.updateQueue.baseState = $$typeof), pushProvider(workInProgress2, CacheContext, props)) : (props = nextProps.cache, pushProvider(workInProgress2, CacheContext, props), props !== $$typeof.cache && propagateContextChanges(
              workInProgress2,
              [CacheContext],
              renderLanes2,
              true
            ))), reconcileChildren(
              current,
              workInProgress2,
              workInProgress2.pendingProps.children,
              renderLanes2
            ), workInProgress2.child;
          case 29:
            throw workInProgress2.pendingProps;
        }
        throw Error(formatProdErrorMessage(156, workInProgress2.tag));
      }
      __name(beginWork, "beginWork");
      function markUpdate(workInProgress2) {
        workInProgress2.flags |= 4;
      }
      __name(markUpdate, "markUpdate");
      function markCloned(workInProgress2) {
        supportsPersistence && (workInProgress2.flags |= 8);
      }
      __name(markCloned, "markCloned");
      function doesRequireClone(current, completedWork) {
        if (null !== current && current.child === completedWork.child) return false;
        if (0 !== (completedWork.flags & 16)) return true;
        for (current = completedWork.child; null !== current; ) {
          if (0 !== (current.flags & 8218) || 0 !== (current.subtreeFlags & 8218))
            return true;
          current = current.sibling;
        }
        return false;
      }
      __name(doesRequireClone, "doesRequireClone");
      function appendAllChildren(parent, workInProgress2, needsVisibilityToggle, isHidden2) {
        if (supportsMutation)
          for (needsVisibilityToggle = workInProgress2.child; null !== needsVisibilityToggle; ) {
            if (5 === needsVisibilityToggle.tag || 6 === needsVisibilityToggle.tag)
              appendInitialChild(parent, needsVisibilityToggle.stateNode);
            else if (!(4 === needsVisibilityToggle.tag || supportsSingletons && 27 === needsVisibilityToggle.tag) && null !== needsVisibilityToggle.child) {
              needsVisibilityToggle.child.return = needsVisibilityToggle;
              needsVisibilityToggle = needsVisibilityToggle.child;
              continue;
            }
            if (needsVisibilityToggle === workInProgress2) break;
            for (; null === needsVisibilityToggle.sibling; ) {
              if (null === needsVisibilityToggle.return || needsVisibilityToggle.return === workInProgress2)
                return;
              needsVisibilityToggle = needsVisibilityToggle.return;
            }
            needsVisibilityToggle.sibling.return = needsVisibilityToggle.return;
            needsVisibilityToggle = needsVisibilityToggle.sibling;
          }
        else if (supportsPersistence)
          for (var node$85 = workInProgress2.child; null !== node$85; ) {
            if (5 === node$85.tag) {
              var instance = node$85.stateNode;
              needsVisibilityToggle && isHidden2 && (instance = cloneHiddenInstance(
                instance,
                node$85.type,
                node$85.memoizedProps
              ));
              appendInitialChild(parent, instance);
            } else if (6 === node$85.tag)
              instance = node$85.stateNode, needsVisibilityToggle && isHidden2 && (instance = cloneHiddenTextInstance(
                instance,
                node$85.memoizedProps
              )), appendInitialChild(parent, instance);
            else if (4 !== node$85.tag) {
              if (22 === node$85.tag && null !== node$85.memoizedState)
                instance = node$85.child, null !== instance && (instance.return = node$85), appendAllChildren(parent, node$85, true, true);
              else if (null !== node$85.child) {
                node$85.child.return = node$85;
                node$85 = node$85.child;
                continue;
              }
            }
            if (node$85 === workInProgress2) break;
            for (; null === node$85.sibling; ) {
              if (null === node$85.return || node$85.return === workInProgress2)
                return;
              node$85 = node$85.return;
            }
            node$85.sibling.return = node$85.return;
            node$85 = node$85.sibling;
          }
      }
      __name(appendAllChildren, "appendAllChildren");
      function appendAllChildrenToContainer(containerChildSet, workInProgress2, needsVisibilityToggle, isHidden2) {
        var hasOffscreenComponentChild = false;
        if (supportsPersistence)
          for (var node = workInProgress2.child; null !== node; ) {
            if (5 === node.tag) {
              var instance = node.stateNode;
              needsVisibilityToggle && isHidden2 && (instance = cloneHiddenInstance(
                instance,
                node.type,
                node.memoizedProps
              ));
              appendChildToContainerChildSet(containerChildSet, instance);
            } else if (6 === node.tag)
              instance = node.stateNode, needsVisibilityToggle && isHidden2 && (instance = cloneHiddenTextInstance(
                instance,
                node.memoizedProps
              )), appendChildToContainerChildSet(containerChildSet, instance);
            else if (4 !== node.tag) {
              if (22 === node.tag && null !== node.memoizedState)
                hasOffscreenComponentChild = node.child, null !== hasOffscreenComponentChild && (hasOffscreenComponentChild.return = node), appendAllChildrenToContainer(containerChildSet, node, true, true), hasOffscreenComponentChild = true;
              else if (null !== node.child) {
                node.child.return = node;
                node = node.child;
                continue;
              }
            }
            if (node === workInProgress2) break;
            for (; null === node.sibling; ) {
              if (null === node.return || node.return === workInProgress2)
                return hasOffscreenComponentChild;
              node = node.return;
            }
            node.sibling.return = node.return;
            node = node.sibling;
          }
        return hasOffscreenComponentChild;
      }
      __name(appendAllChildrenToContainer, "appendAllChildrenToContainer");
      function updateHostContainer(current, workInProgress2) {
        if (supportsPersistence && doesRequireClone(current, workInProgress2)) {
          current = workInProgress2.stateNode;
          var container = current.containerInfo, newChildSet = createContainerChildSet();
          appendAllChildrenToContainer(newChildSet, workInProgress2, false, false);
          current.pendingChildren = newChildSet;
          markUpdate(workInProgress2);
          finalizeContainerChildren(container, newChildSet);
        }
      }
      __name(updateHostContainer, "updateHostContainer");
      function updateHostComponent(current, workInProgress2, type, newProps) {
        if (supportsMutation)
          current.memoizedProps !== newProps && markUpdate(workInProgress2);
        else if (supportsPersistence) {
          var currentInstance = current.stateNode, oldProps$88 = current.memoizedProps;
          if ((current = doesRequireClone(current, workInProgress2)) || oldProps$88 !== newProps) {
            var currentHostContext = contextStackCursor.current;
            oldProps$88 = cloneInstance(
              currentInstance,
              type,
              oldProps$88,
              newProps,
              !current,
              null
            );
            oldProps$88 === currentInstance ? workInProgress2.stateNode = currentInstance : (markCloned(workInProgress2), finalizeInitialChildren(
              oldProps$88,
              type,
              newProps,
              currentHostContext
            ) && markUpdate(workInProgress2), workInProgress2.stateNode = oldProps$88, current && appendAllChildren(oldProps$88, workInProgress2, false, false));
          } else workInProgress2.stateNode = currentInstance;
        }
      }
      __name(updateHostComponent, "updateHostComponent");
      function preloadInstanceAndSuspendIfNeeded(workInProgress2, type, oldProps, newProps, renderLanes2) {
        if (0 !== (workInProgress2.mode & 32) && (null === oldProps ? maySuspendCommit(type, newProps) : maySuspendCommitOnUpdate(type, oldProps, newProps))) {
          if (workInProgress2.flags |= 16777216, (renderLanes2 & 335544128) === renderLanes2 || maySuspendCommitInSyncRender(type, newProps))
            if (preloadInstance(workInProgress2.stateNode, type, newProps))
              workInProgress2.flags |= 8192;
            else if (shouldRemainOnPreviousScreen()) workInProgress2.flags |= 8192;
            else
              throw suspendedThenable = noopSuspenseyCommitThenable, SuspenseyCommitException;
        } else workInProgress2.flags &= -16777217;
      }
      __name(preloadInstanceAndSuspendIfNeeded, "preloadInstanceAndSuspendIfNeeded");
      function preloadResourceAndSuspendIfNeeded(workInProgress2, resource) {
        if (mayResourceSuspendCommit(resource)) {
          if (workInProgress2.flags |= 16777216, !preloadResource(resource))
            if (shouldRemainOnPreviousScreen()) workInProgress2.flags |= 8192;
            else
              throw suspendedThenable = noopSuspenseyCommitThenable, SuspenseyCommitException;
        } else workInProgress2.flags &= -16777217;
      }
      __name(preloadResourceAndSuspendIfNeeded, "preloadResourceAndSuspendIfNeeded");
      function scheduleRetryEffect(workInProgress2, retryQueue) {
        null !== retryQueue && (workInProgress2.flags |= 4);
        workInProgress2.flags & 16384 && (retryQueue = 22 !== workInProgress2.tag ? claimNextRetryLane() : 536870912, workInProgress2.lanes |= retryQueue, workInProgressSuspendedRetryLanes |= retryQueue);
      }
      __name(scheduleRetryEffect, "scheduleRetryEffect");
      function cutOffTailIfNeeded(renderState, hasRenderedATailFallback) {
        if (!isHydrating)
          switch (renderState.tailMode) {
            case "hidden":
              hasRenderedATailFallback = renderState.tail;
              for (var lastTailNode = null; null !== hasRenderedATailFallback; )
                null !== hasRenderedATailFallback.alternate && (lastTailNode = hasRenderedATailFallback), hasRenderedATailFallback = hasRenderedATailFallback.sibling;
              null === lastTailNode ? renderState.tail = null : lastTailNode.sibling = null;
              break;
            case "collapsed":
              lastTailNode = renderState.tail;
              for (var lastTailNode$90 = null; null !== lastTailNode; )
                null !== lastTailNode.alternate && (lastTailNode$90 = lastTailNode), lastTailNode = lastTailNode.sibling;
              null === lastTailNode$90 ? hasRenderedATailFallback || null === renderState.tail ? renderState.tail = null : renderState.tail.sibling = null : lastTailNode$90.sibling = null;
          }
      }
      __name(cutOffTailIfNeeded, "cutOffTailIfNeeded");
      function bubbleProperties(completedWork) {
        var didBailout = null !== completedWork.alternate && completedWork.alternate.child === completedWork.child, newChildLanes = 0, subtreeFlags = 0;
        if (didBailout)
          for (var child$91 = completedWork.child; null !== child$91; )
            newChildLanes |= child$91.lanes | child$91.childLanes, subtreeFlags |= child$91.subtreeFlags & 65011712, subtreeFlags |= child$91.flags & 65011712, child$91.return = completedWork, child$91 = child$91.sibling;
        else
          for (child$91 = completedWork.child; null !== child$91; )
            newChildLanes |= child$91.lanes | child$91.childLanes, subtreeFlags |= child$91.subtreeFlags, subtreeFlags |= child$91.flags, child$91.return = completedWork, child$91 = child$91.sibling;
        completedWork.subtreeFlags |= subtreeFlags;
        completedWork.childLanes = newChildLanes;
        return didBailout;
      }
      __name(bubbleProperties, "bubbleProperties");
      function completeWork(current, workInProgress2, renderLanes2) {
        var newProps = workInProgress2.pendingProps;
        popTreeContext(workInProgress2);
        switch (workInProgress2.tag) {
          case 16:
          case 15:
          case 0:
          case 11:
          case 7:
          case 8:
          case 12:
          case 9:
          case 14:
            return bubbleProperties(workInProgress2), null;
          case 1:
            return bubbleProperties(workInProgress2), null;
          case 3:
            renderLanes2 = workInProgress2.stateNode;
            newProps = null;
            null !== current && (newProps = current.memoizedState.cache);
            workInProgress2.memoizedState.cache !== newProps && (workInProgress2.flags |= 2048);
            popProvider(CacheContext);
            popHostContainer();
            renderLanes2.pendingContext && (renderLanes2.context = renderLanes2.pendingContext, renderLanes2.pendingContext = null);
            if (null === current || null === current.child)
              popHydrationState(workInProgress2) ? markUpdate(workInProgress2) : null === current || current.memoizedState.isDehydrated && 0 === (workInProgress2.flags & 256) || (workInProgress2.flags |= 1024, upgradeHydrationErrorsToRecoverable());
            updateHostContainer(current, workInProgress2);
            bubbleProperties(workInProgress2);
            return null;
          case 26:
            if (supportsResources) {
              var type = workInProgress2.type, nextResource = workInProgress2.memoizedState;
              null === current ? (markUpdate(workInProgress2), null !== nextResource ? (bubbleProperties(workInProgress2), preloadResourceAndSuspendIfNeeded(
                workInProgress2,
                nextResource
              )) : (bubbleProperties(workInProgress2), preloadInstanceAndSuspendIfNeeded(
                workInProgress2,
                type,
                null,
                newProps,
                renderLanes2
              ))) : nextResource ? nextResource !== current.memoizedState ? (markUpdate(workInProgress2), bubbleProperties(workInProgress2), preloadResourceAndSuspendIfNeeded(
                workInProgress2,
                nextResource
              )) : (bubbleProperties(workInProgress2), workInProgress2.flags &= -16777217) : (nextResource = current.memoizedProps, supportsMutation ? nextResource !== newProps && markUpdate(workInProgress2) : updateHostComponent(
                current,
                workInProgress2,
                type,
                newProps
              ), bubbleProperties(workInProgress2), preloadInstanceAndSuspendIfNeeded(
                workInProgress2,
                type,
                nextResource,
                newProps,
                renderLanes2
              ));
              return null;
            }
          case 27:
            if (supportsSingletons) {
              popHostContext(workInProgress2);
              renderLanes2 = rootInstanceStackCursor.current;
              type = workInProgress2.type;
              if (null !== current && null != workInProgress2.stateNode)
                supportsMutation ? current.memoizedProps !== newProps && markUpdate(workInProgress2) : updateHostComponent(current, workInProgress2, type, newProps);
              else {
                if (!newProps) {
                  if (null === workInProgress2.stateNode)
                    throw Error(formatProdErrorMessage(166));
                  bubbleProperties(workInProgress2);
                  return null;
                }
                current = contextStackCursor.current;
                popHydrationState(workInProgress2) ? prepareToHydrateHostInstance(workInProgress2, current) : (current = resolveSingletonInstance(
                  type,
                  newProps,
                  renderLanes2,
                  current,
                  true
                ), workInProgress2.stateNode = current, markUpdate(workInProgress2));
              }
              bubbleProperties(workInProgress2);
              return null;
            }
          case 5:
            popHostContext(workInProgress2);
            type = workInProgress2.type;
            if (null !== current && null != workInProgress2.stateNode)
              updateHostComponent(current, workInProgress2, type, newProps);
            else {
              if (!newProps) {
                if (null === workInProgress2.stateNode)
                  throw Error(formatProdErrorMessage(166));
                bubbleProperties(workInProgress2);
                return null;
              }
              nextResource = contextStackCursor.current;
              if (popHydrationState(workInProgress2))
                prepareToHydrateHostInstance(workInProgress2, nextResource), finalizeHydratedChildren(
                  workInProgress2.stateNode,
                  type,
                  newProps,
                  nextResource
                ) && (workInProgress2.flags |= 64);
              else {
                var instance$101 = createInstance(
                  type,
                  newProps,
                  rootInstanceStackCursor.current,
                  nextResource,
                  workInProgress2
                );
                markCloned(workInProgress2);
                appendAllChildren(instance$101, workInProgress2, false, false);
                workInProgress2.stateNode = instance$101;
                finalizeInitialChildren(
                  instance$101,
                  type,
                  newProps,
                  nextResource
                ) && markUpdate(workInProgress2);
              }
            }
            bubbleProperties(workInProgress2);
            preloadInstanceAndSuspendIfNeeded(
              workInProgress2,
              workInProgress2.type,
              null === current ? null : current.memoizedProps,
              workInProgress2.pendingProps,
              renderLanes2
            );
            return null;
          case 6:
            if (current && null != workInProgress2.stateNode)
              renderLanes2 = current.memoizedProps, supportsMutation ? renderLanes2 !== newProps && markUpdate(workInProgress2) : supportsPersistence && (renderLanes2 !== newProps ? (current = rootInstanceStackCursor.current, renderLanes2 = contextStackCursor.current, markCloned(workInProgress2), workInProgress2.stateNode = createTextInstance(
                newProps,
                current,
                renderLanes2,
                workInProgress2
              )) : workInProgress2.stateNode = current.stateNode);
            else {
              if ("string" !== typeof newProps && null === workInProgress2.stateNode)
                throw Error(formatProdErrorMessage(166));
              current = rootInstanceStackCursor.current;
              renderLanes2 = contextStackCursor.current;
              if (popHydrationState(workInProgress2)) {
                if (!supportsHydration) throw Error(formatProdErrorMessage(176));
                current = workInProgress2.stateNode;
                renderLanes2 = workInProgress2.memoizedProps;
                newProps = null;
                type = hydrationParentFiber;
                if (null !== type)
                  switch (type.tag) {
                    case 27:
                    case 5:
                      newProps = type.memoizedProps;
                  }
                hydrateTextInstance(
                  current,
                  renderLanes2,
                  workInProgress2,
                  newProps
                ) || throwOnHydrationMismatch(workInProgress2, true);
              } else
                markCloned(workInProgress2), workInProgress2.stateNode = createTextInstance(
                  newProps,
                  current,
                  renderLanes2,
                  workInProgress2
                );
            }
            bubbleProperties(workInProgress2);
            return null;
          case 31:
            renderLanes2 = workInProgress2.memoizedState;
            if (null === current || null !== current.memoizedState) {
              newProps = popHydrationState(workInProgress2);
              if (null !== renderLanes2) {
                if (null === current) {
                  if (!newProps) throw Error(formatProdErrorMessage(318));
                  if (!supportsHydration) throw Error(formatProdErrorMessage(556));
                  current = workInProgress2.memoizedState;
                  current = null !== current ? current.dehydrated : null;
                  if (!current) throw Error(formatProdErrorMessage(557));
                  hydrateActivityInstance(current, workInProgress2);
                } else
                  resetHydrationState(), 0 === (workInProgress2.flags & 128) && (workInProgress2.memoizedState = null), workInProgress2.flags |= 4;
                bubbleProperties(workInProgress2);
                current = false;
              } else
                renderLanes2 = upgradeHydrationErrorsToRecoverable(), null !== current && null !== current.memoizedState && (current.memoizedState.hydrationErrors = renderLanes2), current = true;
              if (!current) {
                if (workInProgress2.flags & 256)
                  return popSuspenseHandler(workInProgress2), workInProgress2;
                popSuspenseHandler(workInProgress2);
                return null;
              }
              if (0 !== (workInProgress2.flags & 128))
                throw Error(formatProdErrorMessage(558));
            }
            bubbleProperties(workInProgress2);
            return null;
          case 13:
            newProps = workInProgress2.memoizedState;
            if (null === current || null !== current.memoizedState && null !== current.memoizedState.dehydrated) {
              type = popHydrationState(workInProgress2);
              if (null !== newProps && null !== newProps.dehydrated) {
                if (null === current) {
                  if (!type) throw Error(formatProdErrorMessage(318));
                  if (!supportsHydration) throw Error(formatProdErrorMessage(344));
                  type = workInProgress2.memoizedState;
                  type = null !== type ? type.dehydrated : null;
                  if (!type) throw Error(formatProdErrorMessage(317));
                  hydrateSuspenseInstance(type, workInProgress2);
                } else
                  resetHydrationState(), 0 === (workInProgress2.flags & 128) && (workInProgress2.memoizedState = null), workInProgress2.flags |= 4;
                bubbleProperties(workInProgress2);
                type = false;
              } else
                type = upgradeHydrationErrorsToRecoverable(), null !== current && null !== current.memoizedState && (current.memoizedState.hydrationErrors = type), type = true;
              if (!type) {
                if (workInProgress2.flags & 256)
                  return popSuspenseHandler(workInProgress2), workInProgress2;
                popSuspenseHandler(workInProgress2);
                return null;
              }
            }
            popSuspenseHandler(workInProgress2);
            if (0 !== (workInProgress2.flags & 128))
              return workInProgress2.lanes = renderLanes2, workInProgress2;
            renderLanes2 = null !== newProps;
            current = null !== current && null !== current.memoizedState;
            renderLanes2 && (newProps = workInProgress2.child, type = null, null !== newProps.alternate && null !== newProps.alternate.memoizedState && null !== newProps.alternate.memoizedState.cachePool && (type = newProps.alternate.memoizedState.cachePool.pool), nextResource = null, null !== newProps.memoizedState && null !== newProps.memoizedState.cachePool && (nextResource = newProps.memoizedState.cachePool.pool), nextResource !== type && (newProps.flags |= 2048));
            renderLanes2 !== current && renderLanes2 && (workInProgress2.child.flags |= 8192);
            scheduleRetryEffect(workInProgress2, workInProgress2.updateQueue);
            bubbleProperties(workInProgress2);
            return null;
          case 4:
            return popHostContainer(), updateHostContainer(current, workInProgress2), null === current && preparePortalMount(workInProgress2.stateNode.containerInfo), bubbleProperties(workInProgress2), null;
          case 10:
            return popProvider(workInProgress2.type), bubbleProperties(workInProgress2), null;
          case 19:
            pop(suspenseStackCursor);
            newProps = workInProgress2.memoizedState;
            if (null === newProps) return bubbleProperties(workInProgress2), null;
            type = 0 !== (workInProgress2.flags & 128);
            nextResource = newProps.rendering;
            if (null === nextResource)
              if (type) cutOffTailIfNeeded(newProps, false);
              else {
                if (0 !== workInProgressRootExitStatus || null !== current && 0 !== (current.flags & 128))
                  for (current = workInProgress2.child; null !== current; ) {
                    nextResource = findFirstSuspended(current);
                    if (null !== nextResource) {
                      workInProgress2.flags |= 128;
                      cutOffTailIfNeeded(newProps, false);
                      current = nextResource.updateQueue;
                      workInProgress2.updateQueue = current;
                      scheduleRetryEffect(workInProgress2, current);
                      workInProgress2.subtreeFlags = 0;
                      current = renderLanes2;
                      for (renderLanes2 = workInProgress2.child; null !== renderLanes2; )
                        resetWorkInProgress(renderLanes2, current), renderLanes2 = renderLanes2.sibling;
                      push(
                        suspenseStackCursor,
                        suspenseStackCursor.current & 1 | 2
                      );
                      isHydrating && pushTreeFork(workInProgress2, newProps.treeForkCount);
                      return workInProgress2.child;
                    }
                    current = current.sibling;
                  }
                null !== newProps.tail && now() > workInProgressRootRenderTargetTime && (workInProgress2.flags |= 128, type = true, cutOffTailIfNeeded(newProps, false), workInProgress2.lanes = 4194304);
              }
            else {
              if (!type)
                if (current = findFirstSuspended(nextResource), null !== current) {
                  if (workInProgress2.flags |= 128, type = true, current = current.updateQueue, workInProgress2.updateQueue = current, scheduleRetryEffect(workInProgress2, current), cutOffTailIfNeeded(newProps, true), null === newProps.tail && "hidden" === newProps.tailMode && !nextResource.alternate && !isHydrating)
                    return bubbleProperties(workInProgress2), null;
                } else
                  2 * now() - newProps.renderingStartTime > workInProgressRootRenderTargetTime && 536870912 !== renderLanes2 && (workInProgress2.flags |= 128, type = true, cutOffTailIfNeeded(newProps, false), workInProgress2.lanes = 4194304);
              newProps.isBackwards ? (nextResource.sibling = workInProgress2.child, workInProgress2.child = nextResource) : (current = newProps.last, null !== current ? current.sibling = nextResource : workInProgress2.child = nextResource, newProps.last = nextResource);
            }
            if (null !== newProps.tail)
              return current = newProps.tail, newProps.rendering = current, newProps.tail = current.sibling, newProps.renderingStartTime = now(), current.sibling = null, renderLanes2 = suspenseStackCursor.current, push(
                suspenseStackCursor,
                type ? renderLanes2 & 1 | 2 : renderLanes2 & 1
              ), isHydrating && pushTreeFork(workInProgress2, newProps.treeForkCount), current;
            bubbleProperties(workInProgress2);
            return null;
          case 22:
          case 23:
            return popSuspenseHandler(workInProgress2), popHiddenContext(), newProps = null !== workInProgress2.memoizedState, null !== current ? null !== current.memoizedState !== newProps && (workInProgress2.flags |= 8192) : newProps && (workInProgress2.flags |= 8192), newProps ? 0 !== (renderLanes2 & 536870912) && 0 === (workInProgress2.flags & 128) && (bubbleProperties(workInProgress2), workInProgress2.subtreeFlags & 6 && (workInProgress2.flags |= 8192)) : bubbleProperties(workInProgress2), renderLanes2 = workInProgress2.updateQueue, null !== renderLanes2 && scheduleRetryEffect(workInProgress2, renderLanes2.retryQueue), renderLanes2 = null, null !== current && null !== current.memoizedState && null !== current.memoizedState.cachePool && (renderLanes2 = current.memoizedState.cachePool.pool), newProps = null, null !== workInProgress2.memoizedState && null !== workInProgress2.memoizedState.cachePool && (newProps = workInProgress2.memoizedState.cachePool.pool), newProps !== renderLanes2 && (workInProgress2.flags |= 2048), null !== current && pop(resumedCache), null;
          case 24:
            return renderLanes2 = null, null !== current && (renderLanes2 = current.memoizedState.cache), workInProgress2.memoizedState.cache !== renderLanes2 && (workInProgress2.flags |= 2048), popProvider(CacheContext), bubbleProperties(workInProgress2), null;
          case 25:
            return null;
          case 30:
            return null;
        }
        throw Error(formatProdErrorMessage(156, workInProgress2.tag));
      }
      __name(completeWork, "completeWork");
      function unwindWork(current, workInProgress2) {
        popTreeContext(workInProgress2);
        switch (workInProgress2.tag) {
          case 1:
            return current = workInProgress2.flags, current & 65536 ? (workInProgress2.flags = current & -65537 | 128, workInProgress2) : null;
          case 3:
            return popProvider(CacheContext), popHostContainer(), current = workInProgress2.flags, 0 !== (current & 65536) && 0 === (current & 128) ? (workInProgress2.flags = current & -65537 | 128, workInProgress2) : null;
          case 26:
          case 27:
          case 5:
            return popHostContext(workInProgress2), null;
          case 31:
            if (null !== workInProgress2.memoizedState) {
              popSuspenseHandler(workInProgress2);
              if (null === workInProgress2.alternate)
                throw Error(formatProdErrorMessage(340));
              resetHydrationState();
            }
            current = workInProgress2.flags;
            return current & 65536 ? (workInProgress2.flags = current & -65537 | 128, workInProgress2) : null;
          case 13:
            popSuspenseHandler(workInProgress2);
            current = workInProgress2.memoizedState;
            if (null !== current && null !== current.dehydrated) {
              if (null === workInProgress2.alternate)
                throw Error(formatProdErrorMessage(340));
              resetHydrationState();
            }
            current = workInProgress2.flags;
            return current & 65536 ? (workInProgress2.flags = current & -65537 | 128, workInProgress2) : null;
          case 19:
            return pop(suspenseStackCursor), null;
          case 4:
            return popHostContainer(), null;
          case 10:
            return popProvider(workInProgress2.type), null;
          case 22:
          case 23:
            return popSuspenseHandler(workInProgress2), popHiddenContext(), null !== current && pop(resumedCache), current = workInProgress2.flags, current & 65536 ? (workInProgress2.flags = current & -65537 | 128, workInProgress2) : null;
          case 24:
            return popProvider(CacheContext), null;
          case 25:
            return null;
          default:
            return null;
        }
      }
      __name(unwindWork, "unwindWork");
      function unwindInterruptedWork(current, interruptedWork) {
        popTreeContext(interruptedWork);
        switch (interruptedWork.tag) {
          case 3:
            popProvider(CacheContext);
            popHostContainer();
            break;
          case 26:
          case 27:
          case 5:
            popHostContext(interruptedWork);
            break;
          case 4:
            popHostContainer();
            break;
          case 31:
            null !== interruptedWork.memoizedState && popSuspenseHandler(interruptedWork);
            break;
          case 13:
            popSuspenseHandler(interruptedWork);
            break;
          case 19:
            pop(suspenseStackCursor);
            break;
          case 10:
            popProvider(interruptedWork.type);
            break;
          case 22:
          case 23:
            popSuspenseHandler(interruptedWork);
            popHiddenContext();
            null !== current && pop(resumedCache);
            break;
          case 24:
            popProvider(CacheContext);
        }
      }
      __name(unwindInterruptedWork, "unwindInterruptedWork");
      function commitHookEffectListMount(flags, finishedWork) {
        try {
          var updateQueue = finishedWork.updateQueue, lastEffect = null !== updateQueue ? updateQueue.lastEffect : null;
          if (null !== lastEffect) {
            var firstEffect = lastEffect.next;
            updateQueue = firstEffect;
            do {
              if ((updateQueue.tag & flags) === flags) {
                lastEffect = void 0;
                var create3 = updateQueue.create, inst = updateQueue.inst;
                lastEffect = create3();
                inst.destroy = lastEffect;
              }
              updateQueue = updateQueue.next;
            } while (updateQueue !== firstEffect);
          }
        } catch (error) {
          captureCommitPhaseError(finishedWork, finishedWork.return, error);
        }
      }
      __name(commitHookEffectListMount, "commitHookEffectListMount");
      function commitHookEffectListUnmount(flags, finishedWork, nearestMountedAncestor$jscomp$0) {
        try {
          var updateQueue = finishedWork.updateQueue, lastEffect = null !== updateQueue ? updateQueue.lastEffect : null;
          if (null !== lastEffect) {
            var firstEffect = lastEffect.next;
            updateQueue = firstEffect;
            do {
              if ((updateQueue.tag & flags) === flags) {
                var inst = updateQueue.inst, destroy = inst.destroy;
                if (void 0 !== destroy) {
                  inst.destroy = void 0;
                  lastEffect = finishedWork;
                  var nearestMountedAncestor = nearestMountedAncestor$jscomp$0, destroy_ = destroy;
                  try {
                    destroy_();
                  } catch (error) {
                    captureCommitPhaseError(
                      lastEffect,
                      nearestMountedAncestor,
                      error
                    );
                  }
                }
              }
              updateQueue = updateQueue.next;
            } while (updateQueue !== firstEffect);
          }
        } catch (error) {
          captureCommitPhaseError(finishedWork, finishedWork.return, error);
        }
      }
      __name(commitHookEffectListUnmount, "commitHookEffectListUnmount");
      function commitClassCallbacks(finishedWork) {
        var updateQueue = finishedWork.updateQueue;
        if (null !== updateQueue) {
          var instance = finishedWork.stateNode;
          try {
            commitCallbacks(updateQueue, instance);
          } catch (error) {
            captureCommitPhaseError(finishedWork, finishedWork.return, error);
          }
        }
      }
      __name(commitClassCallbacks, "commitClassCallbacks");
      function safelyCallComponentWillUnmount(current, nearestMountedAncestor, instance) {
        instance.props = resolveClassComponentProps(
          current.type,
          current.memoizedProps
        );
        instance.state = current.memoizedState;
        try {
          instance.componentWillUnmount();
        } catch (error) {
          captureCommitPhaseError(current, nearestMountedAncestor, error);
        }
      }
      __name(safelyCallComponentWillUnmount, "safelyCallComponentWillUnmount");
      function safelyAttachRef(current, nearestMountedAncestor) {
        try {
          var ref = current.ref;
          if (null !== ref) {
            switch (current.tag) {
              case 26:
              case 27:
              case 5:
                var instanceToUse = getPublicInstance(current.stateNode);
                break;
              case 30:
                instanceToUse = current.stateNode;
                break;
              default:
                instanceToUse = current.stateNode;
            }
            "function" === typeof ref ? current.refCleanup = ref(instanceToUse) : ref.current = instanceToUse;
          }
        } catch (error) {
          captureCommitPhaseError(current, nearestMountedAncestor, error);
        }
      }
      __name(safelyAttachRef, "safelyAttachRef");
      function safelyDetachRef(current, nearestMountedAncestor) {
        var ref = current.ref, refCleanup = current.refCleanup;
        if (null !== ref)
          if ("function" === typeof refCleanup)
            try {
              refCleanup();
            } catch (error) {
              captureCommitPhaseError(current, nearestMountedAncestor, error);
            } finally {
              current.refCleanup = null, current = current.alternate, null != current && (current.refCleanup = null);
            }
          else if ("function" === typeof ref)
            try {
              ref(null);
            } catch (error$124) {
              captureCommitPhaseError(current, nearestMountedAncestor, error$124);
            }
          else ref.current = null;
      }
      __name(safelyDetachRef, "safelyDetachRef");
      function commitHostMount(finishedWork) {
        var type = finishedWork.type, props = finishedWork.memoizedProps, instance = finishedWork.stateNode;
        try {
          commitMount(instance, type, props, finishedWork);
        } catch (error) {
          captureCommitPhaseError(finishedWork, finishedWork.return, error);
        }
      }
      __name(commitHostMount, "commitHostMount");
      function commitHostUpdate(finishedWork, newProps, oldProps) {
        try {
          commitUpdate(
            finishedWork.stateNode,
            finishedWork.type,
            oldProps,
            newProps,
            finishedWork
          );
        } catch (error) {
          captureCommitPhaseError(finishedWork, finishedWork.return, error);
        }
      }
      __name(commitHostUpdate, "commitHostUpdate");
      function isHostParent(fiber) {
        return 5 === fiber.tag || 3 === fiber.tag || (supportsResources ? 26 === fiber.tag : false) || (supportsSingletons ? 27 === fiber.tag && isSingletonScope(fiber.type) : false) || 4 === fiber.tag;
      }
      __name(isHostParent, "isHostParent");
      function getHostSibling(fiber) {
        a: for (; ; ) {
          for (; null === fiber.sibling; ) {
            if (null === fiber.return || isHostParent(fiber.return)) return null;
            fiber = fiber.return;
          }
          fiber.sibling.return = fiber.return;
          for (fiber = fiber.sibling; 5 !== fiber.tag && 6 !== fiber.tag && 18 !== fiber.tag; ) {
            if (supportsSingletons && 27 === fiber.tag && isSingletonScope(fiber.type))
              continue a;
            if (fiber.flags & 2) continue a;
            if (null === fiber.child || 4 === fiber.tag) continue a;
            else fiber.child.return = fiber, fiber = fiber.child;
          }
          if (!(fiber.flags & 2)) return fiber.stateNode;
        }
      }
      __name(getHostSibling, "getHostSibling");
      function insertOrAppendPlacementNodeIntoContainer(node, before, parent) {
        var tag = node.tag;
        if (5 === tag || 6 === tag)
          node = node.stateNode, before ? insertInContainerBefore(parent, node, before) : appendChildToContainer(parent, node);
        else if (4 !== tag && (supportsSingletons && 27 === tag && isSingletonScope(node.type) && (parent = node.stateNode, before = null), node = node.child, null !== node))
          for (insertOrAppendPlacementNodeIntoContainer(node, before, parent), node = node.sibling; null !== node; )
            insertOrAppendPlacementNodeIntoContainer(node, before, parent), node = node.sibling;
      }
      __name(insertOrAppendPlacementNodeIntoContainer, "insertOrAppendPlacementNodeIntoContainer");
      function insertOrAppendPlacementNode(node, before, parent) {
        var tag = node.tag;
        if (5 === tag || 6 === tag)
          node = node.stateNode, before ? insertBefore(parent, node, before) : appendChild(parent, node);
        else if (4 !== tag && (supportsSingletons && 27 === tag && isSingletonScope(node.type) && (parent = node.stateNode), node = node.child, null !== node))
          for (insertOrAppendPlacementNode(node, before, parent), node = node.sibling; null !== node; )
            insertOrAppendPlacementNode(node, before, parent), node = node.sibling;
      }
      __name(insertOrAppendPlacementNode, "insertOrAppendPlacementNode");
      function commitHostPortalContainerChildren(portal, finishedWork, pendingChildren) {
        portal = portal.containerInfo;
        try {
          replaceContainerChildren(portal, pendingChildren);
        } catch (error) {
          captureCommitPhaseError(finishedWork, finishedWork.return, error);
        }
      }
      __name(commitHostPortalContainerChildren, "commitHostPortalContainerChildren");
      function commitHostSingletonAcquisition(finishedWork) {
        var singleton = finishedWork.stateNode, props = finishedWork.memoizedProps;
        try {
          acquireSingletonInstance(
            finishedWork.type,
            props,
            singleton,
            finishedWork
          );
        } catch (error) {
          captureCommitPhaseError(finishedWork, finishedWork.return, error);
        }
      }
      __name(commitHostSingletonAcquisition, "commitHostSingletonAcquisition");
      function commitBeforeMutationEffects(root, firstChild) {
        prepareForCommit(root.containerInfo);
        for (nextEffect = firstChild; null !== nextEffect; )
          if (root = nextEffect, firstChild = root.child, 0 !== (root.subtreeFlags & 1028) && null !== firstChild)
            firstChild.return = root, nextEffect = firstChild;
          else
            for (; null !== nextEffect; ) {
              root = nextEffect;
              var current = root.alternate;
              firstChild = root.flags;
              switch (root.tag) {
                case 0:
                  if (0 !== (firstChild & 4) && (firstChild = root.updateQueue, firstChild = null !== firstChild ? firstChild.events : null, null !== firstChild))
                    for (var ii = 0; ii < firstChild.length; ii++) {
                      var _eventPayloads$ii = firstChild[ii];
                      _eventPayloads$ii.ref.impl = _eventPayloads$ii.nextImpl;
                    }
                  break;
                case 11:
                case 15:
                  break;
                case 1:
                  if (0 !== (firstChild & 1024) && null !== current) {
                    firstChild = void 0;
                    ii = root;
                    _eventPayloads$ii = current.memoizedProps;
                    current = current.memoizedState;
                    var instance = ii.stateNode;
                    try {
                      var resolvedPrevProps = resolveClassComponentProps(
                        ii.type,
                        _eventPayloads$ii
                      );
                      firstChild = instance.getSnapshotBeforeUpdate(
                        resolvedPrevProps,
                        current
                      );
                      instance.__reactInternalSnapshotBeforeUpdate = firstChild;
                    } catch (error) {
                      captureCommitPhaseError(ii, ii.return, error);
                    }
                  }
                  break;
                case 3:
                  0 !== (firstChild & 1024) && supportsMutation && clearContainer(root.stateNode.containerInfo);
                  break;
                case 5:
                case 26:
                case 27:
                case 6:
                case 4:
                case 17:
                  break;
                default:
                  if (0 !== (firstChild & 1024))
                    throw Error(formatProdErrorMessage(163));
              }
              firstChild = root.sibling;
              if (null !== firstChild) {
                firstChild.return = root.return;
                nextEffect = firstChild;
                break;
              }
              nextEffect = root.return;
            }
      }
      __name(commitBeforeMutationEffects, "commitBeforeMutationEffects");
      function commitLayoutEffectOnFiber(finishedRoot, current, finishedWork) {
        var flags = finishedWork.flags;
        switch (finishedWork.tag) {
          case 0:
          case 11:
          case 15:
            recursivelyTraverseLayoutEffects(finishedRoot, finishedWork);
            flags & 4 && commitHookEffectListMount(5, finishedWork);
            break;
          case 1:
            recursivelyTraverseLayoutEffects(finishedRoot, finishedWork);
            if (flags & 4)
              if (finishedRoot = finishedWork.stateNode, null === current)
                try {
                  finishedRoot.componentDidMount();
                } catch (error) {
                  captureCommitPhaseError(finishedWork, finishedWork.return, error);
                }
              else {
                var prevProps = resolveClassComponentProps(
                  finishedWork.type,
                  current.memoizedProps
                );
                current = current.memoizedState;
                try {
                  finishedRoot.componentDidUpdate(
                    prevProps,
                    current,
                    finishedRoot.__reactInternalSnapshotBeforeUpdate
                  );
                } catch (error$123) {
                  captureCommitPhaseError(
                    finishedWork,
                    finishedWork.return,
                    error$123
                  );
                }
              }
            flags & 64 && commitClassCallbacks(finishedWork);
            flags & 512 && safelyAttachRef(finishedWork, finishedWork.return);
            break;
          case 3:
            recursivelyTraverseLayoutEffects(finishedRoot, finishedWork);
            if (flags & 64 && (flags = finishedWork.updateQueue, null !== flags)) {
              finishedRoot = null;
              if (null !== finishedWork.child)
                switch (finishedWork.child.tag) {
                  case 27:
                  case 5:
                    finishedRoot = getPublicInstance(finishedWork.child.stateNode);
                    break;
                  case 1:
                    finishedRoot = finishedWork.child.stateNode;
                }
              try {
                commitCallbacks(flags, finishedRoot);
              } catch (error) {
                captureCommitPhaseError(finishedWork, finishedWork.return, error);
              }
            }
            break;
          case 27:
            supportsSingletons && null === current && flags & 4 && commitHostSingletonAcquisition(finishedWork);
          case 26:
          case 5:
            recursivelyTraverseLayoutEffects(finishedRoot, finishedWork);
            if (null === current) {
              if (flags & 4) commitHostMount(finishedWork);
              else if (flags & 64) {
                finishedRoot = finishedWork.type;
                current = finishedWork.memoizedProps;
                prevProps = finishedWork.stateNode;
                try {
                  commitHydratedInstance(
                    prevProps,
                    finishedRoot,
                    current,
                    finishedWork
                  );
                } catch (error) {
                  captureCommitPhaseError(finishedWork, finishedWork.return, error);
                }
              }
            }
            flags & 512 && safelyAttachRef(finishedWork, finishedWork.return);
            break;
          case 12:
            recursivelyTraverseLayoutEffects(finishedRoot, finishedWork);
            break;
          case 31:
            recursivelyTraverseLayoutEffects(finishedRoot, finishedWork);
            flags & 4 && commitActivityHydrationCallbacks(finishedRoot, finishedWork);
            break;
          case 13:
            recursivelyTraverseLayoutEffects(finishedRoot, finishedWork);
            flags & 4 && commitSuspenseHydrationCallbacks(finishedRoot, finishedWork);
            flags & 64 && (flags = finishedWork.memoizedState, null !== flags && (flags = flags.dehydrated, null !== flags && (finishedWork = retryDehydratedSuspenseBoundary.bind(
              null,
              finishedWork
            ), registerSuspenseInstanceRetry(flags, finishedWork))));
            break;
          case 22:
            flags = null !== finishedWork.memoizedState || offscreenSubtreeIsHidden;
            if (!flags) {
              current = null !== current && null !== current.memoizedState || offscreenSubtreeWasHidden;
              prevProps = offscreenSubtreeIsHidden;
              var prevOffscreenSubtreeWasHidden = offscreenSubtreeWasHidden;
              offscreenSubtreeIsHidden = flags;
              (offscreenSubtreeWasHidden = current) && !prevOffscreenSubtreeWasHidden ? recursivelyTraverseReappearLayoutEffects(
                finishedRoot,
                finishedWork,
                0 !== (finishedWork.subtreeFlags & 8772)
              ) : recursivelyTraverseLayoutEffects(finishedRoot, finishedWork);
              offscreenSubtreeIsHidden = prevProps;
              offscreenSubtreeWasHidden = prevOffscreenSubtreeWasHidden;
            }
            break;
          case 30:
            break;
          default:
            recursivelyTraverseLayoutEffects(finishedRoot, finishedWork);
        }
      }
      __name(commitLayoutEffectOnFiber, "commitLayoutEffectOnFiber");
      function detachFiberAfterEffects(fiber) {
        var alternate = fiber.alternate;
        null !== alternate && (fiber.alternate = null, detachFiberAfterEffects(alternate));
        fiber.child = null;
        fiber.deletions = null;
        fiber.sibling = null;
        5 === fiber.tag && (alternate = fiber.stateNode, null !== alternate && detachDeletedInstance(alternate));
        fiber.stateNode = null;
        fiber.return = null;
        fiber.dependencies = null;
        fiber.memoizedProps = null;
        fiber.memoizedState = null;
        fiber.pendingProps = null;
        fiber.stateNode = null;
        fiber.updateQueue = null;
      }
      __name(detachFiberAfterEffects, "detachFiberAfterEffects");
      function recursivelyTraverseDeletionEffects(finishedRoot, nearestMountedAncestor, parent) {
        for (parent = parent.child; null !== parent; )
          commitDeletionEffectsOnFiber(
            finishedRoot,
            nearestMountedAncestor,
            parent
          ), parent = parent.sibling;
      }
      __name(recursivelyTraverseDeletionEffects, "recursivelyTraverseDeletionEffects");
      function commitDeletionEffectsOnFiber(finishedRoot, nearestMountedAncestor, deletedFiber) {
        if (injectedHook && "function" === typeof injectedHook.onCommitFiberUnmount)
          try {
            injectedHook.onCommitFiberUnmount(rendererID, deletedFiber);
          } catch (err) {
          }
        switch (deletedFiber.tag) {
          case 26:
            if (supportsResources) {
              offscreenSubtreeWasHidden || safelyDetachRef(deletedFiber, nearestMountedAncestor);
              recursivelyTraverseDeletionEffects(
                finishedRoot,
                nearestMountedAncestor,
                deletedFiber
              );
              deletedFiber.memoizedState ? releaseResource(deletedFiber.memoizedState) : deletedFiber.stateNode && unmountHoistable(deletedFiber.stateNode);
              break;
            }
          case 27:
            if (supportsSingletons) {
              offscreenSubtreeWasHidden || safelyDetachRef(deletedFiber, nearestMountedAncestor);
              var prevHostParent = hostParent, prevHostParentIsContainer = hostParentIsContainer;
              isSingletonScope(deletedFiber.type) && (hostParent = deletedFiber.stateNode, hostParentIsContainer = false);
              recursivelyTraverseDeletionEffects(
                finishedRoot,
                nearestMountedAncestor,
                deletedFiber
              );
              releaseSingletonInstance(deletedFiber.stateNode);
              hostParent = prevHostParent;
              hostParentIsContainer = prevHostParentIsContainer;
              break;
            }
          case 5:
            offscreenSubtreeWasHidden || safelyDetachRef(deletedFiber, nearestMountedAncestor);
          case 6:
            if (supportsMutation) {
              if (prevHostParent = hostParent, prevHostParentIsContainer = hostParentIsContainer, hostParent = null, recursivelyTraverseDeletionEffects(
                finishedRoot,
                nearestMountedAncestor,
                deletedFiber
              ), hostParent = prevHostParent, hostParentIsContainer = prevHostParentIsContainer, null !== hostParent)
                if (hostParentIsContainer)
                  try {
                    removeChildFromContainer(hostParent, deletedFiber.stateNode);
                  } catch (error) {
                    captureCommitPhaseError(
                      deletedFiber,
                      nearestMountedAncestor,
                      error
                    );
                  }
                else
                  try {
                    removeChild(hostParent, deletedFiber.stateNode);
                  } catch (error) {
                    captureCommitPhaseError(
                      deletedFiber,
                      nearestMountedAncestor,
                      error
                    );
                  }
            } else
              recursivelyTraverseDeletionEffects(
                finishedRoot,
                nearestMountedAncestor,
                deletedFiber
              );
            break;
          case 18:
            supportsMutation && null !== hostParent && (hostParentIsContainer ? clearSuspenseBoundaryFromContainer(
              hostParent,
              deletedFiber.stateNode
            ) : clearSuspenseBoundary(hostParent, deletedFiber.stateNode));
            break;
          case 4:
            supportsMutation ? (prevHostParent = hostParent, prevHostParentIsContainer = hostParentIsContainer, hostParent = deletedFiber.stateNode.containerInfo, hostParentIsContainer = true, recursivelyTraverseDeletionEffects(
              finishedRoot,
              nearestMountedAncestor,
              deletedFiber
            ), hostParent = prevHostParent, hostParentIsContainer = prevHostParentIsContainer) : (supportsPersistence && commitHostPortalContainerChildren(
              deletedFiber.stateNode,
              deletedFiber,
              createContainerChildSet()
            ), recursivelyTraverseDeletionEffects(
              finishedRoot,
              nearestMountedAncestor,
              deletedFiber
            ));
            break;
          case 0:
          case 11:
          case 14:
          case 15:
            commitHookEffectListUnmount(2, deletedFiber, nearestMountedAncestor);
            offscreenSubtreeWasHidden || commitHookEffectListUnmount(4, deletedFiber, nearestMountedAncestor);
            recursivelyTraverseDeletionEffects(
              finishedRoot,
              nearestMountedAncestor,
              deletedFiber
            );
            break;
          case 1:
            offscreenSubtreeWasHidden || (safelyDetachRef(deletedFiber, nearestMountedAncestor), prevHostParent = deletedFiber.stateNode, "function" === typeof prevHostParent.componentWillUnmount && safelyCallComponentWillUnmount(
              deletedFiber,
              nearestMountedAncestor,
              prevHostParent
            ));
            recursivelyTraverseDeletionEffects(
              finishedRoot,
              nearestMountedAncestor,
              deletedFiber
            );
            break;
          case 21:
            recursivelyTraverseDeletionEffects(
              finishedRoot,
              nearestMountedAncestor,
              deletedFiber
            );
            break;
          case 22:
            offscreenSubtreeWasHidden = (prevHostParent = offscreenSubtreeWasHidden) || null !== deletedFiber.memoizedState;
            recursivelyTraverseDeletionEffects(
              finishedRoot,
              nearestMountedAncestor,
              deletedFiber
            );
            offscreenSubtreeWasHidden = prevHostParent;
            break;
          default:
            recursivelyTraverseDeletionEffects(
              finishedRoot,
              nearestMountedAncestor,
              deletedFiber
            );
        }
      }
      __name(commitDeletionEffectsOnFiber, "commitDeletionEffectsOnFiber");
      function commitActivityHydrationCallbacks(finishedRoot, finishedWork) {
        if (supportsHydration && null === finishedWork.memoizedState && (finishedRoot = finishedWork.alternate, null !== finishedRoot && (finishedRoot = finishedRoot.memoizedState, null !== finishedRoot))) {
          finishedRoot = finishedRoot.dehydrated;
          try {
            commitHydratedActivityInstance(finishedRoot);
          } catch (error) {
            captureCommitPhaseError(finishedWork, finishedWork.return, error);
          }
        }
      }
      __name(commitActivityHydrationCallbacks, "commitActivityHydrationCallbacks");
      function commitSuspenseHydrationCallbacks(finishedRoot, finishedWork) {
        if (supportsHydration && null === finishedWork.memoizedState && (finishedRoot = finishedWork.alternate, null !== finishedRoot && (finishedRoot = finishedRoot.memoizedState, null !== finishedRoot && (finishedRoot = finishedRoot.dehydrated, null !== finishedRoot))))
          try {
            commitHydratedSuspenseInstance(finishedRoot);
          } catch (error) {
            captureCommitPhaseError(finishedWork, finishedWork.return, error);
          }
      }
      __name(commitSuspenseHydrationCallbacks, "commitSuspenseHydrationCallbacks");
      function getRetryCache(finishedWork) {
        switch (finishedWork.tag) {
          case 31:
          case 13:
          case 19:
            var retryCache = finishedWork.stateNode;
            null === retryCache && (retryCache = finishedWork.stateNode = new PossiblyWeakSet());
            return retryCache;
          case 22:
            return finishedWork = finishedWork.stateNode, retryCache = finishedWork._retryCache, null === retryCache && (retryCache = finishedWork._retryCache = new PossiblyWeakSet()), retryCache;
          default:
            throw Error(formatProdErrorMessage(435, finishedWork.tag));
        }
      }
      __name(getRetryCache, "getRetryCache");
      function attachSuspenseRetryListeners(finishedWork, wakeables) {
        var retryCache = getRetryCache(finishedWork);
        wakeables.forEach(function(wakeable) {
          if (!retryCache.has(wakeable)) {
            retryCache.add(wakeable);
            var retry = resolveRetryWakeable.bind(null, finishedWork, wakeable);
            wakeable.then(retry, retry);
          }
        });
      }
      __name(attachSuspenseRetryListeners, "attachSuspenseRetryListeners");
      function recursivelyTraverseMutationEffects(root$jscomp$0, parentFiber) {
        var deletions = parentFiber.deletions;
        if (null !== deletions)
          for (var i = 0; i < deletions.length; i++) {
            var childToDelete = deletions[i], root = root$jscomp$0, returnFiber = parentFiber;
            if (supportsMutation) {
              var parent = returnFiber;
              a: for (; null !== parent; ) {
                switch (parent.tag) {
                  case 27:
                    if (supportsSingletons) {
                      if (isSingletonScope(parent.type)) {
                        hostParent = parent.stateNode;
                        hostParentIsContainer = false;
                        break a;
                      }
                      break;
                    }
                  case 5:
                    hostParent = parent.stateNode;
                    hostParentIsContainer = false;
                    break a;
                  case 3:
                  case 4:
                    hostParent = parent.stateNode.containerInfo;
                    hostParentIsContainer = true;
                    break a;
                }
                parent = parent.return;
              }
              if (null === hostParent) throw Error(formatProdErrorMessage(160));
              commitDeletionEffectsOnFiber(root, returnFiber, childToDelete);
              hostParent = null;
              hostParentIsContainer = false;
            } else commitDeletionEffectsOnFiber(root, returnFiber, childToDelete);
            root = childToDelete.alternate;
            null !== root && (root.return = null);
            childToDelete.return = null;
          }
        if (parentFiber.subtreeFlags & 13886)
          for (parentFiber = parentFiber.child; null !== parentFiber; )
            commitMutationEffectsOnFiber(parentFiber, root$jscomp$0), parentFiber = parentFiber.sibling;
      }
      __name(recursivelyTraverseMutationEffects, "recursivelyTraverseMutationEffects");
      function commitMutationEffectsOnFiber(finishedWork, root) {
        var current = finishedWork.alternate, flags = finishedWork.flags;
        switch (finishedWork.tag) {
          case 0:
          case 11:
          case 14:
          case 15:
            recursivelyTraverseMutationEffects(root, finishedWork);
            commitReconciliationEffects(finishedWork);
            flags & 4 && (commitHookEffectListUnmount(3, finishedWork, finishedWork.return), commitHookEffectListMount(3, finishedWork), commitHookEffectListUnmount(5, finishedWork, finishedWork.return));
            break;
          case 1:
            recursivelyTraverseMutationEffects(root, finishedWork);
            commitReconciliationEffects(finishedWork);
            flags & 512 && (offscreenSubtreeWasHidden || null === current || safelyDetachRef(current, current.return));
            flags & 64 && offscreenSubtreeIsHidden && (finishedWork = finishedWork.updateQueue, null !== finishedWork && (flags = finishedWork.callbacks, null !== flags && (current = finishedWork.shared.hiddenCallbacks, finishedWork.shared.hiddenCallbacks = null === current ? flags : current.concat(flags))));
            break;
          case 26:
            if (supportsResources) {
              var hoistableRoot = currentHoistableRoot;
              recursivelyTraverseMutationEffects(root, finishedWork);
              commitReconciliationEffects(finishedWork);
              flags & 512 && (offscreenSubtreeWasHidden || null === current || safelyDetachRef(current, current.return));
              if (flags & 4) {
                flags = null !== current ? current.memoizedState : null;
                var newResource = finishedWork.memoizedState;
                null === current ? null === newResource ? null === finishedWork.stateNode ? finishedWork.stateNode = hydrateHoistable(
                  hoistableRoot,
                  finishedWork.type,
                  finishedWork.memoizedProps,
                  finishedWork
                ) : mountHoistable(
                  hoistableRoot,
                  finishedWork.type,
                  finishedWork.stateNode
                ) : finishedWork.stateNode = acquireResource(
                  hoistableRoot,
                  newResource,
                  finishedWork.memoizedProps
                ) : flags !== newResource ? (null === flags ? null !== current.stateNode && unmountHoistable(current.stateNode) : releaseResource(flags), null === newResource ? mountHoistable(
                  hoistableRoot,
                  finishedWork.type,
                  finishedWork.stateNode
                ) : acquireResource(
                  hoistableRoot,
                  newResource,
                  finishedWork.memoizedProps
                )) : null === newResource && null !== finishedWork.stateNode && commitHostUpdate(
                  finishedWork,
                  finishedWork.memoizedProps,
                  current.memoizedProps
                );
              }
              break;
            }
          case 27:
            if (supportsSingletons) {
              recursivelyTraverseMutationEffects(root, finishedWork);
              commitReconciliationEffects(finishedWork);
              flags & 512 && (offscreenSubtreeWasHidden || null === current || safelyDetachRef(current, current.return));
              null !== current && flags & 4 && commitHostUpdate(
                finishedWork,
                finishedWork.memoizedProps,
                current.memoizedProps
              );
              break;
            }
          case 5:
            recursivelyTraverseMutationEffects(root, finishedWork);
            commitReconciliationEffects(finishedWork);
            flags & 512 && (offscreenSubtreeWasHidden || null === current || safelyDetachRef(current, current.return));
            if (supportsMutation) {
              if (finishedWork.flags & 32) {
                hoistableRoot = finishedWork.stateNode;
                try {
                  resetTextContent(hoistableRoot);
                } catch (error) {
                  captureCommitPhaseError(finishedWork, finishedWork.return, error);
                }
              }
              flags & 4 && null != finishedWork.stateNode && (hoistableRoot = finishedWork.memoizedProps, commitHostUpdate(
                finishedWork,
                hoistableRoot,
                null !== current ? current.memoizedProps : hoistableRoot
              ));
              flags & 1024 && (needsFormReset = true);
            } else
              supportsPersistence && null !== finishedWork.alternate && (finishedWork.alternate.stateNode = finishedWork.stateNode);
            break;
          case 6:
            recursivelyTraverseMutationEffects(root, finishedWork);
            commitReconciliationEffects(finishedWork);
            if (flags & 4 && supportsMutation) {
              if (null === finishedWork.stateNode)
                throw Error(formatProdErrorMessage(162));
              flags = finishedWork.memoizedProps;
              current = null !== current ? current.memoizedProps : flags;
              hoistableRoot = finishedWork.stateNode;
              try {
                commitTextUpdate(hoistableRoot, current, flags);
              } catch (error) {
                captureCommitPhaseError(finishedWork, finishedWork.return, error);
              }
            }
            break;
          case 3:
            supportsResources ? (prepareToCommitHoistables(), hoistableRoot = currentHoistableRoot, currentHoistableRoot = getHoistableRoot(root.containerInfo), recursivelyTraverseMutationEffects(root, finishedWork), currentHoistableRoot = hoistableRoot) : recursivelyTraverseMutationEffects(root, finishedWork);
            commitReconciliationEffects(finishedWork);
            if (flags & 4) {
              if (supportsMutation && supportsHydration && null !== current && current.memoizedState.isDehydrated)
                try {
                  commitHydratedContainer(root.containerInfo);
                } catch (error) {
                  captureCommitPhaseError(finishedWork, finishedWork.return, error);
                }
              if (supportsPersistence) {
                flags = root.containerInfo;
                current = root.pendingChildren;
                try {
                  replaceContainerChildren(flags, current);
                } catch (error) {
                  captureCommitPhaseError(finishedWork, finishedWork.return, error);
                }
              }
            }
            needsFormReset && (needsFormReset = false, recursivelyResetForms(finishedWork));
            break;
          case 4:
            supportsResources ? (current = currentHoistableRoot, currentHoistableRoot = getHoistableRoot(
              finishedWork.stateNode.containerInfo
            ), recursivelyTraverseMutationEffects(root, finishedWork), commitReconciliationEffects(finishedWork), currentHoistableRoot = current) : (recursivelyTraverseMutationEffects(root, finishedWork), commitReconciliationEffects(finishedWork));
            flags & 4 && supportsPersistence && commitHostPortalContainerChildren(
              finishedWork.stateNode,
              finishedWork,
              finishedWork.stateNode.pendingChildren
            );
            break;
          case 12:
            recursivelyTraverseMutationEffects(root, finishedWork);
            commitReconciliationEffects(finishedWork);
            break;
          case 31:
            recursivelyTraverseMutationEffects(root, finishedWork);
            commitReconciliationEffects(finishedWork);
            flags & 4 && (flags = finishedWork.updateQueue, null !== flags && (finishedWork.updateQueue = null, attachSuspenseRetryListeners(finishedWork, flags)));
            break;
          case 13:
            recursivelyTraverseMutationEffects(root, finishedWork);
            commitReconciliationEffects(finishedWork);
            finishedWork.child.flags & 8192 && null !== finishedWork.memoizedState !== (null !== current && null !== current.memoizedState) && (globalMostRecentFallbackTime = now());
            flags & 4 && (flags = finishedWork.updateQueue, null !== flags && (finishedWork.updateQueue = null, attachSuspenseRetryListeners(finishedWork, flags)));
            break;
          case 22:
            hoistableRoot = null !== finishedWork.memoizedState;
            var wasHidden = null !== current && null !== current.memoizedState, prevOffscreenSubtreeIsHidden = offscreenSubtreeIsHidden, prevOffscreenSubtreeWasHidden = offscreenSubtreeWasHidden;
            offscreenSubtreeIsHidden = prevOffscreenSubtreeIsHidden || hoistableRoot;
            offscreenSubtreeWasHidden = prevOffscreenSubtreeWasHidden || wasHidden;
            recursivelyTraverseMutationEffects(root, finishedWork);
            offscreenSubtreeWasHidden = prevOffscreenSubtreeWasHidden;
            offscreenSubtreeIsHidden = prevOffscreenSubtreeIsHidden;
            commitReconciliationEffects(finishedWork);
            if (flags & 8192 && (root = finishedWork.stateNode, root._visibility = hoistableRoot ? root._visibility & -2 : root._visibility | 1, hoistableRoot && (null === current || wasHidden || offscreenSubtreeIsHidden || offscreenSubtreeWasHidden || recursivelyTraverseDisappearLayoutEffects(finishedWork)), supportsMutation)) {
              a: if (current = null, supportsMutation)
                for (root = finishedWork; ; ) {
                  if (5 === root.tag || supportsResources && 26 === root.tag) {
                    if (null === current) {
                      wasHidden = current = root;
                      try {
                        newResource = wasHidden.stateNode, hoistableRoot ? hideInstance(newResource) : unhideInstance(
                          wasHidden.stateNode,
                          wasHidden.memoizedProps
                        );
                      } catch (error) {
                        captureCommitPhaseError(wasHidden, wasHidden.return, error);
                      }
                    }
                  } else if (6 === root.tag) {
                    if (null === current) {
                      wasHidden = root;
                      try {
                        var instance = wasHidden.stateNode;
                        hoistableRoot ? hideTextInstance(instance) : unhideTextInstance(instance, wasHidden.memoizedProps);
                      } catch (error) {
                        captureCommitPhaseError(wasHidden, wasHidden.return, error);
                      }
                    }
                  } else if (18 === root.tag) {
                    if (null === current) {
                      wasHidden = root;
                      try {
                        var instance$jscomp$0 = wasHidden.stateNode;
                        hoistableRoot ? hideDehydratedBoundary(instance$jscomp$0) : unhideDehydratedBoundary(wasHidden.stateNode);
                      } catch (error) {
                        captureCommitPhaseError(wasHidden, wasHidden.return, error);
                      }
                    }
                  } else if ((22 !== root.tag && 23 !== root.tag || null === root.memoizedState || root === finishedWork) && null !== root.child) {
                    root.child.return = root;
                    root = root.child;
                    continue;
                  }
                  if (root === finishedWork) break a;
                  for (; null === root.sibling; ) {
                    if (null === root.return || root.return === finishedWork)
                      break a;
                    current === root && (current = null);
                    root = root.return;
                  }
                  current === root && (current = null);
                  root.sibling.return = root.return;
                  root = root.sibling;
                }
            }
            flags & 4 && (flags = finishedWork.updateQueue, null !== flags && (current = flags.retryQueue, null !== current && (flags.retryQueue = null, attachSuspenseRetryListeners(finishedWork, current))));
            break;
          case 19:
            recursivelyTraverseMutationEffects(root, finishedWork);
            commitReconciliationEffects(finishedWork);
            flags & 4 && (flags = finishedWork.updateQueue, null !== flags && (finishedWork.updateQueue = null, attachSuspenseRetryListeners(finishedWork, flags)));
            break;
          case 30:
            break;
          case 21:
            break;
          default:
            recursivelyTraverseMutationEffects(root, finishedWork), commitReconciliationEffects(finishedWork);
        }
      }
      __name(commitMutationEffectsOnFiber, "commitMutationEffectsOnFiber");
      function commitReconciliationEffects(finishedWork) {
        var flags = finishedWork.flags;
        if (flags & 2) {
          try {
            for (var hostParentFiber, parentFiber = finishedWork.return; null !== parentFiber; ) {
              if (isHostParent(parentFiber)) {
                hostParentFiber = parentFiber;
                break;
              }
              parentFiber = parentFiber.return;
            }
            if (supportsMutation) {
              if (null == hostParentFiber) throw Error(formatProdErrorMessage(160));
              switch (hostParentFiber.tag) {
                case 27:
                  if (supportsSingletons) {
                    var parent = hostParentFiber.stateNode, before = getHostSibling(finishedWork);
                    insertOrAppendPlacementNode(finishedWork, before, parent);
                    break;
                  }
                case 5:
                  var parent$125 = hostParentFiber.stateNode;
                  hostParentFiber.flags & 32 && (resetTextContent(parent$125), hostParentFiber.flags &= -33);
                  var before$126 = getHostSibling(finishedWork);
                  insertOrAppendPlacementNode(finishedWork, before$126, parent$125);
                  break;
                case 3:
                case 4:
                  var parent$127 = hostParentFiber.stateNode.containerInfo, before$128 = getHostSibling(finishedWork);
                  insertOrAppendPlacementNodeIntoContainer(
                    finishedWork,
                    before$128,
                    parent$127
                  );
                  break;
                default:
                  throw Error(formatProdErrorMessage(161));
              }
            }
          } catch (error) {
            captureCommitPhaseError(finishedWork, finishedWork.return, error);
          }
          finishedWork.flags &= -3;
        }
        flags & 4096 && (finishedWork.flags &= -4097);
      }
      __name(commitReconciliationEffects, "commitReconciliationEffects");
      function recursivelyResetForms(parentFiber) {
        if (parentFiber.subtreeFlags & 1024)
          for (parentFiber = parentFiber.child; null !== parentFiber; ) {
            var fiber = parentFiber;
            recursivelyResetForms(fiber);
            5 === fiber.tag && fiber.flags & 1024 && resetFormInstance(fiber.stateNode);
            parentFiber = parentFiber.sibling;
          }
      }
      __name(recursivelyResetForms, "recursivelyResetForms");
      function recursivelyTraverseLayoutEffects(root, parentFiber) {
        if (parentFiber.subtreeFlags & 8772)
          for (parentFiber = parentFiber.child; null !== parentFiber; )
            commitLayoutEffectOnFiber(root, parentFiber.alternate, parentFiber), parentFiber = parentFiber.sibling;
      }
      __name(recursivelyTraverseLayoutEffects, "recursivelyTraverseLayoutEffects");
      function recursivelyTraverseDisappearLayoutEffects(parentFiber) {
        for (parentFiber = parentFiber.child; null !== parentFiber; ) {
          var finishedWork = parentFiber;
          switch (finishedWork.tag) {
            case 0:
            case 11:
            case 14:
            case 15:
              commitHookEffectListUnmount(4, finishedWork, finishedWork.return);
              recursivelyTraverseDisappearLayoutEffects(finishedWork);
              break;
            case 1:
              safelyDetachRef(finishedWork, finishedWork.return);
              var instance = finishedWork.stateNode;
              "function" === typeof instance.componentWillUnmount && safelyCallComponentWillUnmount(
                finishedWork,
                finishedWork.return,
                instance
              );
              recursivelyTraverseDisappearLayoutEffects(finishedWork);
              break;
            case 27:
              supportsSingletons && releaseSingletonInstance(finishedWork.stateNode);
            case 26:
            case 5:
              safelyDetachRef(finishedWork, finishedWork.return);
              recursivelyTraverseDisappearLayoutEffects(finishedWork);
              break;
            case 22:
              null === finishedWork.memoizedState && recursivelyTraverseDisappearLayoutEffects(finishedWork);
              break;
            case 30:
              recursivelyTraverseDisappearLayoutEffects(finishedWork);
              break;
            default:
              recursivelyTraverseDisappearLayoutEffects(finishedWork);
          }
          parentFiber = parentFiber.sibling;
        }
      }
      __name(recursivelyTraverseDisappearLayoutEffects, "recursivelyTraverseDisappearLayoutEffects");
      function recursivelyTraverseReappearLayoutEffects(finishedRoot$jscomp$0, parentFiber, includeWorkInProgressEffects) {
        includeWorkInProgressEffects = includeWorkInProgressEffects && 0 !== (parentFiber.subtreeFlags & 8772);
        for (parentFiber = parentFiber.child; null !== parentFiber; ) {
          var current = parentFiber.alternate, finishedRoot = finishedRoot$jscomp$0, finishedWork = parentFiber, flags = finishedWork.flags;
          switch (finishedWork.tag) {
            case 0:
            case 11:
            case 15:
              recursivelyTraverseReappearLayoutEffects(
                finishedRoot,
                finishedWork,
                includeWorkInProgressEffects
              );
              commitHookEffectListMount(4, finishedWork);
              break;
            case 1:
              recursivelyTraverseReappearLayoutEffects(
                finishedRoot,
                finishedWork,
                includeWorkInProgressEffects
              );
              current = finishedWork;
              finishedRoot = current.stateNode;
              if ("function" === typeof finishedRoot.componentDidMount)
                try {
                  finishedRoot.componentDidMount();
                } catch (error) {
                  captureCommitPhaseError(current, current.return, error);
                }
              current = finishedWork;
              finishedRoot = current.updateQueue;
              if (null !== finishedRoot) {
                var instance = current.stateNode;
                try {
                  var hiddenCallbacks = finishedRoot.shared.hiddenCallbacks;
                  if (null !== hiddenCallbacks)
                    for (finishedRoot.shared.hiddenCallbacks = null, finishedRoot = 0; finishedRoot < hiddenCallbacks.length; finishedRoot++)
                      callCallback(hiddenCallbacks[finishedRoot], instance);
                } catch (error) {
                  captureCommitPhaseError(current, current.return, error);
                }
              }
              includeWorkInProgressEffects && flags & 64 && commitClassCallbacks(finishedWork);
              safelyAttachRef(finishedWork, finishedWork.return);
              break;
            case 27:
              supportsSingletons && commitHostSingletonAcquisition(finishedWork);
            case 26:
            case 5:
              recursivelyTraverseReappearLayoutEffects(
                finishedRoot,
                finishedWork,
                includeWorkInProgressEffects
              );
              includeWorkInProgressEffects && null === current && flags & 4 && commitHostMount(finishedWork);
              safelyAttachRef(finishedWork, finishedWork.return);
              break;
            case 12:
              recursivelyTraverseReappearLayoutEffects(
                finishedRoot,
                finishedWork,
                includeWorkInProgressEffects
              );
              break;
            case 31:
              recursivelyTraverseReappearLayoutEffects(
                finishedRoot,
                finishedWork,
                includeWorkInProgressEffects
              );
              includeWorkInProgressEffects && flags & 4 && commitActivityHydrationCallbacks(finishedRoot, finishedWork);
              break;
            case 13:
              recursivelyTraverseReappearLayoutEffects(
                finishedRoot,
                finishedWork,
                includeWorkInProgressEffects
              );
              includeWorkInProgressEffects && flags & 4 && commitSuspenseHydrationCallbacks(finishedRoot, finishedWork);
              break;
            case 22:
              null === finishedWork.memoizedState && recursivelyTraverseReappearLayoutEffects(
                finishedRoot,
                finishedWork,
                includeWorkInProgressEffects
              );
              safelyAttachRef(finishedWork, finishedWork.return);
              break;
            case 30:
              break;
            default:
              recursivelyTraverseReappearLayoutEffects(
                finishedRoot,
                finishedWork,
                includeWorkInProgressEffects
              );
          }
          parentFiber = parentFiber.sibling;
        }
      }
      __name(recursivelyTraverseReappearLayoutEffects, "recursivelyTraverseReappearLayoutEffects");
      function commitOffscreenPassiveMountEffects(current, finishedWork) {
        var previousCache = null;
        null !== current && null !== current.memoizedState && null !== current.memoizedState.cachePool && (previousCache = current.memoizedState.cachePool.pool);
        current = null;
        null !== finishedWork.memoizedState && null !== finishedWork.memoizedState.cachePool && (current = finishedWork.memoizedState.cachePool.pool);
        current !== previousCache && (null != current && current.refCount++, null != previousCache && releaseCache(previousCache));
      }
      __name(commitOffscreenPassiveMountEffects, "commitOffscreenPassiveMountEffects");
      function commitCachePassiveMountEffect(current, finishedWork) {
        current = null;
        null !== finishedWork.alternate && (current = finishedWork.alternate.memoizedState.cache);
        finishedWork = finishedWork.memoizedState.cache;
        finishedWork !== current && (finishedWork.refCount++, null != current && releaseCache(current));
      }
      __name(commitCachePassiveMountEffect, "commitCachePassiveMountEffect");
      function recursivelyTraversePassiveMountEffects(root, parentFiber, committedLanes, committedTransitions) {
        if (parentFiber.subtreeFlags & 10256)
          for (parentFiber = parentFiber.child; null !== parentFiber; )
            commitPassiveMountOnFiber(
              root,
              parentFiber,
              committedLanes,
              committedTransitions
            ), parentFiber = parentFiber.sibling;
      }
      __name(recursivelyTraversePassiveMountEffects, "recursivelyTraversePassiveMountEffects");
      function commitPassiveMountOnFiber(finishedRoot, finishedWork, committedLanes, committedTransitions) {
        var flags = finishedWork.flags;
        switch (finishedWork.tag) {
          case 0:
          case 11:
          case 15:
            recursivelyTraversePassiveMountEffects(
              finishedRoot,
              finishedWork,
              committedLanes,
              committedTransitions
            );
            flags & 2048 && commitHookEffectListMount(9, finishedWork);
            break;
          case 1:
            recursivelyTraversePassiveMountEffects(
              finishedRoot,
              finishedWork,
              committedLanes,
              committedTransitions
            );
            break;
          case 3:
            recursivelyTraversePassiveMountEffects(
              finishedRoot,
              finishedWork,
              committedLanes,
              committedTransitions
            );
            flags & 2048 && (finishedRoot = null, null !== finishedWork.alternate && (finishedRoot = finishedWork.alternate.memoizedState.cache), finishedWork = finishedWork.memoizedState.cache, finishedWork !== finishedRoot && (finishedWork.refCount++, null != finishedRoot && releaseCache(finishedRoot)));
            break;
          case 12:
            if (flags & 2048) {
              recursivelyTraversePassiveMountEffects(
                finishedRoot,
                finishedWork,
                committedLanes,
                committedTransitions
              );
              finishedRoot = finishedWork.stateNode;
              try {
                var _finishedWork$memoize2 = finishedWork.memoizedProps, id = _finishedWork$memoize2.id, onPostCommit = _finishedWork$memoize2.onPostCommit;
                "function" === typeof onPostCommit && onPostCommit(
                  id,
                  null === finishedWork.alternate ? "mount" : "update",
                  finishedRoot.passiveEffectDuration,
                  -0
                );
              } catch (error) {
                captureCommitPhaseError(finishedWork, finishedWork.return, error);
              }
            } else
              recursivelyTraversePassiveMountEffects(
                finishedRoot,
                finishedWork,
                committedLanes,
                committedTransitions
              );
            break;
          case 31:
            recursivelyTraversePassiveMountEffects(
              finishedRoot,
              finishedWork,
              committedLanes,
              committedTransitions
            );
            break;
          case 13:
            recursivelyTraversePassiveMountEffects(
              finishedRoot,
              finishedWork,
              committedLanes,
              committedTransitions
            );
            break;
          case 23:
            break;
          case 22:
            _finishedWork$memoize2 = finishedWork.stateNode;
            id = finishedWork.alternate;
            null !== finishedWork.memoizedState ? _finishedWork$memoize2._visibility & 2 ? recursivelyTraversePassiveMountEffects(
              finishedRoot,
              finishedWork,
              committedLanes,
              committedTransitions
            ) : recursivelyTraverseAtomicPassiveEffects(
              finishedRoot,
              finishedWork
            ) : _finishedWork$memoize2._visibility & 2 ? recursivelyTraversePassiveMountEffects(
              finishedRoot,
              finishedWork,
              committedLanes,
              committedTransitions
            ) : (_finishedWork$memoize2._visibility |= 2, recursivelyTraverseReconnectPassiveEffects(
              finishedRoot,
              finishedWork,
              committedLanes,
              committedTransitions,
              0 !== (finishedWork.subtreeFlags & 10256) || false
            ));
            flags & 2048 && commitOffscreenPassiveMountEffects(id, finishedWork);
            break;
          case 24:
            recursivelyTraversePassiveMountEffects(
              finishedRoot,
              finishedWork,
              committedLanes,
              committedTransitions
            );
            flags & 2048 && commitCachePassiveMountEffect(finishedWork.alternate, finishedWork);
            break;
          default:
            recursivelyTraversePassiveMountEffects(
              finishedRoot,
              finishedWork,
              committedLanes,
              committedTransitions
            );
        }
      }
      __name(commitPassiveMountOnFiber, "commitPassiveMountOnFiber");
      function recursivelyTraverseReconnectPassiveEffects(finishedRoot$jscomp$0, parentFiber, committedLanes$jscomp$0, committedTransitions$jscomp$0, includeWorkInProgressEffects) {
        includeWorkInProgressEffects = includeWorkInProgressEffects && (0 !== (parentFiber.subtreeFlags & 10256) || false);
        for (parentFiber = parentFiber.child; null !== parentFiber; ) {
          var finishedRoot = finishedRoot$jscomp$0, finishedWork = parentFiber, committedLanes = committedLanes$jscomp$0, committedTransitions = committedTransitions$jscomp$0, flags = finishedWork.flags;
          switch (finishedWork.tag) {
            case 0:
            case 11:
            case 15:
              recursivelyTraverseReconnectPassiveEffects(
                finishedRoot,
                finishedWork,
                committedLanes,
                committedTransitions,
                includeWorkInProgressEffects
              );
              commitHookEffectListMount(8, finishedWork);
              break;
            case 23:
              break;
            case 22:
              var instance = finishedWork.stateNode;
              null !== finishedWork.memoizedState ? instance._visibility & 2 ? recursivelyTraverseReconnectPassiveEffects(
                finishedRoot,
                finishedWork,
                committedLanes,
                committedTransitions,
                includeWorkInProgressEffects
              ) : recursivelyTraverseAtomicPassiveEffects(
                finishedRoot,
                finishedWork
              ) : (instance._visibility |= 2, recursivelyTraverseReconnectPassiveEffects(
                finishedRoot,
                finishedWork,
                committedLanes,
                committedTransitions,
                includeWorkInProgressEffects
              ));
              includeWorkInProgressEffects && flags & 2048 && commitOffscreenPassiveMountEffects(
                finishedWork.alternate,
                finishedWork
              );
              break;
            case 24:
              recursivelyTraverseReconnectPassiveEffects(
                finishedRoot,
                finishedWork,
                committedLanes,
                committedTransitions,
                includeWorkInProgressEffects
              );
              includeWorkInProgressEffects && flags & 2048 && commitCachePassiveMountEffect(finishedWork.alternate, finishedWork);
              break;
            default:
              recursivelyTraverseReconnectPassiveEffects(
                finishedRoot,
                finishedWork,
                committedLanes,
                committedTransitions,
                includeWorkInProgressEffects
              );
          }
          parentFiber = parentFiber.sibling;
        }
      }
      __name(recursivelyTraverseReconnectPassiveEffects, "recursivelyTraverseReconnectPassiveEffects");
      function recursivelyTraverseAtomicPassiveEffects(finishedRoot$jscomp$0, parentFiber) {
        if (parentFiber.subtreeFlags & 10256)
          for (parentFiber = parentFiber.child; null !== parentFiber; ) {
            var finishedRoot = finishedRoot$jscomp$0, finishedWork = parentFiber, flags = finishedWork.flags;
            switch (finishedWork.tag) {
              case 22:
                recursivelyTraverseAtomicPassiveEffects(finishedRoot, finishedWork);
                flags & 2048 && commitOffscreenPassiveMountEffects(
                  finishedWork.alternate,
                  finishedWork
                );
                break;
              case 24:
                recursivelyTraverseAtomicPassiveEffects(finishedRoot, finishedWork);
                flags & 2048 && commitCachePassiveMountEffect(
                  finishedWork.alternate,
                  finishedWork
                );
                break;
              default:
                recursivelyTraverseAtomicPassiveEffects(finishedRoot, finishedWork);
            }
            parentFiber = parentFiber.sibling;
          }
      }
      __name(recursivelyTraverseAtomicPassiveEffects, "recursivelyTraverseAtomicPassiveEffects");
      function recursivelyAccumulateSuspenseyCommit(parentFiber, committedLanes, suspendedState) {
        if (parentFiber.subtreeFlags & suspenseyCommitFlag)
          for (parentFiber = parentFiber.child; null !== parentFiber; )
            accumulateSuspenseyCommitOnFiber(
              parentFiber,
              committedLanes,
              suspendedState
            ), parentFiber = parentFiber.sibling;
      }
      __name(recursivelyAccumulateSuspenseyCommit, "recursivelyAccumulateSuspenseyCommit");
      function accumulateSuspenseyCommitOnFiber(fiber, committedLanes, suspendedState) {
        switch (fiber.tag) {
          case 26:
            recursivelyAccumulateSuspenseyCommit(
              fiber,
              committedLanes,
              suspendedState
            );
            if (fiber.flags & suspenseyCommitFlag)
              if (null !== fiber.memoizedState)
                suspendResource(
                  suspendedState,
                  currentHoistableRoot,
                  fiber.memoizedState,
                  fiber.memoizedProps
                );
              else {
                var instance = fiber.stateNode, type = fiber.type;
                fiber = fiber.memoizedProps;
                ((committedLanes & 335544128) === committedLanes || maySuspendCommitInSyncRender(type, fiber)) && suspendInstance(suspendedState, instance, type, fiber);
              }
            break;
          case 5:
            recursivelyAccumulateSuspenseyCommit(
              fiber,
              committedLanes,
              suspendedState
            );
            fiber.flags & suspenseyCommitFlag && (instance = fiber.stateNode, type = fiber.type, fiber = fiber.memoizedProps, ((committedLanes & 335544128) === committedLanes || maySuspendCommitInSyncRender(type, fiber)) && suspendInstance(suspendedState, instance, type, fiber));
            break;
          case 3:
          case 4:
            supportsResources ? (instance = currentHoistableRoot, currentHoistableRoot = getHoistableRoot(
              fiber.stateNode.containerInfo
            ), recursivelyAccumulateSuspenseyCommit(
              fiber,
              committedLanes,
              suspendedState
            ), currentHoistableRoot = instance) : recursivelyAccumulateSuspenseyCommit(
              fiber,
              committedLanes,
              suspendedState
            );
            break;
          case 22:
            null === fiber.memoizedState && (instance = fiber.alternate, null !== instance && null !== instance.memoizedState ? (instance = suspenseyCommitFlag, suspenseyCommitFlag = 16777216, recursivelyAccumulateSuspenseyCommit(
              fiber,
              committedLanes,
              suspendedState
            ), suspenseyCommitFlag = instance) : recursivelyAccumulateSuspenseyCommit(
              fiber,
              committedLanes,
              suspendedState
            ));
            break;
          default:
            recursivelyAccumulateSuspenseyCommit(
              fiber,
              committedLanes,
              suspendedState
            );
        }
      }
      __name(accumulateSuspenseyCommitOnFiber, "accumulateSuspenseyCommitOnFiber");
      function detachAlternateSiblings(parentFiber) {
        var previousFiber = parentFiber.alternate;
        if (null !== previousFiber && (parentFiber = previousFiber.child, null !== parentFiber)) {
          previousFiber.child = null;
          do
            previousFiber = parentFiber.sibling, parentFiber.sibling = null, parentFiber = previousFiber;
          while (null !== parentFiber);
        }
      }
      __name(detachAlternateSiblings, "detachAlternateSiblings");
      function recursivelyTraversePassiveUnmountEffects(parentFiber) {
        var deletions = parentFiber.deletions;
        if (0 !== (parentFiber.flags & 16)) {
          if (null !== deletions)
            for (var i = 0; i < deletions.length; i++) {
              var childToDelete = deletions[i];
              nextEffect = childToDelete;
              commitPassiveUnmountEffectsInsideOfDeletedTree_begin(
                childToDelete,
                parentFiber
              );
            }
          detachAlternateSiblings(parentFiber);
        }
        if (parentFiber.subtreeFlags & 10256)
          for (parentFiber = parentFiber.child; null !== parentFiber; )
            commitPassiveUnmountOnFiber(parentFiber), parentFiber = parentFiber.sibling;
      }
      __name(recursivelyTraversePassiveUnmountEffects, "recursivelyTraversePassiveUnmountEffects");
      function commitPassiveUnmountOnFiber(finishedWork) {
        switch (finishedWork.tag) {
          case 0:
          case 11:
          case 15:
            recursivelyTraversePassiveUnmountEffects(finishedWork);
            finishedWork.flags & 2048 && commitHookEffectListUnmount(9, finishedWork, finishedWork.return);
            break;
          case 3:
            recursivelyTraversePassiveUnmountEffects(finishedWork);
            break;
          case 12:
            recursivelyTraversePassiveUnmountEffects(finishedWork);
            break;
          case 22:
            var instance = finishedWork.stateNode;
            null !== finishedWork.memoizedState && instance._visibility & 2 && (null === finishedWork.return || 13 !== finishedWork.return.tag) ? (instance._visibility &= -3, recursivelyTraverseDisconnectPassiveEffects(finishedWork)) : recursivelyTraversePassiveUnmountEffects(finishedWork);
            break;
          default:
            recursivelyTraversePassiveUnmountEffects(finishedWork);
        }
      }
      __name(commitPassiveUnmountOnFiber, "commitPassiveUnmountOnFiber");
      function recursivelyTraverseDisconnectPassiveEffects(parentFiber) {
        var deletions = parentFiber.deletions;
        if (0 !== (parentFiber.flags & 16)) {
          if (null !== deletions)
            for (var i = 0; i < deletions.length; i++) {
              var childToDelete = deletions[i];
              nextEffect = childToDelete;
              commitPassiveUnmountEffectsInsideOfDeletedTree_begin(
                childToDelete,
                parentFiber
              );
            }
          detachAlternateSiblings(parentFiber);
        }
        for (parentFiber = parentFiber.child; null !== parentFiber; ) {
          deletions = parentFiber;
          switch (deletions.tag) {
            case 0:
            case 11:
            case 15:
              commitHookEffectListUnmount(8, deletions, deletions.return);
              recursivelyTraverseDisconnectPassiveEffects(deletions);
              break;
            case 22:
              i = deletions.stateNode;
              i._visibility & 2 && (i._visibility &= -3, recursivelyTraverseDisconnectPassiveEffects(deletions));
              break;
            default:
              recursivelyTraverseDisconnectPassiveEffects(deletions);
          }
          parentFiber = parentFiber.sibling;
        }
      }
      __name(recursivelyTraverseDisconnectPassiveEffects, "recursivelyTraverseDisconnectPassiveEffects");
      function commitPassiveUnmountEffectsInsideOfDeletedTree_begin(deletedSubtreeRoot, nearestMountedAncestor) {
        for (; null !== nextEffect; ) {
          var fiber = nextEffect;
          switch (fiber.tag) {
            case 0:
            case 11:
            case 15:
              commitHookEffectListUnmount(8, fiber, nearestMountedAncestor);
              break;
            case 23:
            case 22:
              if (null !== fiber.memoizedState && null !== fiber.memoizedState.cachePool) {
                var cache3 = fiber.memoizedState.cachePool.pool;
                null != cache3 && cache3.refCount++;
              }
              break;
            case 24:
              releaseCache(fiber.memoizedState.cache);
          }
          cache3 = fiber.child;
          if (null !== cache3) cache3.return = fiber, nextEffect = cache3;
          else
            a: for (fiber = deletedSubtreeRoot; null !== nextEffect; ) {
              cache3 = nextEffect;
              var sibling = cache3.sibling, returnFiber = cache3.return;
              detachFiberAfterEffects(cache3);
              if (cache3 === fiber) {
                nextEffect = null;
                break a;
              }
              if (null !== sibling) {
                sibling.return = returnFiber;
                nextEffect = sibling;
                break a;
              }
              nextEffect = returnFiber;
            }
        }
      }
      __name(commitPassiveUnmountEffectsInsideOfDeletedTree_begin, "commitPassiveUnmountEffectsInsideOfDeletedTree_begin");
      function findFiberRootForHostRoot(hostRoot) {
        var maybeFiber = getInstanceFromNode(hostRoot);
        if (null != maybeFiber) {
          if ("string" !== typeof maybeFiber.memoizedProps["data-testname"])
            throw Error(formatProdErrorMessage(364));
          return maybeFiber;
        }
        hostRoot = findFiberRoot(hostRoot);
        if (null === hostRoot) throw Error(formatProdErrorMessage(362));
        return hostRoot.stateNode.current;
      }
      __name(findFiberRootForHostRoot, "findFiberRootForHostRoot");
      function matchSelector(fiber$jscomp$0, selector) {
        var tag = fiber$jscomp$0.tag;
        switch (selector.$$typeof) {
          case COMPONENT_TYPE:
            if (fiber$jscomp$0.type === selector.value) return true;
            break;
          case HAS_PSEUDO_CLASS_TYPE:
            a: {
              selector = selector.value;
              fiber$jscomp$0 = [fiber$jscomp$0, 0];
              for (tag = 0; tag < fiber$jscomp$0.length; ) {
                var fiber = fiber$jscomp$0[tag++], tag$jscomp$0 = fiber.tag, selectorIndex = fiber$jscomp$0[tag++], selector$jscomp$0 = selector[selectorIndex];
                if (5 !== tag$jscomp$0 && 26 !== tag$jscomp$0 && 27 !== tag$jscomp$0 || !isHiddenSubtree(fiber)) {
                  for (; null != selector$jscomp$0 && matchSelector(fiber, selector$jscomp$0); )
                    selectorIndex++, selector$jscomp$0 = selector[selectorIndex];
                  if (selectorIndex === selector.length) {
                    selector = true;
                    break a;
                  } else
                    for (fiber = fiber.child; null !== fiber; )
                      fiber$jscomp$0.push(fiber, selectorIndex), fiber = fiber.sibling;
                }
              }
              selector = false;
            }
            return selector;
          case ROLE_TYPE:
            if ((5 === tag || 26 === tag || 27 === tag) && matchAccessibilityRole(fiber$jscomp$0.stateNode, selector.value))
              return true;
            break;
          case TEXT_TYPE:
            if (5 === tag || 6 === tag || 26 === tag || 27 === tag) {
              if (fiber$jscomp$0 = getTextContent(fiber$jscomp$0), null !== fiber$jscomp$0 && 0 <= fiber$jscomp$0.indexOf(selector.value))
                return true;
            }
            break;
          case TEST_NAME_TYPE:
            if (5 === tag || 26 === tag || 27 === tag) {
              if (fiber$jscomp$0 = fiber$jscomp$0.memoizedProps["data-testname"], "string" === typeof fiber$jscomp$0 && fiber$jscomp$0.toLowerCase() === selector.value.toLowerCase())
                return true;
            }
            break;
          default:
            throw Error(formatProdErrorMessage(365));
        }
        return false;
      }
      __name(matchSelector, "matchSelector");
      function selectorToString(selector) {
        switch (selector.$$typeof) {
          case COMPONENT_TYPE:
            return "<" + (getComponentNameFromType(selector.value) || "Unknown") + ">";
          case HAS_PSEUDO_CLASS_TYPE:
            return ":has(" + (selectorToString(selector) || "") + ")";
          case ROLE_TYPE:
            return '[role="' + selector.value + '"]';
          case TEXT_TYPE:
            return '"' + selector.value + '"';
          case TEST_NAME_TYPE:
            return '[data-testname="' + selector.value + '"]';
          default:
            throw Error(formatProdErrorMessage(365));
        }
      }
      __name(selectorToString, "selectorToString");
      function findPaths(root, selectors) {
        var matchingFibers = [];
        root = [root, 0];
        for (var index = 0; index < root.length; ) {
          var fiber = root[index++], tag = fiber.tag, selectorIndex = root[index++], selector = selectors[selectorIndex];
          if (5 !== tag && 26 !== tag && 27 !== tag || !isHiddenSubtree(fiber)) {
            for (; null != selector && matchSelector(fiber, selector); )
              selectorIndex++, selector = selectors[selectorIndex];
            if (selectorIndex === selectors.length) matchingFibers.push(fiber);
            else
              for (fiber = fiber.child; null !== fiber; )
                root.push(fiber, selectorIndex), fiber = fiber.sibling;
          }
        }
        return matchingFibers;
      }
      __name(findPaths, "findPaths");
      function findAllNodes(hostRoot, selectors) {
        if (!supportsTestSelectors) throw Error(formatProdErrorMessage(363));
        hostRoot = findFiberRootForHostRoot(hostRoot);
        hostRoot = findPaths(hostRoot, selectors);
        selectors = [];
        hostRoot = Array.from(hostRoot);
        for (var index = 0; index < hostRoot.length; ) {
          var node = hostRoot[index++], tag = node.tag;
          if (5 === tag || 26 === tag || 27 === tag)
            isHiddenSubtree(node) || selectors.push(node.stateNode);
          else
            for (node = node.child; null !== node; )
              hostRoot.push(node), node = node.sibling;
        }
        return selectors;
      }
      __name(findAllNodes, "findAllNodes");
      function requestUpdateLane() {
        return 0 !== (executionContext & 2) && 0 !== workInProgressRootRenderLanes ? workInProgressRootRenderLanes & -workInProgressRootRenderLanes : null !== ReactSharedInternals.T ? requestTransitionLane() : resolveUpdatePriority();
      }
      __name(requestUpdateLane, "requestUpdateLane");
      function requestDeferredLane() {
        if (0 === workInProgressDeferredLane)
          if (0 === (workInProgressRootRenderLanes & 536870912) || isHydrating) {
            var lane = nextTransitionDeferredLane;
            nextTransitionDeferredLane <<= 1;
            0 === (nextTransitionDeferredLane & 3932160) && (nextTransitionDeferredLane = 262144);
            workInProgressDeferredLane = lane;
          } else workInProgressDeferredLane = 536870912;
        lane = suspenseHandlerStackCursor.current;
        null !== lane && (lane.flags |= 32);
        return workInProgressDeferredLane;
      }
      __name(requestDeferredLane, "requestDeferredLane");
      function scheduleUpdateOnFiber(root, fiber, lane) {
        if (root === workInProgressRoot && (2 === workInProgressSuspendedReason || 9 === workInProgressSuspendedReason) || null !== root.cancelPendingCommit)
          prepareFreshStack(root, 0), markRootSuspended(
            root,
            workInProgressRootRenderLanes,
            workInProgressDeferredLane,
            false
          );
        markRootUpdated$1(root, lane);
        if (0 === (executionContext & 2) || root !== workInProgressRoot)
          root === workInProgressRoot && (0 === (executionContext & 2) && (workInProgressRootInterleavedUpdatedLanes |= lane), 4 === workInProgressRootExitStatus && markRootSuspended(
            root,
            workInProgressRootRenderLanes,
            workInProgressDeferredLane,
            false
          )), ensureRootIsScheduled(root);
      }
      __name(scheduleUpdateOnFiber, "scheduleUpdateOnFiber");
      function performWorkOnRoot(root$jscomp$0, lanes, forceSync) {
        if (0 !== (executionContext & 6)) throw Error(formatProdErrorMessage(327));
        var shouldTimeSlice = !forceSync && 0 === (lanes & 127) && 0 === (lanes & root$jscomp$0.expiredLanes) || checkIfRootIsPrerendering(root$jscomp$0, lanes), exitStatus = shouldTimeSlice ? renderRootConcurrent(root$jscomp$0, lanes) : renderRootSync(root$jscomp$0, lanes, true), renderWasConcurrent = shouldTimeSlice;
        do {
          if (0 === exitStatus) {
            workInProgressRootIsPrerendering && !shouldTimeSlice && markRootSuspended(root$jscomp$0, lanes, 0, false);
            break;
          } else {
            forceSync = root$jscomp$0.current.alternate;
            if (renderWasConcurrent && !isRenderConsistentWithExternalStores(forceSync)) {
              exitStatus = renderRootSync(root$jscomp$0, lanes, false);
              renderWasConcurrent = false;
              continue;
            }
            if (2 === exitStatus) {
              renderWasConcurrent = lanes;
              if (root$jscomp$0.errorRecoveryDisabledLanes & renderWasConcurrent)
                var JSCompiler_inline_result = 0;
              else
                JSCompiler_inline_result = root$jscomp$0.pendingLanes & -536870913, JSCompiler_inline_result = 0 !== JSCompiler_inline_result ? JSCompiler_inline_result : JSCompiler_inline_result & 536870912 ? 536870912 : 0;
              if (0 !== JSCompiler_inline_result) {
                lanes = JSCompiler_inline_result;
                a: {
                  var root = root$jscomp$0;
                  exitStatus = workInProgressRootConcurrentErrors;
                  var wasRootDehydrated = supportsHydration && root.current.memoizedState.isDehydrated;
                  wasRootDehydrated && (prepareFreshStack(root, JSCompiler_inline_result).flags |= 256);
                  JSCompiler_inline_result = renderRootSync(
                    root,
                    JSCompiler_inline_result,
                    false
                  );
                  if (2 !== JSCompiler_inline_result) {
                    if (workInProgressRootDidAttachPingListener && !wasRootDehydrated) {
                      root.errorRecoveryDisabledLanes |= renderWasConcurrent;
                      workInProgressRootInterleavedUpdatedLanes |= renderWasConcurrent;
                      exitStatus = 4;
                      break a;
                    }
                    renderWasConcurrent = workInProgressRootRecoverableErrors;
                    workInProgressRootRecoverableErrors = exitStatus;
                    null !== renderWasConcurrent && (null === workInProgressRootRecoverableErrors ? workInProgressRootRecoverableErrors = renderWasConcurrent : workInProgressRootRecoverableErrors.push.apply(
                      workInProgressRootRecoverableErrors,
                      renderWasConcurrent
                    ));
                  }
                  exitStatus = JSCompiler_inline_result;
                }
                renderWasConcurrent = false;
                if (2 !== exitStatus) continue;
              }
            }
            if (1 === exitStatus) {
              prepareFreshStack(root$jscomp$0, 0);
              markRootSuspended(root$jscomp$0, lanes, 0, true);
              break;
            }
            a: {
              shouldTimeSlice = root$jscomp$0;
              renderWasConcurrent = exitStatus;
              switch (renderWasConcurrent) {
                case 0:
                case 1:
                  throw Error(formatProdErrorMessage(345));
                case 4:
                  if ((lanes & 4194048) !== lanes) break;
                case 6:
                  markRootSuspended(
                    shouldTimeSlice,
                    lanes,
                    workInProgressDeferredLane,
                    !workInProgressRootDidSkipSuspendedSiblings
                  );
                  break a;
                case 2:
                  workInProgressRootRecoverableErrors = null;
                  break;
                case 3:
                case 5:
                  break;
                default:
                  throw Error(formatProdErrorMessage(329));
              }
              if ((lanes & 62914560) === lanes && (exitStatus = globalMostRecentFallbackTime + 300 - now(), 10 < exitStatus)) {
                markRootSuspended(
                  shouldTimeSlice,
                  lanes,
                  workInProgressDeferredLane,
                  !workInProgressRootDidSkipSuspendedSiblings
                );
                if (0 !== getNextLanes(shouldTimeSlice, 0, true)) break a;
                pendingEffectsLanes = lanes;
                shouldTimeSlice.timeoutHandle = scheduleTimeout(
                  commitRootWhenReady.bind(
                    null,
                    shouldTimeSlice,
                    forceSync,
                    workInProgressRootRecoverableErrors,
                    workInProgressTransitions,
                    workInProgressRootDidIncludeRecursiveRenderUpdate,
                    lanes,
                    workInProgressDeferredLane,
                    workInProgressRootInterleavedUpdatedLanes,
                    workInProgressSuspendedRetryLanes,
                    workInProgressRootDidSkipSuspendedSiblings,
                    renderWasConcurrent,
                    "Throttled",
                    -0,
                    0
                  ),
                  exitStatus
                );
                break a;
              }
              commitRootWhenReady(
                shouldTimeSlice,
                forceSync,
                workInProgressRootRecoverableErrors,
                workInProgressTransitions,
                workInProgressRootDidIncludeRecursiveRenderUpdate,
                lanes,
                workInProgressDeferredLane,
                workInProgressRootInterleavedUpdatedLanes,
                workInProgressSuspendedRetryLanes,
                workInProgressRootDidSkipSuspendedSiblings,
                renderWasConcurrent,
                null,
                -0,
                0
              );
            }
          }
          break;
        } while (1);
        ensureRootIsScheduled(root$jscomp$0);
      }
      __name(performWorkOnRoot, "performWorkOnRoot");
      function commitRootWhenReady(root, finishedWork, recoverableErrors, transitions, didIncludeRenderPhaseUpdate, lanes, spawnedLane, updatedLanes, suspendedRetryLanes, didSkipSuspendedSiblings, exitStatus, suspendedCommitReason, completedRenderStartTime, completedRenderEndTime) {
        root.timeoutHandle = noTimeout;
        suspendedCommitReason = finishedWork.subtreeFlags;
        if (suspendedCommitReason & 8192 || 16785408 === (suspendedCommitReason & 16785408)) {
          suspendedCommitReason = startSuspendingCommit();
          accumulateSuspenseyCommitOnFiber(
            finishedWork,
            lanes,
            suspendedCommitReason
          );
          var timeoutOffset = (lanes & 62914560) === lanes ? globalMostRecentFallbackTime - now() : (lanes & 4194048) === lanes ? globalMostRecentTransitionTime - now() : 0;
          timeoutOffset = waitForCommitToBeReady(
            suspendedCommitReason,
            timeoutOffset
          );
          if (null !== timeoutOffset) {
            pendingEffectsLanes = lanes;
            root.cancelPendingCommit = timeoutOffset(
              commitRoot.bind(
                null,
                root,
                finishedWork,
                lanes,
                recoverableErrors,
                transitions,
                didIncludeRenderPhaseUpdate,
                spawnedLane,
                updatedLanes,
                suspendedRetryLanes,
                exitStatus,
                suspendedCommitReason,
                null,
                completedRenderStartTime,
                completedRenderEndTime
              )
            );
            markRootSuspended(root, lanes, spawnedLane, !didSkipSuspendedSiblings);
            return;
          }
        }
        commitRoot(
          root,
          finishedWork,
          lanes,
          recoverableErrors,
          transitions,
          didIncludeRenderPhaseUpdate,
          spawnedLane,
          updatedLanes,
          suspendedRetryLanes
        );
      }
      __name(commitRootWhenReady, "commitRootWhenReady");
      function isRenderConsistentWithExternalStores(finishedWork) {
        for (var node = finishedWork; ; ) {
          var tag = node.tag;
          if ((0 === tag || 11 === tag || 15 === tag) && node.flags & 16384 && (tag = node.updateQueue, null !== tag && (tag = tag.stores, null !== tag)))
            for (var i = 0; i < tag.length; i++) {
              var check = tag[i], getSnapshot = check.getSnapshot;
              check = check.value;
              try {
                if (!objectIs(getSnapshot(), check)) return false;
              } catch (error) {
                return false;
              }
            }
          tag = node.child;
          if (node.subtreeFlags & 16384 && null !== tag)
            tag.return = node, node = tag;
          else {
            if (node === finishedWork) break;
            for (; null === node.sibling; ) {
              if (null === node.return || node.return === finishedWork) return true;
              node = node.return;
            }
            node.sibling.return = node.return;
            node = node.sibling;
          }
        }
        return true;
      }
      __name(isRenderConsistentWithExternalStores, "isRenderConsistentWithExternalStores");
      function markRootSuspended(root, suspendedLanes, spawnedLane, didAttemptEntireTree) {
        suspendedLanes &= ~workInProgressRootPingedLanes;
        suspendedLanes &= ~workInProgressRootInterleavedUpdatedLanes;
        root.suspendedLanes |= suspendedLanes;
        root.pingedLanes &= ~suspendedLanes;
        didAttemptEntireTree && (root.warmLanes |= suspendedLanes);
        didAttemptEntireTree = root.expirationTimes;
        for (var lanes = suspendedLanes; 0 < lanes; ) {
          var index$4 = 31 - clz32(lanes), lane = 1 << index$4;
          didAttemptEntireTree[index$4] = -1;
          lanes &= ~lane;
        }
        0 !== spawnedLane && markSpawnedDeferredLane(root, spawnedLane, suspendedLanes);
      }
      __name(markRootSuspended, "markRootSuspended");
      function flushSyncWork() {
        return 0 === (executionContext & 6) ? (flushSyncWorkAcrossRoots_impl(0, false), false) : true;
      }
      __name(flushSyncWork, "flushSyncWork");
      function resetWorkInProgressStack() {
        if (null !== workInProgress) {
          if (0 === workInProgressSuspendedReason)
            var interruptedWork = workInProgress.return;
          else
            interruptedWork = workInProgress, lastContextDependency = currentlyRenderingFiber$1 = null, resetHooksOnUnwind(interruptedWork), thenableState$1 = null, thenableIndexCounter$1 = 0, interruptedWork = workInProgress;
          for (; null !== interruptedWork; )
            unwindInterruptedWork(interruptedWork.alternate, interruptedWork), interruptedWork = interruptedWork.return;
          workInProgress = null;
        }
      }
      __name(resetWorkInProgressStack, "resetWorkInProgressStack");
      function prepareFreshStack(root, lanes) {
        var timeoutHandle = root.timeoutHandle;
        timeoutHandle !== noTimeout && (root.timeoutHandle = noTimeout, cancelTimeout(timeoutHandle));
        timeoutHandle = root.cancelPendingCommit;
        null !== timeoutHandle && (root.cancelPendingCommit = null, timeoutHandle());
        pendingEffectsLanes = 0;
        resetWorkInProgressStack();
        workInProgressRoot = root;
        workInProgress = timeoutHandle = createWorkInProgress(root.current, null);
        workInProgressRootRenderLanes = lanes;
        workInProgressSuspendedReason = 0;
        workInProgressThrownValue = null;
        workInProgressRootDidSkipSuspendedSiblings = false;
        workInProgressRootIsPrerendering = checkIfRootIsPrerendering(root, lanes);
        workInProgressRootDidAttachPingListener = false;
        workInProgressSuspendedRetryLanes = workInProgressDeferredLane = workInProgressRootPingedLanes = workInProgressRootInterleavedUpdatedLanes = workInProgressRootSkippedLanes = workInProgressRootExitStatus = 0;
        workInProgressRootRecoverableErrors = workInProgressRootConcurrentErrors = null;
        workInProgressRootDidIncludeRecursiveRenderUpdate = false;
        0 !== (lanes & 8) && (lanes |= lanes & 32);
        var allEntangledLanes = root.entangledLanes;
        if (0 !== allEntangledLanes)
          for (root = root.entanglements, allEntangledLanes &= lanes; 0 < allEntangledLanes; ) {
            var index$2 = 31 - clz32(allEntangledLanes), lane = 1 << index$2;
            lanes |= root[index$2];
            allEntangledLanes &= ~lane;
          }
        entangledRenderLanes = lanes;
        finishQueueingConcurrentUpdates();
        return timeoutHandle;
      }
      __name(prepareFreshStack, "prepareFreshStack");
      function handleThrow(root, thrownValue) {
        currentlyRenderingFiber = null;
        ReactSharedInternals.H = ContextOnlyDispatcher;
        thrownValue === SuspenseException || thrownValue === SuspenseActionException ? (thrownValue = getSuspendedThenable(), workInProgressSuspendedReason = 3) : thrownValue === SuspenseyCommitException ? (thrownValue = getSuspendedThenable(), workInProgressSuspendedReason = 4) : workInProgressSuspendedReason = thrownValue === SelectiveHydrationException ? 8 : null !== thrownValue && "object" === typeof thrownValue && "function" === typeof thrownValue.then ? 6 : 1;
        workInProgressThrownValue = thrownValue;
        null === workInProgress && (workInProgressRootExitStatus = 1, logUncaughtError(
          root,
          createCapturedValueAtFiber(thrownValue, root.current)
        ));
      }
      __name(handleThrow, "handleThrow");
      function shouldRemainOnPreviousScreen() {
        var handler = suspenseHandlerStackCursor.current;
        return null === handler ? true : (workInProgressRootRenderLanes & 4194048) === workInProgressRootRenderLanes ? null === shellBoundary ? true : false : (workInProgressRootRenderLanes & 62914560) === workInProgressRootRenderLanes || 0 !== (workInProgressRootRenderLanes & 536870912) ? handler === shellBoundary : false;
      }
      __name(shouldRemainOnPreviousScreen, "shouldRemainOnPreviousScreen");
      function pushDispatcher() {
        var prevDispatcher = ReactSharedInternals.H;
        ReactSharedInternals.H = ContextOnlyDispatcher;
        return null === prevDispatcher ? ContextOnlyDispatcher : prevDispatcher;
      }
      __name(pushDispatcher, "pushDispatcher");
      function pushAsyncDispatcher() {
        var prevAsyncDispatcher = ReactSharedInternals.A;
        ReactSharedInternals.A = DefaultAsyncDispatcher;
        return prevAsyncDispatcher;
      }
      __name(pushAsyncDispatcher, "pushAsyncDispatcher");
      function renderDidSuspendDelayIfPossible() {
        workInProgressRootExitStatus = 4;
        workInProgressRootDidSkipSuspendedSiblings || (workInProgressRootRenderLanes & 4194048) !== workInProgressRootRenderLanes && null !== suspenseHandlerStackCursor.current || (workInProgressRootIsPrerendering = true);
        0 === (workInProgressRootSkippedLanes & 134217727) && 0 === (workInProgressRootInterleavedUpdatedLanes & 134217727) || null === workInProgressRoot || markRootSuspended(
          workInProgressRoot,
          workInProgressRootRenderLanes,
          workInProgressDeferredLane,
          false
        );
      }
      __name(renderDidSuspendDelayIfPossible, "renderDidSuspendDelayIfPossible");
      function renderRootSync(root, lanes, shouldYieldForPrerendering) {
        var prevExecutionContext = executionContext;
        executionContext |= 2;
        var prevDispatcher = pushDispatcher(), prevAsyncDispatcher = pushAsyncDispatcher();
        if (workInProgressRoot !== root || workInProgressRootRenderLanes !== lanes)
          workInProgressTransitions = null, prepareFreshStack(root, lanes);
        lanes = false;
        var exitStatus = workInProgressRootExitStatus;
        a: do
          try {
            if (0 !== workInProgressSuspendedReason && null !== workInProgress) {
              var unitOfWork = workInProgress, thrownValue = workInProgressThrownValue;
              switch (workInProgressSuspendedReason) {
                case 8:
                  resetWorkInProgressStack();
                  exitStatus = 6;
                  break a;
                case 3:
                case 2:
                case 9:
                case 6:
                  null === suspenseHandlerStackCursor.current && (lanes = true);
                  var reason = workInProgressSuspendedReason;
                  workInProgressSuspendedReason = 0;
                  workInProgressThrownValue = null;
                  throwAndUnwindWorkLoop(root, unitOfWork, thrownValue, reason);
                  if (shouldYieldForPrerendering && workInProgressRootIsPrerendering) {
                    exitStatus = 0;
                    break a;
                  }
                  break;
                default:
                  reason = workInProgressSuspendedReason, workInProgressSuspendedReason = 0, workInProgressThrownValue = null, throwAndUnwindWorkLoop(root, unitOfWork, thrownValue, reason);
              }
            }
            workLoopSync();
            exitStatus = workInProgressRootExitStatus;
            break;
          } catch (thrownValue$152) {
            handleThrow(root, thrownValue$152);
          }
        while (1);
        lanes && root.shellSuspendCounter++;
        lastContextDependency = currentlyRenderingFiber$1 = null;
        executionContext = prevExecutionContext;
        ReactSharedInternals.H = prevDispatcher;
        ReactSharedInternals.A = prevAsyncDispatcher;
        null === workInProgress && (workInProgressRoot = null, workInProgressRootRenderLanes = 0, finishQueueingConcurrentUpdates());
        return exitStatus;
      }
      __name(renderRootSync, "renderRootSync");
      function workLoopSync() {
        for (; null !== workInProgress; ) performUnitOfWork(workInProgress);
      }
      __name(workLoopSync, "workLoopSync");
      function renderRootConcurrent(root, lanes) {
        var prevExecutionContext = executionContext;
        executionContext |= 2;
        var prevDispatcher = pushDispatcher(), prevAsyncDispatcher = pushAsyncDispatcher();
        workInProgressRoot !== root || workInProgressRootRenderLanes !== lanes ? (workInProgressTransitions = null, workInProgressRootRenderTargetTime = now() + 500, prepareFreshStack(root, lanes)) : workInProgressRootIsPrerendering = checkIfRootIsPrerendering(
          root,
          lanes
        );
        a: do
          try {
            if (0 !== workInProgressSuspendedReason && null !== workInProgress) {
              lanes = workInProgress;
              var thrownValue = workInProgressThrownValue;
              b: switch (workInProgressSuspendedReason) {
                case 1:
                  workInProgressSuspendedReason = 0;
                  workInProgressThrownValue = null;
                  throwAndUnwindWorkLoop(root, lanes, thrownValue, 1);
                  break;
                case 2:
                case 9:
                  if (isThenableResolved(thrownValue)) {
                    workInProgressSuspendedReason = 0;
                    workInProgressThrownValue = null;
                    replaySuspendedUnitOfWork(lanes);
                    break;
                  }
                  lanes = /* @__PURE__ */ __name(function() {
                    2 !== workInProgressSuspendedReason && 9 !== workInProgressSuspendedReason || workInProgressRoot !== root || (workInProgressSuspendedReason = 7);
                    ensureRootIsScheduled(root);
                  }, "lanes");
                  thrownValue.then(lanes, lanes);
                  break a;
                case 3:
                  workInProgressSuspendedReason = 7;
                  break a;
                case 4:
                  workInProgressSuspendedReason = 5;
                  break a;
                case 7:
                  isThenableResolved(thrownValue) ? (workInProgressSuspendedReason = 0, workInProgressThrownValue = null, replaySuspendedUnitOfWork(lanes)) : (workInProgressSuspendedReason = 0, workInProgressThrownValue = null, throwAndUnwindWorkLoop(root, lanes, thrownValue, 7));
                  break;
                case 5:
                  var resource = null;
                  switch (workInProgress.tag) {
                    case 26:
                      resource = workInProgress.memoizedState;
                    case 5:
                    case 27:
                      var hostFiber = workInProgress, type = hostFiber.type, props = hostFiber.pendingProps;
                      if (resource ? preloadResource(resource) : preloadInstance(hostFiber.stateNode, type, props)) {
                        workInProgressSuspendedReason = 0;
                        workInProgressThrownValue = null;
                        var sibling = hostFiber.sibling;
                        if (null !== sibling) workInProgress = sibling;
                        else {
                          var returnFiber = hostFiber.return;
                          null !== returnFiber ? (workInProgress = returnFiber, completeUnitOfWork(returnFiber)) : workInProgress = null;
                        }
                        break b;
                      }
                  }
                  workInProgressSuspendedReason = 0;
                  workInProgressThrownValue = null;
                  throwAndUnwindWorkLoop(root, lanes, thrownValue, 5);
                  break;
                case 6:
                  workInProgressSuspendedReason = 0;
                  workInProgressThrownValue = null;
                  throwAndUnwindWorkLoop(root, lanes, thrownValue, 6);
                  break;
                case 8:
                  resetWorkInProgressStack();
                  workInProgressRootExitStatus = 6;
                  break a;
                default:
                  throw Error(formatProdErrorMessage(462));
              }
            }
            workLoopConcurrentByScheduler();
            break;
          } catch (thrownValue$154) {
            handleThrow(root, thrownValue$154);
          }
        while (1);
        lastContextDependency = currentlyRenderingFiber$1 = null;
        ReactSharedInternals.H = prevDispatcher;
        ReactSharedInternals.A = prevAsyncDispatcher;
        executionContext = prevExecutionContext;
        if (null !== workInProgress) return 0;
        workInProgressRoot = null;
        workInProgressRootRenderLanes = 0;
        finishQueueingConcurrentUpdates();
        return workInProgressRootExitStatus;
      }
      __name(renderRootConcurrent, "renderRootConcurrent");
      function workLoopConcurrentByScheduler() {
        for (; null !== workInProgress && !shouldYield(); )
          performUnitOfWork(workInProgress);
      }
      __name(workLoopConcurrentByScheduler, "workLoopConcurrentByScheduler");
      function performUnitOfWork(unitOfWork) {
        var next = beginWork(
          unitOfWork.alternate,
          unitOfWork,
          entangledRenderLanes
        );
        unitOfWork.memoizedProps = unitOfWork.pendingProps;
        null === next ? completeUnitOfWork(unitOfWork) : workInProgress = next;
      }
      __name(performUnitOfWork, "performUnitOfWork");
      function replaySuspendedUnitOfWork(unitOfWork) {
        var next = unitOfWork;
        var current = next.alternate;
        switch (next.tag) {
          case 15:
          case 0:
            next = replayFunctionComponent(
              current,
              next,
              next.pendingProps,
              next.type,
              void 0,
              workInProgressRootRenderLanes
            );
            break;
          case 11:
            next = replayFunctionComponent(
              current,
              next,
              next.pendingProps,
              next.type.render,
              next.ref,
              workInProgressRootRenderLanes
            );
            break;
          case 5:
            resetHooksOnUnwind(next);
          default:
            unwindInterruptedWork(current, next), next = workInProgress = resetWorkInProgress(next, entangledRenderLanes), next = beginWork(current, next, entangledRenderLanes);
        }
        unitOfWork.memoizedProps = unitOfWork.pendingProps;
        null === next ? completeUnitOfWork(unitOfWork) : workInProgress = next;
      }
      __name(replaySuspendedUnitOfWork, "replaySuspendedUnitOfWork");
      function throwAndUnwindWorkLoop(root, unitOfWork, thrownValue, suspendedReason) {
        lastContextDependency = currentlyRenderingFiber$1 = null;
        resetHooksOnUnwind(unitOfWork);
        thenableState$1 = null;
        thenableIndexCounter$1 = 0;
        var returnFiber = unitOfWork.return;
        try {
          if (throwException(
            root,
            returnFiber,
            unitOfWork,
            thrownValue,
            workInProgressRootRenderLanes
          )) {
            workInProgressRootExitStatus = 1;
            logUncaughtError(
              root,
              createCapturedValueAtFiber(thrownValue, root.current)
            );
            workInProgress = null;
            return;
          }
        } catch (error) {
          if (null !== returnFiber) throw workInProgress = returnFiber, error;
          workInProgressRootExitStatus = 1;
          logUncaughtError(
            root,
            createCapturedValueAtFiber(thrownValue, root.current)
          );
          workInProgress = null;
          return;
        }
        if (unitOfWork.flags & 32768) {
          if (isHydrating || 1 === suspendedReason) root = true;
          else if (workInProgressRootIsPrerendering || 0 !== (workInProgressRootRenderLanes & 536870912))
            root = false;
          else if (workInProgressRootDidSkipSuspendedSiblings = root = true, 2 === suspendedReason || 9 === suspendedReason || 3 === suspendedReason || 6 === suspendedReason)
            suspendedReason = suspenseHandlerStackCursor.current, null !== suspendedReason && 13 === suspendedReason.tag && (suspendedReason.flags |= 16384);
          unwindUnitOfWork(unitOfWork, root);
        } else completeUnitOfWork(unitOfWork);
      }
      __name(throwAndUnwindWorkLoop, "throwAndUnwindWorkLoop");
      function completeUnitOfWork(unitOfWork) {
        var completedWork = unitOfWork;
        do {
          if (0 !== (completedWork.flags & 32768)) {
            unwindUnitOfWork(
              completedWork,
              workInProgressRootDidSkipSuspendedSiblings
            );
            return;
          }
          unitOfWork = completedWork.return;
          var next = completeWork(
            completedWork.alternate,
            completedWork,
            entangledRenderLanes
          );
          if (null !== next) {
            workInProgress = next;
            return;
          }
          completedWork = completedWork.sibling;
          if (null !== completedWork) {
            workInProgress = completedWork;
            return;
          }
          workInProgress = completedWork = unitOfWork;
        } while (null !== completedWork);
        0 === workInProgressRootExitStatus && (workInProgressRootExitStatus = 5);
      }
      __name(completeUnitOfWork, "completeUnitOfWork");
      function unwindUnitOfWork(unitOfWork, skipSiblings) {
        do {
          var next = unwindWork(unitOfWork.alternate, unitOfWork);
          if (null !== next) {
            next.flags &= 32767;
            workInProgress = next;
            return;
          }
          next = unitOfWork.return;
          null !== next && (next.flags |= 32768, next.subtreeFlags = 0, next.deletions = null);
          if (!skipSiblings && (unitOfWork = unitOfWork.sibling, null !== unitOfWork)) {
            workInProgress = unitOfWork;
            return;
          }
          workInProgress = unitOfWork = next;
        } while (null !== unitOfWork);
        workInProgressRootExitStatus = 6;
        workInProgress = null;
      }
      __name(unwindUnitOfWork, "unwindUnitOfWork");
      function commitRoot(root, finishedWork, lanes, recoverableErrors, transitions, didIncludeRenderPhaseUpdate, spawnedLane, updatedLanes, suspendedRetryLanes) {
        root.cancelPendingCommit = null;
        do
          flushPendingEffects();
        while (0 !== pendingEffectsStatus);
        if (0 !== (executionContext & 6)) throw Error(formatProdErrorMessage(327));
        if (null !== finishedWork) {
          if (finishedWork === root.current)
            throw Error(formatProdErrorMessage(177));
          didIncludeRenderPhaseUpdate = finishedWork.lanes | finishedWork.childLanes;
          didIncludeRenderPhaseUpdate |= concurrentlyUpdatedLanes;
          markRootFinished(
            root,
            lanes,
            didIncludeRenderPhaseUpdate,
            spawnedLane,
            updatedLanes,
            suspendedRetryLanes
          );
          root === workInProgressRoot && (workInProgress = workInProgressRoot = null, workInProgressRootRenderLanes = 0);
          pendingFinishedWork = finishedWork;
          pendingEffectsRoot = root;
          pendingEffectsLanes = lanes;
          pendingEffectsRemainingLanes = didIncludeRenderPhaseUpdate;
          pendingPassiveTransitions = transitions;
          pendingRecoverableErrors = recoverableErrors;
          0 !== (finishedWork.subtreeFlags & 10256) || 0 !== (finishedWork.flags & 10256) ? (root.callbackNode = null, root.callbackPriority = 0, scheduleCallback(NormalPriority$1, function() {
            flushPassiveEffects();
            return null;
          })) : (root.callbackNode = null, root.callbackPriority = 0);
          recoverableErrors = 0 !== (finishedWork.flags & 13878);
          if (0 !== (finishedWork.subtreeFlags & 13878) || recoverableErrors) {
            recoverableErrors = ReactSharedInternals.T;
            ReactSharedInternals.T = null;
            transitions = getCurrentUpdatePriority();
            setCurrentUpdatePriority(2);
            spawnedLane = executionContext;
            executionContext |= 4;
            try {
              commitBeforeMutationEffects(root, finishedWork, lanes);
            } finally {
              executionContext = spawnedLane, setCurrentUpdatePriority(transitions), ReactSharedInternals.T = recoverableErrors;
            }
          }
          pendingEffectsStatus = 1;
          flushMutationEffects();
          flushLayoutEffects();
          flushSpawnedWork();
        }
      }
      __name(commitRoot, "commitRoot");
      function flushMutationEffects() {
        if (1 === pendingEffectsStatus) {
          pendingEffectsStatus = 0;
          var root = pendingEffectsRoot, finishedWork = pendingFinishedWork, rootMutationHasEffect = 0 !== (finishedWork.flags & 13878);
          if (0 !== (finishedWork.subtreeFlags & 13878) || rootMutationHasEffect) {
            rootMutationHasEffect = ReactSharedInternals.T;
            ReactSharedInternals.T = null;
            var previousPriority = getCurrentUpdatePriority();
            setCurrentUpdatePriority(2);
            var prevExecutionContext = executionContext;
            executionContext |= 4;
            try {
              commitMutationEffectsOnFiber(finishedWork, root), resetAfterCommit(root.containerInfo);
            } finally {
              executionContext = prevExecutionContext, setCurrentUpdatePriority(previousPriority), ReactSharedInternals.T = rootMutationHasEffect;
            }
          }
          root.current = finishedWork;
          pendingEffectsStatus = 2;
        }
      }
      __name(flushMutationEffects, "flushMutationEffects");
      function flushLayoutEffects() {
        if (2 === pendingEffectsStatus) {
          pendingEffectsStatus = 0;
          var root = pendingEffectsRoot, finishedWork = pendingFinishedWork, rootHasLayoutEffect = 0 !== (finishedWork.flags & 8772);
          if (0 !== (finishedWork.subtreeFlags & 8772) || rootHasLayoutEffect) {
            rootHasLayoutEffect = ReactSharedInternals.T;
            ReactSharedInternals.T = null;
            var previousPriority = getCurrentUpdatePriority();
            setCurrentUpdatePriority(2);
            var prevExecutionContext = executionContext;
            executionContext |= 4;
            try {
              commitLayoutEffectOnFiber(root, finishedWork.alternate, finishedWork);
            } finally {
              executionContext = prevExecutionContext, setCurrentUpdatePriority(previousPriority), ReactSharedInternals.T = rootHasLayoutEffect;
            }
          }
          pendingEffectsStatus = 3;
        }
      }
      __name(flushLayoutEffects, "flushLayoutEffects");
      function flushSpawnedWork() {
        if (4 === pendingEffectsStatus || 3 === pendingEffectsStatus) {
          pendingEffectsStatus = 0;
          requestPaint();
          var root = pendingEffectsRoot, finishedWork = pendingFinishedWork, lanes = pendingEffectsLanes, recoverableErrors = pendingRecoverableErrors;
          0 !== (finishedWork.subtreeFlags & 10256) || 0 !== (finishedWork.flags & 10256) ? pendingEffectsStatus = 5 : (pendingEffectsStatus = 0, pendingFinishedWork = pendingEffectsRoot = null, releaseRootPooledCache(root, root.pendingLanes));
          var remainingLanes = root.pendingLanes;
          0 === remainingLanes && (legacyErrorBoundariesThatAlreadyFailed = null);
          lanesToEventPriority(lanes);
          finishedWork = finishedWork.stateNode;
          if (injectedHook && "function" === typeof injectedHook.onCommitFiberRoot)
            try {
              injectedHook.onCommitFiberRoot(
                rendererID,
                finishedWork,
                void 0,
                128 === (finishedWork.current.flags & 128)
              );
            } catch (err) {
            }
          if (null !== recoverableErrors) {
            finishedWork = ReactSharedInternals.T;
            remainingLanes = getCurrentUpdatePriority();
            setCurrentUpdatePriority(2);
            ReactSharedInternals.T = null;
            try {
              for (var onRecoverableError = root.onRecoverableError, i = 0; i < recoverableErrors.length; i++) {
                var recoverableError = recoverableErrors[i];
                onRecoverableError(recoverableError.value, {
                  componentStack: recoverableError.stack
                });
              }
            } finally {
              ReactSharedInternals.T = finishedWork, setCurrentUpdatePriority(remainingLanes);
            }
          }
          0 !== (pendingEffectsLanes & 3) && flushPendingEffects();
          ensureRootIsScheduled(root);
          remainingLanes = root.pendingLanes;
          0 !== (lanes & 261930) && 0 !== (remainingLanes & 42) ? root === rootWithNestedUpdates ? nestedUpdateCount++ : (nestedUpdateCount = 0, rootWithNestedUpdates = root) : nestedUpdateCount = 0;
          supportsHydration && flushHydrationEvents();
          flushSyncWorkAcrossRoots_impl(0, false);
        }
      }
      __name(flushSpawnedWork, "flushSpawnedWork");
      function releaseRootPooledCache(root, remainingLanes) {
        0 === (root.pooledCacheLanes &= remainingLanes) && (remainingLanes = root.pooledCache, null != remainingLanes && (root.pooledCache = null, releaseCache(remainingLanes)));
      }
      __name(releaseRootPooledCache, "releaseRootPooledCache");
      function flushPendingEffects() {
        flushMutationEffects();
        flushLayoutEffects();
        flushSpawnedWork();
        return flushPassiveEffects();
      }
      __name(flushPendingEffects, "flushPendingEffects");
      function flushPassiveEffects() {
        if (5 !== pendingEffectsStatus) return false;
        var root = pendingEffectsRoot, remainingLanes = pendingEffectsRemainingLanes;
        pendingEffectsRemainingLanes = 0;
        var renderPriority = lanesToEventPriority(pendingEffectsLanes), priority = 32 > renderPriority ? 32 : renderPriority;
        renderPriority = ReactSharedInternals.T;
        var previousPriority = getCurrentUpdatePriority();
        try {
          setCurrentUpdatePriority(priority);
          ReactSharedInternals.T = null;
          priority = pendingPassiveTransitions;
          pendingPassiveTransitions = null;
          var root$jscomp$0 = pendingEffectsRoot, lanes = pendingEffectsLanes;
          pendingEffectsStatus = 0;
          pendingFinishedWork = pendingEffectsRoot = null;
          pendingEffectsLanes = 0;
          if (0 !== (executionContext & 6))
            throw Error(formatProdErrorMessage(331));
          var prevExecutionContext = executionContext;
          executionContext |= 4;
          commitPassiveUnmountOnFiber(root$jscomp$0.current);
          commitPassiveMountOnFiber(
            root$jscomp$0,
            root$jscomp$0.current,
            lanes,
            priority
          );
          executionContext = prevExecutionContext;
          flushSyncWorkAcrossRoots_impl(0, false);
          if (injectedHook && "function" === typeof injectedHook.onPostCommitFiberRoot)
            try {
              injectedHook.onPostCommitFiberRoot(rendererID, root$jscomp$0);
            } catch (err) {
            }
          return true;
        } finally {
          setCurrentUpdatePriority(previousPriority), ReactSharedInternals.T = renderPriority, releaseRootPooledCache(root, remainingLanes);
        }
      }
      __name(flushPassiveEffects, "flushPassiveEffects");
      function captureCommitPhaseErrorOnRoot(rootFiber, sourceFiber, error) {
        sourceFiber = createCapturedValueAtFiber(error, sourceFiber);
        sourceFiber = createRootErrorUpdate(rootFiber.stateNode, sourceFiber, 2);
        rootFiber = enqueueUpdate(rootFiber, sourceFiber, 2);
        null !== rootFiber && (markRootUpdated$1(rootFiber, 2), ensureRootIsScheduled(rootFiber));
      }
      __name(captureCommitPhaseErrorOnRoot, "captureCommitPhaseErrorOnRoot");
      function captureCommitPhaseError(sourceFiber, nearestMountedAncestor, error) {
        if (3 === sourceFiber.tag)
          captureCommitPhaseErrorOnRoot(sourceFiber, sourceFiber, error);
        else
          for (; null !== nearestMountedAncestor; ) {
            if (3 === nearestMountedAncestor.tag) {
              captureCommitPhaseErrorOnRoot(
                nearestMountedAncestor,
                sourceFiber,
                error
              );
              break;
            } else if (1 === nearestMountedAncestor.tag) {
              var instance = nearestMountedAncestor.stateNode;
              if ("function" === typeof nearestMountedAncestor.type.getDerivedStateFromError || "function" === typeof instance.componentDidCatch && (null === legacyErrorBoundariesThatAlreadyFailed || !legacyErrorBoundariesThatAlreadyFailed.has(instance))) {
                sourceFiber = createCapturedValueAtFiber(error, sourceFiber);
                error = createClassErrorUpdate(2);
                instance = enqueueUpdate(nearestMountedAncestor, error, 2);
                null !== instance && (initializeClassErrorUpdate(
                  error,
                  instance,
                  nearestMountedAncestor,
                  sourceFiber
                ), markRootUpdated$1(instance, 2), ensureRootIsScheduled(instance));
                break;
              }
            }
            nearestMountedAncestor = nearestMountedAncestor.return;
          }
      }
      __name(captureCommitPhaseError, "captureCommitPhaseError");
      function attachPingListener(root, wakeable, lanes) {
        var pingCache = root.pingCache;
        if (null === pingCache) {
          pingCache = root.pingCache = new PossiblyWeakMap();
          var threadIDs = /* @__PURE__ */ new Set();
          pingCache.set(wakeable, threadIDs);
        } else
          threadIDs = pingCache.get(wakeable), void 0 === threadIDs && (threadIDs = /* @__PURE__ */ new Set(), pingCache.set(wakeable, threadIDs));
        threadIDs.has(lanes) || (workInProgressRootDidAttachPingListener = true, threadIDs.add(lanes), root = pingSuspendedRoot.bind(null, root, wakeable, lanes), wakeable.then(root, root));
      }
      __name(attachPingListener, "attachPingListener");
      function pingSuspendedRoot(root, wakeable, pingedLanes) {
        var pingCache = root.pingCache;
        null !== pingCache && pingCache.delete(wakeable);
        root.pingedLanes |= root.suspendedLanes & pingedLanes;
        root.warmLanes &= ~pingedLanes;
        workInProgressRoot === root && (workInProgressRootRenderLanes & pingedLanes) === pingedLanes && (4 === workInProgressRootExitStatus || 3 === workInProgressRootExitStatus && (workInProgressRootRenderLanes & 62914560) === workInProgressRootRenderLanes && 300 > now() - globalMostRecentFallbackTime ? 0 === (executionContext & 2) && prepareFreshStack(root, 0) : workInProgressRootPingedLanes |= pingedLanes, workInProgressSuspendedRetryLanes === workInProgressRootRenderLanes && (workInProgressSuspendedRetryLanes = 0));
        ensureRootIsScheduled(root);
      }
      __name(pingSuspendedRoot, "pingSuspendedRoot");
      function retryTimedOutBoundary(boundaryFiber, retryLane) {
        0 === retryLane && (retryLane = claimNextRetryLane());
        boundaryFiber = enqueueConcurrentRenderForLane(boundaryFiber, retryLane);
        null !== boundaryFiber && (markRootUpdated$1(boundaryFiber, retryLane), ensureRootIsScheduled(boundaryFiber));
      }
      __name(retryTimedOutBoundary, "retryTimedOutBoundary");
      function retryDehydratedSuspenseBoundary(boundaryFiber) {
        var suspenseState = boundaryFiber.memoizedState, retryLane = 0;
        null !== suspenseState && (retryLane = suspenseState.retryLane);
        retryTimedOutBoundary(boundaryFiber, retryLane);
      }
      __name(retryDehydratedSuspenseBoundary, "retryDehydratedSuspenseBoundary");
      function resolveRetryWakeable(boundaryFiber, wakeable) {
        var retryLane = 0;
        switch (boundaryFiber.tag) {
          case 31:
          case 13:
            var retryCache = boundaryFiber.stateNode;
            var suspenseState = boundaryFiber.memoizedState;
            null !== suspenseState && (retryLane = suspenseState.retryLane);
            break;
          case 19:
            retryCache = boundaryFiber.stateNode;
            break;
          case 22:
            retryCache = boundaryFiber.stateNode._retryCache;
            break;
          default:
            throw Error(formatProdErrorMessage(314));
        }
        null !== retryCache && retryCache.delete(wakeable);
        retryTimedOutBoundary(boundaryFiber, retryLane);
      }
      __name(resolveRetryWakeable, "resolveRetryWakeable");
      function scheduleCallback(priorityLevel, callback) {
        return scheduleCallback$3(priorityLevel, callback);
      }
      __name(scheduleCallback, "scheduleCallback");
      function FiberNode(tag, pendingProps, key, mode) {
        this.tag = tag;
        this.key = key;
        this.sibling = this.child = this.return = this.stateNode = this.type = this.elementType = null;
        this.index = 0;
        this.refCleanup = this.ref = null;
        this.pendingProps = pendingProps;
        this.dependencies = this.memoizedState = this.updateQueue = this.memoizedProps = null;
        this.mode = mode;
        this.subtreeFlags = this.flags = 0;
        this.deletions = null;
        this.childLanes = this.lanes = 0;
        this.alternate = null;
      }
      __name(FiberNode, "FiberNode");
      function shouldConstruct(Component) {
        Component = Component.prototype;
        return !(!Component || !Component.isReactComponent);
      }
      __name(shouldConstruct, "shouldConstruct");
      function createWorkInProgress(current, pendingProps) {
        var workInProgress2 = current.alternate;
        null === workInProgress2 ? (workInProgress2 = createFiber(
          current.tag,
          pendingProps,
          current.key,
          current.mode
        ), workInProgress2.elementType = current.elementType, workInProgress2.type = current.type, workInProgress2.stateNode = current.stateNode, workInProgress2.alternate = current, current.alternate = workInProgress2) : (workInProgress2.pendingProps = pendingProps, workInProgress2.type = current.type, workInProgress2.flags = 0, workInProgress2.subtreeFlags = 0, workInProgress2.deletions = null);
        workInProgress2.flags = current.flags & 65011712;
        workInProgress2.childLanes = current.childLanes;
        workInProgress2.lanes = current.lanes;
        workInProgress2.child = current.child;
        workInProgress2.memoizedProps = current.memoizedProps;
        workInProgress2.memoizedState = current.memoizedState;
        workInProgress2.updateQueue = current.updateQueue;
        pendingProps = current.dependencies;
        workInProgress2.dependencies = null === pendingProps ? null : {
          lanes: pendingProps.lanes,
          firstContext: pendingProps.firstContext
        };
        workInProgress2.sibling = current.sibling;
        workInProgress2.index = current.index;
        workInProgress2.ref = current.ref;
        workInProgress2.refCleanup = current.refCleanup;
        return workInProgress2;
      }
      __name(createWorkInProgress, "createWorkInProgress");
      function resetWorkInProgress(workInProgress2, renderLanes2) {
        workInProgress2.flags &= 65011714;
        var current = workInProgress2.alternate;
        null === current ? (workInProgress2.childLanes = 0, workInProgress2.lanes = renderLanes2, workInProgress2.child = null, workInProgress2.subtreeFlags = 0, workInProgress2.memoizedProps = null, workInProgress2.memoizedState = null, workInProgress2.updateQueue = null, workInProgress2.dependencies = null, workInProgress2.stateNode = null) : (workInProgress2.childLanes = current.childLanes, workInProgress2.lanes = current.lanes, workInProgress2.child = current.child, workInProgress2.subtreeFlags = 0, workInProgress2.deletions = null, workInProgress2.memoizedProps = current.memoizedProps, workInProgress2.memoizedState = current.memoizedState, workInProgress2.updateQueue = current.updateQueue, workInProgress2.type = current.type, renderLanes2 = current.dependencies, workInProgress2.dependencies = null === renderLanes2 ? null : {
          lanes: renderLanes2.lanes,
          firstContext: renderLanes2.firstContext
        });
        return workInProgress2;
      }
      __name(resetWorkInProgress, "resetWorkInProgress");
      function createFiberFromTypeAndProps(type, key, pendingProps, owner, mode, lanes) {
        var fiberTag = 0;
        owner = type;
        if ("function" === typeof type) shouldConstruct(type) && (fiberTag = 1);
        else if ("string" === typeof type)
          fiberTag = supportsResources && supportsSingletons ? isHostHoistableType(type, pendingProps, contextStackCursor.current) ? 26 : isHostSingletonType(type) ? 27 : 5 : supportsResources ? isHostHoistableType(
            type,
            pendingProps,
            contextStackCursor.current
          ) ? 26 : 5 : supportsSingletons ? isHostSingletonType(type) ? 27 : 5 : 5;
        else
          a: switch (type) {
            case REACT_ACTIVITY_TYPE:
              return type = createFiber(31, pendingProps, key, mode), type.elementType = REACT_ACTIVITY_TYPE, type.lanes = lanes, type;
            case REACT_FRAGMENT_TYPE:
              return createFiberFromFragment(
                pendingProps.children,
                mode,
                lanes,
                key
              );
            case REACT_STRICT_MODE_TYPE:
              fiberTag = 8;
              mode |= 24;
              break;
            case REACT_PROFILER_TYPE:
              return type = createFiber(12, pendingProps, key, mode | 2), type.elementType = REACT_PROFILER_TYPE, type.lanes = lanes, type;
            case REACT_SUSPENSE_TYPE:
              return type = createFiber(13, pendingProps, key, mode), type.elementType = REACT_SUSPENSE_TYPE, type.lanes = lanes, type;
            case REACT_SUSPENSE_LIST_TYPE:
              return type = createFiber(19, pendingProps, key, mode), type.elementType = REACT_SUSPENSE_LIST_TYPE, type.lanes = lanes, type;
            default:
              if ("object" === typeof type && null !== type)
                switch (type.$$typeof) {
                  case REACT_CONTEXT_TYPE:
                    fiberTag = 10;
                    break a;
                  case REACT_CONSUMER_TYPE:
                    fiberTag = 9;
                    break a;
                  case REACT_FORWARD_REF_TYPE:
                    fiberTag = 11;
                    break a;
                  case REACT_MEMO_TYPE:
                    fiberTag = 14;
                    break a;
                  case REACT_LAZY_TYPE:
                    fiberTag = 16;
                    owner = null;
                    break a;
                }
              fiberTag = 29;
              pendingProps = Error(
                formatProdErrorMessage(
                  130,
                  null === type ? "null" : typeof type,
                  ""
                )
              );
              owner = null;
          }
        key = createFiber(fiberTag, pendingProps, key, mode);
        key.elementType = type;
        key.type = owner;
        key.lanes = lanes;
        return key;
      }
      __name(createFiberFromTypeAndProps, "createFiberFromTypeAndProps");
      function createFiberFromFragment(elements, mode, lanes, key) {
        elements = createFiber(7, elements, key, mode);
        elements.lanes = lanes;
        return elements;
      }
      __name(createFiberFromFragment, "createFiberFromFragment");
      function createFiberFromText(content, mode, lanes) {
        content = createFiber(6, content, null, mode);
        content.lanes = lanes;
        return content;
      }
      __name(createFiberFromText, "createFiberFromText");
      function createFiberFromDehydratedFragment(dehydratedNode) {
        var fiber = createFiber(18, null, null, 0);
        fiber.stateNode = dehydratedNode;
        return fiber;
      }
      __name(createFiberFromDehydratedFragment, "createFiberFromDehydratedFragment");
      function createFiberFromPortal(portal, mode, lanes) {
        mode = createFiber(
          4,
          null !== portal.children ? portal.children : [],
          portal.key,
          mode
        );
        mode.lanes = lanes;
        mode.stateNode = {
          containerInfo: portal.containerInfo,
          pendingChildren: null,
          implementation: portal.implementation
        };
        return mode;
      }
      __name(createFiberFromPortal, "createFiberFromPortal");
      function FiberRootNode(containerInfo, tag, hydrate, identifierPrefix, onUncaughtError, onCaughtError, onRecoverableError, onDefaultTransitionIndicator, formState) {
        this.tag = 1;
        this.containerInfo = containerInfo;
        this.pingCache = this.current = this.pendingChildren = null;
        this.timeoutHandle = noTimeout;
        this.callbackNode = this.next = this.pendingContext = this.context = this.cancelPendingCommit = null;
        this.callbackPriority = 0;
        this.expirationTimes = createLaneMap(-1);
        this.entangledLanes = this.shellSuspendCounter = this.errorRecoveryDisabledLanes = this.expiredLanes = this.warmLanes = this.pingedLanes = this.suspendedLanes = this.pendingLanes = 0;
        this.entanglements = createLaneMap(0);
        this.hiddenUpdates = createLaneMap(null);
        this.identifierPrefix = identifierPrefix;
        this.onUncaughtError = onUncaughtError;
        this.onCaughtError = onCaughtError;
        this.onRecoverableError = onRecoverableError;
        this.pooledCache = null;
        this.pooledCacheLanes = 0;
        this.formState = formState;
        this.incompleteTransitions = /* @__PURE__ */ new Map();
      }
      __name(FiberRootNode, "FiberRootNode");
      function createFiberRoot(containerInfo, tag, hydrate, initialChildren, hydrationCallbacks, isStrictMode, identifierPrefix, formState, onUncaughtError, onCaughtError, onRecoverableError, onDefaultTransitionIndicator) {
        containerInfo = new FiberRootNode(
          containerInfo,
          tag,
          hydrate,
          identifierPrefix,
          onUncaughtError,
          onCaughtError,
          onRecoverableError,
          onDefaultTransitionIndicator,
          formState
        );
        tag = 1;
        true === isStrictMode && (tag |= 24);
        isStrictMode = createFiber(3, null, null, tag);
        containerInfo.current = isStrictMode;
        isStrictMode.stateNode = containerInfo;
        tag = createCache();
        tag.refCount++;
        containerInfo.pooledCache = tag;
        tag.refCount++;
        isStrictMode.memoizedState = {
          element: initialChildren,
          isDehydrated: hydrate,
          cache: tag
        };
        initializeUpdateQueue(isStrictMode);
        return containerInfo;
      }
      __name(createFiberRoot, "createFiberRoot");
      function getContextForSubtree(parentComponent) {
        if (!parentComponent) return emptyContextObject;
        parentComponent = emptyContextObject;
        return parentComponent;
      }
      __name(getContextForSubtree, "getContextForSubtree");
      function findHostInstance(component) {
        var fiber = component._reactInternals;
        if (void 0 === fiber) {
          if ("function" === typeof component.render)
            throw Error(formatProdErrorMessage(188));
          component = Object.keys(component).join(",");
          throw Error(formatProdErrorMessage(268, component));
        }
        component = findCurrentFiberUsingSlowPath(fiber);
        component = null !== component ? findCurrentHostFiberImpl(component) : null;
        return null === component ? null : getPublicInstance(component.stateNode);
      }
      __name(findHostInstance, "findHostInstance");
      function updateContainerImpl(rootFiber, lane, element, container, parentComponent, callback) {
        parentComponent = getContextForSubtree(parentComponent);
        null === container.context ? container.context = parentComponent : container.pendingContext = parentComponent;
        container = createUpdate(lane);
        container.payload = { element };
        callback = void 0 === callback ? null : callback;
        null !== callback && (container.callback = callback);
        element = enqueueUpdate(rootFiber, container, lane);
        null !== element && (scheduleUpdateOnFiber(element, rootFiber, lane), entangleTransitions(element, rootFiber, lane));
      }
      __name(updateContainerImpl, "updateContainerImpl");
      function markRetryLaneImpl(fiber, retryLane) {
        fiber = fiber.memoizedState;
        if (null !== fiber && null !== fiber.dehydrated) {
          var a = fiber.retryLane;
          fiber.retryLane = 0 !== a && a < retryLane ? a : retryLane;
        }
      }
      __name(markRetryLaneImpl, "markRetryLaneImpl");
      function markRetryLaneIfNotHydrated(fiber, retryLane) {
        markRetryLaneImpl(fiber, retryLane);
        (fiber = fiber.alternate) && markRetryLaneImpl(fiber, retryLane);
      }
      __name(markRetryLaneIfNotHydrated, "markRetryLaneIfNotHydrated");
      var exports2 = {};
      "use strict";
      var React11 = require_react(), Scheduler2 = require_scheduler(), assign = Object.assign, REACT_LEGACY_ELEMENT_TYPE = Symbol.for("react.element"), REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element"), REACT_PORTAL_TYPE = Symbol.for("react.portal"), REACT_FRAGMENT_TYPE = Symbol.for("react.fragment"), REACT_STRICT_MODE_TYPE = Symbol.for("react.strict_mode"), REACT_PROFILER_TYPE = Symbol.for("react.profiler"), REACT_CONSUMER_TYPE = Symbol.for("react.consumer"), REACT_CONTEXT_TYPE = Symbol.for("react.context"), REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref"), REACT_SUSPENSE_TYPE = Symbol.for("react.suspense"), REACT_SUSPENSE_LIST_TYPE = Symbol.for("react.suspense_list"), REACT_MEMO_TYPE = Symbol.for("react.memo"), REACT_LAZY_TYPE = Symbol.for("react.lazy");
      Symbol.for("react.scope");
      var REACT_ACTIVITY_TYPE = Symbol.for("react.activity");
      Symbol.for("react.legacy_hidden");
      Symbol.for("react.tracing_marker");
      var REACT_MEMO_CACHE_SENTINEL = Symbol.for("react.memo_cache_sentinel");
      Symbol.for("react.view_transition");
      var MAYBE_ITERATOR_SYMBOL = Symbol.iterator, REACT_CLIENT_REFERENCE = Symbol.for("react.client.reference"), isArrayImpl = Array.isArray, ReactSharedInternals = React11.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, rendererVersion = $$$config.rendererVersion, rendererPackageName = $$$config.rendererPackageName, extraDevToolsConfig = $$$config.extraDevToolsConfig, getPublicInstance = $$$config.getPublicInstance, getRootHostContext = $$$config.getRootHostContext, getChildHostContext = $$$config.getChildHostContext, prepareForCommit = $$$config.prepareForCommit, resetAfterCommit = $$$config.resetAfterCommit, createInstance = $$$config.createInstance;
      $$$config.cloneMutableInstance;
      var appendInitialChild = $$$config.appendInitialChild, finalizeInitialChildren = $$$config.finalizeInitialChildren, shouldSetTextContent = $$$config.shouldSetTextContent, createTextInstance = $$$config.createTextInstance;
      $$$config.cloneMutableTextInstance;
      var scheduleTimeout = $$$config.scheduleTimeout, cancelTimeout = $$$config.cancelTimeout, noTimeout = $$$config.noTimeout, isPrimaryRenderer = $$$config.isPrimaryRenderer;
      $$$config.warnsIfNotActing;
      var supportsMutation = $$$config.supportsMutation, supportsPersistence = $$$config.supportsPersistence, supportsHydration = $$$config.supportsHydration, getInstanceFromNode = $$$config.getInstanceFromNode;
      $$$config.beforeActiveInstanceBlur;
      var preparePortalMount = $$$config.preparePortalMount;
      $$$config.prepareScopeUpdate;
      $$$config.getInstanceFromScope;
      var setCurrentUpdatePriority = $$$config.setCurrentUpdatePriority, getCurrentUpdatePriority = $$$config.getCurrentUpdatePriority, resolveUpdatePriority = $$$config.resolveUpdatePriority;
      $$$config.trackSchedulerEvent;
      $$$config.resolveEventType;
      $$$config.resolveEventTimeStamp;
      var shouldAttemptEagerTransition = $$$config.shouldAttemptEagerTransition, detachDeletedInstance = $$$config.detachDeletedInstance;
      $$$config.requestPostPaintCallback;
      var maySuspendCommit = $$$config.maySuspendCommit, maySuspendCommitOnUpdate = $$$config.maySuspendCommitOnUpdate, maySuspendCommitInSyncRender = $$$config.maySuspendCommitInSyncRender, preloadInstance = $$$config.preloadInstance, startSuspendingCommit = $$$config.startSuspendingCommit, suspendInstance = $$$config.suspendInstance;
      $$$config.suspendOnActiveViewTransition;
      var waitForCommitToBeReady = $$$config.waitForCommitToBeReady;
      $$$config.getSuspendedCommitReason;
      var NotPendingTransition = $$$config.NotPendingTransition, HostTransitionContext = $$$config.HostTransitionContext, resetFormInstance = $$$config.resetFormInstance;
      $$$config.bindToConsole;
      var supportsMicrotasks = $$$config.supportsMicrotasks, scheduleMicrotask = $$$config.scheduleMicrotask, supportsTestSelectors = $$$config.supportsTestSelectors, findFiberRoot = $$$config.findFiberRoot, getBoundingRect = $$$config.getBoundingRect, getTextContent = $$$config.getTextContent, isHiddenSubtree = $$$config.isHiddenSubtree, matchAccessibilityRole = $$$config.matchAccessibilityRole, setFocusIfFocusable = $$$config.setFocusIfFocusable, setupIntersectionObserver = $$$config.setupIntersectionObserver, appendChild = $$$config.appendChild, appendChildToContainer = $$$config.appendChildToContainer, commitTextUpdate = $$$config.commitTextUpdate, commitMount = $$$config.commitMount, commitUpdate = $$$config.commitUpdate, insertBefore = $$$config.insertBefore, insertInContainerBefore = $$$config.insertInContainerBefore, removeChild = $$$config.removeChild, removeChildFromContainer = $$$config.removeChildFromContainer, resetTextContent = $$$config.resetTextContent, hideInstance = $$$config.hideInstance, hideTextInstance = $$$config.hideTextInstance, unhideInstance = $$$config.unhideInstance, unhideTextInstance = $$$config.unhideTextInstance;
      $$$config.cancelViewTransitionName;
      $$$config.cancelRootViewTransitionName;
      $$$config.restoreRootViewTransitionName;
      $$$config.cloneRootViewTransitionContainer;
      $$$config.removeRootViewTransitionClone;
      $$$config.measureClonedInstance;
      $$$config.hasInstanceChanged;
      $$$config.hasInstanceAffectedParent;
      $$$config.startViewTransition;
      $$$config.startGestureTransition;
      $$$config.stopViewTransition;
      $$$config.getCurrentGestureOffset;
      $$$config.createViewTransitionInstance;
      var clearContainer = $$$config.clearContainer;
      $$$config.createFragmentInstance;
      $$$config.updateFragmentInstanceFiber;
      $$$config.commitNewChildToFragmentInstance;
      $$$config.deleteChildFromFragmentInstance;
      var cloneInstance = $$$config.cloneInstance, createContainerChildSet = $$$config.createContainerChildSet, appendChildToContainerChildSet = $$$config.appendChildToContainerChildSet, finalizeContainerChildren = $$$config.finalizeContainerChildren, replaceContainerChildren = $$$config.replaceContainerChildren, cloneHiddenInstance = $$$config.cloneHiddenInstance, cloneHiddenTextInstance = $$$config.cloneHiddenTextInstance, isSuspenseInstancePending = $$$config.isSuspenseInstancePending, isSuspenseInstanceFallback = $$$config.isSuspenseInstanceFallback, getSuspenseInstanceFallbackErrorDetails = $$$config.getSuspenseInstanceFallbackErrorDetails, registerSuspenseInstanceRetry = $$$config.registerSuspenseInstanceRetry, canHydrateFormStateMarker = $$$config.canHydrateFormStateMarker, isFormStateMarkerMatching = $$$config.isFormStateMarkerMatching, getNextHydratableSibling = $$$config.getNextHydratableSibling, getNextHydratableSiblingAfterSingleton = $$$config.getNextHydratableSiblingAfterSingleton, getFirstHydratableChild = $$$config.getFirstHydratableChild, getFirstHydratableChildWithinContainer = $$$config.getFirstHydratableChildWithinContainer, getFirstHydratableChildWithinActivityInstance = $$$config.getFirstHydratableChildWithinActivityInstance, getFirstHydratableChildWithinSuspenseInstance = $$$config.getFirstHydratableChildWithinSuspenseInstance, getFirstHydratableChildWithinSingleton = $$$config.getFirstHydratableChildWithinSingleton, canHydrateInstance = $$$config.canHydrateInstance, canHydrateTextInstance = $$$config.canHydrateTextInstance, canHydrateActivityInstance = $$$config.canHydrateActivityInstance, canHydrateSuspenseInstance = $$$config.canHydrateSuspenseInstance, hydrateInstance = $$$config.hydrateInstance, hydrateTextInstance = $$$config.hydrateTextInstance, hydrateActivityInstance = $$$config.hydrateActivityInstance, hydrateSuspenseInstance = $$$config.hydrateSuspenseInstance, getNextHydratableInstanceAfterActivityInstance = $$$config.getNextHydratableInstanceAfterActivityInstance, getNextHydratableInstanceAfterSuspenseInstance = $$$config.getNextHydratableInstanceAfterSuspenseInstance, commitHydratedInstance = $$$config.commitHydratedInstance, commitHydratedContainer = $$$config.commitHydratedContainer, commitHydratedActivityInstance = $$$config.commitHydratedActivityInstance, commitHydratedSuspenseInstance = $$$config.commitHydratedSuspenseInstance, finalizeHydratedChildren = $$$config.finalizeHydratedChildren, flushHydrationEvents = $$$config.flushHydrationEvents;
      $$$config.clearActivityBoundary;
      var clearSuspenseBoundary = $$$config.clearSuspenseBoundary;
      $$$config.clearActivityBoundaryFromContainer;
      var clearSuspenseBoundaryFromContainer = $$$config.clearSuspenseBoundaryFromContainer, hideDehydratedBoundary = $$$config.hideDehydratedBoundary, unhideDehydratedBoundary = $$$config.unhideDehydratedBoundary, shouldDeleteUnhydratedTailInstances = $$$config.shouldDeleteUnhydratedTailInstances;
      $$$config.diffHydratedPropsForDevWarnings;
      $$$config.diffHydratedTextForDevWarnings;
      $$$config.describeHydratableInstanceForDevWarnings;
      var validateHydratableInstance = $$$config.validateHydratableInstance, validateHydratableTextInstance = $$$config.validateHydratableTextInstance, supportsResources = $$$config.supportsResources, isHostHoistableType = $$$config.isHostHoistableType, getHoistableRoot = $$$config.getHoistableRoot, getResource = $$$config.getResource, acquireResource = $$$config.acquireResource, releaseResource = $$$config.releaseResource, hydrateHoistable = $$$config.hydrateHoistable, mountHoistable = $$$config.mountHoistable, unmountHoistable = $$$config.unmountHoistable, createHoistableInstance = $$$config.createHoistableInstance, prepareToCommitHoistables = $$$config.prepareToCommitHoistables, mayResourceSuspendCommit = $$$config.mayResourceSuspendCommit, preloadResource = $$$config.preloadResource, suspendResource = $$$config.suspendResource, supportsSingletons = $$$config.supportsSingletons, resolveSingletonInstance = $$$config.resolveSingletonInstance, acquireSingletonInstance = $$$config.acquireSingletonInstance, releaseSingletonInstance = $$$config.releaseSingletonInstance, isHostSingletonType = $$$config.isHostSingletonType, isSingletonScope = $$$config.isSingletonScope, valueStack = [], index$jscomp$0 = -1, emptyContextObject = {}, clz32 = Math.clz32 ? Math.clz32 : clz32Fallback, log$1 = Math.log, LN2 = Math.LN2, nextTransitionUpdateLane = 256, nextTransitionDeferredLane = 262144, nextRetryLane = 4194304, scheduleCallback$3 = Scheduler2.unstable_scheduleCallback, cancelCallback$1 = Scheduler2.unstable_cancelCallback, shouldYield = Scheduler2.unstable_shouldYield, requestPaint = Scheduler2.unstable_requestPaint, now = Scheduler2.unstable_now, ImmediatePriority = Scheduler2.unstable_ImmediatePriority, UserBlockingPriority = Scheduler2.unstable_UserBlockingPriority, NormalPriority$1 = Scheduler2.unstable_NormalPriority, IdlePriority = Scheduler2.unstable_IdlePriority, log = Scheduler2.log, unstable_setDisableYieldValue = Scheduler2.unstable_setDisableYieldValue, rendererID = null, injectedHook = null, objectIs = "function" === typeof Object.is ? Object.is : is, reportGlobalError = "function" === typeof reportError ? reportError : function(error) {
        if ("object" === typeof window && "function" === typeof window.ErrorEvent) {
          var event = new window.ErrorEvent("error", {
            bubbles: true,
            cancelable: true,
            message: "object" === typeof error && null !== error && "string" === typeof error.message ? String(error.message) : String(error),
            error
          });
          if (!window.dispatchEvent(event)) return;
        } else if ("object" === typeof process && "function" === typeof process.emit) {
          process.emit("uncaughtException", error);
          return;
        }
        console.error(error);
      }, hasOwnProperty = Object.prototype.hasOwnProperty, prefix, suffix, reentry = false, CapturedStacks = /* @__PURE__ */ new WeakMap(), forkStack = [], forkStackIndex = 0, treeForkProvider = null, treeForkCount = 0, idStack = [], idStackIndex = 0, treeContextProvider = null, treeContextId = 1, treeContextOverflow = "", contextStackCursor = createCursor(null), contextFiberStackCursor = createCursor(null), rootInstanceStackCursor = createCursor(null), hostTransitionProviderCursor = createCursor(null), hydrationParentFiber = null, nextHydratableInstance = null, isHydrating = false, hydrationErrors = null, rootOrSingletonContext = false, HydrationMismatchException = Error(formatProdErrorMessage(519)), valueCursor = createCursor(null), currentlyRenderingFiber$1 = null, lastContextDependency = null, AbortControllerLocal = "undefined" !== typeof AbortController ? AbortController : function() {
        var listeners = [], signal = this.signal = {
          aborted: false,
          addEventListener: /* @__PURE__ */ __name(function(type, listener) {
            listeners.push(listener);
          }, "addEventListener")
        };
        this.abort = function() {
          signal.aborted = true;
          listeners.forEach(function(listener) {
            return listener();
          });
        };
      }, scheduleCallback$2 = Scheduler2.unstable_scheduleCallback, NormalPriority = Scheduler2.unstable_NormalPriority, CacheContext = {
        $$typeof: REACT_CONTEXT_TYPE,
        Consumer: null,
        Provider: null,
        _currentValue: null,
        _currentValue2: null,
        _threadCount: 0
      }, firstScheduledRoot = null, lastScheduledRoot = null, didScheduleMicrotask = false, mightHavePendingSyncWork = false, isFlushingWork = false, currentEventTransitionLane = 0, currentEntangledListeners = null, currentEntangledPendingCount = 0, currentEntangledLane = 0, currentEntangledActionThenable = null, prevOnStartTransitionFinish = ReactSharedInternals.S;
      ReactSharedInternals.S = function(transition, returnValue) {
        globalMostRecentTransitionTime = now();
        "object" === typeof returnValue && null !== returnValue && "function" === typeof returnValue.then && entangleAsyncAction(transition, returnValue);
        null !== prevOnStartTransitionFinish && prevOnStartTransitionFinish(transition, returnValue);
      };
      var resumedCache = createCursor(null), SuspenseException = Error(formatProdErrorMessage(460)), SuspenseyCommitException = Error(formatProdErrorMessage(474)), SuspenseActionException = Error(formatProdErrorMessage(542)), noopSuspenseyCommitThenable = { then: /* @__PURE__ */ __name(function() {
      }, "then") }, suspendedThenable = null, thenableState$1 = null, thenableIndexCounter$1 = 0, reconcileChildFibers = createChildReconciler(true), mountChildFibers = createChildReconciler(false), concurrentQueues = [], concurrentQueuesIndex = 0, concurrentlyUpdatedLanes = 0, hasForceUpdate = false, didReadFromEntangledAsyncAction = false, currentTreeHiddenStackCursor = createCursor(null), prevEntangledRenderLanesCursor = createCursor(0), suspenseHandlerStackCursor = createCursor(null), shellBoundary = null, suspenseStackCursor = createCursor(0), renderLanes = 0, currentlyRenderingFiber = null, currentHook = null, workInProgressHook = null, didScheduleRenderPhaseUpdate = false, didScheduleRenderPhaseUpdateDuringThisPass = false, shouldDoubleInvokeUserFnsInHooksDEV = false, localIdCounter = 0, thenableIndexCounter = 0, thenableState = null, globalClientIdCounter = 0, ContextOnlyDispatcher = {
        readContext,
        use,
        useCallback: throwInvalidHookError,
        useContext: throwInvalidHookError,
        useEffect: throwInvalidHookError,
        useImperativeHandle: throwInvalidHookError,
        useLayoutEffect: throwInvalidHookError,
        useInsertionEffect: throwInvalidHookError,
        useMemo: throwInvalidHookError,
        useReducer: throwInvalidHookError,
        useRef: throwInvalidHookError,
        useState: throwInvalidHookError,
        useDebugValue: throwInvalidHookError,
        useDeferredValue: throwInvalidHookError,
        useTransition: throwInvalidHookError,
        useSyncExternalStore: throwInvalidHookError,
        useId: throwInvalidHookError,
        useHostTransitionStatus: throwInvalidHookError,
        useFormState: throwInvalidHookError,
        useActionState: throwInvalidHookError,
        useOptimistic: throwInvalidHookError,
        useMemoCache: throwInvalidHookError,
        useCacheRefresh: throwInvalidHookError
      };
      ContextOnlyDispatcher.useEffectEvent = throwInvalidHookError;
      var HooksDispatcherOnMount = {
        readContext,
        use,
        useCallback: /* @__PURE__ */ __name(function(callback, deps) {
          mountWorkInProgressHook().memoizedState = [
            callback,
            void 0 === deps ? null : deps
          ];
          return callback;
        }, "useCallback"),
        useContext: readContext,
        useEffect: mountEffect,
        useImperativeHandle: /* @__PURE__ */ __name(function(ref, create3, deps) {
          deps = null !== deps && void 0 !== deps ? deps.concat([ref]) : null;
          mountEffectImpl(
            4194308,
            4,
            imperativeHandleEffect.bind(null, create3, ref),
            deps
          );
        }, "useImperativeHandle"),
        useLayoutEffect: /* @__PURE__ */ __name(function(create3, deps) {
          return mountEffectImpl(4194308, 4, create3, deps);
        }, "useLayoutEffect"),
        useInsertionEffect: /* @__PURE__ */ __name(function(create3, deps) {
          mountEffectImpl(4, 2, create3, deps);
        }, "useInsertionEffect"),
        useMemo: /* @__PURE__ */ __name(function(nextCreate, deps) {
          var hook = mountWorkInProgressHook();
          deps = void 0 === deps ? null : deps;
          var nextValue = nextCreate();
          if (shouldDoubleInvokeUserFnsInHooksDEV) {
            setIsStrictModeForDevtools(true);
            try {
              nextCreate();
            } finally {
              setIsStrictModeForDevtools(false);
            }
          }
          hook.memoizedState = [nextValue, deps];
          return nextValue;
        }, "useMemo"),
        useReducer: /* @__PURE__ */ __name(function(reducer, initialArg, init) {
          var hook = mountWorkInProgressHook();
          if (void 0 !== init) {
            var initialState = init(initialArg);
            if (shouldDoubleInvokeUserFnsInHooksDEV) {
              setIsStrictModeForDevtools(true);
              try {
                init(initialArg);
              } finally {
                setIsStrictModeForDevtools(false);
              }
            }
          } else initialState = initialArg;
          hook.memoizedState = hook.baseState = initialState;
          reducer = {
            pending: null,
            lanes: 0,
            dispatch: null,
            lastRenderedReducer: reducer,
            lastRenderedState: initialState
          };
          hook.queue = reducer;
          reducer = reducer.dispatch = dispatchReducerAction.bind(
            null,
            currentlyRenderingFiber,
            reducer
          );
          return [hook.memoizedState, reducer];
        }, "useReducer"),
        useRef: /* @__PURE__ */ __name(function(initialValue) {
          var hook = mountWorkInProgressHook();
          initialValue = { current: initialValue };
          return hook.memoizedState = initialValue;
        }, "useRef"),
        useState: /* @__PURE__ */ __name(function(initialState) {
          initialState = mountStateImpl(initialState);
          var queue = initialState.queue, dispatch = dispatchSetState.bind(
            null,
            currentlyRenderingFiber,
            queue
          );
          queue.dispatch = dispatch;
          return [initialState.memoizedState, dispatch];
        }, "useState"),
        useDebugValue: mountDebugValue,
        useDeferredValue: /* @__PURE__ */ __name(function(value, initialValue) {
          var hook = mountWorkInProgressHook();
          return mountDeferredValueImpl(hook, value, initialValue);
        }, "useDeferredValue"),
        useTransition: /* @__PURE__ */ __name(function() {
          var stateHook = mountStateImpl(false);
          stateHook = startTransition.bind(
            null,
            currentlyRenderingFiber,
            stateHook.queue,
            true,
            false
          );
          mountWorkInProgressHook().memoizedState = stateHook;
          return [false, stateHook];
        }, "useTransition"),
        useSyncExternalStore: /* @__PURE__ */ __name(function(subscribe, getSnapshot, getServerSnapshot) {
          var fiber = currentlyRenderingFiber, hook = mountWorkInProgressHook();
          if (isHydrating) {
            if (void 0 === getServerSnapshot)
              throw Error(formatProdErrorMessage(407));
            getServerSnapshot = getServerSnapshot();
          } else {
            getServerSnapshot = getSnapshot();
            if (null === workInProgressRoot)
              throw Error(formatProdErrorMessage(349));
            0 !== (workInProgressRootRenderLanes & 127) || pushStoreConsistencyCheck(fiber, getSnapshot, getServerSnapshot);
          }
          hook.memoizedState = getServerSnapshot;
          var inst = { value: getServerSnapshot, getSnapshot };
          hook.queue = inst;
          mountEffect(subscribeToStore.bind(null, fiber, inst, subscribe), [
            subscribe
          ]);
          fiber.flags |= 2048;
          pushSimpleEffect(
            9,
            { destroy: void 0 },
            updateStoreInstance.bind(
              null,
              fiber,
              inst,
              getServerSnapshot,
              getSnapshot
            ),
            null
          );
          return getServerSnapshot;
        }, "useSyncExternalStore"),
        useId: /* @__PURE__ */ __name(function() {
          var hook = mountWorkInProgressHook(), identifierPrefix = workInProgressRoot.identifierPrefix;
          if (isHydrating) {
            var JSCompiler_inline_result = treeContextOverflow;
            var idWithLeadingBit = treeContextId;
            JSCompiler_inline_result = (idWithLeadingBit & ~(1 << 32 - clz32(idWithLeadingBit) - 1)).toString(32) + JSCompiler_inline_result;
            identifierPrefix = "_" + identifierPrefix + "R_" + JSCompiler_inline_result;
            JSCompiler_inline_result = localIdCounter++;
            0 < JSCompiler_inline_result && (identifierPrefix += "H" + JSCompiler_inline_result.toString(32));
            identifierPrefix += "_";
          } else
            JSCompiler_inline_result = globalClientIdCounter++, identifierPrefix = "_" + identifierPrefix + "r_" + JSCompiler_inline_result.toString(32) + "_";
          return hook.memoizedState = identifierPrefix;
        }, "useId"),
        useHostTransitionStatus,
        useFormState: mountActionState,
        useActionState: mountActionState,
        useOptimistic: /* @__PURE__ */ __name(function(passthrough) {
          var hook = mountWorkInProgressHook();
          hook.memoizedState = hook.baseState = passthrough;
          var queue = {
            pending: null,
            lanes: 0,
            dispatch: null,
            lastRenderedReducer: null,
            lastRenderedState: null
          };
          hook.queue = queue;
          hook = dispatchOptimisticSetState.bind(
            null,
            currentlyRenderingFiber,
            true,
            queue
          );
          queue.dispatch = hook;
          return [passthrough, hook];
        }, "useOptimistic"),
        useMemoCache,
        useCacheRefresh: /* @__PURE__ */ __name(function() {
          return mountWorkInProgressHook().memoizedState = refreshCache.bind(
            null,
            currentlyRenderingFiber
          );
        }, "useCacheRefresh"),
        useEffectEvent: /* @__PURE__ */ __name(function(callback) {
          var hook = mountWorkInProgressHook(), ref = { impl: callback };
          hook.memoizedState = ref;
          return function() {
            if (0 !== (executionContext & 2))
              throw Error(formatProdErrorMessage(440));
            return ref.impl.apply(void 0, arguments);
          };
        }, "useEffectEvent")
      }, HooksDispatcherOnUpdate = {
        readContext,
        use,
        useCallback: updateCallback,
        useContext: readContext,
        useEffect: updateEffect,
        useImperativeHandle: updateImperativeHandle,
        useInsertionEffect: updateInsertionEffect,
        useLayoutEffect: updateLayoutEffect,
        useMemo: updateMemo,
        useReducer: updateReducer,
        useRef: updateRef,
        useState: /* @__PURE__ */ __name(function() {
          return updateReducer(basicStateReducer);
        }, "useState"),
        useDebugValue: mountDebugValue,
        useDeferredValue: /* @__PURE__ */ __name(function(value, initialValue) {
          var hook = updateWorkInProgressHook();
          return updateDeferredValueImpl(
            hook,
            currentHook.memoizedState,
            value,
            initialValue
          );
        }, "useDeferredValue"),
        useTransition: /* @__PURE__ */ __name(function() {
          var booleanOrThenable = updateReducer(basicStateReducer)[0], start = updateWorkInProgressHook().memoizedState;
          return [
            "boolean" === typeof booleanOrThenable ? booleanOrThenable : useThenable(booleanOrThenable),
            start
          ];
        }, "useTransition"),
        useSyncExternalStore: updateSyncExternalStore,
        useId: updateId,
        useHostTransitionStatus,
        useFormState: updateActionState,
        useActionState: updateActionState,
        useOptimistic: /* @__PURE__ */ __name(function(passthrough, reducer) {
          var hook = updateWorkInProgressHook();
          return updateOptimisticImpl(hook, currentHook, passthrough, reducer);
        }, "useOptimistic"),
        useMemoCache,
        useCacheRefresh: updateRefresh
      };
      HooksDispatcherOnUpdate.useEffectEvent = updateEvent;
      var HooksDispatcherOnRerender = {
        readContext,
        use,
        useCallback: updateCallback,
        useContext: readContext,
        useEffect: updateEffect,
        useImperativeHandle: updateImperativeHandle,
        useInsertionEffect: updateInsertionEffect,
        useLayoutEffect: updateLayoutEffect,
        useMemo: updateMemo,
        useReducer: rerenderReducer,
        useRef: updateRef,
        useState: /* @__PURE__ */ __name(function() {
          return rerenderReducer(basicStateReducer);
        }, "useState"),
        useDebugValue: mountDebugValue,
        useDeferredValue: /* @__PURE__ */ __name(function(value, initialValue) {
          var hook = updateWorkInProgressHook();
          return null === currentHook ? mountDeferredValueImpl(hook, value, initialValue) : updateDeferredValueImpl(
            hook,
            currentHook.memoizedState,
            value,
            initialValue
          );
        }, "useDeferredValue"),
        useTransition: /* @__PURE__ */ __name(function() {
          var booleanOrThenable = rerenderReducer(basicStateReducer)[0], start = updateWorkInProgressHook().memoizedState;
          return [
            "boolean" === typeof booleanOrThenable ? booleanOrThenable : useThenable(booleanOrThenable),
            start
          ];
        }, "useTransition"),
        useSyncExternalStore: updateSyncExternalStore,
        useId: updateId,
        useHostTransitionStatus,
        useFormState: rerenderActionState,
        useActionState: rerenderActionState,
        useOptimistic: /* @__PURE__ */ __name(function(passthrough, reducer) {
          var hook = updateWorkInProgressHook();
          if (null !== currentHook)
            return updateOptimisticImpl(hook, currentHook, passthrough, reducer);
          hook.baseState = passthrough;
          return [passthrough, hook.queue.dispatch];
        }, "useOptimistic"),
        useMemoCache,
        useCacheRefresh: updateRefresh
      };
      HooksDispatcherOnRerender.useEffectEvent = updateEvent;
      var classComponentUpdater = {
        enqueueSetState: /* @__PURE__ */ __name(function(inst, payload, callback) {
          inst = inst._reactInternals;
          var lane = requestUpdateLane(), update = createUpdate(lane);
          update.payload = payload;
          void 0 !== callback && null !== callback && (update.callback = callback);
          payload = enqueueUpdate(inst, update, lane);
          null !== payload && (scheduleUpdateOnFiber(payload, inst, lane), entangleTransitions(payload, inst, lane));
        }, "enqueueSetState"),
        enqueueReplaceState: /* @__PURE__ */ __name(function(inst, payload, callback) {
          inst = inst._reactInternals;
          var lane = requestUpdateLane(), update = createUpdate(lane);
          update.tag = 1;
          update.payload = payload;
          void 0 !== callback && null !== callback && (update.callback = callback);
          payload = enqueueUpdate(inst, update, lane);
          null !== payload && (scheduleUpdateOnFiber(payload, inst, lane), entangleTransitions(payload, inst, lane));
        }, "enqueueReplaceState"),
        enqueueForceUpdate: /* @__PURE__ */ __name(function(inst, callback) {
          inst = inst._reactInternals;
          var lane = requestUpdateLane(), update = createUpdate(lane);
          update.tag = 2;
          void 0 !== callback && null !== callback && (update.callback = callback);
          callback = enqueueUpdate(inst, update, lane);
          null !== callback && (scheduleUpdateOnFiber(callback, inst, lane), entangleTransitions(callback, inst, lane));
        }, "enqueueForceUpdate")
      }, SelectiveHydrationException = Error(formatProdErrorMessage(461)), didReceiveUpdate = false, SUSPENDED_MARKER = {
        dehydrated: null,
        treeContext: null,
        retryLane: 0,
        hydrationErrors: null
      }, offscreenSubtreeIsHidden = false, offscreenSubtreeWasHidden = false, needsFormReset = false, PossiblyWeakSet = "function" === typeof WeakSet ? WeakSet : Set, nextEffect = null, hostParent = null, hostParentIsContainer = false, currentHoistableRoot = null, suspenseyCommitFlag = 8192, DefaultAsyncDispatcher = {
        getCacheForType: /* @__PURE__ */ __name(function(resourceType) {
          var cache3 = readContext(CacheContext), cacheForType = cache3.data.get(resourceType);
          void 0 === cacheForType && (cacheForType = resourceType(), cache3.data.set(resourceType, cacheForType));
          return cacheForType;
        }, "getCacheForType"),
        cacheSignal: /* @__PURE__ */ __name(function() {
          return readContext(CacheContext).controller.signal;
        }, "cacheSignal")
      }, COMPONENT_TYPE = 0, HAS_PSEUDO_CLASS_TYPE = 1, ROLE_TYPE = 2, TEST_NAME_TYPE = 3, TEXT_TYPE = 4;
      if ("function" === typeof Symbol && Symbol.for) {
        var symbolFor = Symbol.for;
        COMPONENT_TYPE = symbolFor("selector.component");
        HAS_PSEUDO_CLASS_TYPE = symbolFor("selector.has_pseudo_class");
        ROLE_TYPE = symbolFor("selector.role");
        TEST_NAME_TYPE = symbolFor("selector.test_id");
        TEXT_TYPE = symbolFor("selector.text");
      }
      var PossiblyWeakMap = "function" === typeof WeakMap ? WeakMap : Map, executionContext = 0, workInProgressRoot = null, workInProgress = null, workInProgressRootRenderLanes = 0, workInProgressSuspendedReason = 0, workInProgressThrownValue = null, workInProgressRootDidSkipSuspendedSiblings = false, workInProgressRootIsPrerendering = false, workInProgressRootDidAttachPingListener = false, entangledRenderLanes = 0, workInProgressRootExitStatus = 0, workInProgressRootSkippedLanes = 0, workInProgressRootInterleavedUpdatedLanes = 0, workInProgressRootPingedLanes = 0, workInProgressDeferredLane = 0, workInProgressSuspendedRetryLanes = 0, workInProgressRootConcurrentErrors = null, workInProgressRootRecoverableErrors = null, workInProgressRootDidIncludeRecursiveRenderUpdate = false, globalMostRecentFallbackTime = 0, globalMostRecentTransitionTime = 0, workInProgressRootRenderTargetTime = Infinity, workInProgressTransitions = null, legacyErrorBoundariesThatAlreadyFailed = null, pendingEffectsStatus = 0, pendingEffectsRoot = null, pendingFinishedWork = null, pendingEffectsLanes = 0, pendingEffectsRemainingLanes = 0, pendingPassiveTransitions = null, pendingRecoverableErrors = null, nestedUpdateCount = 0, rootWithNestedUpdates = null;
      exports2.attemptContinuousHydration = function(fiber) {
        if (13 === fiber.tag || 31 === fiber.tag) {
          var root = enqueueConcurrentRenderForLane(fiber, 67108864);
          null !== root && scheduleUpdateOnFiber(root, fiber, 67108864);
          markRetryLaneIfNotHydrated(fiber, 67108864);
        }
      };
      exports2.attemptHydrationAtCurrentPriority = function(fiber) {
        if (13 === fiber.tag || 31 === fiber.tag) {
          var lane = requestUpdateLane();
          lane = getBumpedLaneForHydrationByLane(lane);
          var root = enqueueConcurrentRenderForLane(fiber, lane);
          null !== root && scheduleUpdateOnFiber(root, fiber, lane);
          markRetryLaneIfNotHydrated(fiber, lane);
        }
      };
      exports2.attemptSynchronousHydration = function(fiber) {
        switch (fiber.tag) {
          case 3:
            fiber = fiber.stateNode;
            if (fiber.current.memoizedState.isDehydrated) {
              var lanes = getHighestPriorityLanes(fiber.pendingLanes);
              if (0 !== lanes) {
                fiber.pendingLanes |= 2;
                for (fiber.entangledLanes |= 2; lanes; ) {
                  var lane = 1 << 31 - clz32(lanes);
                  fiber.entanglements[1] |= lane;
                  lanes &= ~lane;
                }
                ensureRootIsScheduled(fiber);
                0 === (executionContext & 6) && (workInProgressRootRenderTargetTime = now() + 500, flushSyncWorkAcrossRoots_impl(0, false));
              }
            }
            break;
          case 31:
          case 13:
            lanes = enqueueConcurrentRenderForLane(fiber, 2), null !== lanes && scheduleUpdateOnFiber(lanes, fiber, 2), flushSyncWork(), markRetryLaneIfNotHydrated(fiber, 2);
        }
      };
      exports2.batchedUpdates = function(fn, a) {
        return fn(a);
      };
      exports2.createComponentSelector = function(component) {
        return { $$typeof: COMPONENT_TYPE, value: component };
      };
      exports2.createContainer = function(containerInfo, tag, hydrationCallbacks, isStrictMode, concurrentUpdatesByDefaultOverride, identifierPrefix, onUncaughtError, onCaughtError, onRecoverableError, onDefaultTransitionIndicator) {
        return createFiberRoot(
          containerInfo,
          tag,
          false,
          null,
          hydrationCallbacks,
          isStrictMode,
          identifierPrefix,
          null,
          onUncaughtError,
          onCaughtError,
          onRecoverableError,
          onDefaultTransitionIndicator
        );
      };
      exports2.createHasPseudoClassSelector = function(selectors) {
        return { $$typeof: HAS_PSEUDO_CLASS_TYPE, value: selectors };
      };
      exports2.createHydrationContainer = function(initialChildren, callback, containerInfo, tag, hydrationCallbacks, isStrictMode, concurrentUpdatesByDefaultOverride, identifierPrefix, onUncaughtError, onCaughtError, onRecoverableError, onDefaultTransitionIndicator, transitionCallbacks, formState) {
        initialChildren = createFiberRoot(
          containerInfo,
          tag,
          true,
          initialChildren,
          hydrationCallbacks,
          isStrictMode,
          identifierPrefix,
          formState,
          onUncaughtError,
          onCaughtError,
          onRecoverableError,
          onDefaultTransitionIndicator
        );
        initialChildren.context = getContextForSubtree(null);
        containerInfo = initialChildren.current;
        tag = requestUpdateLane();
        tag = getBumpedLaneForHydrationByLane(tag);
        hydrationCallbacks = createUpdate(tag);
        hydrationCallbacks.callback = void 0 !== callback && null !== callback ? callback : null;
        enqueueUpdate(containerInfo, hydrationCallbacks, tag);
        callback = tag;
        initialChildren.current.lanes = callback;
        markRootUpdated$1(initialChildren, callback);
        ensureRootIsScheduled(initialChildren);
        return initialChildren;
      };
      exports2.createPortal = function(children, containerInfo, implementation) {
        var key = 3 < arguments.length && void 0 !== arguments[3] ? arguments[3] : null;
        return {
          $$typeof: REACT_PORTAL_TYPE,
          key: null == key ? null : "" + key,
          children,
          containerInfo,
          implementation
        };
      };
      exports2.createRoleSelector = function(role) {
        return { $$typeof: ROLE_TYPE, value: role };
      };
      exports2.createTestNameSelector = function(id) {
        return { $$typeof: TEST_NAME_TYPE, value: id };
      };
      exports2.createTextSelector = function(text) {
        return { $$typeof: TEXT_TYPE, value: text };
      };
      exports2.defaultOnCaughtError = function(error) {
        console.error(error);
      };
      exports2.defaultOnRecoverableError = function(error) {
        reportGlobalError(error);
      };
      exports2.defaultOnUncaughtError = function(error) {
        reportGlobalError(error);
      };
      exports2.deferredUpdates = function(fn) {
        var prevTransition = ReactSharedInternals.T, previousPriority = getCurrentUpdatePriority();
        try {
          return setCurrentUpdatePriority(32), ReactSharedInternals.T = null, fn();
        } finally {
          setCurrentUpdatePriority(previousPriority), ReactSharedInternals.T = prevTransition;
        }
      };
      exports2.discreteUpdates = function(fn, a, b, c, d) {
        var prevTransition = ReactSharedInternals.T, previousPriority = getCurrentUpdatePriority();
        try {
          return setCurrentUpdatePriority(2), ReactSharedInternals.T = null, fn(a, b, c, d);
        } finally {
          setCurrentUpdatePriority(previousPriority), ReactSharedInternals.T = prevTransition, 0 === executionContext && (workInProgressRootRenderTargetTime = now() + 500);
        }
      };
      exports2.findAllNodes = findAllNodes;
      exports2.findBoundingRects = function(hostRoot, selectors) {
        if (!supportsTestSelectors) throw Error(formatProdErrorMessage(363));
        selectors = findAllNodes(hostRoot, selectors);
        hostRoot = [];
        for (var i = 0; i < selectors.length; i++)
          hostRoot.push(getBoundingRect(selectors[i]));
        for (selectors = hostRoot.length - 1; 0 < selectors; selectors--) {
          i = hostRoot[selectors];
          for (var targetLeft = i.x, targetRight = targetLeft + i.width, targetTop = i.y, targetBottom = targetTop + i.height, j = selectors - 1; 0 <= j; j--)
            if (selectors !== j) {
              var otherRect = hostRoot[j], otherLeft = otherRect.x, otherRight = otherLeft + otherRect.width, otherTop = otherRect.y, otherBottom = otherTop + otherRect.height;
              if (targetLeft >= otherLeft && targetTop >= otherTop && targetRight <= otherRight && targetBottom <= otherBottom) {
                hostRoot.splice(selectors, 1);
                break;
              } else if (!(targetLeft !== otherLeft || i.width !== otherRect.width || otherBottom < targetTop || otherTop > targetBottom)) {
                otherTop > targetTop && (otherRect.height += otherTop - targetTop, otherRect.y = targetTop);
                otherBottom < targetBottom && (otherRect.height = targetBottom - otherTop);
                hostRoot.splice(selectors, 1);
                break;
              } else if (!(targetTop !== otherTop || i.height !== otherRect.height || otherRight < targetLeft || otherLeft > targetRight)) {
                otherLeft > targetLeft && (otherRect.width += otherLeft - targetLeft, otherRect.x = targetLeft);
                otherRight < targetRight && (otherRect.width = targetRight - otherLeft);
                hostRoot.splice(selectors, 1);
                break;
              }
            }
        }
        return hostRoot;
      };
      exports2.findHostInstance = findHostInstance;
      exports2.findHostInstanceWithNoPortals = function(fiber) {
        fiber = findCurrentFiberUsingSlowPath(fiber);
        fiber = null !== fiber ? findCurrentHostFiberWithNoPortalsImpl(fiber) : null;
        return null === fiber ? null : getPublicInstance(fiber.stateNode);
      };
      exports2.findHostInstanceWithWarning = function(component) {
        return findHostInstance(component);
      };
      exports2.flushPassiveEffects = flushPendingEffects;
      exports2.flushSyncFromReconciler = function(fn) {
        var prevExecutionContext = executionContext;
        executionContext |= 1;
        var prevTransition = ReactSharedInternals.T, previousPriority = getCurrentUpdatePriority();
        try {
          if (setCurrentUpdatePriority(2), ReactSharedInternals.T = null, fn)
            return fn();
        } finally {
          setCurrentUpdatePriority(previousPriority), ReactSharedInternals.T = prevTransition, executionContext = prevExecutionContext, 0 === (executionContext & 6) && flushSyncWorkAcrossRoots_impl(0, false);
        }
      };
      exports2.flushSyncWork = flushSyncWork;
      exports2.focusWithin = function(hostRoot, selectors) {
        if (!supportsTestSelectors) throw Error(formatProdErrorMessage(363));
        hostRoot = findFiberRootForHostRoot(hostRoot);
        selectors = findPaths(hostRoot, selectors);
        selectors = Array.from(selectors);
        for (hostRoot = 0; hostRoot < selectors.length; ) {
          var fiber = selectors[hostRoot++], tag = fiber.tag;
          if (!isHiddenSubtree(fiber)) {
            if ((5 === tag || 26 === tag || 27 === tag) && setFocusIfFocusable(fiber.stateNode))
              return true;
            for (fiber = fiber.child; null !== fiber; )
              selectors.push(fiber), fiber = fiber.sibling;
          }
        }
        return false;
      };
      exports2.getFindAllNodesFailureDescription = function(hostRoot, selectors) {
        if (!supportsTestSelectors) throw Error(formatProdErrorMessage(363));
        var maxSelectorIndex = 0, matchedNames = [];
        hostRoot = [findFiberRootForHostRoot(hostRoot), 0];
        for (var index = 0; index < hostRoot.length; ) {
          var fiber = hostRoot[index++], tag = fiber.tag, selectorIndex = hostRoot[index++], selector = selectors[selectorIndex];
          if (5 !== tag && 26 !== tag && 27 !== tag || !isHiddenSubtree(fiber)) {
            if (matchSelector(fiber, selector) && (matchedNames.push(selectorToString(selector)), selectorIndex++, selectorIndex > maxSelectorIndex && (maxSelectorIndex = selectorIndex)), selectorIndex < selectors.length)
              for (fiber = fiber.child; null !== fiber; )
                hostRoot.push(fiber, selectorIndex), fiber = fiber.sibling;
          }
        }
        if (maxSelectorIndex < selectors.length) {
          for (hostRoot = []; maxSelectorIndex < selectors.length; maxSelectorIndex++)
            hostRoot.push(selectorToString(selectors[maxSelectorIndex]));
          return "findAllNodes was able to match part of the selector:\n  " + (matchedNames.join(" > ") + "\n\nNo matching component was found for:\n  ") + hostRoot.join(" > ");
        }
        return null;
      };
      exports2.getPublicRootInstance = function(container) {
        container = container.current;
        if (!container.child) return null;
        switch (container.child.tag) {
          case 27:
          case 5:
            return getPublicInstance(container.child.stateNode);
          default:
            return container.child.stateNode;
        }
      };
      exports2.injectIntoDevTools = function() {
        var internals = {
          bundleType: 0,
          version: rendererVersion,
          rendererPackageName,
          currentDispatcherRef: ReactSharedInternals,
          reconcilerVersion: "19.2.0"
        };
        null !== extraDevToolsConfig && (internals.rendererConfig = extraDevToolsConfig);
        if ("undefined" === typeof __REACT_DEVTOOLS_GLOBAL_HOOK__) internals = false;
        else {
          var hook = __REACT_DEVTOOLS_GLOBAL_HOOK__;
          if (hook.isDisabled || !hook.supportsFiber) internals = true;
          else {
            try {
              rendererID = hook.inject(internals), injectedHook = hook;
            } catch (err) {
            }
            internals = hook.checkDCE ? true : false;
          }
        }
        return internals;
      };
      exports2.isAlreadyRendering = function() {
        return 0 !== (executionContext & 6);
      };
      exports2.observeVisibleRects = function(hostRoot, selectors, callback, options) {
        if (!supportsTestSelectors) throw Error(formatProdErrorMessage(363));
        hostRoot = findAllNodes(hostRoot, selectors);
        var disconnect = setupIntersectionObserver(
          hostRoot,
          callback,
          options
        ).disconnect;
        return {
          disconnect: /* @__PURE__ */ __name(function() {
            disconnect();
          }, "disconnect")
        };
      };
      exports2.shouldError = function() {
        return null;
      };
      exports2.shouldSuspend = function() {
        return false;
      };
      exports2.startHostTransition = function(formFiber, pendingState, action, formData) {
        if (5 !== formFiber.tag) throw Error(formatProdErrorMessage(476));
        var queue = ensureFormComponentIsStateful(formFiber).queue;
        startTransition(
          formFiber,
          queue,
          pendingState,
          NotPendingTransition,
          null === action ? noop2 : function() {
            var stateHook = ensureFormComponentIsStateful(formFiber);
            null === stateHook.next && (stateHook = formFiber.alternate.memoizedState);
            dispatchSetStateInternal(
              formFiber,
              stateHook.next.queue,
              {},
              requestUpdateLane()
            );
            return action(formData);
          }
        );
      };
      exports2.updateContainer = function(element, container, parentComponent, callback) {
        var current = container.current, lane = requestUpdateLane();
        updateContainerImpl(
          current,
          lane,
          element,
          container,
          parentComponent,
          callback
        );
        return lane;
      };
      exports2.updateContainerSync = function(element, container, parentComponent, callback) {
        updateContainerImpl(
          container.current,
          2,
          element,
          container,
          parentComponent,
          callback
        );
        return 2;
      };
      return exports2;
    };
    module.exports.default = module.exports;
    Object.defineProperty(module.exports, "__esModule", { value: true });
  }
});

// node_modules/react-reconciler/index.js
var require_react_reconciler = __commonJS({
  "node_modules/react-reconciler/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    if (true) {
      module.exports = require_react_reconciler_production();
    } else {
      module.exports = null;
    }
  }
});

// node_modules/mimic-fn/index.js
var require_mimic_fn = __commonJS({
  "node_modules/mimic-fn/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var mimicFn = /* @__PURE__ */ __name((to, from) => {
      for (const prop of Reflect.ownKeys(from)) {
        Object.defineProperty(to, prop, Object.getOwnPropertyDescriptor(from, prop));
      }
      return to;
    }, "mimicFn");
    module.exports = mimicFn;
    module.exports.default = mimicFn;
  }
});

// node_modules/onetime/index.js
var require_onetime = __commonJS({
  "node_modules/onetime/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var mimicFn = require_mimic_fn();
    var calledFunctions = /* @__PURE__ */ new WeakMap();
    var onetime2 = /* @__PURE__ */ __name((function_, options = {}) => {
      if (typeof function_ !== "function") {
        throw new TypeError("Expected a function");
      }
      let returnValue;
      let callCount = 0;
      const functionName = function_.displayName || function_.name || "<anonymous>";
      const onetime3 = /* @__PURE__ */ __name(function(...arguments_) {
        calledFunctions.set(onetime3, ++callCount);
        if (callCount === 1) {
          returnValue = function_.apply(this, arguments_);
          function_ = null;
        } else if (options.throw === true) {
          throw new Error(`Function \`${functionName}\` can only be called once`);
        }
        return returnValue;
      }, "onetime");
      mimicFn(onetime3, function_);
      calledFunctions.set(onetime3, callCount);
      return onetime3;
    }, "onetime");
    module.exports = onetime2;
    module.exports.default = onetime2;
    module.exports.callCount = (function_) => {
      if (!calledFunctions.has(function_)) {
        throw new Error(`The given function \`${function_.name}\` is not wrapped by the \`onetime\` package`);
      }
      return calledFunctions.get(function_);
    };
  }
});

// node_modules/restore-cursor/node_modules/signal-exit/signals.js
var require_signals2 = __commonJS({
  "node_modules/restore-cursor/node_modules/signal-exit/signals.js"(exports, module) {
    init_esbuild_shims();
    module.exports = [
      "SIGABRT",
      "SIGALRM",
      "SIGHUP",
      "SIGINT",
      "SIGTERM"
    ];
    if (process.platform !== "win32") {
      module.exports.push(
        "SIGVTALRM",
        "SIGXCPU",
        "SIGXFSZ",
        "SIGUSR2",
        "SIGTRAP",
        "SIGSYS",
        "SIGQUIT",
        "SIGIOT"
        // should detect profiler and enable/disable accordingly.
        // see #21
        // 'SIGPROF'
      );
    }
    if (process.platform === "linux") {
      module.exports.push(
        "SIGIO",
        "SIGPOLL",
        "SIGPWR",
        "SIGSTKFLT",
        "SIGUNUSED"
      );
    }
  }
});

// node_modules/restore-cursor/node_modules/signal-exit/index.js
var require_signal_exit2 = __commonJS({
  "node_modules/restore-cursor/node_modules/signal-exit/index.js"(exports, module) {
    init_esbuild_shims();
    var process14 = globalThis.process;
    var processOk = /* @__PURE__ */ __name(function(process15) {
      return process15 && typeof process15 === "object" && typeof process15.removeListener === "function" && typeof process15.emit === "function" && typeof process15.reallyExit === "function" && typeof process15.listeners === "function" && typeof process15.kill === "function" && typeof process15.pid === "number" && typeof process15.on === "function";
    }, "processOk");
    if (!processOk(process14)) {
      module.exports = function() {
        return function() {
        };
      };
    } else {
      assert = __require("assert");
      signals = require_signals2();
      isWin = /^win/i.test(process14.platform);
      EE = __require("events");
      if (typeof EE !== "function") {
        EE = EE.EventEmitter;
      }
      if (process14.__signal_exit_emitter__) {
        emitter = process14.__signal_exit_emitter__;
      } else {
        emitter = process14.__signal_exit_emitter__ = new EE();
        emitter.count = 0;
        emitter.emitted = {};
      }
      if (!emitter.infinite) {
        emitter.setMaxListeners(Infinity);
        emitter.infinite = true;
      }
      module.exports = function(cb, opts) {
        if (!processOk(globalThis.process)) {
          return function() {
          };
        }
        assert.equal(typeof cb, "function", "a callback must be provided for exit handler");
        if (loaded === false) {
          load();
        }
        var ev = "exit";
        if (opts && opts.alwaysLast) {
          ev = "afterexit";
        }
        var remove = /* @__PURE__ */ __name(function() {
          emitter.removeListener(ev, cb);
          if (emitter.listeners("exit").length === 0 && emitter.listeners("afterexit").length === 0) {
            unload();
          }
        }, "remove");
        emitter.on(ev, cb);
        return remove;
      };
      unload = /* @__PURE__ */ __name(function unload2() {
        if (!loaded || !processOk(globalThis.process)) {
          return;
        }
        loaded = false;
        signals.forEach(function(sig) {
          try {
            process14.removeListener(sig, sigListeners[sig]);
          } catch (er) {
          }
        });
        process14.emit = originalProcessEmit;
        process14.reallyExit = originalProcessReallyExit;
        emitter.count -= 1;
      }, "unload");
      module.exports.unload = unload;
      emit = /* @__PURE__ */ __name(function emit2(event, code, signal) {
        if (emitter.emitted[event]) {
          return;
        }
        emitter.emitted[event] = true;
        emitter.emit(event, code, signal);
      }, "emit");
      sigListeners = {};
      signals.forEach(function(sig) {
        sigListeners[sig] = /* @__PURE__ */ __name(function listener() {
          if (!processOk(globalThis.process)) {
            return;
          }
          var listeners = process14.listeners(sig);
          if (listeners.length === emitter.count) {
            unload();
            emit("exit", null, sig);
            emit("afterexit", null, sig);
            if (isWin && sig === "SIGHUP") {
              sig = "SIGINT";
            }
            process14.kill(process14.pid, sig);
          }
        }, "listener");
      });
      module.exports.signals = function() {
        return signals;
      };
      loaded = false;
      load = /* @__PURE__ */ __name(function load2() {
        if (loaded || !processOk(globalThis.process)) {
          return;
        }
        loaded = true;
        emitter.count += 1;
        signals = signals.filter(function(sig) {
          try {
            process14.on(sig, sigListeners[sig]);
            return true;
          } catch (er) {
            return false;
          }
        });
        process14.emit = processEmit;
        process14.reallyExit = processReallyExit;
      }, "load");
      module.exports.load = load;
      originalProcessReallyExit = process14.reallyExit;
      processReallyExit = /* @__PURE__ */ __name(function processReallyExit2(code) {
        if (!processOk(globalThis.process)) {
          return;
        }
        process14.exitCode = code || /* istanbul ignore next */
        0;
        emit("exit", process14.exitCode, null);
        emit("afterexit", process14.exitCode, null);
        originalProcessReallyExit.call(process14, process14.exitCode);
      }, "processReallyExit");
      originalProcessEmit = process14.emit;
      processEmit = /* @__PURE__ */ __name(function processEmit2(ev, arg) {
        if (ev === "exit" && processOk(globalThis.process)) {
          if (arg !== void 0) {
            process14.exitCode = arg;
          }
          var ret = originalProcessEmit.apply(this, arguments);
          emit("exit", process14.exitCode, null);
          emit("afterexit", process14.exitCode, null);
          return ret;
        } else {
          return originalProcessEmit.apply(this, arguments);
        }
      }, "processEmit");
    }
    var assert;
    var signals;
    var isWin;
    var EE;
    var emitter;
    var unload;
    var emit;
    var sigListeners;
    var loaded;
    var load;
    var originalProcessReallyExit;
    var processReallyExit;
    var originalProcessEmit;
    var processEmit;
  }
});

// node_modules/stack-utils/node_modules/escape-string-regexp/index.js
var require_escape_string_regexp = __commonJS({
  "node_modules/stack-utils/node_modules/escape-string-regexp/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var matchOperatorsRegex = /[|\\{}()[\]^$+*?.-]/g;
    module.exports = (string) => {
      if (typeof string !== "string") {
        throw new TypeError("Expected a string");
      }
      return string.replace(matchOperatorsRegex, "\\$&");
    };
  }
});

// node_modules/stack-utils/index.js
var require_stack_utils = __commonJS({
  "node_modules/stack-utils/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var escapeStringRegexp = require_escape_string_regexp();
    var cwd2 = typeof process === "object" && process && typeof process.cwd === "function" ? process.cwd() : ".";
    var natives = [].concat(
      __require("module").builtinModules,
      "bootstrap_node",
      "node"
    ).map((n) => new RegExp(`(?:\\((?:node:)?${n}(?:\\.js)?:\\d+:\\d+\\)$|^\\s*at (?:node:)?${n}(?:\\.js)?:\\d+:\\d+$)`));
    natives.push(
      /\((?:node:)?internal\/[^:]+:\d+:\d+\)$/,
      /\s*at (?:node:)?internal\/[^:]+:\d+:\d+$/,
      /\/\.node-spawn-wrap-\w+-\w+\/node:\d+:\d+\)?$/
    );
    var StackUtils2 = class _StackUtils {
      static {
        __name(this, "StackUtils");
      }
      constructor(opts) {
        opts = {
          ignoredPackages: [],
          ...opts
        };
        if ("internals" in opts === false) {
          opts.internals = _StackUtils.nodeInternals();
        }
        if ("cwd" in opts === false) {
          opts.cwd = cwd2;
        }
        this._cwd = opts.cwd.replace(/\\/g, "/");
        this._internals = [].concat(
          opts.internals,
          ignoredPackagesRegExp(opts.ignoredPackages)
        );
        this._wrapCallSite = opts.wrapCallSite || false;
      }
      static nodeInternals() {
        return [...natives];
      }
      clean(stack, indent = 0) {
        indent = " ".repeat(indent);
        if (!Array.isArray(stack)) {
          stack = stack.split("\n");
        }
        if (!/^\s*at /.test(stack[0]) && /^\s*at /.test(stack[1])) {
          stack = stack.slice(1);
        }
        let outdent = false;
        let lastNonAtLine = null;
        const result = [];
        stack.forEach((st) => {
          st = st.replace(/\\/g, "/");
          if (this._internals.some((internal) => internal.test(st))) {
            return;
          }
          const isAtLine = /^\s*at /.test(st);
          if (outdent) {
            st = st.trimEnd().replace(/^(\s+)at /, "$1");
          } else {
            st = st.trim();
            if (isAtLine) {
              st = st.slice(3);
            }
          }
          st = st.replace(`${this._cwd}/`, "");
          if (st) {
            if (isAtLine) {
              if (lastNonAtLine) {
                result.push(lastNonAtLine);
                lastNonAtLine = null;
              }
              result.push(st);
            } else {
              outdent = true;
              lastNonAtLine = st;
            }
          }
        });
        return result.map((line) => `${indent}${line}
`).join("");
      }
      captureString(limit, fn = this.captureString) {
        if (typeof limit === "function") {
          fn = limit;
          limit = Infinity;
        }
        const { stackTraceLimit } = Error;
        if (limit) {
          Error.stackTraceLimit = limit;
        }
        const obj = {};
        Error.captureStackTrace(obj, fn);
        const { stack } = obj;
        Error.stackTraceLimit = stackTraceLimit;
        return this.clean(stack);
      }
      capture(limit, fn = this.capture) {
        if (typeof limit === "function") {
          fn = limit;
          limit = Infinity;
        }
        const { prepareStackTrace, stackTraceLimit } = Error;
        Error.prepareStackTrace = (obj2, site) => {
          if (this._wrapCallSite) {
            return site.map(this._wrapCallSite);
          }
          return site;
        };
        if (limit) {
          Error.stackTraceLimit = limit;
        }
        const obj = {};
        Error.captureStackTrace(obj, fn);
        const { stack } = obj;
        Object.assign(Error, { prepareStackTrace, stackTraceLimit });
        return stack;
      }
      at(fn = this.at) {
        const [site] = this.capture(1, fn);
        if (!site) {
          return {};
        }
        const res = {
          line: site.getLineNumber(),
          column: site.getColumnNumber()
        };
        setFile(res, site.getFileName(), this._cwd);
        if (site.isConstructor()) {
          Object.defineProperty(res, "constructor", {
            value: true,
            configurable: true
          });
        }
        if (site.isEval()) {
          res.evalOrigin = site.getEvalOrigin();
        }
        if (site.isNative()) {
          res.native = true;
        }
        let typename;
        try {
          typename = site.getTypeName();
        } catch (_) {
        }
        if (typename && typename !== "Object" && typename !== "[object Object]") {
          res.type = typename;
        }
        const fname = site.getFunctionName();
        if (fname) {
          res.function = fname;
        }
        const meth = site.getMethodName();
        if (meth && fname !== meth) {
          res.method = meth;
        }
        return res;
      }
      parseLine(line) {
        const match = line && line.match(re);
        if (!match) {
          return null;
        }
        const ctor = match[1] === "new";
        let fname = match[2];
        const evalOrigin = match[3];
        const evalFile = match[4];
        const evalLine = Number(match[5]);
        const evalCol = Number(match[6]);
        let file = match[7];
        const lnum = match[8];
        const col = match[9];
        const native = match[10] === "native";
        const closeParen = match[11] === ")";
        let method;
        const res = {};
        if (lnum) {
          res.line = Number(lnum);
        }
        if (col) {
          res.column = Number(col);
        }
        if (closeParen && file) {
          let closes = 0;
          for (let i = file.length - 1; i > 0; i--) {
            if (file.charAt(i) === ")") {
              closes++;
            } else if (file.charAt(i) === "(" && file.charAt(i - 1) === " ") {
              closes--;
              if (closes === -1 && file.charAt(i - 1) === " ") {
                const before = file.slice(0, i - 1);
                const after = file.slice(i + 1);
                file = after;
                fname += ` (${before}`;
                break;
              }
            }
          }
        }
        if (fname) {
          const methodMatch = fname.match(methodRe);
          if (methodMatch) {
            fname = methodMatch[1];
            method = methodMatch[2];
          }
        }
        setFile(res, file, this._cwd);
        if (ctor) {
          Object.defineProperty(res, "constructor", {
            value: true,
            configurable: true
          });
        }
        if (evalOrigin) {
          res.evalOrigin = evalOrigin;
          res.evalLine = evalLine;
          res.evalColumn = evalCol;
          res.evalFile = evalFile && evalFile.replace(/\\/g, "/");
        }
        if (native) {
          res.native = true;
        }
        if (fname) {
          res.function = fname;
        }
        if (method && fname !== method) {
          res.method = method;
        }
        return res;
      }
    };
    function setFile(result, filename, cwd3) {
      if (filename) {
        filename = filename.replace(/\\/g, "/");
        if (filename.startsWith(`${cwd3}/`)) {
          filename = filename.slice(cwd3.length + 1);
        }
        result.file = filename;
      }
    }
    __name(setFile, "setFile");
    function ignoredPackagesRegExp(ignoredPackages) {
      if (ignoredPackages.length === 0) {
        return [];
      }
      const packages = ignoredPackages.map((mod) => escapeStringRegexp(mod));
      return new RegExp(`[/\\\\]node_modules[/\\\\](?:${packages.join("|")})[/\\\\][^:]+:\\d+:\\d+`);
    }
    __name(ignoredPackagesRegExp, "ignoredPackagesRegExp");
    var re = new RegExp(
      "^(?:\\s*at )?(?:(new) )?(?:(.*?) \\()?(?:eval at ([^ ]+) \\((.+?):(\\d+):(\\d+)\\), )?(?:(.+?):(\\d+):(\\d+)|(native))(\\)?)$"
    );
    var methodRe = /^(.*?) \[as (.*?)\]$/;
    module.exports = StackUtils2;
  }
});

// node_modules/ink/build/index.js
init_esbuild_shims();

// node_modules/ink/build/render.js
init_esbuild_shims();
import { Stream } from "node:stream";
import process13 from "node:process";

// node_modules/ink/build/ink.js
init_esbuild_shims();
var import_react16 = __toESM(require_react(), 1);
import process12 from "node:process";

// node_modules/es-toolkit/dist/compat/index.mjs
init_esbuild_shims();

// node_modules/es-toolkit/dist/compat/function/debounce.mjs
init_esbuild_shims();

// node_modules/es-toolkit/dist/function/debounce.mjs
init_esbuild_shims();
function debounce(func, debounceMs, { signal, edges } = {}) {
  let pendingThis = void 0;
  let pendingArgs = null;
  const leading = edges != null && edges.includes("leading");
  const trailing = edges == null || edges.includes("trailing");
  const invoke = /* @__PURE__ */ __name(() => {
    if (pendingArgs !== null) {
      func.apply(pendingThis, pendingArgs);
      pendingThis = void 0;
      pendingArgs = null;
    }
  }, "invoke");
  const onTimerEnd = /* @__PURE__ */ __name(() => {
    if (trailing) {
      invoke();
    }
    cancel();
  }, "onTimerEnd");
  let timeoutId = null;
  const schedule = /* @__PURE__ */ __name(() => {
    if (timeoutId != null) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      timeoutId = null;
      onTimerEnd();
    }, debounceMs);
  }, "schedule");
  const cancelTimer = /* @__PURE__ */ __name(() => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }, "cancelTimer");
  const cancel = /* @__PURE__ */ __name(() => {
    cancelTimer();
    pendingThis = void 0;
    pendingArgs = null;
  }, "cancel");
  const flush = /* @__PURE__ */ __name(() => {
    invoke();
  }, "flush");
  const debounced = /* @__PURE__ */ __name(function(...args) {
    if (signal?.aborted) {
      return;
    }
    pendingThis = this;
    pendingArgs = args;
    const isFirstCall = timeoutId == null;
    schedule();
    if (leading && isFirstCall) {
      invoke();
    }
  }, "debounced");
  debounced.schedule = schedule;
  debounced.cancel = cancel;
  debounced.flush = flush;
  signal?.addEventListener("abort", cancel, { once: true });
  return debounced;
}
__name(debounce, "debounce");

// node_modules/es-toolkit/dist/compat/function/debounce.mjs
function debounce2(func, debounceMs = 0, options = {}) {
  if (typeof options !== "object") {
    options = {};
  }
  const { leading = false, trailing = true, maxWait } = options;
  const edges = Array(2);
  if (leading) {
    edges[0] = "leading";
  }
  if (trailing) {
    edges[1] = "trailing";
  }
  let result = void 0;
  let pendingAt = null;
  const _debounced = debounce(function(...args) {
    result = func.apply(this, args);
    pendingAt = null;
  }, debounceMs, { edges });
  const debounced = /* @__PURE__ */ __name(function(...args) {
    if (maxWait != null) {
      if (pendingAt === null) {
        pendingAt = Date.now();
      }
      if (Date.now() - pendingAt >= maxWait) {
        result = func.apply(this, args);
        pendingAt = Date.now();
        _debounced.cancel();
        _debounced.schedule();
        return result;
      }
    }
    _debounced.apply(this, args);
    return result;
  }, "debounced");
  const flush = /* @__PURE__ */ __name(() => {
    _debounced.flush();
    return result;
  }, "flush");
  debounced.cancel = _debounced.cancel;
  debounced.flush = flush;
  return debounced;
}
__name(debounce2, "debounce");

// node_modules/es-toolkit/dist/compat/function/throttle.mjs
init_esbuild_shims();
function throttle(func, throttleMs = 0, options = {}) {
  const { leading = true, trailing = true } = options;
  return debounce2(func, throttleMs, {
    leading,
    maxWait: throttleMs,
    trailing
  });
}
__name(throttle, "throttle");

// node_modules/ansi-escapes/index.js
init_esbuild_shims();

// node_modules/ansi-escapes/base.js
var base_exports = {};
__export(base_exports, {
  ConEmu: () => ConEmu,
  beep: () => beep,
  beginSynchronizedOutput: () => beginSynchronizedOutput,
  clearScreen: () => clearScreen,
  clearTerminal: () => clearTerminal,
  clearViewport: () => clearViewport,
  cursorBackward: () => cursorBackward,
  cursorDown: () => cursorDown,
  cursorForward: () => cursorForward,
  cursorGetPosition: () => cursorGetPosition,
  cursorHide: () => cursorHide,
  cursorLeft: () => cursorLeft,
  cursorMove: () => cursorMove,
  cursorNextLine: () => cursorNextLine,
  cursorPrevLine: () => cursorPrevLine,
  cursorRestorePosition: () => cursorRestorePosition,
  cursorSavePosition: () => cursorSavePosition,
  cursorShow: () => cursorShow,
  cursorTo: () => cursorTo,
  cursorUp: () => cursorUp,
  endSynchronizedOutput: () => endSynchronizedOutput,
  enterAlternativeScreen: () => enterAlternativeScreen,
  eraseDown: () => eraseDown,
  eraseEndLine: () => eraseEndLine,
  eraseLine: () => eraseLine,
  eraseLines: () => eraseLines,
  eraseScreen: () => eraseScreen,
  eraseStartLine: () => eraseStartLine,
  eraseUp: () => eraseUp,
  exitAlternativeScreen: () => exitAlternativeScreen,
  iTerm: () => iTerm,
  image: () => image,
  link: () => link,
  scrollDown: () => scrollDown,
  scrollUp: () => scrollUp,
  setCwd: () => setCwd,
  synchronizedOutput: () => synchronizedOutput
});
init_esbuild_shims();
import process2 from "node:process";
import os from "node:os";

// node_modules/environment/index.js
init_esbuild_shims();
var isBrowser = globalThis.window?.document !== void 0;
var isNode = globalThis.process?.versions?.node !== void 0;
var isBun = globalThis.process?.versions?.bun !== void 0;
var isDeno = globalThis.Deno?.version?.deno !== void 0;
var isElectron = globalThis.process?.versions?.electron !== void 0;
var isJsDom = globalThis.navigator?.userAgent?.includes("jsdom") === true;
var isWebWorker = typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope;
var isDedicatedWorker = typeof DedicatedWorkerGlobalScope !== "undefined" && globalThis instanceof DedicatedWorkerGlobalScope;
var isSharedWorker = typeof SharedWorkerGlobalScope !== "undefined" && globalThis instanceof SharedWorkerGlobalScope;
var isServiceWorker = typeof ServiceWorkerGlobalScope !== "undefined" && globalThis instanceof ServiceWorkerGlobalScope;
var platform = globalThis.navigator?.userAgentData?.platform;
var isMacOs = platform === "macOS" || globalThis.navigator?.platform === "MacIntel" || globalThis.navigator?.userAgent?.includes(" Mac ") === true || globalThis.process?.platform === "darwin";
var isWindows = platform === "Windows" || globalThis.navigator?.platform === "Win32" || globalThis.process?.platform === "win32";
var isLinux = platform === "Linux" || globalThis.navigator?.platform?.startsWith("Linux") === true || globalThis.navigator?.userAgent?.includes(" Linux ") === true || globalThis.process?.platform === "linux";
var isIos = platform === "iOS" || globalThis.navigator?.platform === "MacIntel" && globalThis.navigator?.maxTouchPoints > 1 || /iPad|iPhone|iPod/.test(globalThis.navigator?.platform);
var isAndroid = platform === "Android" || globalThis.navigator?.platform === "Android" || globalThis.navigator?.userAgent?.includes(" Android ") === true || globalThis.process?.platform === "android";

// node_modules/ansi-escapes/base.js
var ESC = "\x1B[";
var OSC = "\x1B]";
var BEL = "\x07";
var SEP = ";";
var isTerminalApp = !isBrowser && process2.env.TERM_PROGRAM === "Apple_Terminal";
var isWindows2 = !isBrowser && process2.platform === "win32";
var isTmux = !isBrowser && (process2.env.TERM?.startsWith("screen") || process2.env.TERM?.startsWith("tmux") || process2.env.TMUX !== void 0);
var cwdFunction = isBrowser ? () => {
  throw new Error("`process.cwd()` only works in Node.js, not the browser.");
} : process2.cwd;
var wrapOsc = /* @__PURE__ */ __name((sequence) => {
  if (isTmux) {
    return "\x1BPtmux;" + sequence.replaceAll("\x1B", "\x1B\x1B") + "\x1B\\";
  }
  return sequence;
}, "wrapOsc");
var cursorTo = /* @__PURE__ */ __name((x, y) => {
  if (typeof x !== "number") {
    throw new TypeError("The `x` argument is required");
  }
  if (typeof y !== "number") {
    return ESC + (x + 1) + "G";
  }
  return ESC + (y + 1) + SEP + (x + 1) + "H";
}, "cursorTo");
var cursorMove = /* @__PURE__ */ __name((x, y) => {
  if (typeof x !== "number") {
    throw new TypeError("The `x` argument is required");
  }
  let returnValue = "";
  if (x < 0) {
    returnValue += ESC + -x + "D";
  } else if (x > 0) {
    returnValue += ESC + x + "C";
  }
  if (y < 0) {
    returnValue += ESC + -y + "A";
  } else if (y > 0) {
    returnValue += ESC + y + "B";
  }
  return returnValue;
}, "cursorMove");
var cursorUp = /* @__PURE__ */ __name((count = 1) => ESC + count + "A", "cursorUp");
var cursorDown = /* @__PURE__ */ __name((count = 1) => ESC + count + "B", "cursorDown");
var cursorForward = /* @__PURE__ */ __name((count = 1) => ESC + count + "C", "cursorForward");
var cursorBackward = /* @__PURE__ */ __name((count = 1) => ESC + count + "D", "cursorBackward");
var cursorLeft = ESC + "G";
var cursorSavePosition = isTerminalApp ? "\x1B7" : ESC + "s";
var cursorRestorePosition = isTerminalApp ? "\x1B8" : ESC + "u";
var cursorGetPosition = ESC + "6n";
var cursorNextLine = ESC + "E";
var cursorPrevLine = ESC + "F";
var cursorHide = ESC + "?25l";
var cursorShow = ESC + "?25h";
var eraseLines = /* @__PURE__ */ __name((count) => {
  let clear = "";
  for (let i = 0; i < count; i++) {
    clear += eraseLine + (i < count - 1 ? cursorUp() : "");
  }
  if (count) {
    clear += cursorLeft;
  }
  return clear;
}, "eraseLines");
var eraseEndLine = ESC + "K";
var eraseStartLine = ESC + "1K";
var eraseLine = ESC + "2K";
var eraseDown = ESC + "J";
var eraseUp = ESC + "1J";
var eraseScreen = ESC + "2J";
var scrollUp = ESC + "S";
var scrollDown = ESC + "T";
var clearScreen = "\x1Bc";
var clearViewport = `${eraseScreen}${ESC}H`;
var isOldWindows = /* @__PURE__ */ __name(() => {
  if (isBrowser || !isWindows2) {
    return false;
  }
  const parts = os.release().split(".");
  const major = Number(parts[0]);
  const build = Number(parts[2] ?? 0);
  if (major < 10) {
    return true;
  }
  if (major === 10 && build < 10586) {
    return true;
  }
  return false;
}, "isOldWindows");
var clearTerminal = isOldWindows() ? `${eraseScreen}${ESC}0f` : `${eraseScreen}${ESC}3J${ESC}H`;
var enterAlternativeScreen = ESC + "?1049h";
var exitAlternativeScreen = ESC + "?1049l";
var beginSynchronizedOutput = ESC + "?2026h";
var endSynchronizedOutput = ESC + "?2026l";
var synchronizedOutput = /* @__PURE__ */ __name((text) => beginSynchronizedOutput + text + endSynchronizedOutput, "synchronizedOutput");
var beep = BEL;
var link = /* @__PURE__ */ __name((text, url) => {
  const openLink = wrapOsc(`${OSC}8${SEP}${SEP}${url}${BEL}`);
  const closeLink = wrapOsc(`${OSC}8${SEP}${SEP}${BEL}`);
  return openLink + text + closeLink;
}, "link");
var image = /* @__PURE__ */ __name((data, options = {}) => {
  let returnValue = `${OSC}1337;File=inline=1`;
  if (options.width) {
    returnValue += `;width=${options.width}`;
  }
  if (options.height) {
    returnValue += `;height=${options.height}`;
  }
  if (options.preserveAspectRatio === false) {
    returnValue += ";preserveAspectRatio=0";
  }
  const imageBuffer = Buffer.from(data);
  return wrapOsc(returnValue + `;size=${imageBuffer.byteLength}:` + imageBuffer.toString("base64") + BEL);
}, "image");
var iTerm = {
  setCwd: /* @__PURE__ */ __name((cwd2 = cwdFunction()) => wrapOsc(`${OSC}50;CurrentDir=${cwd2}${BEL}`), "setCwd"),
  annotation(message, options = {}) {
    let returnValue = `${OSC}1337;`;
    const hasX = options.x !== void 0;
    const hasY = options.y !== void 0;
    if ((hasX || hasY) && !(hasX && hasY && options.length !== void 0)) {
      throw new Error("`x`, `y` and `length` must be defined when `x` or `y` is defined");
    }
    message = message.replaceAll("|", "");
    returnValue += options.isHidden ? "AddHiddenAnnotation=" : "AddAnnotation=";
    if (options.length > 0) {
      returnValue += (hasX ? [message, options.length, options.x, options.y] : [options.length, message]).join("|");
    } else {
      returnValue += message;
    }
    return wrapOsc(returnValue + BEL);
  }
};
var ConEmu = {
  setCwd: /* @__PURE__ */ __name((cwd2 = cwdFunction()) => wrapOsc(`${OSC}9;9;${cwd2}${BEL}`), "setCwd")
};
var setCwd = /* @__PURE__ */ __name((cwd2 = cwdFunction()) => iTerm.setCwd(cwd2) + ConEmu.setCwd(cwd2), "setCwd");

// packages/cli/src/patches/is-in-ci.ts
init_esbuild_shims();
var isInCi = false;
var is_in_ci_default = isInCi;

// node_modules/auto-bind/index.js
init_esbuild_shims();
var getAllProperties = /* @__PURE__ */ __name((object) => {
  const properties = /* @__PURE__ */ new Set();
  do {
    for (const key of Reflect.ownKeys(object)) {
      properties.add([object, key]);
    }
  } while ((object = Reflect.getPrototypeOf(object)) && object !== Object.prototype);
  return properties;
}, "getAllProperties");
function autoBind(self, { include, exclude } = {}) {
  const filter = /* @__PURE__ */ __name((key) => {
    const match = /* @__PURE__ */ __name((pattern) => typeof pattern === "string" ? key === pattern : pattern.test(key), "match");
    if (include) {
      return include.some(match);
    }
    if (exclude) {
      return !exclude.some(match);
    }
    return true;
  }, "filter");
  for (const [object, key] of getAllProperties(self.constructor.prototype)) {
    if (key === "constructor" || !filter(key)) {
      continue;
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
    if (descriptor && typeof descriptor.value === "function") {
      self[key] = self[key].bind(self);
    }
  }
  return self;
}
__name(autoBind, "autoBind");

// node_modules/ink/build/ink.js
var import_signal_exit2 = __toESM(require_signal_exit(), 1);

// node_modules/patch-console/dist/index.js
init_esbuild_shims();
import { PassThrough } from "node:stream";
var consoleMethods = [
  "assert",
  "count",
  "countReset",
  "debug",
  "dir",
  "dirxml",
  "error",
  "group",
  "groupCollapsed",
  "groupEnd",
  "info",
  "log",
  "table",
  "time",
  "timeEnd",
  "timeLog",
  "trace",
  "warn"
];
var originalMethods = {};
var patchConsole = /* @__PURE__ */ __name((callback) => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.write = (data) => {
    callback("stdout", data);
  };
  stderr.write = (data) => {
    callback("stderr", data);
  };
  const internalConsole = new console.Console(stdout, stderr);
  for (const method of consoleMethods) {
    originalMethods[method] = console[method];
    console[method] = internalConsole[method];
  }
  return () => {
    for (const method of consoleMethods) {
      console[method] = originalMethods[method];
    }
    originalMethods = {};
  };
}, "patchConsole");
var dist_default = patchConsole;

// node_modules/ink/build/ink.js
var import_constants2 = __toESM(require_constants(), 1);

// node_modules/yoga-layout/dist/src/index.js
init_esbuild_shims();

// node_modules/yoga-layout/dist/binaries/yoga-wasm-base64-esm.js
init_esbuild_shims();
var loadYoga = (() => {
  var _scriptDir = import.meta.url;
  return function(loadYoga2) {
    loadYoga2 = loadYoga2 || {};
    var h;
    h || (h = typeof loadYoga2 !== "undefined" ? loadYoga2 : {});
    var aa, ca;
    h.ready = new Promise(function(a, b) {
      aa = a;
      ca = b;
    });
    var da = Object.assign({}, h), q = "";
    "undefined" != typeof document && document.currentScript && (q = document.currentScript.src);
    _scriptDir && (q = _scriptDir);
    0 !== q.indexOf("blob:") ? q = q.substr(0, q.replace(/[?#].*/, "").lastIndexOf("/") + 1) : q = "";
    var ea = h.print || console.log.bind(console), v = h.printErr || console.warn.bind(console);
    Object.assign(h, da);
    da = null;
    var w;
    h.wasmBinary && (w = h.wasmBinary);
    var noExitRuntime = h.noExitRuntime || true;
    "object" != typeof WebAssembly && x("no native wasm support detected");
    var fa, ha = false;
    function z(a, b, c) {
      c = b + c;
      for (var d = ""; !(b >= c); ) {
        var e = a[b++];
        if (!e) break;
        if (e & 128) {
          var f = a[b++] & 63;
          if (192 == (e & 224)) d += String.fromCharCode((e & 31) << 6 | f);
          else {
            var g = a[b++] & 63;
            e = 224 == (e & 240) ? (e & 15) << 12 | f << 6 | g : (e & 7) << 18 | f << 12 | g << 6 | a[b++] & 63;
            65536 > e ? d += String.fromCharCode(e) : (e -= 65536, d += String.fromCharCode(55296 | e >> 10, 56320 | e & 1023));
          }
        } else d += String.fromCharCode(e);
      }
      return d;
    }
    __name(z, "z");
    var ia, ja, A, C, ka, D, E, la, ma;
    function na() {
      var a = fa.buffer;
      ia = a;
      h.HEAP8 = ja = new Int8Array(a);
      h.HEAP16 = C = new Int16Array(a);
      h.HEAP32 = D = new Int32Array(a);
      h.HEAPU8 = A = new Uint8Array(a);
      h.HEAPU16 = ka = new Uint16Array(a);
      h.HEAPU32 = E = new Uint32Array(a);
      h.HEAPF32 = la = new Float32Array(a);
      h.HEAPF64 = ma = new Float64Array(a);
    }
    __name(na, "na");
    var oa, pa = [], qa = [], ra = [];
    function sa() {
      var a = h.preRun.shift();
      pa.unshift(a);
    }
    __name(sa, "sa");
    var F = 0, ta = null, G = null;
    function x(a) {
      if (h.onAbort) h.onAbort(a);
      a = "Aborted(" + a + ")";
      v(a);
      ha = true;
      a = new WebAssembly.RuntimeError(a + ". Build with -sASSERTIONS for more info.");
      ca(a);
      throw a;
    }
    __name(x, "x");
    function ua(a) {
      return a.startsWith("data:application/octet-stream;base64,");
    }
    __name(ua, "ua");
    var H;
    H = "data:application/octet-stream;base64,AGFzbQEAAAABugM3YAF/AGACf38AYAF/AX9gA39/fwBgAn98AGACf38Bf2ADf39/AX9gBH9/f30BfWADf398AGAAAGAEf39/fwBgAX8BfGACf38BfGAFf39/f38Bf2AAAX9gA39/fwF9YAZ/f31/fX8AYAV/f39/fwBgAn9/AX1gBX9/f319AX1gAX8BfWADf35/AX5gB39/f39/f38AYAZ/f39/f38AYAR/f39/AX9gBn9/f319fQF9YAR/f31/AGADf399AX1gBn98f39/fwF/YAR/fHx/AGACf30AYAh/f39/f39/fwBgDX9/f39/f39/f39/f38AYAp/f39/f39/f39/AGAFf39/f38BfGAEfHx/fwF9YA1/fX1/f399fX9/f39/AX9gB39/f319f38AYAJ+fwF/YAN/fX0BfWABfAF8YAN/fHwAYAR/f319AGAHf39/fX19fQF9YA1/fX99f31/fX19fX1/AX9gC39/f39/f399fX19AX9gCH9/f39/f319AGAEf39+fgBgB39/f39/f38Bf2ACfH8BfGAFf398fH8AYAN/f38BfGAEf39/fABgA39/fQBgBn9/fX99fwF/ArUBHgFhAWEAHwFhAWIAAwFhAWMACQFhAWQAFgFhAWUAEQFhAWYAIAFhAWcAAAFhAWgAIQFhAWkAAwFhAWoAAAFhAWsAFwFhAWwACgFhAW0ABQFhAW4AAwFhAW8AAQFhAXAAFwFhAXEABgFhAXIAAAFhAXMAIgFhAXQACgFhAXUADQFhAXYAFgFhAXcAAgFhAXgAAwFhAXkAGAFhAXoAAgFhAUEAAQFhAUIAEQFhAUMAAQFhAUQAAAOiAqACAgMSBwcACRkDAAoRBgYKEwAPDxMBBiMTCgcHGgMUASQFJRQHAwMKCgMmAQYYDxobFAAKBw8KBwMDAgkCAAAFGwACBwIHBgIDAQMIDAABKAkHBQURACkZASoAAAIrLAIALQcHBy4HLwkFCgMCMA0xAgMJAgACAQYKAQIBBQEACQIFAQEABQAODQ0GFQIBHBUGAgkCEAAAAAUyDzMMBQYINAUCAwUODg41AgMCAgIDBgICNgIBDAwMAQsLCwsLCx0CAAIAAAABABABBQICAQMCEgMMCwEBAQEBAQsLAQICAwICAgICAgIDAgIICAEICAgEBAQEBAQEBAQABAQABAQEBAAE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GiABQQA2AvADIAFCADcC6AMgAigC7AMiAyACKALoAyIERwRAIAMgBGsiBEEASA0FIAEgBBAeIgM2AuwDIAEgAzYC6AMgASADIARqNgLwAyACKALoAyIEIAIoAuwDIghHBEADQCADIAQoAgA2AgAgA0EEaiEDIARBBGoiBCAIRw0ACwsgASADNgLsAwsgASACKQL0AzcC9AMgASACKAKEBDYChAQgASACKQL8AzcC/AMgAUEANgLkAwsgBSABNgIAIAEgADYC5AMLIAZBAWohBiAFQQRqIgUgB0cNAAsLDwsQAgALUAACQAJAAkACQAJAIAIOBAQAAQIDCyAAIAEgAUEwahBDDwsgACABIAFBMGogAxBEDwsgACABIAFBMGoQQg8LECQACyAAIAEgAUEwaiADEEULcAIBfwF9IwBBEGsiBCQAIARBCGogACABQQJ0QdwlaigCACACEDZDAADAfyEFAkACQAJAIAQtAAxBAWsOAgABAgsgBCoCCCEFDAELIAQqAgggA5RDCtcjPJQhBQsgBEEQaiQAIAVDAAAAACAFIAVbGwt5AgF/AX0jAEEQayIDJAAgA0EIaiAAIAFBAnRB7CVqKAIAIAIQU0MAAMB/IQQCQAJAAkAgAy0ADEEBaw4CAAECCyADKgIIIQQMAQsgAyoCCEMAAAAAlEMK1yM8lCEECyADQRBqJAAgBEMAAAAAl0MAAAAAIAQgBFsbC1QAAkACQAJAAkACQCACDgQEAAECAwsgACABIAFBwgBqEEMPCyAAIAEgAUHCAGogAxBEDwsgACABIAFBwgBqEEIPCxAkAAsgACABIAFBwgBqIAMQRQsvACAAIAJFQQF0IgIgASADEGAgACACIAEQS5IgACACIAEgAxB/IAAgAiABEFKSkgvOAQIDfwJ9IwBBEGsiAyQAQQEhBCADQQhqIABB/ABqIgUgACABQQF0akH2AGoiAS8BABAfAkACQCADKgIIIgcgAioCACIGXARAIAcgB1sEQCACLQAEIQIMAgsgBiAGXCEECyACLQAEIQIgBEUNACADLQAMIAJB/wFxRg0BCyAFIAEgBiACEDkDQCAALQAAIgFBBHENASAAIAFBBHI6AAAgACgCECIBBEAgACABEQAACyAAQYCAgP4HNgKcASAAKALkAyIADQALCyADQRBqJAALzgECA38CfSMAQRBrIgMk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AWsOAgABAgsgBCoCCCEFDAELIAQqAgggA5RDCtcjPJQhBQsgBEEQaiQAIAVDAAAAACAFIAVbGwscACAAIAFBCCACpyACQiCIpyADpyADQiCIpxAVCwUAEFgACzkAIABFBEBBAA8LAn8gAUGAf3FBgL8DRiABQf8ATXJFBEBB/DtBGTYCAEF/DAELIAAgAToAAEEBCwvEAgACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQCABQQlrDhIACgsMCgsCAwQFDAsMDAoLBwgJCyACIAIoAgAiAUEEajYCACAAIAEoAgA2AgAPCwALIAIgAigCACIBQQRqNgIAIAAgATIBADcDAA8LIAIgAigCACIBQQRqNgIAIAAgATMBADcDAA8LIAIgAigCACIBQQRqNgIAIAAgATAAADcDAA8LIAIgAigCACIBQQRqNgIAIAAgATEAADcDAA8LAAsgAiACKAIAQQdqQXhxIgFBCGo2AgAgACABKwMAOQMADwsgACACIAMRAQALDwsgAiACKAIAIgFBBGo2AgAgACABNAIANwMADwsgAiACKAIAIgFBBGo2AgAgACABNQIANwMADwsgAiACKAIAQQdqQXhxIgFBCGo2AgAgACABKQMANwMAC84BAgN/An0jAEEQayIDJABBASEEIANBCGogAEH8AGoiBSAAIAFBAXRqQegAaiIBLwEAEB8CQAJAIAMqAggiByACKgIAIgZcBEAgByAHWwRAIAItAAQhAgwCCyAGIAZcIQQLIAItAAQhAiAERQ0AIAMtAAwgAkH/AXFGDQELIAUgASAGIAIQOQNAIAAtAAAiAUEEcQ0BIAAgAUEEcjoAACAAKAIQIgEEQCAAIAERAAALIABBgICA/gc2ApwBIAAoAuQDIgANAAsLIANBEGokAAtdAQR/IAAoAgAhAgNAIAIsAAAiAxBXBEBBfyEEIAAgAkEBaiICNgIAIAFBzJmz5gBNBH9BfyADQTBrIgMgAUEKbCIEaiADIARB/////wdzShsFIAQLIQEMAQsLIAELrhQCEn8BfiMAQdAAayIIJAAgCCABNgJMIAhBN2ohFyAIQThqIRQCQAJAAkACQANAIAEhDSAHIA5B/////wdzSg0BIAcgDmohDgJAAkACQCANIgctAAAiCQRAA0ACQAJAIAlB/wFxIgFFBEAgByEBDAELIAFBJUcNASAH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IQEgAEIANwIEIAAgATYCACABIAA2AgQgAkEQaiQAIAALGwEBfyAABEAgACgCACIBBEAgARAjCyAAECMLC0kBAn9BBBAeIQFBIBAeIgBBADYCHCAAQoCAgICAgIDAPzcCFCAAQgA3AgwgAEEAOgAIIABBAzYCBCAAQQA2AgAgASAANgIAIAELIAAgAkEFR0EAIAIbRQRAQbgwIAMgBBBJDwsgAyAEEHALIgEBfiABIAKtIAOtQiCGhCAEIAARFQAiBUIgiKckASAFpwuoAQEFfyAAKAJUIgMoAgAhBSADKAIEIgQgACgCFCAAKAIcIgdrIgYgBCAGSRsiBgRAIAUgByAGECsaIAMgAygCACAGaiIFNgIAIAMgAygCBCAGayIENgIECyAEIAIgAiAESxsiBARAIAUgASAEECsaIAMgAygCACAEaiIFNgIAIAMgAygCBCAEazYCBAsgBUEAOgAAIAAgACgCLCIBNgIcIAAgATYCFCACCwQAQgALBABBAAuKBQIGfgJ/IAEgASgCAEEHakF4cSIBQRBqNgIAIAAhCSABKQMAIQMgASkDCCEGIwBBIGsiCCQAAkAgBkL///////////8AgyIEQoCAgICAgMCAPH0gBEKAgICAgIDA/8MAfVQEQCAGQgSGIANCPIiEIQQgA0L//////////w+DIgNCgYCAgICAgIAIWgRAIARCgYCAgICAgIDAAHwhAgwCCyAEQoCAgICAgICAQH0hAiADQoCAgICAgICACFINASACIARCAYN8IQIMAQsgA1AgBEKAgICAgIDA//8AVCAEQoCAgICAgMD//wBRG0UEQCAGQgSGIANCPIiEQv////////8Dg0KAgICAgICA/P8AhCECDAELQoCAgICAgID4/wAhAiAEQv///////7//wwBWDQBCACECIARCMIinIgBBkfcASQ0AIAMhAiAGQv///////z+DQoCAgICAgMAAhCIFIQcCQCAAQYH3AGsiAUHAAHEEQCACIAFBQGqthiEHQgAhAgwBCyABRQ0AIAcgAa0iBIYgAkHAACABa62IhCEHIAIgBIYhAgsgCCACNwMQIAggBzcDGAJAQYH4ACAAayIAQcAAcQRAIAUgAEFAaq2IIQNCACEFDAELIABFDQAgBUHAACAAa62GIAMgAK0iAoiEIQMgBSACiCEFCyAIIAM3AwAgCCAFNwMIIAgpAwhCBIYgCCkDACIDQjyIhCECIAgpAxAgCCkDGIRCAFKtIANC//////////8Pg4QiA0KBgICAgICAgAhaBEAgAkIBfCECDAELIANCgICAgICAgIAIUg0AIAJCAYMgAnwhAgsgCEEgaiQAIAkgAiAGQoCAgICAgICAgH+DhL85AwALmRgDEn8BfAN+IwBBsARrIgwkACAMQQA2AiwCQCABvSIZQgBTBEBBASERQZkJIRMgAZoiAb0hGQwBCyAEQYAQcQRAQQEhEUGcCSETDAELQZ8JQZoJIARBAXEiERshEyARRSEVCwJAIBlCgICAgICAgPj/AINCgICAgICAgPj/AFEEQCAAQSAgAiARQQNqIgMgBEH//3txECkgACATIBEQJiAAQe0VQdweIAVBIHEiBRtB4RpB4B4gBRsgASABYhtBAxAmIABBICACIAMgBEGAwABzECkgAyACIAIgA0gbIQoMAQsgDEEQaiESAkACfwJAIAEgDEEsahCMASIBIAGgIgFEAAAAAAAAAABiBEAgDCAMKAIsIgZBAWs2AiwgBUEgciIOQeEARw0BDAMLIAVBIHIiDkHhAEYNAiAMKAIsIQlBBiADIANBAEgbDAELIAwgBkEdayIJNgIsIAFEAAAAAAAAsEGiIQFBBiADIANBAEgbCyELIAxBMGpBoAJBACAJQQBOG2oiDSEHA0AgBwJ/IAFEAAAAAAAA8EFjIAFEAAAAAAAAAABmcQRAIAGrDAELQQALIgM2AgAgB0EEaiEHIAEgA7ihRAAAAABlzc1BoiIBRAAAAAAAAAAAYg0ACwJAIAlBAEwEQCAJIQMgByEGIA0hCAwBCyANIQggCSEDA0BBHSADIANBHU4bIQMCQCAHQQRrIgYgCEkNACADrSEaQgAhGQNAIAYgGUL/////D4MgBjUCACAahnwiG0KAlOvcA4AiGUKA7JSjDH4gG3w+AgAgBkEEayIGIAhPDQALIBmnIgZFDQAgCEEEayIIIAY2AgALA0AgCCAHIgZJBEAgBkEEayIHKAIARQ0BCwsgDCAMKAIsIANrIgM2AiwgBiEHIANBAEoNAAsLIANBAEgEQCALQRlqQQluQQFqIQ8gDkHmAEYhEANAQQlBACADayIDIANBCU4bIQoCQCAGIAhNBEAgCCgCACEHDAELQYCU69wDIAp2IRRBfyAKdEF/cyEWQQAhAyAIIQcDQCAHIAMgBygCACIXIAp2ajYCACAWIBdxIBRsIQMgB0EEaiIHIAZJDQALIAgoAgAhByADRQ0AIAYgAzYCACAGQQRqIQYLIAwgDCgCLCAKaiIDNgIsIA0gCCAHRUECdGoiCCAQGyIHIA9BAnRqIAYgBiAHa0ECdSAPShshBiADQQBIDQALC0EAIQMCQCAGIAhNDQAgDSAIa0ECdUEJbCEDQQohByAIKAIAIgpBCkkNAANAIANBAWohAyAKIAdBCmwiB08NAAsLIAsgA0EAIA5B5gBHG2sgDkHnAEYgC0EAR3FrIgcgBiANa0ECdUEJbEEJa0gEQEEEQaQCIAlBAEgbIAxqIAdBgMgAaiIKQQltIg9BAnRqQdAfayEJQQohByAPQXdsIApqIgpBB0wEQANAIAdBCmwhByAKQQFqIgpBCEcNAAsLAkAgCSgCACIQIBAgB24iDyAHbCIKRiAJQQRqIhQgBkZxDQAgECAKayEQAkAgD0EBcUUEQEQAAAAAAABAQyEBIAdBgJTr3ANHIAggCU9yDQEgCUEEay0AAEEBcUUNAQtEAQAAAAAAQEMhAQtEAAAAAAAA4D9EAAAAAAAA8D9EAAAAAAAA+D8gBiAURhtEAAAAAAAA+D8gECAHQQF2IhRGGyAQIBRJGyEYAkAgFQ0AIBMtAABBLUcNACAYmiEYIAGaIQELIAkgCjYCACABIBigIAFhDQAgCSAHIApqIgM2AgAgA0GAlOvcA08EQANAIAlBADYCACAIIAlBBGsiCUsEQCAIQQRrIghBADYCAAsgCSAJKAIAQQFqIgM2AgAgA0H/k+vcA0sNAAsLIA0gCGtBAnVBCWwhA0EKIQcgCCgCACIKQQpJDQADQCADQQFqIQMgCiAHQQpsIgdPDQALCyAJQQRqIgcgBiAGIAdLGyEGCwNAIAYiByAITSIKRQRAIAdBBGsiBigCAEUNAQsLAkAgDkHnAEcEQCAEQQhxIQkMAQsgA0F/c0F/IAtBASALGyIGIANKIANBe0pxIgkbIAZqIQtBf0F+IAkbIAVqIQUgBEEIcSIJDQBBdyEGAkAgCg0AIAdBBGsoAgAiDkUNAEEKIQpBACEGIA5BCnANAANAIAYiCUEBaiEGIA4gCkEKbCIKcEUNAAsgCUF/cyEGCyAHIA1rQQJ1QQlsIQogBUFfcUHGAEYEQEEAIQkgCyAGIApqQQlrIgZBACAGQQBKGyIGIAYgC0obIQsMAQtBACEJIAsgAyAKaiAGakEJayIGQQAgBkEAShsiBiAGIAtKGyELC0F/IQogC0H9////B0H+////ByAJIAtyIhAbSg0BIAsgEEEAR2pBAWohDgJAIAVBX3EiFUHGAEYEQCADIA5B/////wdzSg0DIANBACADQQBKGyEGDAELIBIgAyADQR91IgZzIAZrrSASEEciBmtBAUwEQANAIAZBAWsiBkEwOgAAIBIgBmtBAkgNAAsLIAZBAmsiDyAFOgAAIAZBAWtBLUErIANBAEgbOgAAIBIgD2siBiAOQf////8Hc0oNAgsgBiAOaiIDIBFB/////wdzSg0BIABBICACIAMgEWoiBSAEECkgACATIBEQJiAAQTAgAiAFIARBgIAEcxApAkACQAJAIBVBxgBGBEAgDEEQaiIGQQhyIQMgBkEJciEJIA0gCCAIIA1LGyIKIQgDQCAINQIAIAkQRyEGAkAgCCAKRwRAIAYgDEEQak0NAQNAIAZBAWsiBkEwOgAAIAYgDEEQaksNAAsMAQsgBiAJRw0AIAxBMDoAGCADIQYLIAAgBiAJIAZrECYgCEEEaiIIIA1NDQALIBAEQCAAQYwlQQEQJgsgC0EATCAHIAhNcg0BA0AgCDUCACAJEEciBiAMQRBqSwRAA0AgBkEBayIGQTA6AAAgBiAMQRBqSw0ACwsgACAGQQkgCyALQQlOGxAmIAtBCWshBiAIQQRqIgggB08NAyALQQlKIQMgBiELIAMNAAsMAgsCQCALQQBIDQAgByAIQQRqIAcgCEsbIQogDEEQaiIGQQhyIQMgBkEJciENIAghBwNAIA0gBzUCACANEEciBkYEQCAMQTA6ABggAyEGCwJAIAcgCEcEQCAGIAxBEGpNDQEDQCAGQQFrIgZBMDoAACAGIAxBEGpLDQALDAELIAAgBkEBECYgBkEBaiEGIAkgC3JFDQAgAEGMJUEBECYLIAAgBiALIA0gBmsiBiAGIAtKGxAmIAsgBmshCyAHQQRqIgcgCk8NASALQQBODQALCyAAQTAgC0ESakESQQAQKSAAIA8gEiAPaxAmDAILIAshBgsgAEEwIAZBCWpBCUEAECkLIABBICACIAUgBEGAwABzECkgBSACIAIgBUgbIQoMAQsgEyAFQRp0QR91QQlxaiELAkAgA0ELSw0AQQwgA2shBkQAAAAAAAAwQCEYA0AgGEQAAAAAAAAwQKIhGCAGQQFrIgYNAAsgCy0AAEEtRgRAIBggAZogGKGgmiEBDAELIAEgGKAgGKEhAQsgEUECciEJIAVBIHEhCCASIAwoAiwiByAHQR91IgZzIAZrrSASEEciBkYEQCAMQTA6AA8gDEEPaiEGCyAGQQJrIg0gBUEPajoAACAGQQFrQS1BKyAHQQBIGzoAACAEQQhxIQYgDEEQaiEHA0AgByIFAn8gAZlEAAAAAAAA4EFjBEAgAaoMAQtBgICAgHgLIgdBkC9qLQAAIAhyOgAAIAYgA0EASnJFIAEgB7ehRAAAAAAAADBAoiIBRAAAAAAAAAAAYXEgBUEBaiIHIAxBEGprQQFHckUEQCAFQS46AAEgBUECaiEHCyABRAAAAAAAAAAAYg0AC0F/IQpB/f///wcgCSASIA1rIgVqIgZrIANIDQAgAEEgIAIgBgJ/AkAgA0UNACAHIAxBEGprIghBAmsgA04NACADQQJqDAELIAcgDEEQamsiCAsiB2oiAyAEECkgACALIAkQJiAAQTAgAiADIARBgIAEcxApIAAgDEEQaiAIECYgAEEwIAcgCGtBAEEAECkgACANIAUQJiAAQSAgAiADIARBgMAAcxApIAMgAiACIANIGyEKCyAMQbAEaiQAIAoLRgEBfyAAKAI8IQMjAEEQayIAJAAgAyABpyABQiCIpyACQf8BcSAAQQhqEBQQjQEhAiAAKQMIIQEgAEEQaiQAQn8gASACGwu+AgEHfyMAQSBrIgMkACADIAAoAhwiBDYCECAAKAIUIQUgAyACNgIcIAMgATYCGCADIAUgBGsiATYCFCABIAJqIQVBAiEGIANBEGohAQJ/A0ACQAJAAkAgACgCPCABIAYgA0EMahAYEI0BRQRAIAUgAygCDCIHRg0BIAdBAE4NAgwDCyAFQX9HDQILIAAgACgCLCIBNgIcIAAgATYCFCAAIAEgACgCMGo2AhAgAgwDCyABIAcgASgCBCIISyIJQQN0aiIEIAcgCEEAIAkbayIIIAQoAgBqNgIAIAFBDEEEIAkbaiIBIAEoAgAgCGs2AgAgBSAHayEFIAYgCWshBiAEIQEMAQsLIABBADYCHCAAQgA3AxAgACAAKAIAQSByNgIAQQAgBkECRg0AGiACIAEoAgRrCyEEIANBIGokACAECwkAIAAoAjwQGQsjAQF/Qcg7KAIAIgAEQANAIAAoAgARCQAgACgCBCIADQALCwu/AgEFfyMAQeAAayICJAAgAiAANgIAIwBBEGsiAyQAIAMgAjYCDCMAQZABayIAJAAgAEGgL0GQARArIgAgAkEQaiIFIgE2AiwgACABNgIUIABB/////wdBfiABayIEIARB/////wdPGyIENgIwIAAgASAEaiIBNgIcIAAgATYCECAAQbsTIAJBAEEAEIsBGiAEBEAgACgCFCIBIAEgACgCEEZrQQA6AAALIABBkAFqJAAgA0EQaiQAAkAgBSIAQQNxBEADQCAALQAARQ0CIABBAWoiAEEDcQ0ACwsDQCAAIgFBBGohACABKAIAIgNBf3MgA0GBgoQIa3FBgIGChHhxRQ0ACwNAIAEiAEEBaiEBIAAtAAANAAsLIAAgBWtBAWoiABBhIgEEfyABIAUgABArBUEACyEAIAJB4ABqJAAgAAvFAQICfwF8IwBBMGsiBiQAIAEoAgghBwJAQbQ7LQAAQQFxBEBBsDsoAgAhAQwBC0EFQZAnEAwhAUG0O0EBOgAAQbA7IAE2AgALIAYgBTYCKCAGIAQ4AiAgBiADNgIYIAYgAjgCEAJ/IAEgB0GXGyAGQQxqIAZBEGoQEiIIRAAAAAAAAPBBYyAIRAAAAAAAAAAAZnEEQCAIqwwBC0EACyEBIAYoAgwhAyAAIAEpAwA3AwAgACABKQMINwMIIAMQESAGQTBqJAALCQAgABCQARAjCwwAIAAoAghB6BwQZgsJACAAEJIBECMLVQECfyMAQTBrIgIkACABIAAoAgQiA0EBdWohASAAKAIAIQAgAiABIANBAXEEfyABKAIAIABqKAIABSAACxEBAEEwEB4gAkEwECshACACQTBqJAAgAAs7AQF/IAEgACgCBCIFQQF1aiEBIAAoAgAhACABIAIgAyAEIAVBAXEEfyABKAIAIABqKAIABSAACxEdAAs3AQF/IAEgACgCBCIDQQF1aiEBIAAoAgAhACABIAIgA0EBcQR/IAEoAgAgAGooAgAFIAALERIACzcBAX8gASAAKAIEIgNBAXVqIQEgACgCACEAIAEgAiADQQFxBH8gASgCACAAaigCAAUgAAsRDAALNQEBfyABIAAoAgQiAkEBdWohASAAKAIAIQAgASACQQFxBH8gASgCACAAaigCAAUgAAsRCwALYQECfyMAQRBrIgIkACABIAAoAgQiA0EBdWohASAAKAIAIQAgAiABIANBAXEEfyABKAIAIABqKAIABSAACxEBAEEQEB4iACACKQMINwMIIAAgAikDADcDACACQRBqJAAgAAtjAQJ/IwBBEGsiAyQAIAEgACgCBCIEQQF1aiEBIAAoAgAhACADIAEgAiAEQQFxBH8gASgCACAAaigCAAUgAAsRAwBBEBAeIgAgAykDCDcDCCAAIAMpAwA3AwAgA0EQaiQAIAALNwEBfyABIAAoAgQiA0EBdWohASAAKAIAIQAgASACIANBAXEEfyABKAIAIABqKAIABSAACxEEAAs5AQF/IAEgACgCBCIEQQF1aiEBIAAoAgAhACABIAIgAyAEQQFxBH8gASgCACAAaigCAAUgAAsRCAALCQAgASAAEQIACwUAQcM7Cw8AIAEgACgCAGogAjYCAAsNACABIAAoAgBqKAIACxgBAX9BEBAeIgBCADcDCCAAQQA2AgAgAAsYAQF/QRAQHiIAQgA3AwAgAEIANwMIIAALDABBMBAeQQBBMBAqCzcBAX8gASAAKAIEIgNBAXVqIQEgACgCACEAIAEgAiADQQFxBH8gASgCACAAaigCAAUgAAsRHgALBQBBvjsLIQAgACABKAIAIAEgASwAC0EASBtBuzsgAigCABAQNgIACyoBAX9BDBAeIgFBADoABCABIAAoAgA2AgggAEEANgIAIAFB2Cc2AgAgAQsFAEG7OwsFAEG4OwshACAAIAEoAgAgASABLAALQQBIG0GkOyACKAIAEBA2AgAL2AEBBH8jAEEgayIDJAAgASgCACIEQfD///8HSQRAAkACQCAEQQtPBEAgBEEPckEBaiIFEB4hBiADIAVBgICAgHhyNgIQIAMgBjYCCCADIAQ2AgwgBCAGaiEFDAELIAMgBDoAEyADQQhqIgYgBGohBSAERQ0BCyAGIAFBBGogBBArGgsgBUEAOgAAIAMgAjYCACADQRhqIANBCGogAyAAEQMAIAMoAhgQHSADKAIYIgAQBiADKAIAEAYgAywAE0EASARAIAMoAggQIwsgA0EgaiQAIAAPCxACAAsqAQF/QQwQHiIBQQA6AAQgASAAKAIANgIIIABBADYCACABQeAmNgIAIAELBQBBpDsLaQECfyMAQRBrIgYkACABIAAoAgQiB0EBdWohASAAKAIAIQAgBiABIAIgAyAEIAUgB0EBcQR/IAEoAgAgAGooAgAFIAALERAAQRAQHiIAIAYpAwg3AwggACAGKQMANwMAIAZBEGokACAACwUAQaA7Cx0AIAAoAgAiACAALQAAQfcBcUEIQQAgARtyOgAAC6oBAgJ/AX0jAEEQayICJAAgACgCACEAIAFB/wFxIgNBBkkEQAJ/AkACQAJAIANBBGsOAgABAgsgAEHUA2ogAC0AiANBA3FBAkYNAhogAEHMA2oMAgsgAEHMA2ogAC0AiANBA3FBAkYNARogAEHUA2oMAQsgACABQf8BcUECdGpBzANqCyoCACEEIAJBEGokACAEuw8LIAJB7hA2AgAgAEEFQdglIAIQLBAkAAuqAQICfwF9IwBBEGsiAiQAIAAoAgAhACABQf8BcSIDQQZJBEACfwJAAkACQCADQQRrDgIAAQILIABBxANqIAAtAIgDQQNxQQJGDQIaIABBvANqDAILIABBvANqIAAtAIgDQQNxQQJGDQEaIABBxANqDAELIAAgAUH/AXFBAnRqQbwDagsqAgAhBCACQRBqJAAgBLsPCyACQe4QNgIAIABBBUHYJSACECwQJAALqgECAn8BfSMAQRBrIgIkACAAKAIAIQAgAUH/AXEiA0EGSQRAAn8CQAJAAkAgA0EEaw4CAAECCyAAQbQDaiAALQCIA0EDcUECRg0CGiAAQawDagwCCyAAQawDaiAALQCIA0EDcUECRg0BGiAAQbQDagwBCyAAIAFB/wFxQQJ0akGsA2oLKgIAIQQgAkEQaiQAIAS7DwsgAkHuEDYCACAAQQVB2CUgAhAsECQAC08AIAAgASgCACIBKgKcA7s5AwAgACABKgKkA7s5AwggACABKgKgA7s5AxAgACABKgKoA7s5AxggACABKgKMA7s5AyAgACABKgKQA7s5AygLDAAgACgCACoCkAO7CwwAIAAoAgAqAowDuwsMACAAKAIAKgKoA7sLDAAgACgCACoCoAO7CwwAIAAoAgAqAqQDuwsMACAAKAIAKgKcA7sL6AMCBH0FfyMAQUBqIgokACAAKAIAIQAgCkEIakEAQTgQKhpB8DpB8DooAgBBAWo2AgAgABB4IAAtABRBA3EiCCADQQEgA0H/AXEbIAgbIQkgAEEUaiEIIAG2IQQgACoC+AMhBQJ9AkACQAJAIAAtAPwDQQFrDgIBAAILIAUgBJRDCtcjPJQhBQsgBUMAAAAAYEUNACAAIAlB/wFxQQAgBCAEEDEgCEECQQEgBBAiIAhBAkEBIAQQIZKSDAELIAggCUH/AXFBACAEIAQQLSIFIAVbBEBBAiELIAggCUH/AXFBACAEIAQQLQwBCyAEIARcIQsgBAshByACtiEFIAAqAoAEIQYgACAHAn0CQAJAAkAgAC0AhARBAWsOAgEAAgsgBiAFlEMK1yM8lCEGCyAGQwAAAABgRQ0AIAAgCUH/AXFBASAFIAQQMSAIQQBBASAEECIgCEEAQQEgBBAhkpIMAQsgCCAJQf8BcSIJQQEgBSAEEC0iBiAGWwRAQQIhDCAIIAlBASAFIAQQLQwBCyAFIAVcIQwgBQsgA0H/AXEgCyAMIAQgBUEBQQAgCkEIakEAQfA6KAIAED0EQCAAIAAtAIgDQQNxIAQgBRB2IABEAAAAAAAAAABEAAAAAAAAAAAQcwsgCkFAayQACw0AIAAoAgAtAABBAXELFQAgACgCACIAIAAtAABB/gFxOgAACxAAIAAoAgAtAABBBHFBAnYLegECfyMAQRBrIgEkACAAKAIAIgAoAggEQANAIAAtAAAiAkEEcUUEQCAAIAJBBHI6AAAgACgCECICBEAgACACEQAACyAAQYCAgP4HNgKcASAAKALkAyIADQELCyABQRBqJAAPCyABQYAINgIAIABBBUHYJSABECwQJAALLgEBfyAAKAIIIQEgAEEANgIIIAEEQCABIAEoAgAoAgQRAAALIAAoAgBBADYCEAsXACAAKAIEKAIIIgAgACgCACgCCBEAAAsuAQF/IAAoAgghAiAAIAE2AgggAgRAIAIgAigCACgCBBEAAAsgACgCAEEFNgIQCz4BAX8gACgCBCEBIABBADYCBCABBEAgASABKAIAKAIEEQAACyAAKAIAIgBBADYCCCAAIAAtAABB7wFxOgAAC0kBAX8jAEEQayIGJAAgBiABKAIEKAIEIgEgAiADIAQgBSABKAIAKAIIERAAIAAgBisDALY4AgAgACAGKwMItjgCBCAGQRBqJAALcwECfyMAQRBrIgIkACAAKAIEIQMgACABNgIEIAMEQCADIAMoAgAoAgQRAAALIAAoAgAiACgC6AMgACgC7ANHBEAgAkH5IzYCACAAQQVB2CUgAhAsECQACyAAQQQ2AgggACAALQAAQRByOgAAIAJBEGokAAs8AQF/AkAgACgCACIAKALsAyAAKALoAyIAa0ECdSABTQ0AIAAgAUECdGooAgAiAEUNACAAKAIEIQILIAILGQAgACgCACgC5AMiAEUEQEEADwsgACgCBAsXACAAKAIAIgAoAuwDIAAoAugDa0ECdQuOAwEDfyMAQdACayICJAACQCAAKAIAIgAoAuwDIAAoAugDRg0AIAEoAgAiAygC5AMhASAAIAMQb0UNACAAIAFGBEAgAkEIakEAQcQCECoaIAJBADoAGCACQgA3AxAgAkGAgID+BzYCDCACQRxqQQBBxAEQKhogAkHgAWohBCACQSBqIQEDQCABQoCAgPyLgIDAv383AhAgAUKBgICAEDcCCCABQoCAgPyLgIDAv383AgAgAUEYaiIBIARHDQALIAJCgICA/IuAgMC/fzcD8AEgAkKBgICAEDcD6AEgAkKAgID8i4CAwL9/NwPgASACQoCAgP6HgIDg/wA3AoQCIAJCgICA/oeAgOD/ADcC/AEgAiACLQD4AUH4AXE6APgBIAJBjAJqQQBBwAAQKhogA0GYAWogAkEIakHEAhArGiADQQA2AuQDCwNAIAAtAAAiAUEEcQ0BIAAgAUEEcjoAACAAKAIQIgEEQCAAIAERAAALIABBgICA/gc2ApwBIAAoAuQDIgANAAsLIAJB0AJqJAAL4AcBCH8jAEHQAGsiByQAIAAoAgAhAAJAAkAgASgCACIIKALkA0UEQCAAKAIIDQEgCC0AF0EQdEGAgDBxQYCAIEYEQCAAIAAoAuADQQFqNgLgAwsgACgC6AMiASACQQJ0aiEGAkAgACgC7AMiBCAAQfADaiIDKAIAIgVJBEAgBCAGRgRAIAYgCDYCACAAIAZBBGo2AuwDDAILIAQgBCICQQRrIgFLBEADQCACIAEoAgA2AgAgAkEEaiECIAFBBGoiASAESQ0ACwsgACACNgLsAyAGQQRqIgEgBEcEQCAEIAQgAWsiAUF8cWsgBiABEDMaCyAGIAg2AgAMAQsgBCABa0ECdUEBaiIEQYCAgIAETw0DAkAgB0EgakH/////AyAFIAFrIgFBAXUiBSAEIAQgBUkbIAFB/P///wdPGyACIAMQSiIDKAIIIgIgAygCDEcNACADKAIEIgEgAygCACIESwRAIAMgASABIARrQQJ1QQFqQX5tQQJ0IgRqIAEgAiABayIBEDMgAWoiAjYCCCADIAMoAgQgBGo2AgQMAQsgB0E4akEBIAIgBGtBAXUgAiAERhsiASABQQJ2IAMoAhAQSiIFKAIIIQQCfyADKAIIIgIgAygCBCIBRgRAIAQhAiABDAELIAQgAiABa2ohAgNAIAQgASgCADYCACABQQRqIQEgBEEEaiIEIAJHDQALIAMoAgghASADKAIECyEEIAMoAgAhCSADIAUoAgA2AgAgBSAJNgIAIAMgBSgCBDYCBCAFIAQ2AgQgAyACNgIIIAUgATYCCCADKAIMIQogAyAFKAIMNgIMIAUgCjYCDCABIARHBEAgBSABIAQgAWtBA2pBfHFqNgIICyAJRQ0AIAkQIyADKAIIIQILIAIgCDYCACADIAMoAghBBGo2AgggAyADKAIEIAYgACgC6AMiAWsiAmsgASACEDM2AgQgAygCCCAGIAAoAuwDIAZrIgQQMyEGIAAoAugDIQEgACADKAIENgLoAyADIAE2AgQgACgC7AMhAiAAIAQgBmo2AuwDIAMgAjYCCCAAKALwAyEEIAAgAygCDDYC8AMgAyABNgIAIAMgBDYCDCABIAJHBEAgAyACIAEgAmtBA2pBfHFqNgIICyABRQ0AIAEQIwsgCCAANgLkAwNAIAAtAAAiAUEEcUUEQCAAIAFBBHI6AAAgACgCECIBBEAgACABEQAACyAAQYCAgP4HNgKcASAAKALkAyIADQELCyAHQdAAaiQADwsgB0HEIzYCECAAQQVB2CUgB0EQahAsECQACyAHQckkNgIAIABBBUHYJSAHECwQJAALEAIACxAAIAAoAgAtAABBAnFBAXYLWQIBfwF9IwBBEGsiAiQAIAJBCGogACgCACIAQfwAaiAAIAFB/wFxQQF0ai8BaBAfQwAAwH8hAwJAAkAgAi0ADA4EAQAAAQALIAIqAgghAwsgAkEQaiQAIAMLTgEBfyMAQRBrIgMkACADQQhqIAEoAgAiAUH8AGogASACQf8BcUEBdGovAUQQHyADLQAMIQEgACADKgIIuzkDCCAAIAE2AgAgA0EQaiQAC14CAX8BfCMAQRBrIgIkACACQQhqIAAoAgAiAEH8AGogACABQf8BcUEBdGovAVYQH0QAAAAAAAD4fyEDAkACQCACLQAMDgQBAAABAAsgAioCCLshAwsgAkEQaiQAIAMLJAEBfUMAAMB/IAAoAgAiAEH8AGogAC8BehAgIgEgASABXBu7C0QBAX8jAEEQayICJAAgAkEIaiABKAIAIgFB/ABqIAEvAXgQHyACLQAMIQEgACACKgIIuzkDCCAAIAE2AgAgAkEQaiQAC0QBAX8jAEEQayICJAAgAkEIaiABKAIAIgFB/ABqIAEvAXYQHyACLQAMIQEgACACKgIIuzkDCCAAIAE2AgAgAkEQaiQAC0QBAX8jAEEQayICJAAgAkEIaiABKAIAIgFB/ABqIAEvAXQQHyACLQAMIQEgACACKgIIuzkDCCAAIAE2AgAgAkEQaiQAC0QBAX8jAEEQayICJAAgAkEIaiABKAIAIgFB/ABqIAEvAXIQHyACLQAMIQEgACACKgIIuzkDCCAAIAE2AgAgAkEQaiQAC0QBAX8jAEEQayICJAAgAkEIaiABKAIAIgFB/ABqIAEvAXAQHyACLQAMIQEgACACKgIIuzkDCCAAIAE2AgAgAkEQaiQAC0QBAX8jAEEQayICJAAgAkEIaiABKAIAIgFB/ABqIAEvAW4QHyACLQAMIQEgACACKgIIuzkDCCAAIAE2AgAgAkEQaiQAC0gCAX8BfQJ9IAAoAgAiAEH8AGoiASAALwEcECAiAiACXARAQwAAgD9DAAAAACAAKAL0Ay0ACEEBcRsMAQsgASAALwEcECALuws2AgF/AX0gACgCACIAQfwAaiIBIAAvARoQICICIAJcBEBEAAAAAAAAAAAPCyABIAAvARoQILsLRAEBfyMAQRBrIgIkACACQQhqIAEoAgAiAUH8AGogAS8BHhAfIAItAAwhASAAIAIqAgi7OQMIIAAgATYCACACQRBqJAALEAAgACgCAC0AF0ECdkEDcQsNACAAKAIALQAXQQNxC04BAX8jAEEQayIDJAAgA0EIaiABKAIAIgFB/ABqIAEgAkH/AXFBAXRqLwEgEB8gAy0ADCEBIAAgAyoCCLs5AwggACABNgIAIANBEGokAAsQACAAKAIALQAUQQR2QQdxCw0AIAAoAgAvABVBDnYLDQAgACgCAC0AFEEDcQsQACAAKAIALQAUQQJ2QQNxCw0AIAAoAgAvABZBD3ELEAAgACgCAC8AFUEEdkEPcQsNACAAKAIALwAVQQ9xC04BAX8jAEEQayIDJAAgA0EIaiABKAIAIgFB/ABqIAEgAkH/AXFBAXRqLwEyEB8gAy0ADCEBIAAgAyoCCLs5AwggACABNgIAIANBEGokAAsQACAAKAIALwAVQQx2QQNxCxAAIAAoAgAtABdBBHZBAXELgQECA38BfSMAQRBrIgMkACAAKAIAIQQCfSACtiIGIAZcBEBBACEAQwAAwH8MAQtBAEECIAZDAACAf1sgBkMAAID/W3IiBRshAEMAAMB/IAYgBRsLIQYgAyAAOgAMIAMgBjgCCCADIAMpAwg3AwAgBCABQf8BcSADEIgBIANBEGokAAt5AgF9An8jAEEQayIEJAAgACgCACEFIAQCfyACtiIDIANcBEBDAADAfyEDQQAMAQtDAADAfyADIANDAACAf1sgA0MAAID/W3IiABshAyAARQs6AAwgBCADOAIIIAQgBCkDCDcDACAFIAFB/wFxIAQQiAEgBEEQaiQAC3EBAX8CQCAAKAIAIgAtAAAiAkECcUEBdiABRg0AIAAgAkH9AXFBAkEAIAEbcjoAAANAIAAtAAAiAUEEcQ0BIAAgAUEEcjoAACAAKAIQIgEEQCAAIAERAAALIABBgICA/gc2ApwBIAAoAuQDIgANAAsLC4EBAgN/AX0jAEEQayIDJAAgACgCACEEAn0gArYiBiAGXARAQQAhAEMAAMB/DAELQQBBAiAGQwAAgH9bIAZDAACA/1tyIgUbIQBDAADAfyAGIAUbCyEGIAMgADoADCADIAY4AgggAyADKQMINwMAIAQgAUH/AXEgAxCOASADQRBqJAALeQIBfQJ/IwBBEGsiBCQAIAAoAgAhBSAEAn8gArYiAyADXARAQwAAwH8hA0EADAELQwAAwH8gAyADQwAAgH9bIANDAACA/1tyIgAbIQMgAEULOgAMIAQgAzgCCCAEIAQpAwg3AwAgBSABQf8BcSAEEI4BIARBEGokAAv5AQICfQR/IwBBEGsiBSQAIAAoAgAhAAJ/IAK2IgMgA1wEQEMAAMB/IQNBAAwBC0MAAMB/IAMgA0MAAIB/WyADQwAAgP9bciIGGyEDIAZFCyEGQQEhByAFQQhqIABB/ABqIgggACABQf8BcUEBdGpB1gBqIgEvAQAQHwJAAkAgAyAFKgIIIgRcBH8gBCAEWw0BIAMgA1wFIAcLRQ0AIAUtAAwgBkYNAQsgCCABIAMgBhA5A0AgAC0AACIBQQRxDQEgACABQQRyOgAAIAAoAhAiAQRAIAAgAREAAAsgAEGAgID+BzYCnAEgACgC5AMiAA0ACwsgBUEQaiQAC7UBAgN/An0CQCAAKAIAIgBB/ABqIgMgAEH6AGoiAi8BABAgIgYgAbYiBVsNACAFIAVbIgRFIAYgBlxxDQACQCAEIAVDAAAAAFsgBYtDAACAf1tyRXFFBEAgAiACLwEAQfj/A3E7AQAMAQsgAyACIAVBAxBMCwNAIAAtAAAiAkEEcQ0BIAAgAkEEcjoAACAAKAIQIgIEQCAAIAIRAAALIABBgICA/gc2ApwBIAAoAuQDIgANAAsLC3wCA38BfSMAQRBrIgIkACAAKAIAIQMCfSABtiIFIAVcBEBBACEAQwAAwH8MAQtBAEECIAVDAACAf1sgBUMAAID/W3IiBBshAEMAAMB/IAUgBBsLIQUgAiAAOgAMIAIgBTgCCCACIAIpAwg3AwAgA0EBIAIQVSACQRBqJAALdAIBfQJ/IwBBEGsiAyQAIAAoAgAhBCADAn8gAbYiAiACXARAQwAAwH8hAkEADAELQwAAwH8gAiACQwAAgH9bIAJDAACA/1tyIgAbIQIgAEULOgAMIAMgAjgCCCADIAMpAwg3AwAgBEEBIAMQVSADQRBqJAALfAIDfwF9IwBBEGsiAiQAIAAoAgAhAwJ9IAG2IgUgBVwEQEEAIQBDAADAfwwBC0EAQQIgBUMAAIB/WyAFQwAAgP9bciIEGyEAQwAAwH8gBSAEGwshBSACIAA6AAwgAiAFOAIIIAIgAikDCDcDACADQQAgAhBVIAJBEGokAAt0AgF9An8jAEEQayIDJAAgACgCACEEIAMCfyABtiICIAJcBEBDAADAfyECQQAMAQtDAADAfyACIAJDAACAf1sgAkMAAID/W3IiABshAiAARQs6AAwgAyACOAIIIAMgAykDCDcDACAEQQAgAxBVIANBEGokAAt8AgN/AX0jAEEQayICJAAgACgCACEDAn0gAbYiBSAFXARAQQAhAEMAAMB/DAELQQBBAiAFQwAAgH9bIAVDAACA/1tyIgQbIQBDAADAfyAFIAQbCyEFIAIgADoADCACIAU4AgggAiACKQMINwMAIANBASACEFYgAkEQaiQAC3QCAX0CfyMAQRBrIgMkACAAKAIAIQQgAwJ/IAG2IgIgAlwEQEMAAMB/IQJBAAwBC0MAAMB/IAIgAkMAAIB/WyACQwAAgP9bciIAGyECIABFCzoADCADIAI4AgggAyADKQMINwMAIARBASADEFYgA0EQaiQAC3wCA38BfSMAQRBrIgIkACAAKAIAIQMCfSABtiIFIAVcBEBBACEAQwAAwH8MAQtBAEECIAVDAACAf1sgBUMAAID/W3IiBBshAEMAAMB/IAUgBBsLIQUgAiAAOgAMIAIgBTgCCCACIAIpAwg3AwAgA0EAIAIQViACQRBqJAALdAIBfQJ/IwBBEGsiAyQAIAAoAgAhBCADAn8gAbYiAiACXARAQwAAwH8hAkEADAELQwAAwH8gAiACQwAAgH9bIAJDAACA/1tyIgAbIQIgAEULOgAMIAMgAjgCCCADIAMpAwg3AwAgBEEAIAMQViADQRBqJAALPwEBfyMAQRBrIgEkACAAKAIAIQAgAUEDOgAMIAFBgICA/gc2AgggASABKQMINwMAIABBASABEEYgAUEQaiQAC3wCA38BfSMAQRBrIgIkACAAKAIAIQMCfSABtiIFIAVcBEBBACEAQwAAwH8MAQtBAEECIAVDAACAf1sgBUMAAID/W3IiBBshAEMAAMB/IAUgBBsLIQUgAiAAOgAMIAIgBTgCCCACIAIpAwg3AwAgA0EBIAIQRiACQRBqJAALdAIBfQJ/IwBBEGsiAyQAIAAoAgAhBCADAn8gAbYiAiACXARAQwAAwH8hAkEADAELQwAAwH8gAiACQwAAgH9bIAJDAACA/1tyIgAbIQIgAEULOgAMIAMgAjgCCCADIAMpAwg3AwAgBEEBIAMQRiADQRBqJAALPwEBfyMAQRBrIgEkACAAKAIAIQAgAUEDOgAMIAFBgICA/gc2AgggASABKQMINwMAIABBACABEEYgAUEQaiQAC3wCA38BfSMAQRBrIgIkACAAKAIAIQMCfSABtiIFIAVcBEBBACEAQwAAwH8MAQtBAEECIAVDAACAf1sgBUMAAID/W3IiBBshAEMAAMB/IAUgBBsLIQUgAiAAOgAMIAIgBTgCCCACIAIpAwg3AwAgA0EAIAIQRiACQRBqJAALdAIBfQJ/IwBBEGsiAyQAIAAoAgAhBCADAn8gAbYiAiACXARAQwAAwH8hAkEADAELQwAAwH8gAiACQwAAgH9bIAJDAACA/1tyIgAbIQIgAEULOgAMIAMgAjgCCCADIAMpAwg3AwAgBEEAIAMQRiADQRBqJAALoAECA38CfQJAIAAoAgAiAEH8AGoiAyAAQRxqIgIvAQAQICIGIAG2IgVbDQAgBSAFWyIERSAGIAZccQ0AAkAgBEUEQCACIAIvAQBB+P8DcTsBAAwBCyADIAIgBUEDEEwLA0AgAC0AACICQQRxDQEgACACQQRyOgAAIAAoAhAiAgRAIAAgAhEAAAsgAEGAgID+BzYCnAEgACgC5AMiAA0ACwsLoAECA38CfQJAIAAoAgAiAEH8AGoiAyAAQRpqIgIvAQAQICIGIAG2IgVbDQAgBSAFWyIERSAGIAZccQ0AAkAgBEUEQCACIAIvAQBB+P8DcTsBAAwBCyADIAIgBUEDEEwLA0AgAC0AACICQQRxDQEgACACQQRyOgAAIAAoAhAiAgRAIAAgAhEAAAsgAEGAgID+BzYCnAEgACgC5AMiAA0ACwsLPQEBfyMAQRBrIgEkACAAKAIAIQAgAUEDOgAMIAFBgICA/gc2AgggASABKQMINwMAIAAgARBrIAFBEGokAAt6AgN/AX0jAEEQayICJAAgACgCACEDAn0gAbYiBSAFXARAQQAhAEMAAMB/DAELQQBBAiAFQwAAgH9bIAVDAACA/1tyIgQbIQBDAADAfyAFIAQbCyEFIAIgADoADCACIAU4AgggAiACKQMINwMAIAMgAhBrIAJBEGokAAtyAgF9An8jAEEQayIDJAAgACgCACEEIAMCfyABtiICIAJcBEBDAADAfyECQQAMAQtDAADAfyACIAJDAACAf1sgAkMAAID/W3IiABshAiAARQs6AAwgAyACOAIIIAMgAykDCDcDACAEIAMQayADQRBqJAALoAECA38CfQJAIAAoAgAiAEH8AGoiAyAAQRhqIgIvAQAQICIGIAG2IgVbDQAgBSAFWyIERSAGIAZccQ0AAkAgBEUEQCACIAIvAQBB+P8DcTsBAAwBCyADIAIgBUEDEEwLA0AgAC0AACICQQRxDQEgACACQQRyOgAAIAAoAhAiAgRAIAAgAhEAAAsgAEGAgID+BzYCnAEgACgC5AMiAA0ACwsLkAEBAX8CQCAAKAIAIgBBF2otAAAiAkECdkEDcSABQf8BcUYNACAAIAAvABUgAkEQdHIiAjsAFSAAIAJB///PB3EgAUEDcUESdHJBEHY6ABcDQCAALQAAIgFBBHENASAAIAFBBHI6AAAgACgCECIBBEAgACABEQAACyAAQYCAgP4HNgKcASAAKALkAyIADQALCwuNAQEBfwJAIAAoAgAiAEEXai0AACICQQNxIAFB/wFxRg0AIAAgAC8AFSACQRB0ciICOwAVIAAgAkH///MHcSABQQNxQRB0ckEQdjoAFwNAIAAtAAAiAUEEcQ0BIAAgAUEEcjoAACAAKAIQIgEEQCAAIAERAAALIABBgICA/gc2ApwBIAAoAuQDIgANAAsLC0MBAX8jAEEQayICJAAgACgCACEAIAJBAzoADCACQYCAgP4HNgIIIAIgAikDCDcDACAAIAFB/wFxIAIQZSACQRBqJAALgAECA38BfSMAQRBrIgMkACAAKAIAIQQCfSACtiIGIAZcBEBBACEAQwAAwH8MAQtBAEECIAZDAACAf1sgBkMAAID/W3IiBRshAEMAAMB/IAYgBRsLIQYgAyAAOgAMIAMgBjgCCCADIAMpAwg3AwAgBCABQf8BcSADEGUgA0EQaiQAC3gCAX0CfyMAQRBrIgQkACAAKAIAIQUgBAJ/IAK2IgMgA1wEQEMAAMB/IQNBAAwBC0MAAMB/IAMgA0MAAIB/WyADQwAAgP9bciIAGyEDIABFCzoADCAEIAM4AgggBCAEKQMINwMAIAUgAUH/AXEgBBBlIARBEGokAAt3AQF/AkAgACgCACIALQAUIgJBBHZBB3EgAUH/AXFGDQAgACACQY8BcSABQQR0QfAAcXI6ABQDQCAALQAAIgFBBHENASAAIAFBBHI6AAAgACgCECIBBEAgACABEQAACyAAQYCAgP4HNgKcASAAKALkAyIADQALCwuJAQEBfwJAIAFB/wFxIAAoAgAiAC8AFSICQQ52Rg0AIABBF2ogAiAALQAXQRB0ciICQRB2OgAAIAAgAkH//wBxIAFBDnRyOwAVA0AgAC0AACIBQQRxDQEgACABQQRyOgAAIAAoAhAiAQRAIAAgAREAAAsgAEGAgID+BzYCnAEgACgC5AMiAA0ACwsLcAEBfwJAIAAoAgAiAC0AFCICQQNxIAFB/wFxRg0AIAAgAkH8AXEgAUEDcXI6ABQDQCAALQAAIgFBBHENASAAIAFBBHI6AAAgACgCECIBBEAgACABEQAACyAAQYCAgP4HNgKcASAAKALkAyIADQALCwt2AQF/AkAgACgCACIALQAUIgJBAnZBA3EgAUH/AXFGDQAgACACQfMBcSABQQJ0QQxxcjoAFANAIAAtAAAiAUEEcQ0BIAAgAUEEcjoAACAAKAIQIgEEQCAAIAERAAALIABBgICA/gc2ApwBIAAoAuQDIgANAAsLC48BAQF/AkAgACgCACIALwAVIgJBCHZBD3EgAUH/AXFGDQAgAEEXaiACIAAtABdBEHRyIgJBEHY6AAAgACACQf/hA3EgAUEPcUEIdHI7ABUDQCAALQAAIgFBBHENASAAIAFBBHI6AAAgACgCECIBBEAgACABEQAACyAAQYCAgP4HNgKcASAAKALkAyIADQALCwuPAQEBfwJAIAFB/wFxIAAoAgAiAC8AFSAAQRdqLQAAQRB0ciICQfABcUEEdkYNACAAIAJBEHY6ABcgACACQY/+A3EgAUEEdEHwAXFyOwAVA0AgAC0AACIBQQRxDQEgACABQQRyOgAAIAAoAhAiAQRAIAAgAREAAAsgAEGAgID+BzYCnAEgACgC5AMiAA0ACwsLhwEBAX8CQCAAKAIAIgAvABUgAEEXai0AAEEQdHIiAkEPcSABQf8BcUYNACAAIAJBEHY6ABcgACACQfD/A3EgAUEPcXI7ABUDQCAALQAAIgFBBHENASAAIAFBBHI6AAAgACgCECIBBEAgACABEQAACyAAQYCAgP4HNgKcASAAKALkAyIADQALCwtDAQF/IwBBEGsiAiQAIAAoAgAhACACQQM6AAwgAkGAgID+BzYCCCACIAIpAwg3AwAgACABQf8BcSACEGcgAkEQaiQAC4ABAgN/AX0jAEEQayIDJAAgACgCACEEAn0gArYiBiAGXARAQQAhAEMAAMB/DAELQQBBAiAGQwAAgH9bIAZDAACA/1tyIgUbIQBDAADAfyAGIAUbCyEGIAMgADoADCADIAY4AgggAyADKQMINwMAIAQgAUH/AXEgAxBnIANBEGokAAt4AgF9An8jAEEQayIEJAAgACgCACEFIAQCfyACtiIDIANcBEBDAADAfyEDQQAMAQtDAADAfyADIANDAACAf1sgA0MAAID/W3IiABshAyAARQs6AAwgBCADOAIIIAQgBCkDCDcDACAFIAFB/wFxIAQQZyAEQRBqJAALjwEBAX8CQCAAKAIAIgAvABUiAkEMdkEDcSABQf8BcUYNACAAQRdqIAIgAC0AF0EQdHIiAkEQdjoAACAAIAJB/58DcSABQQNxQQx0cjsAFQNAIAAtAAAiAUEEcQ0BIAAgAUEEcjoAACAAKAIQIgEEQCAAIAERAAALIABBgICA/gc2ApwBIAAoAuQDIgANAAsLC5ABAQF/AkAgACgCACIAQRdqLQAAIgJBBHZBAXEgAUH/AXFGDQAgACAALwAVIAJBEHRyIgI7ABUgACACQf//vwdxIAFBAXFBFHRyQRB2OgAXA0AgAC0AACIBQQRxDQEgACABQQRyOgAAIAAoAhAiAQRAIAAgAREAAAsgAEGAgID+BzYCnAEgACgC5AMiAA0ACwsL9g0CCH8CfSMAQRBrIgIkAAJAAkAgASgCACIFLQAUIAAoAgAiAS0AFHNB/wBxDQAgBS8AFSAFLQAXQRB0ciABLwAVIAEtABdBEHRyc0H//z9xDQAgBUH8AGohByABQfwAaiEIAkAgAS8AGCIAQQdxRQRAIAUtABhBB3FFDQELIAggABAgIgogByAFLwAYECAiC1sNACAKIApbIAsgC1tyDQELAkAgAS8AGiIAQQdxRQRAIAUtABpBB3FFDQELIAggABAgIgogByAFLwAaECAiC1sNACAKIApbIAsgC1tyDQELAkAgAS8AHCIAQQdxRQRAIAUtABxBB3FFDQELIAggABAgIgogByAFLwAcECAiC1sNACAKIApbIAsgC1tyDQELAkAgAS8AHiIAQQdxRQRAIAUtAB5BB3FFDQELIAJBCGogCCAAEB8gAiAHIAUvAB4QH0EBIQAgAioCCCIKIAIqAgAiC1wEfyAKIApbDQIgCyALXAUgAAtFDQEgAi0ADCACLQAERw0BCyAFQSBqIQAgAUEgaiEGA0ACQCAGIANBAXRqLwAAIgRBB3FFBEAgAC0AAEEHcUUNAQsgAkEIaiAIIAQQHyACIAcgAC8AABAfQQEhBCACKgIIIgogAioCACILXAR/IAogClsNAyALIAtcBSAEC0UNAiACLQAMIAItAARHDQILIABBAmohACADQQFqIgNBCUcNAAsgBUEyaiEAIAFBMmohBkEAIQMDQAJAIAYgA0EBdGovAAAiBEEHcUUEQCAALQAAQQdxRQ0BCyACQQhqIAggBBAfIAIgByAALwAAEB9BASEEIAIqAggiCiACKgIAIgtcBH8gCiAKWw0DIAsgC1wFIAQLRQ0CIAItAAwgAi0ABEcNAgsgAEECaiEAIANBAWoiA0EJRw0ACyAFQcQAaiEAIAFBxABqIQZBACEDA0ACQCAGIANBAXRqLwAAIgRBB3FFBEAgAC0AAEEHcUUNAQsgAkEIaiAIIAQQHyACIAcgAC8AABAfQQEhBCACKgIIIgogAioCACILXAR/IAogClsNAyALIAtcBSAEC0UNAiACLQAMIAItAARHDQILIABBAmohACADQQFqIgNBCUcNAAsgBUHWAGohACABQdYAaiEGQQAhAwNAAkAgBiADQQF0ai8AACIEQQdxRQRAIAAtAABBB3FFDQELIAJBCGogCCAEEB8gAiAHIAAvAAAQH0EBIQQgAioCCCIKIAIqAgAiC1wEfyAKIApbDQMgCyALXAUgBAtFDQIgAi0ADCACLQAERw0CCyAAQQJqIQAgA0EBaiIDQQlHDQALIAVB6ABqIQAgAUHoAGohBkEAIQMDQAJAIAYgA0EBdGovAAAiBEEHcUUEQCAALQAAQQdxRQ0BCyACQQhqIAggBBAfIAIgByAALwAAEB9BASEEIAIqAggiCiACKgIAIgtcBH8gCiAKWw0DIAsgC1wFIAQLRQ0CIAItAAwgAi0ABEcNAgsgAEECaiEAIANBAWoiA0EDRw0ACyAFQe4AaiEAIAFB7gBqIQlBACEEQQAhAwNAAkAgCSADQQF0ai8AACIGQQdxRQRAIAAtAABBB3FFDQELIAJBCGogCCAGEB8gAiAHIAAvAAAQH0EBIQMgAioCCCIKIAIqAgAiC1wEfyAKIApbDQMgCyALXAUgAwtFDQIgAi0ADCACLQAERw0CCyAAQQJqIQBBASEDIAQhBkEBIQQgBkUNAAsgBUHyAGohACABQfIAaiEJQQAhBEEAIQMDQAJAIAkgA0EBdGovAAAiBkEHcUUEQCAALQAAQQdxRQ0BCyACQQhqIAggBhAfIAIgByAALwAAEB9BASEDIAIqAggiCiACKgIAIgtcBH8gCiAKWw0DIAsgC1wFIAMLRQ0CIAItAAwgAi0ABEcNAgsgAEECaiEAQQEhAyAEIQZBASEEIAZFDQALIAVB9gBqIQAgAUH2AGohCUEAIQRBACEDA0ACQCAJIANBAXRqLwAAIgZBB3FFBEAgAC0AAEEHcUUNAQsgAkEIaiAIIAYQHyACIAcgAC8AABAfQQEhAyACKgIIIgogAioCACILXAR/IAogClsNAyALIAtcBSADC0UNAiACLQAMIAItAARHDQILIABBAmohAEEBIQMgBCEGQQEhBCAGRQ0ACyABLwB6IgBBB3FFBEAgBS0AekEHcUUNAgsgCCAAECAiCiAHIAUvAHoQICILWw0BIAogClsNACALIAtcDQELIAFBFGogBUEUakHoABArGiABQfwAaiAFQfwAahCgAQNAIAEtAAAiAEEEcQ0BIAEgAEEEcjoAACABKAIQIgAEQCABIAARAAALIAFBgICA/gc2ApwBIAEoAuQDIgENAAsLIAJBEGokAAvGAwEEfyMAQaAEayICJAAgACgCBCEBIABBADYCBCABBEAgASABKAIAKAIEEQAACyAAKAIIIQEgAEEANgIIIAEEQCABIAEoAgAoAgQRAAALAkAgACgCACIAKALoAyAAKALsA0YEQCAAKALkAw0BIAAgAkEYaiAAKAL0AxBcIgEpAgA3AgAgACABKAIQNgIQIAAgASkCCDcCCCAAQRRqIAFBFGpB6AAQKxogACABKQKMATcCjAEgACABKQKEATcChAEgACABKQJ8NwJ8IAEoApQBIQQgAUEANgKUASAAKAKUASEDIAAgBDYClAEgAwRAIAMQWwsgAEGYAWogAUGYAWpB0AIQKxogACgC6AMiAwRAIAAgAzYC7AMgAxAjCyAAIAEoAugDNgLoAyAAIAEoAuwDNgLsAyAAIAEoAvADNgLwAyABQQA2AvADIAFCADcC6AMgACABKQL8AzcC/AMgACABKQL0AzcC9AMgACABKAKEBDYChAQgASgClAEhACABQQA2ApQBIAAEQCAAEFsLIAJBoARqJAAPCyACQfAcNgIQIABBBUHYJSACQRBqECwQJAALIAJB5hE2AgAgAEEFQdglIAIQLBAkAAsLAEEMEB4gABCiAQsLAEEMEB5BABCiAQsNACAAKAIALQAIQQFxCwoAIAAoAgAoAhQLGQAgAUH/AXEEQBACAAsgACgCACgCEEEBcQsYACAAKAIAIgAgAC0ACEH+AXEgAXI6AAgLJgAgASAAKAIAIgAoAhRHBEAgACABNgIUIAAgACgCDEEBajYCDAsLkgEBAn8jAEEQayICJAAgACgCACEAIAFDAAAAAGAEQCABIAAqAhhcBEAgACABOAIYIAAgACgCDEEBajYCDAsgAkEQaiQADwsgAkGIFDYCACMAQRBrIgMkACADIAI2AgwCQCAARQRAQbgwQdglIAIQSRoMAQsgAEEAQQVB2CUgAiAAKAIEEQ0AGgsgA0EQaiQAECQACz8AIAFB/wFxRQRAIAIgACgCACIAKAIQIgFBAXFHBEAgACABQX5xIAJyNgIQIAAgACgCDEEBajYCDAsPCxACAAsL4CYjAEGACAuBHk9ubHkgbGVhZiBub2RlcyB3aXRoIGN1c3RvbSBtZWFzdXJlIGZ1bmN0aW9ucyBzaG91bGQgbWFudWFsbHkgbWFyayB0aGVtc2VsdmVzIGFzIGRpcnR5AGlzRGlydHkAbWFya0RpcnR5AGRlc3Ryb3kAc2V0RGlzcGxheQBnZXREaXNwbGF5AHNldEZsZXgALSsgICAwWDB4AC0wWCswWCAwWC0weCsweCAweABzZXRGbGV4R3JvdwBnZXRGbGV4R3JvdwBzZXRPdmVyZmxvdwBnZXRPdmVyZmxvdwBoYXNOZXdMYXlvdXQAY2FsY3VsYXRlTGF5b3V0AGdldENvbXB1dGVkTGF5b3V0AHVuc2lnbmVkIHNob3J0AGdldENoaWxkQ291bnQAdW5zaWduZWQgaW50AHNldEp1c3RpZnlDb250ZW50AGdldEp1c3RpZnlDb250ZW50AGF2YWlsYWJsZUhlaWdodCBpcyBpbmRlZmluaXRlIHNvIGhlaWdodFNpemluZ01vZGUgbXVzdCBiZSBTaXppbmdNb2RlOjpNYXhDb250ZW50AGF2YWlsYWJsZVdpZHRoIGlzIGluZGVmaW5pdGUgc28gd2lkdGhTaXppbmdNb2RlIG11c3QgYmUgU2l6aW5nTW9kZTo6TWF4Q29udGVudABzZXRBbGlnbkNvbnRlbnQAZ2V0QWxpZ25Db250ZW50AGdldFBhcmVudABpbXBsZW1lbnQAc2V0TWF4SGVpZ2h0UGVyY2VudABzZXRIZWlnaHRQZXJjZW50AHNldE1pbkhlaWdodFBlcmNlbnQAc2V0RmxleEJhc2lzUGVyY2VudABzZXRHYXBQZXJjZW50AHNldFBvc2l0aW9uUGVyY2VudABzZXRNYXJnaW5QZXJjZW50AHNldE1heFdpZHRoUGVyY2VudABzZXRXaWR0aFBlcmNlbnQAc2V0TWluV2lkdGhQZXJjZW50AHNldFBhZGRpbmdQZXJjZW50AGhhbmRsZS50eXBlKCkgPT0gU3R5bGVWYWx1ZUhhbmRsZTo6VHlwZTo6UG9pbnQgfHwgaGFuZGxlLnR5cGUoKSA9PSBTdHlsZVZhbHVlSGFuZGxlOjpUeXBlOjpQZXJjZW50AGNyZWF0ZURlZmF1bHQAdW5pdAByaWdodABoZWlnaHQAc2V0TWF4SGVpZ2h0AGdldE1heEhlaWdodABzZXRIZWlnaHQAZ2V0SGVpZ2h0AHNldE1pbkhlaWdodABnZXRNaW5IZWlnaHQAZ2V0Q29tcHV0ZWRIZWlnaHQAZ2V0Q29tcHV0ZWRSaWdodABsZWZ0AGdldENvbXB1dGVkTGVmdAByZXNldABfX2Rlc3RydWN0AGZsb2F0AHVpbnQ2NF90AHVzZVdlYkRlZmF1bHRzAHNldFVzZVdlYkRlZmF1bHRzAHNldEFsaWduSXRlbXMAZ2V0QWxpZ25JdGVtcwBzZXRGbGV4QmFzaXMAZ2V0RmxleEJhc2lzAENhbm5vdCBnZXQgbGF5b3V0IHByb3BlcnRpZXMgb2YgbXVsdGktZWRnZSBzaG9ydGhhbmRzAHNldFBvaW50U2NhbGVGYWN0b3IATWVhc3VyZUNhbGxiYWNrV3JhcHBlcgBEaXJ0aWVkQ2FsbGJhY2tXcmFwcGVyAENhbm5vdCByZXNldCBhIG5vZGUgc3RpbGwgYXR0YWNoZWQgdG8gYSBvd25lcgBzZXRCb3JkZXIAZ2V0Qm9yZGVyAGdldENvbXB1dGVkQm9yZGVyAGdldE51bWJlcgBoYW5kbGUudHlwZSgpID09IFN0eWxlVmFsdWVIYW5kbGU6OlR5cGU6Ok51bWJlcgB1bnNpZ25lZCBjaGFyAHRvcABnZXRDb21wdXRlZFRvcABzZXRGbGV4V3JhcABnZXRGbGV4V3JhcABzZXRHYXAAZ2V0R2FwACVwAHNldEhlaWdodEF1dG8Ac2V0RmxleEJhc2lzQXV0bwBzZXRQb3NpdGlvbkF1dG8Ac2V0TWFyZ2luQXV0bwBzZXRXaWR0aEF1dG8AU2NhbGUgZmFjdG9yIHNob3VsZCBub3QgYmUgbGVzcyB0aGFuIHplcm8Ac2V0QXNwZWN0UmF0aW8AZ2V0QXNwZWN0UmF0aW8Ac2V0UG9zaXRpb24AZ2V0UG9zaXRpb24Abm90aWZ5T25EZXN0cnVjdGlvbgBzZXRGbGV4RGlyZWN0aW9uAGdldEZsZXhEaXJlY3Rpb24Ac2V0RGlyZWN0aW9uAGdldERpcmVjdGlvbgBzZXRNYXJnaW4AZ2V0TWFyZ2luAGdldENvbXB1dGVkTWFyZ2luAG1hcmtMYXlvdXRTZWVuAG5hbgBib3R0b20AZ2V0Q29tcHV0ZWRCb3R0b20AYm9vbABlbXNjcmlwdGVuOjp2YWwAc2V0RmxleFNocmluawBnZXRGbGV4U2hyaW5rAHNldEFsd2F5c0Zvcm1zQ29udGFpbmluZ0Jsb2NrAE1lYXN1cmVDYWxsYmFjawBEaXJ0aWVkQ2FsbGJhY2sAZ2V0TGVuZ3RoAHdpZHRoAHNldE1heFdpZHRoAGdldE1heFdpZHRoAHNldFdpZHRoAGdldFdpZHRoAHNldE1pbldpZHRoAGdldE1pbldpZHRoAGdldENvbXB1dGVkV2lkdGgAcHVzaAAvaG9tZS9ydW5uZXIvd29yay95b2dhL3lvZ2EvamF2YXNjcmlwdC8uLi95b2dhL3N0eWxlL1NtYWxsVmFsdWVCdWZmZXIuaAAvaG9tZS9ydW5uZXIvd29yay95b2dhL3lvZ2EvamF2YXNjcmlwdC8uLi95b2dhL3N0eWxlL1N0eWxlVmFsdWVQb29sLmgAdW5zaWduZWQgbG9uZwBzZXRCb3hTaXppbmcAZ2V0Qm94U2l6aW5nAHN0ZDo6d3N0cmluZwBzdGQ6OnN0cmluZwBzdGQ6OnUxNnN0cmluZwBzdGQ6OnUzMnN0cmluZwBzZXRQYWRkaW5nAGdldFBhZGRpbmcAZ2V0Q29tcHV0ZWRQYWRkaW5nAFRyaWVkIHRvIGNvbnN0cnVjdCBZR05vZGUgd2l0aCBudWxsIGNvbmZpZwBBdHRlbXB0aW5nIHRvIGNvbnN0cnVjdCBOb2RlIHdpdGggbnVsbCBjb25maWcAY3JlYXRlV2l0aENvbmZpZwBpbmYAc2V0QWxpZ25TZWxmAGdldEFsaWduU2VsZgBTaXplAHZhbHVlAFZhbHVlAGNyZWF0ZQBtZWFzdXJlAHNldFBvc2l0aW9uVHlwZQBnZXRQb3NpdGlvblR5cGUAaXNSZWZlcmVuY2VCYXNlbGluZQBzZXRJc1JlZmVyZW5jZUJhc2VsaW5lAGNvcHlTdHlsZQBkb3VibGUATm9kZQBleHRlbmQAaW5zZXJ0Q2hpbGQAZ2V0Q2hpbGQAcmVtb3ZlQ2hpbGQAdm9pZABzZXRFeHBlcmltZW50YWxGZWF0dXJlRW5hYmxlZABpc0V4cGVyaW1lbnRhbEZlYXR1cmVFbmFibGVkAGRpcnRpZWQAQ2Fubm90IHJlc2V0IGEgbm9kZSB3aGljaCBzdGlsbCBoYXMgY2hpbGRyZW4gYXR0YWNoZWQAdW5zZXRNZWFzdXJlRnVuYwB1bnNldERpcnRpZWRGdW5jAHNldEVycmF0YQBnZXRFcnJhdGEATWVhc3VyZSBmdW5jdGlvbiByZXR1cm5lZCBhbiBpbnZhbGlkIGRpbWVuc2lvbiB0byBZb2dhOiBbd2lkdGg9JWYsIGhlaWdodD0lZl0ARXhwZWN0IGN1c3RvbSBiYXNlbGluZSBmdW5jdGlvbiB0byBub3QgcmV0dXJuIE5hTgBOQU4ASU5GAGVtc2NyaXB0ZW46Om1lbW9yeV92aWV3PHNob3J0PgBlbXNjcmlwdGVuOjptZW1vcnlfdmlldzx1bnNpZ25lZCBzaG9ydD4AZW1zY3JpcHRlbjo6bWVtb3J5X3ZpZXc8aW50PgBlbXNjcmlwdGVuOjptZW1vcnlfdmlldzx1bnNpZ25lZCBpbnQ+AGVtc2NyaXB0ZW46Om1lbW9yeV92aWV3PGZsb2F0PgBlbXNjcmlwdGVuOjptZW1vcnlfdmlldzx1aW50OF90PgBlbXNjcmlwdGVuOjptZW1vcnlfdmlldzxpbnQ4X3Q+AGVtc2NyaXB0ZW46Om1lbW9yeV92aWV3PHVpbnQxNl90PgBlbXNjcmlwdGVuOjptZW1vcnlfdmlldzxpbnQxNl90PgBlbXNjcmlwdGVuOjptZW1vcnlfdmlldzx1aW50MzJfdD4AZW1zY3JpcHRlbjo6bWVtb3J5X3ZpZXc8aW50MzJfdD4AZW1zY3JpcHRlbjo6bWVtb3J5X3ZpZXc8Y2hhcj4AZW1zY3JpcHRlbjo6bWVtb3J5X3ZpZXc8dW5zaWduZWQgY2hhcj4Ac3RkOjpiYXNpY19zdHJpbmc8dW5zaWduZWQgY2hhcj4AZW1zY3JpcHRlbjo6bWVtb3J5X3ZpZXc8c2lnbmVk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";
    if (!ua(H)) {
      var va = H;
      H = h.locateFile ? h.locateFile(va, q) : q + va;
    }
    function wa() {
      var a = H;
      try {
        if (a == H && w) return new Uint8Array(w);
        if (ua(a)) try {
          var b = xa(a.slice(37)), c = new Uint8Array(b.length);
          for (a = 0; a < b.length; ++a) c[a] = b.charCodeAt(a);
          var d = c;
        } catch (f) {
          throw Error("Converting base64 string to bytes failed.");
        }
        else d = void 0;
        var e = d;
        if (e) return e;
        throw "both async and sync fetching of the wasm failed";
      } catch (f) {
        x(f);
      }
    }
    __name(wa, "wa");
    function ya() {
      return w || "function" != typeof fetch ? Promise.resolve().then(function() {
        return wa();
      }) : fetch(H, { credentials: "same-origin" }).then(function(a) {
        if (!a.ok) throw "failed to load wasm binary file at '" + H + "'";
        return a.arrayBuffer();
      }).catch(function() {
        return wa();
      });
    }
    __name(ya, "ya");
    function za(a) {
      for (; 0 < a.length; ) a.shift()(h);
    }
    __name(za, "za");
    function Aa(a) {
      if (void 0 === a) return "_unknown";
      a = a.replace(/[^a-zA-Z0-9_]/g, "$");
      var b = a.charCodeAt(0);
      return 48 <= b && 57 >= b ? "_" + a : a;
    }
    __name(Aa, "Aa");
    function Ba(a, b) {
      a = Aa(a);
      return function() {
        return b.apply(this, arguments);
      };
    }
    __name(Ba, "Ba");
    var J = [{}, { value: void 0 }, { value: null }, { value: true }, { value: false }], Ca = [];
    function Da(a) {
      var b = Error, c = Ba(a, function(d) {
        this.name = a;
        this.message = d;
        d = Error(d).stack;
        void 0 !== d && (this.stack = this.toString() + "\n" + d.replace(/^Error(:[^\n]*)?\n/, ""));
      });
      c.prototype = Object.create(b.prototype);
      c.prototype.constructor = c;
      c.prototype.toString = function() {
        return void 0 === this.message ? this.name : this.name + ": " + this.message;
      };
      return c;
    }
    __name(Da, "Da");
    var K = void 0;
    function L(a) {
      throw new K(a);
    }
    __name(L, "L");
    var M = /* @__PURE__ */ __name((a) => {
      a || L("Cannot use deleted val. handle = " + a);
      return J[a].value;
    }, "M"), Ea = /* @__PURE__ */ __name((a) => {
      switch (a) {
        case void 0:
          return 1;
        case null:
          return 2;
        case true:
          return 3;
        case false:
          return 4;
        default:
          var b = Ca.length ? Ca.pop() : J.length;
          J[b] = { ga: 1, value: a };
          return b;
      }
    }, "Ea"), Fa = void 0, Ga = void 0;
    function N(a) {
      for (var b = ""; A[a]; ) b += Ga[A[a++]];
      return b;
    }
    __name(N, "N");
    var O = [];
    function Ha() {
      for (; O.length; ) {
        var a = O.pop();
        a.M.$ = false;
        a["delete"]();
      }
    }
    __name(Ha, "Ha");
    var P = void 0, Q = {};
    function Ia(a, b) {
      for (void 0 === b && L("ptr should not be undefined"); a.R; ) b = a.ba(b), a = a.R;
      return b;
    }
    __name(Ia, "Ia");
    var R = {};
    function Ja(a) {
      a = Ka(a);
      var b = N(a);
      S(a);
      return b;
    }
    __name(Ja, "Ja");
    function La(a, b) {
      var c = R[a];
      void 0 === c && L(b + " has unknown type " + Ja(a));
      return c;
    }
    __name(La, "La");
    function Ma() {
    }
    __name(Ma, "Ma");
    var Na = false;
    function Oa(a) {
      --a.count.value;
      0 === a.count.value && (a.T ? a.U.W(a.T) : a.P.N.W(a.O));
    }
    __name(Oa, "Oa");
    function Pa(a, b, c) {
      if (b === c) return a;
      if (void 0 === c.R) return null;
      a = Pa(a, b, c.R);
      return null === a ? null : c.na(a);
    }
    __name(Pa, "Pa");
    var Qa = {};
    function Ra(a, b) {
      b = Ia(a, b);
      return Q[b];
    }
    __name(Ra, "Ra");
    var Sa = void 0;
    function Ta(a) {
      throw new Sa(a);
    }
    __name(Ta, "Ta");
    function Ua(a, b) {
      b.P && b.O || Ta("makeClassHandle requires ptr and ptrType");
      !!b.U !== !!b.T && Ta("Both smartPtrType and smartPtr must be specified");
      b.count = { value: 1 };
      return T(Object.create(a, { M: { value: b } }));
    }
    __name(Ua, "Ua");
    function T(a) {
      if ("undefined" === typeof FinalizationRegistry) return T = /* @__PURE__ */ __name((b) => b, "T"), a;
      Na = new FinalizationRegistry((b) => {
        Oa(b.M);
      });
      T = /* @__PURE__ */ __name((b) => {
        var c = b.M;
        c.T && Na.register(b, { M: c }, b);
        return b;
      }, "T");
      Ma = /* @__PURE__ */ __name((b) => {
        Na.unregister(b);
      }, "Ma");
      return T(a);
    }
    __name(T, "T");
    var Va = {};
    function Wa(a) {
      for (; a.length; ) {
        var b = a.pop();
        a.pop()(b);
      }
    }
    __name(Wa, "Wa");
    function Xa(a) {
      return this.fromWireType(D[a >> 2]);
    }
    __name(Xa, "Xa");
    var U = {}, Ya = {};
    function V(a, b, c) {
      function d(k) {
        k = c(k);
        k.length !== a.length && Ta("Mismatched type converter count");
        for (var m = 0; m < a.length; ++m) W(a[m], k[m]);
      }
      __name(d, "d");
      a.forEach(function(k) {
        Ya[k] = b;
      });
      var e = Array(b.length), f = [], g = 0;
      b.forEach((k, m) => {
        R.hasOwnProperty(k) ? e[m] = R[k] : (f.push(k), U.hasOwnProperty(k) || (U[k] = []), U[k].push(() => {
          e[m] = R[k];
          ++g;
          g === f.length && d(e);
        }));
      });
      0 === f.length && d(e);
    }
    __name(V, "V");
    function Za(a) {
      switch (a) {
        case 1:
          return 0;
        case 2:
          return 1;
        case 4:
          return 2;
        case 8:
          return 3;
        default:
          throw new TypeError("Unknown type size: " + a);
      }
    }
    __name(Za, "Za");
    function W(a, b, c = {}) {
      if (!("argPackAdvance" in b)) throw new TypeError("registerType registeredInstance requires argPackAdvance");
      var d = b.name;
      a || L('type "' + d + '" must have a positive integer typeid pointer');
      if (R.hasOwnProperty(a)) {
        if (c.ua) return;
        L("Cannot register type '" + d + "' twice");
      }
      R[a] = b;
      delete Ya[a];
      U.hasOwnProperty(a) && (b = U[a], delete U[a], b.forEach((e) => e()));
    }
    __name(W, "W");
    function $a(a) {
      L(a.M.P.N.name + " instance already deleted");
    }
    __name($a, "$a");
    function X() {
    }
    __name(X, "X");
    function ab(a, b, c) {
      if (void 0 === a[b].S) {
        var d = a[b];
        a[b] = function() {
          a[b].S.hasOwnProperty(arguments.length) || L("Function '" + c + "' called with an invalid number of arguments (" + arguments.length + ") - expects one of (" + a[b].S + ")!");
          return a[b].S[arguments.length].apply(this, arguments);
        };
        a[b].S = [];
        a[b].S[d.Z] = d;
      }
    }
    __name(ab, "ab");
    function bb(a, b) {
      h.hasOwnProperty(a) ? (L("Cannot register public name '" + a + "' twice"), ab(h, a, a), h.hasOwnProperty(void 0) && L("Cannot register multiple overloads of a function with the same number of arguments (undefined)!"), h[a].S[void 0] = b) : h[a] = b;
    }
    __name(bb, "bb");
    function cb(a, b, c, d, e, f, g, k) {
      this.name = a;
      this.constructor = b;
      this.X = c;
      this.W = d;
      this.R = e;
      this.pa = f;
      this.ba = g;
      this.na = k;
      this.ja = [];
    }
    __name(cb, "cb");
    function db(a, b, c) {
      for (; b !== c; ) b.ba || L("Expected null or instance of " + c.name + ", got an instance of " + b.name), a = b.ba(a), b = b.R;
      return a;
    }
    __name(db, "db");
    function eb(a, b) {
      if (null === b) return this.ea && L("null is not a valid " + this.name), 0;
      b.M || L('Cannot pass "' + fb(b) + '" as a ' + this.name);
      b.M.O || L("Cannot pass deleted object as a pointer of type " + this.name);
      return db(b.M.O, b.M.P.N, this.N);
    }
    __name(eb, "eb");
    function gb(a, b) {
      if (null === b) {
        this.ea && L("null is not a valid " + this.name);
        if (this.da) {
          var c = this.fa();
          null !== a && a.push(this.W, c);
          return c;
        }
        return 0;
      }
      b.M || L('Cannot pass "' + fb(b) + '" as a ' + this.name);
      b.M.O || L("Cannot pass deleted object as a pointer of type " + this.name);
      !this.ca && b.M.P.ca && L("Cannot convert argument of type " + (b.M.U ? b.M.U.name : b.M.P.name) + " to parameter type " + this.name);
      c = db(b.M.O, b.M.P.N, this.N);
      if (this.da) switch (void 0 === b.M.T && L("Passing raw pointer to smart pointer is illegal"), this.Ba) {
        case 0:
          b.M.U === this ? c = b.M.T : L("Cannot convert argument of type " + (b.M.U ? b.M.U.name : b.M.P.name) + " to parameter type " + this.name);
          break;
        case 1:
          c = b.M.T;
          break;
        case 2:
          if (b.M.U === this) c = b.M.T;
          else {
            var d = b.clone();
            c = this.xa(c, Ea(function() {
              d["delete"]();
            }));
            null !== a && a.push(this.W, c);
          }
          break;
        default:
          L("Unsupporting sharing policy");
      }
      return c;
    }
    __name(gb, "gb");
    function hb(a, b) {
      if (null === b) return this.ea && L("null is not a valid " + this.name), 0;
      b.M || L('Cannot pass "' + fb(b) + '" as a ' + this.name);
      b.M.O || L("Cannot pass deleted object as a pointer of type " + this.name);
      b.M.P.ca && L("Cannot convert argument of type " + b.M.P.name + " to parameter type " + this.name);
      return db(b.M.O, b.M.P.N, this.N);
    }
    __name(hb, "hb");
    function Y(a, b, c, d) {
      this.name = a;
      this.N = b;
      this.ea = c;
      this.ca = d;
      this.da = false;
      this.W = this.xa = this.fa = this.ka = this.Ba = this.wa = void 0;
      void 0 !== b.R ? this.toWireType = gb : (this.toWireType = d ? eb : hb, this.V = null);
    }
    __name(Y, "Y");
    function ib(a, b) {
      h.hasOwnProperty(a) || Ta("Replacing nonexistant public symbol");
      h[a] = b;
      h[a].Z = void 0;
    }
    __name(ib, "ib");
    function jb(a, b) {
      var c = [];
      return function() {
        c.length = 0;
        Object.assign(c, arguments);
        if (a.includes("j")) {
          var d = h["dynCall_" + a];
          d = c && c.length ? d.apply(null, [b].concat(c)) : d.call(null, b);
        } else d = oa.get(b).apply(null, c);
        return d;
      };
    }
    __name(jb, "jb");
    function Z(a, b) {
      a = N(a);
      var c = a.includes("j") ? jb(a, b) : oa.get(b);
      "function" != typeof c && L("unknown function pointer with signature " + a + ": " + b);
      return c;
    }
    __name(Z, "Z");
    var mb = void 0;
    function nb(a, b) {
      function c(f) {
        e[f] || R[f] || (Ya[f] ? Ya[f].forEach(c) : (d.push(f), e[f] = true));
      }
      __name(c, "c");
      var d = [], e = {};
      b.forEach(c);
      throw new mb(a + ": " + d.map(Ja).join([", "]));
    }
    __name(nb, "nb");
    function ob(a, b, c, d, e) {
      var f = b.length;
      2 > f && L("argTypes array size mismatch! Must at least get return value and 'this' types!");
      var g = null !== b[1] && null !== c, k = false;
      for (c = 1; c < b.length; ++c) if (null !== b[c] && void 0 === b[c].V) {
        k = true;
        break;
      }
      var m = "void" !== b[0].name, l = f - 2, n = Array(l), p = [], r = [];
      return function() {
        arguments.length !== l && L("function " + a + " called with " + arguments.length + " arguments, expected " + l + " args!");
        r.length = 0;
        p.length = g ? 2 : 1;
        p[0] = e;
        if (g) {
          var u = b[1].toWireType(r, this);
          p[1] = u;
        }
        for (var t = 0; t < l; ++t) n[t] = b[t + 2].toWireType(r, arguments[t]), p.push(n[t]);
        t = d.apply(null, p);
        if (k) Wa(r);
        else for (var y = g ? 1 : 2; y < b.length; y++) {
          var B = 1 === y ? u : n[y - 2];
          null !== b[y].V && b[y].V(B);
        }
        u = m ? b[0].fromWireType(t) : void 0;
        return u;
      };
    }
    __name(ob, "ob");
    function pb(a, b) {
      for (var c = [], d = 0; d < a; d++) c.push(E[b + 4 * d >> 2]);
      return c;
    }
    __name(pb, "pb");
    function qb(a) {
      4 < a && 0 === --J[a].ga && (J[a] = void 0, Ca.push(a));
    }
    __name(qb, "qb");
    function fb(a) {
      if (null === a) return "null";
      var b = typeof a;
      return "object" === b || "array" === b || "function" === b ? a.toString() : "" + a;
    }
    __name(fb, "fb");
    function rb(a, b) {
      switch (b) {
        case 2:
          return function(c) {
            return this.fromWireType(la[c >> 2]);
          };
        case 3:
          return function(c) {
            return this.fromWireType(ma[c >> 3]);
          };
        default:
          throw new TypeError("Unknown float type: " + a);
      }
    }
    __name(rb, "rb");
    function sb(a, b, c) {
      switch (b) {
        case 0:
          return c ? function(d) {
            return ja[d];
          } : function(d) {
            return A[d];
          };
        case 1:
          return c ? function(d) {
            return C[d >> 1];
          } : function(d) {
            return ka[d >> 1];
          };
        case 2:
          return c ? function(d) {
            return D[d >> 2];
          } : function(d) {
            return E[d >> 2];
          };
        default:
          throw new TypeError("Unknown integer type: " + a);
      }
    }
    __name(sb, "sb");
    function tb(a, b) {
      for (var c = "", d = 0; !(d >= b / 2); ++d) {
        var e = C[a + 2 * d >> 1];
        if (0 == e) break;
        c += String.fromCharCode(e);
      }
      return c;
    }
    __name(tb, "tb");
    function ub(a, b, c) {
      void 0 === c && (c = 2147483647);
      if (2 > c) return 0;
      c -= 2;
      var d = b;
      c = c < 2 * a.length ? c / 2 : a.length;
      for (var e = 0; e < c; ++e) C[b >> 1] = a.charCodeAt(e), b += 2;
      C[b >> 1] = 0;
      return b - d;
    }
    __name(ub, "ub");
    function vb(a) {
      return 2 * a.length;
    }
    __name(vb, "vb");
    function wb(a, b) {
      for (var c = 0, d = ""; !(c >= b / 4); ) {
        var e = D[a + 4 * c >> 2];
        if (0 == e) break;
        ++c;
        65536 <= e ? (e -= 65536, d += String.fromCharCode(55296 | e >> 10, 56320 | e & 1023)) : d += String.fromCharCode(e);
      }
      return d;
    }
    __name(wb, "wb");
    function xb(a, b, c) {
      void 0 === c && (c = 2147483647);
      if (4 > c) return 0;
      var d = b;
      c = d + c - 4;
      for (var e = 0; e < a.length; ++e) {
        var f = a.charCodeAt(e);
        if (55296 <= f && 57343 >= f) {
          var g = a.charCodeAt(++e);
          f = 65536 + ((f & 1023) << 10) | g & 1023;
        }
        D[b >> 2] = f;
        b += 4;
        if (b + 4 > c) break;
      }
      D[b >> 2] = 0;
      return b - d;
    }
    __name(xb, "xb");
    function yb(a) {
      for (var b = 0, c = 0; c < a.length; ++c) {
        var d = a.charCodeAt(c);
        55296 <= d && 57343 >= d && ++c;
        b += 4;
      }
      return b;
    }
    __name(yb, "yb");
    var zb = {};
    function Ab(a) {
      var b = zb[a];
      return void 0 === b ? N(a) : b;
    }
    __name(Ab, "Ab");
    var Bb = [];
    function Cb(a) {
      var b = Bb.length;
      Bb.push(a);
      return b;
    }
    __name(Cb, "Cb");
    function Db(a, b) {
      for (var c = Array(a), d = 0; d < a; ++d) c[d] = La(E[b + 4 * d >> 2], "parameter " + d);
      return c;
    }
    __name(Db, "Db");
    var Eb = [], Fb = [null, [], []];
    K = h.BindingError = Da("BindingError");
    h.count_emval_handles = function() {
      for (var a = 0, b = 5; b < J.length; ++b) void 0 !== J[b] && ++a;
      return a;
    };
    h.get_first_emval = function() {
      for (var a = 5; a < J.length; ++a) if (void 0 !== J[a]) return J[a];
      return null;
    };
    Fa = h.PureVirtualError = Da("PureVirtualError");
    for (var Gb = Array(256), Hb = 0; 256 > Hb; ++Hb) Gb[Hb] = String.fromCharCode(Hb);
    Ga = Gb;
    h.getInheritedInstanceCount = function() {
      return Object.keys(Q).length;
    };
    h.getLiveInheritedInstances = function() {
      var a = [], b;
      for (b in Q) Q.hasOwnProperty(b) && a.push(Q[b]);
      return a;
    };
    h.flushPendingDeletes = Ha;
    h.setDelayFunction = function(a) {
      P = a;
      O.length && P && P(Ha);
    };
    Sa = h.InternalError = Da("InternalError");
    X.prototype.isAliasOf = function(a) {
      if (!(this instanceof X && a instanceof X)) return false;
      var b = this.M.P.N, c = this.M.O, d = a.M.P.N;
      for (a = a.M.O; b.R; ) c = b.ba(c), b = b.R;
      for (; d.R; ) a = d.ba(a), d = d.R;
      return b === d && c === a;
    };
    X.prototype.clone = function() {
      this.M.O || $a(this);
      if (this.M.aa) return this.M.count.value += 1, this;
      var a = T, b = Object, c = b.create, d = Object.getPrototypeOf(this), e = this.M;
      a = a(c.call(b, d, { M: { value: { count: e.count, $: e.$, aa: e.aa, O: e.O, P: e.P, T: e.T, U: e.U } } }));
      a.M.count.value += 1;
      a.M.$ = false;
      return a;
    };
    X.prototype["delete"] = function() {
      this.M.O || $a(this);
      this.M.$ && !this.M.aa && L("Object already scheduled for deletion");
      Ma(this);
      Oa(this.M);
      this.M.aa || (this.M.T = void 0, this.M.O = void 0);
    };
    X.prototype.isDeleted = function() {
      return !this.M.O;
    };
    X.prototype.deleteLater = function() {
      this.M.O || $a(this);
      this.M.$ && !this.M.aa && L("Object already scheduled for deletion");
      O.push(this);
      1 === O.length && P && P(Ha);
      this.M.$ = true;
      return this;
    };
    Y.prototype.qa = function(a) {
      this.ka && (a = this.ka(a));
      return a;
    };
    Y.prototype.ha = function(a) {
      this.W && this.W(a);
    };
    Y.prototype.argPackAdvance = 8;
    Y.prototype.readValueFromPointer = Xa;
    Y.prototype.deleteObject = function(a) {
      if (null !== a) a["delete"]();
    };
    Y.prototype.fromWireType = function(a) {
      function b() {
        return this.da ? Ua(this.N.X, { P: this.wa, O: c, U: this, T: a }) : Ua(this.N.X, { P: this, O: a });
      }
      __name(b, "b");
      var c = this.qa(a);
      if (!c) return this.ha(a), null;
      var d = Ra(this.N, c);
      if (void 0 !== d) {
        if (0 === d.M.count.value) return d.M.O = c, d.M.T = a, d.clone();
        d = d.clone();
        this.ha(a);
        return d;
      }
      d = this.N.pa(c);
      d = Qa[d];
      if (!d) return b.call(this);
      d = this.ca ? d.la : d.pointerType;
      var e = Pa(c, this.N, d.N);
      return null === e ? b.call(this) : this.da ? Ua(d.N.X, { P: d, O: e, U: this, T: a }) : Ua(d.N.X, { P: d, O: e });
    };
    mb = h.UnboundTypeError = Da("UnboundTypeError");
    var xa = "function" == typeof atob ? atob : function(a) {
      var b = "", c = 0;
      a = a.replace(/[^A-Za-z0-9\+\/=]/g, "");
      do {
        var d = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=".indexOf(a.charAt(c++));
        var e = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=".indexOf(a.charAt(c++));
        var f = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=".indexOf(a.charAt(c++));
        var g = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=".indexOf(a.charAt(c++));
        d = d << 2 | e >> 4;
        e = (e & 15) << 4 | f >> 2;
        var k = (f & 3) << 6 | g;
        b += String.fromCharCode(d);
        64 !== f && (b += String.fromCharCode(e));
        64 !== g && (b += String.fromCharCode(k));
      } while (c < a.length);
      return b;
    }, Jb = {
      l: /* @__PURE__ */ __name(function(a, b, c, d) {
        x("Assertion failed: " + (a ? z(A, a) : "") + ", at: " + [b ? b ? z(A, b) : "" : "unknown filename", c, d ? d ? z(A, d) : "" : "unknown function"]);
      }, "l"),
      q: /* @__PURE__ */ __name(function(a, b, c) {
        a = N(a);
        b = La(b, "wrapper");
        c = M(c);
        var d = [].slice, e = b.N, f = e.X, g = e.R.X, k = e.R.constructor;
        a = Ba(a, function() {
          e.R.ja.forEach(function(l) {
            if (this[l] === g[l]) throw new Fa("Pure virtual function " + l + " must be implemented in JavaScript");
          }.bind(this));
          Object.defineProperty(this, "__parent", { value: f });
          this.__construct.apply(this, d.call(arguments));
        });
        f.__construct = function() {
          this === f && L("Pass correct 'this' to __construct");
          var l = k.implement.apply(void 0, [this].concat(d.call(arguments)));
          Ma(l);
          var n = l.M;
          l.notifyOnDestruction();
          n.aa = true;
          Object.defineProperties(this, { M: { value: n } });
          T(this);
          l = n.O;
          l = Ia(e, l);
          Q.hasOwnProperty(l) ? L("Tried to register registered instance: " + l) : Q[l] = this;
        };
        f.__destruct = function() {
          this === f && L("Pass correct 'this' to __destruct");
          Ma(this);
          var l = this.M.O;
          l = Ia(e, l);
          Q.hasOwnProperty(l) ? delete Q[l] : L("Tried to unregister unregistered instance: " + l);
        };
        a.prototype = Object.create(f);
        for (var m in c) a.prototype[m] = c[m];
        return Ea(a);
      }, "q"),
      j: /* @__PURE__ */ __name(function(a) {
        var b = Va[a];
        delete Va[a];
        var c = b.fa, d = b.W, e = b.ia, f = e.map((g) => g.ta).concat(e.map((g) => g.za));
        V([a], f, (g) => {
          var k = {};
          e.forEach((m, l) => {
            var n = g[l], p = m.ra, r = m.sa, u = g[l + e.length], t = m.ya, y = m.Aa;
            k[m.oa] = { read: /* @__PURE__ */ __name((B) => n.fromWireType(p(r, B)), "read"), write: /* @__PURE__ */ __name((B, ba) => {
              var I = [];
              t(
                y,
                B,
                u.toWireType(I, ba)
              );
              Wa(I);
            }, "write") };
          });
          return [{ name: b.name, fromWireType: /* @__PURE__ */ __name(function(m) {
            var l = {}, n;
            for (n in k) l[n] = k[n].read(m);
            d(m);
            return l;
          }, "fromWireType"), toWireType: /* @__PURE__ */ __name(function(m, l) {
            for (var n in k) if (!(n in l)) throw new TypeError('Missing field:  "' + n + '"');
            var p = c();
            for (n in k) k[n].write(p, l[n]);
            null !== m && m.push(d, p);
            return p;
          }, "toWireType"), argPackAdvance: 8, readValueFromPointer: Xa, V: d }];
        });
      }, "j"),
      v: /* @__PURE__ */ __name(function() {
      }, "v"),
      B: /* @__PURE__ */ __name(function(a, b, c, d, e) {
        var f = Za(c);
        b = N(b);
        W(a, {
          name: b,
          fromWireType: /* @__PURE__ */ __name(function(g) {
            return !!g;
          }, "fromWireType"),
          toWireType: /* @__PURE__ */ __name(function(g, k) {
            return k ? d : e;
          }, "toWireType"),
          argPackAdvance: 8,
          readValueFromPointer: /* @__PURE__ */ __name(function(g) {
            if (1 === c) var k = ja;
            else if (2 === c) k = C;
            else if (4 === c) k = D;
            else throw new TypeError("Unknown boolean type size: " + b);
            return this.fromWireType(k[g >> f]);
          }, "readValueFromPointer"),
          V: null
        });
      }, "B"),
      f: /* @__PURE__ */ __name(function(a, b, c, d, e, f, g, k, m, l, n, p, r) {
        n = N(n);
        f = Z(e, f);
        k && (k = Z(g, k));
        l && (l = Z(m, l));
        r = Z(p, r);
        var u = Aa(n);
        bb(u, function() {
          nb("Cannot construct " + n + " due to unbound types", [d]);
        });
        V([a, b, c], d ? [d] : [], function(t) {
          t = t[0];
          if (d) {
            var y = t.N;
            var B = y.X;
          } else B = X.prototype;
          t = Ba(u, function() {
            if (Object.getPrototypeOf(this) !== ba) throw new K("Use 'new' to construct " + n);
            if (void 0 === I.Y) throw new K(n + " has no accessible constructor");
            var kb = I.Y[arguments.length];
            if (void 0 === kb) throw new K("Tried to invoke ctor of " + n + " with invalid number of parameters (" + arguments.length + ") - expected (" + Object.keys(I.Y).toString() + ") parameters instead!");
            return kb.apply(this, arguments);
          });
          var ba = Object.create(B, { constructor: { value: t } });
          t.prototype = ba;
          var I = new cb(n, t, ba, r, y, f, k, l);
          y = new Y(n, I, true, false);
          B = new Y(n + "*", I, false, false);
          var lb = new Y(n + " const*", I, false, true);
          Qa[a] = {
            pointerType: B,
            la: lb
          };
          ib(u, t);
          return [y, B, lb];
        });
      }, "f"),
      d: /* @__PURE__ */ __name(function(a, b, c, d, e, f, g) {
        var k = pb(c, d);
        b = N(b);
        f = Z(e, f);
        V([], [a], function(m) {
          function l() {
            nb("Cannot call " + n + " due to unbound types", k);
          }
          __name(l, "l");
          m = m[0];
          var n = m.name + "." + b;
          b.startsWith("@@") && (b = Symbol[b.substring(2)]);
          var p = m.N.constructor;
          void 0 === p[b] ? (l.Z = c - 1, p[b] = l) : (ab(p, b, n), p[b].S[c - 1] = l);
          V([], k, function(r) {
            r = ob(n, [r[0], null].concat(r.slice(1)), null, f, g);
            void 0 === p[b].S ? (r.Z = c - 1, p[b] = r) : p[b].S[c - 1] = r;
            return [];
          });
          return [];
        });
      }, "d"),
      p: /* @__PURE__ */ __name(function(a, b, c, d, e, f) {
        0 < b || x();
        var g = pb(
          b,
          c
        );
        e = Z(d, e);
        V([], [a], function(k) {
          k = k[0];
          var m = "constructor " + k.name;
          void 0 === k.N.Y && (k.N.Y = []);
          if (void 0 !== k.N.Y[b - 1]) throw new K("Cannot register multiple constructors with identical number of parameters (" + (b - 1) + ") for class '" + k.name + "'! Overload resolution is currently only performed using the parameter count, not actual type info!");
          k.N.Y[b - 1] = () => {
            nb("Cannot construct " + k.name + " due to unbound types", g);
          };
          V([], g, function(l) {
            l.splice(1, 0, null);
            k.N.Y[b - 1] = ob(m, l, null, e, f);
            return [];
          });
          return [];
        });
      }, "p"),
      a: /* @__PURE__ */ __name(function(a, b, c, d, e, f, g, k) {
        var m = pb(c, d);
        b = N(b);
        f = Z(e, f);
        V([], [a], function(l) {
          function n() {
            nb("Cannot call " + p + " due to unbound types", m);
          }
          __name(n, "n");
          l = l[0];
          var p = l.name + "." + b;
          b.startsWith("@@") && (b = Symbol[b.substring(2)]);
          k && l.N.ja.push(b);
          var r = l.N.X, u = r[b];
          void 0 === u || void 0 === u.S && u.className !== l.name && u.Z === c - 2 ? (n.Z = c - 2, n.className = l.name, r[b] = n) : (ab(r, b, p), r[b].S[c - 2] = n);
          V([], m, function(t) {
            t = ob(p, t, l, f, g);
            void 0 === r[b].S ? (t.Z = c - 2, r[b] = t) : r[b].S[c - 2] = t;
            return [];
          });
          return [];
        });
      }, "a"),
      A: /* @__PURE__ */ __name(function(a, b) {
        b = N(b);
        W(
          a,
          { name: b, fromWireType: /* @__PURE__ */ __name(function(c) {
            var d = M(c);
            qb(c);
            return d;
          }, "fromWireType"), toWireType: /* @__PURE__ */ __name(function(c, d) {
            return Ea(d);
          }, "toWireType"), argPackAdvance: 8, readValueFromPointer: Xa, V: null }
        );
      }, "A"),
      n: /* @__PURE__ */ __name(function(a, b, c) {
        c = Za(c);
        b = N(b);
        W(a, { name: b, fromWireType: /* @__PURE__ */ __name(function(d) {
          return d;
        }, "fromWireType"), toWireType: /* @__PURE__ */ __name(function(d, e) {
          return e;
        }, "toWireType"), argPackAdvance: 8, readValueFromPointer: rb(b, c), V: null });
      }, "n"),
      e: /* @__PURE__ */ __name(function(a, b, c, d, e) {
        b = N(b);
        -1 === e && (e = 4294967295);
        e = Za(c);
        var f = /* @__PURE__ */ __name((k) => k, "f");
        if (0 === d) {
          var g = 32 - 8 * c;
          f = /* @__PURE__ */ __name((k) => k << g >>> g, "f");
        }
        c = b.includes("unsigned") ? function(k, m) {
          return m >>> 0;
        } : function(k, m) {
          return m;
        };
        W(a, { name: b, fromWireType: f, toWireType: c, argPackAdvance: 8, readValueFromPointer: sb(b, e, 0 !== d), V: null });
      }, "e"),
      b: /* @__PURE__ */ __name(function(a, b, c) {
        function d(f) {
          f >>= 2;
          var g = E;
          return new e(ia, g[f + 1], g[f]);
        }
        __name(d, "d");
        var e = [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array][b];
        c = N(c);
        W(a, { name: c, fromWireType: d, argPackAdvance: 8, readValueFromPointer: d }, { ua: true });
      }, "b"),
      o: /* @__PURE__ */ __name(function(a, b) {
        b = N(b);
        var c = "std::string" === b;
        W(a, { name: b, fromWireType: /* @__PURE__ */ __name(function(d) {
          var e = E[d >> 2], f = d + 4;
          if (c) for (var g = f, k = 0; k <= e; ++k) {
            var m = f + k;
            if (k == e || 0 == A[m]) {
              g = g ? z(A, g, m - g) : "";
              if (void 0 === l) var l = g;
              else l += String.fromCharCode(0), l += g;
              g = m + 1;
            }
          }
          else {
            l = Array(e);
            for (k = 0; k < e; ++k) l[k] = String.fromCharCode(A[f + k]);
            l = l.join("");
          }
          S(d);
          return l;
        }, "fromWireType"), toWireType: /* @__PURE__ */ __name(function(d, e) {
          e instanceof ArrayBuffer && (e = new Uint8Array(e));
          var f, g = "string" == typeof e;
          g || e instanceof Uint8Array || e instanceof Uint8ClampedArray || e instanceof Int8Array || L("Cannot pass non-string to std::string");
          if (c && g) {
            var k = 0;
            for (f = 0; f < e.length; ++f) {
              var m = e.charCodeAt(f);
              127 >= m ? k++ : 2047 >= m ? k += 2 : 55296 <= m && 57343 >= m ? (k += 4, ++f) : k += 3;
            }
            f = k;
          } else f = e.length;
          k = Ib(4 + f + 1);
          m = k + 4;
          E[k >> 2] = f;
          if (c && g) {
            if (g = m, m = f + 1, f = A, 0 < m) {
              m = g + m - 1;
              for (var l = 0; l < e.length; ++l) {
                var n = e.charCodeAt(l);
                if (55296 <= n && 57343 >= n) {
                  var p = e.charCodeAt(++l);
                  n = 65536 + ((n & 1023) << 10) | p & 1023;
                }
                if (127 >= n) {
                  if (g >= m) break;
                  f[g++] = n;
                } else {
                  if (2047 >= n) {
                    if (g + 1 >= m) break;
                    f[g++] = 192 | n >> 6;
                  } else {
                    if (65535 >= n) {
                      if (g + 2 >= m) break;
                      f[g++] = 224 | n >> 12;
                    } else {
                      if (g + 3 >= m) break;
                      f[g++] = 240 | n >> 18;
                      f[g++] = 128 | n >> 12 & 63;
                    }
                    f[g++] = 128 | n >> 6 & 63;
                  }
                  f[g++] = 128 | n & 63;
                }
              }
              f[g] = 0;
            }
          } else if (g) for (g = 0; g < f; ++g) l = e.charCodeAt(g), 255 < l && (S(m), L("String has UTF-16 code units that do not fit in 8 bits")), A[m + g] = l;
          else for (g = 0; g < f; ++g) A[m + g] = e[g];
          null !== d && d.push(S, k);
          return k;
        }, "toWireType"), argPackAdvance: 8, readValueFromPointer: Xa, V: /* @__PURE__ */ __name(function(d) {
          S(d);
        }, "V") });
      }, "o"),
      i: /* @__PURE__ */ __name(function(a, b, c) {
        c = N(c);
        if (2 === b) {
          var d = tb;
          var e = ub;
          var f = vb;
          var g = /* @__PURE__ */ __name(() => ka, "g");
          var k = 1;
        } else 4 === b && (d = wb, e = xb, f = yb, g = /* @__PURE__ */ __name(() => E, "g"), k = 2);
        W(a, { name: c, fromWireType: /* @__PURE__ */ __name(function(m) {
          for (var l = E[m >> 2], n = g(), p, r = m + 4, u = 0; u <= l; ++u) {
            var t = m + 4 + u * b;
            if (u == l || 0 == n[t >> k]) r = d(r, t - r), void 0 === p ? p = r : (p += String.fromCharCode(0), p += r), r = t + b;
          }
          S(m);
          return p;
        }, "fromWireType"), toWireType: /* @__PURE__ */ __name(function(m, l) {
          "string" != typeof l && L("Cannot pass non-string to C++ string type " + c);
          var n = f(l), p = Ib(4 + n + b);
          E[p >> 2] = n >> k;
          e(l, p + 4, n + b);
          null !== m && m.push(S, p);
          return p;
        }, "toWireType"), argPackAdvance: 8, readValueFromPointer: Xa, V: /* @__PURE__ */ __name(function(m) {
          S(m);
        }, "V") });
      }, "i"),
      k: /* @__PURE__ */ __name(function(a, b, c, d, e, f) {
        Va[a] = { name: N(b), fa: Z(c, d), W: Z(e, f), ia: [] };
      }, "k"),
      h: /* @__PURE__ */ __name(function(a, b, c, d, e, f, g, k, m, l) {
        Va[a].ia.push({ oa: N(b), ta: c, ra: Z(d, e), sa: f, za: g, ya: Z(k, m), Aa: l });
      }, "h"),
      C: /* @__PURE__ */ __name(function(a, b) {
        b = N(b);
        W(a, {
          va: true,
          name: b,
          argPackAdvance: 0,
          fromWireType: /* @__PURE__ */ __name(function() {
          }, "fromWireType"),
          toWireType: /* @__PURE__ */ __name(function() {
          }, "toWireType")
        });
      }, "C"),
      s: /* @__PURE__ */ __name(function(a, b, c, d, e) {
        a = Bb[a];
        b = M(b);
        c = Ab(c);
        var f = [];
        E[d >> 2] = Ea(f);
        return a(b, c, f, e);
      }, "s"),
      t: /* @__PURE__ */ __name(function(a, b, c, d) {
        a = Bb[a];
        b = M(b);
        c = Ab(c);
        a(b, c, null, d);
      }, "t"),
      g: qb,
      m: /* @__PURE__ */ __name(function(a, b) {
        var c = Db(a, b), d = c[0];
        b = d.name + "_$" + c.slice(1).map(function(g) {
          return g.name;
        }).join("_") + "$";
        var e = Eb[b];
        if (void 0 !== e) return e;
        var f = Array(a - 1);
        e = Cb((g, k, m, l) => {
          for (var n = 0, p = 0; p < a - 1; ++p) f[p] = c[p + 1].readValueFromPointer(l + n), n += c[p + 1].argPackAdvance;
          g = g[k].apply(
            g,
            f
          );
          for (p = 0; p < a - 1; ++p) c[p + 1].ma && c[p + 1].ma(f[p]);
          if (!d.va) return d.toWireType(m, g);
        });
        return Eb[b] = e;
      }, "m"),
      D: /* @__PURE__ */ __name(function(a) {
        4 < a && (J[a].ga += 1);
      }, "D"),
      r: /* @__PURE__ */ __name(function(a) {
        var b = M(a);
        Wa(b);
        qb(a);
      }, "r"),
      c: /* @__PURE__ */ __name(function() {
        x("");
      }, "c"),
      x: /* @__PURE__ */ __name(function(a, b, c) {
        A.copyWithin(a, b, b + c);
      }, "x"),
      w: /* @__PURE__ */ __name(function(a) {
        var b = A.length;
        a >>>= 0;
        if (2147483648 < a) return false;
        for (var c = 1; 4 >= c; c *= 2) {
          var d = b * (1 + 0.2 / c);
          d = Math.min(d, a + 100663296);
          var e = Math;
          d = Math.max(a, d);
          e = e.min.call(e, 2147483648, d + (65536 - d % 65536) % 65536);
          a: {
            try {
              fa.grow(e - ia.byteLength + 65535 >>> 16);
              na();
              var f = 1;
              break a;
            } catch (g) {
            }
            f = void 0;
          }
          if (f) return true;
        }
        return false;
      }, "w"),
      z: /* @__PURE__ */ __name(function() {
        return 52;
      }, "z"),
      u: /* @__PURE__ */ __name(function() {
        return 70;
      }, "u"),
      y: /* @__PURE__ */ __name(function(a, b, c, d) {
        for (var e = 0, f = 0; f < c; f++) {
          var g = E[b >> 2], k = E[b + 4 >> 2];
          b += 8;
          for (var m = 0; m < k; m++) {
            var l = A[g + m], n = Fb[a];
            0 === l || 10 === l ? ((1 === a ? ea : v)(z(n, 0)), n.length = 0) : n.push(l);
          }
          e += k;
        }
        E[d >> 2] = e;
        return 0;
      }, "y")
    };
    (function() {
      function a(e) {
        h.asm = e.exports;
        fa = h.asm.E;
        na();
        oa = h.asm.J;
        qa.unshift(h.asm.F);
        F--;
        h.monitorRunDependencies && h.monitorRunDependencies(F);
        0 == F && (null !== ta && (clearInterval(ta), ta = null), G && (e = G, G = null, e()));
      }
      __name(a, "a");
      function b(e) {
        a(e.instance);
      }
      __name(b, "b");
      function c(e) {
        return ya().then(function(f) {
          return WebAssembly.instantiate(f, d);
        }).then(function(f) {
          return f;
        }).then(e, function(f) {
          v("failed to asynchronously prepare wasm: " + f);
          x(f);
        });
      }
      __name(c, "c");
      var d = { a: Jb };
      F++;
      h.monitorRunDependencies && h.monitorRunDependencies(F);
      if (h.instantiateWasm) try {
        return h.instantiateWasm(
          d,
          a
        );
      } catch (e) {
        v("Module.instantiateWasm callback failed with error: " + e), ca(e);
      }
      (function() {
        return w || "function" != typeof WebAssembly.instantiateStreaming || ua(H) || "function" != typeof fetch ? c(b) : fetch(H, { credentials: "same-origin" }).then(function(e) {
          return WebAssembly.instantiateStreaming(e, d).then(b, function(f) {
            v("wasm streaming compile failed: " + f);
            v("falling back to ArrayBuffer instantiation");
            return c(b);
          });
        });
      })().catch(ca);
      return {};
    })();
    h.___wasm_call_ctors = function() {
      return (h.___wasm_call_ctors = h.asm.F).apply(null, arguments);
    };
    var Ka = h.___getTypeName = function() {
      return (Ka = h.___getTypeName = h.asm.G).apply(null, arguments);
    };
    h.__embind_initialize_bindings = function() {
      return (h.__embind_initialize_bindings = h.asm.H).apply(null, arguments);
    };
    var Ib = h._malloc = function() {
      return (Ib = h._malloc = h.asm.I).apply(null, arguments);
    }, S = h._free = function() {
      return (S = h._free = h.asm.K).apply(null, arguments);
    };
    h.dynCall_jiji = function() {
      return (h.dynCall_jiji = h.asm.L).apply(null, arguments);
    };
    var Kb;
    G = /* @__PURE__ */ __name(function Lb() {
      Kb || Mb();
      Kb || (G = Lb);
    }, "Lb");
    function Mb() {
      function a() {
        if (!Kb && (Kb = true, h.calledRun = true, !ha)) {
          za(qa);
          aa(h);
          if (h.onRuntimeInitialized) h.onRuntimeInitialized();
          if (h.postRun) for ("function" == typeof h.postRun && (h.postRun = [h.postRun]); h.postRun.length; ) {
            var b = h.postRun.shift();
            ra.unshift(b);
          }
          za(ra);
        }
      }
      __name(a, "a");
      if (!(0 < F)) {
        if (h.preRun) for ("function" == typeof h.preRun && (h.preRun = [h.preRun]); h.preRun.length; ) sa();
        za(pa);
        0 < F || (h.setStatus ? (h.setStatus("Running..."), setTimeout(function() {
          setTimeout(function() {
            h.setStatus("");
          }, 1);
          a();
        }, 1)) : a());
      }
    }
    __name(Mb, "Mb");
    if (h.preInit) for ("function" == typeof h.preInit && (h.preInit = [h.preInit]); 0 < h.preInit.length; ) h.preInit.pop()();
    Mb();
    return loadYoga2.ready;
  };
})();
var yoga_wasm_base64_esm_default = loadYoga;

// node_modules/yoga-layout/dist/src/wrapAssembly.js
init_esbuild_shims();

// node_modules/yoga-layout/dist/src/generated/YGEnums.js
init_esbuild_shims();
var Align = /* @__PURE__ */ function(Align2) {
  Align2[Align2["Auto"] = 0] = "Auto";
  Align2[Align2["FlexStart"] = 1] = "FlexStart";
  Align2[Align2["Center"] = 2] = "Center";
  Align2[Align2["FlexEnd"] = 3] = "FlexEnd";
  Align2[Align2["Stretch"] = 4] = "Stretch";
  Align2[Align2["Baseline"] = 5] = "Baseline";
  Align2[Align2["SpaceBetween"] = 6] = "SpaceBetween";
  Align2[Align2["SpaceAround"] = 7] = "SpaceAround";
  Align2[Align2["SpaceEvenly"] = 8] = "SpaceEvenly";
  return Align2;
}({});
var BoxSizing = /* @__PURE__ */ function(BoxSizing2) {
  BoxSizing2[BoxSizing2["BorderBox"] = 0] = "BorderBox";
  BoxSizing2[BoxSizing2["ContentBox"] = 1] = "ContentBox";
  return BoxSizing2;
}({});
var Dimension = /* @__PURE__ */ function(Dimension2) {
  Dimension2[Dimension2["Width"] = 0] = "Width";
  Dimension2[Dimension2["Height"] = 1] = "Height";
  return Dimension2;
}({});
var Direction = /* @__PURE__ */ function(Direction2) {
  Direction2[Direction2["Inherit"] = 0] = "Inherit";
  Direction2[Direction2["LTR"] = 1] = "LTR";
  Direction2[Direction2["RTL"] = 2] = "RTL";
  return Direction2;
}({});
var Display = /* @__PURE__ */ function(Display2) {
  Display2[Display2["Flex"] = 0] = "Flex";
  Display2[Display2["None"] = 1] = "None";
  Display2[Display2["Contents"] = 2] = "Contents";
  return Display2;
}({});
var Edge = /* @__PURE__ */ function(Edge2) {
  Edge2[Edge2["Left"] = 0] = "Left";
  Edge2[Edge2["Top"] = 1] = "Top";
  Edge2[Edge2["Right"] = 2] = "Right";
  Edge2[Edge2["Bottom"] = 3] = "Bottom";
  Edge2[Edge2["Start"] = 4] = "Start";
  Edge2[Edge2["End"] = 5] = "End";
  Edge2[Edge2["Horizontal"] = 6] = "Horizontal";
  Edge2[Edge2["Vertical"] = 7] = "Vertical";
  Edge2[Edge2["All"] = 8] = "All";
  return Edge2;
}({});
var Errata = /* @__PURE__ */ function(Errata2) {
  Errata2[Errata2["None"] = 0] = "None";
  Errata2[Errata2["StretchFlexBasis"] = 1] = "StretchFlexBasis";
  Errata2[Errata2["AbsolutePositionWithoutInsetsExcludesPadding"] = 2] = "AbsolutePositionWithoutInsetsExcludesPadding";
  Errata2[Errata2["AbsolutePercentAgainstInnerSize"] = 4] = "AbsolutePercentAgainstInnerSize";
  Errata2[Errata2["All"] = 2147483647] = "All";
  Errata2[Errata2["Classic"] = 2147483646] = "Classic";
  return Errata2;
}({});
var ExperimentalFeature = /* @__PURE__ */ function(ExperimentalFeature2) {
  ExperimentalFeature2[ExperimentalFeature2["WebFlexBasis"] = 0] = "WebFlexBasis";
  return ExperimentalFeature2;
}({});
var FlexDirection = /* @__PURE__ */ function(FlexDirection2) {
  FlexDirection2[FlexDirection2["Column"] = 0] = "Column";
  FlexDirection2[FlexDirection2["ColumnReverse"] = 1] = "ColumnReverse";
  FlexDirection2[FlexDirection2["Row"] = 2] = "Row";
  FlexDirection2[FlexDirection2["RowReverse"] = 3] = "RowReverse";
  return FlexDirection2;
}({});
var Gutter = /* @__PURE__ */ function(Gutter2) {
  Gutter2[Gutter2["Column"] = 0] = "Column";
  Gutter2[Gutter2["Row"] = 1] = "Row";
  Gutter2[Gutter2["All"] = 2] = "All";
  return Gutter2;
}({});
var Justify = /* @__PURE__ */ function(Justify2) {
  Justify2[Justify2["FlexStart"] = 0] = "FlexStart";
  Justify2[Justify2["Center"] = 1] = "Center";
  Justify2[Justify2["FlexEnd"] = 2] = "FlexEnd";
  Justify2[Justify2["SpaceBetween"] = 3] = "SpaceBetween";
  Justify2[Justify2["SpaceAround"] = 4] = "SpaceAround";
  Justify2[Justify2["SpaceEvenly"] = 5] = "SpaceEvenly";
  return Justify2;
}({});
var LogLevel = /* @__PURE__ */ function(LogLevel2) {
  LogLevel2[LogLevel2["Error"] = 0] = "Error";
  LogLevel2[LogLevel2["Warn"] = 1] = "Warn";
  LogLevel2[LogLevel2["Info"] = 2] = "Info";
  LogLevel2[LogLevel2["Debug"] = 3] = "Debug";
  LogLevel2[LogLevel2["Verbose"] = 4] = "Verbose";
  LogLevel2[LogLevel2["Fatal"] = 5] = "Fatal";
  return LogLevel2;
}({});
var MeasureMode = /* @__PURE__ */ function(MeasureMode2) {
  MeasureMode2[MeasureMode2["Undefined"] = 0] = "Undefined";
  MeasureMode2[MeasureMode2["Exactly"] = 1] = "Exactly";
  MeasureMode2[MeasureMode2["AtMost"] = 2] = "AtMost";
  return MeasureMode2;
}({});
var NodeType = /* @__PURE__ */ function(NodeType2) {
  NodeType2[NodeType2["Default"] = 0] = "Default";
  NodeType2[NodeType2["Text"] = 1] = "Text";
  return NodeType2;
}({});
var Overflow = /* @__PURE__ */ function(Overflow2) {
  Overflow2[Overflow2["Visible"] = 0] = "Visible";
  Overflow2[Overflow2["Hidden"] = 1] = "Hidden";
  Overflow2[Overflow2["Scroll"] = 2] = "Scroll";
  return Overflow2;
}({});
var PositionType = /* @__PURE__ */ function(PositionType2) {
  PositionType2[PositionType2["Static"] = 0] = "Static";
  PositionType2[PositionType2["Relative"] = 1] = "Relative";
  PositionType2[PositionType2["Absolute"] = 2] = "Absolute";
  return PositionType2;
}({});
var Unit = /* @__PURE__ */ function(Unit2) {
  Unit2[Unit2["Undefined"] = 0] = "Undefined";
  Unit2[Unit2["Point"] = 1] = "Point";
  Unit2[Unit2["Percent"] = 2] = "Percent";
  Unit2[Unit2["Auto"] = 3] = "Auto";
  return Unit2;
}({});
var Wrap = /* @__PURE__ */ function(Wrap2) {
  Wrap2[Wrap2["NoWrap"] = 0] = "NoWrap";
  Wrap2[Wrap2["Wrap"] = 1] = "Wrap";
  Wrap2[Wrap2["WrapReverse"] = 2] = "WrapReverse";
  return Wrap2;
}({});
var constants = {
  ALIGN_AUTO: Align.Auto,
  ALIGN_FLEX_START: Align.FlexStart,
  ALIGN_CENTER: Align.Center,
  ALIGN_FLEX_END: Align.FlexEnd,
  ALIGN_STRETCH: Align.Stretch,
  ALIGN_BASELINE: Align.Baseline,
  ALIGN_SPACE_BETWEEN: Align.SpaceBetween,
  ALIGN_SPACE_AROUND: Align.SpaceAround,
  ALIGN_SPACE_EVENLY: Align.SpaceEvenly,
  BOX_SIZING_BORDER_BOX: BoxSizing.BorderBox,
  BOX_SIZING_CONTENT_BOX: BoxSizing.ContentBox,
  DIMENSION_WIDTH: Dimension.Width,
  DIMENSION_HEIGHT: Dimension.Height,
  DIRECTION_INHERIT: Direction.Inherit,
  DIRECTION_LTR: Direction.LTR,
  DIRECTION_RTL: Direction.RTL,
  DISPLAY_FLEX: Display.Flex,
  DISPLAY_NONE: Display.None,
  DISPLAY_CONTENTS: Display.Contents,
  EDGE_LEFT: Edge.Left,
  EDGE_TOP: Edge.Top,
  EDGE_RIGHT: Edge.Right,
  EDGE_BOTTOM: Edge.Bottom,
  EDGE_START: Edge.Start,
  EDGE_END: Edge.End,
  EDGE_HORIZONTAL: Edge.Horizontal,
  EDGE_VERTICAL: Edge.Vertical,
  EDGE_ALL: Edge.All,
  ERRATA_NONE: Errata.None,
  ERRATA_STRETCH_FLEX_BASIS: Errata.StretchFlexBasis,
  ERRATA_ABSOLUTE_POSITION_WITHOUT_INSETS_EXCLUDES_PADDING: Errata.AbsolutePositionWithoutInsetsExcludesPadding,
  ERRATA_ABSOLUTE_PERCENT_AGAINST_INNER_SIZE: Errata.AbsolutePercentAgainstInnerSize,
  ERRATA_ALL: Errata.All,
  ERRATA_CLASSIC: Errata.Classic,
  EXPERIMENTAL_FEATURE_WEB_FLEX_BASIS: ExperimentalFeature.WebFlexBasis,
  FLEX_DIRECTION_COLUMN: FlexDirection.Column,
  FLEX_DIRECTION_COLUMN_REVERSE: FlexDirection.ColumnReverse,
  FLEX_DIRECTION_ROW: FlexDirection.Row,
  FLEX_DIRECTION_ROW_REVERSE: FlexDirection.RowReverse,
  GUTTER_COLUMN: Gutter.Column,
  GUTTER_ROW: Gutter.Row,
  GUTTER_ALL: Gutter.All,
  JUSTIFY_FLEX_START: Justify.FlexStart,
  JUSTIFY_CENTER: Justify.Center,
  JUSTIFY_FLEX_END: Justify.FlexEnd,
  JUSTIFY_SPACE_BETWEEN: Justify.SpaceBetween,
  JUSTIFY_SPACE_AROUND: Justify.SpaceAround,
  JUSTIFY_SPACE_EVENLY: Justify.SpaceEvenly,
  LOG_LEVEL_ERROR: LogLevel.Error,
  LOG_LEVEL_WARN: LogLevel.Warn,
  LOG_LEVEL_INFO: LogLevel.Info,
  LOG_LEVEL_DEBUG: LogLevel.Debug,
  LOG_LEVEL_VERBOSE: LogLevel.Verbose,
  LOG_LEVEL_FATAL: LogLevel.Fatal,
  MEASURE_MODE_UNDEFINED: MeasureMode.Undefined,
  MEASURE_MODE_EXACTLY: MeasureMode.Exactly,
  MEASURE_MODE_AT_MOST: MeasureMode.AtMost,
  NODE_TYPE_DEFAULT: NodeType.Default,
  NODE_TYPE_TEXT: NodeType.Text,
  OVERFLOW_VISIBLE: Overflow.Visible,
  OVERFLOW_HIDDEN: Overflow.Hidden,
  OVERFLOW_SCROLL: Overflow.Scroll,
  POSITION_TYPE_STATIC: PositionType.Static,
  POSITION_TYPE_RELATIVE: PositionType.Relative,
  POSITION_TYPE_ABSOLUTE: PositionType.Absolute,
  UNIT_UNDEFINED: Unit.Undefined,
  UNIT_POINT: Unit.Point,
  UNIT_PERCENT: Unit.Percent,
  UNIT_AUTO: Unit.Auto,
  WRAP_NO_WRAP: Wrap.NoWrap,
  WRAP_WRAP: Wrap.Wrap,
  WRAP_WRAP_REVERSE: Wrap.WrapReverse
};
var YGEnums_default = constants;

// node_modules/yoga-layout/dist/src/wrapAssembly.js
function wrapAssembly(lib) {
  function patch(prototype, name, fn) {
    const original = prototype[name];
    prototype[name] = function() {
      for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
        args[_key] = arguments[_key];
      }
      return fn.call(this, original, ...args);
    };
  }
  __name(patch, "patch");
  for (const fnName of ["setPosition", "setMargin", "setFlexBasis", "setWidth", "setHeight", "setMinWidth", "setMinHeight", "setMaxWidth", "setMaxHeight", "setPadding", "setGap"]) {
    const methods = {
      [Unit.Point]: lib.Node.prototype[fnName],
      [Unit.Percent]: lib.Node.prototype[`${fnName}Percent`],
      [Unit.Auto]: lib.Node.prototype[`${fnName}Auto`]
    };
    patch(lib.Node.prototype, fnName, function(original) {
      for (var _len2 = arguments.length, args = new Array(_len2 > 1 ? _len2 - 1 : 0), _key2 = 1; _key2 < _len2; _key2++) {
        args[_key2 - 1] = arguments[_key2];
      }
      const value = args.pop();
      let unit, asNumber;
      if (value === "auto") {
        unit = Unit.Auto;
        asNumber = void 0;
      } else if (typeof value === "object") {
        unit = value.unit;
        asNumber = value.valueOf();
      } else {
        unit = typeof value === "string" && value.endsWith("%") ? Unit.Percent : Unit.Point;
        asNumber = parseFloat(value);
        if (value !== void 0 && !Number.isNaN(value) && Number.isNaN(asNumber)) {
          throw new Error(`Invalid value ${value} for ${fnName}`);
        }
      }
      if (!methods[unit]) throw new Error(`Failed to execute "${fnName}": Unsupported unit '${value}'`);
      if (asNumber !== void 0) {
        return methods[unit].call(this, ...args, asNumber);
      } else {
        return methods[unit].call(this, ...args);
      }
    });
  }
  function wrapMeasureFunction(measureFunction) {
    return lib.MeasureCallback.implement({
      measure: /* @__PURE__ */ __name(function() {
        const {
          width,
          height
        } = measureFunction(...arguments);
        return {
          width: width ?? NaN,
          height: height ?? NaN
        };
      }, "measure")
    });
  }
  __name(wrapMeasureFunction, "wrapMeasureFunction");
  patch(lib.Node.prototype, "setMeasureFunc", function(original, measureFunc) {
    if (measureFunc) {
      return original.call(this, wrapMeasureFunction(measureFunc));
    } else {
      return this.unsetMeasureFunc();
    }
  });
  function wrapDirtiedFunc(dirtiedFunction) {
    return lib.DirtiedCallback.implement({
      dirtied: dirtiedFunction
    });
  }
  __name(wrapDirtiedFunc, "wrapDirtiedFunc");
  patch(lib.Node.prototype, "setDirtiedFunc", function(original, dirtiedFunc) {
    original.call(this, wrapDirtiedFunc(dirtiedFunc));
  });
  patch(lib.Config.prototype, "free", function() {
    lib.Config.destroy(this);
  });
  patch(lib.Node, "create", (_, config) => {
    return config ? lib.Node.createWithConfig(config) : lib.Node.createDefault();
  });
  patch(lib.Node.prototype, "free", function() {
    lib.Node.destroy(this);
  });
  patch(lib.Node.prototype, "freeRecursive", function() {
    for (let t = 0, T = this.getChildCount(); t < T; ++t) {
      this.getChild(0).freeRecursive();
    }
    this.free();
  });
  patch(lib.Node.prototype, "calculateLayout", function(original) {
    let width = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : NaN;
    let height = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : NaN;
    let direction = arguments.length > 3 && arguments[3] !== void 0 ? arguments[3] : Direction.LTR;
    return original.call(this, width, height, direction);
  });
  return {
    Config: lib.Config,
    Node: lib.Node,
    ...YGEnums_default
  };
}
__name(wrapAssembly, "wrapAssembly");

// node_modules/yoga-layout/dist/src/index.js
var Yoga = wrapAssembly(await yoga_wasm_base64_esm_default());
var src_default = Yoga;

// node_modules/ink/node_modules/wrap-ansi/index.js
init_esbuild_shims();

// node_modules/ink/node_modules/string-width/index.js
init_esbuild_shims();
var segmenter = new Intl.Segmenter();
var zeroWidthClusterRegex = new RegExp("^(?:\\p{Default_Ignorable_Code_Point}|\\p{Control}|\\p{Format}|\\p{Mark}|\\p{Surrogate})+$", "v");
var leadingNonPrintingRegex = new RegExp("^[\\p{Default_Ignorable_Code_Point}\\p{Control}\\p{Format}\\p{Mark}\\p{Surrogate}]+", "v");
var rgiEmojiRegex = new RegExp("^\\p{RGI_Emoji}$", "v");
var unqualifiedKeycapRegex = /^[\d#*]\u20E3$/;
var extendedPictographicRegex = new RegExp("\\p{Extended_Pictographic}", "gu");
function isDoubleWidthNonRgiEmojiSequence(segment) {
  if (segment.length > 50) {
    return false;
  }
  if (unqualifiedKeycapRegex.test(segment)) {
    return true;
  }
  if (segment.includes("\u200D")) {
    const pictographics = segment.match(extendedPictographicRegex);
    return pictographics !== null && pictographics.length >= 2;
  }
  return false;
}
__name(isDoubleWidthNonRgiEmojiSequence, "isDoubleWidthNonRgiEmojiSequence");
function baseVisible(segment) {
  return segment.replace(leadingNonPrintingRegex, "");
}
__name(baseVisible, "baseVisible");
function isZeroWidthCluster(segment) {
  return zeroWidthClusterRegex.test(segment);
}
__name(isZeroWidthCluster, "isZeroWidthCluster");
function isHangulLeadingJamo(codePoint) {
  return codePoint >= 4352 && codePoint <= 4447 || codePoint >= 43360 && codePoint <= 43388;
}
__name(isHangulLeadingJamo, "isHangulLeadingJamo");
function isHangulVowelJamo(codePoint) {
  return codePoint >= 4448 && codePoint <= 4519 || codePoint >= 55216 && codePoint <= 55238;
}
__name(isHangulVowelJamo, "isHangulVowelJamo");
function isHangulTrailingJamo(codePoint) {
  return codePoint >= 4520 && codePoint <= 4607 || codePoint >= 55243 && codePoint <= 55291;
}
__name(isHangulTrailingJamo, "isHangulTrailingJamo");
function isHangulJamo(codePoint) {
  return isHangulLeadingJamo(codePoint) || isHangulVowelJamo(codePoint) || isHangulTrailingJamo(codePoint);
}
__name(isHangulJamo, "isHangulJamo");
function hangulClusterWidth(visibleSegment, eastAsianWidthOptions) {
  const codePoints = [];
  for (const character of visibleSegment) {
    if (zeroWidthClusterRegex.test(character)) {
      continue;
    }
    codePoints.push(character.codePointAt(0));
  }
  if (codePoints.length === 0) {
    return void 0;
  }
  let width = 0;
  for (let index = 0; index < codePoints.length; index++) {
    const codePoint = codePoints[index];
    if (!isHangulJamo(codePoint)) {
      if (width === 0) {
        return void 0;
      }
      for (let remaining = index; remaining < codePoints.length; remaining++) {
        width += eastAsianWidth(codePoints[remaining], eastAsianWidthOptions);
      }
      return width;
    }
    if (isHangulLeadingJamo(codePoint) && isHangulVowelJamo(codePoints[index + 1])) {
      width += 2;
      index += isHangulTrailingJamo(codePoints[index + 2]) ? 2 : 1;
      continue;
    }
    width += eastAsianWidth(codePoint, eastAsianWidthOptions);
  }
  return width;
}
__name(hangulClusterWidth, "hangulClusterWidth");
function trailingHalfwidthWidth(visibleSegment, eastAsianWidthOptions) {
  let extra = 0;
  let first = true;
  for (const character of visibleSegment) {
    if (first) {
      first = false;
      continue;
    }
    if (character >= "\uFF00" && character <= "\uFFEF") {
      extra += eastAsianWidth(character.codePointAt(0), eastAsianWidthOptions);
    }
  }
  return extra;
}
__name(trailingHalfwidthWidth, "trailingHalfwidthWidth");
function stringWidth(input, options = {}) {
  if (typeof input !== "string" || input.length === 0) {
    return 0;
  }
  const {
    ambiguousIsNarrow = true,
    countAnsiEscapeCodes = false
  } = options;
  let string = input;
  if (!countAnsiEscapeCodes && (string.includes("\x1B") || string.includes("\x9B"))) {
    string = stripAnsi(string);
  }
  if (string.length === 0) {
    return 0;
  }
  if (/^[\u0020-\u007E]*$/.test(string)) {
    return string.length;
  }
  let width = 0;
  const eastAsianWidthOptions = { ambiguousAsWide: !ambiguousIsNarrow };
  for (const { segment } of segmenter.segment(string)) {
    if (isZeroWidthCluster(segment)) {
      continue;
    }
    if (rgiEmojiRegex.test(segment) || isDoubleWidthNonRgiEmojiSequence(segment)) {
      width += 2;
      continue;
    }
    const visibleSegment = baseVisible(segment);
    const hangulWidth = hangulClusterWidth(visibleSegment, eastAsianWidthOptions);
    if (hangulWidth !== void 0) {
      width += hangulWidth;
      continue;
    }
    const codePoint = visibleSegment.codePointAt(0);
    width += eastAsianWidth(codePoint, eastAsianWidthOptions);
    width += trailingHalfwidthWidth(visibleSegment, eastAsianWidthOptions);
  }
  return width;
}
__name(stringWidth, "stringWidth");

// node_modules/ink/node_modules/ansi-styles/index.js
init_esbuild_shims();
var ANSI_BACKGROUND_OFFSET = 10;
var wrapAnsi16 = /* @__PURE__ */ __name((offset = 0) => (code) => `\x1B[${code + offset}m`, "wrapAnsi16");
var wrapAnsi256 = /* @__PURE__ */ __name((offset = 0) => (code) => `\x1B[${38 + offset};5;${code}m`, "wrapAnsi256");
var wrapAnsi16m = /* @__PURE__ */ __name((offset = 0) => (red, green, blue) => `\x1B[${38 + offset};2;${red};${green};${blue}m`, "wrapAnsi16m");
var styles = {
  modifier: {
    reset: [0, 0],
    // 21 isn't widely supported and 22 does the same thing
    bold: [1, 22],
    dim: [2, 22],
    italic: [3, 23],
    underline: [4, 24],
    overline: [53, 55],
    inverse: [7, 27],
    hidden: [8, 28],
    strikethrough: [9, 29]
  },
  color: {
    black: [30, 39],
    red: [31, 39],
    green: [32, 39],
    yellow: [33, 39],
    blue: [34, 39],
    magenta: [35, 39],
    cyan: [36, 39],
    white: [37, 39],
    // Bright color
    blackBright: [90, 39],
    gray: [90, 39],
    // Alias of `blackBright`
    grey: [90, 39],
    // Alias of `blackBright`
    redBright: [91, 39],
    greenBright: [92, 39],
    yellowBright: [93, 39],
    blueBright: [94, 39],
    magentaBright: [95, 39],
    cyanBright: [96, 39],
    whiteBright: [97, 39]
  },
  bgColor: {
    bgBlack: [40, 49],
    bgRed: [41, 49],
    bgGreen: [42, 49],
    bgYellow: [43, 49],
    bgBlue: [44, 49],
    bgMagenta: [45, 49],
    bgCyan: [46, 49],
    bgWhite: [47, 49],
    // Bright color
    bgBlackBright: [100, 49],
    bgGray: [100, 49],
    // Alias of `bgBlackBright`
    bgGrey: [100, 49],
    // Alias of `bgBlackBright`
    bgRedBright: [101, 49],
    bgGreenBright: [102, 49],
    bgYellowBright: [103, 49],
    bgBlueBright: [104, 49],
    bgMagentaBright: [105, 49],
    bgCyanBright: [106, 49],
    bgWhiteBright: [107, 49]
  }
};
var modifierNames = Object.keys(styles.modifier);
var foregroundColorNames = Object.keys(styles.color);
var backgroundColorNames = Object.keys(styles.bgColor);
var colorNames = [...foregroundColorNames, ...backgroundColorNames];
function assembleStyles() {
  const codes = /* @__PURE__ */ new Map();
  for (const [groupName, group] of Object.entries(styles)) {
    for (const [styleName, style] of Object.entries(group)) {
      styles[styleName] = {
        open: `\x1B[${style[0]}m`,
        close: `\x1B[${style[1]}m`
      };
      group[styleName] = styles[styleName];
      codes.set(style[0], style[1]);
    }
    Object.defineProperty(styles, groupName, {
      value: group,
      enumerable: false
    });
  }
  Object.defineProperty(styles, "codes", {
    value: codes,
    enumerable: false
  });
  styles.color.close = "\x1B[39m";
  styles.bgColor.close = "\x1B[49m";
  styles.color.ansi = wrapAnsi16();
  styles.color.ansi256 = wrapAnsi256();
  styles.color.ansi16m = wrapAnsi16m();
  styles.bgColor.ansi = wrapAnsi16(ANSI_BACKGROUND_OFFSET);
  styles.bgColor.ansi256 = wrapAnsi256(ANSI_BACKGROUND_OFFSET);
  styles.bgColor.ansi16m = wrapAnsi16m(ANSI_BACKGROUND_OFFSET);
  Object.defineProperties(styles, {
    rgbToAnsi256: {
      value(red, green, blue) {
        if (red === green && green === blue) {
          if (red < 8) {
            return 16;
          }
          if (red > 248) {
            return 231;
          }
          return Math.round((red - 8) / 247 * 24) + 232;
        }
        return 16 + 36 * Math.round(red / 255 * 5) + 6 * Math.round(green / 255 * 5) + Math.round(blue / 255 * 5);
      },
      enumerable: false
    },
    hexToRgb: {
      value(hex) {
        const matches = /[a-f\d]{6}|[a-f\d]{3}/i.exec(hex.toString(16));
        if (!matches) {
          return [0, 0, 0];
        }
        let [colorString] = matches;
        if (colorString.length === 3) {
          colorString = [...colorString].map((character) => character + character).join("");
        }
        const integer = Number.parseInt(colorString, 16);
        return [
          /* eslint-disable no-bitwise */
          integer >> 16 & 255,
          integer >> 8 & 255,
          integer & 255
          /* eslint-enable no-bitwise */
        ];
      },
      enumerable: false
    },
    hexToAnsi256: {
      value: /* @__PURE__ */ __name((hex) => styles.rgbToAnsi256(...styles.hexToRgb(hex)), "value"),
      enumerable: false
    },
    ansi256ToAnsi: {
      value(code) {
        if (code < 8) {
          return 30 + code;
        }
        if (code < 16) {
          return 90 + (code - 8);
        }
        let red;
        let green;
        let blue;
        if (code >= 232) {
          red = ((code - 232) * 10 + 8) / 255;
          green = red;
          blue = red;
        } else {
          code -= 16;
          const remainder = code % 36;
          red = Math.floor(code / 36) / 5;
          green = Math.floor(remainder / 6) / 5;
          blue = remainder % 6 / 5;
        }
        const value = Math.max(red, green, blue) * 2;
        if (value === 0) {
          return 30;
        }
        let result = 30 + (Math.round(blue) << 2 | Math.round(green) << 1 | Math.round(red));
        if (value === 2) {
          result += 60;
        }
        return result;
      },
      enumerable: false
    },
    rgbToAnsi: {
      value: /* @__PURE__ */ __name((red, green, blue) => styles.ansi256ToAnsi(styles.rgbToAnsi256(red, green, blue)), "value"),
      enumerable: false
    },
    hexToAnsi: {
      value: /* @__PURE__ */ __name((hex) => styles.ansi256ToAnsi(styles.hexToAnsi256(hex)), "value"),
      enumerable: false
    }
  });
  return styles;
}
__name(assembleStyles, "assembleStyles");
var ansiStyles = assembleStyles();
var ansi_styles_default = ansiStyles;

// node_modules/ink/node_modules/wrap-ansi/index.js
var ANSI_ESCAPE = "\x1B";
var ANSI_ESCAPE_CSI = "\x9B";
var ESCAPES = /* @__PURE__ */ new Set([
  ANSI_ESCAPE,
  ANSI_ESCAPE_CSI
]);
var ANSI_ESCAPE_BELL = "\x07";
var ANSI_CSI = "[";
var ANSI_OSC = "]";
var ANSI_SGR_TERMINATOR = "m";
var ANSI_SGR_RESET = 0;
var ANSI_SGR_RESET_FOREGROUND = 39;
var ANSI_SGR_RESET_BACKGROUND = 49;
var ANSI_SGR_RESET_UNDERLINE_COLOR = 59;
var ANSI_SGR_FOREGROUND_EXTENDED = 38;
var ANSI_SGR_BACKGROUND_EXTENDED = 48;
var ANSI_SGR_UNDERLINE_COLOR_EXTENDED = 58;
var ANSI_SGR_COLOR_MODE_256 = 5;
var ANSI_SGR_COLOR_MODE_RGB = 2;
var ANSI_ESCAPE_LINK = `${ANSI_OSC}8;;`;
var ANSI_ESCAPE_REGEX = new RegExp(`^\\u001B(?:\\${ANSI_CSI}(?<sgr>[0-9;]*)${ANSI_SGR_TERMINATOR}|${ANSI_ESCAPE_LINK}(?<uri>[^\\u0007\\u001B]*)(?:\\u0007|\\u001B\\\\))`);
var ANSI_ESCAPE_CSI_REGEX = new RegExp(`^\\u009B(?<sgr>[0-9;]*)${ANSI_SGR_TERMINATOR}`);
var ANSI_SGR_MODIFIER_CLOSE_CODES = new Set(ansi_styles_default.codes.values());
ANSI_SGR_MODIFIER_CLOSE_CODES.delete(ANSI_SGR_RESET);
var segmenter2 = new Intl.Segmenter();
var getGraphemes = /* @__PURE__ */ __name((string) => Array.from(segmenter2.segment(string), ({ segment }) => segment), "getGraphemes");
var TAB_SIZE = 8;
var wrapAnsiCode = /* @__PURE__ */ __name((code) => `${ANSI_ESCAPE}${ANSI_CSI}${code}${ANSI_SGR_TERMINATOR}`, "wrapAnsiCode");
var wrapAnsiHyperlink = /* @__PURE__ */ __name((url) => `${ANSI_ESCAPE}${ANSI_ESCAPE_LINK}${url}${ANSI_ESCAPE_BELL}`, "wrapAnsiHyperlink");
var getSgrTokens = /* @__PURE__ */ __name((sgrParameters) => {
  const codes = sgrParameters.split(";").map((sgrParameter) => sgrParameter === "" ? ANSI_SGR_RESET : Number.parseInt(sgrParameter, 10));
  const sgrTokens = [];
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    if (!Number.isFinite(code)) {
      continue;
    }
    if (code === ANSI_SGR_FOREGROUND_EXTENDED || code === ANSI_SGR_BACKGROUND_EXTENDED || code === ANSI_SGR_UNDERLINE_COLOR_EXTENDED) {
      if (index + 1 >= codes.length) {
        break;
      }
      const mode = codes[index + 1];
      if (mode === ANSI_SGR_COLOR_MODE_256 && Number.isFinite(codes[index + 2])) {
        sgrTokens.push([code, mode, codes[index + 2]]);
        index += 2;
        continue;
      }
      const red = codes[index + 2];
      const green = codes[index + 3];
      const blue = codes[index + 4];
      if (mode === ANSI_SGR_COLOR_MODE_RGB && Number.isFinite(red) && Number.isFinite(green) && Number.isFinite(blue)) {
        sgrTokens.push([code, mode, red, green, blue]);
        index += 4;
        continue;
      }
      break;
    }
    sgrTokens.push([code]);
  }
  return sgrTokens;
}, "getSgrTokens");
var removeActiveStyle = /* @__PURE__ */ __name((activeStyles, family) => {
  const activeStyleIndex = activeStyles.findIndex((activeStyle) => activeStyle.family === family);
  if (activeStyleIndex !== -1) {
    activeStyles.splice(activeStyleIndex, 1);
  }
}, "removeActiveStyle");
var upsertActiveStyle = /* @__PURE__ */ __name((activeStyles, nextActiveStyle) => {
  removeActiveStyle(activeStyles, nextActiveStyle.family);
  activeStyles.push(nextActiveStyle);
}, "upsertActiveStyle");
var removeModifierStylesByClose = /* @__PURE__ */ __name((activeStyles, closeCode) => {
  for (let index = activeStyles.length - 1; index >= 0; index--) {
    const activeStyle = activeStyles[index];
    if (activeStyle.family.startsWith("modifier-") && activeStyle.close === closeCode) {
      activeStyles.splice(index, 1);
    }
  }
}, "removeModifierStylesByClose");
var getColorStyle = /* @__PURE__ */ __name((code, sgrToken) => {
  if (code >= 30 && code <= 37 || code >= 90 && code <= 97 || code === ANSI_SGR_FOREGROUND_EXTENDED && sgrToken.length > 1) {
    return {
      family: "foreground",
      open: sgrToken.join(";"),
      close: ANSI_SGR_RESET_FOREGROUND
    };
  }
  if (code >= 40 && code <= 47 || code >= 100 && code <= 107 || code === ANSI_SGR_BACKGROUND_EXTENDED && sgrToken.length > 1) {
    return {
      family: "background",
      open: sgrToken.join(";"),
      close: ANSI_SGR_RESET_BACKGROUND
    };
  }
  if (code === ANSI_SGR_UNDERLINE_COLOR_EXTENDED && sgrToken.length > 1) {
    return {
      family: "underlineColor",
      open: sgrToken.join(";"),
      close: ANSI_SGR_RESET_UNDERLINE_COLOR
    };
  }
}, "getColorStyle");
var applySgrResetCode = /* @__PURE__ */ __name((code, activeStyles) => {
  if (code === ANSI_SGR_RESET) {
    activeStyles.length = 0;
    return true;
  }
  if (code === ANSI_SGR_RESET_FOREGROUND) {
    removeActiveStyle(activeStyles, "foreground");
    return true;
  }
  if (code === ANSI_SGR_RESET_BACKGROUND) {
    removeActiveStyle(activeStyles, "background");
    return true;
  }
  if (code === ANSI_SGR_RESET_UNDERLINE_COLOR) {
    removeActiveStyle(activeStyles, "underlineColor");
    return true;
  }
  if (ANSI_SGR_MODIFIER_CLOSE_CODES.has(code)) {
    removeModifierStylesByClose(activeStyles, code);
    return true;
  }
  return false;
}, "applySgrResetCode");
var applySgrToken = /* @__PURE__ */ __name((sgrToken, activeStyles) => {
  const [code] = sgrToken;
  if (applySgrResetCode(code, activeStyles)) {
    return;
  }
  const colorStyle = getColorStyle(code, sgrToken);
  if (colorStyle) {
    upsertActiveStyle(activeStyles, colorStyle);
    return;
  }
  const close = ansi_styles_default.codes.get(code);
  if (close !== void 0 && close !== ANSI_SGR_RESET) {
    upsertActiveStyle(activeStyles, {
      family: `modifier-${code}`,
      open: sgrToken.join(";"),
      close
    });
  }
}, "applySgrToken");
var applySgrParameters = /* @__PURE__ */ __name((sgrParameters, activeStyles) => {
  for (const sgrToken of getSgrTokens(sgrParameters)) {
    applySgrToken(sgrToken, activeStyles);
  }
}, "applySgrParameters");
var applySgrResets = /* @__PURE__ */ __name((sgrParameters, activeStyles) => {
  for (const sgrToken of getSgrTokens(sgrParameters)) {
    const [code] = sgrToken;
    applySgrResetCode(code, activeStyles);
  }
}, "applySgrResets");
var applyLeadingSgrResets = /* @__PURE__ */ __name((string, activeStyles) => {
  let remainder = string;
  while (remainder.length > 0) {
    if (remainder.startsWith(ANSI_ESCAPE) && remainder[1] !== "\\") {
      const match = ANSI_ESCAPE_REGEX.exec(remainder);
      if (!match) {
        break;
      }
      if (match.groups.sgr !== void 0) {
        applySgrResets(match.groups.sgr, activeStyles);
      }
      remainder = remainder.slice(match[0].length);
      continue;
    }
    if (remainder.startsWith(ANSI_ESCAPE_CSI)) {
      const match = ANSI_ESCAPE_CSI_REGEX.exec(remainder);
      if (!match || match.groups.sgr === void 0) {
        break;
      }
      applySgrResets(match.groups.sgr, activeStyles);
      remainder = remainder.slice(match[0].length);
      continue;
    }
    break;
  }
}, "applyLeadingSgrResets");
var getClosingSgrSequence = /* @__PURE__ */ __name((activeStyles) => [...activeStyles].reverse().map((activeStyle) => wrapAnsiCode(activeStyle.close)).join(""), "getClosingSgrSequence");
var getOpeningSgrSequence = /* @__PURE__ */ __name((activeStyles) => activeStyles.map((activeStyle) => wrapAnsiCode(activeStyle.open)).join(""), "getOpeningSgrSequence");
var wordLengths = /* @__PURE__ */ __name((string) => string.split(" ").map((word) => stringWidth(word)), "wordLengths");
var wrapWord = /* @__PURE__ */ __name((rows, word, columns) => {
  const characters = getGraphemes(word);
  let isInsideEscape = false;
  let isInsideLinkEscape = false;
  let visible = stringWidth(stripAnsi(rows.at(-1)));
  for (const [index, character] of characters.entries()) {
    const characterLength = stringWidth(character);
    if (visible + characterLength <= columns) {
      rows[rows.length - 1] += character;
    } else {
      rows.push(character);
      visible = 0;
    }
    if (ESCAPES.has(character) && !(isInsideLinkEscape && character === ANSI_ESCAPE && characters[index + 1] === "\\")) {
      isInsideEscape = true;
      const ansiEscapeLinkCandidate = characters.slice(index + 1, index + 1 + ANSI_ESCAPE_LINK.length).join("");
      isInsideLinkEscape = ansiEscapeLinkCandidate === ANSI_ESCAPE_LINK;
    }
    if (isInsideEscape) {
      if (isInsideLinkEscape) {
        if (character === ANSI_ESCAPE_BELL || character === "\\" && index > 0 && characters[index - 1] === ANSI_ESCAPE) {
          isInsideEscape = false;
          isInsideLinkEscape = false;
        }
      } else if (character === ANSI_SGR_TERMINATOR) {
        isInsideEscape = false;
      }
      continue;
    }
    visible += characterLength;
    if (visible === columns && index < characters.length - 1) {
      rows.push("");
      visible = 0;
    }
  }
  if (!visible && rows.at(-1).length > 0 && rows.length > 1) {
    rows[rows.length - 2] += rows.pop();
  }
}, "wrapWord");
var stringVisibleTrimSpacesRight = /* @__PURE__ */ __name((string) => {
  const words = string.split(" ");
  let last = words.length;
  while (last > 0) {
    if (stringWidth(words[last - 1]) > 0) {
      break;
    }
    last--;
  }
  if (last === words.length) {
    return string;
  }
  return words.slice(0, last).join(" ") + words.slice(last).join("");
}, "stringVisibleTrimSpacesRight");
var expandTabs = /* @__PURE__ */ __name((line) => {
  if (!line.includes("	")) {
    return line;
  }
  const segments = line.split("	");
  let visible = 0;
  let expandedLine = "";
  for (const [index, segment] of segments.entries()) {
    expandedLine += segment;
    visible += stringWidth(segment);
    if (index < segments.length - 1) {
      const spaces = TAB_SIZE - visible % TAB_SIZE;
      expandedLine += " ".repeat(spaces);
      visible += spaces;
    }
  }
  return expandedLine;
}, "expandTabs");
var exec = /* @__PURE__ */ __name((string, columns, options = {}) => {
  if (options.trim !== false && string.trim() === "") {
    return "";
  }
  let returnValue = "";
  let escapeUrl;
  const activeStyles = [];
  const lengths = wordLengths(string);
  let rows = [""];
  for (const [index, word] of string.split(" ").entries()) {
    if (options.trim !== false) {
      rows[rows.length - 1] = rows.at(-1).trimStart();
    }
    let rowLength = stringWidth(rows.at(-1));
    if (index !== 0) {
      if (rowLength >= columns && (options.wordWrap === false || options.trim === false)) {
        rows.push("");
        rowLength = 0;
      }
      if (rowLength > 0 || options.trim === false) {
        rows[rows.length - 1] += " ";
        rowLength++;
      }
    }
    if (options.hard && options.wordWrap !== false && lengths[index] > columns) {
      const remainingColumns = columns - rowLength;
      const breaksStartingThisLine = 1 + Math.floor((lengths[index] - remainingColumns - 1) / columns);
      const breaksStartingNextLine = Math.floor((lengths[index] - 1) / columns);
      if (breaksStartingNextLine < breaksStartingThisLine) {
        rows.push("");
      }
      wrapWord(rows, word, columns);
      continue;
    }
    if (rowLength + lengths[index] > columns && rowLength > 0 && lengths[index] > 0) {
      if (options.wordWrap === false && rowLength < columns) {
        wrapWord(rows, word, columns);
        continue;
      }
      rows.push("");
    }
    if (rowLength + lengths[index] > columns && options.wordWrap === false) {
      wrapWord(rows, word, columns);
      continue;
    }
    rows[rows.length - 1] += word;
  }
  if (options.trim !== false) {
    rows = rows.map((row) => stringVisibleTrimSpacesRight(row));
  }
  const preString = rows.join("\n");
  const pre = getGraphemes(preString);
  let preStringIndex = 0;
  for (const [index, character] of pre.entries()) {
    returnValue += character;
    if (character === ANSI_ESCAPE && pre[index + 1] !== "\\") {
      const { groups } = ANSI_ESCAPE_REGEX.exec(preString.slice(preStringIndex)) || { groups: {} };
      if (groups.sgr !== void 0) {
        applySgrParameters(groups.sgr, activeStyles);
      } else if (groups.uri !== void 0) {
        escapeUrl = groups.uri.length === 0 ? void 0 : groups.uri;
      }
    } else if (character === ANSI_ESCAPE_CSI) {
      const { groups } = ANSI_ESCAPE_CSI_REGEX.exec(preString.slice(preStringIndex)) || { groups: {} };
      if (groups.sgr !== void 0) {
        applySgrParameters(groups.sgr, activeStyles);
      }
    }
    if (pre[index + 1] === "\n") {
      if (escapeUrl) {
        returnValue += wrapAnsiHyperlink("");
      }
      returnValue += getClosingSgrSequence(activeStyles);
    } else if (character === "\n") {
      const openingStyles = [...activeStyles];
      applyLeadingSgrResets(preString.slice(preStringIndex + 1), openingStyles);
      returnValue += getOpeningSgrSequence(openingStyles);
      if (escapeUrl) {
        returnValue += wrapAnsiHyperlink(escapeUrl);
      }
    }
    preStringIndex += character.length;
  }
  return returnValue;
}, "exec");
function wrapAnsi(string, columns, options) {
  return String(string).normalize().replaceAll("\r\n", "\n").split("\n").map((line) => exec(expandTabs(line), columns, options)).join("\n");
}
__name(wrapAnsi, "wrapAnsi");

// node_modules/ink/build/utils.js
init_esbuild_shims();

// node_modules/terminal-size/index.js
init_esbuild_shims();
import process3 from "node:process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import tty from "node:tty";
var defaultColumns = 80;
var defaultRows = 24;
var exec2 = /* @__PURE__ */ __name((command, arguments_, { shell, env: env2 } = {}) => execFileSync(command, arguments_, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  timeout: 500,
  shell,
  env: env2
}).trim(), "exec");
var create = /* @__PURE__ */ __name((columns, rows) => ({
  columns: Number.parseInt(columns, 10),
  rows: Number.parseInt(rows, 10)
}), "create");
var createIfNotDefault = /* @__PURE__ */ __name((maybeColumns, maybeRows) => {
  const { columns, rows } = create(maybeColumns, maybeRows);
  if (Number.isNaN(columns) || Number.isNaN(rows)) {
    return;
  }
  if (columns === defaultColumns && rows === defaultRows) {
    return;
  }
  return { columns, rows };
}, "createIfNotDefault");
var isForegroundProcess = /* @__PURE__ */ __name(() => {
  if (process3.platform !== "linux") {
    return true;
  }
  try {
    const statContents = fs.readFileSync("/proc/self/stat", "utf8");
    const closingParenthesisIndex = statContents.lastIndexOf(") ");
    if (closingParenthesisIndex === -1) {
      return false;
    }
    const statFields = statContents.slice(closingParenthesisIndex + 2).trim().split(/\s+/);
    const processGroupId = Number.parseInt(statFields[2], 10);
    const foregroundProcessGroupId = Number.parseInt(statFields[5], 10);
    if (Number.isNaN(processGroupId) || Number.isNaN(foregroundProcessGroupId)) {
      return false;
    }
    if (foregroundProcessGroupId <= 0) {
      return false;
    }
    return processGroupId === foregroundProcessGroupId;
  } catch {
    return false;
  }
}, "isForegroundProcess");
function terminalSize() {
  const { env: env2, stdout, stderr } = process3;
  if (stdout?.columns && stdout?.rows) {
    return create(stdout.columns, stdout.rows);
  }
  if (stderr?.columns && stderr?.rows) {
    return create(stderr.columns, stderr.rows);
  }
  if (env2.COLUMNS && env2.LINES) {
    return create(env2.COLUMNS, env2.LINES);
  }
  const fallback = {
    columns: defaultColumns,
    rows: defaultRows
  };
  if (process3.platform === "win32") {
    return tput() ?? fallback;
  }
  if (process3.platform === "darwin") {
    return devTty() ?? tput() ?? fallback;
  }
  return devTty() ?? tput() ?? resize() ?? fallback;
}
__name(terminalSize, "terminalSize");
var devTty = /* @__PURE__ */ __name(() => {
  try {
    const flags = process3.platform === "darwin" ? fs.constants.O_EVTONLY | fs.constants.O_NONBLOCK : fs.constants.O_NONBLOCK;
    const { columns, rows } = tty.WriteStream(fs.openSync("/dev/tty", flags));
    return { columns, rows };
  } catch {
  }
}, "devTty");
var tput = /* @__PURE__ */ __name(() => {
  try {
    const columns = exec2("tput", ["cols"], { env: { TERM: "dumb", ...process3.env } });
    const rows = exec2("tput", ["lines"], { env: { TERM: "dumb", ...process3.env } });
    if (columns && rows) {
      return createIfNotDefault(columns, rows);
    }
  } catch {
  }
}, "tput");
var resize = /* @__PURE__ */ __name(() => {
  try {
    if (!isForegroundProcess()) {
      return;
    }
    const size = exec2("resize", ["-u"]).match(/\d+/g);
    if (size.length === 2) {
      return createIfNotDefault(size[0], size[1]);
    }
  } catch {
  }
}, "resize");

// node_modules/ink/build/utils.js
var getWindowSize = /* @__PURE__ */ __name((stdout) => {
  const { columns, rows } = stdout;
  if (columns && rows) {
    return { columns, rows };
  }
  const fallbackSize = terminalSize();
  return {
    columns: columns || fallbackSize.columns || 80,
    rows: rows || fallbackSize.rows || 24
  };
}, "getWindowSize");

// node_modules/ink/build/reconciler.js
init_esbuild_shims();
var import_react_reconciler = __toESM(require_react_reconciler(), 1);
var import_constants = __toESM(require_constants(), 1);
var Scheduler = __toESM(require_scheduler(), 1);
import process4 from "node:process";
var import_react = __toESM(require_react(), 1);

// node_modules/ink/build/dom.js
init_esbuild_shims();

// node_modules/ink/build/measure-text.js
init_esbuild_shims();

// node_modules/ink/node_modules/widest-line/index.js
init_esbuild_shims();
function widestLine(string) {
  let lineWidth = 0;
  for (const line of string.split("\n")) {
    lineWidth = Math.max(lineWidth, stringWidth(line));
  }
  return lineWidth;
}
__name(widestLine, "widestLine");

// node_modules/ink/build/measure-text.js
var cache = /* @__PURE__ */ new Map();
var measureText = /* @__PURE__ */ __name((text) => {
  if (text.length === 0) {
    return {
      width: 0,
      height: 0
    };
  }
  const cachedDimensions = cache.get(text);
  if (cachedDimensions) {
    return cachedDimensions;
  }
  const width = widestLine(text);
  const height = text.split("\n").length;
  const dimensions = { width, height };
  cache.set(text, dimensions);
  return dimensions;
}, "measureText");
var measure_text_default = measureText;

// node_modules/ink/build/wrap-text.js
init_esbuild_shims();

// node_modules/ink/node_modules/cli-truncate/index.js
init_esbuild_shims();

// node_modules/ink/node_modules/slice-ansi/index.js
init_esbuild_shims();

// node_modules/ink/node_modules/slice-ansi/tokenize-ansi.js
init_esbuild_shims();

// node_modules/ink/node_modules/is-fullwidth-code-point/index.js
init_esbuild_shims();
function isFullwidthCodePoint(codePoint) {
  if (!Number.isInteger(codePoint)) {
    return false;
  }
  return isFullWidth(codePoint) || isWide(codePoint);
}
__name(isFullwidthCodePoint, "isFullwidthCodePoint");

// node_modules/ink/node_modules/slice-ansi/tokenize-ansi.js
var ESCAPE_CODE_POINT = 27;
var C1_DCS_CODE_POINT = 144;
var C1_SOS_CODE_POINT = 152;
var C1_CSI_CODE_POINT = 155;
var C1_ST_CODE_POINT = 156;
var C1_OSC_CODE_POINT = 157;
var C1_PM_CODE_POINT = 158;
var C1_APC_CODE_POINT = 159;
var ESCAPES2 = /* @__PURE__ */ new Set([
  ESCAPE_CODE_POINT,
  C1_DCS_CODE_POINT,
  C1_SOS_CODE_POINT,
  C1_CSI_CODE_POINT,
  C1_ST_CODE_POINT,
  C1_OSC_CODE_POINT,
  C1_PM_CODE_POINT,
  C1_APC_CODE_POINT
]);
var ESCAPE = "\x1B";
var ANSI_BELL = "\x07";
var ANSI_CSI2 = "[";
var ANSI_OSC2 = "]";
var ANSI_DCS = "P";
var ANSI_SOS = "X";
var ANSI_PM = "^";
var ANSI_APC = "_";
var ANSI_SGR_TERMINATOR2 = "m";
var ANSI_OSC_TERMINATOR = "\\";
var ANSI_STRING_TERMINATOR = `${ESCAPE}${ANSI_OSC_TERMINATOR}`;
var C1_OSC = "\x9D";
var C1_STRING_TERMINATOR = "\x9C";
var ANSI_HYPERLINK_ESC_PREFIX = `${ESCAPE}${ANSI_OSC2}8;`;
var ANSI_HYPERLINK_C1_PREFIX = `${C1_OSC}8;`;
var ANSI_HYPERLINK_ESC_CLOSE = `${ANSI_HYPERLINK_ESC_PREFIX};`;
var ANSI_HYPERLINK_C1_CLOSE = `${ANSI_HYPERLINK_C1_PREFIX};`;
var CODE_POINT_0 = "0".codePointAt(0);
var CODE_POINT_9 = "9".codePointAt(0);
var CODE_POINT_SEMICOLON = ";".codePointAt(0);
var CODE_POINT_COLON = ":".codePointAt(0);
var CODE_POINT_CSI_PARAMETER_START = "0".codePointAt(0);
var CODE_POINT_CSI_PARAMETER_END = "?".codePointAt(0);
var CODE_POINT_CSI_INTERMEDIATE_START = " ".codePointAt(0);
var CODE_POINT_CSI_INTERMEDIATE_END = "/".codePointAt(0);
var CODE_POINT_CSI_FINAL_START = "@".codePointAt(0);
var CODE_POINT_CSI_FINAL_END = "~".codePointAt(0);
var REGIONAL_INDICATOR_SYMBOL_LETTER_A = 127462;
var REGIONAL_INDICATOR_SYMBOL_LETTER_Z = 127487;
var SGR_RESET_CODE = 0;
var SGR_EXTENDED_FOREGROUND_CODE = 38;
var SGR_DEFAULT_FOREGROUND_CODE = 39;
var SGR_EXTENDED_BACKGROUND_CODE = 48;
var SGR_DEFAULT_BACKGROUND_CODE = 49;
var SGR_COLOR_TYPE_ANSI_256 = 5;
var SGR_COLOR_TYPE_TRUECOLOR = 2;
var SGR_ANSI_256_FRAGMENT_LENGTH = 3;
var SGR_TRUECOLOR_FRAGMENT_LENGTH = 5;
var SGR_ANSI_256_LAST_PARAMETER_OFFSET = 2;
var SGR_TRUECOLOR_LAST_PARAMETER_OFFSET = 4;
var VARIATION_SELECTOR_16_CODE_POINT = 65039;
var COMBINING_ENCLOSING_KEYCAP_CODE_POINT = 8419;
var EMOJI_PRESENTATION_GRAPHEME_REGEX = new RegExp("\\p{Emoji_Presentation}", "v");
var GRAPHEME_SEGMENTER = new Intl.Segmenter(void 0, { granularity: "grapheme" });
var endCodeNumbers = /* @__PURE__ */ new Set();
for (const [, end] of ansi_styles_default.codes) {
  endCodeNumbers.add(end);
}
function isSgrParameterCharacter(codePoint) {
  return codePoint >= CODE_POINT_0 && codePoint <= CODE_POINT_9 || codePoint === CODE_POINT_SEMICOLON || codePoint === CODE_POINT_COLON;
}
__name(isSgrParameterCharacter, "isSgrParameterCharacter");
function isCsiParameterCharacter(codePoint) {
  return codePoint >= CODE_POINT_CSI_PARAMETER_START && codePoint <= CODE_POINT_CSI_PARAMETER_END;
}
__name(isCsiParameterCharacter, "isCsiParameterCharacter");
function isCsiIntermediateCharacter(codePoint) {
  return codePoint >= CODE_POINT_CSI_INTERMEDIATE_START && codePoint <= CODE_POINT_CSI_INTERMEDIATE_END;
}
__name(isCsiIntermediateCharacter, "isCsiIntermediateCharacter");
function isCsiFinalCharacter(codePoint) {
  return codePoint >= CODE_POINT_CSI_FINAL_START && codePoint <= CODE_POINT_CSI_FINAL_END;
}
__name(isCsiFinalCharacter, "isCsiFinalCharacter");
function isRegionalIndicatorCodePoint(codePoint) {
  return codePoint >= REGIONAL_INDICATOR_SYMBOL_LETTER_A && codePoint <= REGIONAL_INDICATOR_SYMBOL_LETTER_Z;
}
__name(isRegionalIndicatorCodePoint, "isRegionalIndicatorCodePoint");
function createControlParseResult(code, endIndex) {
  return {
    token: {
      type: "control",
      code
    },
    endIndex
  };
}
__name(createControlParseResult, "createControlParseResult");
function isEmojiStyleGrapheme(grapheme) {
  if (EMOJI_PRESENTATION_GRAPHEME_REGEX.test(grapheme)) {
    return true;
  }
  for (const character of grapheme) {
    const codePoint = character.codePointAt(0);
    if (codePoint === VARIATION_SELECTOR_16_CODE_POINT || codePoint === COMBINING_ENCLOSING_KEYCAP_CODE_POINT) {
      return true;
    }
  }
  return false;
}
__name(isEmojiStyleGrapheme, "isEmojiStyleGrapheme");
function getGraphemeWidth(grapheme) {
  let regionalIndicatorCount = 0;
  for (const character of grapheme) {
    const codePoint = character.codePointAt(0);
    if (isFullwidthCodePoint(codePoint)) {
      return 2;
    }
    if (isRegionalIndicatorCodePoint(codePoint)) {
      regionalIndicatorCount++;
    }
  }
  if (regionalIndicatorCount >= 1) {
    return 2;
  }
  if (isEmojiStyleGrapheme(grapheme)) {
    return 2;
  }
  return 1;
}
__name(getGraphemeWidth, "getGraphemeWidth");
function getSgrPrefix(code) {
  if (code.startsWith("\x9B")) {
    return "\x9B";
  }
  return `${ESCAPE}${ANSI_CSI2}`;
}
__name(getSgrPrefix, "getSgrPrefix");
function createSgrCode(prefix, values) {
  return `${prefix}${values.join(";")}${ANSI_SGR_TERMINATOR2}`;
}
__name(createSgrCode, "createSgrCode");
function getSgrFragments(code) {
  const fragments = [];
  const sgrPrefix = getSgrPrefix(code);
  let parameterString;
  if (code.startsWith(`${ESCAPE}${ANSI_CSI2}`)) {
    parameterString = code.slice(2, -1);
  } else if (code.startsWith("\x9B")) {
    parameterString = code.slice(1, -1);
  } else {
    return fragments;
  }
  const rawCodes = parameterString.length === 0 ? [String(SGR_RESET_CODE)] : parameterString.split(";");
  let index = 0;
  while (index < rawCodes.length) {
    const codeNumber = Number.parseInt(rawCodes[index], 10);
    if (Number.isNaN(codeNumber)) {
      index++;
      continue;
    }
    if (codeNumber === SGR_RESET_CODE) {
      fragments.push({ type: "reset" });
      index++;
      continue;
    }
    if (codeNumber === SGR_EXTENDED_FOREGROUND_CODE || codeNumber === SGR_EXTENDED_BACKGROUND_CODE) {
      const colorType = Number.parseInt(rawCodes[index + 1], 10);
      if (colorType === SGR_COLOR_TYPE_ANSI_256 && index + SGR_ANSI_256_LAST_PARAMETER_OFFSET < rawCodes.length) {
        const openCode3 = createSgrCode(sgrPrefix, rawCodes.slice(index, index + SGR_ANSI_256_FRAGMENT_LENGTH));
        fragments.push({
          type: "start",
          code: openCode3,
          endCode: ansi_styles_default.color.ansi(codeNumber === SGR_EXTENDED_FOREGROUND_CODE ? SGR_DEFAULT_FOREGROUND_CODE : SGR_DEFAULT_BACKGROUND_CODE)
        });
        index += SGR_ANSI_256_FRAGMENT_LENGTH;
        continue;
      }
      if (colorType === SGR_COLOR_TYPE_TRUECOLOR && index + SGR_TRUECOLOR_LAST_PARAMETER_OFFSET < rawCodes.length) {
        const openCode3 = createSgrCode(sgrPrefix, rawCodes.slice(index, index + SGR_TRUECOLOR_FRAGMENT_LENGTH));
        fragments.push({
          type: "start",
          code: openCode3,
          endCode: ansi_styles_default.color.ansi(codeNumber === SGR_EXTENDED_FOREGROUND_CODE ? SGR_DEFAULT_FOREGROUND_CODE : SGR_DEFAULT_BACKGROUND_CODE)
        });
        index += SGR_TRUECOLOR_FRAGMENT_LENGTH;
        continue;
      }
      const openCode2 = createSgrCode(sgrPrefix, [rawCodes[index]]);
      fragments.push({
        type: "start",
        code: openCode2,
        endCode: ansi_styles_default.color.ansi(codeNumber === SGR_EXTENDED_FOREGROUND_CODE ? SGR_DEFAULT_FOREGROUND_CODE : SGR_DEFAULT_BACKGROUND_CODE)
      });
      index++;
      continue;
    }
    if (endCodeNumbers.has(codeNumber)) {
      fragments.push({
        type: "end",
        endCode: ansi_styles_default.color.ansi(codeNumber)
      });
      index++;
      continue;
    }
    const mappedEndCode = ansi_styles_default.codes.get(codeNumber);
    if (mappedEndCode !== void 0) {
      const openCode2 = createSgrCode(sgrPrefix, [rawCodes[index]]);
      fragments.push({
        type: "start",
        code: openCode2,
        endCode: ansi_styles_default.color.ansi(mappedEndCode)
      });
      index++;
      continue;
    }
    const openCode = createSgrCode(sgrPrefix, [rawCodes[index]]);
    fragments.push({
      type: "start",
      code: openCode,
      endCode: ansi_styles_default.reset.open
    });
    index++;
  }
  if (fragments.length === 0) {
    fragments.push({ type: "reset" });
  }
  return fragments;
}
__name(getSgrFragments, "getSgrFragments");
function parseCsiCode(string, index) {
  const escapeCodePoint = string.codePointAt(index);
  let sequenceStartIndex;
  if (escapeCodePoint === ESCAPE_CODE_POINT) {
    if (string[index + 1] !== ANSI_CSI2) {
      return;
    }
    sequenceStartIndex = index + 2;
  } else if (escapeCodePoint === C1_CSI_CODE_POINT) {
    sequenceStartIndex = index + 1;
  } else {
    return;
  }
  let hasCanonicalSgrParameters = true;
  for (let sequenceIndex = sequenceStartIndex; sequenceIndex < string.length; sequenceIndex++) {
    const codePoint = string.codePointAt(sequenceIndex);
    if (isCsiFinalCharacter(codePoint)) {
      const code = string.slice(index, sequenceIndex + 1);
      if (string[sequenceIndex] !== ANSI_SGR_TERMINATOR2 || !hasCanonicalSgrParameters) {
        return createControlParseResult(code, sequenceIndex + 1);
      }
      return {
        token: {
          type: "sgr",
          code,
          fragments: getSgrFragments(code)
        },
        endIndex: sequenceIndex + 1
      };
    }
    if (isCsiParameterCharacter(codePoint)) {
      if (!isSgrParameterCharacter(codePoint)) {
        hasCanonicalSgrParameters = false;
      }
      continue;
    }
    if (isCsiIntermediateCharacter(codePoint)) {
      hasCanonicalSgrParameters = false;
      continue;
    }
    const endIndex = sequenceIndex;
    return createControlParseResult(string.slice(index, endIndex), endIndex);
  }
  return createControlParseResult(string.slice(index), string.length);
}
__name(parseCsiCode, "parseCsiCode");
function parseHyperlinkCode(string, index) {
  let hyperlinkPrefix;
  let hyperlinkClose;
  const codePoint = string.codePointAt(index);
  if (codePoint === ESCAPE_CODE_POINT && string.startsWith(ANSI_HYPERLINK_ESC_PREFIX, index)) {
    hyperlinkPrefix = ANSI_HYPERLINK_ESC_PREFIX;
    hyperlinkClose = ANSI_HYPERLINK_ESC_CLOSE;
  } else if (codePoint === C1_OSC_CODE_POINT && string.startsWith(ANSI_HYPERLINK_C1_PREFIX, index)) {
    hyperlinkPrefix = ANSI_HYPERLINK_C1_PREFIX;
    hyperlinkClose = ANSI_HYPERLINK_C1_CLOSE;
  } else {
    return;
  }
  const uriStart = string.indexOf(";", index + hyperlinkPrefix.length);
  if (uriStart === -1) {
    return createControlParseResult(string.slice(index), string.length);
  }
  for (let sequenceIndex = uriStart + 1; sequenceIndex < string.length; sequenceIndex++) {
    const character = string[sequenceIndex];
    if (character === ANSI_BELL) {
      const code = string.slice(index, sequenceIndex + 1);
      const action = sequenceIndex === uriStart + 1 ? "close" : "open";
      return {
        token: {
          type: "hyperlink",
          code,
          action,
          closePrefix: hyperlinkClose,
          terminator: ANSI_BELL
        },
        endIndex: sequenceIndex + 1
      };
    }
    if (character === ESCAPE && string[sequenceIndex + 1] === ANSI_OSC_TERMINATOR) {
      const code = string.slice(index, sequenceIndex + 2);
      const action = sequenceIndex === uriStart + 1 ? "close" : "open";
      return {
        token: {
          type: "hyperlink",
          code,
          action,
          closePrefix: hyperlinkClose,
          terminator: ANSI_STRING_TERMINATOR
        },
        endIndex: sequenceIndex + 2
      };
    }
    if (character === C1_STRING_TERMINATOR) {
      const code = string.slice(index, sequenceIndex + 1);
      const action = sequenceIndex === uriStart + 1 ? "close" : "open";
      return {
        token: {
          type: "hyperlink",
          code,
          action,
          closePrefix: hyperlinkClose,
          terminator: C1_STRING_TERMINATOR
        },
        endIndex: sequenceIndex + 1
      };
    }
  }
  return createControlParseResult(string.slice(index), string.length);
}
__name(parseHyperlinkCode, "parseHyperlinkCode");
function parseControlStringCode(string, index) {
  const codePoint = string.codePointAt(index);
  let sequenceStartIndex;
  let supportsBellTerminator = false;
  switch (codePoint) {
    case ESCAPE_CODE_POINT: {
      const command = string[index + 1];
      switch (command) {
        case ANSI_OSC2: {
          sequenceStartIndex = index + 2;
          supportsBellTerminator = true;
          break;
        }
        case ANSI_DCS:
        case ANSI_SOS:
        case ANSI_PM:
        case ANSI_APC: {
          sequenceStartIndex = index + 2;
          break;
        }
        case ANSI_OSC_TERMINATOR: {
          return createControlParseResult(ANSI_STRING_TERMINATOR, index + 2);
        }
        default: {
          return;
        }
      }
      break;
    }
    case C1_OSC_CODE_POINT: {
      sequenceStartIndex = index + 1;
      supportsBellTerminator = true;
      break;
    }
    case C1_DCS_CODE_POINT:
    case C1_SOS_CODE_POINT:
    case C1_PM_CODE_POINT:
    case C1_APC_CODE_POINT: {
      sequenceStartIndex = index + 1;
      break;
    }
    case C1_ST_CODE_POINT: {
      return createControlParseResult(C1_STRING_TERMINATOR, index + 1);
    }
    default: {
      return;
    }
  }
  for (let sequenceIndex = sequenceStartIndex; sequenceIndex < string.length; sequenceIndex++) {
    if (supportsBellTerminator && string[sequenceIndex] === ANSI_BELL) {
      return createControlParseResult(string.slice(index, sequenceIndex + 1), sequenceIndex + 1);
    }
    if (string[sequenceIndex] === ESCAPE && string[sequenceIndex + 1] === ANSI_OSC_TERMINATOR) {
      return createControlParseResult(string.slice(index, sequenceIndex + 2), sequenceIndex + 2);
    }
    if (string[sequenceIndex] === C1_STRING_TERMINATOR) {
      return createControlParseResult(string.slice(index, sequenceIndex + 1), sequenceIndex + 1);
    }
  }
  return createControlParseResult(string.slice(index), string.length);
}
__name(parseControlStringCode, "parseControlStringCode");
function parseAnsiCode(string, index) {
  const codePoint = string.codePointAt(index);
  if (codePoint === ESCAPE_CODE_POINT || codePoint === C1_OSC_CODE_POINT) {
    const hyperlinkCode = parseHyperlinkCode(string, index);
    if (hyperlinkCode) {
      return hyperlinkCode;
    }
  }
  const controlStringCode = parseControlStringCode(string, index);
  if (controlStringCode) {
    return controlStringCode;
  }
  return parseCsiCode(string, index);
}
__name(parseAnsiCode, "parseAnsiCode");
function appendTrailingAnsiTokens(string, index, tokens) {
  while (index < string.length) {
    const nextCodePoint = string.codePointAt(index);
    if (!ESCAPES2.has(nextCodePoint)) {
      break;
    }
    const escapeCode = parseAnsiCode(string, index);
    if (!escapeCode) {
      break;
    }
    tokens.push(escapeCode.token);
    index = escapeCode.endIndex;
  }
  return index;
}
__name(appendTrailingAnsiTokens, "appendTrailingAnsiTokens");
function parseCharacterTokenWithRawSegmentation(string, index, graphemeSegments) {
  const segment = graphemeSegments.containing(index);
  if (!segment || segment.index !== index) {
    return;
  }
  return {
    token: {
      type: "character",
      // Intentionally preserve UAX29 behavior (GB3): CRLF is one grapheme cluster.
      value: segment.segment,
      visibleWidth: getGraphemeWidth(segment.segment),
      isGraphemeContinuation: false
    },
    endIndex: index + segment.segment.length
  };
}
__name(parseCharacterTokenWithRawSegmentation, "parseCharacterTokenWithRawSegmentation");
function collectVisibleCharacters(string) {
  const visibleCharacters = [];
  let index = 0;
  while (index < string.length) {
    const codePoint = string.codePointAt(index);
    if (ESCAPES2.has(codePoint)) {
      const code = parseAnsiCode(string, index);
      if (code) {
        index = code.endIndex;
        continue;
      }
    }
    const value = String.fromCodePoint(codePoint);
    visibleCharacters.push({
      value,
      visibleWidth: 1,
      isGraphemeContinuation: false
    });
    index += value.length;
  }
  return visibleCharacters;
}
__name(collectVisibleCharacters, "collectVisibleCharacters");
function applyGraphemeMetadata(visibleCharacters) {
  if (visibleCharacters.length === 0) {
    return;
  }
  const visibleString = visibleCharacters.map(({ value }) => value).join("");
  const scalarOffsets = [];
  let scalarOffset = 0;
  for (const visibleCharacter of visibleCharacters) {
    scalarOffsets.push(scalarOffset);
    scalarOffset += visibleCharacter.value.length;
  }
  let scalarIndex = 0;
  for (const segment of GRAPHEME_SEGMENTER.segment(visibleString)) {
    while (scalarIndex < visibleCharacters.length && scalarOffsets[scalarIndex] < segment.index) {
      scalarIndex++;
    }
    let graphemeIndex = scalarIndex;
    let isFirstInGrapheme = true;
    while (graphemeIndex < visibleCharacters.length && scalarOffsets[graphemeIndex] < segment.index + segment.segment.length) {
      visibleCharacters[graphemeIndex].visibleWidth = isFirstInGrapheme ? getGraphemeWidth(segment.segment) : 0;
      visibleCharacters[graphemeIndex].isGraphemeContinuation = !isFirstInGrapheme;
      isFirstInGrapheme = false;
      graphemeIndex++;
    }
    scalarIndex = graphemeIndex;
  }
}
__name(applyGraphemeMetadata, "applyGraphemeMetadata");
function tokenizeAnsiWithVisibleSegmentation(string, { endCharacter = Number.POSITIVE_INFINITY } = {}) {
  const tokens = [];
  const visibleCharacters = collectVisibleCharacters(string);
  applyGraphemeMetadata(visibleCharacters);
  let index = 0;
  let visibleCharacterIndex = 0;
  let visibleCount = 0;
  while (index < string.length) {
    const codePoint = string.codePointAt(index);
    if (ESCAPES2.has(codePoint)) {
      const code = parseAnsiCode(string, index);
      if (code) {
        tokens.push(code.token);
        index = code.endIndex;
        continue;
      }
    }
    const value = String.fromCodePoint(codePoint);
    const visibleCharacter = visibleCharacters[visibleCharacterIndex];
    let visibleWidth = isFullwidthCodePoint(codePoint) ? 2 : value.length;
    if (visibleCharacter) {
      visibleWidth = visibleCharacter.visibleWidth;
    }
    const token = {
      type: "character",
      value,
      visibleWidth,
      isGraphemeContinuation: visibleCharacter ? visibleCharacter.isGraphemeContinuation : false
    };
    tokens.push(token);
    index += value.length;
    visibleCharacterIndex++;
    visibleCount += token.visibleWidth;
    if (visibleCount >= endCharacter) {
      const nextVisibleCharacter = visibleCharacters[visibleCharacterIndex];
      if (!nextVisibleCharacter || !nextVisibleCharacter.isGraphemeContinuation) {
        index = appendTrailingAnsiTokens(string, index, tokens);
        break;
      }
    }
  }
  return tokens;
}
__name(tokenizeAnsiWithVisibleSegmentation, "tokenizeAnsiWithVisibleSegmentation");
function areValuesInSameGrapheme(leftValue, rightValue) {
  const pair = `${leftValue}${rightValue}`;
  const splitIndex = leftValue.length;
  for (const segment of GRAPHEME_SEGMENTER.segment(pair)) {
    if (segment.index === splitIndex) {
      return false;
    }
    if (segment.index > splitIndex) {
      return true;
    }
  }
  return true;
}
__name(areValuesInSameGrapheme, "areValuesInSameGrapheme");
function hasAnsiSplitContinuationAhead(string, startIndex, previousVisibleValue, graphemeSegments) {
  if (!previousVisibleValue) {
    return false;
  }
  let index = startIndex;
  let hasAnsiCode = false;
  while (index < string.length) {
    const codePoint = string.codePointAt(index);
    if (ESCAPES2.has(codePoint)) {
      const code = parseAnsiCode(string, index);
      if (code) {
        hasAnsiCode = true;
        index = code.endIndex;
        continue;
      }
    }
    if (!hasAnsiCode) {
      return false;
    }
    const characterToken = parseCharacterTokenWithRawSegmentation(string, index, graphemeSegments);
    if (!characterToken) {
      return true;
    }
    return areValuesInSameGrapheme(previousVisibleValue, characterToken.token.value);
  }
  return false;
}
__name(hasAnsiSplitContinuationAhead, "hasAnsiSplitContinuationAhead");
function tokenizeAnsi(string, { endCharacter = Number.POSITIVE_INFINITY } = {}) {
  const tokens = [];
  const graphemeSegments = GRAPHEME_SEGMENTER.segment(string);
  let index = 0;
  let visibleCount = 0;
  let previousVisibleValue;
  let hasAnsiSinceLastVisible = false;
  while (index < string.length) {
    const codePoint = string.codePointAt(index);
    if (ESCAPES2.has(codePoint)) {
      const code = parseAnsiCode(string, index);
      if (code) {
        tokens.push(code.token);
        index = code.endIndex;
        hasAnsiSinceLastVisible = true;
        continue;
      }
    }
    const characterToken = parseCharacterTokenWithRawSegmentation(string, index, graphemeSegments);
    if (!characterToken) {
      return tokenizeAnsiWithVisibleSegmentation(string, { endCharacter });
    }
    if (hasAnsiSinceLastVisible && previousVisibleValue && areValuesInSameGrapheme(previousVisibleValue, characterToken.token.value)) {
      return tokenizeAnsiWithVisibleSegmentation(string, { endCharacter });
    }
    tokens.push(characterToken.token);
    index = characterToken.endIndex;
    visibleCount += characterToken.token.visibleWidth;
    hasAnsiSinceLastVisible = false;
    previousVisibleValue = characterToken.token.value;
    if (visibleCount >= endCharacter) {
      if (hasAnsiSplitContinuationAhead(string, index, previousVisibleValue, graphemeSegments)) {
        return tokenizeAnsiWithVisibleSegmentation(string, { endCharacter });
      }
      index = appendTrailingAnsiTokens(string, index, tokens);
      break;
    }
  }
  return tokens;
}
__name(tokenizeAnsi, "tokenizeAnsi");

// node_modules/ink/node_modules/slice-ansi/index.js
function applySgrFragments(activeStyles, fragments) {
  for (const fragment of fragments) {
    switch (fragment.type) {
      case "reset": {
        activeStyles.clear();
        break;
      }
      case "end": {
        activeStyles.delete(fragment.endCode);
        break;
      }
      case "start": {
        activeStyles.delete(fragment.endCode);
        activeStyles.set(fragment.endCode, fragment.code);
        break;
      }
      default: {
        break;
      }
    }
  }
  return activeStyles;
}
__name(applySgrFragments, "applySgrFragments");
function undoAnsiCodes(activeStyles) {
  return [...activeStyles.keys()].toReversed().join("");
}
__name(undoAnsiCodes, "undoAnsiCodes");
function closeHyperlink(hyperlinkToken) {
  return `${hyperlinkToken.closePrefix}${hyperlinkToken.terminator}`;
}
__name(closeHyperlink, "closeHyperlink");
function shouldIncludeSgrAfterEnd(token, activeStyles) {
  let hasStartFragment = false;
  let hasClosingEffect = false;
  for (const fragment of token.fragments) {
    if (fragment.type === "start") {
      hasStartFragment = true;
      continue;
    }
    if (fragment.type === "reset" && activeStyles.size > 0) {
      hasClosingEffect = true;
      continue;
    }
    if (fragment.type === "end" && activeStyles.has(fragment.endCode)) {
      hasClosingEffect = true;
    }
  }
  return hasClosingEffect && !hasStartFragment;
}
__name(shouldIncludeSgrAfterEnd, "shouldIncludeSgrAfterEnd");
function hasSgrStartFragment(token) {
  return token.fragments.some((fragment) => fragment.type === "start");
}
__name(hasSgrStartFragment, "hasSgrStartFragment");
function discardPendingHyperlink(parameters) {
  if (parameters.activeHyperlink && !parameters.activeHyperlinkHasVisibleText && parameters.activeHyperlinkOutputIndex !== void 0) {
    const openCodeLength = parameters.activeHyperlink.code.length;
    parameters.returnValue = parameters.returnValue.slice(0, parameters.activeHyperlinkOutputIndex) + parameters.returnValue.slice(parameters.activeHyperlinkOutputIndex + openCodeLength);
    if (parameters.pendingSgrOutputIndex !== void 0 && parameters.pendingSgrOutputIndex > parameters.activeHyperlinkOutputIndex) {
      parameters.pendingSgrOutputIndex -= openCodeLength;
    }
  }
  parameters.activeHyperlink = void 0;
  parameters.activeHyperlinkHasVisibleText = false;
  parameters.activeHyperlinkOutputIndex = void 0;
}
__name(discardPendingHyperlink, "discardPendingHyperlink");
function applySgrToken2(parameters) {
  if (parameters.isPastEnd && !shouldIncludeSgrAfterEnd(parameters.token, parameters.activeStyles)) {
    return parameters;
  }
  if (parameters.include && hasSgrStartFragment(parameters.token) && parameters.pendingSgrOutputIndex === void 0) {
    parameters.pendingSgrOutputIndex = parameters.returnValue.length;
    parameters.pendingSgrActiveStyles = new Map(parameters.activeStyles);
  }
  parameters.activeStyles = applySgrFragments(parameters.activeStyles, parameters.token.fragments);
  if (parameters.include) {
    parameters.returnValue += parameters.token.code;
  }
  return parameters;
}
__name(applySgrToken2, "applySgrToken");
function applyHyperlinkToken(parameters) {
  if (parameters.isPastEnd && (parameters.token.action !== "close" || !parameters.activeHyperlink)) {
    return parameters;
  }
  if (parameters.token.action === "open") {
    parameters.activeHyperlink = parameters.token;
    parameters.activeHyperlinkHasVisibleText = false;
    parameters.activeHyperlinkOutputIndex = void 0;
    if (parameters.include) {
      parameters.activeHyperlinkOutputIndex = parameters.returnValue.length;
    }
  } else if (parameters.token.action === "close") {
    if (parameters.include && parameters.activeHyperlink && !parameters.activeHyperlinkHasVisibleText) {
      discardPendingHyperlink(parameters);
      return parameters;
    }
    parameters.activeHyperlink = void 0;
    parameters.activeHyperlinkHasVisibleText = false;
    parameters.activeHyperlinkOutputIndex = void 0;
  }
  if (parameters.include) {
    parameters.returnValue += parameters.token.code;
  }
  return parameters;
}
__name(applyHyperlinkToken, "applyHyperlinkToken");
function applyControlToken(parameters) {
  if (!parameters.isPastEnd && parameters.include) {
    parameters.returnValue += parameters.token.code;
  }
  return parameters;
}
__name(applyControlToken, "applyControlToken");
function applyCharacterToken(parameters) {
  if (!parameters.include && parameters.position >= parameters.start && !parameters.token.isGraphemeContinuation) {
    parameters.include = true;
    parameters.returnValue = [...parameters.activeStyles.values()].join("");
    if (parameters.activeHyperlink) {
      parameters.activeHyperlinkOutputIndex = parameters.returnValue.length;
      parameters.returnValue += parameters.activeHyperlink.code;
    }
  }
  if (parameters.include) {
    parameters.returnValue += parameters.token.value;
    parameters.pendingSgrOutputIndex = void 0;
    parameters.pendingSgrActiveStyles = void 0;
    if (parameters.activeHyperlink) {
      parameters.activeHyperlinkHasVisibleText = true;
    }
  }
  parameters.position += parameters.token.visibleWidth;
  return parameters;
}
__name(applyCharacterToken, "applyCharacterToken");
var tokenHandlers = {
  sgr: applySgrToken2,
  hyperlink: applyHyperlinkToken,
  control: applyControlToken,
  character: applyCharacterToken
};
function applyToken(parameters) {
  const tokenHandler = tokenHandlers[parameters.token.type];
  if (!tokenHandler) {
    return parameters;
  }
  return tokenHandler(parameters);
}
__name(applyToken, "applyToken");
function createHasContinuationAheadMap(tokens) {
  const hasContinuationAhead = Array.from({ length: tokens.length }, () => false);
  let nextCharacterIsContinuation = false;
  for (let tokenIndex = tokens.length - 1; tokenIndex >= 0; tokenIndex--) {
    const token = tokens[tokenIndex];
    hasContinuationAhead[tokenIndex] = nextCharacterIsContinuation;
    if (token.type === "character") {
      nextCharacterIsContinuation = Boolean(token.isGraphemeContinuation);
    }
  }
  return hasContinuationAhead;
}
__name(createHasContinuationAheadMap, "createHasContinuationAheadMap");
function isPastEndBoundary(token, position, end) {
  if (end === void 0) {
    return false;
  }
  if (position >= end) {
    return true;
  }
  return token.type === "character" && !token.isGraphemeContinuation && position + token.visibleWidth > end;
}
__name(isPastEndBoundary, "isPastEndBoundary");
function sliceAnsi(string, start, end) {
  const tokens = tokenizeAnsi(string, { endCharacter: end });
  const hasContinuationAhead = createHasContinuationAheadMap(tokens);
  let activeStyles = /* @__PURE__ */ new Map();
  let activeHyperlink;
  let activeHyperlinkHasVisibleText = false;
  let activeHyperlinkOutputIndex;
  let pendingSgrOutputIndex;
  let pendingSgrActiveStyles;
  let position = 0;
  let returnValue = "";
  let include = false;
  for (const [tokenIndex, token] of tokens.entries()) {
    let isPastEnd = isPastEndBoundary(token, position, end);
    if (isPastEnd && token.type !== "character" && hasContinuationAhead[tokenIndex]) {
      isPastEnd = false;
    }
    if (isPastEnd && token.type === "character" && !token.isGraphemeContinuation) {
      if (activeHyperlink && !activeHyperlinkHasVisibleText) {
        const hyperlinkState = {
          activeHyperlink,
          activeHyperlinkHasVisibleText,
          activeHyperlinkOutputIndex,
          pendingSgrOutputIndex,
          returnValue
        };
        discardPendingHyperlink(hyperlinkState);
        ({
          activeHyperlink,
          activeHyperlinkHasVisibleText,
          activeHyperlinkOutputIndex,
          pendingSgrOutputIndex,
          returnValue
        } = hyperlinkState);
      }
      if (pendingSgrOutputIndex !== void 0) {
        returnValue = returnValue.slice(0, pendingSgrOutputIndex);
        activeStyles = pendingSgrActiveStyles;
        pendingSgrOutputIndex = void 0;
        pendingSgrActiveStyles = void 0;
      }
      break;
    }
    ({ activeStyles, activeHyperlink, activeHyperlinkHasVisibleText, activeHyperlinkOutputIndex, pendingSgrOutputIndex, pendingSgrActiveStyles, position, returnValue, include } = applyToken({
      token,
      isPastEnd,
      start,
      activeStyles,
      activeHyperlink,
      activeHyperlinkHasVisibleText,
      activeHyperlinkOutputIndex,
      pendingSgrOutputIndex,
      pendingSgrActiveStyles,
      position,
      returnValue,
      include
    }));
  }
  if (!include) {
    return "";
  }
  if (activeHyperlink) {
    returnValue += closeHyperlink(activeHyperlink);
  }
  returnValue += undoAnsiCodes(activeStyles);
  return returnValue;
}
__name(sliceAnsi, "sliceAnsi");

// node_modules/ink/node_modules/cli-truncate/index.js
function getIndexOfNearestSpace(string, wantedIndex, shouldSearchRight) {
  if (string.charAt(wantedIndex) === " ") {
    return wantedIndex;
  }
  const direction = shouldSearchRight ? 1 : -1;
  for (let index = 0; index <= 3; index++) {
    const finalIndex = wantedIndex + index * direction;
    if (string.charAt(finalIndex) === " ") {
      return finalIndex;
    }
  }
  return wantedIndex;
}
__name(getIndexOfNearestSpace, "getIndexOfNearestSpace");
function cliTruncate(text, columns, options = {}) {
  const {
    position = "end",
    space = false,
    preferTruncationOnSpace = false
  } = options;
  let { truncationCharacter = "\u2026" } = options;
  if (typeof text !== "string") {
    throw new TypeError(`Expected \`input\` to be a string, got ${typeof text}`);
  }
  if (typeof columns !== "number") {
    throw new TypeError(`Expected \`columns\` to be a number, got ${typeof columns}`);
  }
  if (columns < 1) {
    return "";
  }
  const length = stringWidth(text);
  if (length <= columns) {
    return text;
  }
  if (columns === 1) {
    return truncationCharacter;
  }
  const ANSI = {
    ESC: 27,
    LEFT_BRACKET: 91,
    LETTER_M: 109
  };
  const isSgrParameter = /* @__PURE__ */ __name((code) => code >= 48 && code <= 57 || code === 59, "isSgrParameter");
  function leadingSgrSpanEndIndex(string) {
    let index = 0;
    while (index + 2 < string.length && string.codePointAt(index) === ANSI.ESC && string.codePointAt(index + 1) === ANSI.LEFT_BRACKET) {
      let j = index + 2;
      while (j < string.length && isSgrParameter(string.codePointAt(j))) {
        j++;
      }
      if (j < string.length && string.codePointAt(j) === ANSI.LETTER_M) {
        index = j + 1;
        continue;
      }
      break;
    }
    return index;
  }
  __name(leadingSgrSpanEndIndex, "leadingSgrSpanEndIndex");
  function trailingSgrSpanStartIndex(string) {
    let start = string.length;
    while (start > 1 && string.codePointAt(start - 1) === ANSI.LETTER_M) {
      let j = start - 2;
      while (j >= 0 && isSgrParameter(string.codePointAt(j))) {
        j--;
      }
      if (j >= 1 && string.codePointAt(j - 1) === ANSI.ESC && string.codePointAt(j) === ANSI.LEFT_BRACKET) {
        start = j - 1;
        continue;
      }
      break;
    }
    return start;
  }
  __name(trailingSgrSpanStartIndex, "trailingSgrSpanStartIndex");
  function appendWithInheritedStyleFromEnd(visible, suffix) {
    const start = trailingSgrSpanStartIndex(visible);
    if (start === visible.length) {
      return visible + suffix;
    }
    return visible.slice(0, start) + suffix + visible.slice(start);
  }
  __name(appendWithInheritedStyleFromEnd, "appendWithInheritedStyleFromEnd");
  function prependWithInheritedStyleFromStart(prefix, visible) {
    const end = leadingSgrSpanEndIndex(visible);
    if (end === 0) {
      return prefix + visible;
    }
    return visible.slice(0, end) + prefix + visible.slice(end);
  }
  __name(prependWithInheritedStyleFromStart, "prependWithInheritedStyleFromStart");
  if (position === "start") {
    if (preferTruncationOnSpace) {
      const nearestSpace = getIndexOfNearestSpace(text, length - columns + 1, true);
      const right2 = sliceAnsi(text, nearestSpace, length).trim();
      return prependWithInheritedStyleFromStart(truncationCharacter, right2);
    }
    if (space) {
      truncationCharacter += " ";
    }
    const right = sliceAnsi(text, length - columns + stringWidth(truncationCharacter), length);
    return prependWithInheritedStyleFromStart(truncationCharacter, right);
  }
  if (position === "middle") {
    if (space) {
      truncationCharacter = ` ${truncationCharacter} `;
    }
    const half = Math.floor(columns / 2);
    if (preferTruncationOnSpace) {
      const spaceNearFirstBreakPoint = getIndexOfNearestSpace(text, half);
      const spaceNearSecondBreakPoint = getIndexOfNearestSpace(text, length - (columns - half) + 1, true);
      return sliceAnsi(text, 0, spaceNearFirstBreakPoint) + truncationCharacter + sliceAnsi(text, spaceNearSecondBreakPoint, length).trim();
    }
    return sliceAnsi(text, 0, half) + truncationCharacter + sliceAnsi(text, length - (columns - half) + stringWidth(truncationCharacter), length);
  }
  if (position === "end") {
    if (preferTruncationOnSpace) {
      const nearestSpace = getIndexOfNearestSpace(text, columns - 1);
      const left2 = sliceAnsi(text, 0, nearestSpace);
      return appendWithInheritedStyleFromEnd(left2, truncationCharacter);
    }
    if (space) {
      truncationCharacter = ` ${truncationCharacter}`;
    }
    const left = sliceAnsi(text, 0, columns - stringWidth(truncationCharacter));
    return appendWithInheritedStyleFromEnd(left, truncationCharacter);
  }
  throw new Error(`Expected \`options.position\` to be either \`start\`, \`middle\` or \`end\`, got ${position}`);
}
__name(cliTruncate, "cliTruncate");

// node_modules/ink/build/wrap-text.js
var cache2 = {};
var wrapText = /* @__PURE__ */ __name((text, maxWidth, wrapType) => {
  const cacheKey = text + String(maxWidth) + String(wrapType);
  const cachedText = cache2[cacheKey];
  if (cachedText) {
    return cachedText;
  }
  let wrappedText = text;
  if (wrapType === "wrap") {
    wrappedText = wrapAnsi(text, maxWidth, {
      trim: false,
      hard: true
    });
  }
  if (wrapType === "hard") {
    wrappedText = wrapAnsi(text, maxWidth, {
      trim: false,
      hard: true,
      wordWrap: false
    });
  }
  if (wrapType.startsWith("truncate")) {
    let position = "end";
    if (wrapType === "truncate-middle") {
      position = "middle";
    }
    if (wrapType === "truncate-start") {
      position = "start";
    }
    wrappedText = cliTruncate(text, maxWidth, { position });
  }
  cache2[cacheKey] = wrappedText;
  return wrappedText;
}, "wrapText");
var wrapTextWithMetadata = /* @__PURE__ */ __name((text, maxWidth, wrapType, shouldWrap = true) => {
  const sourceLines = text.replaceAll("\r\n", "\n").split("\n");
  const lines = [];
  const boundaries = [];
  const selectableRows = [];
  for (const [sourceLineIndex, sourceLine] of sourceLines.entries()) {
    const wrappedLines = (shouldWrap ? wrapText(sourceLine, maxWidth, wrapType) : sourceLine).split("\n");
    const visibleSource = stripAnsi(sourceLine);
    let sourceOffset = 0;
    for (const [wrappedLineIndex, wrappedLine] of wrappedLines.entries()) {
      const visibleLine = stripAnsi(wrappedLine);
      const separatorRow = sourceOffset > 0 && visibleLine.length > 0 && /^\s+$/u.test(visibleLine) && /\S/u.test(visibleSource.slice(sourceOffset));
      const sourceSeparator = separatorRow ? (/^\s+/u.exec(visibleSource.slice(sourceOffset))?.[0] ?? "").slice(0, visibleLine.length) : "";
      const lineOffset = separatorRow ? sourceOffset : visibleSource.indexOf(visibleLine, sourceOffset);
      const resolvedOffset = lineOffset === -1 ? sourceOffset : lineOffset;
      if (lines.length > 0) {
        boundaries.push({
          kind: wrappedLineIndex === 0 ? "hard" : "soft",
          joiner: wrappedLineIndex === 0 ? "\n" : separatorRow ? sourceSeparator : visibleSource.slice(sourceOffset, resolvedOffset)
        });
      }
      lines.push(wrappedLine);
      selectableRows.push(!separatorRow);
      sourceOffset = separatorRow ? sourceOffset + sourceSeparator.length : resolvedOffset + visibleLine.length;
    }
    if (sourceLineIndex < sourceLines.length - 1 && wrappedLines.length === 0) {
      lines.push("");
    }
  }
  return { text: lines.join("\n"), boundaries, selectableRows };
}, "wrapTextWithMetadata");
var wrap_text_default = wrapText;

// node_modules/ink/build/squash-text-nodes.js
init_esbuild_shims();

// node_modules/ink/build/sanitize-ansi.js
init_esbuild_shims();

// node_modules/ink/build/ansi-tokenizer.js
init_esbuild_shims();
var bellCharacter = "\x07";
var escapeCharacter = "\x1B";
var stringTerminatorCharacter = "\x9C";
var csiCharacter = "\x9B";
var oscCharacter = "\x9D";
var dcsCharacter = "\x90";
var pmCharacter = "\x9E";
var apcCharacter = "\x9F";
var sosCharacter = "\x98";
var isCsiParameterCharacter2 = /* @__PURE__ */ __name((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint !== void 0 && codePoint >= 48 && codePoint <= 63;
}, "isCsiParameterCharacter");
var isCsiIntermediateCharacter2 = /* @__PURE__ */ __name((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint !== void 0 && codePoint >= 32 && codePoint <= 47;
}, "isCsiIntermediateCharacter");
var isCsiFinalCharacter2 = /* @__PURE__ */ __name((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint !== void 0 && codePoint >= 64 && codePoint <= 126;
}, "isCsiFinalCharacter");
var isEscapeIntermediateCharacter = /* @__PURE__ */ __name((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint !== void 0 && codePoint >= 32 && codePoint <= 47;
}, "isEscapeIntermediateCharacter");
var isEscapeFinalCharacter = /* @__PURE__ */ __name((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint !== void 0 && codePoint >= 48 && codePoint <= 126;
}, "isEscapeFinalCharacter");
var isC1ControlCharacter = /* @__PURE__ */ __name((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint !== void 0 && codePoint >= 128 && codePoint <= 159;
}, "isC1ControlCharacter");
var readCsiSequence = /* @__PURE__ */ __name((text, fromIndex) => {
  let index = fromIndex;
  while (index < text.length) {
    const character = text[index];
    if (!isCsiParameterCharacter2(character)) {
      break;
    }
    index++;
  }
  const parameterString = text.slice(fromIndex, index);
  const intermediateStartIndex = index;
  while (index < text.length) {
    const character = text[index];
    if (!isCsiIntermediateCharacter2(character)) {
      break;
    }
    index++;
  }
  const intermediateString = text.slice(intermediateStartIndex, index);
  const finalCharacter = text[index];
  if (finalCharacter === void 0 || !isCsiFinalCharacter2(finalCharacter)) {
    return void 0;
  }
  return {
    endIndex: index + 1,
    parameterString,
    intermediateString,
    finalCharacter
  };
}, "readCsiSequence");
var findControlStringTerminatorIndex = /* @__PURE__ */ __name((text, fromIndex, allowBellTerminator) => {
  for (let index = fromIndex; index < text.length; index++) {
    const character = text[index];
    if (allowBellTerminator && character === bellCharacter) {
      return index + 1;
    }
    if (character === stringTerminatorCharacter) {
      return index + 1;
    }
    if (character === escapeCharacter) {
      const followingCharacter = text[index + 1];
      if (followingCharacter === escapeCharacter) {
        index++;
        continue;
      }
      if (followingCharacter === "\\") {
        return index + 2;
      }
    }
  }
  return void 0;
}, "findControlStringTerminatorIndex");
var readEscapeSequence = /* @__PURE__ */ __name((text, fromIndex) => {
  let index = fromIndex;
  while (index < text.length) {
    const character = text[index];
    if (!isEscapeIntermediateCharacter(character)) {
      break;
    }
    index++;
  }
  const intermediateString = text.slice(fromIndex, index);
  const finalCharacter = text[index];
  if (finalCharacter === void 0 || !isEscapeFinalCharacter(finalCharacter)) {
    return void 0;
  }
  return {
    endIndex: index + 1,
    intermediateString,
    finalCharacter
  };
}, "readEscapeSequence");
var getControlStringFromEscapeIntroducer = /* @__PURE__ */ __name((character) => {
  switch (character) {
    case "]": {
      return { type: "osc", allowBellTerminator: true };
    }
    case "P": {
      return { type: "dcs", allowBellTerminator: false };
    }
    case "^": {
      return { type: "pm", allowBellTerminator: false };
    }
    case "_": {
      return { type: "apc", allowBellTerminator: false };
    }
    case "X": {
      return { type: "sos", allowBellTerminator: false };
    }
    default: {
      return void 0;
    }
  }
}, "getControlStringFromEscapeIntroducer");
var getControlStringFromC1Introducer = /* @__PURE__ */ __name((character) => {
  switch (character) {
    case oscCharacter: {
      return { type: "osc", allowBellTerminator: true };
    }
    case dcsCharacter: {
      return { type: "dcs", allowBellTerminator: false };
    }
    case pmCharacter: {
      return { type: "pm", allowBellTerminator: false };
    }
    case apcCharacter: {
      return { type: "apc", allowBellTerminator: false };
    }
    case sosCharacter: {
      return { type: "sos", allowBellTerminator: false };
    }
    default: {
      return void 0;
    }
  }
}, "getControlStringFromC1Introducer");
var hasAnsiControlCharacters = /* @__PURE__ */ __name((text) => {
  if (text.includes(escapeCharacter)) {
    return true;
  }
  for (const character of text) {
    if (isC1ControlCharacter(character)) {
      return true;
    }
  }
  return false;
}, "hasAnsiControlCharacters");
var malformedFromIndex = /* @__PURE__ */ __name((tokens, text, textStartIndex, fromIndex) => {
  if (fromIndex > textStartIndex) {
    tokens.push({ type: "text", value: text.slice(textStartIndex, fromIndex) });
  }
  tokens.push({ type: "invalid", value: text.slice(fromIndex) });
  return tokens;
}, "malformedFromIndex");
var tokenizeAnsi2 = /* @__PURE__ */ __name((text) => {
  if (!hasAnsiControlCharacters(text)) {
    return [{ type: "text", value: text }];
  }
  const tokens = [];
  let textStartIndex = 0;
  for (let index = 0; index < text.length; ) {
    const character = text[index];
    if (character === void 0) {
      break;
    }
    if (character === escapeCharacter) {
      const followingCharacter = text[index + 1];
      if (followingCharacter === void 0) {
        return malformedFromIndex(tokens, text, textStartIndex, index);
      }
      if (followingCharacter === "[") {
        const csiSequence = readCsiSequence(text, index + 2);
        if (csiSequence === void 0) {
          return malformedFromIndex(tokens, text, textStartIndex, index);
        }
        if (index > textStartIndex) {
          tokens.push({ type: "text", value: text.slice(textStartIndex, index) });
        }
        tokens.push({
          type: "csi",
          value: text.slice(index, csiSequence.endIndex),
          parameterString: csiSequence.parameterString,
          intermediateString: csiSequence.intermediateString,
          finalCharacter: csiSequence.finalCharacter
        });
        index = csiSequence.endIndex;
        textStartIndex = index;
        continue;
      }
      const escapeControlString = getControlStringFromEscapeIntroducer(followingCharacter);
      if (escapeControlString !== void 0) {
        const controlStringTerminatorIndex = findControlStringTerminatorIndex(text, index + 2, escapeControlString.allowBellTerminator);
        if (controlStringTerminatorIndex === void 0) {
          return malformedFromIndex(tokens, text, textStartIndex, index);
        }
        if (index > textStartIndex) {
          tokens.push({ type: "text", value: text.slice(textStartIndex, index) });
        }
        tokens.push({
          type: escapeControlString.type,
          value: text.slice(index, controlStringTerminatorIndex)
        });
        index = controlStringTerminatorIndex;
        textStartIndex = index;
        continue;
      }
      const escapeSequence = readEscapeSequence(text, index + 1);
      if (escapeSequence === void 0) {
        if (isEscapeIntermediateCharacter(followingCharacter)) {
          return malformedFromIndex(tokens, text, textStartIndex, index);
        }
        if (index > textStartIndex) {
          tokens.push({ type: "text", value: text.slice(textStartIndex, index) });
        }
        index++;
        textStartIndex = index;
        continue;
      }
      if (index > textStartIndex) {
        tokens.push({ type: "text", value: text.slice(textStartIndex, index) });
      }
      tokens.push({
        type: "esc",
        value: text.slice(index, escapeSequence.endIndex),
        intermediateString: escapeSequence.intermediateString,
        finalCharacter: escapeSequence.finalCharacter
      });
      index = escapeSequence.endIndex;
      textStartIndex = index;
      continue;
    }
    if (character === csiCharacter) {
      const csiSequence = readCsiSequence(text, index + 1);
      if (csiSequence === void 0) {
        return malformedFromIndex(tokens, text, textStartIndex, index);
      }
      if (index > textStartIndex) {
        tokens.push({ type: "text", value: text.slice(textStartIndex, index) });
      }
      tokens.push({
        type: "csi",
        value: text.slice(index, csiSequence.endIndex),
        parameterString: csiSequence.parameterString,
        intermediateString: csiSequence.intermediateString,
        finalCharacter: csiSequence.finalCharacter
      });
      index = csiSequence.endIndex;
      textStartIndex = index;
      continue;
    }
    const c1ControlString = getControlStringFromC1Introducer(character);
    if (c1ControlString !== void 0) {
      const controlStringTerminatorIndex = findControlStringTerminatorIndex(text, index + 1, c1ControlString.allowBellTerminator);
      if (controlStringTerminatorIndex === void 0) {
        return malformedFromIndex(tokens, text, textStartIndex, index);
      }
      if (index > textStartIndex) {
        tokens.push({ type: "text", value: text.slice(textStartIndex, index) });
      }
      tokens.push({
        type: c1ControlString.type,
        value: text.slice(index, controlStringTerminatorIndex)
      });
      index = controlStringTerminatorIndex;
      textStartIndex = index;
      continue;
    }
    if (character === stringTerminatorCharacter) {
      if (index > textStartIndex) {
        tokens.push({ type: "text", value: text.slice(textStartIndex, index) });
      }
      tokens.push({ type: "st", value: character });
      index++;
      textStartIndex = index;
      continue;
    }
    if (isC1ControlCharacter(character)) {
      if (index > textStartIndex) {
        tokens.push({ type: "text", value: text.slice(textStartIndex, index) });
      }
      tokens.push({ type: "c1", value: character });
      index++;
      textStartIndex = index;
      continue;
    }
    index++;
  }
  if (textStartIndex < text.length) {
    tokens.push({ type: "text", value: text.slice(textStartIndex) });
  }
  return tokens;
}, "tokenizeAnsi");

// node_modules/ink/build/sanitize-ansi.js
var sgrParametersRegex = /^[\d:;]*$/;
var sanitizeAnsi = /* @__PURE__ */ __name((text) => {
  if (!hasAnsiControlCharacters(text)) {
    return text;
  }
  let output = "";
  for (const token of tokenizeAnsi2(text)) {
    if (token.type === "text" || token.type === "osc") {
      output += token.value;
      continue;
    }
    if (token.type === "csi" && token.finalCharacter === "m" && token.intermediateString === "" && sgrParametersRegex.test(token.parameterString)) {
      output += token.value;
    }
  }
  return output;
}, "sanitizeAnsi");
var sanitize_ansi_default = sanitizeAnsi;

// node_modules/ink/build/squash-text-nodes.js
var squashTextNodes = /* @__PURE__ */ __name((node) => {
  let text = "";
  for (let index = 0; index < node.childNodes.length; index++) {
    const childNode = node.childNodes[index];
    if (childNode === void 0) {
      continue;
    }
    let nodeText = "";
    if (childNode.nodeName === "#text") {
      nodeText = childNode.nodeValue;
    } else {
      if (childNode.nodeName === "ink-text" || childNode.nodeName === "ink-virtual-text") {
        nodeText = squashTextNodes(childNode);
      }
      if (nodeText.length > 0 && typeof childNode.internal_transform === "function") {
        nodeText = childNode.internal_transform(nodeText, index);
      }
    }
    text += nodeText;
  }
  return sanitize_ansi_default(text);
}, "squashTextNodes");
var squash_text_nodes_default = squashTextNodes;

// node_modules/ink/build/dom.js
var createNode = /* @__PURE__ */ __name((nodeName) => {
  const node = {
    nodeName,
    style: {},
    attributes: {},
    childNodes: [],
    parentNode: void 0,
    yogaNode: nodeName === "ink-virtual-text" ? void 0 : src_default.Node.create(),
    // eslint-disable-next-line @typescript-eslint/naming-convention
    internal_accessibility: {}
  };
  if (nodeName === "ink-text") {
    node.yogaNode?.setMeasureFunc(measureTextNode.bind(null, node));
  }
  return node;
}, "createNode");
var appendChildNode = /* @__PURE__ */ __name((node, childNode) => {
  if (childNode.parentNode) {
    removeChildNode(childNode.parentNode, childNode);
  }
  childNode.parentNode = node;
  node.childNodes.push(childNode);
  if (childNode.yogaNode) {
    node.yogaNode?.insertChild(childNode.yogaNode, node.yogaNode.getChildCount());
  }
  if (node.nodeName === "ink-text" || node.nodeName === "ink-virtual-text") {
    markNodeAsDirty(node);
  }
}, "appendChildNode");
var insertBeforeNode = /* @__PURE__ */ __name((node, newChildNode, beforeChildNode) => {
  if (newChildNode.parentNode) {
    removeChildNode(newChildNode.parentNode, newChildNode);
  }
  newChildNode.parentNode = node;
  const index = node.childNodes.indexOf(beforeChildNode);
  if (index >= 0) {
    node.childNodes.splice(index, 0, newChildNode);
    if (newChildNode.yogaNode) {
      node.yogaNode?.insertChild(newChildNode.yogaNode, index);
    }
  } else {
    node.childNodes.push(newChildNode);
    if (newChildNode.yogaNode) {
      node.yogaNode?.insertChild(newChildNode.yogaNode, node.yogaNode.getChildCount());
    }
  }
  if (node.nodeName === "ink-text" || node.nodeName === "ink-virtual-text") {
    markNodeAsDirty(node);
  }
}, "insertBeforeNode");
var removeChildNode = /* @__PURE__ */ __name((node, removeNode) => {
  if (removeNode.yogaNode) {
    removeNode.parentNode?.yogaNode?.removeChild(removeNode.yogaNode);
  }
  removeNode.parentNode = void 0;
  const index = node.childNodes.indexOf(removeNode);
  if (index >= 0) {
    node.childNodes.splice(index, 1);
  }
  if (node.nodeName === "ink-text" || node.nodeName === "ink-virtual-text") {
    markNodeAsDirty(node);
  }
}, "removeChildNode");
var setAttribute = /* @__PURE__ */ __name((node, key, value) => {
  if (key === "internal_accessibility") {
    node.internal_accessibility = value;
    return;
  }
  node.attributes[key] = value;
}, "setAttribute");
var setStyle = /* @__PURE__ */ __name((node, style) => {
  node.style = style ?? {};
}, "setStyle");
var createTextNode = /* @__PURE__ */ __name((text) => {
  const node = {
    nodeName: "#text",
    nodeValue: text,
    yogaNode: void 0,
    parentNode: void 0,
    style: {}
  };
  setTextNodeValue(node, text);
  return node;
}, "createTextNode");
var measureTextNode = /* @__PURE__ */ __name(function(node, width) {
  const text = node.nodeName === "#text" ? node.nodeValue : squash_text_nodes_default(node);
  const dimensions = measure_text_default(text);
  if (dimensions.width <= width) {
    return dimensions;
  }
  if (dimensions.width >= 1 && width > 0 && width < 1) {
    return dimensions;
  }
  const textWrap = node.style?.textWrap ?? "wrap";
  const wrappedText = wrap_text_default(text, width, textWrap);
  return measure_text_default(wrappedText);
}, "measureTextNode");
var findClosestYogaNode = /* @__PURE__ */ __name((node) => {
  if (!node?.parentNode) {
    return void 0;
  }
  return node.yogaNode ?? findClosestYogaNode(node.parentNode);
}, "findClosestYogaNode");
var markNodeAsDirty = /* @__PURE__ */ __name((node) => {
  const yogaNode = findClosestYogaNode(node);
  yogaNode?.markDirty();
}, "markNodeAsDirty");
var setTextNodeValue = /* @__PURE__ */ __name((node, text) => {
  if (typeof text !== "string") {
    text = String(text);
  }
  node.nodeValue = text;
  markNodeAsDirty(node);
}, "setTextNodeValue");
var addLayoutListener = /* @__PURE__ */ __name((rootNode, listener) => {
  if (rootNode.nodeName !== "ink-root") {
    return () => {
    };
  }
  rootNode.internal_layoutListeners ??= /* @__PURE__ */ new Set();
  rootNode.internal_layoutListeners.add(listener);
  return () => {
    rootNode.internal_layoutListeners?.delete(listener);
  };
}, "addLayoutListener");
var emitLayoutListeners = /* @__PURE__ */ __name((rootNode) => {
  if (rootNode.nodeName !== "ink-root" || !rootNode.internal_layoutListeners) {
    return;
  }
  for (const listener of rootNode.internal_layoutListeners) {
    listener();
  }
}, "emitLayoutListeners");

// node_modules/ink/build/styles.js
init_esbuild_shims();
var positionEdges = [
  ["top", src_default.EDGE_TOP],
  ["right", src_default.EDGE_RIGHT],
  ["bottom", src_default.EDGE_BOTTOM],
  ["left", src_default.EDGE_LEFT]
];
var applyPositionStyles = /* @__PURE__ */ __name((node, style) => {
  if ("position" in style) {
    let positionType = src_default.POSITION_TYPE_RELATIVE;
    if (style.position === "absolute") {
      positionType = src_default.POSITION_TYPE_ABSOLUTE;
    } else if (style.position === "static") {
      positionType = src_default.POSITION_TYPE_STATIC;
    }
    node.setPositionType(positionType);
  }
  for (const [property, edge] of positionEdges) {
    if (!(property in style)) {
      continue;
    }
    const value = style[property];
    if (typeof value === "string") {
      node.setPositionPercent(edge, Number.parseFloat(value));
      continue;
    }
    node.setPosition(edge, value);
  }
}, "applyPositionStyles");
var applyMarginStyles = /* @__PURE__ */ __name((node, style) => {
  if ("margin" in style) {
    node.setMargin(src_default.EDGE_ALL, style.margin ?? 0);
  }
  if ("marginX" in style) {
    node.setMargin(src_default.EDGE_HORIZONTAL, style.marginX ?? 0);
  }
  if ("marginY" in style) {
    node.setMargin(src_default.EDGE_VERTICAL, style.marginY ?? 0);
  }
  if ("marginLeft" in style) {
    node.setMargin(src_default.EDGE_START, style.marginLeft ?? 0);
  }
  if ("marginRight" in style) {
    node.setMargin(src_default.EDGE_END, style.marginRight ?? 0);
  }
  if ("marginTop" in style) {
    node.setMargin(src_default.EDGE_TOP, style.marginTop ?? 0);
  }
  if ("marginBottom" in style) {
    node.setMargin(src_default.EDGE_BOTTOM, style.marginBottom ?? 0);
  }
}, "applyMarginStyles");
var applyPaddingStyles = /* @__PURE__ */ __name((node, style) => {
  if ("padding" in style) {
    node.setPadding(src_default.EDGE_ALL, style.padding ?? 0);
  }
  if ("paddingX" in style) {
    node.setPadding(src_default.EDGE_HORIZONTAL, style.paddingX ?? 0);
  }
  if ("paddingY" in style) {
    node.setPadding(src_default.EDGE_VERTICAL, style.paddingY ?? 0);
  }
  if ("paddingLeft" in style) {
    node.setPadding(src_default.EDGE_LEFT, style.paddingLeft ?? 0);
  }
  if ("paddingRight" in style) {
    node.setPadding(src_default.EDGE_RIGHT, style.paddingRight ?? 0);
  }
  if ("paddingTop" in style) {
    node.setPadding(src_default.EDGE_TOP, style.paddingTop ?? 0);
  }
  if ("paddingBottom" in style) {
    node.setPadding(src_default.EDGE_BOTTOM, style.paddingBottom ?? 0);
  }
}, "applyPaddingStyles");
var applyFlexStyles = /* @__PURE__ */ __name((node, style) => {
  if ("flexGrow" in style) {
    node.setFlexGrow(style.flexGrow ?? 0);
  }
  if ("flexShrink" in style) {
    node.setFlexShrink(typeof style.flexShrink === "number" ? style.flexShrink : 1);
  }
  if ("flexWrap" in style) {
    if (style.flexWrap === "nowrap") {
      node.setFlexWrap(src_default.WRAP_NO_WRAP);
    }
    if (style.flexWrap === "wrap") {
      node.setFlexWrap(src_default.WRAP_WRAP);
    }
    if (style.flexWrap === "wrap-reverse") {
      node.setFlexWrap(src_default.WRAP_WRAP_REVERSE);
    }
  }
  if ("flexDirection" in style) {
    if (style.flexDirection === "row") {
      node.setFlexDirection(src_default.FLEX_DIRECTION_ROW);
    }
    if (style.flexDirection === "row-reverse") {
      node.setFlexDirection(src_default.FLEX_DIRECTION_ROW_REVERSE);
    }
    if (style.flexDirection === "column") {
      node.setFlexDirection(src_default.FLEX_DIRECTION_COLUMN);
    }
    if (style.flexDirection === "column-reverse") {
      node.setFlexDirection(src_default.FLEX_DIRECTION_COLUMN_REVERSE);
    }
  }
  if ("flexBasis" in style) {
    if (typeof style.flexBasis === "number") {
      node.setFlexBasis(style.flexBasis);
    } else if (typeof style.flexBasis === "string") {
      node.setFlexBasisPercent(Number.parseInt(style.flexBasis, 10));
    } else {
      node.setFlexBasisAuto();
    }
  }
  if ("alignItems" in style) {
    if (style.alignItems === "stretch" || !style.alignItems) {
      node.setAlignItems(src_default.ALIGN_STRETCH);
    }
    if (style.alignItems === "flex-start") {
      node.setAlignItems(src_default.ALIGN_FLEX_START);
    }
    if (style.alignItems === "center") {
      node.setAlignItems(src_default.ALIGN_CENTER);
    }
    if (style.alignItems === "flex-end") {
      node.setAlignItems(src_default.ALIGN_FLEX_END);
    }
    if (style.alignItems === "baseline") {
      node.setAlignItems(src_default.ALIGN_BASELINE);
    }
  }
  if ("alignSelf" in style) {
    if (style.alignSelf === "auto" || !style.alignSelf) {
      node.setAlignSelf(src_default.ALIGN_AUTO);
    }
    if (style.alignSelf === "flex-start") {
      node.setAlignSelf(src_default.ALIGN_FLEX_START);
    }
    if (style.alignSelf === "center") {
      node.setAlignSelf(src_default.ALIGN_CENTER);
    }
    if (style.alignSelf === "flex-end") {
      node.setAlignSelf(src_default.ALIGN_FLEX_END);
    }
    if (style.alignSelf === "stretch") {
      node.setAlignSelf(src_default.ALIGN_STRETCH);
    }
    if (style.alignSelf === "baseline") {
      node.setAlignSelf(src_default.ALIGN_BASELINE);
    }
  }
  if ("alignContent" in style) {
    if (style.alignContent === "flex-start" || !style.alignContent) {
      node.setAlignContent(src_default.ALIGN_FLEX_START);
    }
    if (style.alignContent === "center") {
      node.setAlignContent(src_default.ALIGN_CENTER);
    }
    if (style.alignContent === "flex-end") {
      node.setAlignContent(src_default.ALIGN_FLEX_END);
    }
    if (style.alignContent === "space-between") {
      node.setAlignContent(src_default.ALIGN_SPACE_BETWEEN);
    }
    if (style.alignContent === "space-around") {
      node.setAlignContent(src_default.ALIGN_SPACE_AROUND);
    }
    if (style.alignContent === "space-evenly") {
      node.setAlignContent(src_default.ALIGN_SPACE_EVENLY);
    }
    if (style.alignContent === "stretch") {
      node.setAlignContent(src_default.ALIGN_STRETCH);
    }
  }
  if ("justifyContent" in style) {
    if (style.justifyContent === "flex-start" || !style.justifyContent) {
      node.setJustifyContent(src_default.JUSTIFY_FLEX_START);
    }
    if (style.justifyContent === "center") {
      node.setJustifyContent(src_default.JUSTIFY_CENTER);
    }
    if (style.justifyContent === "flex-end") {
      node.setJustifyContent(src_default.JUSTIFY_FLEX_END);
    }
    if (style.justifyContent === "space-between") {
      node.setJustifyContent(src_default.JUSTIFY_SPACE_BETWEEN);
    }
    if (style.justifyContent === "space-around") {
      node.setJustifyContent(src_default.JUSTIFY_SPACE_AROUND);
    }
    if (style.justifyContent === "space-evenly") {
      node.setJustifyContent(src_default.JUSTIFY_SPACE_EVENLY);
    }
  }
}, "applyFlexStyles");
var applyDimensionStyles = /* @__PURE__ */ __name((node, style) => {
  if ("width" in style) {
    if (typeof style.width === "number") {
      node.setWidth(style.width);
    } else if (typeof style.width === "string") {
      node.setWidthPercent(Number.parseInt(style.width, 10));
    } else {
      node.setWidthAuto();
    }
  }
  if ("height" in style) {
    if (typeof style.height === "number") {
      node.setHeight(style.height);
    } else if (typeof style.height === "string") {
      node.setHeightPercent(Number.parseInt(style.height, 10));
    } else {
      node.setHeightAuto();
    }
  }
  if ("minWidth" in style) {
    if (typeof style.minWidth === "string") {
      node.setMinWidthPercent(Number.parseInt(style.minWidth, 10));
    } else {
      node.setMinWidth(style.minWidth ?? 0);
    }
  }
  if ("minHeight" in style) {
    if (typeof style.minHeight === "string") {
      node.setMinHeightPercent(Number.parseInt(style.minHeight, 10));
    } else {
      node.setMinHeight(style.minHeight ?? 0);
    }
  }
  if ("maxWidth" in style) {
    if (typeof style.maxWidth === "string") {
      node.setMaxWidthPercent(Number.parseInt(style.maxWidth, 10));
    } else {
      node.setMaxWidth(style.maxWidth);
    }
  }
  if ("maxHeight" in style) {
    if (typeof style.maxHeight === "string") {
      node.setMaxHeightPercent(Number.parseInt(style.maxHeight, 10));
    } else {
      node.setMaxHeight(style.maxHeight);
    }
  }
  if ("aspectRatio" in style) {
    node.setAspectRatio(style.aspectRatio);
  }
}, "applyDimensionStyles");
var applyDisplayStyles = /* @__PURE__ */ __name((node, style) => {
  if ("display" in style) {
    node.setDisplay(style.display === "flex" ? src_default.DISPLAY_FLEX : src_default.DISPLAY_NONE);
  }
}, "applyDisplayStyles");
var applyBorderStyles = /* @__PURE__ */ __name((node, style, currentStyle) => {
  const hasBorderChanges = "borderStyle" in style || "borderTop" in style || "borderBottom" in style || "borderLeft" in style || "borderRight" in style;
  if (!hasBorderChanges) {
    return;
  }
  const borderWidth = currentStyle.borderStyle ? 1 : 0;
  node.setBorder(src_default.EDGE_TOP, currentStyle.borderTop === false ? 0 : borderWidth);
  node.setBorder(src_default.EDGE_BOTTOM, currentStyle.borderBottom === false ? 0 : borderWidth);
  node.setBorder(src_default.EDGE_LEFT, currentStyle.borderLeft === false ? 0 : borderWidth);
  node.setBorder(src_default.EDGE_RIGHT, currentStyle.borderRight === false ? 0 : borderWidth);
}, "applyBorderStyles");
var applyGapStyles = /* @__PURE__ */ __name((node, style) => {
  if ("gap" in style) {
    node.setGap(src_default.GUTTER_ALL, style.gap ?? 0);
  }
  if ("columnGap" in style) {
    node.setGap(src_default.GUTTER_COLUMN, style.columnGap ?? 0);
  }
  if ("rowGap" in style) {
    node.setGap(src_default.GUTTER_ROW, style.rowGap ?? 0);
  }
}, "applyGapStyles");
var styles2 = /* @__PURE__ */ __name((node, style = {}, currentStyle = style) => {
  applyPositionStyles(node, style);
  applyMarginStyles(node, style);
  applyPaddingStyles(node, style);
  applyFlexStyles(node, style);
  applyDimensionStyles(node, style);
  applyDisplayStyles(node, style);
  applyBorderStyles(node, style, currentStyle);
  applyGapStyles(node, style);
}, "styles");
var styles_default = styles2;

// node_modules/ink/build/reconciler.js
if (process4.env["DEV"] === "true") {
  let isDevtoolsInstalled = false;
  try {
    import.meta.resolve("react-devtools-core");
    isDevtoolsInstalled = true;
  } catch {
  }
  if (isDevtoolsInstalled) {
    await import("./devtools-VDRJYPZF.js");
  }
}
var diff = /* @__PURE__ */ __name((before, after) => {
  if (before === after) {
    return;
  }
  if (!before) {
    return after;
  }
  const changed = {};
  let isChanged = false;
  for (const key of Object.keys(before)) {
    const isDeleted = after ? !Object.hasOwn(after, key) : true;
    if (isDeleted) {
      changed[key] = void 0;
      isChanged = true;
    }
  }
  if (after) {
    for (const key of Object.keys(after)) {
      if (after[key] !== before[key]) {
        changed[key] = after[key];
        isChanged = true;
      }
    }
  }
  return isChanged ? changed : void 0;
}, "diff");
var cleanupYogaNode = /* @__PURE__ */ __name((node) => {
  node?.unsetMeasureFunc();
  node?.freeRecursive();
}, "cleanupYogaNode");
var clearStaticNodeIfContained = /* @__PURE__ */ __name((removeNode) => {
  const staticNode = currentRootNode?.staticNode;
  if (!staticNode) {
    return;
  }
  let current = staticNode;
  while (current) {
    if (current === removeNode) {
      currentRootNode.staticNode = void 0;
      return;
    }
    current = current.parentNode;
  }
}, "clearStaticNodeIfContained");
var currentUpdatePriority = import_constants.NoEventPriority;
var currentRootNode;
async function loadPackageJson() {
  const fs3 = await import("node:fs");
  const content = fs3.readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const parsedContent = JSON.parse(content);
  return {
    name: parsedContent?.name,
    version: parsedContent?.version
  };
}
__name(loadPackageJson, "loadPackageJson");
var packageInfo = {
  name: "ink",
  version: import_react.version
};
if (process4.env["DEV"] === "true") {
  try {
    const loaded = await loadPackageJson();
    packageInfo = {
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      name: loaded.name || packageInfo.name,
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      version: loaded.version || packageInfo.version
    };
  } catch (error) {
    console.warn("Failed to load package.json in development mode. Falling back to default renderer metadata.", error);
  }
}
var reconciler_default = (0, import_react_reconciler.default)({
  getRootHostContext: /* @__PURE__ */ __name(() => ({
    isInsideText: false
  }), "getRootHostContext"),
  prepareForCommit: /* @__PURE__ */ __name(() => null, "prepareForCommit"),
  preparePortalMount: /* @__PURE__ */ __name(() => null, "preparePortalMount"),
  clearContainer: /* @__PURE__ */ __name(() => false, "clearContainer"),
  resetAfterCommit(rootNode) {
    if (typeof rootNode.onComputeLayout === "function") {
      rootNode.onComputeLayout();
    }
    emitLayoutListeners(rootNode);
    if (rootNode.staticNode !== rootNode.previousStaticNode) {
      rootNode.previousStaticNode = rootNode.staticNode;
      if (typeof rootNode.onStaticChange === "function") {
        rootNode.onStaticChange();
      }
    }
    if (rootNode.isStaticDirty) {
      rootNode.isStaticDirty = false;
      if (typeof rootNode.onImmediateRender === "function") {
        rootNode.onImmediateRender();
      }
      return;
    }
    if (typeof rootNode.onRender === "function") {
      rootNode.onRender();
    }
  },
  getChildHostContext(parentHostContext, type) {
    const previousIsInsideText = parentHostContext.isInsideText;
    const isInsideText = type === "ink-text" || type === "ink-virtual-text";
    if (previousIsInsideText === isInsideText) {
      return parentHostContext;
    }
    return { isInsideText };
  },
  shouldSetTextContent: /* @__PURE__ */ __name(() => false, "shouldSetTextContent"),
  createInstance(originalType, newProps, rootNode, hostContext) {
    if (hostContext.isInsideText && originalType === "ink-box") {
      throw new Error(`<Box> can\u2019t be nested inside <Text> component`);
    }
    const type = originalType === "ink-text" && hostContext.isInsideText ? "ink-virtual-text" : originalType;
    const node = createNode(type);
    for (const [key, value] of Object.entries(newProps)) {
      if (key === "children") {
        continue;
      }
      if (key === "style") {
        setStyle(node, value);
        if (node.yogaNode) {
          styles_default(node.yogaNode, value);
        }
        continue;
      }
      if (key === "internal_transform") {
        node.internal_transform = value;
        continue;
      }
      if (key === "internal_static") {
        currentRootNode = rootNode;
        node.internal_static = true;
        rootNode.isStaticDirty = true;
        rootNode.staticNode = node;
        continue;
      }
      setAttribute(node, key, value);
    }
    return node;
  },
  createTextInstance(text, _root, hostContext) {
    if (!hostContext.isInsideText) {
      throw new Error(`Text string "${text}" must be rendered inside <Text> component`);
    }
    return createTextNode(text);
  },
  resetTextContent() {
  },
  hideTextInstance(node) {
    setTextNodeValue(node, "");
  },
  unhideTextInstance(node, text) {
    setTextNodeValue(node, text);
  },
  getPublicInstance: /* @__PURE__ */ __name((instance) => instance, "getPublicInstance"),
  hideInstance(node) {
    node.yogaNode?.setDisplay(src_default.DISPLAY_NONE);
  },
  unhideInstance(node) {
    node.yogaNode?.setDisplay(src_default.DISPLAY_FLEX);
  },
  appendInitialChild: appendChildNode,
  appendChild: appendChildNode,
  insertBefore: insertBeforeNode,
  finalizeInitialChildren() {
    return false;
  },
  isPrimaryRenderer: true,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  // Scheduler integration for concurrent mode
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,
  // @ts-expect-error @types/react-reconciler is outdated and doesn't include scheduleCallback
  scheduleCallback: Scheduler.unstable_scheduleCallback,
  cancelCallback: Scheduler.unstable_cancelCallback,
  shouldYield: Scheduler.unstable_shouldYield,
  now: Scheduler.unstable_now,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  beforeActiveInstanceBlur() {
  },
  afterActiveInstanceBlur() {
  },
  detachDeletedInstance() {
  },
  getInstanceFromNode: /* @__PURE__ */ __name(() => null, "getInstanceFromNode"),
  prepareScopeUpdate() {
  },
  getInstanceFromScope: /* @__PURE__ */ __name(() => null, "getInstanceFromScope"),
  appendChildToContainer: appendChildNode,
  insertInContainerBefore: insertBeforeNode,
  removeChildFromContainer(node, removeNode) {
    clearStaticNodeIfContained(removeNode);
    removeChildNode(node, removeNode);
    cleanupYogaNode(removeNode.yogaNode);
    removeNode.yogaNode = void 0;
  },
  commitUpdate(node, _type, oldProps, newProps) {
    if (currentRootNode && node.internal_static) {
      currentRootNode.isStaticDirty = true;
    }
    const props = diff(oldProps, newProps);
    const style = diff(oldProps["style"], newProps["style"]);
    if (!props && !style) {
      return;
    }
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (key === "style") {
          setStyle(node, value);
          continue;
        }
        if (key === "internal_transform") {
          node.internal_transform = value;
          continue;
        }
        if (key === "internal_static") {
          node.internal_static = true;
          continue;
        }
        setAttribute(node, key, value);
      }
    }
    if (style && node.yogaNode) {
      styles_default(node.yogaNode, style, newProps["style"] ?? {});
    }
  },
  commitTextUpdate(node, _oldText, newText) {
    setTextNodeValue(node, newText);
  },
  removeChild(node, removeNode) {
    clearStaticNodeIfContained(removeNode);
    removeChildNode(node, removeNode);
    cleanupYogaNode(removeNode.yogaNode);
    removeNode.yogaNode = void 0;
  },
  setCurrentUpdatePriority(newPriority) {
    currentUpdatePriority = newPriority;
  },
  getCurrentUpdatePriority: /* @__PURE__ */ __name(() => currentUpdatePriority, "getCurrentUpdatePriority"),
  resolveUpdatePriority() {
    if (currentUpdatePriority !== import_constants.NoEventPriority) {
      return currentUpdatePriority;
    }
    return import_constants.DefaultEventPriority;
  },
  maySuspendCommit() {
    return true;
  },
  // eslint-disable-next-line @typescript-eslint/naming-convention
  NotPendingTransition: void 0,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  HostTransitionContext: (0, import_react.createContext)(null),
  resetFormInstance() {
  },
  requestPostPaintCallback() {
  },
  shouldAttemptEagerTransition() {
    return false;
  },
  trackSchedulerEvent() {
  },
  resolveEventType() {
    return null;
  },
  resolveEventTimeStamp() {
    return -1.1;
  },
  preloadInstance() {
    return true;
  },
  startSuspendingCommit() {
  },
  suspendInstance() {
  },
  waitForCommitToBeReady() {
    return null;
  },
  rendererPackageName: packageInfo.name,
  rendererVersion: packageInfo.version
});

// node_modules/ink/build/renderer.js
init_esbuild_shims();

// node_modules/ink/build/render-node-to-output.js
init_esbuild_shims();

// node_modules/ink/build/get-max-width.js
init_esbuild_shims();
var getMaxWidth = /* @__PURE__ */ __name((yogaNode) => {
  return yogaNode.getComputedWidth() - yogaNode.getComputedPadding(src_default.EDGE_LEFT) - yogaNode.getComputedPadding(src_default.EDGE_RIGHT) - yogaNode.getComputedBorder(src_default.EDGE_LEFT) - yogaNode.getComputedBorder(src_default.EDGE_RIGHT);
}, "getMaxWidth");
var get_max_width_default = getMaxWidth;

// node_modules/ink/build/render-border.js
init_esbuild_shims();

// node_modules/ink/node_modules/cli-boxes/index.js
init_esbuild_shims();

// node_modules/ink/node_modules/cli-boxes/boxes.json
var boxes_default = {
  single: {
    topLeft: "\u250C",
    top: "\u2500",
    topRight: "\u2510",
    right: "\u2502",
    bottomRight: "\u2518",
    bottom: "\u2500",
    bottomLeft: "\u2514",
    left: "\u2502"
  },
  double: {
    topLeft: "\u2554",
    top: "\u2550",
    topRight: "\u2557",
    right: "\u2551",
    bottomRight: "\u255D",
    bottom: "\u2550",
    bottomLeft: "\u255A",
    left: "\u2551"
  },
  round: {
    topLeft: "\u256D",
    top: "\u2500",
    topRight: "\u256E",
    right: "\u2502",
    bottomRight: "\u256F",
    bottom: "\u2500",
    bottomLeft: "\u2570",
    left: "\u2502"
  },
  bold: {
    topLeft: "\u250F",
    top: "\u2501",
    topRight: "\u2513",
    right: "\u2503",
    bottomRight: "\u251B",
    bottom: "\u2501",
    bottomLeft: "\u2517",
    left: "\u2503"
  },
  singleDouble: {
    topLeft: "\u2553",
    top: "\u2500",
    topRight: "\u2556",
    right: "\u2551",
    bottomRight: "\u255C",
    bottom: "\u2500",
    bottomLeft: "\u2559",
    left: "\u2551"
  },
  doubleSingle: {
    topLeft: "\u2552",
    top: "\u2550",
    topRight: "\u2555",
    right: "\u2502",
    bottomRight: "\u255B",
    bottom: "\u2550",
    bottomLeft: "\u2558",
    left: "\u2502"
  },
  classic: {
    topLeft: "+",
    top: "-",
    topRight: "+",
    right: "|",
    bottomRight: "+",
    bottom: "-",
    bottomLeft: "+",
    left: "|"
  },
  arrow: {
    topLeft: "\u2198",
    top: "\u2193",
    topRight: "\u2199",
    right: "\u2190",
    bottomRight: "\u2196",
    bottom: "\u2191",
    bottomLeft: "\u2197",
    left: "\u2192"
  }
};

// node_modules/ink/node_modules/cli-boxes/index.js
var cli_boxes_default = boxes_default;

// node_modules/ink/node_modules/chalk/source/index.js
init_esbuild_shims();

// node_modules/ink/node_modules/chalk/source/vendor/ansi-styles/index.js
init_esbuild_shims();
var ANSI_BACKGROUND_OFFSET2 = 10;
var wrapAnsi162 = /* @__PURE__ */ __name((offset = 0) => (code) => `\x1B[${code + offset}m`, "wrapAnsi16");
var wrapAnsi2562 = /* @__PURE__ */ __name((offset = 0) => (code) => `\x1B[${38 + offset};5;${code}m`, "wrapAnsi256");
var wrapAnsi16m2 = /* @__PURE__ */ __name((offset = 0) => (red, green, blue) => `\x1B[${38 + offset};2;${red};${green};${blue}m`, "wrapAnsi16m");
var styles3 = {
  modifier: {
    reset: [0, 0],
    // 21 isn't widely supported and 22 does the same thing
    bold: [1, 22],
    dim: [2, 22],
    italic: [3, 23],
    underline: [4, 24],
    overline: [53, 55],
    inverse: [7, 27],
    hidden: [8, 28],
    strikethrough: [9, 29]
  },
  color: {
    black: [30, 39],
    red: [31, 39],
    green: [32, 39],
    yellow: [33, 39],
    blue: [34, 39],
    magenta: [35, 39],
    cyan: [36, 39],
    white: [37, 39],
    // Bright color
    blackBright: [90, 39],
    gray: [90, 39],
    // Alias of `blackBright`
    grey: [90, 39],
    // Alias of `blackBright`
    redBright: [91, 39],
    greenBright: [92, 39],
    yellowBright: [93, 39],
    blueBright: [94, 39],
    magentaBright: [95, 39],
    cyanBright: [96, 39],
    whiteBright: [97, 39]
  },
  bgColor: {
    bgBlack: [40, 49],
    bgRed: [41, 49],
    bgGreen: [42, 49],
    bgYellow: [43, 49],
    bgBlue: [44, 49],
    bgMagenta: [45, 49],
    bgCyan: [46, 49],
    bgWhite: [47, 49],
    // Bright color
    bgBlackBright: [100, 49],
    bgGray: [100, 49],
    // Alias of `bgBlackBright`
    bgGrey: [100, 49],
    // Alias of `bgBlackBright`
    bgRedBright: [101, 49],
    bgGreenBright: [102, 49],
    bgYellowBright: [103, 49],
    bgBlueBright: [104, 49],
    bgMagentaBright: [105, 49],
    bgCyanBright: [106, 49],
    bgWhiteBright: [107, 49]
  }
};
var modifierNames2 = Object.keys(styles3.modifier);
var foregroundColorNames2 = Object.keys(styles3.color);
var backgroundColorNames2 = Object.keys(styles3.bgColor);
var colorNames2 = [...foregroundColorNames2, ...backgroundColorNames2];
function assembleStyles2() {
  const codes = /* @__PURE__ */ new Map();
  for (const [groupName, group] of Object.entries(styles3)) {
    for (const [styleName, style] of Object.entries(group)) {
      styles3[styleName] = {
        open: `\x1B[${style[0]}m`,
        close: `\x1B[${style[1]}m`
      };
      group[styleName] = styles3[styleName];
      codes.set(style[0], style[1]);
    }
    Object.defineProperty(styles3, groupName, {
      value: group,
      enumerable: false
    });
  }
  Object.defineProperty(styles3, "codes", {
    value: codes,
    enumerable: false
  });
  styles3.color.close = "\x1B[39m";
  styles3.bgColor.close = "\x1B[49m";
  styles3.color.ansi = wrapAnsi162();
  styles3.color.ansi256 = wrapAnsi2562();
  styles3.color.ansi16m = wrapAnsi16m2();
  styles3.bgColor.ansi = wrapAnsi162(ANSI_BACKGROUND_OFFSET2);
  styles3.bgColor.ansi256 = wrapAnsi2562(ANSI_BACKGROUND_OFFSET2);
  styles3.bgColor.ansi16m = wrapAnsi16m2(ANSI_BACKGROUND_OFFSET2);
  Object.defineProperties(styles3, {
    rgbToAnsi256: {
      value(red, green, blue) {
        if (red === green && green === blue) {
          if (red < 8) {
            return 16;
          }
          if (red > 248) {
            return 231;
          }
          return Math.round((red - 8) / 247 * 24) + 232;
        }
        return 16 + 36 * Math.round(red / 255 * 5) + 6 * Math.round(green / 255 * 5) + Math.round(blue / 255 * 5);
      },
      enumerable: false
    },
    hexToRgb: {
      value(hex) {
        const matches = /[a-f\d]{6}|[a-f\d]{3}/i.exec(hex.toString(16));
        if (!matches) {
          return [0, 0, 0];
        }
        let [colorString] = matches;
        if (colorString.length === 3) {
          colorString = [...colorString].map((character) => character + character).join("");
        }
        const integer = Number.parseInt(colorString, 16);
        return [
          /* eslint-disable no-bitwise */
          integer >> 16 & 255,
          integer >> 8 & 255,
          integer & 255
          /* eslint-enable no-bitwise */
        ];
      },
      enumerable: false
    },
    hexToAnsi256: {
      value: /* @__PURE__ */ __name((hex) => styles3.rgbToAnsi256(...styles3.hexToRgb(hex)), "value"),
      enumerable: false
    },
    ansi256ToAnsi: {
      value(code) {
        if (code < 8) {
          return 30 + code;
        }
        if (code < 16) {
          return 90 + (code - 8);
        }
        let red;
        let green;
        let blue;
        if (code >= 232) {
          red = ((code - 232) * 10 + 8) / 255;
          green = red;
          blue = red;
        } else {
          code -= 16;
          const remainder = code % 36;
          red = Math.floor(code / 36) / 5;
          green = Math.floor(remainder / 6) / 5;
          blue = remainder % 6 / 5;
        }
        const value = Math.max(red, green, blue) * 2;
        if (value === 0) {
          return 30;
        }
        let result = 30 + (Math.round(blue) << 2 | Math.round(green) << 1 | Math.round(red));
        if (value === 2) {
          result += 60;
        }
        return result;
      },
      enumerable: false
    },
    rgbToAnsi: {
      value: /* @__PURE__ */ __name((red, green, blue) => styles3.ansi256ToAnsi(styles3.rgbToAnsi256(red, green, blue)), "value"),
      enumerable: false
    },
    hexToAnsi: {
      value: /* @__PURE__ */ __name((hex) => styles3.ansi256ToAnsi(styles3.hexToAnsi256(hex)), "value"),
      enumerable: false
    }
  });
  return styles3;
}
__name(assembleStyles2, "assembleStyles");
var ansiStyles2 = assembleStyles2();
var ansi_styles_default2 = ansiStyles2;

// node_modules/ink/node_modules/chalk/source/vendor/supports-color/index.js
init_esbuild_shims();
import process5 from "node:process";
import os2 from "node:os";
import tty2 from "node:tty";
function hasFlag(flag, argv = globalThis.Deno ? globalThis.Deno.args : process5.argv) {
  const prefix = flag.startsWith("-") ? "" : flag.length === 1 ? "-" : "--";
  const position = argv.indexOf(prefix + flag);
  const terminatorPosition = argv.indexOf("--");
  return position !== -1 && (terminatorPosition === -1 || position < terminatorPosition);
}
__name(hasFlag, "hasFlag");
var { env } = process5;
var flagForceColor;
if (hasFlag("no-color") || hasFlag("no-colors") || hasFlag("color=false") || hasFlag("color=never")) {
  flagForceColor = 0;
} else if (hasFlag("color") || hasFlag("colors") || hasFlag("color=true") || hasFlag("color=always")) {
  flagForceColor = 1;
}
function envForceColor() {
  if ("FORCE_COLOR" in env) {
    if (env.FORCE_COLOR === "true") {
      return 1;
    }
    if (env.FORCE_COLOR === "false") {
      return 0;
    }
    return env.FORCE_COLOR.length === 0 ? 1 : Math.min(Number.parseInt(env.FORCE_COLOR, 10), 3);
  }
}
__name(envForceColor, "envForceColor");
function translateLevel(level) {
  if (level === 0) {
    return false;
  }
  return {
    level,
    hasBasic: true,
    has256: level >= 2,
    has16m: level >= 3
  };
}
__name(translateLevel, "translateLevel");
function _supportsColor(haveStream, { streamIsTTY, sniffFlags = true } = {}) {
  const noFlagForceColor = envForceColor();
  if (noFlagForceColor !== void 0) {
    flagForceColor = noFlagForceColor;
  }
  const forceColor = sniffFlags ? flagForceColor : noFlagForceColor;
  if (forceColor === 0) {
    return 0;
  }
  if (sniffFlags) {
    if (hasFlag("color=16m") || hasFlag("color=full") || hasFlag("color=truecolor")) {
      return 3;
    }
    if (hasFlag("color=256")) {
      return 2;
    }
  }
  if ("TF_BUILD" in env && "AGENT_NAME" in env) {
    return 1;
  }
  if (haveStream && !streamIsTTY && forceColor === void 0) {
    return 0;
  }
  const min = forceColor || 0;
  if (env.TERM === "dumb") {
    return min;
  }
  if (process5.platform === "win32") {
    const osRelease = os2.release().split(".");
    if (Number(osRelease[0]) >= 10 && Number(osRelease[2]) >= 10586) {
      return Number(osRelease[2]) >= 14931 ? 3 : 2;
    }
    return 1;
  }
  if ("CI" in env) {
    if (["GITHUB_ACTIONS", "GITEA_ACTIONS", "CIRCLECI"].some((key) => key in env)) {
      return 3;
    }
    if (["TRAVIS", "APPVEYOR", "GITLAB_CI", "BUILDKITE", "DRONE"].some((sign) => sign in env) || env.CI_NAME === "codeship") {
      return 1;
    }
    return min;
  }
  if ("TEAMCITY_VERSION" in env) {
    return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env.TEAMCITY_VERSION) ? 1 : 0;
  }
  if (env.COLORTERM === "truecolor") {
    return 3;
  }
  if (env.TERM === "xterm-kitty") {
    return 3;
  }
  if (env.TERM === "xterm-ghostty") {
    return 3;
  }
  if (env.TERM === "wezterm") {
    return 3;
  }
  if ("TERM_PROGRAM" in env) {
    const version = Number.parseInt((env.TERM_PROGRAM_VERSION || "").split(".")[0], 10);
    switch (env.TERM_PROGRAM) {
      case "iTerm.app": {
        return version >= 3 ? 3 : 2;
      }
      case "Apple_Terminal": {
        return 2;
      }
    }
  }
  if (/-256(color)?$/i.test(env.TERM)) {
    return 2;
  }
  if (/^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(env.TERM)) {
    return 1;
  }
  if ("COLORTERM" in env) {
    return 1;
  }
  return min;
}
__name(_supportsColor, "_supportsColor");
function createSupportsColor(stream, options = {}) {
  const level = _supportsColor(stream, {
    streamIsTTY: stream && stream.isTTY,
    ...options
  });
  return translateLevel(level);
}
__name(createSupportsColor, "createSupportsColor");
var supportsColor = {
  stdout: createSupportsColor({ isTTY: tty2.isatty(1) }),
  stderr: createSupportsColor({ isTTY: tty2.isatty(2) })
};
var supports_color_default = supportsColor;

// node_modules/ink/node_modules/chalk/source/utilities.js
init_esbuild_shims();
function stringReplaceAll(string, substring, replacer) {
  let index = string.indexOf(substring);
  if (index === -1) {
    return string;
  }
  const substringLength = substring.length;
  let endIndex = 0;
  let returnValue = "";
  do {
    returnValue += string.slice(endIndex, index) + substring + replacer;
    endIndex = index + substringLength;
    index = string.indexOf(substring, endIndex);
  } while (index !== -1);
  returnValue += string.slice(endIndex);
  return returnValue;
}
__name(stringReplaceAll, "stringReplaceAll");
function stringEncaseCRLFWithFirstIndex(string, prefix, postfix, index) {
  let endIndex = 0;
  let returnValue = "";
  do {
    const gotCR = string[index - 1] === "\r";
    returnValue += string.slice(endIndex, gotCR ? index - 1 : index) + prefix + (gotCR ? "\r\n" : "\n") + postfix;
    endIndex = index + 1;
    index = string.indexOf("\n", endIndex);
  } while (index !== -1);
  returnValue += string.slice(endIndex);
  return returnValue;
}
__name(stringEncaseCRLFWithFirstIndex, "stringEncaseCRLFWithFirstIndex");

// node_modules/ink/node_modules/chalk/source/index.js
var { stdout: stdoutColor, stderr: stderrColor } = supports_color_default;
var GENERATOR = Symbol("GENERATOR");
var STYLER = Symbol("STYLER");
var IS_EMPTY = Symbol("IS_EMPTY");
var levelMapping = [
  "ansi",
  "ansi",
  "ansi256",
  "ansi16m"
];
var styles4 = /* @__PURE__ */ Object.create(null);
var applyOptions = /* @__PURE__ */ __name((object, options = {}) => {
  if (options.level && !(Number.isInteger(options.level) && options.level >= 0 && options.level <= 3)) {
    throw new Error("The `level` option should be an integer from 0 to 3");
  }
  const colorLevel = stdoutColor ? stdoutColor.level : 0;
  object.level = options.level === void 0 ? colorLevel : options.level;
}, "applyOptions");
var chalkFactory = /* @__PURE__ */ __name((options) => {
  const chalk2 = /* @__PURE__ */ __name((...strings) => strings.join(" "), "chalk");
  applyOptions(chalk2, options);
  Object.setPrototypeOf(chalk2, createChalk.prototype);
  return chalk2;
}, "chalkFactory");
function createChalk(options) {
  return chalkFactory(options);
}
__name(createChalk, "createChalk");
Object.setPrototypeOf(createChalk.prototype, Function.prototype);
for (const [styleName, style] of Object.entries(ansi_styles_default2)) {
  styles4[styleName] = {
    get() {
      const builder = createBuilder(this, createStyler(style.open, style.close, this[STYLER]), this[IS_EMPTY]);
      Object.defineProperty(this, styleName, { value: builder });
      return builder;
    }
  };
}
styles4.visible = {
  get() {
    const builder = createBuilder(this, this[STYLER], true);
    Object.defineProperty(this, "visible", { value: builder });
    return builder;
  }
};
var getModelAnsi = /* @__PURE__ */ __name((model, level, type, ...arguments_) => {
  if (model === "rgb") {
    if (level === "ansi16m") {
      return ansi_styles_default2[type].ansi16m(...arguments_);
    }
    if (level === "ansi256") {
      return ansi_styles_default2[type].ansi256(ansi_styles_default2.rgbToAnsi256(...arguments_));
    }
    return ansi_styles_default2[type].ansi(ansi_styles_default2.rgbToAnsi(...arguments_));
  }
  if (model === "hex") {
    return getModelAnsi("rgb", level, type, ...ansi_styles_default2.hexToRgb(...arguments_));
  }
  return ansi_styles_default2[type][model](...arguments_);
}, "getModelAnsi");
var usedModels = ["rgb", "hex", "ansi256"];
for (const model of usedModels) {
  styles4[model] = {
    get() {
      const { level } = this;
      return function(...arguments_) {
        const styler = createStyler(getModelAnsi(model, levelMapping[level], "color", ...arguments_), ansi_styles_default2.color.close, this[STYLER]);
        return createBuilder(this, styler, this[IS_EMPTY]);
      };
    }
  };
  const bgModel = "bg" + model[0].toUpperCase() + model.slice(1);
  styles4[bgModel] = {
    get() {
      const { level } = this;
      return function(...arguments_) {
        const styler = createStyler(getModelAnsi(model, levelMapping[level], "bgColor", ...arguments_), ansi_styles_default2.bgColor.close, this[STYLER]);
        return createBuilder(this, styler, this[IS_EMPTY]);
      };
    }
  };
}
var proto = Object.defineProperties(() => {
}, {
  ...styles4,
  level: {
    enumerable: true,
    get() {
      return this[GENERATOR].level;
    },
    set(level) {
      this[GENERATOR].level = level;
    }
  }
});
var createStyler = /* @__PURE__ */ __name((open, close, parent) => {
  let openAll;
  let closeAll;
  if (parent === void 0) {
    openAll = open;
    closeAll = close;
  } else {
    openAll = parent.openAll + open;
    closeAll = close + parent.closeAll;
  }
  return {
    open,
    close,
    openAll,
    closeAll,
    parent
  };
}, "createStyler");
var createBuilder = /* @__PURE__ */ __name((self, _styler, _isEmpty) => {
  const builder = /* @__PURE__ */ __name((...arguments_) => applyStyle(builder, arguments_.length === 1 ? "" + arguments_[0] : arguments_.join(" ")), "builder");
  Object.setPrototypeOf(builder, proto);
  builder[GENERATOR] = self;
  builder[STYLER] = _styler;
  builder[IS_EMPTY] = _isEmpty;
  return builder;
}, "createBuilder");
var applyStyle = /* @__PURE__ */ __name((self, string) => {
  if (self.level <= 0 || !string) {
    return self[IS_EMPTY] ? "" : string;
  }
  let styler = self[STYLER];
  if (styler === void 0) {
    return string;
  }
  const { openAll, closeAll } = styler;
  if (string.includes("\x1B")) {
    while (styler !== void 0) {
      string = stringReplaceAll(string, styler.close, styler.open);
      styler = styler.parent;
    }
  }
  const lfIndex = string.indexOf("\n");
  if (lfIndex !== -1) {
    string = stringEncaseCRLFWithFirstIndex(string, closeAll, openAll, lfIndex);
  }
  return openAll + string + closeAll;
}, "applyStyle");
Object.defineProperties(createChalk.prototype, styles4);
var chalk = createChalk();
var chalkStderr = createChalk({ level: stderrColor ? stderrColor.level : 0 });
var source_default = chalk;

// node_modules/ink/build/colorize.js
init_esbuild_shims();
var rgbRegex = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/;
var ansiRegex = /^ansi256\(\s?(\d+)\s?\)$/;
var isNamedColor = /* @__PURE__ */ __name((color) => {
  return color in source_default;
}, "isNamedColor");
var colorize = /* @__PURE__ */ __name((str, color, type) => {
  if (!color) {
    return str;
  }
  if (isNamedColor(color)) {
    if (type === "foreground") {
      return source_default[color](str);
    }
    const methodName = `bg${color[0].toUpperCase() + color.slice(1)}`;
    return source_default[methodName](str);
  }
  if (color.startsWith("#")) {
    return type === "foreground" ? source_default.hex(color)(str) : source_default.bgHex(color)(str);
  }
  if (color.startsWith("ansi256")) {
    const matches = ansiRegex.exec(color);
    if (!matches) {
      return str;
    }
    const value = Number(matches[1]);
    return type === "foreground" ? source_default.ansi256(value)(str) : source_default.bgAnsi256(value)(str);
  }
  if (color.startsWith("rgb")) {
    const matches = rgbRegex.exec(color);
    if (!matches) {
      return str;
    }
    const firstValue = Number(matches[1]);
    const secondValue = Number(matches[2]);
    const thirdValue = Number(matches[3]);
    return type === "foreground" ? source_default.rgb(firstValue, secondValue, thirdValue)(str) : source_default.bgRgb(firstValue, secondValue, thirdValue)(str);
  }
  return str;
}, "colorize");
var colorize_default = colorize;

// node_modules/ink/build/render-border.js
var stylePiece = /* @__PURE__ */ __name((segment, fg, bg, dim) => {
  let styled = colorize_default(segment, fg, "foreground");
  styled = colorize_default(styled, bg, "background");
  if (dim) {
    styled = source_default.dim(styled);
  }
  return styled;
}, "stylePiece");
var renderBorder = /* @__PURE__ */ __name((x, y, node, output) => {
  if (node.style.borderStyle) {
    const width = node.yogaNode.getComputedWidth();
    const height = node.yogaNode.getComputedHeight();
    const box = typeof node.style.borderStyle === "string" ? cli_boxes_default[node.style.borderStyle] : node.style.borderStyle;
    const topBorderColor = node.style.borderTopColor ?? node.style.borderColor;
    const bottomBorderColor = node.style.borderBottomColor ?? node.style.borderColor;
    const leftBorderColor = node.style.borderLeftColor ?? node.style.borderColor;
    const rightBorderColor = node.style.borderRightColor ?? node.style.borderColor;
    const topBorderBackgroundColor = node.style.borderTopBackgroundColor ?? node.style.borderBackgroundColor;
    const bottomBorderBackgroundColor = node.style.borderBottomBackgroundColor ?? node.style.borderBackgroundColor;
    const leftBorderBackgroundColor = node.style.borderLeftBackgroundColor ?? node.style.borderBackgroundColor;
    const rightBorderBackgroundColor = node.style.borderRightBackgroundColor ?? node.style.borderBackgroundColor;
    const dimTopBorderColor = node.style.borderTopDimColor ?? node.style.borderDimColor;
    const dimBottomBorderColor = node.style.borderBottomDimColor ?? node.style.borderDimColor;
    const dimLeftBorderColor = node.style.borderLeftDimColor ?? node.style.borderDimColor;
    const dimRightBorderColor = node.style.borderRightDimColor ?? node.style.borderDimColor;
    const showTopBorder = node.style.borderTop !== false;
    const showBottomBorder = node.style.borderBottom !== false;
    const showLeftBorder = node.style.borderLeft !== false;
    const showRightBorder = node.style.borderRight !== false;
    const contentWidth = width - (showLeftBorder ? 1 : 0) - (showRightBorder ? 1 : 0);
    let topBorder = showTopBorder ? (showLeftBorder ? box.topLeft : "") + box.top.repeat(contentWidth) + (showRightBorder ? box.topRight : "") : void 0;
    topBorder &&= stylePiece(topBorder, topBorderColor, topBorderBackgroundColor, dimTopBorderColor);
    let verticalBorderHeight = height;
    if (showTopBorder) {
      verticalBorderHeight -= 1;
    }
    if (showBottomBorder) {
      verticalBorderHeight -= 1;
    }
    let leftBorder = "";
    if (showLeftBorder) {
      const one = stylePiece(box.left, leftBorderColor, leftBorderBackgroundColor, dimLeftBorderColor);
      leftBorder = (one + "\n").repeat(verticalBorderHeight);
    }
    let rightBorder = "";
    if (showRightBorder) {
      const one = stylePiece(box.right, rightBorderColor, rightBorderBackgroundColor, dimRightBorderColor);
      rightBorder = (one + "\n").repeat(verticalBorderHeight);
    }
    let bottomBorder = showBottomBorder ? (showLeftBorder ? box.bottomLeft : "") + box.bottom.repeat(contentWidth) + (showRightBorder ? box.bottomRight : "") : void 0;
    bottomBorder &&= stylePiece(bottomBorder, bottomBorderColor, bottomBorderBackgroundColor, dimBottomBorderColor);
    const offsetY = showTopBorder ? 1 : 0;
    if (topBorder) {
      output.write(x, y, topBorder, { transformers: [] });
    }
    if (leftBorder) {
      output.write(x, y + offsetY, leftBorder, { transformers: [] });
    }
    if (rightBorder) {
      output.write(x + width - 1, y + offsetY, rightBorder, {
        transformers: []
      });
    }
    if (bottomBorder) {
      output.write(x, y + height - 1, bottomBorder, { transformers: [] });
    }
  }
}, "renderBorder");
var render_border_default = renderBorder;

// node_modules/ink/build/render-background.js
init_esbuild_shims();
var renderBackground = /* @__PURE__ */ __name((x, y, node, output) => {
  if (!node.style.backgroundColor) {
    return;
  }
  const width = node.yogaNode.getComputedWidth();
  const height = node.yogaNode.getComputedHeight();
  const leftBorderWidth = node.style.borderStyle && node.style.borderLeft !== false ? 1 : 0;
  const rightBorderWidth = node.style.borderStyle && node.style.borderRight !== false ? 1 : 0;
  const topBorderHeight = node.style.borderStyle && node.style.borderTop !== false ? 1 : 0;
  const bottomBorderHeight = node.style.borderStyle && node.style.borderBottom !== false ? 1 : 0;
  const contentWidth = width - leftBorderWidth - rightBorderWidth;
  const contentHeight = height - topBorderHeight - bottomBorderHeight;
  if (!(contentWidth > 0 && contentHeight > 0)) {
    return;
  }
  const backgroundLine = colorize_default(" ".repeat(contentWidth), node.style.backgroundColor, "background");
  for (let row = 0; row < contentHeight; row++) {
    output.write(x + leftBorderWidth, y + topBorderHeight + row, backgroundLine, {
      transformers: [],
      selectable: false
    });
  }
}, "renderBackground");
var render_background_default = renderBackground;

// node_modules/ink/build/render-node-to-output.js
var getTextOffset = /* @__PURE__ */ __name((node) => {
  const yogaNode = node.childNodes[0]?.yogaNode;
  if (yogaNode) {
    return {
      x: yogaNode.getComputedLeft(),
      y: yogaNode.getComputedTop()
    };
  }
  return { x: 0, y: 0 };
}, "getTextOffset");
var renderNodeToScreenReaderOutput = /* @__PURE__ */ __name((node, options = {}) => {
  if (options.skipStaticElements && node.internal_static) {
    return "";
  }
  if (node.yogaNode?.getDisplay() === src_default.DISPLAY_NONE) {
    return "";
  }
  let output = "";
  if (node.nodeName === "ink-text") {
    output = squash_text_nodes_default(node);
  } else if (node.nodeName === "ink-box" || node.nodeName === "ink-root") {
    const separator = node.style.flexDirection === "row" || node.style.flexDirection === "row-reverse" ? " " : "\n";
    const childNodes = node.style.flexDirection === "row-reverse" || node.style.flexDirection === "column-reverse" ? [...node.childNodes].reverse() : [...node.childNodes];
    output = childNodes.map((childNode) => {
      const screenReaderOutput = renderNodeToScreenReaderOutput(childNode, {
        parentRole: node.internal_accessibility?.role,
        skipStaticElements: options.skipStaticElements
      });
      return screenReaderOutput;
    }).filter(Boolean).join(separator);
  }
  if (node.internal_accessibility) {
    const { role, state } = node.internal_accessibility;
    if (state) {
      const stateKeys = Object.keys(state);
      const stateDescription = stateKeys.filter((key) => state[key]).join(", ");
      if (stateDescription) {
        output = `(${stateDescription}) ${output}`;
      }
    }
    if (role && role !== options.parentRole) {
      output = `${role}: ${output}`;
    }
  }
  return output;
}, "renderNodeToScreenReaderOutput");
var renderNodeToOutput = /* @__PURE__ */ __name((node, output, options) => {
  const { offsetX = 0, offsetY = 0, transformers = [], skipStaticElements, flowIds, nextFlowId } = options;
  if (skipStaticElements && node.internal_static) {
    return;
  }
  const { yogaNode } = node;
  if (yogaNode) {
    if (yogaNode.getDisplay() === src_default.DISPLAY_NONE) {
      return;
    }
    const x = offsetX + yogaNode.getComputedLeft();
    const y = offsetY + yogaNode.getComputedTop();
    let newTransformers = transformers;
    if (typeof node.internal_transform === "function") {
      newTransformers = [node.internal_transform, ...transformers];
    }
    if (node.nodeName === "ink-text") {
      const sourceText = squash_text_nodes_default(node);
      if (sourceText.length > 0) {
        const maxWidth = get_max_width_default(yogaNode);
        const textWrap = node.style.textWrap ?? "wrap";
        const wrapped = wrapTextWithMetadata(sourceText, maxWidth, textWrap, widestLine(sourceText) > maxWidth);
        const flowKey = node.attributes.selectionFlow ?? node;
        let flowId = flowIds.get(flowKey);
        if (flowId === void 0) {
          flowId = nextFlowId.value++;
          flowIds.set(flowKey, flowId);
        }
        const boundaries = [...wrapped.boundaries];
        const breakAfter = node.attributes.selectionBreakAfter;
        boundaries.push(breakAfter === "soft" || breakAfter === "hard" ? {
          kind: breakAfter,
          joiner: typeof node.attributes.selectionJoiner === "string" ? node.attributes.selectionJoiner : breakAfter === "hard" ? "\n" : ""
        } : null);
        const textOffset = getTextOffset(node);
        if (textOffset.x > 0) {
          const padding = wrapped.text.split("\n").map((line) => line.length > 0 ? " ".repeat(textOffset.x) : "").join("\n");
          output.write(x, y + textOffset.y, padding, {
            transformers: newTransformers,
            semantic: {
              flowId,
              selectable: false,
              selectableRows: wrapped.selectableRows.map(() => false),
              boundaries: wrapped.boundaries.map(() => null)
            }
          });
        }
        output.write(x + textOffset.x, y + textOffset.y, wrapped.text, {
          transformers: newTransformers,
          semantic: {
            flowId,
            selectable: node.attributes.selectable !== false,
            selectableRows: wrapped.selectableRows,
            boundaries
          }
        });
      }
      return;
    }
    let clipped = false;
    if (node.nodeName === "ink-box") {
      render_background_default(x, y, node, output);
      render_border_default(x, y, node, output);
      const clipHorizontally = node.style.overflowX === "hidden" || node.style.overflow === "hidden";
      const clipVertically = node.style.overflowY === "hidden" || node.style.overflow === "hidden";
      if (clipHorizontally || clipVertically) {
        const x1 = clipHorizontally ? x + yogaNode.getComputedBorder(src_default.EDGE_LEFT) : void 0;
        const x2 = clipHorizontally ? x + yogaNode.getComputedWidth() - yogaNode.getComputedBorder(src_default.EDGE_RIGHT) : void 0;
        const y1 = clipVertically ? y + yogaNode.getComputedBorder(src_default.EDGE_TOP) : void 0;
        const y2 = clipVertically ? y + yogaNode.getComputedHeight() - yogaNode.getComputedBorder(src_default.EDGE_BOTTOM) : void 0;
        output.clip({ x1, x2, y1, y2 });
        clipped = true;
      }
    }
    if (node.nodeName === "ink-root" || node.nodeName === "ink-box") {
      for (const childNode of node.childNodes) {
        renderNodeToOutput(childNode, output, {
          offsetX: x,
          offsetY: y,
          transformers: newTransformers,
          skipStaticElements,
          flowIds,
          nextFlowId
        });
      }
      if (clipped) {
        output.unclip();
      }
    }
  }
}, "renderNodeToOutput");
var render_node_to_output_default = renderNodeToOutput;

// node_modules/ink/build/output.js
init_esbuild_shims();

// node_modules/@alcalzone/ansi-tokenize/build/index.js
init_esbuild_shims();

// node_modules/@alcalzone/ansi-tokenize/build/ansiCodes.js
init_esbuild_shims();

// node_modules/@alcalzone/ansi-tokenize/node_modules/ansi-styles/index.js
init_esbuild_shims();
var ANSI_BACKGROUND_OFFSET3 = 10;
var wrapAnsi163 = /* @__PURE__ */ __name((offset = 0) => (code) => `\x1B[${code + offset}m`, "wrapAnsi16");
var wrapAnsi2563 = /* @__PURE__ */ __name((offset = 0) => (code) => `\x1B[${38 + offset};5;${code}m`, "wrapAnsi256");
var wrapAnsi16m3 = /* @__PURE__ */ __name((offset = 0) => (red, green, blue) => `\x1B[${38 + offset};2;${red};${green};${blue}m`, "wrapAnsi16m");
var styles5 = {
  modifier: {
    reset: [0, 0],
    // 21 isn't widely supported and 22 does the same thing
    bold: [1, 22],
    dim: [2, 22],
    italic: [3, 23],
    underline: [4, 24],
    overline: [53, 55],
    inverse: [7, 27],
    hidden: [8, 28],
    strikethrough: [9, 29]
  },
  color: {
    black: [30, 39],
    red: [31, 39],
    green: [32, 39],
    yellow: [33, 39],
    blue: [34, 39],
    magenta: [35, 39],
    cyan: [36, 39],
    white: [37, 39],
    // Bright color
    blackBright: [90, 39],
    gray: [90, 39],
    // Alias of `blackBright`
    grey: [90, 39],
    // Alias of `blackBright`
    redBright: [91, 39],
    greenBright: [92, 39],
    yellowBright: [93, 39],
    blueBright: [94, 39],
    magentaBright: [95, 39],
    cyanBright: [96, 39],
    whiteBright: [97, 39]
  },
  bgColor: {
    bgBlack: [40, 49],
    bgRed: [41, 49],
    bgGreen: [42, 49],
    bgYellow: [43, 49],
    bgBlue: [44, 49],
    bgMagenta: [45, 49],
    bgCyan: [46, 49],
    bgWhite: [47, 49],
    // Bright color
    bgBlackBright: [100, 49],
    bgGray: [100, 49],
    // Alias of `bgBlackBright`
    bgGrey: [100, 49],
    // Alias of `bgBlackBright`
    bgRedBright: [101, 49],
    bgGreenBright: [102, 49],
    bgYellowBright: [103, 49],
    bgBlueBright: [104, 49],
    bgMagentaBright: [105, 49],
    bgCyanBright: [106, 49],
    bgWhiteBright: [107, 49]
  }
};
var modifierNames3 = Object.keys(styles5.modifier);
var foregroundColorNames3 = Object.keys(styles5.color);
var backgroundColorNames3 = Object.keys(styles5.bgColor);
var colorNames3 = [...foregroundColorNames3, ...backgroundColorNames3];
function assembleStyles3() {
  const codes = /* @__PURE__ */ new Map();
  for (const [groupName, group] of Object.entries(styles5)) {
    for (const [styleName, style] of Object.entries(group)) {
      styles5[styleName] = {
        open: `\x1B[${style[0]}m`,
        close: `\x1B[${style[1]}m`
      };
      group[styleName] = styles5[styleName];
      codes.set(style[0], style[1]);
    }
    Object.defineProperty(styles5, groupName, {
      value: group,
      enumerable: false
    });
  }
  Object.defineProperty(styles5, "codes", {
    value: codes,
    enumerable: false
  });
  styles5.color.close = "\x1B[39m";
  styles5.bgColor.close = "\x1B[49m";
  styles5.color.ansi = wrapAnsi163();
  styles5.color.ansi256 = wrapAnsi2563();
  styles5.color.ansi16m = wrapAnsi16m3();
  styles5.bgColor.ansi = wrapAnsi163(ANSI_BACKGROUND_OFFSET3);
  styles5.bgColor.ansi256 = wrapAnsi2563(ANSI_BACKGROUND_OFFSET3);
  styles5.bgColor.ansi16m = wrapAnsi16m3(ANSI_BACKGROUND_OFFSET3);
  Object.defineProperties(styles5, {
    rgbToAnsi256: {
      value(red, green, blue) {
        if (red === green && green === blue) {
          if (red < 8) {
            return 16;
          }
          if (red > 248) {
            return 231;
          }
          return Math.round((red - 8) / 247 * 24) + 232;
        }
        return 16 + 36 * Math.round(red / 255 * 5) + 6 * Math.round(green / 255 * 5) + Math.round(blue / 255 * 5);
      },
      enumerable: false
    },
    hexToRgb: {
      value(hex) {
        const matches = /[a-f\d]{6}|[a-f\d]{3}/i.exec(hex.toString(16));
        if (!matches) {
          return [0, 0, 0];
        }
        let [colorString] = matches;
        if (colorString.length === 3) {
          colorString = [...colorString].map((character) => character + character).join("");
        }
        const integer = Number.parseInt(colorString, 16);
        return [
          /* eslint-disable no-bitwise */
          integer >> 16 & 255,
          integer >> 8 & 255,
          integer & 255
          /* eslint-enable no-bitwise */
        ];
      },
      enumerable: false
    },
    hexToAnsi256: {
      value: /* @__PURE__ */ __name((hex) => styles5.rgbToAnsi256(...styles5.hexToRgb(hex)), "value"),
      enumerable: false
    },
    ansi256ToAnsi: {
      value(code) {
        if (code < 8) {
          return 30 + code;
        }
        if (code < 16) {
          return 90 + (code - 8);
        }
        let red;
        let green;
        let blue;
        if (code >= 232) {
          red = ((code - 232) * 10 + 8) / 255;
          green = red;
          blue = red;
        } else {
          code -= 16;
          const remainder = code % 36;
          red = Math.floor(code / 36) / 5;
          green = Math.floor(remainder / 6) / 5;
          blue = remainder % 6 / 5;
        }
        const value = Math.max(red, green, blue) * 2;
        if (value === 0) {
          return 30;
        }
        let result = 30 + (Math.round(blue) << 2 | Math.round(green) << 1 | Math.round(red));
        if (value === 2) {
          result += 60;
        }
        return result;
      },
      enumerable: false
    },
    rgbToAnsi: {
      value: /* @__PURE__ */ __name((red, green, blue) => styles5.ansi256ToAnsi(styles5.rgbToAnsi256(red, green, blue)), "value"),
      enumerable: false
    },
    hexToAnsi: {
      value: /* @__PURE__ */ __name((hex) => styles5.ansi256ToAnsi(styles5.hexToAnsi256(hex)), "value"),
      enumerable: false
    }
  });
  return styles5;
}
__name(assembleStyles3, "assembleStyles");
var ansiStyles3 = assembleStyles3();
var ansi_styles_default3 = ansiStyles3;

// node_modules/@alcalzone/ansi-tokenize/build/consts.js
init_esbuild_shims();
var BEL2 = "\x07";
var ESC2 = "\x1B";
var BACKSLASH = "\\";
var CSI = "[";
var OSC2 = "]";
var C1_ST = "\x9C";
var CC_BEL = BEL2.charCodeAt(0);
var CC_ESC = ESC2.charCodeAt(0);
var CC_BACKSLASH = BACKSLASH.charCodeAt(0);
var CC_CSI = CSI.charCodeAt(0);
var CC_OSC = OSC2.charCodeAt(0);
var CC_C1_ST = C1_ST.charCodeAt(0);
var CC_0 = "0".charCodeAt(0);
var CC_9 = "9".charCodeAt(0);
var CC_SEMI = ";".charCodeAt(0);
var CC_M = "m".charCodeAt(0);
var ESCAPES3 = /* @__PURE__ */ new Set([CC_ESC, 155]);
var linkCodePrefix = `${ESC2}${OSC2}8;`;
var linkCodePrefixCharCodes = linkCodePrefix.split("").map((char) => char.charCodeAt(0));
var linkEndCode = `${ESC2}${OSC2}8;;${BEL2}`;
var linkEndCodeST = `${ESC2}${OSC2}8;;${ESC2}${BACKSLASH}`;
var linkEndCodeC1ST = `${ESC2}${OSC2}8;;${C1_ST}`;

// node_modules/@alcalzone/ansi-tokenize/build/ansiCodes.js
var endCodesSet = /* @__PURE__ */ new Set();
var endCodesMap = /* @__PURE__ */ new Map();
for (const [start, end] of ansi_styles_default3.codes) {
  endCodesSet.add(ansi_styles_default3.color.ansi(end));
  endCodesMap.set(ansi_styles_default3.color.ansi(start), ansi_styles_default3.color.ansi(end));
}
function getEndCode(code) {
  if (endCodesSet.has(code))
    return code;
  if (endCodesMap.has(code))
    return endCodesMap.get(code);
  if (code.startsWith(linkCodePrefix)) {
    if (code.endsWith("\x1B\\"))
      return linkEndCodeST;
    if (code.endsWith("\x9C"))
      return linkEndCodeC1ST;
    return linkEndCode;
  }
  code = code.slice(2);
  if (code.startsWith("38")) {
    return ansi_styles_default3.color.close;
  } else if (code.startsWith("48")) {
    return ansi_styles_default3.bgColor.close;
  }
  const ret = ansi_styles_default3.codes.get(parseInt(code, 10));
  if (ret) {
    return ansi_styles_default3.color.ansi(ret);
  } else {
    return ansi_styles_default3.reset.open;
  }
}
__name(getEndCode, "getEndCode");
function ansiCodesToString(codes) {
  const deduplicated = new Set(codes.map((code) => code.code));
  return [...deduplicated].join("");
}
__name(ansiCodesToString, "ansiCodesToString");
function isIntensityCode(code) {
  return code.code === ansi_styles_default3.bold.open || code.code === ansi_styles_default3.dim.open;
}
__name(isIntensityCode, "isIntensityCode");

// node_modules/@alcalzone/ansi-tokenize/build/diff.js
init_esbuild_shims();

// node_modules/@alcalzone/ansi-tokenize/build/undo.js
init_esbuild_shims();

// node_modules/@alcalzone/ansi-tokenize/build/reduce.js
init_esbuild_shims();
function reduceAnsiCodes(codes) {
  return reduceAnsiCodesIncremental([], codes);
}
__name(reduceAnsiCodes, "reduceAnsiCodes");
function reduceAnsiCodesIncremental(codes, newCodes) {
  let ret = [...codes];
  for (const code of newCodes) {
    if (code.code === ansi_styles_default3.reset.open) {
      ret = [];
    } else if (endCodesSet.has(code.code)) {
      ret = ret.filter((retCode) => retCode.endCode !== code.code);
    } else {
      if (isIntensityCode(code)) {
        if (!ret.find((retCode) => retCode.code === code.code && retCode.endCode === code.endCode)) {
          ret.push(code);
        }
      } else {
        ret = ret.filter((retCode) => retCode.endCode !== code.endCode);
        ret.push(code);
      }
    }
  }
  return ret;
}
__name(reduceAnsiCodesIncremental, "reduceAnsiCodesIncremental");

// node_modules/@alcalzone/ansi-tokenize/build/undo.js
function undoAnsiCodes2(codes) {
  return reduceAnsiCodes(codes).reverse().map((code) => ({
    ...code,
    code: code.endCode
  }));
}
__name(undoAnsiCodes2, "undoAnsiCodes");

// node_modules/@alcalzone/ansi-tokenize/build/diff.js
function diffAnsiCodes(from, to) {
  const endCodesInTo = new Set(to.map((code) => code.endCode));
  const startCodesInTo = new Set(to.map((code) => code.code));
  const startCodesInFrom = new Set(from.map((code) => code.code));
  return [
    // Ignore all styles in `from` that are not overwritten or removed by `to`
    // Disable all styles in `from` that are removed in `to`
    ...undoAnsiCodes2(from.filter((code) => {
      if (isIntensityCode(code)) {
        return !startCodesInTo.has(code.code);
      }
      return !endCodesInTo.has(code.endCode);
    })),
    // Add all styles in `to` that don't exist in `from`
    ...to.filter((code) => !startCodesInFrom.has(code.code))
  ];
}
__name(diffAnsiCodes, "diffAnsiCodes");

// node_modules/@alcalzone/ansi-tokenize/build/styledChars.js
init_esbuild_shims();
function styledCharsFromTokens(tokens) {
  let codes = [];
  const ret = [];
  for (const token of tokens) {
    if (token.type === "ansi") {
      codes = reduceAnsiCodesIncremental(codes, [token]);
    } else if (token.type === "char") {
      ret.push({
        ...token,
        styles: [...codes]
      });
    }
  }
  return ret;
}
__name(styledCharsFromTokens, "styledCharsFromTokens");
function styledCharsToString(chars) {
  let ret = "";
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (i === 0) {
      ret += ansiCodesToString(char.styles);
    } else {
      ret += ansiCodesToString(diffAnsiCodes(chars[i - 1].styles, char.styles));
    }
    ret += char.value;
    if (i === chars.length - 1) {
      ret += ansiCodesToString(diffAnsiCodes(char.styles, []));
    }
  }
  return ret;
}
__name(styledCharsToString, "styledCharsToString");

// node_modules/@alcalzone/ansi-tokenize/build/tokenize.js
init_esbuild_shims();

// node_modules/@alcalzone/ansi-tokenize/node_modules/is-fullwidth-code-point/index.js
init_esbuild_shims();
function isFullwidthCodePoint2(codePoint) {
  if (!Number.isInteger(codePoint)) {
    return false;
  }
  return isFullWidth(codePoint) || isWide(codePoint);
}
__name(isFullwidthCodePoint2, "isFullwidthCodePoint");

// node_modules/@alcalzone/ansi-tokenize/build/tokenize.js
var segmenter3 = new Intl.Segmenter(void 0, { granularity: "grapheme" });
function isFullwidthGrapheme(grapheme, baseCodePoint) {
  if (isFullwidthCodePoint2(baseCodePoint))
    return true;
  if (grapheme.includes("\uFE0F"))
    return true;
  if (baseCodePoint >= 127462 && baseCodePoint <= 127487)
    return true;
  return false;
}
__name(isFullwidthGrapheme, "isFullwidthGrapheme");
function parseLinkCode(string, offset) {
  string = string.slice(offset);
  for (let index = 1; index < linkCodePrefixCharCodes.length; index++) {
    if (string.charCodeAt(index) !== linkCodePrefixCharCodes[index]) {
      return void 0;
    }
  }
  const paramsEndIndex = string.indexOf(";", linkCodePrefix.length);
  if (paramsEndIndex === -1)
    return void 0;
  const endIndex = findOSCTerminatorIndex(string, paramsEndIndex + 1);
  if (endIndex === -1)
    return void 0;
  return string.slice(0, endIndex + 1);
}
__name(parseLinkCode, "parseLinkCode");
function parseOSCSequence(string, offset) {
  string = string.slice(offset);
  const endIndex = findOSCTerminatorIndex(string, 2);
  if (endIndex === -1)
    return void 0;
  return string.slice(0, endIndex + 1);
}
__name(parseOSCSequence, "parseOSCSequence");
function findOSCTerminatorIndex(string, startIndex) {
  for (let i = startIndex; i < string.length; i++) {
    const ch = string.charCodeAt(i);
    if (ch === CC_BEL)
      return i;
    if (ch === CC_C1_ST)
      return i;
    if (ch === CC_ESC && i + 1 < string.length && string.charCodeAt(i + 1) === CC_BACKSLASH) {
      return i + 1;
    }
  }
  return -1;
}
__name(findOSCTerminatorIndex, "findOSCTerminatorIndex");
function findSGRSequenceEndIndex(str) {
  for (let index = 2; index < str.length; index++) {
    const charCode = str.charCodeAt(index);
    if (charCode === CC_M)
      return index;
    if (charCode === CC_SEMI)
      continue;
    if (charCode >= CC_0 && charCode <= CC_9)
      continue;
    break;
  }
  return -1;
}
__name(findSGRSequenceEndIndex, "findSGRSequenceEndIndex");
function parseSGRSequence(string, offset) {
  string = string.slice(offset);
  const endIndex = findSGRSequenceEndIndex(string);
  if (endIndex === -1)
    return;
  return string.slice(0, endIndex + 1);
}
__name(parseSGRSequence, "parseSGRSequence");
function splitCompoundSGRSequences(code) {
  if (!code.includes(";")) {
    return [code];
  }
  const codeParts = code.slice(2, -1).split(";");
  const ret = [];
  for (let i = 0; i < codeParts.length; i++) {
    const rawCode = codeParts[i];
    if (rawCode === "38" || rawCode === "48") {
      if (i + 2 < codeParts.length && codeParts[i + 1] === "5") {
        ret.push(codeParts.slice(i, i + 3).join(";"));
        i += 2;
        continue;
      } else if (i + 4 < codeParts.length && codeParts[i + 1] === "2") {
        ret.push(codeParts.slice(i, i + 5).join(";"));
        i += 4;
        continue;
      }
    }
    ret.push(rawCode);
  }
  return ret.map((part) => `\x1B[${part}m`);
}
__name(splitCompoundSGRSequences, "splitCompoundSGRSequences");
function tokenize(str, endChar = Number.POSITIVE_INFINITY) {
  const ret = [];
  let visible = 0;
  let codeEndIndex = 0;
  for (const { segment, index } of segmenter3.segment(str)) {
    if (index < codeEndIndex)
      continue;
    const codePoint = segment.codePointAt(0);
    if (ESCAPES3.has(codePoint)) {
      let code;
      const nextCodePoint = str.codePointAt(index + 1);
      if (nextCodePoint === CC_OSC) {
        code = parseLinkCode(str, index);
        if (code) {
          ret.push({
            type: "ansi",
            code,
            endCode: getEndCode(code)
          });
        } else {
          code = parseOSCSequence(str, index);
          if (code) {
            ret.push({
              type: "control",
              code
            });
          }
        }
      } else if (nextCodePoint === CC_CSI) {
        code = parseSGRSequence(str, index);
        if (code) {
          const codes = splitCompoundSGRSequences(code);
          for (const individualCode of codes) {
            ret.push({
              type: "ansi",
              code: individualCode,
              endCode: getEndCode(individualCode)
            });
          }
        }
      }
      if (code) {
        codeEndIndex = index + code.length;
        continue;
      }
    }
    const fullWidth = isFullwidthGrapheme(segment, codePoint);
    ret.push({
      type: "char",
      value: segment,
      fullWidth
    });
    visible += fullWidth ? 2 : 1;
    if (visible >= endChar) {
      break;
    }
  }
  return ret;
}
__name(tokenize, "tokenize");

// node_modules/ink/build/output.js
var SELECTION_BG = { code: "\x1B[48;5;240m", endCode: "\x1B[49m" };
var isCellSelected = /* @__PURE__ */ __name((x, y, sel) => {
  if (y < sel.sy || y > sel.ey) {
    return false;
  }
  if (sel.sy === sel.ey) {
    return x >= sel.sx && x <= sel.ex;
  }
  if (y === sel.sy) {
    return x >= sel.sx;
  }
  if (y === sel.ey) {
    return x <= sel.ex;
  }
  return true;
}, "isCellSelected");
var OutputCaches = class {
  static {
    __name(this, "OutputCaches");
  }
  widths = /* @__PURE__ */ new Map();
  blockWidths = /* @__PURE__ */ new Map();
  styledChars = /* @__PURE__ */ new Map();
  getStyledChars(line) {
    let cached = this.styledChars.get(line);
    if (cached === void 0) {
      cached = styledCharsFromTokens(tokenize(line));
      this.styledChars.set(line, cached);
    }
    return cached;
  }
  getStringWidth(text) {
    let cached = this.widths.get(text);
    if (cached === void 0) {
      cached = stringWidth(text);
      this.widths.set(text, cached);
    }
    return cached;
  }
  getWidestLine(text) {
    let cached = this.blockWidths.get(text);
    if (cached === void 0) {
      let lineWidth = 0;
      for (const line of text.split("\n")) {
        lineWidth = Math.max(lineWidth, this.getStringWidth(line));
      }
      cached = lineWidth;
      this.blockWidths.set(text, cached);
    }
    return cached;
  }
};
var Output = class {
  static {
    __name(this, "Output");
  }
  width;
  height;
  operations = [];
  caches = new OutputCaches();
  constructor(options) {
    const { width, height } = options;
    this.width = width;
    this.height = height;
  }
  write(x, y, text, options) {
    const { transformers, selectable, semantic } = options;
    if (!text) {
      return;
    }
    this.operations.push({
      type: "write",
      x,
      y,
      text,
      transformers,
      selectable,
      semantic
    });
  }
  clip(clip) {
    this.operations.push({
      type: "clip",
      clip
    });
  }
  unclip() {
    this.operations.push({
      type: "unclip"
    });
  }
  get(selection) {
    const output = [];
    for (let y = 0; y < this.height; y++) {
      const row = [];
      for (let x = 0; x < this.width; x++) {
        row.push({
          type: "char",
          value: " ",
          fullWidth: false,
          styles: [],
          selectable: false,
          flowId: null
        });
      }
      output.push(row);
    }
    const boundaries = output.map(() => Array.from({ length: this.width }, () => null));
    const clips = [];
    for (const operation of this.operations) {
      if (operation.type === "clip") {
        clips.push(operation.clip);
      }
      if (operation.type === "unclip") {
        clips.pop();
      }
      if (operation.type === "write") {
        const { text, transformers, selectable, semantic } = operation;
        let { x, y } = operation;
        let lines = text.split("\n");
        let firstLineIndex = 0;
        const clip = clips.at(-1);
        if (clip) {
          const clipHorizontally = typeof clip?.x1 === "number" && typeof clip?.x2 === "number";
          const clipVertically = typeof clip?.y1 === "number" && typeof clip?.y2 === "number";
          if (clipHorizontally) {
            const width = this.caches.getWidestLine(text);
            if (x + width < clip.x1 || x > clip.x2) {
              continue;
            }
          }
          if (clipVertically) {
            const height = lines.length;
            if (y + height < clip.y1 || y > clip.y2) {
              continue;
            }
          }
          if (clipHorizontally) {
            lines = lines.map((line) => {
              const from = x < clip.x1 ? clip.x1 - x : 0;
              const width = this.caches.getStringWidth(line);
              const to = x + width > clip.x2 ? clip.x2 - x : width;
              return sliceAnsi(line, from, to);
            });
            if (x < clip.x1) {
              x = clip.x1;
            }
          }
          if (clipVertically) {
            const from = y < clip.y1 ? clip.y1 - y : 0;
            const height = lines.length;
            const to = y + height > clip.y2 ? clip.y2 - y : height;
            lines = lines.slice(from, to);
            firstLineIndex = from;
            if (y < clip.y1) {
              y = clip.y1;
            }
          }
        }
        let offsetY = 0;
        for (let [index, line] of lines.entries()) {
          const currentLine = output[y + offsetY];
          if (!currentLine) {
            continue;
          }
          for (const transformer of transformers) {
            line = transformer(line, index);
          }
          const boundaryRow = boundaries[y + offsetY];
          if (boundaryRow) {
            const boundaryWidth = semantic ? Math.max(1, this.caches.getStringWidth(line)) : this.caches.getStringWidth(line);
            const boundaryOrigin = x;
            const startX = Math.max(0, boundaryOrigin, clip?.x1 ?? 0);
            const endX = Math.min(this.width, boundaryOrigin + boundaryWidth, clip?.x2 ?? this.width);
            const sourceBoundary = semantic?.boundaries[firstLineIndex + index] ?? null;
            const boundary = sourceBoundary && semantic ? {
              ...sourceBoundary,
              flowId: semantic.flowId,
              selectable: semantic.selectable
            } : null;
            for (let boundaryX = startX; boundaryX < endX; boundaryX++) {
              if (boundaryX < boundaryRow.length) {
                boundaryRow[boundaryX] = boundary;
              }
            }
          }
          const characters = this.caches.getStyledChars(line);
          let offsetX = x;
          const rowSelectable = semantic ? semantic.selectable && (semantic.selectableRows[firstLineIndex + index] ?? true) : selectable ?? true;
          if (characters.length === 0) {
            offsetY++;
            continue;
          }
          const spaceCell = {
            type: "char",
            value: " ",
            fullWidth: false,
            styles: [],
            selectable: false,
            flowId: null
          };
          if (currentLine[offsetX]?.value === "" && offsetX > 0 && this.caches.getStringWidth(currentLine[offsetX - 1]?.value ?? "") > 1) {
            currentLine[offsetX - 1] = spaceCell;
          }
          for (const character of characters) {
            currentLine[offsetX] = {
              ...character,
              selectable: rowSelectable,
              flowId: semantic?.flowId ?? null
            };
            const characterWidth = Math.max(1, this.caches.getStringWidth(character.value));
            if (characterWidth > 1) {
              for (let index2 = 1; index2 < characterWidth; index2++) {
                currentLine[offsetX + index2] = {
                  type: "char",
                  value: "",
                  fullWidth: false,
                  styles: character.styles,
                  selectable: rowSelectable,
                  flowId: semantic?.flowId ?? null
                };
              }
            }
            offsetX += characterWidth;
          }
          if (currentLine[offsetX]?.value === "") {
            currentLine[offsetX] = spaceCell;
          }
          offsetY++;
        }
      }
    }
    if (selection) {
      for (let y = 0; y < output.length; y++) {
        const row = output[y];
        if (!row) {
          continue;
        }
        for (let x = 0; x < row.length; x++) {
          if (!isCellSelected(x, y, selection)) {
            continue;
          }
          const cell = row[x];
          if (cell) {
            row[x] = {
              ...cell,
              styles: [...cell.styles ?? [], SELECTION_BG]
            };
          }
        }
      }
    }
    const generatedOutput = output.map((line) => {
      const lineWithoutEmptyItems = line.filter((item) => item !== void 0);
      return styledCharsToString(lineWithoutEmptyItems).trimEnd();
    }).join("\n");
    return {
      output: generatedOutput,
      height: output.length,
      cells: output,
      boundaries
    };
  }
};

// node_modules/ink/build/renderer.js
var renderer = /* @__PURE__ */ __name((node, isScreenReaderEnabled, selection) => {
  if (node.yogaNode) {
    if (isScreenReaderEnabled) {
      const output2 = renderNodeToScreenReaderOutput(node, {
        skipStaticElements: true
      });
      const outputHeight2 = output2 === "" ? 0 : output2.split("\n").length;
      let staticOutput2 = "";
      if (node.staticNode) {
        staticOutput2 = renderNodeToScreenReaderOutput(node.staticNode, {
          skipStaticElements: false
        });
      }
      return {
        output: output2,
        outputHeight: outputHeight2,
        staticOutput: staticOutput2 ? `${staticOutput2}
` : ""
      };
    }
    const output = new Output({
      width: node.yogaNode.getComputedWidth(),
      height: node.yogaNode.getComputedHeight()
    });
    const flowIds = /* @__PURE__ */ new Map();
    const nextFlowId = { value: 1 };
    render_node_to_output_default(node, output, {
      skipStaticElements: true,
      flowIds,
      nextFlowId
    });
    let staticOutput;
    if (node.staticNode?.yogaNode) {
      staticOutput = new Output({
        width: node.staticNode.yogaNode.getComputedWidth(),
        height: node.staticNode.yogaNode.getComputedHeight()
      });
      render_node_to_output_default(node.staticNode, staticOutput, {
        skipStaticElements: false,
        flowIds,
        nextFlowId
      });
    }
    const { output: generatedOutput, height: outputHeight, cells, boundaries } = output.get(selection);
    return {
      output: generatedOutput,
      outputHeight,
      // Newline at the end is needed, because static output doesn't have one, so
      // interactive output will override last line of static output
      staticOutput: staticOutput ? `${staticOutput.get().output}
` : "",
      cells,
      boundaries
    };
  }
  return {
    output: "",
    outputHeight: 0,
    staticOutput: ""
  };
}, "renderer");
var renderer_default = renderer;

// node_modules/ink/build/cursor-helpers.js
init_esbuild_shims();
var showCursorEscape = "\x1B[?25h";
var hideCursorEscape = "\x1B[?25l";
var cursorPositionChanged = /* @__PURE__ */ __name((a, b) => a?.x !== b?.x || a?.y !== b?.y, "cursorPositionChanged");
var buildCursorSuffix = /* @__PURE__ */ __name((visibleLineCount2, cursorPosition, hasTrailingNewline = true) => {
  if (!cursorPosition) {
    return "";
  }
  const moveUp = (hasTrailingNewline ? visibleLineCount2 : visibleLineCount2 - 1) - cursorPosition.y;
  return (moveUp > 0 ? base_exports.cursorUp(moveUp) : "") + base_exports.cursorTo(cursorPosition.x) + showCursorEscape;
}, "buildCursorSuffix");
var buildReturnToBottom = /* @__PURE__ */ __name((previousLineCount, previousCursorPosition) => {
  if (!previousCursorPosition) {
    return "";
  }
  const down = previousLineCount - 1 - previousCursorPosition.y;
  return (down > 0 ? base_exports.cursorDown(down) : "") + base_exports.cursorTo(0);
}, "buildReturnToBottom");
var buildCursorOnlySequence = /* @__PURE__ */ __name((input) => {
  const hidePrefix = input.cursorWasShown ? hideCursorEscape : "";
  const returnToBottom = buildReturnToBottom(input.previousLineCount, input.previousCursorPosition);
  const cursorSuffix = buildCursorSuffix(input.visibleLineCount, input.cursorPosition, input.hasTrailingNewline);
  return hidePrefix + returnToBottom + cursorSuffix;
}, "buildCursorOnlySequence");
var buildReturnToBottomPrefix = /* @__PURE__ */ __name((cursorWasShown, previousLineCount, previousCursorPosition) => {
  if (!cursorWasShown) {
    return "";
  }
  return hideCursorEscape + buildReturnToBottom(previousLineCount, previousCursorPosition);
}, "buildReturnToBottomPrefix");

// node_modules/ink/build/log-update.js
init_esbuild_shims();

// node_modules/cli-cursor/index.js
init_esbuild_shims();
import process7 from "node:process";

// node_modules/restore-cursor/index.js
init_esbuild_shims();
var import_onetime = __toESM(require_onetime(), 1);
var import_signal_exit = __toESM(require_signal_exit2(), 1);
import process6 from "node:process";
var restoreCursor = (0, import_onetime.default)(() => {
  (0, import_signal_exit.default)(() => {
    process6.stderr.write("\x1B[?25h");
  }, { alwaysLast: true });
});
var restore_cursor_default = restoreCursor;

// node_modules/cli-cursor/index.js
var isHidden = false;
var cliCursor = {};
cliCursor.show = (writableStream = process7.stderr) => {
  if (!writableStream.isTTY) {
    return;
  }
  isHidden = false;
  writableStream.write("\x1B[?25h");
};
cliCursor.hide = (writableStream = process7.stderr) => {
  if (!writableStream.isTTY) {
    return;
  }
  restore_cursor_default();
  isHidden = true;
  writableStream.write("\x1B[?25l");
};
cliCursor.toggle = (force, writableStream) => {
  if (force !== void 0) {
    isHidden = force;
  }
  if (isHidden) {
    cliCursor.show(writableStream);
  } else {
    cliCursor.hide(writableStream);
  }
};
var cli_cursor_default = cliCursor;

// node_modules/ink/build/log-update.js
var visibleLineCount = /* @__PURE__ */ __name((lines, str) => str.endsWith("\n") ? lines.length - 1 : lines.length, "visibleLineCount");
var snapshotCursorPosition = /* @__PURE__ */ __name((position) => position ? { x: position.x, y: position.y } : void 0, "snapshotCursorPosition");
var createStandard = /* @__PURE__ */ __name((stream, { showCursor = false } = {}) => {
  let previousLineCount = 0;
  let previousOutput = "";
  let hasHiddenCursor = false;
  let cursorPosition;
  let cursorDirty = false;
  let previousCursorPosition;
  let cursorWasShown = false;
  let previousHasTrailingNewline = true;
  let preparedActiveCursor;
  let activeCursorPrepared = false;
  const prepareActiveCursor = /* @__PURE__ */ __name(() => {
    if (!activeCursorPrepared) {
      preparedActiveCursor = snapshotCursorPosition(cursorDirty ? cursorPosition : void 0);
      activeCursorPrepared = true;
    }
    return preparedActiveCursor;
  }, "prepareActiveCursor");
  const consumeActiveCursor = /* @__PURE__ */ __name(() => {
    const activeCursor = prepareActiveCursor();
    preparedActiveCursor = void 0;
    activeCursorPrepared = false;
    return activeCursor;
  }, "consumeActiveCursor");
  const invalidateActiveCursor = /* @__PURE__ */ __name(() => {
    preparedActiveCursor = void 0;
    activeCursorPrepared = false;
  }, "invalidateActiveCursor");
  const hasChanges = /* @__PURE__ */ __name((str, activeCursor) => {
    const cursorChanged = cursorPositionChanged(activeCursor, previousCursorPosition);
    return str !== previousOutput || cursorChanged;
  }, "hasChanges");
  const render2 = /* @__PURE__ */ __name((str) => {
    if (!showCursor && !hasHiddenCursor) {
      cli_cursor_default.hide(stream);
      hasHiddenCursor = true;
    }
    const activeCursor = consumeActiveCursor();
    cursorDirty = false;
    const cursorChanged = cursorPositionChanged(activeCursor, previousCursorPosition);
    if (!hasChanges(str, activeCursor)) {
      return false;
    }
    const lines = str.split("\n");
    const visibleCount = visibleLineCount(lines, str);
    const hasTrailingNewline = str.endsWith("\n");
    const cursorSuffix = buildCursorSuffix(visibleCount, activeCursor, hasTrailingNewline);
    if (str === previousOutput && cursorChanged) {
      stream.write(buildCursorOnlySequence({
        cursorWasShown,
        previousLineCount,
        previousCursorPosition,
        visibleLineCount: visibleCount,
        cursorPosition: activeCursor,
        hasTrailingNewline: previousHasTrailingNewline
      }));
    } else {
      previousOutput = str;
      const returnPrefix = buildReturnToBottomPrefix(cursorWasShown, previousLineCount, previousCursorPosition);
      stream.write(returnPrefix + base_exports.eraseLines(previousLineCount) + str + cursorSuffix);
      previousLineCount = lines.length;
      previousHasTrailingNewline = hasTrailingNewline;
    }
    previousCursorPosition = activeCursor ? { ...activeCursor } : void 0;
    cursorWasShown = activeCursor !== void 0;
    return true;
  }, "render");
  render2.clear = () => {
    const prefix = buildReturnToBottomPrefix(cursorWasShown, previousLineCount, previousCursorPosition);
    stream.write(prefix + base_exports.eraseLines(previousLineCount));
    previousOutput = "";
    previousLineCount = 0;
    previousCursorPosition = void 0;
    cursorWasShown = false;
    previousHasTrailingNewline = true;
    invalidateActiveCursor();
  };
  render2.done = () => {
    previousOutput = "";
    previousLineCount = 0;
    previousCursorPosition = void 0;
    cursorWasShown = false;
    previousHasTrailingNewline = true;
    invalidateActiveCursor();
    if (!showCursor) {
      cli_cursor_default.show(stream);
      hasHiddenCursor = false;
    }
  };
  render2.reset = () => {
    previousOutput = "";
    previousLineCount = 0;
    previousCursorPosition = void 0;
    cursorWasShown = false;
    previousHasTrailingNewline = true;
    invalidateActiveCursor();
  };
  render2.sync = (str) => {
    const activeCursor = consumeActiveCursor();
    cursorDirty = false;
    const lines = str.split("\n");
    previousOutput = str;
    previousLineCount = lines.length;
    previousHasTrailingNewline = str.endsWith("\n");
    if (!activeCursor && cursorWasShown) {
      stream.write(hideCursorEscape);
    }
    if (activeCursor) {
      stream.write(buildCursorSuffix(visibleLineCount(lines, str), activeCursor, previousHasTrailingNewline));
    }
    previousCursorPosition = activeCursor ? { ...activeCursor } : void 0;
    cursorWasShown = activeCursor !== void 0;
  };
  render2.setCursorPosition = (position) => {
    cursorPosition = position;
    cursorDirty = true;
    invalidateActiveCursor();
  };
  render2.isCursorDirty = () => cursorDirty;
  render2.willRender = (str) => hasChanges(str, prepareActiveCursor());
  return render2;
}, "createStandard");
var createIncremental = /* @__PURE__ */ __name((stream, { showCursor = false } = {}) => {
  let previousLines = [];
  let previousOutput = "";
  let hasHiddenCursor = false;
  let cursorPosition;
  let cursorDirty = false;
  let previousCursorPosition;
  let cursorWasShown = false;
  let previousHasTrailingNewline = true;
  let preparedActiveCursor;
  let activeCursorPrepared = false;
  const prepareActiveCursor = /* @__PURE__ */ __name(() => {
    if (!activeCursorPrepared) {
      preparedActiveCursor = snapshotCursorPosition(cursorDirty ? cursorPosition : void 0);
      activeCursorPrepared = true;
    }
    return preparedActiveCursor;
  }, "prepareActiveCursor");
  const consumeActiveCursor = /* @__PURE__ */ __name(() => {
    const activeCursor = prepareActiveCursor();
    preparedActiveCursor = void 0;
    activeCursorPrepared = false;
    return activeCursor;
  }, "consumeActiveCursor");
  const invalidateActiveCursor = /* @__PURE__ */ __name(() => {
    preparedActiveCursor = void 0;
    activeCursorPrepared = false;
  }, "invalidateActiveCursor");
  const hasChanges = /* @__PURE__ */ __name((str, activeCursor) => {
    const cursorChanged = cursorPositionChanged(activeCursor, previousCursorPosition);
    return str !== previousOutput || cursorChanged;
  }, "hasChanges");
  const render2 = /* @__PURE__ */ __name((str) => {
    if (!showCursor && !hasHiddenCursor) {
      cli_cursor_default.hide(stream);
      hasHiddenCursor = true;
    }
    const activeCursor = consumeActiveCursor();
    cursorDirty = false;
    const cursorChanged = cursorPositionChanged(activeCursor, previousCursorPosition);
    if (!hasChanges(str, activeCursor)) {
      return false;
    }
    const nextLines = str.split("\n");
    const visibleCount = visibleLineCount(nextLines, str);
    const previousVisible = visibleLineCount(previousLines, previousOutput);
    if (str === previousOutput && cursorChanged) {
      stream.write(buildCursorOnlySequence({
        cursorWasShown,
        previousLineCount: previousLines.length,
        previousCursorPosition,
        visibleLineCount: visibleCount,
        cursorPosition: activeCursor,
        hasTrailingNewline: previousHasTrailingNewline
      }));
      previousCursorPosition = activeCursor ? { ...activeCursor } : void 0;
      cursorWasShown = activeCursor !== void 0;
      return true;
    }
    const returnPrefix = buildReturnToBottomPrefix(cursorWasShown, previousLines.length, previousCursorPosition);
    if (str === "\n" || previousOutput.length === 0) {
      const cursorSuffix2 = buildCursorSuffix(visibleCount, activeCursor, str.endsWith("\n"));
      stream.write(returnPrefix + base_exports.eraseLines(previousLines.length) + str + cursorSuffix2);
      cursorWasShown = activeCursor !== void 0;
      previousCursorPosition = activeCursor ? { ...activeCursor } : void 0;
      previousOutput = str;
      previousLines = nextLines;
      previousHasTrailingNewline = str.endsWith("\n");
      return true;
    }
    const hasTrailingNewline = str.endsWith("\n");
    const buffer = [];
    buffer.push(returnPrefix);
    if (visibleCount < previousVisible) {
      const previousHadTrailingNewline = previousOutput.endsWith("\n");
      const extraSlot = previousHadTrailingNewline ? 1 : 0;
      buffer.push(base_exports.eraseLines(previousVisible - visibleCount + extraSlot), base_exports.cursorUp(visibleCount));
    } else {
      buffer.push(base_exports.cursorUp(previousLines.length - 1));
    }
    for (let i = 0; i < visibleCount; i++) {
      const isLastLine = i === visibleCount - 1;
      if (nextLines[i] === previousLines[i]) {
        if (!isLastLine || hasTrailingNewline) {
          buffer.push(base_exports.cursorNextLine);
        }
        continue;
      }
      buffer.push(base_exports.cursorTo(0) + nextLines[i] + base_exports.eraseEndLine + // Don't append newline after the last line when the input
      // has no trailing newline (fullscreen mode).
      (isLastLine && !hasTrailingNewline ? "" : "\n"));
    }
    const cursorSuffix = buildCursorSuffix(visibleCount, activeCursor, hasTrailingNewline);
    buffer.push(cursorSuffix);
    stream.write(buffer.join(""));
    cursorWasShown = activeCursor !== void 0;
    previousCursorPosition = activeCursor ? { ...activeCursor } : void 0;
    previousOutput = str;
    previousLines = nextLines;
    previousHasTrailingNewline = hasTrailingNewline;
    return true;
  }, "render");
  render2.clear = () => {
    const prefix = buildReturnToBottomPrefix(cursorWasShown, previousLines.length, previousCursorPosition);
    stream.write(prefix + base_exports.eraseLines(previousLines.length));
    previousOutput = "";
    previousLines = [];
    previousCursorPosition = void 0;
    cursorWasShown = false;
    previousHasTrailingNewline = true;
    invalidateActiveCursor();
  };
  render2.done = () => {
    previousOutput = "";
    previousLines = [];
    previousCursorPosition = void 0;
    cursorWasShown = false;
    previousHasTrailingNewline = true;
    invalidateActiveCursor();
    if (!showCursor) {
      cli_cursor_default.show(stream);
      hasHiddenCursor = false;
    }
  };
  render2.reset = () => {
    previousOutput = "";
    previousLines = [];
    previousCursorPosition = void 0;
    cursorWasShown = false;
    previousHasTrailingNewline = true;
    invalidateActiveCursor();
  };
  render2.sync = (str) => {
    const activeCursor = consumeActiveCursor();
    cursorDirty = false;
    const lines = str.split("\n");
    previousOutput = str;
    previousLines = lines;
    previousHasTrailingNewline = str.endsWith("\n");
    if (!activeCursor && cursorWasShown) {
      stream.write(hideCursorEscape);
    }
    if (activeCursor) {
      stream.write(buildCursorSuffix(visibleLineCount(lines, str), activeCursor, previousHasTrailingNewline));
    }
    previousCursorPosition = activeCursor ? { ...activeCursor } : void 0;
    cursorWasShown = activeCursor !== void 0;
  };
  render2.setCursorPosition = (position) => {
    cursorPosition = position;
    cursorDirty = true;
    invalidateActiveCursor();
  };
  render2.isCursorDirty = () => cursorDirty;
  render2.willRender = (str) => hasChanges(str, prepareActiveCursor());
  return render2;
}, "createIncremental");
var create2 = /* @__PURE__ */ __name((stream, { showCursor = false, incremental = false } = {}) => {
  if (incremental) {
    return createIncremental(stream, { showCursor });
  }
  return createStandard(stream, { showCursor });
}, "create");
var logUpdate = { create: create2 };
var log_update_default = logUpdate;

// node_modules/ink/build/write-synchronized.js
init_esbuild_shims();
var bsu = "\x1B[?2026h";
var esu = "\x1B[?2026l";
function shouldSynchronize(stream, interactive) {
  return "isTTY" in stream && stream.isTTY && (interactive ?? !is_in_ci_default);
}
__name(shouldSynchronize, "shouldSynchronize");

// node_modules/ink/build/instances.js
init_esbuild_shims();
var instances = /* @__PURE__ */ new WeakMap();
var instances_default = instances;

// node_modules/ink/build/frame-controller.js
init_esbuild_shims();
var sameSelection = /* @__PURE__ */ __name((a, b) => {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a.sx === b.sx && a.sy === b.sy && a.ex === b.ex && a.ey === b.ey;
}, "sameSelection");
var createFrameController = /* @__PURE__ */ __name((requestRender) => {
  let currentSelection = null;
  let lastFrame = null;
  const listeners = /* @__PURE__ */ new Set();
  return {
    getFrame: /* @__PURE__ */ __name(() => lastFrame, "getFrame"),
    getSelection: /* @__PURE__ */ __name(() => currentSelection, "getSelection"),
    setSelection(selection) {
      if (sameSelection(currentSelection, selection)) {
        return;
      }
      currentSelection = selection;
      requestRender();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publishFrame(frame) {
      lastFrame = frame;
      for (const listener of listeners) {
        listener(frame);
      }
    }
  };
}, "createFrameController");
var getFrameController = /* @__PURE__ */ __name((stdout) => instances_default.get(stdout)?.frameController, "getFrameController");

// node_modules/ink/build/components/App.js
init_esbuild_shims();
var import_react15 = __toESM(require_react(), 1);
import { EventEmitter as EventEmitter2 } from "node:events";
import process11 from "node:process";

// node_modules/ink/build/input-parser.js
init_esbuild_shims();
var escape = "\x1B";
var pasteStart = "\x1B[200~";
var pasteEnd = "\x1B[201~";
var isCsiParameterByte = /* @__PURE__ */ __name((byte) => {
  return byte >= 48 && byte <= 63;
}, "isCsiParameterByte");
var isCsiIntermediateByte = /* @__PURE__ */ __name((byte) => {
  return byte >= 32 && byte <= 47;
}, "isCsiIntermediateByte");
var isCsiFinalByte = /* @__PURE__ */ __name((byte) => {
  return byte >= 64 && byte <= 126;
}, "isCsiFinalByte");
var parseCsiSequence = /* @__PURE__ */ __name((input, startIndex, prefixLength) => {
  const csiPayloadStart = startIndex + prefixLength + 1;
  let index = csiPayloadStart;
  for (; index < input.length; index++) {
    const byte = input.codePointAt(index);
    if (byte === void 0) {
      return "pending";
    }
    if (isCsiParameterByte(byte) || isCsiIntermediateByte(byte)) {
      continue;
    }
    if (byte === 91 && index === csiPayloadStart) {
      continue;
    }
    if (isCsiFinalByte(byte)) {
      return {
        sequence: input.slice(startIndex, index + 1),
        nextIndex: index + 1
      };
    }
    return void 0;
  }
  return "pending";
}, "parseCsiSequence");
var parseSs3Sequence = /* @__PURE__ */ __name((input, startIndex, prefixLength) => {
  const nextIndex = startIndex + prefixLength + 2;
  if (nextIndex > input.length) {
    return "pending";
  }
  const finalByte = input.codePointAt(nextIndex - 1);
  if (finalByte === void 0 || !isCsiFinalByte(finalByte)) {
    return void 0;
  }
  return {
    sequence: input.slice(startIndex, nextIndex),
    nextIndex
  };
}, "parseSs3Sequence");
var parseControlSequence = /* @__PURE__ */ __name((input, startIndex, prefixLength) => {
  const sequenceType = input[startIndex + prefixLength];
  if (sequenceType === void 0) {
    return "pending";
  }
  if (sequenceType === "[") {
    return parseCsiSequence(input, startIndex, prefixLength);
  }
  if (sequenceType === "O") {
    return parseSs3Sequence(input, startIndex, prefixLength);
  }
  return void 0;
}, "parseControlSequence");
var parseEscapedCodePoint = /* @__PURE__ */ __name((input, escapeIndex) => {
  const nextCodePoint = input.codePointAt(escapeIndex + 1);
  const nextCodePointLength = nextCodePoint !== void 0 && nextCodePoint > 65535 ? 2 : 1;
  const nextIndex = escapeIndex + 1 + nextCodePointLength;
  return {
    sequence: input.slice(escapeIndex, nextIndex),
    nextIndex
  };
}, "parseEscapedCodePoint");
var parseEscapeSequence = /* @__PURE__ */ __name((input, escapeIndex) => {
  if (escapeIndex === input.length - 1) {
    return "pending";
  }
  const next = input[escapeIndex + 1];
  if (next === escape) {
    if (escapeIndex + 2 >= input.length) {
      return "pending";
    }
    const doubleEscapeSequence = parseControlSequence(input, escapeIndex, 2);
    if (doubleEscapeSequence === "pending") {
      return "pending";
    }
    if (doubleEscapeSequence) {
      return doubleEscapeSequence;
    }
    return {
      sequence: input.slice(escapeIndex, escapeIndex + 2),
      nextIndex: escapeIndex + 2
    };
  }
  const controlSequence = parseControlSequence(input, escapeIndex, 1);
  if (controlSequence === "pending") {
    return "pending";
  }
  if (controlSequence) {
    return controlSequence;
  }
  return parseEscapedCodePoint(input, escapeIndex);
}, "parseEscapeSequence");
var splitBackspaceBytes = /* @__PURE__ */ __name((text, events) => {
  let textSegmentStart = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "\x7F" || character === "\b") {
      if (index > textSegmentStart) {
        events.push(text.slice(textSegmentStart, index));
      }
      events.push(character);
      textSegmentStart = index + 1;
    }
  }
  if (textSegmentStart < text.length) {
    events.push(text.slice(textSegmentStart));
  }
}, "splitBackspaceBytes");
var parseKeypresses = /* @__PURE__ */ __name((input) => {
  const events = [];
  let index = 0;
  const pendingFrom = /* @__PURE__ */ __name((pendingStartIndex) => ({
    events,
    pending: input.slice(pendingStartIndex)
  }), "pendingFrom");
  while (index < input.length) {
    const escapeIndex = input.indexOf(escape, index);
    if (escapeIndex === -1) {
      splitBackspaceBytes(input.slice(index), events);
      return {
        events,
        pending: ""
      };
    }
    if (escapeIndex > index) {
      splitBackspaceBytes(input.slice(index, escapeIndex), events);
    }
    const parsedEscapeSequence = parseEscapeSequence(input, escapeIndex);
    if (parsedEscapeSequence === "pending") {
      return pendingFrom(escapeIndex);
    }
    if (parsedEscapeSequence.sequence === pasteStart) {
      const afterStart = parsedEscapeSequence.nextIndex;
      const endIndex = input.indexOf(pasteEnd, afterStart);
      if (endIndex === -1) {
        return pendingFrom(escapeIndex);
      }
      events.push({ paste: input.slice(afterStart, endIndex) });
      index = endIndex + pasteEnd.length;
      continue;
    }
    events.push(parsedEscapeSequence.sequence);
    index = parsedEscapeSequence.nextIndex;
  }
  return {
    events,
    pending: ""
  };
}, "parseKeypresses");
var createInputParser = /* @__PURE__ */ __name(() => {
  let pending = "";
  return {
    push(chunk) {
      const parsedInput = parseKeypresses(pending + chunk);
      pending = parsedInput.pending;
      return parsedInput.events;
    },
    hasPendingEscape() {
      return pending.startsWith(escape) && !pending.startsWith(pasteStart) && pending !== "\x1B[200";
    },
    flushPendingEscape() {
      if (!pending.startsWith(escape)) {
        return void 0;
      }
      const pendingEscape = pending;
      pending = "";
      return pendingEscape;
    },
    reset() {
      pending = "";
    }
  };
}, "createInputParser");

// node_modules/ink/build/components/AppContext.js
init_esbuild_shims();
var import_react2 = __toESM(require_react(), 1);
var defaultValue = {
  exit(_errorOrResult) {
  },
  async waitUntilRenderFlush() {
  }
};
var AppContext = (0, import_react2.createContext)(defaultValue);
AppContext.displayName = "InternalAppContext";
var AppContext_default = AppContext;

// node_modules/ink/build/components/StdinContext.js
init_esbuild_shims();
var import_react3 = __toESM(require_react(), 1);
import { EventEmitter } from "node:events";
import process8 from "node:process";
var StdinContext = (0, import_react3.createContext)({
  stdin: process8.stdin,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  internal_eventEmitter: new EventEmitter(),
  setRawMode() {
  },
  setBracketedPasteMode() {
  },
  isRawModeSupported: false,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  internal_exitOnCtrlC: true
});
StdinContext.displayName = "InternalStdinContext";
var StdinContext_default = StdinContext;

// node_modules/ink/build/components/StdoutContext.js
init_esbuild_shims();
var import_react4 = __toESM(require_react(), 1);
import process9 from "node:process";
var StdoutContext = (0, import_react4.createContext)({
  stdout: process9.stdout,
  write() {
  }
});
StdoutContext.displayName = "InternalStdoutContext";
var StdoutContext_default = StdoutContext;

// node_modules/ink/build/components/StderrContext.js
init_esbuild_shims();
var import_react5 = __toESM(require_react(), 1);
import process10 from "node:process";
var StderrContext = (0, import_react5.createContext)({
  stderr: process10.stderr,
  write() {
  }
});
StderrContext.displayName = "InternalStderrContext";
var StderrContext_default = StderrContext;

// node_modules/ink/build/components/FocusContext.js
init_esbuild_shims();
var import_react6 = __toESM(require_react(), 1);
var FocusContext = (0, import_react6.createContext)({
  activeId: void 0,
  add() {
  },
  remove() {
  },
  activate() {
  },
  deactivate() {
  },
  enableFocus() {
  },
  disableFocus() {
  },
  focusNext() {
  },
  focusPrevious() {
  },
  focus() {
  }
});
FocusContext.displayName = "InternalFocusContext";
var FocusContext_default = FocusContext;

// node_modules/ink/build/components/AnimationContext.js
init_esbuild_shims();
var import_react7 = __toESM(require_react(), 1);
var animationContext = (0, import_react7.createContext)({
  renderThrottleMs: 0,
  subscribe() {
    return {
      startTime: 0,
      unsubscribe() {
      }
    };
  }
});
animationContext.displayName = "InternalAnimationContext";
var AnimationContext_default = animationContext;

// node_modules/ink/build/components/CursorContext.js
init_esbuild_shims();
var import_react8 = __toESM(require_react(), 1);
var CursorContext = (0, import_react8.createContext)({
  setCursorPosition() {
  }
});
CursorContext.displayName = "InternalCursorContext";
var CursorContext_default = CursorContext;

// node_modules/ink/build/components/ErrorBoundary.js
init_esbuild_shims();
var import_react14 = __toESM(require_react(), 1);

// node_modules/ink/build/components/ErrorOverview.js
init_esbuild_shims();
var import_react13 = __toESM(require_react(), 1);
var import_stack_utils = __toESM(require_stack_utils(), 1);
import * as fs2 from "node:fs";
import { cwd } from "node:process";

// node_modules/code-excerpt/dist/index.js
init_esbuild_shims();

// node_modules/convert-to-spaces/dist/index.js
init_esbuild_shims();
var convertToSpaces = /* @__PURE__ */ __name((input, spaces = 2) => {
  return input.replace(/^\t+/gm, ($1) => " ".repeat($1.length * spaces));
}, "convertToSpaces");
var dist_default2 = convertToSpaces;

// node_modules/code-excerpt/dist/index.js
var generateLineNumbers = /* @__PURE__ */ __name((line, around) => {
  const lineNumbers = [];
  const min = line - around;
  const max = line + around;
  for (let lineNumber = min; lineNumber <= max; lineNumber++) {
    lineNumbers.push(lineNumber);
  }
  return lineNumbers;
}, "generateLineNumbers");
var codeExcerpt = /* @__PURE__ */ __name((source, line, options = {}) => {
  var _a;
  if (typeof source !== "string") {
    throw new TypeError("Source code is missing.");
  }
  if (!line || line < 1) {
    throw new TypeError("Line number must start from `1`.");
  }
  const lines = dist_default2(source).split(/\r?\n/);
  if (line > lines.length) {
    return;
  }
  return generateLineNumbers(line, (_a = options.around) !== null && _a !== void 0 ? _a : 3).filter((line2) => lines[line2 - 1] !== void 0).map((line2) => ({ line: line2, value: lines[line2 - 1] }));
}, "codeExcerpt");
var dist_default3 = codeExcerpt;

// node_modules/ink/build/components/Box.js
init_esbuild_shims();
var import_react11 = __toESM(require_react(), 1);

// node_modules/ink/build/components/AccessibilityContext.js
init_esbuild_shims();
var import_react9 = __toESM(require_react(), 1);
var accessibilityContext = (0, import_react9.createContext)({
  isScreenReaderEnabled: false
});

// node_modules/ink/build/components/BackgroundContext.js
init_esbuild_shims();
var import_react10 = __toESM(require_react(), 1);
var backgroundContext = (0, import_react10.createContext)(void 0);

// node_modules/ink/build/components/Box.js
var Box = (0, import_react11.forwardRef)(({ children, backgroundColor, "aria-label": ariaLabel, "aria-hidden": ariaHidden, "aria-role": role, "aria-state": ariaState, ...style }, ref) => {
  const { isScreenReaderEnabled } = (0, import_react11.useContext)(accessibilityContext);
  const label = ariaLabel ? import_react11.default.createElement("ink-text", null, ariaLabel) : void 0;
  if (isScreenReaderEnabled && ariaHidden) {
    return null;
  }
  const boxElement = import_react11.default.createElement("ink-box", { ref, style: {
    flexWrap: "nowrap",
    flexDirection: "row",
    flexGrow: 0,
    flexShrink: 1,
    ...style,
    backgroundColor,
    overflowX: style.overflowX ?? style.overflow ?? "visible",
    overflowY: style.overflowY ?? style.overflow ?? "visible"
  }, internal_accessibility: {
    role,
    state: ariaState
  } }, isScreenReaderEnabled && label ? label : children);
  if (backgroundColor) {
    return import_react11.default.createElement(backgroundContext.Provider, { value: backgroundColor }, boxElement);
  }
  return boxElement;
});
Box.displayName = "Box";
var Box_default = Box;

// node_modules/ink/build/components/Text.js
init_esbuild_shims();
var import_react12 = __toESM(require_react(), 1);
function Text({ color, backgroundColor, dimColor = false, bold = false, italic = false, underline = false, strikethrough = false, inverse = false, wrap = "wrap", selectable = true, selectionFlow, selectionBreakAfter, selectionJoiner = "", children, "aria-label": ariaLabel, "aria-hidden": ariaHidden = false }) {
  const { isScreenReaderEnabled } = (0, import_react12.useContext)(accessibilityContext);
  const inheritedBackgroundColor = (0, import_react12.useContext)(backgroundContext);
  const childrenOrAriaLabel = isScreenReaderEnabled && ariaLabel ? ariaLabel : children;
  if (childrenOrAriaLabel === void 0 || childrenOrAriaLabel === null) {
    return null;
  }
  const transform = /* @__PURE__ */ __name((children2) => {
    if (dimColor) {
      children2 = source_default.dim(children2);
    }
    if (color) {
      children2 = colorize_default(children2, color, "foreground");
    }
    const effectiveBackgroundColor = backgroundColor ?? inheritedBackgroundColor;
    if (effectiveBackgroundColor) {
      children2 = colorize_default(children2, effectiveBackgroundColor, "background");
    }
    if (bold) {
      children2 = source_default.bold(children2);
    }
    if (italic) {
      children2 = source_default.italic(children2);
    }
    if (underline) {
      children2 = source_default.underline(children2);
    }
    if (strikethrough) {
      children2 = source_default.strikethrough(children2);
    }
    if (inverse) {
      children2 = source_default.inverse(children2);
    }
    return children2;
  }, "transform");
  if (isScreenReaderEnabled && ariaHidden) {
    return null;
  }
  return import_react12.default.createElement("ink-text", { style: { flexGrow: 0, flexShrink: 1, flexDirection: "row", textWrap: wrap }, internal_transform: transform, selectable, selectionFlow, selectionBreakAfter, selectionJoiner }, childrenOrAriaLabel);
}
__name(Text, "Text");

// node_modules/ink/build/components/ErrorOverview.js
var cleanupPath = /* @__PURE__ */ __name((path) => {
  return path?.replace(`file://${cwd()}/`, "");
}, "cleanupPath");
var stackUtils = new import_stack_utils.default({
  cwd: cwd(),
  internals: import_stack_utils.default.nodeInternals()
});
function ErrorOverview({ error }) {
  const stack = error.stack ? error.stack.split("\n").slice(1) : void 0;
  const origin = stack ? stackUtils.parseLine(stack[0]) : void 0;
  const filePath = cleanupPath(origin?.file);
  let excerpt;
  let lineWidth = 0;
  if (filePath && origin?.line && fs2.existsSync(filePath)) {
    const sourceCode = fs2.readFileSync(filePath, "utf8");
    excerpt = dist_default3(sourceCode, origin.line);
    if (excerpt) {
      for (const { line } of excerpt) {
        lineWidth = Math.max(lineWidth, String(line).length);
      }
    }
  }
  return import_react13.default.createElement(
    Box_default,
    { flexDirection: "column", padding: 1 },
    import_react13.default.createElement(
      Box_default,
      null,
      import_react13.default.createElement(
        Text,
        { backgroundColor: "red", color: "white" },
        " ",
        "ERROR",
        " "
      ),
      import_react13.default.createElement(
        Text,
        null,
        " ",
        error.message
      )
    ),
    origin && filePath ? import_react13.default.createElement(
      Box_default,
      { marginTop: 1 },
      import_react13.default.createElement(
        Text,
        { dimColor: true },
        filePath,
        ":",
        origin.line,
        ":",
        origin.column
      )
    ) : null,
    origin && excerpt ? import_react13.default.createElement(Box_default, { marginTop: 1, flexDirection: "column" }, excerpt.map(({ line, value }) => import_react13.default.createElement(
      Box_default,
      { key: line },
      import_react13.default.createElement(
        Box_default,
        { width: lineWidth + 1 },
        import_react13.default.createElement(
          Text,
          { dimColor: line !== origin.line, backgroundColor: line === origin.line ? "red" : void 0, color: line === origin.line ? "white" : void 0, "aria-label": line === origin.line ? `Line ${line}, error` : `Line ${line}` },
          String(line).padStart(lineWidth, " "),
          ":"
        )
      ),
      import_react13.default.createElement(Text, { key: line, backgroundColor: line === origin.line ? "red" : void 0, color: line === origin.line ? "white" : void 0 }, " " + value)
    ))) : null,
    error.stack ? import_react13.default.createElement(Box_default, { marginTop: 1, flexDirection: "column" }, error.stack.split("\n").slice(1).map((line) => {
      const parsedLine = stackUtils.parseLine(line);
      if (!parsedLine) {
        return import_react13.default.createElement(
          Box_default,
          { key: line },
          import_react13.default.createElement(Text, { dimColor: true }, "- "),
          import_react13.default.createElement(
            Text,
            { dimColor: true, bold: true },
            line,
            "\\t",
            " "
          )
        );
      }
      return import_react13.default.createElement(
        Box_default,
        { key: line },
        import_react13.default.createElement(Text, { dimColor: true }, "- "),
        import_react13.default.createElement(Text, { dimColor: true, bold: true }, parsedLine.function),
        import_react13.default.createElement(
          Text,
          { dimColor: true, color: "gray", "aria-label": `at ${cleanupPath(parsedLine.file) ?? ""} line ${parsedLine.line} column ${parsedLine.column}` },
          " ",
          "(",
          cleanupPath(parsedLine.file) ?? "",
          ":",
          parsedLine.line,
          ":",
          parsedLine.column,
          ")"
        )
      );
    })) : null
  );
}
__name(ErrorOverview, "ErrorOverview");

// node_modules/ink/build/components/ErrorBoundary.js
var ErrorBoundary = class extends import_react14.PureComponent {
  static {
    __name(this, "ErrorBoundary");
  }
  static displayName = "InternalErrorBoundary";
  static getDerivedStateFromError(error) {
    return { error };
  }
  state = {
    error: void 0
  };
  componentDidCatch(error) {
    this.props.onError(error);
  }
  render() {
    if (this.state.error) {
      return import_react14.default.createElement(ErrorOverview, { error: this.state.error });
    }
    return this.props.children;
  }
};

// node_modules/ink/build/components/App.js
var tab = "	";
var shiftTab = "\x1B[Z";
var escape2 = "\x1B";
function App({ children, stdin, stdout, stderr, writeToStdout, writeToStderr, exitOnCtrlC, onExit, onWaitUntilRenderFlush, setCursorPosition, interactive, renderThrottleMs }) {
  const [isFocusEnabled, setIsFocusEnabled] = (0, import_react15.useState)(true);
  const [activeFocusId, setActiveFocusId] = (0, import_react15.useState)(void 0);
  const [, setFocusables] = (0, import_react15.useState)([]);
  const focusablesCountRef = (0, import_react15.useRef)(0);
  const animationSubscribersRef = (0, import_react15.useRef)(/* @__PURE__ */ new Map());
  const animationTimerRef = (0, import_react15.useRef)(void 0);
  const rawModeEnabledCount = (0, import_react15.useRef)(0);
  const pendingDisableRawModeRef = (0, import_react15.useRef)(false);
  const bracketedPasteModeEnabledCount = (0, import_react15.useRef)(0);
  const internal_eventEmitter = (0, import_react15.useRef)(new EventEmitter2());
  internal_eventEmitter.current.setMaxListeners(Infinity);
  const readableListenerRef = (0, import_react15.useRef)(void 0);
  const inputParserRef = (0, import_react15.useRef)(createInputParser());
  const pendingInputFlushRef = (0, import_react15.useRef)(void 0);
  const pendingInputFlushDelayMilliseconds = 20;
  const clearPendingInputFlush = (0, import_react15.useCallback)(() => {
    if (!pendingInputFlushRef.current) {
      return;
    }
    clearTimeout(pendingInputFlushRef.current);
    pendingInputFlushRef.current = void 0;
  }, []);
  const clearAnimationTimer = (0, import_react15.useCallback)(() => {
    if (!animationTimerRef.current) {
      return;
    }
    clearTimeout(animationTimerRef.current);
    animationTimerRef.current = void 0;
  }, []);
  const scheduleAnimationTick = (0, import_react15.useCallback)(() => {
    clearAnimationTimer();
    if (animationSubscribersRef.current.size === 0) {
      return;
    }
    let nextDueTime = Number.POSITIVE_INFINITY;
    for (const subscriber of animationSubscribersRef.current.values()) {
      nextDueTime = Math.min(nextDueTime, subscriber.nextDueTime);
    }
    const delay = Math.max(0, nextDueTime - performance.now());
    animationTimerRef.current = setTimeout(() => {
      animationTimerRef.current = void 0;
      const currentTime = performance.now();
      for (const subscriber of animationSubscribersRef.current.values()) {
        if (currentTime < subscriber.nextDueTime) {
          continue;
        }
        subscriber.callback(currentTime);
        const elapsedTime = currentTime - subscriber.startTime;
        const elapsedFrames = Math.floor(elapsedTime / subscriber.interval) + 1;
        subscriber.nextDueTime = subscriber.startTime + elapsedFrames * subscriber.interval;
      }
      scheduleAnimationTick();
    }, delay);
  }, [clearAnimationTimer]);
  const animationSubscribe = (0, import_react15.useCallback)((callback, interval) => {
    const startTime = performance.now();
    animationSubscribersRef.current.set(callback, {
      callback,
      interval,
      startTime,
      nextDueTime: startTime + interval
    });
    scheduleAnimationTick();
    return {
      startTime,
      unsubscribe() {
        animationSubscribersRef.current.delete(callback);
        if (animationSubscribersRef.current.size === 0) {
          clearAnimationTimer();
          return;
        }
        scheduleAnimationTick();
      }
    };
  }, [clearAnimationTimer, scheduleAnimationTick]);
  (0, import_react15.useEffect)(() => {
    return () => {
      clearAnimationTimer();
    };
  }, [clearAnimationTimer]);
  const isRawModeSupported = stdin.isTTY;
  const detachReadableListener = (0, import_react15.useCallback)(() => {
    if (!readableListenerRef.current) {
      return;
    }
    stdin.removeListener("readable", readableListenerRef.current);
    readableListenerRef.current = void 0;
  }, [stdin]);
  const clearInputState = (0, import_react15.useCallback)(() => {
    inputParserRef.current.reset();
    clearPendingInputFlush();
    detachReadableListener();
  }, [clearPendingInputFlush, detachReadableListener]);
  const disableRawMode = (0, import_react15.useCallback)(() => {
    pendingDisableRawModeRef.current = false;
    stdin.setRawMode(false);
    stdin.unref();
    rawModeEnabledCount.current = 0;
    clearInputState();
  }, [stdin, clearInputState]);
  const handleExit = (0, import_react15.useCallback)((errorOrResult) => {
    if (isRawModeSupported && (rawModeEnabledCount.current > 0 || pendingDisableRawModeRef.current)) {
      disableRawMode();
    }
    onExit(errorOrResult);
  }, [isRawModeSupported, disableRawMode, onExit]);
  const handleInput = (0, import_react15.useCallback)((input) => {
    if (input === "" && exitOnCtrlC) {
      handleExit();
      return;
    }
    if (input === escape2 && isFocusEnabled) {
      setActiveFocusId(void 0);
    }
  }, [exitOnCtrlC, handleExit, isFocusEnabled]);
  const emitInput = (0, import_react15.useCallback)((input) => {
    handleInput(input);
    internal_eventEmitter.current.emit("input", input);
  }, [handleInput]);
  const schedulePendingInputFlush = (0, import_react15.useCallback)(() => {
    clearPendingInputFlush();
    pendingInputFlushRef.current = setTimeout(() => {
      pendingInputFlushRef.current = void 0;
      const pendingEscape = inputParserRef.current.flushPendingEscape();
      if (!pendingEscape) {
        return;
      }
      emitInput(pendingEscape);
    }, pendingInputFlushDelayMilliseconds);
  }, [clearPendingInputFlush, emitInput]);
  const handleReadable = (0, import_react15.useCallback)(() => {
    clearPendingInputFlush();
    let chunk;
    while ((chunk = stdin.read()) !== null) {
      const inputEvents = inputParserRef.current.push(chunk);
      for (const event of inputEvents) {
        if (typeof event === "string") {
          emitInput(event);
        } else {
          if (internal_eventEmitter.current.listenerCount("paste") === 0) {
            emitInput(event.paste);
            continue;
          }
          internal_eventEmitter.current.emit("paste", event.paste);
        }
      }
    }
    if (inputParserRef.current.hasPendingEscape()) {
      schedulePendingInputFlush();
    }
  }, [stdin, emitInput, clearPendingInputFlush, schedulePendingInputFlush]);
  const attachReadableListener = (0, import_react15.useCallback)(() => {
    if (readableListenerRef.current) {
      return;
    }
    readableListenerRef.current = handleReadable;
    stdin.addListener("readable", handleReadable);
  }, [stdin, handleReadable]);
  const handleSetRawMode = (0, import_react15.useCallback)((isEnabled) => {
    if (!isRawModeSupported) {
      if (stdin === process11.stdin) {
        throw new Error("Raw mode is not supported on the current process.stdin, which Ink uses as input stream by default.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported");
      } else {
        throw new Error("Raw mode is not supported on the stdin provided to Ink.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported");
      }
    }
    stdin.setEncoding("utf8");
    if (isEnabled) {
      if (rawModeEnabledCount.current === 0) {
        const isRawModeAlreadyEnabled = pendingDisableRawModeRef.current;
        pendingDisableRawModeRef.current = false;
        if (!isRawModeAlreadyEnabled) {
          stdin.ref();
          stdin.setRawMode(true);
        }
        attachReadableListener();
      }
      rawModeEnabledCount.current++;
      return;
    }
    if (rawModeEnabledCount.current === 0) {
      return;
    }
    if (--rawModeEnabledCount.current === 0) {
      clearInputState();
      pendingDisableRawModeRef.current = true;
      queueMicrotask(() => {
        if (!pendingDisableRawModeRef.current) {
          return;
        }
        disableRawMode();
      });
    }
  }, [
    isRawModeSupported,
    stdin,
    attachReadableListener,
    clearInputState,
    disableRawMode
  ]);
  const handleSetBracketedPasteMode = (0, import_react15.useCallback)((isEnabled) => {
    if (!stdout.isTTY) {
      return;
    }
    if (isEnabled) {
      if (bracketedPasteModeEnabledCount.current === 0) {
        stdout.write("\x1B[?2004h");
      }
      bracketedPasteModeEnabledCount.current++;
      return;
    }
    if (bracketedPasteModeEnabledCount.current === 0) {
      return;
    }
    if (--bracketedPasteModeEnabledCount.current === 0) {
      stdout.write("\x1B[?2004l");
    }
  }, [stdout]);
  const findNextFocusable = (0, import_react15.useCallback)((currentFocusables, currentActiveFocusId) => {
    const activeIndex = currentFocusables.findIndex((focusable) => {
      return focusable.id === currentActiveFocusId;
    });
    for (let index = activeIndex + 1; index < currentFocusables.length; index++) {
      const focusable = currentFocusables[index];
      if (focusable?.isActive) {
        return focusable.id;
      }
    }
    return void 0;
  }, []);
  const findPreviousFocusable = (0, import_react15.useCallback)((currentFocusables, currentActiveFocusId) => {
    const activeIndex = currentFocusables.findIndex((focusable) => {
      return focusable.id === currentActiveFocusId;
    });
    for (let index = activeIndex - 1; index >= 0; index--) {
      const focusable = currentFocusables[index];
      if (focusable?.isActive) {
        return focusable.id;
      }
    }
    return void 0;
  }, []);
  const focusNext = (0, import_react15.useCallback)(() => {
    setFocusables((currentFocusables) => {
      setActiveFocusId((currentActiveFocusId) => {
        const firstFocusableId = currentFocusables.find((focusable) => focusable.isActive)?.id;
        const nextFocusableId = findNextFocusable(currentFocusables, currentActiveFocusId);
        return nextFocusableId ?? firstFocusableId;
      });
      return currentFocusables;
    });
  }, [findNextFocusable]);
  const focusPrevious = (0, import_react15.useCallback)(() => {
    setFocusables((currentFocusables) => {
      setActiveFocusId((currentActiveFocusId) => {
        const lastFocusableId = currentFocusables.findLast((focusable) => focusable.isActive)?.id;
        const previousFocusableId = findPreviousFocusable(currentFocusables, currentActiveFocusId);
        return previousFocusableId ?? lastFocusableId;
      });
      return currentFocusables;
    });
  }, [findPreviousFocusable]);
  (0, import_react15.useEffect)(() => {
    const handleTabNavigation = /* @__PURE__ */ __name((input) => {
      if (!isFocusEnabled || focusablesCountRef.current === 0)
        return;
      if (input === tab) {
        focusNext();
      }
      if (input === shiftTab) {
        focusPrevious();
      }
    }, "handleTabNavigation");
    internal_eventEmitter.current.on("input", handleTabNavigation);
    const emitter = internal_eventEmitter.current;
    return () => {
      emitter.off("input", handleTabNavigation);
    };
  }, [isFocusEnabled, focusNext, focusPrevious]);
  const enableFocus = (0, import_react15.useCallback)(() => {
    setIsFocusEnabled(true);
  }, []);
  const disableFocus = (0, import_react15.useCallback)(() => {
    setIsFocusEnabled(false);
  }, []);
  const focus = (0, import_react15.useCallback)((id) => {
    setFocusables((currentFocusables) => {
      const hasFocusableId = currentFocusables.some((focusable) => focusable?.id === id);
      if (hasFocusableId) {
        setActiveFocusId(id);
      }
      return currentFocusables;
    });
  }, []);
  const addFocusable = (0, import_react15.useCallback)((id, { autoFocus }) => {
    setFocusables((currentFocusables) => {
      focusablesCountRef.current = currentFocusables.length + 1;
      return [
        ...currentFocusables,
        {
          id,
          isActive: true
        }
      ];
    });
    if (autoFocus) {
      setActiveFocusId((currentActiveFocusId) => {
        if (!currentActiveFocusId) {
          return id;
        }
        return currentActiveFocusId;
      });
    }
  }, []);
  const removeFocusable = (0, import_react15.useCallback)((id) => {
    setActiveFocusId((currentActiveFocusId) => {
      if (currentActiveFocusId === id) {
        return void 0;
      }
      return currentActiveFocusId;
    });
    setFocusables((currentFocusables) => {
      const filtered = currentFocusables.filter((focusable) => {
        return focusable.id !== id;
      });
      focusablesCountRef.current = filtered.length;
      return filtered;
    });
  }, []);
  const activateFocusable = (0, import_react15.useCallback)((id) => {
    setFocusables((currentFocusables) => currentFocusables.map((focusable) => {
      if (focusable.id !== id) {
        return focusable;
      }
      return {
        id,
        isActive: true
      };
    }));
  }, []);
  const deactivateFocusable = (0, import_react15.useCallback)((id) => {
    setActiveFocusId((currentActiveFocusId) => {
      if (currentActiveFocusId === id) {
        return void 0;
      }
      return currentActiveFocusId;
    });
    setFocusables((currentFocusables) => currentFocusables.map((focusable) => {
      if (focusable.id !== id) {
        return focusable;
      }
      return {
        id,
        isActive: false
      };
    }));
  }, []);
  (0, import_react15.useEffect)(() => {
    return () => {
      const canWriteToStdout = !stdout.destroyed && !stdout.writableEnded;
      if (interactive && canWriteToStdout) {
        cli_cursor_default.show(stdout);
      }
      if (isRawModeSupported && (rawModeEnabledCount.current > 0 || pendingDisableRawModeRef.current)) {
        disableRawMode();
      }
      if (bracketedPasteModeEnabledCount.current > 0) {
        if (stdout.isTTY && canWriteToStdout) {
          stdout.write("\x1B[?2004l");
        }
        bracketedPasteModeEnabledCount.current = 0;
      }
    };
  }, [stdout, isRawModeSupported, disableRawMode, interactive]);
  const appContextValue = (0, import_react15.useMemo)(() => ({
    exit: handleExit,
    waitUntilRenderFlush: onWaitUntilRenderFlush
  }), [handleExit, onWaitUntilRenderFlush]);
  const stdinContextValue = (0, import_react15.useMemo)(() => ({
    stdin,
    setRawMode: handleSetRawMode,
    setBracketedPasteMode: handleSetBracketedPasteMode,
    isRawModeSupported,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    internal_exitOnCtrlC: exitOnCtrlC,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    internal_eventEmitter: internal_eventEmitter.current
  }), [
    stdin,
    handleSetRawMode,
    handleSetBracketedPasteMode,
    isRawModeSupported,
    exitOnCtrlC
  ]);
  const stdoutContextValue = (0, import_react15.useMemo)(() => ({
    stdout,
    write: writeToStdout
  }), [stdout, writeToStdout]);
  const stderrContextValue = (0, import_react15.useMemo)(() => ({
    stderr,
    write: writeToStderr
  }), [stderr, writeToStderr]);
  const cursorContextValue = (0, import_react15.useMemo)(() => ({
    setCursorPosition
  }), [setCursorPosition]);
  const focusContextValue = (0, import_react15.useMemo)(() => ({
    activeId: activeFocusId,
    add: addFocusable,
    remove: removeFocusable,
    activate: activateFocusable,
    deactivate: deactivateFocusable,
    enableFocus,
    disableFocus,
    focusNext,
    focusPrevious,
    focus
  }), [
    activeFocusId,
    addFocusable,
    removeFocusable,
    activateFocusable,
    deactivateFocusable,
    enableFocus,
    disableFocus,
    focusNext,
    focusPrevious,
    focus
  ]);
  const animationContextValue = (0, import_react15.useMemo)(() => ({
    renderThrottleMs,
    subscribe: animationSubscribe
  }), [animationSubscribe, renderThrottleMs]);
  return import_react15.default.createElement(
    AppContext_default.Provider,
    { value: appContextValue },
    import_react15.default.createElement(
      StdinContext_default.Provider,
      { value: stdinContextValue },
      import_react15.default.createElement(
        StdoutContext_default.Provider,
        { value: stdoutContextValue },
        import_react15.default.createElement(
          StderrContext_default.Provider,
          { value: stderrContextValue },
          import_react15.default.createElement(
            FocusContext_default.Provider,
            { value: focusContextValue },
            import_react15.default.createElement(
              AnimationContext_default.Provider,
              { value: animationContextValue },
              import_react15.default.createElement(
                CursorContext_default.Provider,
                { value: cursorContextValue },
                import_react15.default.createElement(ErrorBoundary, { onError: handleExit }, children)
              )
            )
          )
        )
      )
    )
  );
}
__name(App, "App");
App.displayName = "InternalApp";
var App_default = App;

// node_modules/ink/build/kitty-keyboard.js
init_esbuild_shims();
var kittyFlags = {
  disambiguateEscapeCodes: 1,
  reportEventTypes: 2,
  reportAlternateKeys: 4,
  reportAllKeysAsEscapeCodes: 8,
  reportAssociatedText: 16
};
function resolveFlags(flags) {
  let result = 0;
  for (const flag of flags) {
    result |= kittyFlags[flag];
  }
  return result;
}
__name(resolveFlags, "resolveFlags");
var kittyModifiers = {
  shift: 1,
  alt: 2,
  ctrl: 4,
  super: 8,
  hyper: 16,
  meta: 32,
  capsLock: 64,
  numLock: 128
};

// node_modules/ink/build/ink.js
var noop = /* @__PURE__ */ __name(() => {
}, "noop");
var textEncoder = new TextEncoder();
var yieldImmediate = /* @__PURE__ */ __name(async () => new Promise((resolve) => {
  setImmediate(resolve);
}), "yieldImmediate");
var kittyQueryEscapeByte = 27;
var kittyQueryOpenBracketByte = 91;
var kittyQueryQuestionMarkByte = 63;
var kittyQueryLetterByte = 117;
var zeroByte = 48;
var nineByte = 57;
var isDigitByte = /* @__PURE__ */ __name((byte) => byte >= zeroByte && byte <= nineByte, "isDigitByte");
var matchKittyQueryResponse = /* @__PURE__ */ __name((buffer, startIndex) => {
  if (buffer[startIndex] !== kittyQueryEscapeByte || buffer[startIndex + 1] !== kittyQueryOpenBracketByte || buffer[startIndex + 2] !== kittyQueryQuestionMarkByte) {
    return void 0;
  }
  let index = startIndex + 3;
  const digitsStartIndex = index;
  while (index < buffer.length && isDigitByte(buffer[index])) {
    index++;
  }
  if (index === digitsStartIndex) {
    return void 0;
  }
  if (index === buffer.length) {
    return { state: "partial" };
  }
  if (buffer[index] === kittyQueryLetterByte) {
    return { state: "complete", endIndex: index };
  }
  return void 0;
}, "matchKittyQueryResponse");
var hasCompleteKittyQueryResponse = /* @__PURE__ */ __name((buffer) => {
  for (let index = 0; index < buffer.length; index++) {
    const match = matchKittyQueryResponse(buffer, index);
    if (match?.state === "complete") {
      return true;
    }
  }
  return false;
}, "hasCompleteKittyQueryResponse");
var stripKittyQueryResponsesAndTrailingPartial = /* @__PURE__ */ __name((buffer) => {
  const keptBytes = [];
  let index = 0;
  while (index < buffer.length) {
    const match = matchKittyQueryResponse(buffer, index);
    if (match?.state === "complete") {
      index = match.endIndex + 1;
      continue;
    }
    if (match?.state === "partial") {
      break;
    }
    keptBytes.push(buffer[index]);
    index++;
  }
  return keptBytes;
}, "stripKittyQueryResponsesAndTrailingPartial");
var shouldClearTerminalForFrame = /* @__PURE__ */ __name(({ isTty, viewportRows, previousOutputHeight, nextOutputHeight, isUnmounting }) => {
  if (!isTty) {
    return false;
  }
  const hadPreviousFrame = previousOutputHeight > 0;
  const wasFullscreen = previousOutputHeight >= viewportRows;
  const wasOverflowing = previousOutputHeight > viewportRows;
  const isOverflowing = nextOutputHeight > viewportRows;
  const isLeavingFullscreen = wasFullscreen && nextOutputHeight < viewportRows;
  const shouldClearOnUnmount = isUnmounting && wasFullscreen;
  return (
    // Overflowing frames still need full clear fallback.
    wasOverflowing || isOverflowing && hadPreviousFrame || // Clear when shrinking from fullscreen to non-fullscreen output.
    isLeavingFullscreen || // Preserve legacy unmount behavior for fullscreen frames: final teardown
    // render should clear once to avoid leaving a scrolled viewport state.
    shouldClearOnUnmount
  );
}, "shouldClearTerminalForFrame");
var isErrorInput = /* @__PURE__ */ __name((value) => {
  return value instanceof Error || Object.prototype.toString.call(value) === "[object Error]";
}, "isErrorInput");
var getWritableStreamState = /* @__PURE__ */ __name((stdout) => {
  const canWriteToStdout = !stdout.destroyed && !stdout.writableEnded && (stdout.writable ?? true);
  const hasWritableState = stdout._writableState !== void 0 || stdout.writableLength !== void 0;
  return {
    canWriteToStdout,
    hasWritableState
  };
}, "getWritableStreamState");
var settleThrottle = /* @__PURE__ */ __name((throttled, canWriteToStdout) => {
  if (!throttled || typeof throttled.flush !== "function") {
    return;
  }
  const throttledValue = throttled;
  if (canWriteToStdout) {
    throttledValue.flush();
  } else if (typeof throttledValue.cancel === "function") {
    throttledValue.cancel();
  }
}, "settleThrottle");
var Ink = class {
  static {
    __name(this, "Ink");
  }
  /**
  Whether this instance is using concurrent rendering mode.
  */
  isConcurrent;
  options;
  log;
  cursorPosition;
  throttledLog;
  isScreenReaderEnabled;
  interactive;
  renderThrottleMs;
  alternateScreen;
  // Ignore last render after unmounting a tree to prevent empty output before exit
  isUnmounted;
  isUnmounting;
  lastOutput;
  lastOutputToRender;
  lastOutputHeight;
  lastTerminalWidth;
  container;
  rootNode;
  // This variable is used only in debug mode to store full static output
  // so that it's rerendered every time, not just new static parts, like in non-debug mode
  fullStaticOutput;
  exitPromise;
  exitResult;
  beforeExitHandler;
  restoreConsole;
  unsubscribeResize;
  throttledOnRender;
  hasPendingThrottledRender = false;
  kittyProtocolEnabled = false;
  cancelKittyDetection;
  nextRenderCommit;
  frameController;
  constructor(options) {
    autoBind(this);
    this.options = options;
    this.rootNode = createNode("ink-root");
    this.rootNode.onComputeLayout = this.calculateLayout;
    this.isScreenReaderEnabled = options.isScreenReaderEnabled ?? process12.env["INK_SCREEN_READER"] === "true";
    this.interactive = this.resolveInteractiveOption(options.interactive);
    this.alternateScreen = false;
    const unthrottled = options.debug || this.isScreenReaderEnabled;
    const maxFps = options.maxFps ?? 30;
    const renderThrottleMs = maxFps > 0 ? Math.max(1, Math.ceil(1e3 / maxFps)) : 0;
    this.renderThrottleMs = unthrottled ? 0 : renderThrottleMs;
    if (unthrottled) {
      this.rootNode.onRender = this.onRender;
      this.throttledOnRender = void 0;
    } else {
      const throttled = throttle(this.onRender, renderThrottleMs, {
        leading: true,
        trailing: true
      });
      this.rootNode.onRender = () => {
        this.hasPendingThrottledRender = true;
        throttled();
      };
      this.throttledOnRender = throttled;
    }
    this.rootNode.onImmediateRender = this.onRender;
    this.frameController = createFrameController(() => {
      this.rootNode.onRender?.();
    });
    this.rootNode.onStaticChange = this.handleStaticChange;
    this.log = log_update_default.create(options.stdout, {
      incremental: options.incrementalRendering
    });
    this.cursorPosition = void 0;
    this.throttledLog = unthrottled ? this.log : throttle((output) => {
      const shouldWrite = this.log.willRender(output);
      const sync = this.shouldSync();
      if (sync && shouldWrite) {
        this.options.stdout.write(bsu);
      }
      this.log(output);
      if (sync && shouldWrite) {
        this.options.stdout.write(esu);
      }
    }, void 0, {
      leading: true,
      trailing: true
    });
    this.isUnmounted = false;
    this.isUnmounting = false;
    this.isConcurrent = options.concurrent ?? false;
    this.lastOutput = "";
    this.lastOutputToRender = "";
    this.lastOutputHeight = 0;
    this.lastTerminalWidth = getWindowSize(this.options.stdout).columns;
    this.fullStaticOutput = "";
    const rootTag = options.concurrent ? import_constants2.ConcurrentRoot : import_constants2.LegacyRoot;
    this.container = reconciler_default.createContainer(this.rootNode, rootTag, null, false, null, "id", () => {
    }, () => {
    }, () => {
    }, () => {
    });
    this.unsubscribeExit = (0, import_signal_exit2.default)(this.unmount, { alwaysLast: false });
    this.setAlternateScreen(Boolean(options.alternateScreen));
    if (process12.env["DEV"] === "true") {
      reconciler_default.injectIntoDevTools();
    }
    if (options.patchConsole) {
      this.patchConsole();
    }
    if (this.interactive) {
      options.stdout.on("resize", this.resized);
      this.unsubscribeResize = () => {
        options.stdout.off("resize", this.resized);
      };
    }
    this.initKittyKeyboard();
    this.exitPromise = new Promise((resolve, reject) => {
      this.resolveExitPromise = resolve;
      this.rejectExitPromise = reject;
    });
    void this.exitPromise.catch(noop);
  }
  resized = /* @__PURE__ */ __name(() => {
    const currentWidth = getWindowSize(this.options.stdout).columns;
    if (currentWidth < this.lastTerminalWidth) {
      this.log.clear();
      this.lastOutput = "";
      this.lastOutputToRender = "";
    }
    this.calculateLayout();
    this.onRender();
    this.lastTerminalWidth = currentWidth;
  }, "resized");
  resolveExitPromise = /* @__PURE__ */ __name(() => {
  }, "resolveExitPromise");
  rejectExitPromise = /* @__PURE__ */ __name(() => {
  }, "rejectExitPromise");
  unsubscribeExit = /* @__PURE__ */ __name(() => {
  }, "unsubscribeExit");
  handleAppExit = /* @__PURE__ */ __name((errorOrResult) => {
    if (this.isUnmounted || this.isUnmounting) {
      return;
    }
    if (isErrorInput(errorOrResult)) {
      this.unmount(errorOrResult);
      return;
    }
    this.exitResult = errorOrResult;
    this.unmount();
  }, "handleAppExit");
  setCursorPosition = /* @__PURE__ */ __name((position) => {
    this.cursorPosition = position;
    this.log.setCursorPosition(position);
  }, "setCursorPosition");
  restoreLastOutput = /* @__PURE__ */ __name(() => {
    if (!this.interactive) {
      return;
    }
    this.log.setCursorPosition(this.cursorPosition);
    this.log(this.lastOutputToRender || this.lastOutput + "\n");
  }, "restoreLastOutput");
  calculateLayout = /* @__PURE__ */ __name(() => {
    const terminalWidth = getWindowSize(this.options.stdout).columns;
    this.rootNode.yogaNode.setWidth(terminalWidth);
    this.rootNode.yogaNode.calculateLayout(void 0, void 0, src_default.DIRECTION_LTR);
  }, "calculateLayout");
  // Resets `fullStaticOutput` when the <Static> identity changes so stale items from a previous instance are not replayed on future rewrites.
  handleStaticChange = /* @__PURE__ */ __name(() => {
    this.fullStaticOutput = "";
  }, "handleStaticChange");
  onRender = /* @__PURE__ */ __name(() => {
    this.hasPendingThrottledRender = false;
    if (this.isUnmounted) {
      return;
    }
    if (this.nextRenderCommit) {
      this.nextRenderCommit.resolve();
      this.nextRenderCommit = void 0;
    }
    const startTime = performance.now();
    const selection = this.frameController?.getSelection() ?? null;
    const { output, outputHeight, staticOutput, cells, boundaries } = renderer_default(this.rootNode, this.isScreenReaderEnabled, selection);
    if (cells && this.frameController) {
      this.frameController.publishFrame({
        width: cells.reduce((width, row) => Math.max(width, row.length), 0),
        height: cells.length,
        cells,
        boundaries: boundaries ?? []
      });
    }
    this.options.onRender?.({ renderTime: performance.now() - startTime });
    const hasStaticOutput = staticOutput && staticOutput !== "\n";
    if (this.options.debug) {
      if (hasStaticOutput) {
        this.fullStaticOutput += staticOutput;
      }
      this.lastOutput = output;
      this.lastOutputToRender = output;
      this.lastOutputHeight = outputHeight;
      this.options.stdout.write(this.fullStaticOutput + output);
      return;
    }
    if (!this.interactive) {
      if (hasStaticOutput) {
        this.options.stdout.write(staticOutput);
      }
      this.lastOutput = output;
      this.lastOutputToRender = output + "\n";
      this.lastOutputHeight = outputHeight;
      return;
    }
    if (this.isScreenReaderEnabled) {
      const sync = this.shouldSync();
      if (sync) {
        this.options.stdout.write(bsu);
      }
      if (hasStaticOutput) {
        const erase = this.lastOutputHeight > 0 ? base_exports.eraseLines(this.lastOutputHeight) : "";
        this.options.stdout.write(erase + staticOutput);
        this.lastOutputHeight = 0;
      }
      if (output === this.lastOutput && !hasStaticOutput) {
        if (sync) {
          this.options.stdout.write(esu);
        }
        return;
      }
      const terminalWidth = getWindowSize(this.options.stdout).columns;
      const wrappedOutput = wrapAnsi(output, terminalWidth, {
        trim: false,
        hard: true
      });
      if (hasStaticOutput) {
        this.options.stdout.write(wrappedOutput);
      } else {
        const erase = this.lastOutputHeight > 0 ? base_exports.eraseLines(this.lastOutputHeight) : "";
        this.options.stdout.write(erase + wrappedOutput);
      }
      this.lastOutput = output;
      this.lastOutputToRender = wrappedOutput;
      this.lastOutputHeight = wrappedOutput === "" ? 0 : wrappedOutput.split("\n").length;
      if (sync) {
        this.options.stdout.write(esu);
      }
      return;
    }
    if (hasStaticOutput) {
      this.fullStaticOutput += staticOutput;
    }
    this.renderInteractiveFrame(output, outputHeight, hasStaticOutput ? staticOutput : "");
  }, "onRender");
  render(node) {
    const tree = import_react16.default.createElement(
      accessibilityContext.Provider,
      { value: { isScreenReaderEnabled: this.isScreenReaderEnabled } },
      import_react16.default.createElement(App_default, { stdin: this.options.stdin, stdout: this.options.stdout, stderr: this.options.stderr, exitOnCtrlC: this.options.exitOnCtrlC, interactive: this.interactive, renderThrottleMs: this.renderThrottleMs, writeToStdout: this.writeToStdout, writeToStderr: this.writeToStderr, setCursorPosition: this.setCursorPosition, onExit: this.handleAppExit, onWaitUntilRenderFlush: this.waitUntilRenderFlush }, node)
    );
    if (this.options.concurrent) {
      reconciler_default.updateContainer(tree, this.container, null, noop);
    } else {
      reconciler_default.updateContainerSync(tree, this.container, null, noop);
      reconciler_default.flushSyncWork();
    }
  }
  writeToStdout(data) {
    if (this.isUnmounted) {
      return;
    }
    if (this.options.debug) {
      this.options.stdout.write(data + this.fullStaticOutput + this.lastOutput);
      return;
    }
    if (!this.interactive) {
      this.options.stdout.write(data);
      return;
    }
    const sync = this.shouldSync();
    if (sync) {
      this.options.stdout.write(bsu);
    }
    this.log.clear();
    this.options.stdout.write(data);
    this.restoreLastOutput();
    if (sync) {
      this.options.stdout.write(esu);
    }
  }
  writeToStderr(data) {
    if (this.isUnmounted) {
      return;
    }
    if (this.options.debug) {
      this.options.stderr.write(data);
      this.options.stdout.write(this.fullStaticOutput + this.lastOutput);
      return;
    }
    if (!this.interactive) {
      this.options.stderr.write(data);
      return;
    }
    const sync = this.shouldSync();
    if (sync) {
      this.options.stdout.write(bsu);
    }
    this.log.clear();
    this.options.stderr.write(data);
    this.restoreLastOutput();
    if (sync) {
      this.options.stdout.write(esu);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-restricted-types
  unmount(error) {
    if (this.isUnmounted || this.isUnmounting) {
      return;
    }
    this.isUnmounting = true;
    if (this.beforeExitHandler) {
      process12.off("beforeExit", this.beforeExitHandler);
      this.beforeExitHandler = void 0;
    }
    const stdout = this.options.stdout;
    const { canWriteToStdout, hasWritableState } = getWritableStreamState(stdout);
    settleThrottle(this.throttledOnRender, canWriteToStdout);
    if (canWriteToStdout) {
      const shouldRenderFinalFrame = !this.throttledOnRender || !this.hasPendingThrottledRender && this.fullStaticOutput === "";
      if (shouldRenderFinalFrame) {
        this.calculateLayout();
        this.onRender();
      }
    }
    this.isUnmounted = true;
    this.unsubscribeExit();
    settleThrottle(this.throttledLog, canWriteToStdout);
    if (typeof this.restoreConsole === "function") {
      this.restoreConsole();
    }
    const finishUnmount = /* @__PURE__ */ __name(() => {
      if (typeof this.unsubscribeResize === "function") {
        this.unsubscribeResize();
      }
      if (this.cancelKittyDetection) {
        this.cancelKittyDetection();
      }
      if (canWriteToStdout) {
        if (this.kittyProtocolEnabled) {
          this.writeBestEffort(this.options.stdout, "\x1B[<u");
        }
        if (this.alternateScreen) {
          this.writeBestEffort(this.options.stdout, base_exports.exitAlternativeScreen);
          this.writeBestEffort(this.options.stdout, showCursorEscape);
          this.alternateScreen = false;
        }
        if (!this.interactive) {
          this.options.stdout.write(this.options.debug ? "\n" : this.lastOutput + "\n");
        } else if (!this.options.debug) {
          this.log.done();
        }
      }
      this.kittyProtocolEnabled = false;
      instances_default.delete(this.options.stdout);
      const { exitResult } = this;
      const resolveOrReject = /* @__PURE__ */ __name(() => {
        if (isErrorInput(error)) {
          this.rejectExitPromise(error);
        } else {
          this.resolveExitPromise(exitResult);
        }
      }, "resolveOrReject");
      const isProcessExiting = error !== void 0 && !isErrorInput(error);
      if (isProcessExiting) {
        resolveOrReject();
      } else if (canWriteToStdout && hasWritableState) {
        this.options.stdout.write("", resolveOrReject);
      } else {
        setImmediate(resolveOrReject);
      }
    }, "finishUnmount");
    const concurrentReconciler = reconciler_default;
    if (this.options.concurrent) {
      reconciler_default.updateContainerSync(null, this.container, null, noop);
      reconciler_default.flushSyncWork();
      concurrentReconciler.flushPassiveEffects?.();
      finishUnmount();
    } else {
      reconciler_default.updateContainerSync(null, this.container, null, noop);
      reconciler_default.flushSyncWork();
      finishUnmount();
    }
  }
  async waitUntilExit() {
    if (!this.beforeExitHandler) {
      this.beforeExitHandler = () => {
        this.unmount();
      };
      process12.once("beforeExit", this.beforeExitHandler);
    }
    return this.exitPromise;
  }
  async waitUntilRenderFlush() {
    if (this.isUnmounted || this.isUnmounting) {
      await this.awaitExit();
      return;
    }
    await yieldImmediate();
    if (this.isUnmounted || this.isUnmounting) {
      await this.awaitExit();
      return;
    }
    if (this.isConcurrent && this.hasPendingConcurrentWork()) {
      await Promise.race([this.awaitNextRender(), this.awaitExit()]);
      if (this.isUnmounted || this.isUnmounting) {
        this.nextRenderCommit = void 0;
        await this.awaitExit();
        return;
      }
    }
    reconciler_default.flushSyncWork();
    const stdout = this.options.stdout;
    const { canWriteToStdout, hasWritableState } = getWritableStreamState(stdout);
    settleThrottle(this.throttledOnRender, canWriteToStdout);
    settleThrottle(this.throttledLog, canWriteToStdout);
    if (canWriteToStdout && hasWritableState) {
      await new Promise((resolve) => {
        this.options.stdout.write("", () => {
          resolve();
        });
      });
      return;
    }
    await yieldImmediate();
  }
  clear() {
    if (this.interactive && !this.options.debug) {
      this.log.clear();
      this.log.sync(this.lastOutputToRender || this.lastOutput + "\n");
    }
  }
  patchConsole() {
    if (this.options.debug) {
      return;
    }
    this.restoreConsole = dist_default((stream, data) => {
      if (stream === "stdout") {
        this.writeToStdout(data);
      }
      if (stream === "stderr") {
        const isReactMessage = data.startsWith("The above error occurred");
        if (!isReactMessage) {
          this.writeToStderr(data);
        }
      }
    });
  }
  setAlternateScreen(enabled) {
    this.alternateScreen = this.resolveAlternateScreenOption(enabled, this.interactive);
    if (this.alternateScreen) {
      this.writeBestEffort(this.options.stdout, base_exports.enterAlternativeScreen);
      this.writeBestEffort(this.options.stdout, base_exports.clearTerminal);
      this.writeBestEffort(this.options.stdout, hideCursorEscape);
    }
  }
  resolveInteractiveOption(interactive) {
    return interactive ?? (!is_in_ci_default && Boolean(this.options.stdout.isTTY));
  }
  resolveAlternateScreenOption(alternateScreen, interactive) {
    return Boolean(alternateScreen) && interactive && Boolean(this.options.stdout.isTTY);
  }
  shouldSync() {
    return shouldSynchronize(this.options.stdout, this.interactive);
  }
  // Best-effort write: streams may already be destroyed during shutdown.
  writeBestEffort(stream, data) {
    try {
      stream.write(data);
    } catch {
    }
  }
  // Waits for the exit promise to settle, suppressing any rejection.
  // Errors are surfaced via waitUntilExit() instead.
  async awaitExit() {
    try {
      await this.exitPromise;
    } catch {
    }
  }
  hasPendingConcurrentWork() {
    const concurrentContainer = this.container;
    return (concurrentContainer.pendingLanes ?? 0) !== 0 && concurrentContainer.callbackNode !== void 0 && concurrentContainer.callbackNode !== null;
  }
  async awaitNextRender() {
    if (!this.nextRenderCommit) {
      let resolveRender;
      const promise = new Promise((resolve) => {
        resolveRender = resolve;
      });
      this.nextRenderCommit = { promise, resolve: resolveRender };
    }
    return this.nextRenderCommit.promise;
  }
  renderInteractiveFrame(output, outputHeight, staticOutput) {
    this.log.setCursorPosition(this.cursorPosition);
    const hasStaticOutput = staticOutput !== "";
    const isTty = this.options.stdout.isTTY;
    const viewportRows = isTty ? getWindowSize(this.options.stdout).rows : 24;
    const isFullscreen = isTty && outputHeight >= viewportRows;
    const outputToRender = isFullscreen ? output : output + "\n";
    const shouldClearTerminal = shouldClearTerminalForFrame({
      isTty,
      viewportRows,
      previousOutputHeight: this.lastOutputHeight,
      nextOutputHeight: outputHeight,
      isUnmounting: this.isUnmounting
    });
    if (shouldClearTerminal) {
      const sync = this.shouldSync();
      if (sync) {
        this.options.stdout.write(bsu);
      }
      this.options.stdout.write(base_exports.clearTerminal + this.fullStaticOutput + outputToRender);
      this.lastOutput = output;
      this.lastOutputToRender = outputToRender;
      this.lastOutputHeight = outputHeight;
      this.log.sync(outputToRender);
      if (sync) {
        this.options.stdout.write(esu);
      }
      return;
    }
    if (hasStaticOutput) {
      const sync = this.shouldSync();
      if (sync) {
        this.options.stdout.write(bsu);
      }
      this.log.clear();
      this.options.stdout.write(staticOutput);
      this.log(outputToRender);
      if (sync) {
        this.options.stdout.write(esu);
      }
    } else if (output !== this.lastOutput || this.log.isCursorDirty()) {
      this.throttledLog(outputToRender);
    }
    this.lastOutput = output;
    this.lastOutputToRender = outputToRender;
    this.lastOutputHeight = outputHeight;
  }
  initKittyKeyboard() {
    if (!this.options.kittyKeyboard) {
      return;
    }
    const opts = this.options.kittyKeyboard;
    const mode = opts.mode ?? "auto";
    if (mode === "disabled") {
      return;
    }
    const flags = opts.flags ?? ["disambiguateEscapeCodes"];
    if (mode === "enabled") {
      if (this.options.stdin.isTTY && this.options.stdout.isTTY) {
        this.enableKittyProtocol(flags);
      }
      return;
    }
    if (!this.interactive || !this.options.stdin.isTTY || !this.options.stdout.isTTY) {
      return;
    }
    this.confirmKittySupport(flags);
  }
  confirmKittySupport(flags) {
    const { stdin, stdout } = this.options;
    let responseBuffer = [];
    const cleanup = /* @__PURE__ */ __name(() => {
      this.cancelKittyDetection = void 0;
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      const remaining = stripKittyQueryResponsesAndTrailingPartial(responseBuffer);
      responseBuffer = [];
      if (remaining.length > 0) {
        stdin.unshift(Uint8Array.from(remaining));
      }
    }, "cleanup");
    const onData = /* @__PURE__ */ __name((data) => {
      const chunk = typeof data === "string" ? textEncoder.encode(data) : data;
      for (const byte of chunk) {
        responseBuffer.push(byte);
      }
      if (hasCompleteKittyQueryResponse(responseBuffer)) {
        cleanup();
        if (!this.isUnmounted) {
          this.enableKittyProtocol(flags);
        }
      }
    }, "onData");
    stdin.on("data", onData);
    const timer = setTimeout(cleanup, 200);
    this.cancelKittyDetection = cleanup;
    stdout.write("\x1B[?u");
  }
  enableKittyProtocol(flags) {
    this.options.stdout.write(`\x1B[>${resolveFlags(flags)}u`);
    this.kittyProtocolEnabled = true;
  }
};

// node_modules/ink/build/render.js
var render = /* @__PURE__ */ __name((node, options) => {
  const inkOptions = {
    stdout: process13.stdout,
    stdin: process13.stdin,
    stderr: process13.stderr,
    debug: false,
    exitOnCtrlC: true,
    patchConsole: true,
    maxFps: 30,
    incrementalRendering: false,
    concurrent: false,
    alternateScreen: false,
    ...getOptions(options)
  };
  const instance = getInstance(inkOptions.stdout, () => new Ink(inkOptions));
  instance.render(node);
  return {
    rerender: instance.render,
    unmount() {
      instance.unmount();
    },
    waitUntilExit: instance.waitUntilExit,
    waitUntilRenderFlush: instance.waitUntilRenderFlush,
    cleanup() {
      instance.unmount();
    },
    clear: instance.clear
  };
}, "render");
var render_default = render;
var getOptions = /* @__PURE__ */ __name((stdout = {}) => {
  if (stdout instanceof Stream) {
    return {
      stdout,
      stdin: process13.stdin
    };
  }
  return stdout;
}, "getOptions");
var getInstance = /* @__PURE__ */ __name((stdout, createInstance) => {
  const instance = instances_default.get(stdout);
  if (instance === void 0) {
    const newInstance = createInstance();
    instances_default.set(stdout, newInstance);
    return newInstance;
  }
  process13.stderr.write("Warning: render() was called again for the same stdout before the previous Ink instance was unmounted. Reusing stdout across multiple render() calls is unsupported. Call unmount() first.\n");
  return instance;
}, "getInstance");

// node_modules/ink/build/render-to-string.js
init_esbuild_shims();
var import_constants3 = __toESM(require_constants(), 1);
var renderToString = /* @__PURE__ */ __name((node, options) => {
  const columns = options?.columns ?? 80;
  const rootNode = createNode("ink-root");
  let capturedStaticOutput = "";
  rootNode.onComputeLayout = () => {
    rootNode.yogaNode.setWidth(columns);
    rootNode.yogaNode.calculateLayout(void 0, void 0, src_default.DIRECTION_LTR);
  };
  rootNode.onImmediateRender = () => {
    const { staticOutput } = renderer_default(rootNode, false);
    if (staticOutput && staticOutput !== "\n") {
      capturedStaticOutput += staticOutput;
    }
  };
  let uncaughtError;
  const container = reconciler_default.createContainer(rootNode, import_constants3.LegacyRoot, null, false, null, "render-to-string", (error) => {
    uncaughtError ??= error;
  }, () => {
  }, () => {
  }, () => {
  });
  let teardownSucceeded = false;
  try {
    reconciler_default.updateContainerSync(node, container, null, () => {
    });
    reconciler_default.flushSyncWork();
    const { output } = renderer_default(rootNode, false);
    reconciler_default.updateContainerSync(null, container, null, () => {
    });
    reconciler_default.flushSyncWork();
    teardownSucceeded = true;
    rootNode.yogaNode.free();
    if (uncaughtError !== void 0) {
      throw uncaughtError instanceof Error ? uncaughtError : (
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        new Error(String(uncaughtError))
      );
    }
    const normalizedStaticOutput = capturedStaticOutput.endsWith("\n") ? capturedStaticOutput.slice(0, -1) : capturedStaticOutput;
    if (normalizedStaticOutput && output) {
      return normalizedStaticOutput + "\n" + output;
    }
    return normalizedStaticOutput || output;
  } finally {
    if (!teardownSucceeded && rootNode.yogaNode) {
      try {
        rootNode.yogaNode.freeRecursive();
      } catch {
      }
    }
  }
}, "renderToString");
var render_to_string_default = renderToString;

// node_modules/ink/build/components/Static.js
init_esbuild_shims();
var import_react17 = __toESM(require_react(), 1);
function Static(props) {
  const { items, children: render2, style: customStyle } = props;
  const [index, setIndex] = (0, import_react17.useState)(0);
  const itemsToRender = (0, import_react17.useMemo)(() => {
    return items.slice(index);
  }, [items, index]);
  (0, import_react17.useLayoutEffect)(() => {
    setIndex(items.length);
  }, [items.length]);
  const children = itemsToRender.map((item, itemIndex) => {
    return render2(item, index + itemIndex);
  });
  const style = (0, import_react17.useMemo)(() => ({
    position: "absolute",
    flexDirection: "column",
    ...customStyle
  }), [customStyle]);
  return import_react17.default.createElement("ink-box", { internal_static: true, style }, children);
}
__name(Static, "Static");

// node_modules/ink/build/components/Transform.js
init_esbuild_shims();
var import_react18 = __toESM(require_react(), 1);
function Transform({ children, transform, accessibilityLabel }) {
  const { isScreenReaderEnabled } = (0, import_react18.useContext)(accessibilityContext);
  if (children === void 0 || children === null) {
    return null;
  }
  return import_react18.default.createElement("ink-text", { style: { flexGrow: 0, flexShrink: 1, flexDirection: "row" }, internal_transform: transform }, isScreenReaderEnabled && accessibilityLabel ? accessibilityLabel : children);
}
__name(Transform, "Transform");

// node_modules/ink/build/components/Newline.js
init_esbuild_shims();
var import_react19 = __toESM(require_react(), 1);
function Newline({ count = 1 }) {
  return import_react19.default.createElement("ink-text", null, "\n".repeat(count));
}
__name(Newline, "Newline");

// node_modules/ink/build/components/Spacer.js
init_esbuild_shims();
var import_react20 = __toESM(require_react(), 1);
function Spacer() {
  return import_react20.default.createElement(Box_default, { flexGrow: 1 });
}
__name(Spacer, "Spacer");

// node_modules/ink/build/hooks/use-input.js
init_esbuild_shims();
var import_react22 = __toESM(require_react(), 1);

// node_modules/ink/build/parse-keypress.js
init_esbuild_shims();
var textDecoder = new TextDecoder();
var metaKeyCodeRe = /^(?:\x1b)([a-zA-Z0-9])$/;
var fnKeyRe = /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/;
var keyName = {
  /* xterm/gnome ESC O letter */
  OP: "f1",
  OQ: "f2",
  OR: "f3",
  OS: "f4",
  /* vt220-style ESC [ letter (e.g. Ctrl+F1 sends ESC [ 1 ; 5 P) */
  "[P": "f1",
  "[Q": "f2",
  "[R": "f3",
  "[S": "f4",
  /* xterm/rxvt ESC [ number ~ */
  "[11~": "f1",
  "[12~": "f2",
  "[13~": "f3",
  "[14~": "f4",
  /* from Cygwin and used in libuv */
  "[[A": "f1",
  "[[B": "f2",
  "[[C": "f3",
  "[[D": "f4",
  "[[E": "f5",
  /* common */
  "[15~": "f5",
  "[17~": "f6",
  "[18~": "f7",
  "[19~": "f8",
  "[20~": "f9",
  "[21~": "f10",
  "[23~": "f11",
  "[24~": "f12",
  /* xterm ESC [ letter */
  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "[E": "clear",
  "[F": "end",
  "[H": "home",
  /* xterm/gnome ESC O letter */
  OA: "up",
  OB: "down",
  OC: "right",
  OD: "left",
  OE: "clear",
  OF: "end",
  OH: "home",
  /* xterm/rxvt ESC [ number ~ */
  "[1~": "home",
  "[2~": "insert",
  "[3~": "delete",
  "[4~": "end",
  "[5~": "pageup",
  "[6~": "pagedown",
  /* putty */
  "[[5~": "pageup",
  "[[6~": "pagedown",
  /* rxvt */
  "[7~": "home",
  "[8~": "end",
  /* rxvt keys with modifiers */
  "[a": "up",
  "[b": "down",
  "[c": "right",
  "[d": "left",
  "[e": "clear",
  "[2$": "insert",
  "[3$": "delete",
  "[5$": "pageup",
  "[6$": "pagedown",
  "[7$": "home",
  "[8$": "end",
  Oa: "up",
  Ob: "down",
  Oc: "right",
  Od: "left",
  Oe: "clear",
  "[2^": "insert",
  "[3^": "delete",
  "[5^": "pageup",
  "[6^": "pagedown",
  "[7^": "home",
  "[8^": "end",
  /* misc. */
  "[Z": "tab"
};
var nonAlphanumericKeys = [...Object.values(keyName), "backspace"];
var isShiftKey = /* @__PURE__ */ __name((code) => {
  return [
    "[a",
    "[b",
    "[c",
    "[d",
    "[e",
    "[2$",
    "[3$",
    "[5$",
    "[6$",
    "[7$",
    "[8$",
    "[Z"
  ].includes(code);
}, "isShiftKey");
var isCtrlKey = /* @__PURE__ */ __name((code) => {
  return [
    "Oa",
    "Ob",
    "Oc",
    "Od",
    "Oe",
    "[2^",
    "[3^",
    "[5^",
    "[6^",
    "[7^",
    "[8^"
  ].includes(code);
}, "isCtrlKey");
var kittyKeyRe = /^\x1b\[(\d+)(?:;(\d+)(?::(\d+))?(?:;([\d:]+))?)?u$/;
var kittySpecialKeyRe = /^\x1b\[(\d+);(\d+):(\d+)([A-Za-z~])$/;
var kittySpecialLetterKeys = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  E: "clear",
  F: "end",
  H: "home",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4"
};
var kittySpecialNumberKeys = {
  2: "insert",
  3: "delete",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12"
};
var kittyCodepointNames = {
  27: "escape",
  // 13 (return) and 32 (space) are handled before this lookup
  // in parseKittyKeypress so they can be marked as printable.
  9: "tab",
  127: "backspace",
  8: "backspace",
  57358: "capslock",
  57359: "scrolllock",
  57360: "numlock",
  57361: "printscreen",
  57362: "pause",
  57363: "menu",
  57376: "f13",
  57377: "f14",
  57378: "f15",
  57379: "f16",
  57380: "f17",
  57381: "f18",
  57382: "f19",
  57383: "f20",
  57384: "f21",
  57385: "f22",
  57386: "f23",
  57387: "f24",
  57388: "f25",
  57389: "f26",
  57390: "f27",
  57391: "f28",
  57392: "f29",
  57393: "f30",
  57394: "f31",
  57395: "f32",
  57396: "f33",
  57397: "f34",
  57398: "f35",
  57399: "kp0",
  57400: "kp1",
  57401: "kp2",
  57402: "kp3",
  57403: "kp4",
  57404: "kp5",
  57405: "kp6",
  57406: "kp7",
  57407: "kp8",
  57408: "kp9",
  57409: "kpdecimal",
  57410: "kpdivide",
  57411: "kpmultiply",
  57412: "kpsubtract",
  57413: "kpadd",
  57414: "kpenter",
  57415: "kpequal",
  57416: "kpseparator",
  57417: "kpleft",
  57418: "kpright",
  57419: "kpup",
  57420: "kpdown",
  57421: "kppageup",
  57422: "kppagedown",
  57423: "kphome",
  57424: "kpend",
  57425: "kpinsert",
  57426: "kpdelete",
  57427: "kpbegin",
  57428: "mediaplay",
  57429: "mediapause",
  57430: "mediaplaypause",
  57431: "mediareverse",
  57432: "mediastop",
  57433: "mediafastforward",
  57434: "mediarewind",
  57435: "mediatracknext",
  57436: "mediatrackprevious",
  57437: "mediarecord",
  57438: "lowervolume",
  57439: "raisevolume",
  57440: "mutevolume",
  57441: "leftshift",
  57442: "leftcontrol",
  57443: "leftalt",
  57444: "leftsuper",
  57445: "lefthyper",
  57446: "leftmeta",
  57447: "rightshift",
  57448: "rightcontrol",
  57449: "rightalt",
  57450: "rightsuper",
  57451: "righthyper",
  57452: "rightmeta",
  57453: "isoLevel3Shift",
  57454: "isoLevel5Shift"
};
var isValidCodepoint = /* @__PURE__ */ __name((cp) => cp >= 0 && cp <= 1114111 && !(cp >= 55296 && cp <= 57343), "isValidCodepoint");
var safeFromCodePoint = /* @__PURE__ */ __name((cp) => isValidCodepoint(cp) ? String.fromCodePoint(cp) : "?", "safeFromCodePoint");
function resolveEventType(value) {
  if (value === 3)
    return "release";
  if (value === 2)
    return "repeat";
  return "press";
}
__name(resolveEventType, "resolveEventType");
function parseKittyModifiers(modifiers) {
  return {
    ctrl: !!(modifiers & kittyModifiers.ctrl),
    shift: !!(modifiers & kittyModifiers.shift),
    meta: !!(modifiers & (kittyModifiers.meta | kittyModifiers.alt)),
    super: !!(modifiers & kittyModifiers.super),
    hyper: !!(modifiers & kittyModifiers.hyper),
    capsLock: !!(modifiers & kittyModifiers.capsLock),
    numLock: !!(modifiers & kittyModifiers.numLock)
  };
}
__name(parseKittyModifiers, "parseKittyModifiers");
var parseKittyKeypress = /* @__PURE__ */ __name((s) => {
  const match = kittyKeyRe.exec(s);
  if (!match)
    return null;
  const codepoint = parseInt(match[1], 10);
  const modifiers = match[2] ? Math.max(0, parseInt(match[2], 10) - 1) : 0;
  const eventType = match[3] ? parseInt(match[3], 10) : 1;
  const textField = match[4];
  if (!isValidCodepoint(codepoint)) {
    return null;
  }
  let text;
  if (textField) {
    text = textField.split(":").map((cp) => safeFromCodePoint(parseInt(cp, 10))).join("");
  }
  let name;
  let isPrintable;
  if (codepoint === 32) {
    name = "space";
    isPrintable = true;
  } else if (codepoint === 13) {
    name = "return";
    isPrintable = true;
  } else if (kittyCodepointNames[codepoint]) {
    name = kittyCodepointNames[codepoint];
    isPrintable = false;
  } else if (codepoint >= 1 && codepoint <= 26) {
    name = String.fromCodePoint(codepoint + 96);
    isPrintable = false;
  } else {
    name = safeFromCodePoint(codepoint).toLowerCase();
    isPrintable = true;
  }
  if (isPrintable && !text) {
    text = safeFromCodePoint(codepoint);
  }
  return {
    name,
    ...parseKittyModifiers(modifiers),
    eventType: resolveEventType(eventType),
    sequence: s,
    raw: s,
    isKittyProtocol: true,
    isPrintable,
    text
  };
}, "parseKittyKeypress");
var parseKittySpecialKey = /* @__PURE__ */ __name((s) => {
  const match = kittySpecialKeyRe.exec(s);
  if (!match)
    return null;
  const number = parseInt(match[1], 10);
  const modifiers = Math.max(0, parseInt(match[2], 10) - 1);
  const eventType = parseInt(match[3], 10);
  const terminator = match[4];
  const name = terminator === "~" ? kittySpecialNumberKeys[number] : kittySpecialLetterKeys[terminator];
  if (!name)
    return null;
  return {
    name,
    ...parseKittyModifiers(modifiers),
    eventType: resolveEventType(eventType),
    sequence: s,
    raw: s,
    isKittyProtocol: true,
    isPrintable: false
  };
}, "parseKittySpecialKey");
var parseKeypress = /* @__PURE__ */ __name((s = "") => {
  let parts;
  if (s instanceof Uint8Array) {
    if (s[0] > 127 && s[1] === void 0) {
      s[0] -= 128;
      s = "\x1B" + textDecoder.decode(s);
    } else {
      s = textDecoder.decode(s);
    }
  } else if (s !== void 0 && typeof s !== "string") {
    s = String(s);
  } else if (!s) {
    s = "";
  }
  const kittyResult = parseKittyKeypress(s);
  if (kittyResult)
    return kittyResult;
  const kittySpecialResult = parseKittySpecialKey(s);
  if (kittySpecialResult)
    return kittySpecialResult;
  if (kittyKeyRe.test(s)) {
    return {
      name: "",
      ctrl: false,
      meta: false,
      shift: false,
      sequence: s,
      raw: s,
      isKittyProtocol: true,
      isPrintable: false
    };
  }
  const key = {
    name: "",
    ctrl: false,
    meta: false,
    shift: false,
    sequence: s,
    raw: s
  };
  key.sequence = key.sequence || s || key.name;
  if (s === "\r" || s === "\x1B\r") {
    key.raw = void 0;
    key.name = "return";
    key.meta = s.length === 2;
  } else if (s === "\n") {
    key.name = "enter";
  } else if (s === "	") {
    key.name = "tab";
  } else if (s === "\b" || s === "\x1B\b") {
    key.name = "backspace";
    key.meta = s.charAt(0) === "\x1B";
  } else if (s === "\x7F" || s === "\x1B\x7F") {
    key.name = "backspace";
    key.meta = s.charAt(0) === "\x1B";
  } else if (s === "\x1B" || s === "\x1B\x1B") {
    key.name = "escape";
    key.meta = s.length === 2;
  } else if (s === " " || s === "\x1B ") {
    key.name = "space";
    key.meta = s.length === 2;
  } else if (s.length === 1 && s <= "") {
    key.name = String.fromCharCode(s.charCodeAt(0) + "a".charCodeAt(0) - 1);
    key.ctrl = true;
  } else if (s.length === 1 && s >= "0" && s <= "9") {
    key.name = "number";
  } else if (s.length === 1 && s >= "a" && s <= "z") {
    key.name = s;
  } else if (s.length === 1 && s >= "A" && s <= "Z") {
    key.name = s.toLowerCase();
    key.shift = true;
  } else if (parts = metaKeyCodeRe.exec(s)) {
    key.name = parts[1].toLowerCase();
    key.meta = true;
    key.shift = /^[A-Z]$/.test(parts[1]);
  } else if (parts = fnKeyRe.exec(s)) {
    const segs = [...s];
    if (segs[0] === "\x1B" && segs[1] === "\x1B") {
      key.meta = true;
    }
    const code = [parts[1], parts[2], parts[4], parts[6]].filter(Boolean).join("");
    const modifier = (parts[3] || parts[5] || 1) - 1;
    key.ctrl = !!(modifier & 4);
    key.meta = key.meta || !!(modifier & 10);
    key.shift = !!(modifier & 1);
    key.code = code;
    key.name = keyName[code] ?? "";
    key.shift = isShiftKey(code) || key.shift;
    key.ctrl = isCtrlKey(code) || key.ctrl;
  }
  return key;
}, "parseKeypress");
var parse_keypress_default = parseKeypress;

// node_modules/ink/build/hooks/use-stdin.js
init_esbuild_shims();
var import_react21 = __toESM(require_react(), 1);
var useStdin = /* @__PURE__ */ __name(() => (0, import_react21.useContext)(StdinContext_default), "useStdin");
var useStdinContext = /* @__PURE__ */ __name(() => (0, import_react21.useContext)(StdinContext_default), "useStdinContext");
var use_stdin_default = useStdin;

// node_modules/ink/build/hooks/use-input.js
var useInput = /* @__PURE__ */ __name((inputHandler, options = {}) => {
  const { setRawMode, internal_exitOnCtrlC, internal_eventEmitter } = useStdinContext();
  (0, import_react22.useEffect)(() => {
    if (options.isActive === false) {
      return;
    }
    setRawMode(true);
    return () => {
      setRawMode(false);
    };
  }, [options.isActive, setRawMode]);
  const handleData = (0, import_react22.useEffectEvent)((data) => {
    const keypress = parse_keypress_default(data);
    const key = {
      upArrow: keypress.name === "up",
      downArrow: keypress.name === "down",
      leftArrow: keypress.name === "left",
      rightArrow: keypress.name === "right",
      pageDown: keypress.name === "pagedown",
      pageUp: keypress.name === "pageup",
      home: keypress.name === "home",
      end: keypress.name === "end",
      return: keypress.name === "return",
      escape: keypress.name === "escape",
      ctrl: keypress.ctrl,
      shift: keypress.shift,
      tab: keypress.name === "tab",
      backspace: keypress.name === "backspace",
      delete: keypress.name === "delete",
      meta: keypress.meta,
      // Kitty keyboard protocol modifiers
      super: keypress.super ?? false,
      hyper: keypress.hyper ?? false,
      capsLock: keypress.capsLock ?? false,
      numLock: keypress.numLock ?? false,
      eventType: keypress.eventType
    };
    let input;
    if (keypress.isKittyProtocol) {
      if (keypress.isPrintable) {
        input = keypress.text ?? keypress.name;
      } else if (keypress.ctrl && keypress.name.length === 1) {
        input = keypress.name;
      } else {
        input = "";
      }
    } else if (keypress.ctrl) {
      input = keypress.name ?? "";
    } else {
      input = keypress.sequence;
    }
    if (!keypress.isKittyProtocol && nonAlphanumericKeys.includes(keypress.name)) {
      input = "";
    }
    if (input.startsWith("\x1B")) {
      input = input.slice(1);
    }
    if (input.length === 1 && /[A-Z]/.test(input)) {
      key.shift = true;
    }
    if (input === "c" && key.ctrl && internal_exitOnCtrlC) {
      return;
    }
    reconciler_default.discreteUpdates(() => {
      inputHandler(input, key);
    });
  });
  (0, import_react22.useEffect)(() => {
    if (options.isActive === false) {
      return;
    }
    internal_eventEmitter.on("input", handleData);
    return () => {
      internal_eventEmitter.removeListener("input", handleData);
    };
  }, [options.isActive, internal_eventEmitter, handleData]);
}, "useInput");
var use_input_default = useInput;

// node_modules/ink/build/hooks/use-paste.js
init_esbuild_shims();
var import_react23 = __toESM(require_react(), 1);
var usePaste = /* @__PURE__ */ __name((handler, options = {}) => {
  const { setRawMode, setBracketedPasteMode, internal_eventEmitter } = useStdinContext();
  (0, import_react23.useEffect)(() => {
    if (options.isActive === false) {
      return;
    }
    setRawMode(true);
    setBracketedPasteMode(true);
    return () => {
      setRawMode(false);
      setBracketedPasteMode(false);
    };
  }, [options.isActive, setRawMode, setBracketedPasteMode]);
  const handlePaste = (0, import_react23.useEffectEvent)((text) => {
    reconciler_default.discreteUpdates(() => {
      handler(text);
    });
  });
  (0, import_react23.useEffect)(() => {
    if (options.isActive === false) {
      return;
    }
    internal_eventEmitter.on("paste", handlePaste);
    return () => {
      internal_eventEmitter.removeListener("paste", handlePaste);
    };
  }, [options.isActive, internal_eventEmitter, handlePaste]);
}, "usePaste");
var use_paste_default = usePaste;

// node_modules/ink/build/hooks/use-app.js
init_esbuild_shims();
var import_react24 = __toESM(require_react(), 1);
var useApp = /* @__PURE__ */ __name(() => (0, import_react24.useContext)(AppContext_default), "useApp");
var use_app_default = useApp;

// node_modules/ink/build/hooks/use-stdout.js
init_esbuild_shims();
var import_react25 = __toESM(require_react(), 1);
var useStdout = /* @__PURE__ */ __name(() => (0, import_react25.useContext)(StdoutContext_default), "useStdout");
var use_stdout_default = useStdout;

// node_modules/ink/build/hooks/use-stderr.js
init_esbuild_shims();
var import_react26 = __toESM(require_react(), 1);
var useStderr = /* @__PURE__ */ __name(() => (0, import_react26.useContext)(StderrContext_default), "useStderr");
var use_stderr_default = useStderr;

// node_modules/ink/build/hooks/use-focus.js
init_esbuild_shims();
var import_react27 = __toESM(require_react(), 1);
var useFocus = /* @__PURE__ */ __name(({ isActive = true, autoFocus = false, id: customId } = {}) => {
  const { isRawModeSupported, setRawMode } = use_stdin_default();
  const { activeId, add, remove, activate, deactivate, focus } = (0, import_react27.useContext)(FocusContext_default);
  const id = (0, import_react27.useMemo)(() => {
    return customId ?? Math.random().toString().slice(2, 7);
  }, [customId]);
  (0, import_react27.useEffect)(() => {
    add(id, { autoFocus });
    return () => {
      remove(id);
    };
  }, [id, autoFocus, add, remove]);
  (0, import_react27.useEffect)(() => {
    if (isActive) {
      activate(id);
    } else {
      deactivate(id);
    }
  }, [isActive, id, activate, deactivate]);
  (0, import_react27.useEffect)(() => {
    if (!isRawModeSupported || !isActive) {
      return;
    }
    setRawMode(true);
    return () => {
      setRawMode(false);
    };
  }, [isActive, isRawModeSupported, setRawMode]);
  return {
    isFocused: Boolean(id) && activeId === id,
    focus
  };
}, "useFocus");
var use_focus_default = useFocus;

// node_modules/ink/build/hooks/use-focus-manager.js
init_esbuild_shims();
var import_react28 = __toESM(require_react(), 1);
var useFocusManager = /* @__PURE__ */ __name(() => {
  const focusContext = (0, import_react28.useContext)(FocusContext_default);
  return {
    enableFocus: focusContext.enableFocus,
    disableFocus: focusContext.disableFocus,
    focusNext: focusContext.focusNext,
    focusPrevious: focusContext.focusPrevious,
    focus: focusContext.focus,
    activeId: focusContext.activeId
  };
}, "useFocusManager");
var use_focus_manager_default = useFocusManager;

// node_modules/ink/build/hooks/use-is-screen-reader-enabled.js
init_esbuild_shims();
var import_react29 = __toESM(require_react(), 1);
var useIsScreenReaderEnabled = /* @__PURE__ */ __name(() => {
  const { isScreenReaderEnabled } = (0, import_react29.useContext)(accessibilityContext);
  return isScreenReaderEnabled;
}, "useIsScreenReaderEnabled");
var use_is_screen_reader_enabled_default = useIsScreenReaderEnabled;

// node_modules/ink/build/hooks/use-cursor.js
init_esbuild_shims();
var import_react30 = __toESM(require_react(), 1);
var useCursor = /* @__PURE__ */ __name(() => {
  const context = (0, import_react30.useContext)(CursorContext_default);
  const positionRef = (0, import_react30.useRef)(void 0);
  const setCursorPosition = (0, import_react30.useCallback)((position) => {
    positionRef.current = position;
  }, []);
  (0, import_react30.useInsertionEffect)(() => {
    context.setCursorPosition(positionRef.current);
    return () => {
      context.setCursorPosition(void 0);
    };
  });
  return { setCursorPosition };
}, "useCursor");
var use_cursor_default = useCursor;

// node_modules/ink/build/hooks/use-animation.js
init_esbuild_shims();
var import_react31 = __toESM(require_react(), 1);
var defaultAnimationInterval = 100;
var maximumTimerInterval = 2147483647;
var zeroAnimState = { frame: 0, time: 0, delta: 0 };
function useAnimation(options) {
  const { interval = defaultAnimationInterval, isActive = true } = options ?? {};
  const safeInterval = normalizeAnimationInterval(interval);
  const { subscribe, renderThrottleMs } = (0, import_react31.useContext)(AnimationContext_default);
  const [resetKey, setResetKey] = (0, import_react31.useState)(0);
  const [animState, setAnimState] = (0, import_react31.useState)(zeroAnimState);
  const nextRenderTimeRef = (0, import_react31.useRef)(0);
  const lastRenderTimeRef = (0, import_react31.useRef)(0);
  const previousOptionsRef = (0, import_react31.useRef)({ isActive, safeInterval, resetKey });
  const previousOptions = previousOptionsRef.current;
  const shouldReset = isActive && (safeInterval !== previousOptions.safeInterval || !previousOptions.isActive || resetKey !== previousOptions.resetKey);
  const reset = (0, import_react31.useCallback)(() => {
    setResetKey((k) => k + 1);
  }, []);
  (0, import_react31.useLayoutEffect)(() => {
    if (!isActive) {
      return;
    }
    setAnimState(zeroAnimState);
    let startTime = 0;
    const { startTime: subscriberStartTime, unsubscribe } = subscribe((currentTime) => {
      const isThrottled = renderThrottleMs > 0 && currentTime < nextRenderTimeRef.current;
      if (isThrottled) {
        return;
      }
      const elapsed = currentTime - startTime;
      const nextDelta = currentTime - lastRenderTimeRef.current;
      lastRenderTimeRef.current = currentTime;
      nextRenderTimeRef.current = currentTime + renderThrottleMs;
      setAnimState({
        frame: Math.floor(elapsed / safeInterval),
        time: elapsed,
        delta: nextDelta
      });
    }, safeInterval);
    startTime = subscriberStartTime;
    lastRenderTimeRef.current = subscriberStartTime;
    nextRenderTimeRef.current = startTime + renderThrottleMs;
    return unsubscribe;
  }, [safeInterval, isActive, subscribe, renderThrottleMs, resetKey]);
  (0, import_react31.useLayoutEffect)(() => {
    previousOptionsRef.current = { isActive, safeInterval, resetKey };
  }, [isActive, safeInterval, resetKey]);
  if (shouldReset) {
    return { ...zeroAnimState, reset };
  }
  return { ...animState, reset };
}
__name(useAnimation, "useAnimation");
function normalizeAnimationInterval(interval) {
  if (!Number.isFinite(interval)) {
    return defaultAnimationInterval;
  }
  return Math.min(maximumTimerInterval, Math.max(1, interval));
}
__name(normalizeAnimationInterval, "normalizeAnimationInterval");

// node_modules/ink/build/hooks/use-window-size.js
init_esbuild_shims();
var import_react32 = __toESM(require_react(), 1);
var useWindowSize = /* @__PURE__ */ __name(() => {
  const { stdout } = use_stdout_default();
  const [size, setSize] = (0, import_react32.useState)(() => getWindowSize(stdout));
  (0, import_react32.useEffect)(() => {
    const onResize = /* @__PURE__ */ __name(() => {
      setSize(getWindowSize(stdout));
    }, "onResize");
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}, "useWindowSize");
var use_window_size_default = useWindowSize;

// node_modules/ink/build/hooks/use-box-metrics.js
init_esbuild_shims();
var import_react33 = __toESM(require_react(), 1);
var emptyMetrics = {
  width: 0,
  height: 0,
  left: 0,
  top: 0
};
var maxSelfDrivenMeasurements = 16;
var measurementGuards = /* @__PURE__ */ new WeakMap();
var getMeasurementGuard = /* @__PURE__ */ __name((rootNode) => {
  const existing = measurementGuards.get(rootNode);
  if (existing) {
    return existing;
  }
  const guard = {
    count: 0,
    listeners: /* @__PURE__ */ new Set()
  };
  measurementGuards.set(rootNode, guard);
  addLayoutListener(rootNode, () => {
    if (guard.count >= maxSelfDrivenMeasurements) {
      return;
    }
    let changed = false;
    for (const listener of guard.listeners) {
      changed = listener() || changed;
    }
    if (changed) {
      if (guard.count === 0) {
        queueMicrotask(() => {
          guard.count = 0;
        });
      }
      guard.count += 1;
    }
  });
  return guard;
}, "getMeasurementGuard");
var addMeasurementListener = /* @__PURE__ */ __name((rootNode, listener) => {
  const guard = getMeasurementGuard(rootNode);
  guard.listeners.add(listener);
  return () => {
    guard.listeners.delete(listener);
  };
}, "addMeasurementListener");
var findRootNode = /* @__PURE__ */ __name((node) => {
  if (!node) {
    return void 0;
  }
  if (!node.parentNode) {
    return node.nodeName === "ink-root" ? node : void 0;
  }
  return findRootNode(node.parentNode);
}, "findRootNode");
var useBoxMetrics = /* @__PURE__ */ __name((ref) => {
  const [metrics, setMetrics] = (0, import_react33.useState)(emptyMetrics);
  const [hasMeasured, setHasMeasured] = (0, import_react33.useState)(false);
  const stateRef = (0, import_react33.useRef)({
    last: null,
    hasMeasured: false,
    rootNode: void 0
  });
  const { stdout } = use_stdout_default();
  const updateMetrics = (0, import_react33.useCallback)(() => {
    const state = stateRef.current;
    const rootNode = findRootNode(ref.current) ?? state.rootNode;
    if (rootNode) {
      state.rootNode = rootNode;
    }
    const guard = rootNode ? getMeasurementGuard(rootNode) : void 0;
    if (guard?.count >= maxSelfDrivenMeasurements) {
      return false;
    }
    const layout = ref.current?.yogaNode?.getComputedLayout() ?? emptyMetrics;
    const last = state.last;
    const hasChanged = last === null || last.width !== layout.width || last.height !== layout.height || last.left !== layout.left || last.top !== layout.top;
    if (hasChanged) {
      state.last = layout;
      setMetrics(layout);
    }
    const nextHasMeasured = Boolean(ref.current);
    const hasMeasuredChanged = nextHasMeasured !== state.hasMeasured;
    if (hasMeasuredChanged) {
      state.hasMeasured = nextHasMeasured;
    }
    setHasMeasured(nextHasMeasured);
    return hasChanged || hasMeasuredChanged;
  }, [ref]);
  (0, import_react33.useEffect)(() => {
    updateMetrics();
  });
  (0, import_react33.useEffect)(() => {
    const rootNode = findRootNode(ref.current);
    if (!rootNode) {
      return;
    }
    stateRef.current.rootNode = rootNode;
    return addMeasurementListener(rootNode, updateMetrics);
  });
  (0, import_react33.useEffect)(() => {
    const onResize = /* @__PURE__ */ __name(() => {
      const rootNode = findRootNode(ref.current) ?? stateRef.current.rootNode;
      if (rootNode) {
        const guard = getMeasurementGuard(rootNode);
        guard.count = 0;
      }
      updateMetrics();
    }, "onResize");
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout, updateMetrics]);
  return (0, import_react33.useMemo)(() => ({
    ...metrics,
    hasMeasured
  }), [metrics, hasMeasured]);
}, "useBoxMetrics");
var use_box_metrics_default = useBoxMetrics;

// node_modules/ink/build/measure-element.js
init_esbuild_shims();
var measureElement = /* @__PURE__ */ __name((node) => ({
  width: node.yogaNode?.getComputedWidth() ?? 0,
  height: node.yogaNode?.getComputedHeight() ?? 0
}), "measureElement");
var measure_element_default = measureElement;

export {
  base_exports,
  require_constants,
  require_react_reconciler,
  getFrameController,
  Box_default,
  Text,
  kittyFlags,
  kittyModifiers,
  render_default,
  render_to_string_default,
  Static,
  Transform,
  Newline,
  Spacer,
  use_stdin_default,
  use_input_default,
  use_paste_default,
  use_app_default,
  use_stdout_default,
  use_stderr_default,
  use_focus_default,
  use_focus_manager_default,
  use_is_screen_reader_enabled_default,
  use_cursor_default,
  useAnimation,
  use_window_size_default,
  use_box_metrics_default,
  measure_element_default
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/*! Bundled license information:

react-reconciler/cjs/react-reconciler-constants.production.js:
  (**
   * @license React
   * react-reconciler-constants.production.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

scheduler/cjs/scheduler.production.js:
  (**
   * @license React
   * scheduler.production.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

react-reconciler/cjs/react-reconciler.production.js:
  (**
   * @license React
   * react-reconciler.production.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)
*/
