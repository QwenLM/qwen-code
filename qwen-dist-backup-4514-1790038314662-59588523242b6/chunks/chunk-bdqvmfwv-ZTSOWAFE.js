// Force strict mode and setup for ESM
"use strict";
import "./chunk-N2TNM3QB.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __commonJS,
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/node_modules/react-devtools-core/dist/backend.js
var require_backend = __commonJS({
  "packages/cli/node_modules/react-devtools-core/dist/backend.js"(exports, module) {
    init_esbuild_shims();
    (/* @__PURE__ */ __name(function webpackUniversalModuleDefinition(root, factory) {
      if (typeof exports === "object" && typeof module === "object")
        module.exports = factory();
      else if (typeof define === "function" && define.amd)
        define([], factory);
      else if (typeof exports === "object")
        exports["ReactDevToolsBackend"] = factory();
      else
        root["ReactDevToolsBackend"] = factory();
    }, "webpackUniversalModuleDefinition"))(self, () => {
      return (
        /******/
        (() => {
          var __webpack_modules__ = {
            /***/
            786: (
              /***/
              (__unused_webpack_module, exports2, __webpack_require__2) => {
                "use strict";
                var __webpack_unused_export__;
                function _typeof(o) {
                  "@babel/helpers - typeof";
                  return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                    return typeof o2;
                  } : function(o2) {
                    return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
                  }, _typeof(o);
                }
                __name(_typeof, "_typeof");
                var ErrorStackParser = __webpack_require__2(206), React = __webpack_require__2(189), assign = Object.assign, ReactSharedInternals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, REACT_CONTEXT_TYPE = Symbol.for("react.context"), REACT_MEMO_CACHE_SENTINEL = Symbol.for("react.memo_cache_sentinel"), hasOwnProperty = Object.prototype.hasOwnProperty, hookLog = [], primitiveStackCache = null;
                function getPrimitiveStackCache() {
                  if (null === primitiveStackCache) {
                    var cache = /* @__PURE__ */ new Map();
                    try {
                      Dispatcher.useContext({
                        _currentValue: null
                      });
                      Dispatcher.useState(null);
                      Dispatcher.useReducer(function(s) {
                        return s;
                      }, null);
                      Dispatcher.useRef(null);
                      "function" === typeof Dispatcher.useCacheRefresh && Dispatcher.useCacheRefresh();
                      Dispatcher.useLayoutEffect(function() {
                      });
                      Dispatcher.useInsertionEffect(function() {
                      });
                      Dispatcher.useEffect(function() {
                      });
                      Dispatcher.useImperativeHandle(void 0, function() {
                        return null;
                      });
                      Dispatcher.useDebugValue(null);
                      Dispatcher.useCallback(function() {
                      });
                      Dispatcher.useTransition();
                      Dispatcher.useSyncExternalStore(function() {
                        return function() {
                        };
                      }, function() {
                        return null;
                      }, function() {
                        return null;
                      });
                      Dispatcher.useDeferredValue(null);
                      Dispatcher.useMemo(function() {
                        return null;
                      });
                      Dispatcher.useOptimistic(null, function(s) {
                        return s;
                      });
                      Dispatcher.useFormState(function(s) {
                        return s;
                      }, null);
                      Dispatcher.useActionState(function(s) {
                        return s;
                      }, null);
                      Dispatcher.useHostTransitionStatus();
                      "function" === typeof Dispatcher.useMemoCache && Dispatcher.useMemoCache(0);
                      if ("function" === typeof Dispatcher.use) {
                        Dispatcher.use({
                          $$typeof: REACT_CONTEXT_TYPE,
                          _currentValue: null
                        });
                        Dispatcher.use({
                          then: /* @__PURE__ */ __name(function then() {
                          }, "then"),
                          status: "fulfilled",
                          value: null
                        });
                        try {
                          Dispatcher.use({
                            then: /* @__PURE__ */ __name(function then() {
                            }, "then")
                          });
                        } catch (x) {
                        }
                      }
                      Dispatcher.useId();
                      "function" === typeof Dispatcher.useEffectEvent && Dispatcher.useEffectEvent(function() {
                      });
                    } finally {
                      var readHookLog = hookLog;
                      hookLog = [];
                    }
                    for (var i = 0; i < readHookLog.length; i++) {
                      var hook = readHookLog[i];
                      cache.set(hook.primitive, ErrorStackParser.parse(hook.stackError));
                    }
                    primitiveStackCache = cache;
                  }
                  return primitiveStackCache;
                }
                __name(getPrimitiveStackCache, "getPrimitiveStackCache");
                var currentFiber = null, currentHook = null, currentContextDependency = null, currentThenableIndex = 0, currentThenableState = null;
                function nextHook() {
                  var hook = currentHook;
                  null !== hook && (currentHook = hook.next);
                  return hook;
                }
                __name(nextHook, "nextHook");
                function readContext(context) {
                  if (null === currentFiber) return context._currentValue;
                  if (null === currentContextDependency) throw Error("Context reads do not line up with context dependencies. This is a bug in React Debug Tools.");
                  hasOwnProperty.call(currentContextDependency, "memoizedValue") ? (context = currentContextDependency.memoizedValue, currentContextDependency = currentContextDependency.next) : context = context._currentValue;
                  return context;
                }
                __name(readContext, "readContext");
                var SuspenseException = Error("Suspense Exception: This is not a real error! It's an implementation detail of `use` to interrupt the current render. You must either rethrow it immediately, or move the `use` call outside of the `try/catch` block. Capturing without rethrowing will lead to unexpected behavior.\n\nTo handle async errors, wrap your component in an error boundary, or call the promise's `.catch` method and pass the result to `use`."), Dispatcher = {
                  readContext,
                  use: /* @__PURE__ */ __name(function use(usable) {
                    if (null !== usable && "object" === _typeof(usable)) {
                      if ("function" === typeof usable.then) {
                        usable = null !== currentThenableState && currentThenableIndex < currentThenableState.length ? currentThenableState[currentThenableIndex++] : usable;
                        switch (usable.status) {
                          case "fulfilled":
                            var fulfilledValue = usable.value;
                            hookLog.push({
                              displayName: null,
                              primitive: "Promise",
                              stackError: Error(),
                              value: fulfilledValue,
                              debugInfo: void 0 === usable._debugInfo ? null : usable._debugInfo,
                              dispatcherHookName: "Use"
                            });
                            return fulfilledValue;
                          case "rejected":
                            throw usable.reason;
                        }
                        hookLog.push({
                          displayName: null,
                          primitive: "Unresolved",
                          stackError: Error(),
                          value: usable,
                          debugInfo: void 0 === usable._debugInfo ? null : usable._debugInfo,
                          dispatcherHookName: "Use"
                        });
                        throw SuspenseException;
                      }
                      if (usable.$$typeof === REACT_CONTEXT_TYPE) return fulfilledValue = readContext(usable), hookLog.push({
                        displayName: usable.displayName || "Context",
                        primitive: "Context (use)",
                        stackError: Error(),
                        value: fulfilledValue,
                        debugInfo: null,
                        dispatcherHookName: "Use"
                      }), fulfilledValue;
                    }
                    throw Error("An unsupported type was passed to use(): " + String(usable));
                  }, "use"),
                  useCallback: /* @__PURE__ */ __name(function useCallback(callback) {
                    var hook = nextHook();
                    hookLog.push({
                      displayName: null,
                      primitive: "Callback",
                      stackError: Error(),
                      value: null !== hook ? hook.memoizedState[0] : callback,
                      debugInfo: null,
                      dispatcherHookName: "Callback"
                    });
                    return callback;
                  }, "useCallback"),
                  useContext: /* @__PURE__ */ __name(function useContext(context) {
                    var value = readContext(context);
                    hookLog.push({
                      displayName: context.displayName || null,
                      primitive: "Context",
                      stackError: Error(),
                      value,
                      debugInfo: null,
                      dispatcherHookName: "Context"
                    });
                    return value;
                  }, "useContext"),
                  useEffect: /* @__PURE__ */ __name(function useEffect(create) {
                    nextHook();
                    hookLog.push({
                      displayName: null,
                      primitive: "Effect",
                      stackError: Error(),
                      value: create,
                      debugInfo: null,
                      dispatcherHookName: "Effect"
                    });
                  }, "useEffect"),
                  useImperativeHandle: /* @__PURE__ */ __name(function useImperativeHandle(ref) {
                    nextHook();
                    var instance = void 0;
                    null !== ref && "object" === _typeof(ref) && (instance = ref.current);
                    hookLog.push({
                      displayName: null,
                      primitive: "ImperativeHandle",
                      stackError: Error(),
                      value: instance,
                      debugInfo: null,
                      dispatcherHookName: "ImperativeHandle"
                    });
                  }, "useImperativeHandle"),
                  useLayoutEffect: /* @__PURE__ */ __name(function useLayoutEffect(create) {
                    nextHook();
                    hookLog.push({
                      displayName: null,
                      primitive: "LayoutEffect",
                      stackError: Error(),
                      value: create,
                      debugInfo: null,
                      dispatcherHookName: "LayoutEffect"
                    });
                  }, "useLayoutEffect"),
                  useInsertionEffect: /* @__PURE__ */ __name(function useInsertionEffect(create) {
                    nextHook();
                    hookLog.push({
                      displayName: null,
                      primitive: "InsertionEffect",
                      stackError: Error(),
                      value: create,
                      debugInfo: null,
                      dispatcherHookName: "InsertionEffect"
                    });
                  }, "useInsertionEffect"),
                  useMemo: /* @__PURE__ */ __name(function useMemo(nextCreate) {
                    var hook = nextHook();
                    nextCreate = null !== hook ? hook.memoizedState[0] : nextCreate();
                    hookLog.push({
                      displayName: null,
                      primitive: "Memo",
                      stackError: Error(),
                      value: nextCreate,
                      debugInfo: null,
                      dispatcherHookName: "Memo"
                    });
                    return nextCreate;
                  }, "useMemo"),
                  useReducer: /* @__PURE__ */ __name(function useReducer(reducer, initialArg, init) {
                    reducer = nextHook();
                    initialArg = null !== reducer ? reducer.memoizedState : void 0 !== init ? init(initialArg) : initialArg;
                    hookLog.push({
                      displayName: null,
                      primitive: "Reducer",
                      stackError: Error(),
                      value: initialArg,
                      debugInfo: null,
                      dispatcherHookName: "Reducer"
                    });
                    return [initialArg, function() {
                    }];
                  }, "useReducer"),
                  useRef: /* @__PURE__ */ __name(function useRef(initialValue) {
                    var hook = nextHook();
                    initialValue = null !== hook ? hook.memoizedState : {
                      current: initialValue
                    };
                    hookLog.push({
                      displayName: null,
                      primitive: "Ref",
                      stackError: Error(),
                      value: initialValue.current,
                      debugInfo: null,
                      dispatcherHookName: "Ref"
                    });
                    return initialValue;
                  }, "useRef"),
                  useState: /* @__PURE__ */ __name(function useState(initialState) {
                    var hook = nextHook();
                    initialState = null !== hook ? hook.memoizedState : "function" === typeof initialState ? initialState() : initialState;
                    hookLog.push({
                      displayName: null,
                      primitive: "State",
                      stackError: Error(),
                      value: initialState,
                      debugInfo: null,
                      dispatcherHookName: "State"
                    });
                    return [initialState, function() {
                    }];
                  }, "useState"),
                  useDebugValue: /* @__PURE__ */ __name(function useDebugValue(value, formatterFn) {
                    hookLog.push({
                      displayName: null,
                      primitive: "DebugValue",
                      stackError: Error(),
                      value: "function" === typeof formatterFn ? formatterFn(value) : value,
                      debugInfo: null,
                      dispatcherHookName: "DebugValue"
                    });
                  }, "useDebugValue"),
                  useDeferredValue: /* @__PURE__ */ __name(function useDeferredValue(value) {
                    var hook = nextHook();
                    value = null !== hook ? hook.memoizedState : value;
                    hookLog.push({
                      displayName: null,
                      primitive: "DeferredValue",
                      stackError: Error(),
                      value,
                      debugInfo: null,
                      dispatcherHookName: "DeferredValue"
                    });
                    return value;
                  }, "useDeferredValue"),
                  useTransition: /* @__PURE__ */ __name(function useTransition() {
                    var stateHook = nextHook();
                    nextHook();
                    stateHook = null !== stateHook ? stateHook.memoizedState : false;
                    hookLog.push({
                      displayName: null,
                      primitive: "Transition",
                      stackError: Error(),
                      value: stateHook,
                      debugInfo: null,
                      dispatcherHookName: "Transition"
                    });
                    return [stateHook, function() {
                    }];
                  }, "useTransition"),
                  useSyncExternalStore: /* @__PURE__ */ __name(function useSyncExternalStore(subscribe, getSnapshot) {
                    nextHook();
                    nextHook();
                    subscribe = getSnapshot();
                    hookLog.push({
                      displayName: null,
                      primitive: "SyncExternalStore",
                      stackError: Error(),
                      value: subscribe,
                      debugInfo: null,
                      dispatcherHookName: "SyncExternalStore"
                    });
                    return subscribe;
                  }, "useSyncExternalStore"),
                  useId: /* @__PURE__ */ __name(function useId() {
                    var hook = nextHook();
                    hook = null !== hook ? hook.memoizedState : "";
                    hookLog.push({
                      displayName: null,
                      primitive: "Id",
                      stackError: Error(),
                      value: hook,
                      debugInfo: null,
                      dispatcherHookName: "Id"
                    });
                    return hook;
                  }, "useId"),
                  useHostTransitionStatus: /* @__PURE__ */ __name(function useHostTransitionStatus() {
                    var status = readContext({
                      _currentValue: null
                    });
                    hookLog.push({
                      displayName: null,
                      primitive: "HostTransitionStatus",
                      stackError: Error(),
                      value: status,
                      debugInfo: null,
                      dispatcherHookName: "HostTransitionStatus"
                    });
                    return status;
                  }, "useHostTransitionStatus"),
                  useFormState: /* @__PURE__ */ __name(function useFormState(action, initialState) {
                    var hook = nextHook();
                    nextHook();
                    nextHook();
                    action = Error();
                    var debugInfo = null, error = null;
                    if (null !== hook) {
                      if (initialState = hook.memoizedState, "object" === _typeof(initialState) && null !== initialState && "function" === typeof initialState.then) switch (initialState.status) {
                        case "fulfilled":
                          var value = initialState.value;
                          debugInfo = void 0 === initialState._debugInfo ? null : initialState._debugInfo;
                          break;
                        case "rejected":
                          error = initialState.reason;
                          break;
                        default:
                          error = SuspenseException, debugInfo = void 0 === initialState._debugInfo ? null : initialState._debugInfo, value = initialState;
                      }
                      else value = initialState;
                    } else value = initialState;
                    hookLog.push({
                      displayName: null,
                      primitive: "FormState",
                      stackError: action,
                      value,
                      debugInfo,
                      dispatcherHookName: "FormState"
                    });
                    if (null !== error) throw error;
                    return [value, function() {
                    }, false];
                  }, "useFormState"),
                  useActionState: /* @__PURE__ */ __name(function useActionState(action, initialState) {
                    var hook = nextHook();
                    nextHook();
                    nextHook();
                    action = Error();
                    var debugInfo = null, error = null;
                    if (null !== hook) {
                      if (initialState = hook.memoizedState, "object" === _typeof(initialState) && null !== initialState && "function" === typeof initialState.then) switch (initialState.status) {
                        case "fulfilled":
                          var value = initialState.value;
                          debugInfo = void 0 === initialState._debugInfo ? null : initialState._debugInfo;
                          break;
                        case "rejected":
                          error = initialState.reason;
                          break;
                        default:
                          error = SuspenseException, debugInfo = void 0 === initialState._debugInfo ? null : initialState._debugInfo, value = initialState;
                      }
                      else value = initialState;
                    } else value = initialState;
                    hookLog.push({
                      displayName: null,
                      primitive: "ActionState",
                      stackError: action,
                      value,
                      debugInfo,
                      dispatcherHookName: "ActionState"
                    });
                    if (null !== error) throw error;
                    return [value, function() {
                    }, false];
                  }, "useActionState"),
                  useOptimistic: /* @__PURE__ */ __name(function useOptimistic(passthrough) {
                    var hook = nextHook();
                    passthrough = null !== hook ? hook.memoizedState : passthrough;
                    hookLog.push({
                      displayName: null,
                      primitive: "Optimistic",
                      stackError: Error(),
                      value: passthrough,
                      debugInfo: null,
                      dispatcherHookName: "Optimistic"
                    });
                    return [passthrough, function() {
                    }];
                  }, "useOptimistic"),
                  useMemoCache: /* @__PURE__ */ __name(function useMemoCache(size) {
                    var fiber = currentFiber;
                    if (null == fiber) return [];
                    fiber = null != fiber.updateQueue ? fiber.updateQueue.memoCache : null;
                    if (null == fiber) return [];
                    var data = fiber.data[fiber.index];
                    if (void 0 === data) {
                      data = fiber.data[fiber.index] = Array(size);
                      for (var i = 0; i < size; i++) data[i] = REACT_MEMO_CACHE_SENTINEL;
                    }
                    fiber.index++;
                    return data;
                  }, "useMemoCache"),
                  useCacheRefresh: /* @__PURE__ */ __name(function useCacheRefresh() {
                    var hook = nextHook();
                    hookLog.push({
                      displayName: null,
                      primitive: "CacheRefresh",
                      stackError: Error(),
                      value: null !== hook ? hook.memoizedState : function() {
                      },
                      debugInfo: null,
                      dispatcherHookName: "CacheRefresh"
                    });
                    return function() {
                    };
                  }, "useCacheRefresh"),
                  useEffectEvent: /* @__PURE__ */ __name(function useEffectEvent(callback) {
                    nextHook();
                    hookLog.push({
                      displayName: null,
                      primitive: "EffectEvent",
                      stackError: Error(),
                      value: callback,
                      debugInfo: null,
                      dispatcherHookName: "EffectEvent"
                    });
                    return callback;
                  }, "useEffectEvent")
                }, DispatcherProxyHandler = {
                  get: /* @__PURE__ */ __name(function get(target, prop) {
                    if (target.hasOwnProperty(prop)) return target[prop];
                    target = Error("Missing method in Dispatcher: " + prop);
                    target.name = "ReactDebugToolsUnsupportedHookError";
                    throw target;
                  }, "get")
                }, DispatcherProxy = "undefined" === typeof Proxy ? Dispatcher : new Proxy(Dispatcher, DispatcherProxyHandler), mostLikelyAncestorIndex = 0;
                function findSharedIndex(hookStack, rootStack, rootIndex) {
                  var source = rootStack[rootIndex].source, i = 0;
                  a: for (; i < hookStack.length; i++) if (hookStack[i].source === source) {
                    for (var a = rootIndex + 1, b = i + 1; a < rootStack.length && b < hookStack.length; a++, b++) if (hookStack[b].source !== rootStack[a].source) continue a;
                    return i;
                  }
                  return -1;
                }
                __name(findSharedIndex, "findSharedIndex");
                function isReactWrapper(functionName, wrapperName) {
                  functionName = parseHookName(functionName);
                  return "HostTransitionStatus" === wrapperName ? functionName === wrapperName || "FormStatus" === functionName : functionName === wrapperName;
                }
                __name(isReactWrapper, "isReactWrapper");
                function parseHookName(functionName) {
                  if (!functionName) return "";
                  var startIndex = functionName.lastIndexOf("[as ");
                  if (-1 !== startIndex) return parseHookName(functionName.slice(startIndex + 4, -1));
                  startIndex = functionName.lastIndexOf(".");
                  startIndex = -1 === startIndex ? 0 : startIndex + 1;
                  functionName.slice(startIndex).startsWith("unstable_") && (startIndex += 9);
                  functionName.slice(startIndex).startsWith("experimental_") && (startIndex += 13);
                  if ("use" === functionName.slice(startIndex, startIndex + 3)) {
                    if (3 === functionName.length - startIndex) return "Use";
                    startIndex += 3;
                  }
                  return functionName.slice(startIndex);
                }
                __name(parseHookName, "parseHookName");
                function buildTree(rootStack$jscomp$0, readHookLog) {
                  for (var rootChildren = [], prevStack = null, levelChildren = rootChildren, nativeHookID = 0, stackOfChildren = [], i = 0; i < readHookLog.length; i++) {
                    var hook = readHookLog[i];
                    var rootStack = rootStack$jscomp$0;
                    var JSCompiler_inline_result = ErrorStackParser.parse(hook.stackError);
                    b: {
                      var hookStack = JSCompiler_inline_result, rootIndex = findSharedIndex(hookStack, rootStack, mostLikelyAncestorIndex);
                      if (-1 !== rootIndex) rootStack = rootIndex;
                      else {
                        for (var i$jscomp$0 = 0; i$jscomp$0 < rootStack.length && 5 > i$jscomp$0; i$jscomp$0++) if (rootIndex = findSharedIndex(hookStack, rootStack, i$jscomp$0), -1 !== rootIndex) {
                          mostLikelyAncestorIndex = i$jscomp$0;
                          rootStack = rootIndex;
                          break b;
                        }
                        rootStack = -1;
                      }
                    }
                    b: {
                      hookStack = JSCompiler_inline_result;
                      rootIndex = getPrimitiveStackCache().get(hook.primitive);
                      if (void 0 !== rootIndex) {
                        for (i$jscomp$0 = 0; i$jscomp$0 < rootIndex.length && i$jscomp$0 < hookStack.length; i$jscomp$0++) if (rootIndex[i$jscomp$0].source !== hookStack[i$jscomp$0].source) {
                          i$jscomp$0 < hookStack.length - 1 && isReactWrapper(hookStack[i$jscomp$0].functionName, hook.dispatcherHookName) && i$jscomp$0++;
                          i$jscomp$0 < hookStack.length - 1 && isReactWrapper(hookStack[i$jscomp$0].functionName, hook.dispatcherHookName) && i$jscomp$0++;
                          hookStack = i$jscomp$0;
                          break b;
                        }
                      }
                      hookStack = -1;
                    }
                    JSCompiler_inline_result = -1 === rootStack || -1 === hookStack || 2 > rootStack - hookStack ? -1 === hookStack ? [null, null] : [JSCompiler_inline_result[hookStack - 1], null] : [JSCompiler_inline_result[hookStack - 1], JSCompiler_inline_result.slice(hookStack, rootStack - 1)];
                    hookStack = JSCompiler_inline_result[0];
                    JSCompiler_inline_result = JSCompiler_inline_result[1];
                    rootStack = hook.displayName;
                    null === rootStack && null !== hookStack && (rootStack = parseHookName(hookStack.functionName) || parseHookName(hook.dispatcherHookName));
                    if (null !== JSCompiler_inline_result) {
                      hookStack = 0;
                      if (null !== prevStack) {
                        for (; hookStack < JSCompiler_inline_result.length && hookStack < prevStack.length && JSCompiler_inline_result[JSCompiler_inline_result.length - hookStack - 1].source === prevStack[prevStack.length - hookStack - 1].source; ) hookStack++;
                        for (prevStack = prevStack.length - 1; prevStack > hookStack; prevStack--) levelChildren = stackOfChildren.pop();
                      }
                      for (prevStack = JSCompiler_inline_result.length - hookStack - 1; 1 <= prevStack; prevStack--) hookStack = [], rootIndex = JSCompiler_inline_result[prevStack], rootIndex = {
                        id: null,
                        isStateEditable: false,
                        name: parseHookName(JSCompiler_inline_result[prevStack - 1].functionName),
                        value: void 0,
                        subHooks: hookStack,
                        debugInfo: null,
                        hookSource: {
                          lineNumber: void 0 === rootIndex.lineNumber ? null : rootIndex.lineNumber,
                          columnNumber: void 0 === rootIndex.columnNumber ? null : rootIndex.columnNumber,
                          functionName: void 0 === rootIndex.functionName ? null : rootIndex.functionName,
                          fileName: void 0 === rootIndex.fileName ? null : rootIndex.fileName
                        }
                      }, levelChildren.push(rootIndex), stackOfChildren.push(levelChildren), levelChildren = hookStack;
                      prevStack = JSCompiler_inline_result;
                    }
                    hookStack = hook.primitive;
                    rootIndex = hook.debugInfo;
                    hook = {
                      id: "Context" === hookStack || "Context (use)" === hookStack || "DebugValue" === hookStack || "Promise" === hookStack || "Unresolved" === hookStack || "HostTransitionStatus" === hookStack ? null : nativeHookID++,
                      isStateEditable: "Reducer" === hookStack || "State" === hookStack,
                      name: rootStack || hookStack,
                      value: hook.value,
                      subHooks: [],
                      debugInfo: rootIndex,
                      hookSource: null
                    };
                    rootStack = {
                      lineNumber: null,
                      functionName: null,
                      fileName: null,
                      columnNumber: null
                    };
                    JSCompiler_inline_result && 1 <= JSCompiler_inline_result.length && (JSCompiler_inline_result = JSCompiler_inline_result[0], rootStack.lineNumber = void 0 === JSCompiler_inline_result.lineNumber ? null : JSCompiler_inline_result.lineNumber, rootStack.functionName = void 0 === JSCompiler_inline_result.functionName ? null : JSCompiler_inline_result.functionName, rootStack.fileName = void 0 === JSCompiler_inline_result.fileName ? null : JSCompiler_inline_result.fileName, rootStack.columnNumber = void 0 === JSCompiler_inline_result.columnNumber ? null : JSCompiler_inline_result.columnNumber);
                    hook.hookSource = rootStack;
                    levelChildren.push(hook);
                  }
                  processDebugValues(rootChildren, null);
                  return rootChildren;
                }
                __name(buildTree, "buildTree");
                function processDebugValues(hooksTree, parentHooksNode) {
                  for (var debugValueHooksNodes = [], i = 0; i < hooksTree.length; i++) {
                    var hooksNode = hooksTree[i];
                    "DebugValue" === hooksNode.name && 0 === hooksNode.subHooks.length ? (hooksTree.splice(i, 1), i--, debugValueHooksNodes.push(hooksNode)) : processDebugValues(hooksNode.subHooks, hooksNode);
                  }
                  null !== parentHooksNode && (1 === debugValueHooksNodes.length ? parentHooksNode.value = debugValueHooksNodes[0].value : 1 < debugValueHooksNodes.length && (parentHooksNode.value = debugValueHooksNodes.map(function(_ref) {
                    return _ref.value;
                  })));
                }
                __name(processDebugValues, "processDebugValues");
                function handleRenderFunctionError(error) {
                  if (error !== SuspenseException) {
                    if (error instanceof Error && "ReactDebugToolsUnsupportedHookError" === error.name) throw error;
                    var wrapperError = Error("Error rendering inspected component", {
                      cause: error
                    });
                    wrapperError.name = "ReactDebugToolsRenderError";
                    wrapperError.cause = error;
                    throw wrapperError;
                  }
                }
                __name(handleRenderFunctionError, "handleRenderFunctionError");
                function inspectHooks(renderFunction, props, currentDispatcher) {
                  null == currentDispatcher && (currentDispatcher = ReactSharedInternals);
                  var previousDispatcher = currentDispatcher.H;
                  currentDispatcher.H = DispatcherProxy;
                  try {
                    var ancestorStackError = Error();
                    renderFunction(props);
                  } catch (error) {
                    handleRenderFunctionError(error);
                  } finally {
                    renderFunction = hookLog, hookLog = [], currentDispatcher.H = previousDispatcher;
                  }
                  currentDispatcher = void 0 === ancestorStackError ? [] : ErrorStackParser.parse(ancestorStackError);
                  return buildTree(currentDispatcher, renderFunction);
                }
                __name(inspectHooks, "inspectHooks");
                function restoreContexts(contextMap) {
                  contextMap.forEach(function(value, context) {
                    return context._currentValue = value;
                  });
                }
                __name(restoreContexts, "restoreContexts");
                __webpack_unused_export__ = inspectHooks;
                exports2.inspectHooksOfFiber = function(fiber, currentDispatcher) {
                  null == currentDispatcher && (currentDispatcher = ReactSharedInternals);
                  if (0 !== fiber.tag && 15 !== fiber.tag && 11 !== fiber.tag) throw Error("Unknown Fiber. Needs to be a function component to inspect hooks.");
                  getPrimitiveStackCache();
                  currentHook = fiber.memoizedState;
                  currentFiber = fiber;
                  var thenableState = fiber.dependencies && fiber.dependencies._debugThenableState;
                  thenableState = thenableState ? thenableState.thenables || thenableState : null;
                  currentThenableState = Array.isArray(thenableState) ? thenableState : null;
                  currentThenableIndex = 0;
                  if (hasOwnProperty.call(currentFiber, "dependencies")) thenableState = currentFiber.dependencies, currentContextDependency = null !== thenableState ? thenableState.firstContext : null;
                  else if (hasOwnProperty.call(currentFiber, "dependencies_old")) thenableState = currentFiber.dependencies_old, currentContextDependency = null !== thenableState ? thenableState.firstContext : null;
                  else if (hasOwnProperty.call(currentFiber, "dependencies_new")) thenableState = currentFiber.dependencies_new, currentContextDependency = null !== thenableState ? thenableState.firstContext : null;
                  else if (hasOwnProperty.call(currentFiber, "contextDependencies")) thenableState = currentFiber.contextDependencies, currentContextDependency = null !== thenableState ? thenableState.first : null;
                  else throw Error("Unsupported React version. This is a bug in React Debug Tools.");
                  thenableState = fiber.type;
                  var props = fiber.memoizedProps;
                  if (thenableState !== fiber.elementType && thenableState && thenableState.defaultProps) {
                    props = assign({}, props);
                    var defaultProps = thenableState.defaultProps;
                    for (propName in defaultProps) void 0 === props[propName] && (props[propName] = defaultProps[propName]);
                  }
                  var propName = /* @__PURE__ */ new Map();
                  try {
                    if (null !== currentContextDependency && !hasOwnProperty.call(currentContextDependency, "memoizedValue")) for (defaultProps = fiber; defaultProps; ) {
                      if (10 === defaultProps.tag) {
                        var context = defaultProps.type;
                        void 0 !== context._context && (context = context._context);
                        propName.has(context) || (propName.set(context, context._currentValue), context._currentValue = defaultProps.memoizedProps.value);
                      }
                      defaultProps = defaultProps.return;
                    }
                    if (11 === fiber.tag) {
                      var renderFunction = thenableState.render;
                      context = props;
                      var ref = fiber.ref;
                      fiber = currentDispatcher;
                      var previousDispatcher = fiber.H;
                      fiber.H = DispatcherProxy;
                      try {
                        var ancestorStackError = Error();
                        renderFunction(context, ref);
                      } catch (error) {
                        handleRenderFunctionError(error);
                      } finally {
                        var readHookLog = hookLog;
                        hookLog = [];
                        fiber.H = previousDispatcher;
                      }
                      var rootStack = void 0 === ancestorStackError ? [] : ErrorStackParser.parse(ancestorStackError);
                      return buildTree(rootStack, readHookLog);
                    }
                    return inspectHooks(thenableState, props, currentDispatcher);
                  } finally {
                    currentThenableState = currentContextDependency = currentHook = currentFiber = null, currentThenableIndex = 0, restoreContexts(propName);
                  }
                };
              }
            ),
            /***/
            987: (
              /***/
              (module2, __unused_webpack_exports, __webpack_require__2) => {
                "use strict";
                if (true) {
                  module2.exports = __webpack_require__2(786);
                } else {
                }
              }
            ),
            /***/
            126: (
              /***/
              (__unused_webpack_module, exports2, __webpack_require__2) => {
                "use strict";
                var process = __webpack_require__2(169);
                function _typeof(o) {
                  "@babel/helpers - typeof";
                  return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                    return typeof o2;
                  } : function(o2) {
                    return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
                  }, _typeof(o);
                }
                __name(_typeof, "_typeof");
                var REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element"), REACT_PORTAL_TYPE = Symbol.for("react.portal"), REACT_FRAGMENT_TYPE = Symbol.for("react.fragment"), REACT_STRICT_MODE_TYPE = Symbol.for("react.strict_mode"), REACT_PROFILER_TYPE = Symbol.for("react.profiler"), REACT_CONSUMER_TYPE = Symbol.for("react.consumer"), REACT_CONTEXT_TYPE = Symbol.for("react.context"), REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref"), REACT_SUSPENSE_TYPE = Symbol.for("react.suspense"), REACT_SUSPENSE_LIST_TYPE = Symbol.for("react.suspense_list"), REACT_MEMO_TYPE = Symbol.for("react.memo"), REACT_LAZY_TYPE = Symbol.for("react.lazy"), REACT_ACTIVITY_TYPE = Symbol.for("react.activity"), REACT_POSTPONE_TYPE = Symbol.for("react.postpone"), REACT_VIEW_TRANSITION_TYPE = Symbol.for("react.view_transition"), MAYBE_ITERATOR_SYMBOL = Symbol.iterator;
                function getIteratorFn(maybeIterable) {
                  if (null === maybeIterable || "object" !== _typeof(maybeIterable)) return null;
                  maybeIterable = MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL] || maybeIterable["@@iterator"];
                  return "function" === typeof maybeIterable ? maybeIterable : null;
                }
                __name(getIteratorFn, "getIteratorFn");
                var ReactNoopUpdateQueue = {
                  isMounted: /* @__PURE__ */ __name(function isMounted() {
                    return false;
                  }, "isMounted"),
                  enqueueForceUpdate: /* @__PURE__ */ __name(function enqueueForceUpdate() {
                  }, "enqueueForceUpdate"),
                  enqueueReplaceState: /* @__PURE__ */ __name(function enqueueReplaceState() {
                  }, "enqueueReplaceState"),
                  enqueueSetState: /* @__PURE__ */ __name(function enqueueSetState() {
                  }, "enqueueSetState")
                }, assign = Object.assign, emptyObject = {};
                function Component(props, context, updater) {
                  this.props = props;
                  this.context = context;
                  this.refs = emptyObject;
                  this.updater = updater || ReactNoopUpdateQueue;
                }
                __name(Component, "Component");
                Component.prototype.isReactComponent = {};
                Component.prototype.setState = function(partialState, callback) {
                  if ("object" !== _typeof(partialState) && "function" !== typeof partialState && null != partialState) throw Error("takes an object of state variables to update or a function which returns an object of state variables.");
                  this.updater.enqueueSetState(this, partialState, callback, "setState");
                };
                Component.prototype.forceUpdate = function(callback) {
                  this.updater.enqueueForceUpdate(this, callback, "forceUpdate");
                };
                function ComponentDummy() {
                }
                __name(ComponentDummy, "ComponentDummy");
                ComponentDummy.prototype = Component.prototype;
                function PureComponent(props, context, updater) {
                  this.props = props;
                  this.context = context;
                  this.refs = emptyObject;
                  this.updater = updater || ReactNoopUpdateQueue;
                }
                __name(PureComponent, "PureComponent");
                var pureComponentPrototype = PureComponent.prototype = new ComponentDummy();
                pureComponentPrototype.constructor = PureComponent;
                assign(pureComponentPrototype, Component.prototype);
                pureComponentPrototype.isPureReactComponent = true;
                var isArrayImpl = Array.isArray;
                function noop() {
                }
                __name(noop, "noop");
                var ReactSharedInternals = {
                  H: null,
                  A: null,
                  T: null,
                  S: null,
                  G: null
                }, hasOwnProperty = Object.prototype.hasOwnProperty;
                function ReactElement(type, key, props) {
                  var refProp = props.ref;
                  return {
                    $$typeof: REACT_ELEMENT_TYPE,
                    type,
                    key,
                    ref: void 0 !== refProp ? refProp : null,
                    props
                  };
                }
                __name(ReactElement, "ReactElement");
                function cloneAndReplaceKey(oldElement, newKey) {
                  return ReactElement(oldElement.type, newKey, oldElement.props);
                }
                __name(cloneAndReplaceKey, "cloneAndReplaceKey");
                function isValidElement(object) {
                  return "object" === _typeof(object) && null !== object && object.$$typeof === REACT_ELEMENT_TYPE;
                }
                __name(isValidElement, "isValidElement");
                function escape(key) {
                  var escaperLookup = {
                    "=": "=0",
                    ":": "=2"
                  };
                  return "$" + key.replace(/[=:]/g, function(match) {
                    return escaperLookup[match];
                  });
                }
                __name(escape, "escape");
                var userProvidedKeyEscapeRegex = /\/+/g;
                function getElementKey(element, index) {
                  return "object" === _typeof(element) && null !== element && null != element.key ? escape("" + element.key) : index.toString(36);
                }
                __name(getElementKey, "getElementKey");
                function resolveThenable(thenable) {
                  switch (thenable.status) {
                    case "fulfilled":
                      return thenable.value;
                    case "rejected":
                      throw thenable.reason;
                    default:
                      switch ("string" === typeof thenable.status ? thenable.then(noop, noop) : (thenable.status = "pending", thenable.then(function(fulfilledValue) {
                        "pending" === thenable.status && (thenable.status = "fulfilled", thenable.value = fulfilledValue);
                      }, function(error) {
                        "pending" === thenable.status && (thenable.status = "rejected", thenable.reason = error);
                      })), thenable.status) {
                        case "fulfilled":
                          return thenable.value;
                        case "rejected":
                          throw thenable.reason;
                      }
                  }
                  throw thenable;
                }
                __name(resolveThenable, "resolveThenable");
                function mapIntoArray(children, array, escapedPrefix, nameSoFar, callback) {
                  var type = _typeof(children);
                  if ("undefined" === type || "boolean" === type) children = null;
                  var invokeCallback = false;
                  if (null === children) invokeCallback = true;
                  else switch (type) {
                    case "bigint":
                    case "string":
                    case "number":
                      invokeCallback = true;
                      break;
                    case "object":
                      switch (children.$$typeof) {
                        case REACT_ELEMENT_TYPE:
                        case REACT_PORTAL_TYPE:
                          invokeCallback = true;
                          break;
                        case REACT_LAZY_TYPE:
                          return invokeCallback = children._init, mapIntoArray(invokeCallback(children._payload), array, escapedPrefix, nameSoFar, callback);
                      }
                  }
                  if (invokeCallback) return callback = callback(children), invokeCallback = "" === nameSoFar ? "." + getElementKey(children, 0) : nameSoFar, isArrayImpl(callback) ? (escapedPrefix = "", null != invokeCallback && (escapedPrefix = invokeCallback.replace(userProvidedKeyEscapeRegex, "$&/") + "/"), mapIntoArray(callback, array, escapedPrefix, "", function(c) {
                    return c;
                  })) : null != callback && (isValidElement(callback) && (callback = cloneAndReplaceKey(callback, escapedPrefix + (null == callback.key || children && children.key === callback.key ? "" : ("" + callback.key).replace(userProvidedKeyEscapeRegex, "$&/") + "/") + invokeCallback)), array.push(callback)), 1;
                  invokeCallback = 0;
                  var nextNamePrefix = "" === nameSoFar ? "." : nameSoFar + ":";
                  if (isArrayImpl(children)) for (var i = 0; i < children.length; i++) nameSoFar = children[i], type = nextNamePrefix + getElementKey(nameSoFar, i), invokeCallback += mapIntoArray(nameSoFar, array, escapedPrefix, type, callback);
                  else if (i = getIteratorFn(children), "function" === typeof i) for (children = i.call(children), i = 0; !(nameSoFar = children.next()).done; ) nameSoFar = nameSoFar.value, type = nextNamePrefix + getElementKey(nameSoFar, i++), invokeCallback += mapIntoArray(nameSoFar, array, escapedPrefix, type, callback);
                  else if ("object" === type) {
                    if ("function" === typeof children.then) return mapIntoArray(resolveThenable(children), array, escapedPrefix, nameSoFar, callback);
                    array = String(children);
                    throw Error("Objects are not valid as a React child (found: " + ("[object Object]" === array ? "object with keys {" + Object.keys(children).join(", ") + "}" : array) + "). If you meant to render a collection of children, use an array instead.");
                  }
                  return invokeCallback;
                }
                __name(mapIntoArray, "mapIntoArray");
                function mapChildren(children, func, context) {
                  if (null == children) return children;
                  var result = [], count = 0;
                  mapIntoArray(children, result, "", "", function(child) {
                    return func.call(context, child, count++);
                  });
                  return result;
                }
                __name(mapChildren, "mapChildren");
                function lazyInitializer(payload) {
                  if (-1 === payload._status) {
                    var ctor = payload._result;
                    ctor = ctor();
                    ctor.then(function(moduleObject) {
                      if (0 === payload._status || -1 === payload._status) payload._status = 1, payload._result = moduleObject;
                    }, function(error) {
                      if (0 === payload._status || -1 === payload._status) payload._status = 2, payload._result = error;
                    });
                    -1 === payload._status && (payload._status = 0, payload._result = ctor);
                  }
                  if (1 === payload._status) return payload._result.default;
                  throw payload._result;
                }
                __name(lazyInitializer, "lazyInitializer");
                function useOptimistic(passthrough, reducer) {
                  return ReactSharedInternals.H.useOptimistic(passthrough, reducer);
                }
                __name(useOptimistic, "useOptimistic");
                var reportGlobalError = "function" === typeof reportError ? reportError : function(error) {
                  if ("object" === (typeof window === "undefined" ? "undefined" : _typeof(window)) && "function" === typeof window.ErrorEvent) {
                    var event = new window.ErrorEvent("error", {
                      bubbles: true,
                      cancelable: true,
                      message: "object" === _typeof(error) && null !== error && "string" === typeof error.message ? String(error.message) : String(error),
                      error
                    });
                    if (!window.dispatchEvent(event)) return;
                  } else if ("object" === (typeof process === "undefined" ? "undefined" : _typeof(process)) && "function" === typeof process.emit) {
                    process.emit("uncaughtException", error);
                    return;
                  }
                  console.error(error);
                };
                function startTransition(scope) {
                  var prevTransition = ReactSharedInternals.T, currentTransition = {};
                  currentTransition.types = null !== prevTransition ? prevTransition.types : null;
                  currentTransition.gesture = null;
                  ReactSharedInternals.T = currentTransition;
                  try {
                    var returnValue = scope(), onStartTransitionFinish = ReactSharedInternals.S;
                    null !== onStartTransitionFinish && onStartTransitionFinish(currentTransition, returnValue);
                    "object" === _typeof(returnValue) && null !== returnValue && "function" === typeof returnValue.then && returnValue.then(noop, reportGlobalError);
                  } catch (error) {
                    reportGlobalError(error);
                  } finally {
                    null !== prevTransition && null !== currentTransition.types && (prevTransition.types = currentTransition.types), ReactSharedInternals.T = prevTransition;
                  }
                }
                __name(startTransition, "startTransition");
                function addTransitionType(type) {
                  var transition = ReactSharedInternals.T;
                  if (null !== transition) {
                    var transitionTypes = transition.types;
                    null === transitionTypes ? transition.types = [type] : -1 === transitionTypes.indexOf(type) && transitionTypes.push(type);
                  } else startTransition(addTransitionType.bind(null, type));
                }
                __name(addTransitionType, "addTransitionType");
                var Children = {
                  map: mapChildren,
                  forEach: /* @__PURE__ */ __name(function forEach(children, forEachFunc, forEachContext) {
                    mapChildren(children, function() {
                      forEachFunc.apply(this, arguments);
                    }, forEachContext);
                  }, "forEach"),
                  count: /* @__PURE__ */ __name(function count(children) {
                    var n = 0;
                    mapChildren(children, function() {
                      n++;
                    });
                    return n;
                  }, "count"),
                  toArray: /* @__PURE__ */ __name(function toArray(children) {
                    return mapChildren(children, function(child) {
                      return child;
                    }) || [];
                  }, "toArray"),
                  only: /* @__PURE__ */ __name(function only(children) {
                    if (!isValidElement(children)) throw Error("React.Children.only expected to receive a single React element child.");
                    return children;
                  }, "only")
                };
                exports2.Activity = REACT_ACTIVITY_TYPE;
                exports2.Children = Children;
                exports2.Component = Component;
                exports2.Fragment = REACT_FRAGMENT_TYPE;
                exports2.Profiler = REACT_PROFILER_TYPE;
                exports2.PureComponent = PureComponent;
                exports2.StrictMode = REACT_STRICT_MODE_TYPE;
                exports2.Suspense = REACT_SUSPENSE_TYPE;
                exports2.ViewTransition = REACT_VIEW_TRANSITION_TYPE;
                exports2.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = ReactSharedInternals;
                exports2.__COMPILER_RUNTIME = {
                  __proto__: null,
                  c: /* @__PURE__ */ __name(function c(size) {
                    return ReactSharedInternals.H.useMemoCache(size);
                  }, "c")
                };
                exports2.addTransitionType = addTransitionType;
                exports2.cache = function(fn) {
                  return function() {
                    return fn.apply(null, arguments);
                  };
                };
                exports2.cacheSignal = function() {
                  return null;
                };
                exports2.cloneElement = function(element, config, children) {
                  if (null === element || void 0 === element) throw Error("The argument must be a React element, but you passed " + element + ".");
                  var props = assign({}, element.props), key = element.key;
                  if (null != config) for (propName in void 0 !== config.key && (key = "" + config.key), config) !hasOwnProperty.call(config, propName) || "key" === propName || "__self" === propName || "__source" === propName || "ref" === propName && void 0 === config.ref || (props[propName] = config[propName]);
                  var propName = arguments.length - 2;
                  if (1 === propName) props.children = children;
                  else if (1 < propName) {
                    for (var childArray = Array(propName), i = 0; i < propName; i++) childArray[i] = arguments[i + 2];
                    props.children = childArray;
                  }
                  return ReactElement(element.type, key, props);
                };
                exports2.createContext = function(defaultValue) {
                  defaultValue = {
                    $$typeof: REACT_CONTEXT_TYPE,
                    _currentValue: defaultValue,
                    _currentValue2: defaultValue,
                    _threadCount: 0,
                    Provider: null,
                    Consumer: null
                  };
                  defaultValue.Provider = defaultValue;
                  defaultValue.Consumer = {
                    $$typeof: REACT_CONSUMER_TYPE,
                    _context: defaultValue
                  };
                  return defaultValue;
                };
                exports2.createElement = function(type, config, children) {
                  var propName, props = {}, key = null;
                  if (null != config) for (propName in void 0 !== config.key && (key = "" + config.key), config) hasOwnProperty.call(config, propName) && "key" !== propName && "__self" !== propName && "__source" !== propName && (props[propName] = config[propName]);
                  var childrenLength = arguments.length - 2;
                  if (1 === childrenLength) props.children = children;
                  else if (1 < childrenLength) {
                    for (var childArray = Array(childrenLength), i = 0; i < childrenLength; i++) childArray[i] = arguments[i + 2];
                    props.children = childArray;
                  }
                  if (type && type.defaultProps) for (propName in childrenLength = type.defaultProps, childrenLength) void 0 === props[propName] && (props[propName] = childrenLength[propName]);
                  return ReactElement(type, key, props);
                };
                exports2.createRef = function() {
                  return {
                    current: null
                  };
                };
                exports2.experimental_useOptimistic = function(passthrough, reducer) {
                  return useOptimistic(passthrough, reducer);
                };
                exports2.forwardRef = function(render) {
                  return {
                    $$typeof: REACT_FORWARD_REF_TYPE,
                    render
                  };
                };
                exports2.isValidElement = isValidElement;
                exports2.lazy = function(ctor) {
                  return {
                    $$typeof: REACT_LAZY_TYPE,
                    _payload: {
                      _status: -1,
                      _result: ctor
                    },
                    _init: lazyInitializer
                  };
                };
                exports2.memo = function(type, compare) {
                  return {
                    $$typeof: REACT_MEMO_TYPE,
                    type,
                    compare: void 0 === compare ? null : compare
                  };
                };
                exports2.startTransition = startTransition;
                exports2.unstable_Activity = REACT_ACTIVITY_TYPE;
                exports2.unstable_SuspenseList = REACT_SUSPENSE_LIST_TYPE;
                exports2.unstable_getCacheForType = function(resourceType) {
                  var dispatcher = ReactSharedInternals.A;
                  return dispatcher ? dispatcher.getCacheForType(resourceType) : resourceType();
                };
                exports2.unstable_postpone = function(reason) {
                  reason = Error(reason);
                  reason.$$typeof = REACT_POSTPONE_TYPE;
                  throw reason;
                };
                exports2.unstable_startGestureTransition = function(provider, scope, options) {
                  if (null == provider) throw Error("A Timeline is required as the first argument to startGestureTransition.");
                  var prevTransition = ReactSharedInternals.T, currentTransition = {
                    types: null
                  };
                  currentTransition.gesture = provider;
                  ReactSharedInternals.T = currentTransition;
                  try {
                    scope();
                    var onStartGestureTransitionFinish = ReactSharedInternals.G;
                    if (null !== onStartGestureTransitionFinish) return onStartGestureTransitionFinish(currentTransition, provider, options);
                  } catch (error) {
                    reportGlobalError(error);
                  } finally {
                    ReactSharedInternals.T = prevTransition;
                  }
                  return noop;
                };
                exports2.unstable_useCacheRefresh = function() {
                  return ReactSharedInternals.H.useCacheRefresh();
                };
                exports2.use = function(usable) {
                  return ReactSharedInternals.H.use(usable);
                };
                exports2.useActionState = function(action, initialState, permalink) {
                  return ReactSharedInternals.H.useActionState(action, initialState, permalink);
                };
                exports2.useCallback = function(callback, deps) {
                  return ReactSharedInternals.H.useCallback(callback, deps);
                };
                exports2.useContext = function(Context) {
                  return ReactSharedInternals.H.useContext(Context);
                };
                exports2.useDebugValue = function() {
                };
                exports2.useDeferredValue = function(value, initialValue) {
                  return ReactSharedInternals.H.useDeferredValue(value, initialValue);
                };
                exports2.useEffect = function(create, deps) {
                  return ReactSharedInternals.H.useEffect(create, deps);
                };
                exports2.useEffectEvent = function(callback) {
                  return ReactSharedInternals.H.useEffectEvent(callback);
                };
                exports2.useId = function() {
                  return ReactSharedInternals.H.useId();
                };
                exports2.useImperativeHandle = function(ref, create, deps) {
                  return ReactSharedInternals.H.useImperativeHandle(ref, create, deps);
                };
                exports2.useInsertionEffect = function(create, deps) {
                  return ReactSharedInternals.H.useInsertionEffect(create, deps);
                };
                exports2.useLayoutEffect = function(create, deps) {
                  return ReactSharedInternals.H.useLayoutEffect(create, deps);
                };
                exports2.useMemo = function(create, deps) {
                  return ReactSharedInternals.H.useMemo(create, deps);
                };
                exports2.useOptimistic = useOptimistic;
                exports2.useReducer = function(reducer, initialArg, init) {
                  return ReactSharedInternals.H.useReducer(reducer, initialArg, init);
                };
                exports2.useRef = function(initialValue) {
                  return ReactSharedInternals.H.useRef(initialValue);
                };
                exports2.useState = function(initialState) {
                  return ReactSharedInternals.H.useState(initialState);
                };
                exports2.useSyncExternalStore = function(subscribe, getSnapshot, getServerSnapshot) {
                  return ReactSharedInternals.H.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
                };
                exports2.useTransition = function() {
                  return ReactSharedInternals.H.useTransition();
                };
                exports2.version = "19.3.0-experimental-3cde211b-20251020";
              }
            ),
            /***/
            189: (
              /***/
              (module2, __unused_webpack_exports, __webpack_require__2) => {
                "use strict";
                if (true) {
                  module2.exports = __webpack_require__2(126);
                } else {
                }
              }
            ),
            /***/
            206: (
              /***/
              function(module2, exports2, __webpack_require__2) {
                var __WEBPACK_AMD_DEFINE_FACTORY__, __WEBPACK_AMD_DEFINE_ARRAY__, __WEBPACK_AMD_DEFINE_RESULT__;
                function _typeof(o) {
                  "@babel/helpers - typeof";
                  return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                    return typeof o2;
                  } : function(o2) {
                    return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
                  }, _typeof(o);
                }
                __name(_typeof, "_typeof");
                (function(root, factory) {
                  "use strict";
                  if (true) {
                    !(__WEBPACK_AMD_DEFINE_ARRAY__ = [__webpack_require__2(430)], __WEBPACK_AMD_DEFINE_FACTORY__ = factory, __WEBPACK_AMD_DEFINE_RESULT__ = typeof __WEBPACK_AMD_DEFINE_FACTORY__ === "function" ? __WEBPACK_AMD_DEFINE_FACTORY__.apply(exports2, __WEBPACK_AMD_DEFINE_ARRAY__) : __WEBPACK_AMD_DEFINE_FACTORY__, __WEBPACK_AMD_DEFINE_RESULT__ !== void 0 && (module2.exports = __WEBPACK_AMD_DEFINE_RESULT__));
                  } else {
                  }
                })(this, /* @__PURE__ */ __name(function ErrorStackParser(StackFrame) {
                  "use strict";
                  var FIREFOX_SAFARI_STACK_REGEXP = /(^|@)\S+:\d+/;
                  var CHROME_IE_STACK_REGEXP = /^\s*at .*(\S+:\d+|\(native\))/m;
                  var SAFARI_NATIVE_CODE_REGEXP = /^(eval@)?(\[native code])?$/;
                  return {
                    parse: /* @__PURE__ */ __name(function ErrorStackParser$$parse(error) {
                      if (typeof error.stacktrace !== "undefined" || typeof error["opera#sourceloc"] !== "undefined") {
                        return this.parseOpera(error);
                      } else if (error.stack && error.stack.match(CHROME_IE_STACK_REGEXP)) {
                        return this.parseV8OrIE(error);
                      } else if (error.stack) {
                        return this.parseFFOrSafari(error);
                      } else {
                        throw new Error("Cannot parse given Error object");
                      }
                    }, "ErrorStackParser$$parse"),
                    extractLocation: /* @__PURE__ */ __name(function ErrorStackParser$$extractLocation(urlLike) {
                      if (urlLike.indexOf(":") === -1) {
                        return [urlLike];
                      }
                      var regExp = /(.+?)(?::(\d+))?(?::(\d+))?$/;
                      var parts = regExp.exec(urlLike.replace(/[()]/g, ""));
                      return [parts[1], parts[2] || void 0, parts[3] || void 0];
                    }, "ErrorStackParser$$extractLocation"),
                    parseV8OrIE: /* @__PURE__ */ __name(function ErrorStackParser$$parseV8OrIE(error) {
                      var filtered = error.stack.split("\n").filter(function(line) {
                        return !!line.match(CHROME_IE_STACK_REGEXP);
                      }, this);
                      return filtered.map(function(line) {
                        if (line.indexOf("(eval ") > -1) {
                          line = line.replace(/eval code/g, "eval").replace(/(\(eval at [^()]*)|(\),.*$)/g, "");
                        }
                        var sanitizedLine = line.replace(/^\s+/, "").replace(/\(eval code/g, "(");
                        var location = sanitizedLine.match(/ (\((.+):(\d+):(\d+)\)$)/);
                        sanitizedLine = location ? sanitizedLine.replace(location[0], "") : sanitizedLine;
                        var tokens = sanitizedLine.split(/\s+/).slice(1);
                        var locationParts = this.extractLocation(location ? location[1] : tokens.pop());
                        var functionName = tokens.join(" ") || void 0;
                        var fileName = ["eval", "<anonymous>"].indexOf(locationParts[0]) > -1 ? void 0 : locationParts[0];
                        return new StackFrame({
                          functionName,
                          fileName,
                          lineNumber: locationParts[1],
                          columnNumber: locationParts[2],
                          source: line
                        });
                      }, this);
                    }, "ErrorStackParser$$parseV8OrIE"),
                    parseFFOrSafari: /* @__PURE__ */ __name(function ErrorStackParser$$parseFFOrSafari(error) {
                      var filtered = error.stack.split("\n").filter(function(line) {
                        return !line.match(SAFARI_NATIVE_CODE_REGEXP);
                      }, this);
                      return filtered.map(function(line) {
                        if (line.indexOf(" > eval") > -1) {
                          line = line.replace(/ line (\d+)(?: > eval line \d+)* > eval:\d+:\d+/g, ":$1");
                        }
                        if (line.indexOf("@") === -1 && line.indexOf(":") === -1) {
                          return new StackFrame({
                            functionName: line
                          });
                        } else {
                          var functionNameRegex = /((.*".+"[^@]*)?[^@]*)(?:@)/;
                          var matches = line.match(functionNameRegex);
                          var functionName = matches && matches[1] ? matches[1] : void 0;
                          var locationParts = this.extractLocation(line.replace(functionNameRegex, ""));
                          return new StackFrame({
                            functionName,
                            fileName: locationParts[0],
                            lineNumber: locationParts[1],
                            columnNumber: locationParts[2],
                            source: line
                          });
                        }
                      }, this);
                    }, "ErrorStackParser$$parseFFOrSafari"),
                    parseOpera: /* @__PURE__ */ __name(function ErrorStackParser$$parseOpera(e) {
                      if (!e.stacktrace || e.message.indexOf("\n") > -1 && e.message.split("\n").length > e.stacktrace.split("\n").length) {
                        return this.parseOpera9(e);
                      } else if (!e.stack) {
                        return this.parseOpera10(e);
                      } else {
                        return this.parseOpera11(e);
                      }
                    }, "ErrorStackParser$$parseOpera"),
                    parseOpera9: /* @__PURE__ */ __name(function ErrorStackParser$$parseOpera9(e) {
                      var lineRE = /Line (\d+).*script (?:in )?(\S+)/i;
                      var lines = e.message.split("\n");
                      var result = [];
                      for (var i = 2, len = lines.length; i < len; i += 2) {
                        var match = lineRE.exec(lines[i]);
                        if (match) {
                          result.push(new StackFrame({
                            fileName: match[2],
                            lineNumber: match[1],
                            source: lines[i]
                          }));
                        }
                      }
                      return result;
                    }, "ErrorStackParser$$parseOpera9"),
                    parseOpera10: /* @__PURE__ */ __name(function ErrorStackParser$$parseOpera10(e) {
                      var lineRE = /Line (\d+).*script (?:in )?(\S+)(?:: In function (\S+))?$/i;
                      var lines = e.stacktrace.split("\n");
                      var result = [];
                      for (var i = 0, len = lines.length; i < len; i += 2) {
                        var match = lineRE.exec(lines[i]);
                        if (match) {
                          result.push(new StackFrame({
                            functionName: match[3] || void 0,
                            fileName: match[2],
                            lineNumber: match[1],
                            source: lines[i]
                          }));
                        }
                      }
                      return result;
                    }, "ErrorStackParser$$parseOpera10"),
                    parseOpera11: /* @__PURE__ */ __name(function ErrorStackParser$$parseOpera11(error) {
                      var filtered = error.stack.split("\n").filter(function(line) {
                        return !!line.match(FIREFOX_SAFARI_STACK_REGEXP) && !line.match(/^Error created at/);
                      }, this);
                      return filtered.map(function(line) {
                        var tokens = line.split("@");
                        var locationParts = this.extractLocation(tokens.pop());
                        var functionCall = tokens.shift() || "";
                        var functionName = functionCall.replace(/<anonymous function(: (\w+))?>/, "$2").replace(/\([^)]*\)/g, "") || void 0;
                        var argsRaw;
                        if (functionCall.match(/\(([^)]*)\)/)) {
                          argsRaw = functionCall.replace(/^[^(]+\(([^)]*)\)$/, "$1");
                        }
                        var args = argsRaw === void 0 || argsRaw === "[arguments not available]" ? void 0 : argsRaw.split(",");
                        return new StackFrame({
                          functionName,
                          args,
                          fileName: locationParts[0],
                          lineNumber: locationParts[1],
                          columnNumber: locationParts[2],
                          source: line
                        });
                      }, this);
                    }, "ErrorStackParser$$parseOpera11")
                  };
                }, "ErrorStackParser"));
              }
            ),
            /***/
            730: (
              /***/
              (module2, __unused_webpack_exports, __webpack_require__2) => {
                "use strict";
                function _typeof(o) {
                  "@babel/helpers - typeof";
                  return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                    return typeof o2;
                  } : function(o2) {
                    return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
                  }, _typeof(o);
                }
                __name(_typeof, "_typeof");
                function _classCallCheck(instance, Constructor) {
                  if (!(instance instanceof Constructor)) {
                    throw new TypeError("Cannot call a class as a function");
                  }
                }
                __name(_classCallCheck, "_classCallCheck");
                function _defineProperties(target, props) {
                  for (var i = 0; i < props.length; i++) {
                    var descriptor = props[i];
                    descriptor.enumerable = descriptor.enumerable || false;
                    descriptor.configurable = true;
                    if ("value" in descriptor) descriptor.writable = true;
                    Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor);
                  }
                }
                __name(_defineProperties, "_defineProperties");
                function _createClass(Constructor, protoProps, staticProps) {
                  if (protoProps) _defineProperties(Constructor.prototype, protoProps);
                  if (staticProps) _defineProperties(Constructor, staticProps);
                  Object.defineProperty(Constructor, "prototype", { writable: false });
                  return Constructor;
                }
                __name(_createClass, "_createClass");
                function _toPropertyKey(t) {
                  var i = _toPrimitive(t, "string");
                  return "symbol" == _typeof(i) ? i : i + "";
                }
                __name(_toPropertyKey, "_toPropertyKey");
                function _toPrimitive(t, r) {
                  if ("object" != _typeof(t) || !t) return t;
                  var e = t[Symbol.toPrimitive];
                  if (void 0 !== e) {
                    var i = e.call(t, r || "default");
                    if ("object" != _typeof(i)) return i;
                    throw new TypeError("@@toPrimitive must return a primitive value.");
                  }
                  return ("string" === r ? String : Number)(t);
                }
                __name(_toPrimitive, "_toPrimitive");
                var Yallist = __webpack_require__2(695);
                var MAX = Symbol("max");
                var LENGTH = Symbol("length");
                var LENGTH_CALCULATOR = Symbol("lengthCalculator");
                var ALLOW_STALE = Symbol("allowStale");
                var MAX_AGE = Symbol("maxAge");
                var DISPOSE = Symbol("dispose");
                var NO_DISPOSE_ON_SET = Symbol("noDisposeOnSet");
                var LRU_LIST = Symbol("lruList");
                var CACHE = Symbol("cache");
                var UPDATE_AGE_ON_GET = Symbol("updateAgeOnGet");
                var naiveLength = /* @__PURE__ */ __name(function naiveLength2() {
                  return 1;
                }, "naiveLength");
                var LRUCache = /* @__PURE__ */ function() {
                  function LRUCache2(options) {
                    _classCallCheck(this, LRUCache2);
                    if (typeof options === "number") options = {
                      max: options
                    };
                    if (!options) options = {};
                    if (options.max && (typeof options.max !== "number" || options.max < 0)) throw new TypeError("max must be a non-negative number");
                    var max = this[MAX] = options.max || Infinity;
                    var lc = options.length || naiveLength;
                    this[LENGTH_CALCULATOR] = typeof lc !== "function" ? naiveLength : lc;
                    this[ALLOW_STALE] = options.stale || false;
                    if (options.maxAge && typeof options.maxAge !== "number") throw new TypeError("maxAge must be a number");
                    this[MAX_AGE] = options.maxAge || 0;
                    this[DISPOSE] = options.dispose;
                    this[NO_DISPOSE_ON_SET] = options.noDisposeOnSet || false;
                    this[UPDATE_AGE_ON_GET] = options.updateAgeOnGet || false;
                    this.reset();
                  }
                  __name(LRUCache2, "LRUCache");
                  return _createClass(LRUCache2, [{
                    key: "max",
                    get: /* @__PURE__ */ __name(function get() {
                      return this[MAX];
                    }, "get"),
                    set: /* @__PURE__ */ __name(function set(mL) {
                      if (typeof mL !== "number" || mL < 0) throw new TypeError("max must be a non-negative number");
                      this[MAX] = mL || Infinity;
                      trim(this);
                    }, "set")
                  }, {
                    key: "allowStale",
                    get: /* @__PURE__ */ __name(function get() {
                      return this[ALLOW_STALE];
                    }, "get"),
                    set: /* @__PURE__ */ __name(function set(allowStale) {
                      this[ALLOW_STALE] = !!allowStale;
                    }, "set")
                  }, {
                    key: "maxAge",
                    get: /* @__PURE__ */ __name(function get() {
                      return this[MAX_AGE];
                    }, "get"),
                    set: /* @__PURE__ */ __name(function set(mA) {
                      if (typeof mA !== "number") throw new TypeError("maxAge must be a non-negative number");
                      this[MAX_AGE] = mA;
                      trim(this);
                    }, "set")
                  }, {
                    key: "lengthCalculator",
                    get: /* @__PURE__ */ __name(function get() {
                      return this[LENGTH_CALCULATOR];
                    }, "get"),
                    set: /* @__PURE__ */ __name(function set(lC) {
                      var _this = this;
                      if (typeof lC !== "function") lC = naiveLength;
                      if (lC !== this[LENGTH_CALCULATOR]) {
                        this[LENGTH_CALCULATOR] = lC;
                        this[LENGTH] = 0;
                        this[LRU_LIST].forEach(function(hit) {
                          hit.length = _this[LENGTH_CALCULATOR](hit.value, hit.key);
                          _this[LENGTH] += hit.length;
                        });
                      }
                      trim(this);
                    }, "set")
                  }, {
                    key: "length",
                    get: /* @__PURE__ */ __name(function get() {
                      return this[LENGTH];
                    }, "get")
                  }, {
                    key: "itemCount",
                    get: /* @__PURE__ */ __name(function get() {
                      return this[LRU_LIST].length;
                    }, "get")
                  }, {
                    key: "rforEach",
                    value: /* @__PURE__ */ __name(function rforEach(fn, thisp) {
                      thisp = thisp || this;
                      for (var walker = this[LRU_LIST].tail; walker !== null; ) {
                        var prev = walker.prev;
                        forEachStep(this, fn, walker, thisp);
                        walker = prev;
                      }
                    }, "rforEach")
                  }, {
                    key: "forEach",
                    value: /* @__PURE__ */ __name(function forEach(fn, thisp) {
                      thisp = thisp || this;
                      for (var walker = this[LRU_LIST].head; walker !== null; ) {
                        var next = walker.next;
                        forEachStep(this, fn, walker, thisp);
                        walker = next;
                      }
                    }, "forEach")
                  }, {
                    key: "keys",
                    value: /* @__PURE__ */ __name(function keys() {
                      return this[LRU_LIST].toArray().map(function(k) {
                        return k.key;
                      });
                    }, "keys")
                  }, {
                    key: "values",
                    value: /* @__PURE__ */ __name(function values() {
                      return this[LRU_LIST].toArray().map(function(k) {
                        return k.value;
                      });
                    }, "values")
                  }, {
                    key: "reset",
                    value: /* @__PURE__ */ __name(function reset() {
                      var _this2 = this;
                      if (this[DISPOSE] && this[LRU_LIST] && this[LRU_LIST].length) {
                        this[LRU_LIST].forEach(function(hit) {
                          return _this2[DISPOSE](hit.key, hit.value);
                        });
                      }
                      this[CACHE] = /* @__PURE__ */ new Map();
                      this[LRU_LIST] = new Yallist();
                      this[LENGTH] = 0;
                    }, "reset")
                  }, {
                    key: "dump",
                    value: /* @__PURE__ */ __name(function dump() {
                      var _this3 = this;
                      return this[LRU_LIST].map(function(hit) {
                        return isStale(_this3, hit) ? false : {
                          k: hit.key,
                          v: hit.value,
                          e: hit.now + (hit.maxAge || 0)
                        };
                      }).toArray().filter(function(h) {
                        return h;
                      });
                    }, "dump")
                  }, {
                    key: "dumpLru",
                    value: /* @__PURE__ */ __name(function dumpLru() {
                      return this[LRU_LIST];
                    }, "dumpLru")
                  }, {
                    key: "set",
                    value: /* @__PURE__ */ __name(function set(key, value, maxAge) {
                      maxAge = maxAge || this[MAX_AGE];
                      if (maxAge && typeof maxAge !== "number") throw new TypeError("maxAge must be a number");
                      var now = maxAge ? Date.now() : 0;
                      var len = this[LENGTH_CALCULATOR](value, key);
                      if (this[CACHE].has(key)) {
                        if (len > this[MAX]) {
                          _del(this, this[CACHE].get(key));
                          return false;
                        }
                        var node = this[CACHE].get(key);
                        var item = node.value;
                        if (this[DISPOSE]) {
                          if (!this[NO_DISPOSE_ON_SET]) this[DISPOSE](key, item.value);
                        }
                        item.now = now;
                        item.maxAge = maxAge;
                        item.value = value;
                        this[LENGTH] += len - item.length;
                        item.length = len;
                        this.get(key);
                        trim(this);
                        return true;
                      }
                      var hit = new Entry(key, value, len, now, maxAge);
                      if (hit.length > this[MAX]) {
                        if (this[DISPOSE]) this[DISPOSE](key, value);
                        return false;
                      }
                      this[LENGTH] += hit.length;
                      this[LRU_LIST].unshift(hit);
                      this[CACHE].set(key, this[LRU_LIST].head);
                      trim(this);
                      return true;
                    }, "set")
                  }, {
                    key: "has",
                    value: /* @__PURE__ */ __name(function has(key) {
                      if (!this[CACHE].has(key)) return false;
                      var hit = this[CACHE].get(key).value;
                      return !isStale(this, hit);
                    }, "has")
                  }, {
                    key: "get",
                    value: /* @__PURE__ */ __name(function get(key) {
                      return _get(this, key, true);
                    }, "get")
                  }, {
                    key: "peek",
                    value: /* @__PURE__ */ __name(function peek(key) {
                      return _get(this, key, false);
                    }, "peek")
                  }, {
                    key: "pop",
                    value: /* @__PURE__ */ __name(function pop() {
                      var node = this[LRU_LIST].tail;
                      if (!node) return null;
                      _del(this, node);
                      return node.value;
                    }, "pop")
                  }, {
                    key: "del",
                    value: /* @__PURE__ */ __name(function del(key) {
                      _del(this, this[CACHE].get(key));
                    }, "del")
                  }, {
                    key: "load",
                    value: /* @__PURE__ */ __name(function load(arr) {
                      this.reset();
                      var now = Date.now();
                      for (var l = arr.length - 1; l >= 0; l--) {
                        var hit = arr[l];
                        var expiresAt = hit.e || 0;
                        if (expiresAt === 0) this.set(hit.k, hit.v);
                        else {
                          var maxAge = expiresAt - now;
                          if (maxAge > 0) {
                            this.set(hit.k, hit.v, maxAge);
                          }
                        }
                      }
                    }, "load")
                  }, {
                    key: "prune",
                    value: /* @__PURE__ */ __name(function prune() {
                      var _this4 = this;
                      this[CACHE].forEach(function(value, key) {
                        return _get(_this4, key, false);
                      });
                    }, "prune")
                  }]);
                }();
                var _get = /* @__PURE__ */ __name(function _get2(self2, key, doUse) {
                  var node = self2[CACHE].get(key);
                  if (node) {
                    var hit = node.value;
                    if (isStale(self2, hit)) {
                      _del(self2, node);
                      if (!self2[ALLOW_STALE]) return void 0;
                    } else {
                      if (doUse) {
                        if (self2[UPDATE_AGE_ON_GET]) node.value.now = Date.now();
                        self2[LRU_LIST].unshiftNode(node);
                      }
                    }
                    return hit.value;
                  }
                }, "_get");
                var isStale = /* @__PURE__ */ __name(function isStale2(self2, hit) {
                  if (!hit || !hit.maxAge && !self2[MAX_AGE]) return false;
                  var diff = Date.now() - hit.now;
                  return hit.maxAge ? diff > hit.maxAge : self2[MAX_AGE] && diff > self2[MAX_AGE];
                }, "isStale");
                var trim = /* @__PURE__ */ __name(function trim2(self2) {
                  if (self2[LENGTH] > self2[MAX]) {
                    for (var walker = self2[LRU_LIST].tail; self2[LENGTH] > self2[MAX] && walker !== null; ) {
                      var prev = walker.prev;
                      _del(self2, walker);
                      walker = prev;
                    }
                  }
                }, "trim");
                var _del = /* @__PURE__ */ __name(function _del2(self2, node) {
                  if (node) {
                    var hit = node.value;
                    if (self2[DISPOSE]) self2[DISPOSE](hit.key, hit.value);
                    self2[LENGTH] -= hit.length;
                    self2[CACHE].delete(hit.key);
                    self2[LRU_LIST].removeNode(node);
                  }
                }, "_del");
                var Entry = /* @__PURE__ */ _createClass(/* @__PURE__ */ __name(function Entry2(key, value, length, now, maxAge) {
                  _classCallCheck(this, Entry2);
                  this.key = key;
                  this.value = value;
                  this.length = length;
                  this.now = now;
                  this.maxAge = maxAge || 0;
                }, "Entry"));
                var forEachStep = /* @__PURE__ */ __name(function forEachStep2(self2, fn, node, thisp) {
                  var hit = node.value;
                  if (isStale(self2, hit)) {
                    _del(self2, node);
                    if (!self2[ALLOW_STALE]) hit = void 0;
                  }
                  if (hit) fn.call(thisp, hit.value, hit.key, self2);
                }, "forEachStep");
                module2.exports = LRUCache;
              }
            ),
            /***/
            169: (
              /***/
              (module2) => {
                var process = module2.exports = {};
                var cachedSetTimeout;
                var cachedClearTimeout;
                function defaultSetTimout() {
                  throw new Error("setTimeout has not been defined");
                }
                __name(defaultSetTimout, "defaultSetTimout");
                function defaultClearTimeout() {
                  throw new Error("clearTimeout has not been defined");
                }
                __name(defaultClearTimeout, "defaultClearTimeout");
                (function() {
                  try {
                    if (typeof setTimeout === "function") {
                      cachedSetTimeout = setTimeout;
                    } else {
                      cachedSetTimeout = defaultSetTimout;
                    }
                  } catch (e) {
                    cachedSetTimeout = defaultSetTimout;
                  }
                  try {
                    if (typeof clearTimeout === "function") {
                      cachedClearTimeout = clearTimeout;
                    } else {
                      cachedClearTimeout = defaultClearTimeout;
                    }
                  } catch (e) {
                    cachedClearTimeout = defaultClearTimeout;
                  }
                })();
                function runTimeout(fun) {
                  if (cachedSetTimeout === setTimeout) {
                    return setTimeout(fun, 0);
                  }
                  if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
                    cachedSetTimeout = setTimeout;
                    return setTimeout(fun, 0);
                  }
                  try {
                    return cachedSetTimeout(fun, 0);
                  } catch (e) {
                    try {
                      return cachedSetTimeout.call(null, fun, 0);
                    } catch (e2) {
                      return cachedSetTimeout.call(this, fun, 0);
                    }
                  }
                }
                __name(runTimeout, "runTimeout");
                function runClearTimeout(marker) {
                  if (cachedClearTimeout === clearTimeout) {
                    return clearTimeout(marker);
                  }
                  if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
                    cachedClearTimeout = clearTimeout;
                    return clearTimeout(marker);
                  }
                  try {
                    return cachedClearTimeout(marker);
                  } catch (e) {
                    try {
                      return cachedClearTimeout.call(null, marker);
                    } catch (e2) {
                      return cachedClearTimeout.call(this, marker);
                    }
                  }
                }
                __name(runClearTimeout, "runClearTimeout");
                var queue = [];
                var draining = false;
                var currentQueue;
                var queueIndex = -1;
                function cleanUpNextTick() {
                  if (!draining || !currentQueue) {
                    return;
                  }
                  draining = false;
                  if (currentQueue.length) {
                    queue = currentQueue.concat(queue);
                  } else {
                    queueIndex = -1;
                  }
                  if (queue.length) {
                    drainQueue();
                  }
                }
                __name(cleanUpNextTick, "cleanUpNextTick");
                function drainQueue() {
                  if (draining) {
                    return;
                  }
                  var timeout = runTimeout(cleanUpNextTick);
                  draining = true;
                  var len = queue.length;
                  while (len) {
                    currentQueue = queue;
                    queue = [];
                    while (++queueIndex < len) {
                      if (currentQueue) {
                        currentQueue[queueIndex].run();
                      }
                    }
                    queueIndex = -1;
                    len = queue.length;
                  }
                  currentQueue = null;
                  draining = false;
                  runClearTimeout(timeout);
                }
                __name(drainQueue, "drainQueue");
                process.nextTick = function(fun) {
                  var args = new Array(arguments.length - 1);
                  if (arguments.length > 1) {
                    for (var i = 1; i < arguments.length; i++) {
                      args[i - 1] = arguments[i];
                    }
                  }
                  queue.push(new Item(fun, args));
                  if (queue.length === 1 && !draining) {
                    runTimeout(drainQueue);
                  }
                };
                function Item(fun, array) {
                  this.fun = fun;
                  this.array = array;
                }
                __name(Item, "Item");
                Item.prototype.run = function() {
                  this.fun.apply(null, this.array);
                };
                process.title = "browser";
                process.browser = true;
                process.env = {};
                process.argv = [];
                process.version = "";
                process.versions = {};
                function noop() {
                }
                __name(noop, "noop");
                process.on = noop;
                process.addListener = noop;
                process.once = noop;
                process.off = noop;
                process.removeListener = noop;
                process.removeAllListeners = noop;
                process.emit = noop;
                process.prependListener = noop;
                process.prependOnceListener = noop;
                process.listeners = function(name) {
                  return [];
                };
                process.binding = function(name) {
                  throw new Error("process.binding is not supported");
                };
                process.cwd = function() {
                  return "/";
                };
                process.chdir = function(dir) {
                  throw new Error("process.chdir is not supported");
                };
                process.umask = function() {
                  return 0;
                };
              }
            ),
            /***/
            430: (
              /***/
              function(module2, exports2) {
                var __WEBPACK_AMD_DEFINE_FACTORY__, __WEBPACK_AMD_DEFINE_ARRAY__, __WEBPACK_AMD_DEFINE_RESULT__;
                function _typeof(o) {
                  "@babel/helpers - typeof";
                  return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                    return typeof o2;
                  } : function(o2) {
                    return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
                  }, _typeof(o);
                }
                __name(_typeof, "_typeof");
                (function(root, factory) {
                  "use strict";
                  if (true) {
                    !(__WEBPACK_AMD_DEFINE_ARRAY__ = [], __WEBPACK_AMD_DEFINE_FACTORY__ = factory, __WEBPACK_AMD_DEFINE_RESULT__ = typeof __WEBPACK_AMD_DEFINE_FACTORY__ === "function" ? __WEBPACK_AMD_DEFINE_FACTORY__.apply(exports2, __WEBPACK_AMD_DEFINE_ARRAY__) : __WEBPACK_AMD_DEFINE_FACTORY__, __WEBPACK_AMD_DEFINE_RESULT__ !== void 0 && (module2.exports = __WEBPACK_AMD_DEFINE_RESULT__));
                  } else {
                  }
                })(this, function() {
                  "use strict";
                  function _isNumber(n) {
                    return !isNaN(parseFloat(n)) && isFinite(n);
                  }
                  __name(_isNumber, "_isNumber");
                  function _capitalize(str) {
                    return str.charAt(0).toUpperCase() + str.substring(1);
                  }
                  __name(_capitalize, "_capitalize");
                  function _getter(p) {
                    return function() {
                      return this[p];
                    };
                  }
                  __name(_getter, "_getter");
                  var booleanProps = ["isConstructor", "isEval", "isNative", "isToplevel"];
                  var numericProps = ["columnNumber", "lineNumber"];
                  var stringProps = ["fileName", "functionName", "source"];
                  var arrayProps = ["args"];
                  var props = booleanProps.concat(numericProps, stringProps, arrayProps);
                  function StackFrame(obj) {
                    if (!obj) return;
                    for (var i2 = 0; i2 < props.length; i2++) {
                      if (obj[props[i2]] !== void 0) {
                        this["set" + _capitalize(props[i2])](obj[props[i2]]);
                      }
                    }
                  }
                  __name(StackFrame, "StackFrame");
                  StackFrame.prototype = {
                    getArgs: /* @__PURE__ */ __name(function getArgs() {
                      return this.args;
                    }, "getArgs"),
                    setArgs: /* @__PURE__ */ __name(function setArgs(v) {
                      if (Object.prototype.toString.call(v) !== "[object Array]") {
                        throw new TypeError("Args must be an Array");
                      }
                      this.args = v;
                    }, "setArgs"),
                    getEvalOrigin: /* @__PURE__ */ __name(function getEvalOrigin() {
                      return this.evalOrigin;
                    }, "getEvalOrigin"),
                    setEvalOrigin: /* @__PURE__ */ __name(function setEvalOrigin(v) {
                      if (v instanceof StackFrame) {
                        this.evalOrigin = v;
                      } else if (v instanceof Object) {
                        this.evalOrigin = new StackFrame(v);
                      } else {
                        throw new TypeError("Eval Origin must be an Object or StackFrame");
                      }
                    }, "setEvalOrigin"),
                    toString: /* @__PURE__ */ __name(function toString() {
                      var fileName = this.getFileName() || "";
                      var lineNumber = this.getLineNumber() || "";
                      var columnNumber = this.getColumnNumber() || "";
                      var functionName = this.getFunctionName() || "";
                      if (this.getIsEval()) {
                        if (fileName) {
                          return "[eval] (" + fileName + ":" + lineNumber + ":" + columnNumber + ")";
                        }
                        return "[eval]:" + lineNumber + ":" + columnNumber;
                      }
                      if (functionName) {
                        return functionName + " (" + fileName + ":" + lineNumber + ":" + columnNumber + ")";
                      }
                      return fileName + ":" + lineNumber + ":" + columnNumber;
                    }, "toString")
                  };
                  StackFrame.fromString = /* @__PURE__ */ __name(function StackFrame$$fromString(str) {
                    var argsStartIndex = str.indexOf("(");
                    var argsEndIndex = str.lastIndexOf(")");
                    var functionName = str.substring(0, argsStartIndex);
                    var args = str.substring(argsStartIndex + 1, argsEndIndex).split(",");
                    var locationString = str.substring(argsEndIndex + 1);
                    if (locationString.indexOf("@") === 0) {
                      var parts = /@(.+?)(?::(\d+))?(?::(\d+))?$/.exec(locationString, "");
                      var fileName = parts[1];
                      var lineNumber = parts[2];
                      var columnNumber = parts[3];
                    }
                    return new StackFrame({
                      functionName,
                      args: args || void 0,
                      fileName,
                      lineNumber: lineNumber || void 0,
                      columnNumber: columnNumber || void 0
                    });
                  }, "StackFrame$$fromString");
                  for (var i = 0; i < booleanProps.length; i++) {
                    StackFrame.prototype["get" + _capitalize(booleanProps[i])] = _getter(booleanProps[i]);
                    StackFrame.prototype["set" + _capitalize(booleanProps[i])] = /* @__PURE__ */ function(p) {
                      return function(v) {
                        this[p] = Boolean(v);
                      };
                    }(booleanProps[i]);
                  }
                  for (var j = 0; j < numericProps.length; j++) {
                    StackFrame.prototype["get" + _capitalize(numericProps[j])] = _getter(numericProps[j]);
                    StackFrame.prototype["set" + _capitalize(numericProps[j])] = /* @__PURE__ */ function(p) {
                      return function(v) {
                        if (!_isNumber(v)) {
                          throw new TypeError(p + " must be a Number");
                        }
                        this[p] = Number(v);
                      };
                    }(numericProps[j]);
                  }
                  for (var k = 0; k < stringProps.length; k++) {
                    StackFrame.prototype["get" + _capitalize(stringProps[k])] = _getter(stringProps[k]);
                    StackFrame.prototype["set" + _capitalize(stringProps[k])] = /* @__PURE__ */ function(p) {
                      return function(v) {
                        this[p] = String(v);
                      };
                    }(stringProps[k]);
                  }
                  return StackFrame;
                });
              }
            ),
            /***/
            476: (
              /***/
              (module2) => {
                "use strict";
                function _typeof(o) {
                  "@babel/helpers - typeof";
                  return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                    return typeof o2;
                  } : function(o2) {
                    return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
                  }, _typeof(o);
                }
                __name(_typeof, "_typeof");
                function _regeneratorRuntime() {
                  "use strict";
                  _regeneratorRuntime = /* @__PURE__ */ __name(function _regeneratorRuntime2() {
                    return e;
                  }, "_regeneratorRuntime");
                  var t, e = {}, r = Object.prototype, n = r.hasOwnProperty, o = Object.defineProperty || function(t2, e2, r2) {
                    t2[e2] = r2.value;
                  }, i = "function" == typeof Symbol ? Symbol : {}, a = i.iterator || "@@iterator", c = i.asyncIterator || "@@asyncIterator", u = i.toStringTag || "@@toStringTag";
                  function define2(t2, e2, r2) {
                    return Object.defineProperty(t2, e2, { value: r2, enumerable: true, configurable: true, writable: true }), t2[e2];
                  }
                  __name(define2, "define");
                  try {
                    define2({}, "");
                  } catch (t2) {
                    define2 = /* @__PURE__ */ __name(function define3(t3, e2, r2) {
                      return t3[e2] = r2;
                    }, "define");
                  }
                  function wrap(t2, e2, r2, n2) {
                    var i2 = e2 && e2.prototype instanceof Generator ? e2 : Generator, a2 = Object.create(i2.prototype), c2 = new Context(n2 || []);
                    return o(a2, "_invoke", { value: makeInvokeMethod(t2, r2, c2) }), a2;
                  }
                  __name(wrap, "wrap");
                  function tryCatch(t2, e2, r2) {
                    try {
                      return { type: "normal", arg: t2.call(e2, r2) };
                    } catch (t3) {
                      return { type: "throw", arg: t3 };
                    }
                  }
                  __name(tryCatch, "tryCatch");
                  e.wrap = wrap;
                  var h = "suspendedStart", l = "suspendedYield", f = "executing", s = "completed", y = {};
                  function Generator() {
                  }
                  __name(Generator, "Generator");
                  function GeneratorFunction() {
                  }
                  __name(GeneratorFunction, "GeneratorFunction");
                  function GeneratorFunctionPrototype() {
                  }
                  __name(GeneratorFunctionPrototype, "GeneratorFunctionPrototype");
                  var p = {};
                  define2(p, a, function() {
                    return this;
                  });
                  var d = Object.getPrototypeOf, v = d && d(d(values([])));
                  v && v !== r && n.call(v, a) && (p = v);
                  var g2 = GeneratorFunctionPrototype.prototype = Generator.prototype = Object.create(p);
                  function defineIteratorMethods(t2) {
                    ["next", "throw", "return"].forEach(function(e2) {
                      define2(t2, e2, function(t3) {
                        return this._invoke(e2, t3);
                      });
                    });
                  }
                  __name(defineIteratorMethods, "defineIteratorMethods");
                  function AsyncIterator(t2, e2) {
                    function invoke(r3, o2, i2, a2) {
                      var c2 = tryCatch(t2[r3], t2, o2);
                      if ("throw" !== c2.type) {
                        var u2 = c2.arg, h2 = u2.value;
                        return h2 && "object" == _typeof(h2) && n.call(h2, "__await") ? e2.resolve(h2.__await).then(function(t3) {
                          invoke("next", t3, i2, a2);
                        }, function(t3) {
                          invoke("throw", t3, i2, a2);
                        }) : e2.resolve(h2).then(function(t3) {
                          u2.value = t3, i2(u2);
                        }, function(t3) {
                          return invoke("throw", t3, i2, a2);
                        });
                      }
                      a2(c2.arg);
                    }
                    __name(invoke, "invoke");
                    var r2;
                    o(this, "_invoke", { value: /* @__PURE__ */ __name(function value(t3, n2) {
                      function callInvokeWithMethodAndArg() {
                        return new e2(function(e3, r3) {
                          invoke(t3, n2, e3, r3);
                        });
                      }
                      __name(callInvokeWithMethodAndArg, "callInvokeWithMethodAndArg");
                      return r2 = r2 ? r2.then(callInvokeWithMethodAndArg, callInvokeWithMethodAndArg) : callInvokeWithMethodAndArg();
                    }, "value") });
                  }
                  __name(AsyncIterator, "AsyncIterator");
                  function makeInvokeMethod(e2, r2, n2) {
                    var o2 = h;
                    return function(i2, a2) {
                      if (o2 === f) throw Error("Generator is already running");
                      if (o2 === s) {
                        if ("throw" === i2) throw a2;
                        return { value: t, done: true };
                      }
                      for (n2.method = i2, n2.arg = a2; ; ) {
                        var c2 = n2.delegate;
                        if (c2) {
                          var u2 = maybeInvokeDelegate(c2, n2);
                          if (u2) {
                            if (u2 === y) continue;
                            return u2;
                          }
                        }
                        if ("next" === n2.method) n2.sent = n2._sent = n2.arg;
                        else if ("throw" === n2.method) {
                          if (o2 === h) throw o2 = s, n2.arg;
                          n2.dispatchException(n2.arg);
                        } else "return" === n2.method && n2.abrupt("return", n2.arg);
                        o2 = f;
                        var p2 = tryCatch(e2, r2, n2);
                        if ("normal" === p2.type) {
                          if (o2 = n2.done ? s : l, p2.arg === y) continue;
                          return { value: p2.arg, done: n2.done };
                        }
                        "throw" === p2.type && (o2 = s, n2.method = "throw", n2.arg = p2.arg);
                      }
                    };
                  }
                  __name(makeInvokeMethod, "makeInvokeMethod");
                  function maybeInvokeDelegate(e2, r2) {
                    var n2 = r2.method, o2 = e2.iterator[n2];
                    if (o2 === t) return r2.delegate = null, "throw" === n2 && e2.iterator.return && (r2.method = "return", r2.arg = t, maybeInvokeDelegate(e2, r2), "throw" === r2.method) || "return" !== n2 && (r2.method = "throw", r2.arg = new TypeError("The iterator does not provide a '" + n2 + "' method")), y;
                    var i2 = tryCatch(o2, e2.iterator, r2.arg);
                    if ("throw" === i2.type) return r2.method = "throw", r2.arg = i2.arg, r2.delegate = null, y;
                    var a2 = i2.arg;
                    return a2 ? a2.done ? (r2[e2.resultName] = a2.value, r2.next = e2.nextLoc, "return" !== r2.method && (r2.method = "next", r2.arg = t), r2.delegate = null, y) : a2 : (r2.method = "throw", r2.arg = new TypeError("iterator result is not an object"), r2.delegate = null, y);
                  }
                  __name(maybeInvokeDelegate, "maybeInvokeDelegate");
                  function pushTryEntry(t2) {
                    var e2 = { tryLoc: t2[0] };
                    1 in t2 && (e2.catchLoc = t2[1]), 2 in t2 && (e2.finallyLoc = t2[2], e2.afterLoc = t2[3]), this.tryEntries.push(e2);
                  }
                  __name(pushTryEntry, "pushTryEntry");
                  function resetTryEntry(t2) {
                    var e2 = t2.completion || {};
                    e2.type = "normal", delete e2.arg, t2.completion = e2;
                  }
                  __name(resetTryEntry, "resetTryEntry");
                  function Context(t2) {
                    this.tryEntries = [{ tryLoc: "root" }], t2.forEach(pushTryEntry, this), this.reset(true);
                  }
                  __name(Context, "Context");
                  function values(e2) {
                    if (e2 || "" === e2) {
                      var r2 = e2[a];
                      if (r2) return r2.call(e2);
                      if ("function" == typeof e2.next) return e2;
                      if (!isNaN(e2.length)) {
                        var o2 = -1, i2 = /* @__PURE__ */ __name(function next() {
                          for (; ++o2 < e2.length; ) if (n.call(e2, o2)) return next.value = e2[o2], next.done = false, next;
                          return next.value = t, next.done = true, next;
                        }, "next");
                        return i2.next = i2;
                      }
                    }
                    throw new TypeError(_typeof(e2) + " is not iterable");
                  }
                  __name(values, "values");
                  return GeneratorFunction.prototype = GeneratorFunctionPrototype, o(g2, "constructor", { value: GeneratorFunctionPrototype, configurable: true }), o(GeneratorFunctionPrototype, "constructor", { value: GeneratorFunction, configurable: true }), GeneratorFunction.displayName = define2(GeneratorFunctionPrototype, u, "GeneratorFunction"), e.isGeneratorFunction = function(t2) {
                    var e2 = "function" == typeof t2 && t2.constructor;
                    return !!e2 && (e2 === GeneratorFunction || "GeneratorFunction" === (e2.displayName || e2.name));
                  }, e.mark = function(t2) {
                    return Object.setPrototypeOf ? Object.setPrototypeOf(t2, GeneratorFunctionPrototype) : (t2.__proto__ = GeneratorFunctionPrototype, define2(t2, u, "GeneratorFunction")), t2.prototype = Object.create(g2), t2;
                  }, e.awrap = function(t2) {
                    return { __await: t2 };
                  }, defineIteratorMethods(AsyncIterator.prototype), define2(AsyncIterator.prototype, c, function() {
                    return this;
                  }), e.AsyncIterator = AsyncIterator, e.async = function(t2, r2, n2, o2, i2) {
                    void 0 === i2 && (i2 = Promise);
                    var a2 = new AsyncIterator(wrap(t2, r2, n2, o2), i2);
                    return e.isGeneratorFunction(r2) ? a2 : a2.next().then(function(t3) {
                      return t3.done ? t3.value : a2.next();
                    });
                  }, defineIteratorMethods(g2), define2(g2, u, "Generator"), define2(g2, a, function() {
                    return this;
                  }), define2(g2, "toString", function() {
                    return "[object Generator]";
                  }), e.keys = function(t2) {
                    var e2 = Object(t2), r2 = [];
                    for (var n2 in e2) r2.push(n2);
                    return r2.reverse(), /* @__PURE__ */ __name(function next() {
                      for (; r2.length; ) {
                        var t3 = r2.pop();
                        if (t3 in e2) return next.value = t3, next.done = false, next;
                      }
                      return next.done = true, next;
                    }, "next");
                  }, e.values = values, Context.prototype = { constructor: Context, reset: /* @__PURE__ */ __name(function reset(e2) {
                    if (this.prev = 0, this.next = 0, this.sent = this._sent = t, this.done = false, this.delegate = null, this.method = "next", this.arg = t, this.tryEntries.forEach(resetTryEntry), !e2) for (var r2 in this) "t" === r2.charAt(0) && n.call(this, r2) && !isNaN(+r2.slice(1)) && (this[r2] = t);
                  }, "reset"), stop: /* @__PURE__ */ __name(function stop() {
                    this.done = true;
                    var t2 = this.tryEntries[0].completion;
                    if ("throw" === t2.type) throw t2.arg;
                    return this.rval;
                  }, "stop"), dispatchException: /* @__PURE__ */ __name(function dispatchException(e2) {
                    if (this.done) throw e2;
                    var r2 = this;
                    function handle(n2, o3) {
                      return a2.type = "throw", a2.arg = e2, r2.next = n2, o3 && (r2.method = "next", r2.arg = t), !!o3;
                    }
                    __name(handle, "handle");
                    for (var o2 = this.tryEntries.length - 1; o2 >= 0; --o2) {
                      var i2 = this.tryEntries[o2], a2 = i2.completion;
                      if ("root" === i2.tryLoc) return handle("end");
                      if (i2.tryLoc <= this.prev) {
                        var c2 = n.call(i2, "catchLoc"), u2 = n.call(i2, "finallyLoc");
                        if (c2 && u2) {
                          if (this.prev < i2.catchLoc) return handle(i2.catchLoc, true);
                          if (this.prev < i2.finallyLoc) return handle(i2.finallyLoc);
                        } else if (c2) {
                          if (this.prev < i2.catchLoc) return handle(i2.catchLoc, true);
                        } else {
                          if (!u2) throw Error("try statement without catch or finally");
                          if (this.prev < i2.finallyLoc) return handle(i2.finallyLoc);
                        }
                      }
                    }
                  }, "dispatchException"), abrupt: /* @__PURE__ */ __name(function abrupt(t2, e2) {
                    for (var r2 = this.tryEntries.length - 1; r2 >= 0; --r2) {
                      var o2 = this.tryEntries[r2];
                      if (o2.tryLoc <= this.prev && n.call(o2, "finallyLoc") && this.prev < o2.finallyLoc) {
                        var i2 = o2;
                        break;
                      }
                    }
                    i2 && ("break" === t2 || "continue" === t2) && i2.tryLoc <= e2 && e2 <= i2.finallyLoc && (i2 = null);
                    var a2 = i2 ? i2.completion : {};
                    return a2.type = t2, a2.arg = e2, i2 ? (this.method = "next", this.next = i2.finallyLoc, y) : this.complete(a2);
                  }, "abrupt"), complete: /* @__PURE__ */ __name(function complete(t2, e2) {
                    if ("throw" === t2.type) throw t2.arg;
                    return "break" === t2.type || "continue" === t2.type ? this.next = t2.arg : "return" === t2.type ? (this.rval = this.arg = t2.arg, this.method = "return", this.next = "end") : "normal" === t2.type && e2 && (this.next = e2), y;
                  }, "complete"), finish: /* @__PURE__ */ __name(function finish(t2) {
                    for (var e2 = this.tryEntries.length - 1; e2 >= 0; --e2) {
                      var r2 = this.tryEntries[e2];
                      if (r2.finallyLoc === t2) return this.complete(r2.completion, r2.afterLoc), resetTryEntry(r2), y;
                    }
                  }, "finish"), catch: /* @__PURE__ */ __name(function _catch(t2) {
                    for (var e2 = this.tryEntries.length - 1; e2 >= 0; --e2) {
                      var r2 = this.tryEntries[e2];
                      if (r2.tryLoc === t2) {
                        var n2 = r2.completion;
                        if ("throw" === n2.type) {
                          var o2 = n2.arg;
                          resetTryEntry(r2);
                        }
                        return o2;
                      }
                    }
                    throw Error("illegal catch attempt");
                  }, "_catch"), delegateYield: /* @__PURE__ */ __name(function delegateYield(e2, r2, n2) {
                    return this.delegate = { iterator: values(e2), resultName: r2, nextLoc: n2 }, "next" === this.method && (this.arg = t), y;
                  }, "delegateYield") }, e;
                }
                __name(_regeneratorRuntime, "_regeneratorRuntime");
                module2.exports = function(Yallist) {
                  Yallist.prototype[Symbol.iterator] = /* @__PURE__ */ _regeneratorRuntime().mark(/* @__PURE__ */ __name(function _callee() {
                    var walker;
                    return _regeneratorRuntime().wrap(/* @__PURE__ */ __name(function _callee$(_context) {
                      while (1) switch (_context.prev = _context.next) {
                        case 0:
                          walker = this.head;
                        case 1:
                          if (!walker) {
                            _context.next = 7;
                            break;
                          }
                          _context.next = 4;
                          return walker.value;
                        case 4:
                          walker = walker.next;
                          _context.next = 1;
                          break;
                        case 7:
                        case "end":
                          return _context.stop();
                      }
                    }, "_callee$"), _callee, this);
                  }, "_callee"));
                };
              }
            ),
            /***/
            695: (
              /***/
              (module2, __unused_webpack_exports, __webpack_require__2) => {
                "use strict";
                module2.exports = Yallist;
                Yallist.Node = Node2;
                Yallist.create = Yallist;
                function Yallist(list) {
                  var self2 = this;
                  if (!(self2 instanceof Yallist)) {
                    self2 = new Yallist();
                  }
                  self2.tail = null;
                  self2.head = null;
                  self2.length = 0;
                  if (list && typeof list.forEach === "function") {
                    list.forEach(function(item) {
                      self2.push(item);
                    });
                  } else if (arguments.length > 0) {
                    for (var i = 0, l = arguments.length; i < l; i++) {
                      self2.push(arguments[i]);
                    }
                  }
                  return self2;
                }
                __name(Yallist, "Yallist");
                Yallist.prototype.removeNode = function(node) {
                  if (node.list !== this) {
                    throw new Error("removing node which does not belong to this list");
                  }
                  var next = node.next;
                  var prev = node.prev;
                  if (next) {
                    next.prev = prev;
                  }
                  if (prev) {
                    prev.next = next;
                  }
                  if (node === this.head) {
                    this.head = next;
                  }
                  if (node === this.tail) {
                    this.tail = prev;
                  }
                  node.list.length--;
                  node.next = null;
                  node.prev = null;
                  node.list = null;
                  return next;
                };
                Yallist.prototype.unshiftNode = function(node) {
                  if (node === this.head) {
                    return;
                  }
                  if (node.list) {
                    node.list.removeNode(node);
                  }
                  var head = this.head;
                  node.list = this;
                  node.next = head;
                  if (head) {
                    head.prev = node;
                  }
                  this.head = node;
                  if (!this.tail) {
                    this.tail = node;
                  }
                  this.length++;
                };
                Yallist.prototype.pushNode = function(node) {
                  if (node === this.tail) {
                    return;
                  }
                  if (node.list) {
                    node.list.removeNode(node);
                  }
                  var tail = this.tail;
                  node.list = this;
                  node.prev = tail;
                  if (tail) {
                    tail.next = node;
                  }
                  this.tail = node;
                  if (!this.head) {
                    this.head = node;
                  }
                  this.length++;
                };
                Yallist.prototype.push = function() {
                  for (var i = 0, l = arguments.length; i < l; i++) {
                    push(this, arguments[i]);
                  }
                  return this.length;
                };
                Yallist.prototype.unshift = function() {
                  for (var i = 0, l = arguments.length; i < l; i++) {
                    unshift(this, arguments[i]);
                  }
                  return this.length;
                };
                Yallist.prototype.pop = function() {
                  if (!this.tail) {
                    return void 0;
                  }
                  var res = this.tail.value;
                  this.tail = this.tail.prev;
                  if (this.tail) {
                    this.tail.next = null;
                  } else {
                    this.head = null;
                  }
                  this.length--;
                  return res;
                };
                Yallist.prototype.shift = function() {
                  if (!this.head) {
                    return void 0;
                  }
                  var res = this.head.value;
                  this.head = this.head.next;
                  if (this.head) {
                    this.head.prev = null;
                  } else {
                    this.tail = null;
                  }
                  this.length--;
                  return res;
                };
                Yallist.prototype.forEach = function(fn, thisp) {
                  thisp = thisp || this;
                  for (var walker = this.head, i = 0; walker !== null; i++) {
                    fn.call(thisp, walker.value, i, this);
                    walker = walker.next;
                  }
                };
                Yallist.prototype.forEachReverse = function(fn, thisp) {
                  thisp = thisp || this;
                  for (var walker = this.tail, i = this.length - 1; walker !== null; i--) {
                    fn.call(thisp, walker.value, i, this);
                    walker = walker.prev;
                  }
                };
                Yallist.prototype.get = function(n) {
                  for (var i = 0, walker = this.head; walker !== null && i < n; i++) {
                    walker = walker.next;
                  }
                  if (i === n && walker !== null) {
                    return walker.value;
                  }
                };
                Yallist.prototype.getReverse = function(n) {
                  for (var i = 0, walker = this.tail; walker !== null && i < n; i++) {
                    walker = walker.prev;
                  }
                  if (i === n && walker !== null) {
                    return walker.value;
                  }
                };
                Yallist.prototype.map = function(fn, thisp) {
                  thisp = thisp || this;
                  var res = new Yallist();
                  for (var walker = this.head; walker !== null; ) {
                    res.push(fn.call(thisp, walker.value, this));
                    walker = walker.next;
                  }
                  return res;
                };
                Yallist.prototype.mapReverse = function(fn, thisp) {
                  thisp = thisp || this;
                  var res = new Yallist();
                  for (var walker = this.tail; walker !== null; ) {
                    res.push(fn.call(thisp, walker.value, this));
                    walker = walker.prev;
                  }
                  return res;
                };
                Yallist.prototype.reduce = function(fn, initial) {
                  var acc;
                  var walker = this.head;
                  if (arguments.length > 1) {
                    acc = initial;
                  } else if (this.head) {
                    walker = this.head.next;
                    acc = this.head.value;
                  } else {
                    throw new TypeError("Reduce of empty list with no initial value");
                  }
                  for (var i = 0; walker !== null; i++) {
                    acc = fn(acc, walker.value, i);
                    walker = walker.next;
                  }
                  return acc;
                };
                Yallist.prototype.reduceReverse = function(fn, initial) {
                  var acc;
                  var walker = this.tail;
                  if (arguments.length > 1) {
                    acc = initial;
                  } else if (this.tail) {
                    walker = this.tail.prev;
                    acc = this.tail.value;
                  } else {
                    throw new TypeError("Reduce of empty list with no initial value");
                  }
                  for (var i = this.length - 1; walker !== null; i--) {
                    acc = fn(acc, walker.value, i);
                    walker = walker.prev;
                  }
                  return acc;
                };
                Yallist.prototype.toArray = function() {
                  var arr = new Array(this.length);
                  for (var i = 0, walker = this.head; walker !== null; i++) {
                    arr[i] = walker.value;
                    walker = walker.next;
                  }
                  return arr;
                };
                Yallist.prototype.toArrayReverse = function() {
                  var arr = new Array(this.length);
                  for (var i = 0, walker = this.tail; walker !== null; i++) {
                    arr[i] = walker.value;
                    walker = walker.prev;
                  }
                  return arr;
                };
                Yallist.prototype.slice = function(from, to) {
                  to = to || this.length;
                  if (to < 0) {
                    to += this.length;
                  }
                  from = from || 0;
                  if (from < 0) {
                    from += this.length;
                  }
                  var ret = new Yallist();
                  if (to < from || to < 0) {
                    return ret;
                  }
                  if (from < 0) {
                    from = 0;
                  }
                  if (to > this.length) {
                    to = this.length;
                  }
                  for (var i = 0, walker = this.head; walker !== null && i < from; i++) {
                    walker = walker.next;
                  }
                  for (; walker !== null && i < to; i++, walker = walker.next) {
                    ret.push(walker.value);
                  }
                  return ret;
                };
                Yallist.prototype.sliceReverse = function(from, to) {
                  to = to || this.length;
                  if (to < 0) {
                    to += this.length;
                  }
                  from = from || 0;
                  if (from < 0) {
                    from += this.length;
                  }
                  var ret = new Yallist();
                  if (to < from || to < 0) {
                    return ret;
                  }
                  if (from < 0) {
                    from = 0;
                  }
                  if (to > this.length) {
                    to = this.length;
                  }
                  for (var i = this.length, walker = this.tail; walker !== null && i > to; i--) {
                    walker = walker.prev;
                  }
                  for (; walker !== null && i > from; i--, walker = walker.prev) {
                    ret.push(walker.value);
                  }
                  return ret;
                };
                Yallist.prototype.splice = function(start, deleteCount) {
                  if (start > this.length) {
                    start = this.length - 1;
                  }
                  if (start < 0) {
                    start = this.length + start;
                  }
                  for (var i = 0, walker = this.head; walker !== null && i < start; i++) {
                    walker = walker.next;
                  }
                  var ret = [];
                  for (var i = 0; walker && i < deleteCount; i++) {
                    ret.push(walker.value);
                    walker = this.removeNode(walker);
                  }
                  if (walker === null) {
                    walker = this.tail;
                  }
                  if (walker !== this.head && walker !== this.tail) {
                    walker = walker.prev;
                  }
                  for (var i = 2; i < arguments.length; i++) {
                    walker = insert(this, walker, arguments[i]);
                  }
                  return ret;
                };
                Yallist.prototype.reverse = function() {
                  var head = this.head;
                  var tail = this.tail;
                  for (var walker = head; walker !== null; walker = walker.prev) {
                    var p = walker.prev;
                    walker.prev = walker.next;
                    walker.next = p;
                  }
                  this.head = tail;
                  this.tail = head;
                  return this;
                };
                function insert(self2, node, value) {
                  var inserted = node === self2.head ? new Node2(value, null, node, self2) : new Node2(value, node, node.next, self2);
                  if (inserted.next === null) {
                    self2.tail = inserted;
                  }
                  if (inserted.prev === null) {
                    self2.head = inserted;
                  }
                  self2.length++;
                  return inserted;
                }
                __name(insert, "insert");
                function push(self2, item) {
                  self2.tail = new Node2(item, self2.tail, null, self2);
                  if (!self2.head) {
                    self2.head = self2.tail;
                  }
                  self2.length++;
                }
                __name(push, "push");
                function unshift(self2, item) {
                  self2.head = new Node2(item, null, self2.head, self2);
                  if (!self2.tail) {
                    self2.tail = self2.head;
                  }
                  self2.length++;
                }
                __name(unshift, "unshift");
                function Node2(value, prev, next, list) {
                  if (!(this instanceof Node2)) {
                    return new Node2(value, prev, next, list);
                  }
                  this.list = list;
                  this.value = value;
                  if (prev) {
                    prev.next = this;
                    this.prev = prev;
                  } else {
                    this.prev = null;
                  }
                  if (next) {
                    next.prev = this;
                    this.next = next;
                  } else {
                    this.next = null;
                  }
                }
                __name(Node2, "Node");
                try {
                  __webpack_require__2(476)(Yallist);
                } catch (er) {
                }
              }
            )
            /******/
          };
          var __webpack_module_cache__ = {};
          function __webpack_require__(moduleId) {
            var cachedModule = __webpack_module_cache__[moduleId];
            if (cachedModule !== void 0) {
              return cachedModule.exports;
            }
            var module2 = __webpack_module_cache__[moduleId] = {
              /******/
              // no module.id needed
              /******/
              // no module.loaded needed
              /******/
              exports: {}
              /******/
            };
            __webpack_modules__[moduleId].call(module2.exports, module2, module2.exports, __webpack_require__);
            return module2.exports;
          }
          __name(__webpack_require__, "__webpack_require__");
          (() => {
            __webpack_require__.n = (module2) => {
              var getter = module2 && module2.__esModule ? (
                /******/
                () => module2["default"]
              ) : (
                /******/
                () => module2
              );
              __webpack_require__.d(getter, { a: getter });
              return getter;
            };
          })();
          (() => {
            __webpack_require__.d = (exports2, definition) => {
              for (var key in definition) {
                if (__webpack_require__.o(definition, key) && !__webpack_require__.o(exports2, key)) {
                  Object.defineProperty(exports2, key, { enumerable: true, get: definition[key] });
                }
              }
            };
          })();
          (() => {
            __webpack_require__.o = (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop);
          })();
          (() => {
            __webpack_require__.r = (exports2) => {
              if (typeof Symbol !== "undefined" && Symbol.toStringTag) {
                Object.defineProperty(exports2, Symbol.toStringTag, { value: "Module" });
              }
              Object.defineProperty(exports2, "__esModule", { value: true });
            };
          })();
          var __webpack_exports__ = {};
          (() => {
            "use strict";
            __webpack_require__.r(__webpack_exports__);
            __webpack_require__.d(__webpack_exports__, {
              "connectToDevTools": /* @__PURE__ */ __name(() => (
                /* binding */
                connectToDevTools
              ), "connectToDevTools"),
              "connectWithCustomMessagingProtocol": /* @__PURE__ */ __name(() => (
                /* binding */
                connectWithCustomMessagingProtocol
              ), "connectWithCustomMessagingProtocol"),
              "initialize": /* @__PURE__ */ __name(() => (
                /* binding */
                backend_initialize
              ), "initialize")
            });
            ;
            function _typeof(o) {
              "@babel/helpers - typeof";
              return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                return typeof o2;
              } : function(o2) {
                return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
              }, _typeof(o);
            }
            __name(_typeof, "_typeof");
            function _classCallCheck(instance, Constructor) {
              if (!(instance instanceof Constructor)) {
                throw new TypeError("Cannot call a class as a function");
              }
            }
            __name(_classCallCheck, "_classCallCheck");
            function _defineProperties(target, props) {
              for (var i = 0; i < props.length; i++) {
                var descriptor = props[i];
                descriptor.enumerable = descriptor.enumerable || false;
                descriptor.configurable = true;
                if ("value" in descriptor) descriptor.writable = true;
                Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor);
              }
            }
            __name(_defineProperties, "_defineProperties");
            function _createClass(Constructor, protoProps, staticProps) {
              if (protoProps) _defineProperties(Constructor.prototype, protoProps);
              if (staticProps) _defineProperties(Constructor, staticProps);
              Object.defineProperty(Constructor, "prototype", { writable: false });
              return Constructor;
            }
            __name(_createClass, "_createClass");
            function _defineProperty(obj, key, value) {
              key = _toPropertyKey(key);
              if (key in obj) {
                Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
              } else {
                obj[key] = value;
              }
              return obj;
            }
            __name(_defineProperty, "_defineProperty");
            function _toPropertyKey(t) {
              var i = _toPrimitive(t, "string");
              return "symbol" == _typeof(i) ? i : i + "";
            }
            __name(_toPropertyKey, "_toPropertyKey");
            function _toPrimitive(t, r) {
              if ("object" != _typeof(t) || !t) return t;
              var e = t[Symbol.toPrimitive];
              if (void 0 !== e) {
                var i = e.call(t, r || "default");
                if ("object" != _typeof(i)) return i;
                throw new TypeError("@@toPrimitive must return a primitive value.");
              }
              return ("string" === r ? String : Number)(t);
            }
            __name(_toPrimitive, "_toPrimitive");
            var EventEmitter = /* @__PURE__ */ function() {
              function EventEmitter2() {
                _classCallCheck(this, EventEmitter2);
                _defineProperty(this, "listenersMap", /* @__PURE__ */ new Map());
              }
              __name(EventEmitter2, "EventEmitter");
              return _createClass(EventEmitter2, [{
                key: "addListener",
                value: /* @__PURE__ */ __name(function addListener(event, listener) {
                  var listeners = this.listenersMap.get(event);
                  if (listeners === void 0) {
                    this.listenersMap.set(event, [listener]);
                  } else {
                    var index = listeners.indexOf(listener);
                    if (index < 0) {
                      listeners.push(listener);
                    }
                  }
                }, "addListener")
              }, {
                key: "emit",
                value: /* @__PURE__ */ __name(function emit(event) {
                  var listeners = this.listenersMap.get(event);
                  if (listeners !== void 0) {
                    for (var _len = arguments.length, args = new Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
                      args[_key - 1] = arguments[_key];
                    }
                    if (listeners.length === 1) {
                      var listener = listeners[0];
                      listener.apply(null, args);
                    } else {
                      var didThrow = false;
                      var caughtError = null;
                      var clonedListeners = Array.from(listeners);
                      for (var i = 0; i < clonedListeners.length; i++) {
                        var _listener = clonedListeners[i];
                        try {
                          _listener.apply(null, args);
                        } catch (error) {
                          if (caughtError === null) {
                            didThrow = true;
                            caughtError = error;
                          }
                        }
                      }
                      if (didThrow) {
                        throw caughtError;
                      }
                    }
                  }
                }, "emit")
              }, {
                key: "removeAllListeners",
                value: /* @__PURE__ */ __name(function removeAllListeners() {
                  this.listenersMap.clear();
                }, "removeAllListeners")
              }, {
                key: "removeListener",
                value: /* @__PURE__ */ __name(function removeListener(event, listener) {
                  var listeners = this.listenersMap.get(event);
                  if (listeners !== void 0) {
                    var index = listeners.indexOf(listener);
                    if (index >= 0) {
                      listeners.splice(index, 1);
                    }
                  }
                }, "removeListener")
              }]);
            }();
            ;
            var CHROME_WEBSTORE_EXTENSION_ID = "fmkadmapgofadopljbjfkapdkoienihi";
            var INTERNAL_EXTENSION_ID = "dnjnjgbfilfphmojnmhliehogmojhclc";
            var LOCAL_EXTENSION_ID = "ikiahnapldjmdmpkmfhjdjilojjhgcbf";
            var __DEBUG__ = false;
            var __PERFORMANCE_PROFILE__ = false;
            var TREE_OPERATION_ADD = 1;
            var TREE_OPERATION_REMOVE = 2;
            var TREE_OPERATION_REORDER_CHILDREN = 3;
            var TREE_OPERATION_UPDATE_TREE_BASE_DURATION = 4;
            var TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS = 5;
            var TREE_OPERATION_REMOVE_ROOT = 6;
            var TREE_OPERATION_SET_SUBTREE_MODE = 7;
            var SUSPENSE_TREE_OPERATION_ADD = 8;
            var SUSPENSE_TREE_OPERATION_REMOVE = 9;
            var SUSPENSE_TREE_OPERATION_REORDER_CHILDREN = 10;
            var SUSPENSE_TREE_OPERATION_RESIZE = 11;
            var SUSPENSE_TREE_OPERATION_SUSPENDERS = 12;
            var PROFILING_FLAG_BASIC_SUPPORT = 1;
            var PROFILING_FLAG_TIMELINE_SUPPORT = 2;
            var PROFILING_FLAG_PERFORMANCE_TRACKS_SUPPORT = 4;
            var UNKNOWN_SUSPENDERS_NONE = 0;
            var UNKNOWN_SUSPENDERS_REASON_PRODUCTION = 1;
            var UNKNOWN_SUSPENDERS_REASON_OLD_VERSION = 2;
            var UNKNOWN_SUSPENDERS_REASON_THROWN_PROMISE = 3;
            var LOCAL_STORAGE_DEFAULT_TAB_KEY = "React::DevTools::defaultTab";
            var constants_LOCAL_STORAGE_COMPONENT_FILTER_PREFERENCES_KEY = "React::DevTools::componentFilters";
            var SESSION_STORAGE_LAST_SELECTION_KEY = "React::DevTools::lastSelection";
            var constants_LOCAL_STORAGE_OPEN_IN_EDITOR_URL = "React::DevTools::openInEditorUrl";
            var constants_LOCAL_STORAGE_OPEN_IN_EDITOR_URL_PRESET = "React::DevTools::openInEditorUrlPreset";
            var constants_LOCAL_STORAGE_ALWAYS_OPEN_IN_EDITOR = "React::DevTools::alwaysOpenInEditor";
            var LOCAL_STORAGE_PARSE_HOOK_NAMES_KEY = "React::DevTools::parseHookNames";
            var constants_SESSION_STORAGE_RECORD_CHANGE_DESCRIPTIONS_KEY = "React::DevTools::recordChangeDescriptions";
            var constants_SESSION_STORAGE_RECORD_TIMELINE_KEY = "React::DevTools::recordTimeline";
            var constants_SESSION_STORAGE_RELOAD_AND_PROFILE_KEY = "React::DevTools::reloadAndProfile";
            var LOCAL_STORAGE_BROWSER_THEME = "React::DevTools::theme";
            var LOCAL_STORAGE_TRACE_UPDATES_ENABLED_KEY = "React::DevTools::traceUpdatesEnabled";
            var LOCAL_STORAGE_SUPPORTS_PROFILING_KEY = "React::DevTools::supportsProfiling";
            var PROFILER_EXPORT_VERSION = 5;
            var FIREFOX_CONSOLE_DIMMING_COLOR = "color: rgba(124, 124, 124, 0.75)";
            var ANSI_STYLE_DIMMING_TEMPLATE = "\x1B[2;38;2;124;124;124m%s\x1B[0m";
            var ANSI_STYLE_DIMMING_TEMPLATE_WITH_COMPONENT_STACK = "\x1B[2;38;2;124;124;124m%s %o\x1B[0m";
            ;
            function esm_typeof(o) {
              "@babel/helpers - typeof";
              return esm_typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                return typeof o2;
              } : function(o2) {
                return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
              }, esm_typeof(o);
            }
            __name(esm_typeof, "esm_typeof");
            function _slicedToArray(arr, i) {
              return _arrayWithHoles(arr) || _iterableToArrayLimit(arr, i) || _unsupportedIterableToArray(arr, i) || _nonIterableRest();
            }
            __name(_slicedToArray, "_slicedToArray");
            function _nonIterableRest() {
              throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
            }
            __name(_nonIterableRest, "_nonIterableRest");
            function _unsupportedIterableToArray(o, minLen) {
              if (!o) return;
              if (typeof o === "string") return _arrayLikeToArray(o, minLen);
              var n = Object.prototype.toString.call(o).slice(8, -1);
              if (n === "Object" && o.constructor) n = o.constructor.name;
              if (n === "Map" || n === "Set") return Array.from(o);
              if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return _arrayLikeToArray(o, minLen);
            }
            __name(_unsupportedIterableToArray, "_unsupportedIterableToArray");
            function _arrayLikeToArray(arr, len) {
              if (len == null || len > arr.length) len = arr.length;
              for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i];
              return arr2;
            }
            __name(_arrayLikeToArray, "_arrayLikeToArray");
            function _iterableToArrayLimit(r, l) {
              var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"];
              if (null != t) {
                var e, n, i, u, a = [], f = true, o = false;
                try {
                  if (i = (t = t.call(r)).next, 0 === l) {
                    if (Object(t) !== t) return;
                    f = false;
                  } else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = true) ;
                } catch (r2) {
                  o = true, n = r2;
                } finally {
                  try {
                    if (!f && null != t.return && (u = t.return(), Object(u) !== u)) return;
                  } finally {
                    if (o) throw n;
                  }
                }
                return a;
              }
            }
            __name(_iterableToArrayLimit, "_iterableToArrayLimit");
            function _arrayWithHoles(arr) {
              if (Array.isArray(arr)) return arr;
            }
            __name(_arrayWithHoles, "_arrayWithHoles");
            var compareVersions = /* @__PURE__ */ __name(function compareVersions2(v1, v2) {
              var n1 = validateAndParse(v1);
              var n2 = validateAndParse(v2);
              var p1 = n1.pop();
              var p2 = n2.pop();
              var r = compareSegments(n1, n2);
              if (r !== 0) return r;
              if (p1 && p2) {
                return compareSegments(p1.split("."), p2.split("."));
              } else if (p1 || p2) {
                return p1 ? -1 : 1;
              }
              return 0;
            }, "compareVersions");
            var validate = /* @__PURE__ */ __name(function validate2(version) {
              return typeof version === "string" && /^[v\d]/.test(version) && semver.test(version);
            }, "validate");
            var compare = /* @__PURE__ */ __name(function compare2(v1, v2, operator) {
              assertValidOperator(operator);
              var res = compareVersions(v1, v2);
              return operatorResMap[operator].includes(res);
            }, "compare");
            var satisfies = /* @__PURE__ */ __name(function satisfies2(version, range) {
              var m = range.match(/^([<>=~^]+)/);
              var op = m ? m[1] : "=";
              if (op !== "^" && op !== "~") return compare(version, range, op);
              var _validateAndParse = validateAndParse(version), _validateAndParse2 = _slicedToArray(_validateAndParse, 5), v1 = _validateAndParse2[0], v2 = _validateAndParse2[1], v3 = _validateAndParse2[2], vp = _validateAndParse2[4];
              var _validateAndParse3 = validateAndParse(range), _validateAndParse4 = _slicedToArray(_validateAndParse3, 5), r1 = _validateAndParse4[0], r2 = _validateAndParse4[1], r3 = _validateAndParse4[2], rp = _validateAndParse4[4];
              var v = [v1, v2, v3];
              var r = [r1, r2 !== null && r2 !== void 0 ? r2 : "x", r3 !== null && r3 !== void 0 ? r3 : "x"];
              if (rp) {
                if (!vp) return false;
                if (compareSegments(v, r) !== 0) return false;
                if (compareSegments(vp.split("."), rp.split(".")) === -1) return false;
              }
              var nonZero = r.findIndex(function(v4) {
                return v4 !== "0";
              }) + 1;
              var i = op === "~" ? 2 : nonZero > 1 ? nonZero : 1;
              if (compareSegments(v.slice(0, i), r.slice(0, i)) !== 0) return false;
              if (compareSegments(v.slice(i), r.slice(i)) === -1) return false;
              return true;
            }, "satisfies");
            var semver = /^[v^~<>=]*?(\d+)(?:\.([x*]|\d+)(?:\.([x*]|\d+)(?:\.([x*]|\d+))?(?:-([\da-z\-]+(?:\.[\da-z\-]+)*))?(?:\+[\da-z\-]+(?:\.[\da-z\-]+)*)?)?)?$/i;
            var validateAndParse = /* @__PURE__ */ __name(function validateAndParse2(version) {
              if (typeof version !== "string") {
                throw new TypeError("Invalid argument expected string");
              }
              var match = version.match(semver);
              if (!match) {
                throw new Error("Invalid argument not valid semver ('".concat(version, "' received)"));
              }
              match.shift();
              return match;
            }, "validateAndParse");
            var isWildcard = /* @__PURE__ */ __name(function isWildcard2(s) {
              return s === "*" || s === "x" || s === "X";
            }, "isWildcard");
            var tryParse = /* @__PURE__ */ __name(function tryParse2(v) {
              var n = parseInt(v, 10);
              return isNaN(n) ? v : n;
            }, "tryParse");
            var forceType = /* @__PURE__ */ __name(function forceType2(a, b) {
              return esm_typeof(a) !== esm_typeof(b) ? [String(a), String(b)] : [a, b];
            }, "forceType");
            var compareStrings = /* @__PURE__ */ __name(function compareStrings2(a, b) {
              if (isWildcard(a) || isWildcard(b)) return 0;
              var _forceType = forceType(tryParse(a), tryParse(b)), _forceType2 = _slicedToArray(_forceType, 2), ap = _forceType2[0], bp = _forceType2[1];
              if (ap > bp) return 1;
              if (ap < bp) return -1;
              return 0;
            }, "compareStrings");
            var compareSegments = /* @__PURE__ */ __name(function compareSegments2(a, b) {
              for (var i = 0; i < Math.max(a.length, b.length); i++) {
                var r = compareStrings(a[i] || "0", b[i] || "0");
                if (r !== 0) return r;
              }
              return 0;
            }, "compareSegments");
            var operatorResMap = {
              ">": [1],
              ">=": [0, 1],
              "=": [0],
              "<=": [-1, 0],
              "<": [-1]
            };
            var allowedOperators = Object.keys(operatorResMap);
            var assertValidOperator = /* @__PURE__ */ __name(function assertValidOperator2(op) {
              if (typeof op !== "string") {
                throw new TypeError("Invalid operator type, expected string but got ".concat(esm_typeof(op)));
              }
              if (allowedOperators.indexOf(op) === -1) {
                throw new Error("Invalid operator, expected one of ".concat(allowedOperators.join("|")));
              }
            }, "assertValidOperator");
            var lru_cache = __webpack_require__(730);
            var lru_cache_default = /* @__PURE__ */ __webpack_require__.n(lru_cache);
            ;
            var enableHydrationLaneScheduling = true;
            var disableSchedulerTimeoutInWorkLoop = false;
            var enableSuspenseCallback = false;
            var enableScopeAPI = false;
            var enableCreateEventHandleAPI = false;
            var enableLegacyFBSupport = false;
            var enableYieldingBeforePassive = false;
            var enableThrottledScheduling = false;
            var enableLegacyCache = (
              /* unused pure expression or super */
              null
            );
            var enableAsyncIterableChildren = (
              /* unused pure expression or super */
              null
            );
            var enableTaint = (
              /* unused pure expression or super */
              null
            );
            var enablePostpone = (
              /* unused pure expression or super */
              null
            );
            var enableHalt = true;
            var enableViewTransition = true;
            var enableGestureTransition = (
              /* unused pure expression or super */
              null
            );
            var enableScrollEndPolyfill = (
              /* unused pure expression or super */
              null
            );
            var enableSuspenseyImages = false;
            var enableFizzBlockingRender = (
              /* unused pure expression or super */
              null
            );
            var enableSrcObject = (
              /* unused pure expression or super */
              null
            );
            var enableHydrationChangeEvent = (
              /* unused pure expression or super */
              null
            );
            var enableDefaultTransitionIndicator = (
              /* unused pure expression or super */
              null
            );
            var enableObjectFiber = false;
            var enableTransitionTracing = false;
            var enableLegacyHidden = false;
            var enableSuspenseAvoidThisFallback = false;
            var enableCPUSuspense = (
              /* unused pure expression or super */
              null
            );
            var enableNoCloningMemoCache = false;
            var enableUseEffectEventHook = true;
            var enableFizzExternalRuntime = (
              /* unused pure expression or super */
              null
            );
            var alwaysThrottleRetries = true;
            var passChildrenWhenCloningPersistedNodes = false;
            var enableEagerAlternateStateNodeCleanup = true;
            var enableRetryLaneExpiration = false;
            var retryLaneExpirationMs = 5e3;
            var syncLaneExpirationMs = 250;
            var transitionLaneExpirationMs = 5e3;
            var enableInfiniteRenderLoopDetection = false;
            var enableFragmentRefs = true;
            var enableFragmentRefsScrollIntoView = true;
            var renameElementSymbol = true;
            var enableHiddenSubtreeInsertionEffectCleanup = true;
            var disableLegacyContext = true;
            var disableLegacyContextForFunctionComponents = true;
            var enableMoveBefore = false;
            var disableClientCache = true;
            var enableReactTestRendererWarning = true;
            var disableLegacyMode = true;
            var disableCommentsAsDOMContainers = true;
            var enableTrustedTypesIntegration = false;
            var disableInputAttributeSyncing = false;
            var disableTextareaChildren = false;
            var enableProfilerTimer = (
              /* unused pure expression or super */
              null
            );
            var enableComponentPerformanceTrack = true;
            var enableSchedulingProfiler = !enableComponentPerformanceTrack && false;
            var enableProfilerCommitHooks = (
              /* unused pure expression or super */
              null
            );
            var enableProfilerNestedUpdatePhase = (
              /* unused pure expression or super */
              null
            );
            var enableAsyncDebugInfo = true;
            var enableUpdaterTracking = (
              /* unused pure expression or super */
              null
            );
            var ownerStackLimit = 1e4;
            ;
            function ReactSymbols_typeof(o) {
              "@babel/helpers - typeof";
              return ReactSymbols_typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                return typeof o2;
              } : function(o2) {
                return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
              }, ReactSymbols_typeof(o);
            }
            __name(ReactSymbols_typeof, "ReactSymbols_typeof");
            var REACT_LEGACY_ELEMENT_TYPE = Symbol.for("react.element");
            var REACT_ELEMENT_TYPE = renameElementSymbol ? Symbol.for("react.transitional.element") : REACT_LEGACY_ELEMENT_TYPE;
            var REACT_PORTAL_TYPE = Symbol.for("react.portal");
            var REACT_FRAGMENT_TYPE = Symbol.for("react.fragment");
            var REACT_STRICT_MODE_TYPE = Symbol.for("react.strict_mode");
            var REACT_PROFILER_TYPE = Symbol.for("react.profiler");
            var REACT_CONSUMER_TYPE = Symbol.for("react.consumer");
            var REACT_CONTEXT_TYPE = Symbol.for("react.context");
            var REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref");
            var REACT_SUSPENSE_TYPE = Symbol.for("react.suspense");
            var REACT_SUSPENSE_LIST_TYPE = Symbol.for("react.suspense_list");
            var REACT_MEMO_TYPE = Symbol.for("react.memo");
            var REACT_LAZY_TYPE = Symbol.for("react.lazy");
            var REACT_SCOPE_TYPE = Symbol.for("react.scope");
            var REACT_ACTIVITY_TYPE = Symbol.for("react.activity");
            var REACT_LEGACY_HIDDEN_TYPE = Symbol.for("react.legacy_hidden");
            var REACT_TRACING_MARKER_TYPE = Symbol.for("react.tracing_marker");
            var REACT_MEMO_CACHE_SENTINEL = Symbol.for("react.memo_cache_sentinel");
            var REACT_POSTPONE_TYPE = Symbol.for("react.postpone");
            var REACT_VIEW_TRANSITION_TYPE = Symbol.for("react.view_transition");
            var MAYBE_ITERATOR_SYMBOL = Symbol.iterator;
            var FAUX_ITERATOR_SYMBOL = "@@iterator";
            function getIteratorFn(maybeIterable) {
              if (maybeIterable === null || ReactSymbols_typeof(maybeIterable) !== "object") {
                return null;
              }
              var maybeIterator = MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL] || maybeIterable[FAUX_ITERATOR_SYMBOL];
              if (typeof maybeIterator === "function") {
                return maybeIterator;
              }
              return null;
            }
            __name(getIteratorFn, "getIteratorFn");
            var ASYNC_ITERATOR = Symbol.asyncIterator;
            ;
            var types_ElementTypeClass = 1;
            var ElementTypeContext = 2;
            var types_ElementTypeFunction = 5;
            var types_ElementTypeForwardRef = 6;
            var ElementTypeHostComponent = 7;
            var types_ElementTypeMemo = 8;
            var ElementTypeOtherOrUnknown = 9;
            var ElementTypeProfiler = 10;
            var ElementTypeRoot = 11;
            var ElementTypeSuspense = 12;
            var ElementTypeSuspenseList = 13;
            var ElementTypeTracingMarker = 14;
            var types_ElementTypeVirtual = 15;
            var ElementTypeViewTransition = 16;
            var ElementTypeActivity = 17;
            var ComponentFilterElementType = 1;
            var ComponentFilterDisplayName = 2;
            var ComponentFilterLocation = 3;
            var ComponentFilterHOC = 4;
            var ComponentFilterEnvironmentName = 5;
            var StrictMode = 1;
            ;
            var isArray = Array.isArray;
            const src_isArray = isArray;
            ;
            var process = __webpack_require__(169);
            function ownKeys(e, r) {
              var t = Object.keys(e);
              if (Object.getOwnPropertySymbols) {
                var o = Object.getOwnPropertySymbols(e);
                r && (o = o.filter(function(r2) {
                  return Object.getOwnPropertyDescriptor(e, r2).enumerable;
                })), t.push.apply(t, o);
              }
              return t;
            }
            __name(ownKeys, "ownKeys");
            function _objectSpread(e) {
              for (var r = 1; r < arguments.length; r++) {
                var t = null != arguments[r] ? arguments[r] : {};
                r % 2 ? ownKeys(Object(t), true).forEach(function(r2) {
                  utils_defineProperty(e, r2, t[r2]);
                }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function(r2) {
                  Object.defineProperty(e, r2, Object.getOwnPropertyDescriptor(t, r2));
                });
              }
              return e;
            }
            __name(_objectSpread, "_objectSpread");
            function utils_defineProperty(obj, key, value) {
              key = utils_toPropertyKey(key);
              if (key in obj) {
                Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
              } else {
                obj[key] = value;
              }
              return obj;
            }
            __name(utils_defineProperty, "utils_defineProperty");
            function utils_toPropertyKey(t) {
              var i = utils_toPrimitive(t, "string");
              return "symbol" == utils_typeof(i) ? i : i + "";
            }
            __name(utils_toPropertyKey, "utils_toPropertyKey");
            function utils_toPrimitive(t, r) {
              if ("object" != utils_typeof(t) || !t) return t;
              var e = t[Symbol.toPrimitive];
              if (void 0 !== e) {
                var i = e.call(t, r || "default");
                if ("object" != utils_typeof(i)) return i;
                throw new TypeError("@@toPrimitive must return a primitive value.");
              }
              return ("string" === r ? String : Number)(t);
            }
            __name(utils_toPrimitive, "utils_toPrimitive");
            function utils_typeof(o) {
              "@babel/helpers - typeof";
              return utils_typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                return typeof o2;
              } : function(o2) {
                return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
              }, utils_typeof(o);
            }
            __name(utils_typeof, "utils_typeof");
            function _toConsumableArray(arr) {
              return _arrayWithoutHoles(arr) || _iterableToArray(arr) || utils_unsupportedIterableToArray(arr) || _nonIterableSpread();
            }
            __name(_toConsumableArray, "_toConsumableArray");
            function _nonIterableSpread() {
              throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
            }
            __name(_nonIterableSpread, "_nonIterableSpread");
            function utils_unsupportedIterableToArray(o, minLen) {
              if (!o) return;
              if (typeof o === "string") return utils_arrayLikeToArray(o, minLen);
              var n = Object.prototype.toString.call(o).slice(8, -1);
              if (n === "Object" && o.constructor) n = o.constructor.name;
              if (n === "Map" || n === "Set") return Array.from(o);
              if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return utils_arrayLikeToArray(o, minLen);
            }
            __name(utils_unsupportedIterableToArray, "utils_unsupportedIterableToArray");
            function _iterableToArray(iter) {
              if (typeof Symbol !== "undefined" && iter[Symbol.iterator] != null || iter["@@iterator"] != null) return Array.from(iter);
            }
            __name(_iterableToArray, "_iterableToArray");
            function _arrayWithoutHoles(arr) {
              if (Array.isArray(arr)) return utils_arrayLikeToArray(arr);
            }
            __name(_arrayWithoutHoles, "_arrayWithoutHoles");
            function utils_arrayLikeToArray(arr, len) {
              if (len == null || len > arr.length) len = arr.length;
              for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i];
              return arr2;
            }
            __name(utils_arrayLikeToArray, "utils_arrayLikeToArray");
            var utils_hasOwnProperty = Object.prototype.hasOwnProperty;
            var cachedDisplayNames = /* @__PURE__ */ new WeakMap();
            var encodedStringCache = new (lru_cache_default())({
              max: 1e3
            });
            var LEGACY_REACT_PROVIDER_TYPE = Symbol.for("react.provider");
            function alphaSortKeys(a, b) {
              if (a.toString() > b.toString()) {
                return 1;
              } else if (b.toString() > a.toString()) {
                return -1;
              } else {
                return 0;
              }
            }
            __name(alphaSortKeys, "alphaSortKeys");
            function getAllEnumerableKeys(obj) {
              var keys = /* @__PURE__ */ new Set();
              var current = obj;
              var _loop = /* @__PURE__ */ __name(function _loop2() {
                var currentKeys = [].concat(_toConsumableArray(Object.keys(current)), _toConsumableArray(Object.getOwnPropertySymbols(current)));
                var descriptors = Object.getOwnPropertyDescriptors(current);
                currentKeys.forEach(function(key) {
                  if (descriptors[key].enumerable) {
                    keys.add(key);
                  }
                });
                current = Object.getPrototypeOf(current);
              }, "_loop");
              while (current != null) {
                _loop();
              }
              return keys;
            }
            __name(getAllEnumerableKeys, "getAllEnumerableKeys");
            function getWrappedDisplayName(outerType, innerType, wrapperName, fallbackName) {
              var displayName = outerType === null || outerType === void 0 ? void 0 : outerType.displayName;
              return displayName || "".concat(wrapperName, "(").concat(getDisplayName(innerType, fallbackName), ")");
            }
            __name(getWrappedDisplayName, "getWrappedDisplayName");
            function getDisplayName(type) {
              var fallbackName = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : "Anonymous";
              var nameFromCache = cachedDisplayNames.get(type);
              if (nameFromCache != null) {
                return nameFromCache;
              }
              var displayName = fallbackName;
              if (typeof type.displayName === "string") {
                displayName = type.displayName;
              } else if (typeof type.name === "string" && type.name !== "") {
                displayName = type.name;
              }
              cachedDisplayNames.set(type, displayName);
              return displayName;
            }
            __name(getDisplayName, "getDisplayName");
            var uidCounter = 0;
            function getUID() {
              return ++uidCounter;
            }
            __name(getUID, "getUID");
            function utfDecodeStringWithRanges(array, left, right) {
              var string = "";
              for (var i = left; i <= right; i++) {
                string += String.fromCodePoint(array[i]);
              }
              return string;
            }
            __name(utfDecodeStringWithRanges, "utfDecodeStringWithRanges");
            function surrogatePairToCodePoint(charCode1, charCode2) {
              return ((charCode1 & 1023) << 10) + (charCode2 & 1023) + 65536;
            }
            __name(surrogatePairToCodePoint, "surrogatePairToCodePoint");
            function utfEncodeString(string) {
              var cached = encodedStringCache.get(string);
              if (cached !== void 0) {
                return cached;
              }
              var encoded = [];
              var i = 0;
              var charCode;
              while (i < string.length) {
                charCode = string.charCodeAt(i);
                if ((charCode & 63488) === 55296) {
                  encoded.push(surrogatePairToCodePoint(charCode, string.charCodeAt(++i)));
                } else {
                  encoded.push(charCode);
                }
                ++i;
              }
              encodedStringCache.set(string, encoded);
              return encoded;
            }
            __name(utfEncodeString, "utfEncodeString");
            function printOperationsArray(operations) {
              var rendererID = operations[0];
              var rootID = operations[1];
              var logs = ["operations for renderer:".concat(rendererID, " and root:").concat(rootID)];
              var i = 2;
              var stringTable = [null];
              var stringTableSize = operations[i++];
              var stringTableEnd = i + stringTableSize;
              while (i < stringTableEnd) {
                var nextLength = operations[i++];
                var nextString = utfDecodeStringWithRanges(operations, i, i + nextLength - 1);
                stringTable.push(nextString);
                i += nextLength;
              }
              while (i < operations.length) {
                var operation = operations[i];
                switch (operation) {
                  case TREE_OPERATION_ADD: {
                    var id = operations[i + 1];
                    var type = operations[i + 2];
                    i += 3;
                    if (type === ElementTypeRoot) {
                      logs.push("Add new root node ".concat(id));
                      i++;
                      i++;
                      i++;
                      i++;
                    } else {
                      var parentID = operations[i];
                      i++;
                      i++;
                      var displayNameStringID = operations[i];
                      var displayName = stringTable[displayNameStringID];
                      i++;
                      i++;
                      i++;
                      logs.push("Add node ".concat(id, " (").concat(displayName || "null", ") as child of ").concat(parentID));
                    }
                    break;
                  }
                  case TREE_OPERATION_REMOVE: {
                    var removeLength = operations[i + 1];
                    i += 2;
                    for (var removeIndex = 0; removeIndex < removeLength; removeIndex++) {
                      var _id = operations[i];
                      i += 1;
                      logs.push("Remove node ".concat(_id));
                    }
                    break;
                  }
                  case TREE_OPERATION_REMOVE_ROOT: {
                    i += 1;
                    logs.push("Remove root ".concat(rootID));
                    break;
                  }
                  case TREE_OPERATION_SET_SUBTREE_MODE: {
                    var _id2 = operations[i + 1];
                    var mode = operations[i + 2];
                    i += 3;
                    logs.push("Mode ".concat(mode, " set for subtree with root ").concat(_id2));
                    break;
                  }
                  case TREE_OPERATION_REORDER_CHILDREN: {
                    var _id3 = operations[i + 1];
                    var numChildren = operations[i + 2];
                    i += 3;
                    var children = operations.slice(i, i + numChildren);
                    i += numChildren;
                    logs.push("Re-order node ".concat(_id3, " children ").concat(children.join(",")));
                    break;
                  }
                  case TREE_OPERATION_UPDATE_TREE_BASE_DURATION:
                    i += 3;
                    break;
                  case TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS: {
                    var _id4 = operations[i + 1];
                    var numErrors = operations[i + 2];
                    var numWarnings = operations[i + 3];
                    i += 4;
                    logs.push("Node ".concat(_id4, " has ").concat(numErrors, " errors and ").concat(numWarnings, " warnings"));
                    break;
                  }
                  case SUSPENSE_TREE_OPERATION_ADD: {
                    var fiberID = operations[i + 1];
                    var _parentID = operations[i + 2];
                    var nameStringID = operations[i + 3];
                    var isSuspended = operations[i + 4];
                    var numRects = operations[i + 5];
                    i += 6;
                    var name = stringTable[nameStringID];
                    var rects = void 0;
                    if (numRects === -1) {
                      rects = "null";
                    } else {
                      rects = "[";
                      for (var rectIndex = 0; rectIndex < numRects; rectIndex++) {
                        var offset = i + rectIndex * 4;
                        var x = operations[offset + 0];
                        var y = operations[offset + 1];
                        var width = operations[offset + 2];
                        var height = operations[offset + 3];
                        if (rectIndex > 0) {
                          rects += ", ";
                        }
                        rects += "(".concat(x, ", ").concat(y, ", ").concat(width, ", ").concat(height, ")");
                        i += 4;
                      }
                      rects += "]";
                    }
                    logs.push("Add suspense node ".concat(fiberID, " (").concat(String(name), ",rects={").concat(rects, "}) under ").concat(_parentID, " suspended ").concat(isSuspended));
                    break;
                  }
                  case SUSPENSE_TREE_OPERATION_REMOVE: {
                    var _removeLength = operations[i + 1];
                    i += 2;
                    for (var _removeIndex = 0; _removeIndex < _removeLength; _removeIndex++) {
                      var _id5 = operations[i];
                      i += 1;
                      logs.push("Remove suspense node ".concat(_id5));
                    }
                    break;
                  }
                  case SUSPENSE_TREE_OPERATION_REORDER_CHILDREN: {
                    var _id6 = operations[i + 1];
                    var _numChildren = operations[i + 2];
                    i += 3;
                    var _children = operations.slice(i, i + _numChildren);
                    i += _numChildren;
                    logs.push("Re-order suspense node ".concat(_id6, " children ").concat(_children.join(",")));
                    break;
                  }
                  case SUSPENSE_TREE_OPERATION_RESIZE: {
                    var _id7 = operations[i + 1];
                    var _numRects = operations[i + 2];
                    i += 3;
                    if (_numRects === -1) {
                      logs.push("Resize suspense node ".concat(_id7, " to null"));
                    } else {
                      var line = "Resize suspense node ".concat(_id7, " to [");
                      for (var _rectIndex = 0; _rectIndex < _numRects; _rectIndex++) {
                        var _x = operations[i + 0];
                        var _y = operations[i + 1];
                        var _width = operations[i + 2];
                        var _height = operations[i + 3];
                        if (_rectIndex > 0) {
                          line += ", ";
                        }
                        line += "(".concat(_x, ", ").concat(_y, ", ").concat(_width, ", ").concat(_height, ")");
                        i += 4;
                      }
                      logs.push(line + "]");
                    }
                    break;
                  }
                  case SUSPENSE_TREE_OPERATION_SUSPENDERS: {
                    i++;
                    var changeLength = operations[i++];
                    for (var changeIndex = 0; changeIndex < changeLength; changeIndex++) {
                      var _id8 = operations[i++];
                      var hasUniqueSuspenders = operations[i++] === 1;
                      var _isSuspended = operations[i++] === 1;
                      var environmentNamesLength = operations[i++];
                      i += environmentNamesLength;
                      logs.push("Suspense node ".concat(_id8, " unique suspenders set to ").concat(String(hasUniqueSuspenders), " is suspended set to ").concat(String(_isSuspended), " with ").concat(String(environmentNamesLength), " environments"));
                    }
                    break;
                  }
                  default:
                    throw Error('Unsupported Bridge operation "'.concat(operation, '"'));
                }
              }
              console.log(logs.join("\n  "));
            }
            __name(printOperationsArray, "printOperationsArray");
            function getDefaultComponentFilters() {
              return [{
                type: ComponentFilterElementType,
                value: ElementTypeHostComponent,
                isEnabled: true
              }];
            }
            __name(getDefaultComponentFilters, "getDefaultComponentFilters");
            function getSavedComponentFilters() {
              try {
                var raw = localStorageGetItem(LOCAL_STORAGE_COMPONENT_FILTER_PREFERENCES_KEY);
                if (raw != null) {
                  var parsedFilters = JSON.parse(raw);
                  return filterOutLocationComponentFilters(parsedFilters);
                }
              } catch (error) {
              }
              return getDefaultComponentFilters();
            }
            __name(getSavedComponentFilters, "getSavedComponentFilters");
            function setSavedComponentFilters(componentFilters) {
              localStorageSetItem(LOCAL_STORAGE_COMPONENT_FILTER_PREFERENCES_KEY, JSON.stringify(filterOutLocationComponentFilters(componentFilters)));
            }
            __name(setSavedComponentFilters, "setSavedComponentFilters");
            function filterOutLocationComponentFilters(componentFilters) {
              if (!Array.isArray(componentFilters)) {
                return componentFilters;
              }
              return componentFilters.filter(function(f) {
                return f.type !== ComponentFilterLocation;
              });
            }
            __name(filterOutLocationComponentFilters, "filterOutLocationComponentFilters");
            var vscodeFilepath = "vscode://file/{path}:{line}:{column}";
            function getDefaultPreset() {
              return typeof process.env.EDITOR_URL === "string" ? "custom" : "vscode";
            }
            __name(getDefaultPreset, "getDefaultPreset");
            function getDefaultOpenInEditorURL() {
              return typeof process.env.EDITOR_URL === "string" ? process.env.EDITOR_URL : vscodeFilepath;
            }
            __name(getDefaultOpenInEditorURL, "getDefaultOpenInEditorURL");
            function getOpenInEditorURL() {
              try {
                var rawPreset = localStorageGetItem(LOCAL_STORAGE_OPEN_IN_EDITOR_URL_PRESET);
                switch (rawPreset) {
                  case '"vscode"':
                    return vscodeFilepath;
                }
                var raw = localStorageGetItem(LOCAL_STORAGE_OPEN_IN_EDITOR_URL);
                if (raw != null) {
                  return JSON.parse(raw);
                }
              } catch (error) {
              }
              return getDefaultOpenInEditorURL();
            }
            __name(getOpenInEditorURL, "getOpenInEditorURL");
            function getAlwaysOpenInEditor() {
              try {
                var raw = localStorageGetItem(LOCAL_STORAGE_ALWAYS_OPEN_IN_EDITOR);
                return raw === "true";
              } catch (error) {
              }
              return false;
            }
            __name(getAlwaysOpenInEditor, "getAlwaysOpenInEditor");
            function parseElementDisplayNameFromBackend(displayName, type) {
              if (displayName === null) {
                return {
                  formattedDisplayName: null,
                  hocDisplayNames: null,
                  compiledWithForget: false
                };
              }
              if (displayName.startsWith("Forget(")) {
                var displayNameWithoutForgetWrapper = displayName.slice(7, displayName.length - 1);
                var _parseElementDisplayN = parseElementDisplayNameFromBackend(displayNameWithoutForgetWrapper, type), formattedDisplayName = _parseElementDisplayN.formattedDisplayName, _hocDisplayNames = _parseElementDisplayN.hocDisplayNames;
                return {
                  formattedDisplayName,
                  hocDisplayNames: _hocDisplayNames,
                  compiledWithForget: true
                };
              }
              var hocDisplayNames = null;
              switch (type) {
                case ElementTypeClass:
                case ElementTypeForwardRef:
                case ElementTypeFunction:
                case ElementTypeMemo:
                case ElementTypeVirtual:
                  if (displayName.indexOf("(") >= 0) {
                    var matches = displayName.match(/[^()]+/g);
                    if (matches != null) {
                      displayName = matches.pop();
                      hocDisplayNames = matches;
                    }
                  }
                  break;
                default:
                  break;
              }
              return {
                formattedDisplayName: displayName,
                hocDisplayNames,
                compiledWithForget: false
              };
            }
            __name(parseElementDisplayNameFromBackend, "parseElementDisplayNameFromBackend");
            function shallowDiffers(prev, next) {
              for (var attribute in prev) {
                if (!(attribute in next)) {
                  return true;
                }
              }
              for (var _attribute in next) {
                if (prev[_attribute] !== next[_attribute]) {
                  return true;
                }
              }
              return false;
            }
            __name(shallowDiffers, "shallowDiffers");
            function utils_getInObject(object, path) {
              return path.reduce(function(reduced, attr) {
                if (reduced) {
                  if (utils_hasOwnProperty.call(reduced, attr)) {
                    return reduced[attr];
                  }
                  if (typeof reduced[Symbol.iterator] === "function") {
                    return Array.from(reduced)[attr];
                  }
                }
                return null;
              }, object);
            }
            __name(utils_getInObject, "utils_getInObject");
            function deletePathInObject(object, path) {
              var length = path.length;
              var last = path[length - 1];
              if (object != null) {
                var parent = utils_getInObject(object, path.slice(0, length - 1));
                if (parent) {
                  if (src_isArray(parent)) {
                    parent.splice(last, 1);
                  } else {
                    delete parent[last];
                  }
                }
              }
            }
            __name(deletePathInObject, "deletePathInObject");
            function renamePathInObject(object, oldPath, newPath) {
              var length = oldPath.length;
              if (object != null) {
                var parent = utils_getInObject(object, oldPath.slice(0, length - 1));
                if (parent) {
                  var lastOld = oldPath[length - 1];
                  var lastNew = newPath[length - 1];
                  parent[lastNew] = parent[lastOld];
                  if (src_isArray(parent)) {
                    parent.splice(lastOld, 1);
                  } else {
                    delete parent[lastOld];
                  }
                }
              }
            }
            __name(renamePathInObject, "renamePathInObject");
            function utils_setInObject(object, path, value) {
              var length = path.length;
              var last = path[length - 1];
              if (object != null) {
                var parent = utils_getInObject(object, path.slice(0, length - 1));
                if (parent) {
                  parent[last] = value;
                }
              }
            }
            __name(utils_setInObject, "utils_setInObject");
            function isError(data) {
              if ("name" in data && "message" in data) {
                while (data) {
                  if (Object.prototype.toString.call(data) === "[object Error]") {
                    return true;
                  }
                  data = Object.getPrototypeOf(data);
                }
              }
              return false;
            }
            __name(isError, "isError");
            function getDataType(data) {
              if (data === null) {
                return "null";
              } else if (data === void 0) {
                return "undefined";
              }
              if (typeof HTMLElement !== "undefined" && data instanceof HTMLElement) {
                return "html_element";
              }
              var type = utils_typeof(data);
              switch (type) {
                case "bigint":
                  return "bigint";
                case "boolean":
                  return "boolean";
                case "function":
                  return "function";
                case "number":
                  if (Number.isNaN(data)) {
                    return "nan";
                  } else if (!Number.isFinite(data)) {
                    return "infinity";
                  } else {
                    return "number";
                  }
                case "object":
                  switch (data.$$typeof) {
                    case REACT_ELEMENT_TYPE:
                    case REACT_LEGACY_ELEMENT_TYPE:
                      return "react_element";
                    case REACT_LAZY_TYPE:
                      return "react_lazy";
                  }
                  if (src_isArray(data)) {
                    return "array";
                  } else if (ArrayBuffer.isView(data)) {
                    return utils_hasOwnProperty.call(data.constructor, "BYTES_PER_ELEMENT") ? "typed_array" : "data_view";
                  } else if (data.constructor && data.constructor.name === "ArrayBuffer") {
                    return "array_buffer";
                  } else if (typeof data[Symbol.iterator] === "function") {
                    var iterator = data[Symbol.iterator]();
                    if (!iterator) {
                    } else {
                      return iterator === data ? "opaque_iterator" : "iterator";
                    }
                  } else if (data.constructor && data.constructor.name === "RegExp") {
                    return "regexp";
                  } else if (typeof data.then === "function") {
                    return "thenable";
                  } else if (isError(data)) {
                    return "error";
                  } else {
                    var toStringValue = Object.prototype.toString.call(data);
                    if (toStringValue === "[object Date]") {
                      return "date";
                    } else if (toStringValue === "[object HTMLAllCollection]") {
                      return "html_all_collection";
                    }
                  }
                  if (!isPlainObject(data)) {
                    return "class_instance";
                  }
                  return "object";
                case "string":
                  return "string";
                case "symbol":
                  return "symbol";
                case "undefined":
                  if (Object.prototype.toString.call(data) === "[object HTMLAllCollection]") {
                    return "html_all_collection";
                  }
                  return "undefined";
                default:
                  return "unknown";
              }
            }
            __name(getDataType, "getDataType");
            function typeOfWithLegacyElementSymbol(object) {
              if (utils_typeof(object) === "object" && object !== null) {
                var $$typeof = object.$$typeof;
                switch ($$typeof) {
                  case REACT_ELEMENT_TYPE:
                  case REACT_LEGACY_ELEMENT_TYPE:
                    var type = object.type;
                    switch (type) {
                      case REACT_FRAGMENT_TYPE:
                      case REACT_PROFILER_TYPE:
                      case REACT_STRICT_MODE_TYPE:
                      case REACT_SUSPENSE_TYPE:
                      case REACT_SUSPENSE_LIST_TYPE:
                      case REACT_VIEW_TRANSITION_TYPE:
                        return type;
                      default:
                        var $$typeofType = type && type.$$typeof;
                        switch ($$typeofType) {
                          case REACT_CONTEXT_TYPE:
                          case REACT_FORWARD_REF_TYPE:
                          case REACT_LAZY_TYPE:
                          case REACT_MEMO_TYPE:
                            return $$typeofType;
                          case REACT_CONSUMER_TYPE:
                            return $$typeofType;
                          default:
                            return $$typeof;
                        }
                    }
                  case REACT_PORTAL_TYPE:
                    return $$typeof;
                }
              }
              return void 0;
            }
            __name(typeOfWithLegacyElementSymbol, "typeOfWithLegacyElementSymbol");
            function getDisplayNameForReactElement(element) {
              var elementType = typeOfWithLegacyElementSymbol(element);
              switch (elementType) {
                case REACT_CONSUMER_TYPE:
                  return "ContextConsumer";
                case LEGACY_REACT_PROVIDER_TYPE:
                  return "ContextProvider";
                case REACT_CONTEXT_TYPE:
                  return "Context";
                case REACT_FORWARD_REF_TYPE:
                  return "ForwardRef";
                case REACT_FRAGMENT_TYPE:
                  return "Fragment";
                case REACT_LAZY_TYPE:
                  return "Lazy";
                case REACT_MEMO_TYPE:
                  return "Memo";
                case REACT_PORTAL_TYPE:
                  return "Portal";
                case REACT_PROFILER_TYPE:
                  return "Profiler";
                case REACT_STRICT_MODE_TYPE:
                  return "StrictMode";
                case REACT_SUSPENSE_TYPE:
                  return "Suspense";
                case REACT_SUSPENSE_LIST_TYPE:
                  return "SuspenseList";
                case REACT_VIEW_TRANSITION_TYPE:
                  return "ViewTransition";
                case REACT_TRACING_MARKER_TYPE:
                  return "TracingMarker";
                default:
                  var type = element.type;
                  if (typeof type === "string") {
                    return type;
                  } else if (typeof type === "function") {
                    return getDisplayName(type, "Anonymous");
                  } else if (type != null) {
                    return "NotImplementedInDevtools";
                  } else {
                    return "Element";
                  }
              }
            }
            __name(getDisplayNameForReactElement, "getDisplayNameForReactElement");
            var MAX_PREVIEW_STRING_LENGTH = 50;
            function truncateForDisplay(string) {
              var length = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : MAX_PREVIEW_STRING_LENGTH;
              if (string.length > length) {
                return string.slice(0, length) + "\u2026";
              } else {
                return string;
              }
            }
            __name(truncateForDisplay, "truncateForDisplay");
            function formatDataForPreview(data, showFormattedValue) {
              if (data != null && utils_hasOwnProperty.call(data, meta.type)) {
                return showFormattedValue ? data[meta.preview_long] : data[meta.preview_short];
              }
              var type = getDataType(data);
              switch (type) {
                case "html_element":
                  return "<".concat(truncateForDisplay(data.tagName.toLowerCase()), " />");
                case "function":
                  if (typeof data.name === "function" || data.name === "") {
                    return "() => {}";
                  }
                  return "".concat(truncateForDisplay(data.name), "() {}");
                case "string":
                  return '"'.concat(data, '"');
                case "bigint":
                  return truncateForDisplay(data.toString() + "n");
                case "regexp":
                  return truncateForDisplay(data.toString());
                case "symbol":
                  return truncateForDisplay(data.toString());
                case "react_element":
                  return "<".concat(truncateForDisplay(getDisplayNameForReactElement(data) || "Unknown"), " />");
                case "react_lazy":
                  var payload = data._payload;
                  if (payload !== null && utils_typeof(payload) === "object") {
                    if (payload._status === 0) {
                      return "pending lazy()";
                    }
                    if (payload._status === 1 && payload._result != null) {
                      if (showFormattedValue) {
                        var formatted = formatDataForPreview(payload._result.default, false);
                        return "fulfilled lazy() {".concat(truncateForDisplay(formatted), "}");
                      } else {
                        return "fulfilled lazy() {\u2026}";
                      }
                    }
                    if (payload._status === 2) {
                      if (showFormattedValue) {
                        var _formatted = formatDataForPreview(payload._result, false);
                        return "rejected lazy() {".concat(truncateForDisplay(_formatted), "}");
                      } else {
                        return "rejected lazy() {\u2026}";
                      }
                    }
                    if (payload.status === "pending" || payload.status === "blocked") {
                      return "pending lazy()";
                    }
                    if (payload.status === "fulfilled") {
                      if (showFormattedValue) {
                        var _formatted2 = formatDataForPreview(payload.value, false);
                        return "fulfilled lazy() {".concat(truncateForDisplay(_formatted2), "}");
                      } else {
                        return "fulfilled lazy() {\u2026}";
                      }
                    }
                    if (payload.status === "rejected") {
                      if (showFormattedValue) {
                        var _formatted3 = formatDataForPreview(payload.reason, false);
                        return "rejected lazy() {".concat(truncateForDisplay(_formatted3), "}");
                      } else {
                        return "rejected lazy() {\u2026}";
                      }
                    }
                  }
                  return "lazy()";
                case "array_buffer":
                  return "ArrayBuffer(".concat(data.byteLength, ")");
                case "data_view":
                  return "DataView(".concat(data.buffer.byteLength, ")");
                case "array":
                  if (showFormattedValue) {
                    var _formatted4 = "";
                    for (var i = 0; i < data.length; i++) {
                      if (i > 0) {
                        _formatted4 += ", ";
                      }
                      _formatted4 += formatDataForPreview(data[i], false);
                      if (_formatted4.length > MAX_PREVIEW_STRING_LENGTH) {
                        break;
                      }
                    }
                    return "[".concat(truncateForDisplay(_formatted4), "]");
                  } else {
                    var length = utils_hasOwnProperty.call(data, meta.size) ? data[meta.size] : data.length;
                    return "Array(".concat(length, ")");
                  }
                case "typed_array":
                  var shortName = "".concat(data.constructor.name, "(").concat(data.length, ")");
                  if (showFormattedValue) {
                    var _formatted5 = "";
                    for (var _i = 0; _i < data.length; _i++) {
                      if (_i > 0) {
                        _formatted5 += ", ";
                      }
                      _formatted5 += data[_i];
                      if (_formatted5.length > MAX_PREVIEW_STRING_LENGTH) {
                        break;
                      }
                    }
                    return "".concat(shortName, " [").concat(truncateForDisplay(_formatted5), "]");
                  } else {
                    return shortName;
                  }
                case "iterator":
                  var name = data.constructor.name;
                  if (showFormattedValue) {
                    var array = Array.from(data);
                    var _formatted6 = "";
                    for (var _i2 = 0; _i2 < array.length; _i2++) {
                      var entryOrEntries = array[_i2];
                      if (_i2 > 0) {
                        _formatted6 += ", ";
                      }
                      if (src_isArray(entryOrEntries)) {
                        var key = formatDataForPreview(entryOrEntries[0], true);
                        var value = formatDataForPreview(entryOrEntries[1], false);
                        _formatted6 += "".concat(key, " => ").concat(value);
                      } else {
                        _formatted6 += formatDataForPreview(entryOrEntries, false);
                      }
                      if (_formatted6.length > MAX_PREVIEW_STRING_LENGTH) {
                        break;
                      }
                    }
                    return "".concat(name, "(").concat(data.size, ") {").concat(truncateForDisplay(_formatted6), "}");
                  } else {
                    return "".concat(name, "(").concat(data.size, ")");
                  }
                case "opaque_iterator": {
                  return data[Symbol.toStringTag];
                }
                case "date":
                  return data.toString();
                case "class_instance":
                  try {
                    var resolvedConstructorName = data.constructor.name;
                    if (typeof resolvedConstructorName === "string") {
                      return resolvedConstructorName;
                    }
                    resolvedConstructorName = Object.getPrototypeOf(data).constructor.name;
                    if (typeof resolvedConstructorName === "string") {
                      return resolvedConstructorName;
                    }
                    try {
                      return truncateForDisplay(String(data));
                    } catch (error) {
                      return "unserializable";
                    }
                  } catch (error) {
                    return "unserializable";
                  }
                case "thenable":
                  var displayName;
                  if (isPlainObject(data)) {
                    displayName = "Thenable";
                  } else {
                    var _resolvedConstructorName = data.constructor.name;
                    if (typeof _resolvedConstructorName !== "string") {
                      _resolvedConstructorName = Object.getPrototypeOf(data).constructor.name;
                    }
                    if (typeof _resolvedConstructorName === "string") {
                      displayName = _resolvedConstructorName;
                    } else {
                      displayName = "Thenable";
                    }
                  }
                  switch (data.status) {
                    case "pending":
                      return "pending ".concat(displayName);
                    case "fulfilled":
                      if (showFormattedValue) {
                        var _formatted7 = formatDataForPreview(data.value, false);
                        return "fulfilled ".concat(displayName, " {").concat(truncateForDisplay(_formatted7), "}");
                      } else {
                        return "fulfilled ".concat(displayName, " {\u2026}");
                      }
                    case "rejected":
                      if (showFormattedValue) {
                        var _formatted8 = formatDataForPreview(data.reason, false);
                        return "rejected ".concat(displayName, " {").concat(truncateForDisplay(_formatted8), "}");
                      } else {
                        return "rejected ".concat(displayName, " {\u2026}");
                      }
                    default:
                      return displayName;
                  }
                case "object":
                  if (showFormattedValue) {
                    var keys = Array.from(getAllEnumerableKeys(data)).sort(alphaSortKeys);
                    var _formatted9 = "";
                    for (var _i3 = 0; _i3 < keys.length; _i3++) {
                      var _key = keys[_i3];
                      if (_i3 > 0) {
                        _formatted9 += ", ";
                      }
                      _formatted9 += "".concat(_key.toString(), ": ").concat(formatDataForPreview(data[_key], false));
                      if (_formatted9.length > MAX_PREVIEW_STRING_LENGTH) {
                        break;
                      }
                    }
                    return "{".concat(truncateForDisplay(_formatted9), "}");
                  } else {
                    return "{\u2026}";
                  }
                case "error":
                  return truncateForDisplay(String(data));
                case "boolean":
                case "number":
                case "infinity":
                case "nan":
                case "null":
                case "undefined":
                  return String(data);
                default:
                  try {
                    return truncateForDisplay(String(data));
                  } catch (error) {
                    return "unserializable";
                  }
              }
            }
            __name(formatDataForPreview, "formatDataForPreview");
            var isPlainObject = /* @__PURE__ */ __name(function isPlainObject2(object) {
              var objectPrototype = Object.getPrototypeOf(object);
              if (!objectPrototype) return true;
              var objectParentPrototype = Object.getPrototypeOf(objectPrototype);
              return !objectParentPrototype;
            }, "isPlainObject");
            function backendToFrontendSerializedElementMapper(element) {
              var _parseElementDisplayN2 = parseElementDisplayNameFromBackend(element.displayName, element.type), formattedDisplayName = _parseElementDisplayN2.formattedDisplayName, hocDisplayNames = _parseElementDisplayN2.hocDisplayNames, compiledWithForget = _parseElementDisplayN2.compiledWithForget;
              return _objectSpread(_objectSpread({}, element), {}, {
                displayName: formattedDisplayName,
                hocDisplayNames,
                compiledWithForget
              });
            }
            __name(backendToFrontendSerializedElementMapper, "backendToFrontendSerializedElementMapper");
            function normalizeUrlIfValid(url) {
              try {
                return new URL(url).toString();
              } catch (_unused) {
                return url;
              }
            }
            __name(normalizeUrlIfValid, "normalizeUrlIfValid");
            function getIsReloadAndProfileSupported() {
              var isBackendStorageAPISupported = false;
              try {
                localStorage.getItem("test");
                isBackendStorageAPISupported = true;
              } catch (error) {
              }
              return isBackendStorageAPISupported && isSynchronousXHRSupported();
            }
            __name(getIsReloadAndProfileSupported, "getIsReloadAndProfileSupported");
            function getIfReloadedAndProfiling() {
              return sessionStorageGetItem(SESSION_STORAGE_RELOAD_AND_PROFILE_KEY) === "true";
            }
            __name(getIfReloadedAndProfiling, "getIfReloadedAndProfiling");
            function getProfilingSettings() {
              return {
                recordChangeDescriptions: sessionStorageGetItem(SESSION_STORAGE_RECORD_CHANGE_DESCRIPTIONS_KEY) === "true",
                recordTimeline: sessionStorageGetItem(SESSION_STORAGE_RECORD_TIMELINE_KEY) === "true"
              };
            }
            __name(getProfilingSettings, "getProfilingSettings");
            function onReloadAndProfile(recordChangeDescriptions, recordTimeline) {
              sessionStorageSetItem(SESSION_STORAGE_RELOAD_AND_PROFILE_KEY, "true");
              sessionStorageSetItem(SESSION_STORAGE_RECORD_CHANGE_DESCRIPTIONS_KEY, recordChangeDescriptions ? "true" : "false");
              sessionStorageSetItem(SESSION_STORAGE_RECORD_TIMELINE_KEY, recordTimeline ? "true" : "false");
            }
            __name(onReloadAndProfile, "onReloadAndProfile");
            function onReloadAndProfileFlagsReset() {
              sessionStorageRemoveItem(SESSION_STORAGE_RELOAD_AND_PROFILE_KEY);
              sessionStorageRemoveItem(SESSION_STORAGE_RECORD_CHANGE_DESCRIPTIONS_KEY);
              sessionStorageRemoveItem(SESSION_STORAGE_RECORD_TIMELINE_KEY);
            }
            __name(onReloadAndProfileFlagsReset, "onReloadAndProfileFlagsReset");
            function unionOfTwoArrays(a, b) {
              var result = a;
              for (var i = 0; i < b.length; i++) {
                var value = b[i];
                if (a.indexOf(value) === -1) {
                  if (result === a) {
                    result = a.slice(0);
                  }
                  result.push(value);
                }
              }
              return result;
            }
            __name(unionOfTwoArrays, "unionOfTwoArrays");
            ;
            function noop() {
            }
            __name(noop, "noop");
            ;
            function hydration_ownKeys(e, r) {
              var t = Object.keys(e);
              if (Object.getOwnPropertySymbols) {
                var o = Object.getOwnPropertySymbols(e);
                r && (o = o.filter(function(r2) {
                  return Object.getOwnPropertyDescriptor(e, r2).enumerable;
                })), t.push.apply(t, o);
              }
              return t;
            }
            __name(hydration_ownKeys, "hydration_ownKeys");
            function hydration_objectSpread(e) {
              for (var r = 1; r < arguments.length; r++) {
                var t = null != arguments[r] ? arguments[r] : {};
                r % 2 ? hydration_ownKeys(Object(t), true).forEach(function(r2) {
                  hydration_defineProperty(e, r2, t[r2]);
                }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : hydration_ownKeys(Object(t)).forEach(function(r2) {
                  Object.defineProperty(e, r2, Object.getOwnPropertyDescriptor(t, r2));
                });
              }
              return e;
            }
            __name(hydration_objectSpread, "hydration_objectSpread");
            function hydration_defineProperty(obj, key, value) {
              key = hydration_toPropertyKey(key);
              if (key in obj) {
                Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
              } else {
                obj[key] = value;
              }
              return obj;
            }
            __name(hydration_defineProperty, "hydration_defineProperty");
            function hydration_toPropertyKey(t) {
              var i = hydration_toPrimitive(t, "string");
              return "symbol" == hydration_typeof(i) ? i : i + "";
            }
            __name(hydration_toPropertyKey, "hydration_toPropertyKey");
            function hydration_toPrimitive(t, r) {
              if ("object" != hydration_typeof(t) || !t) return t;
              var e = t[Symbol.toPrimitive];
              if (void 0 !== e) {
                var i = e.call(t, r || "default");
                if ("object" != hydration_typeof(i)) return i;
                throw new TypeError("@@toPrimitive must return a primitive value.");
              }
              return ("string" === r ? String : Number)(t);
            }
            __name(hydration_toPrimitive, "hydration_toPrimitive");
            function hydration_typeof(o) {
              "@babel/helpers - typeof";
              return hydration_typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                return typeof o2;
              } : function(o2) {
                return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
              }, hydration_typeof(o);
            }
            __name(hydration_typeof, "hydration_typeof");
            var meta = {
              inspectable: Symbol("inspectable"),
              inspected: Symbol("inspected"),
              name: Symbol("name"),
              preview_long: Symbol("preview_long"),
              preview_short: Symbol("preview_short"),
              readonly: Symbol("readonly"),
              size: Symbol("size"),
              type: Symbol("type"),
              unserializable: Symbol("unserializable")
            };
            var LEVEL_THRESHOLD = 2;
            function createDehydrated(type, inspectable, data, cleaned, path) {
              cleaned.push(path);
              var dehydrated = {
                inspectable,
                type,
                preview_long: formatDataForPreview(data, true),
                preview_short: formatDataForPreview(data, false),
                name: typeof data.constructor !== "function" || typeof data.constructor.name !== "string" || data.constructor.name === "Object" ? "" : data.constructor.name
              };
              if (type === "array" || type === "typed_array") {
                dehydrated.size = data.length;
              } else if (type === "object") {
                dehydrated.size = Object.keys(data).length;
              }
              if (type === "iterator" || type === "typed_array") {
                dehydrated.readonly = true;
              }
              return dehydrated;
            }
            __name(createDehydrated, "createDehydrated");
            function dehydrate(data, cleaned, unserializable, path, isPathAllowed) {
              var level = arguments.length > 5 && arguments[5] !== void 0 ? arguments[5] : 0;
              var type = getDataType(data);
              var isPathAllowedCheck;
              switch (type) {
                case "html_element":
                  cleaned.push(path);
                  return {
                    inspectable: false,
                    preview_short: formatDataForPreview(data, false),
                    preview_long: formatDataForPreview(data, true),
                    name: data.tagName,
                    type
                  };
                case "function":
                  cleaned.push(path);
                  return {
                    inspectable: false,
                    preview_short: formatDataForPreview(data, false),
                    preview_long: formatDataForPreview(data, true),
                    name: typeof data.name === "function" || !data.name ? "function" : data.name,
                    type
                  };
                case "string":
                  isPathAllowedCheck = isPathAllowed(path);
                  if (isPathAllowedCheck) {
                    return data;
                  } else {
                    return data.length <= 500 ? data : data.slice(0, 500) + "...";
                  }
                case "bigint":
                  cleaned.push(path);
                  return {
                    inspectable: false,
                    preview_short: formatDataForPreview(data, false),
                    preview_long: formatDataForPreview(data, true),
                    name: data.toString(),
                    type
                  };
                case "symbol":
                  cleaned.push(path);
                  return {
                    inspectable: false,
                    preview_short: formatDataForPreview(data, false),
                    preview_long: formatDataForPreview(data, true),
                    name: data.toString(),
                    type
                  };
                case "react_element": {
                  isPathAllowedCheck = isPathAllowed(path);
                  if (level >= LEVEL_THRESHOLD && !isPathAllowedCheck) {
                    cleaned.push(path);
                    return {
                      inspectable: true,
                      preview_short: formatDataForPreview(data, false),
                      preview_long: formatDataForPreview(data, true),
                      name: getDisplayNameForReactElement(data) || "Unknown",
                      type
                    };
                  }
                  var unserializableValue = {
                    unserializable: true,
                    type,
                    readonly: true,
                    preview_short: formatDataForPreview(data, false),
                    preview_long: formatDataForPreview(data, true),
                    name: getDisplayNameForReactElement(data) || "Unknown"
                  };
                  unserializableValue.key = dehydrate(data.key, cleaned, unserializable, path.concat(["key"]), isPathAllowed, isPathAllowedCheck ? 1 : level + 1);
                  if (data.$$typeof === REACT_LEGACY_ELEMENT_TYPE) {
                    unserializableValue.ref = dehydrate(data.ref, cleaned, unserializable, path.concat(["ref"]), isPathAllowed, isPathAllowedCheck ? 1 : level + 1);
                  }
                  unserializableValue.props = dehydrate(data.props, cleaned, unserializable, path.concat(["props"]), isPathAllowed, isPathAllowedCheck ? 1 : level + 1);
                  unserializable.push(path);
                  return unserializableValue;
                }
                case "react_lazy": {
                  isPathAllowedCheck = isPathAllowed(path);
                  var payload = data._payload;
                  if (level >= LEVEL_THRESHOLD && !isPathAllowedCheck) {
                    cleaned.push(path);
                    var inspectable = payload !== null && hydration_typeof(payload) === "object" && (payload._status === 1 || payload._status === 2 || payload.status === "fulfilled" || payload.status === "rejected");
                    return {
                      inspectable,
                      preview_short: formatDataForPreview(data, false),
                      preview_long: formatDataForPreview(data, true),
                      name: "lazy()",
                      type
                    };
                  }
                  var _unserializableValue = {
                    unserializable: true,
                    type,
                    preview_short: formatDataForPreview(data, false),
                    preview_long: formatDataForPreview(data, true),
                    name: "lazy()"
                  };
                  _unserializableValue._payload = dehydrate(payload, cleaned, unserializable, path.concat(["_payload"]), isPathAllowed, isPathAllowedCheck ? 1 : level + 1);
                  unserializable.push(path);
                  return _unserializableValue;
                }
                case "array_buffer":
                case "data_view":
                  cleaned.push(path);
                  return {
                    inspectable: false,
                    preview_short: formatDataForPreview(data, false),
                    preview_long: formatDataForPreview(data, true),
                    name: type === "data_view" ? "DataView" : "ArrayBuffer",
                    size: data.byteLength,
                    type
                  };
                case "array":
                  isPathAllowedCheck = isPathAllowed(path);
                  if (level >= LEVEL_THRESHOLD && !isPathAllowedCheck) {
                    return createDehydrated(type, true, data, cleaned, path);
                  }
                  var arr = [];
                  for (var i = 0; i < data.length; i++) {
                    arr[i] = dehydrateKey(data, i, cleaned, unserializable, path.concat([i]), isPathAllowed, isPathAllowedCheck ? 1 : level + 1);
                  }
                  return arr;
                case "html_all_collection":
                case "typed_array":
                case "iterator":
                  isPathAllowedCheck = isPathAllowed(path);
                  if (level >= LEVEL_THRESHOLD && !isPathAllowedCheck) {
                    return createDehydrated(type, true, data, cleaned, path);
                  } else {
                    var _unserializableValue2 = {
                      unserializable: true,
                      type,
                      readonly: true,
                      size: type === "typed_array" ? data.length : void 0,
                      preview_short: formatDataForPreview(data, false),
                      preview_long: formatDataForPreview(data, true),
                      name: typeof data.constructor !== "function" || typeof data.constructor.name !== "string" || data.constructor.name === "Object" ? "" : data.constructor.name
                    };
                    Array.from(data).forEach(function(item, i2) {
                      return _unserializableValue2[i2] = dehydrate(item, cleaned, unserializable, path.concat([i2]), isPathAllowed, isPathAllowedCheck ? 1 : level + 1);
                    });
                    unserializable.push(path);
                    return _unserializableValue2;
                  }
                case "opaque_iterator":
                  cleaned.push(path);
                  return {
                    inspectable: false,
                    preview_short: formatDataForPreview(data, false),
                    preview_long: formatDataForPreview(data, true),
                    name: data[Symbol.toStringTag],
                    type
                  };
                case "date":
                  cleaned.push(path);
                  return {
                    inspectable: false,
                    preview_short: formatDataForPreview(data, false),
                    preview_long: formatDataForPreview(data, true),
                    name: data.toString(),
                    type
                  };
                case "regexp":
                  cleaned.push(path);
                  return {
                    inspectable: false,
                    preview_short: formatDataForPreview(data, false),
                    preview_long: formatDataForPreview(data, true),
                    name: data.toString(),
                    type
                  };
                case "thenable":
                  isPathAllowedCheck = isPathAllowed(path);
                  if (level >= LEVEL_THRESHOLD && !isPathAllowedCheck) {
                    cleaned.push(path);
                    return {
                      inspectable: data.status === "fulfilled" || data.status === "rejected",
                      preview_short: formatDataForPreview(data, false),
                      preview_long: formatDataForPreview(data, true),
                      name: data.toString(),
                      type
                    };
                  }
                  if (data.status === "resolved_model" || data.status === "resolve_module") {
                    data.then(noop);
                  }
                  switch (data.status) {
                    case "fulfilled": {
                      var _unserializableValue3 = {
                        unserializable: true,
                        type,
                        preview_short: formatDataForPreview(data, false),
                        preview_long: formatDataForPreview(data, true),
                        name: "fulfilled Thenable"
                      };
                      _unserializableValue3.value = dehydrate(data.value, cleaned, unserializable, path.concat(["value"]), isPathAllowed, isPathAllowedCheck ? 1 : level + 1);
                      unserializable.push(path);
                      return _unserializableValue3;
                    }
                    case "rejected": {
                      var _unserializableValue4 = {
                        unserializable: true,
                        type,
                        preview_short: formatDataForPreview(data, false),
                        preview_long: formatDataForPreview(data, true),
                        name: "rejected Thenable"
                      };
                      _unserializableValue4.reason = dehydrate(data.reason, cleaned, unserializable, path.concat(["reason"]), isPathAllowed, isPathAllowedCheck ? 1 : level + 1);
                      unserializable.push(path);
                      return _unserializableValue4;
                    }
                    default:
                      cleaned.push(path);
                      return {
                        inspectable: false,
                        preview_short: formatDataForPreview(data, false),
                        preview_long: formatDataForPreview(data, true),
                        name: data.toString(),
                        type
                      };
                  }
                case "object":
                  isPathAllowedCheck = isPathAllowed(path);
                  if (level >= LEVEL_THRESHOLD && !isPathAllowedCheck) {
                    return createDehydrated(type, true, data, cleaned, path);
                  } else {
                    var object = {};
                    getAllEnumerableKeys(data).forEach(function(key) {
                      var name = key.toString();
                      object[name] = dehydrateKey(data, key, cleaned, unserializable, path.concat([name]), isPathAllowed, isPathAllowedCheck ? 1 : level + 1);
                    });
                    return object;
                  }
                case "class_instance": {
                  isPathAllowedCheck = isPathAllowed(path);
                  if (level >= LEVEL_THRESHOLD && !isPathAllowedCheck) {
                    return createDehydrated(type, true, data, cleaned, path);
                  }
                  var value = {
                    unserializable: true,
                    type,
                    readonly: true,
                    preview_short: formatDataForPreview(data, false),
                    preview_long: formatDataForPreview(data, true),
                    name: typeof data.constructor !== "function" || typeof data.constructor.name !== "string" ? "" : data.constructor.name
                  };
                  getAllEnumerableKeys(data).forEach(function(key) {
                    var keyAsString = key.toString();
                    value[keyAsString] = dehydrate(data[key], cleaned, unserializable, path.concat([keyAsString]), isPathAllowed, isPathAllowedCheck ? 1 : level + 1);
                  });
                  unserializable.push(path);
                  return value;
                }
                case "error": {
                  isPathAllowedCheck = isPathAllowed(path);
                  if (level >= LEVEL_THRESHOLD && !isPathAllowedCheck) {
                    return createDehydrated(type, true, data, cleaned, path);
                  }
                  var _value = {
                    unserializable: true,
                    type,
                    readonly: true,
                    preview_short: formatDataForPreview(data, false),
                    preview_long: formatDataForPreview(data, true),
                    name: data.name
                  };
                  _value.message = dehydrate(data.message, cleaned, unserializable, path.concat(["message"]), isPathAllowed, isPathAllowedCheck ? 1 : level + 1);
                  _value.stack = dehydrate(data.stack, cleaned, unserializable, path.concat(["stack"]), isPathAllowed, isPathAllowedCheck ? 1 : level + 1);
                  if ("cause" in data) {
                    _value.cause = dehydrate(data.cause, cleaned, unserializable, path.concat(["cause"]), isPathAllowed, isPathAllowedCheck ? 1 : level + 1);
                  }
                  getAllEnumerableKeys(data).forEach(function(key) {
                    var keyAsString = key.toString();
                    _value[keyAsString] = dehydrate(data[key], cleaned, unserializable, path.concat([keyAsString]), isPathAllowed, isPathAllowedCheck ? 1 : level + 1);
                  });
                  unserializable.push(path);
                  return _value;
                }
                case "infinity":
                case "nan":
                case "undefined":
                  cleaned.push(path);
                  return {
                    type
                  };
                default:
                  return data;
              }
            }
            __name(dehydrate, "dehydrate");
            function dehydrateKey(parent, key, cleaned, unserializable, path, isPathAllowed) {
              var level = arguments.length > 6 && arguments[6] !== void 0 ? arguments[6] : 0;
              try {
                return dehydrate(parent[key], cleaned, unserializable, path, isPathAllowed, level);
              } catch (error) {
                var preview = "";
                if (hydration_typeof(error) === "object" && error !== null && typeof error.stack === "string") {
                  preview = error.stack;
                } else if (typeof error === "string") {
                  preview = error;
                }
                cleaned.push(path);
                return {
                  inspectable: false,
                  preview_short: "[Exception]",
                  preview_long: preview ? "[Exception: " + preview + "]" : "[Exception]",
                  name: preview,
                  type: "unknown"
                };
              }
            }
            __name(dehydrateKey, "dehydrateKey");
            function fillInPath(object, data, path, value) {
              var target = getInObject(object, path);
              if (target != null) {
                if (!target[meta.unserializable]) {
                  delete target[meta.inspectable];
                  delete target[meta.inspected];
                  delete target[meta.name];
                  delete target[meta.preview_long];
                  delete target[meta.preview_short];
                  delete target[meta.readonly];
                  delete target[meta.size];
                  delete target[meta.type];
                }
              }
              if (value !== null && data.unserializable.length > 0) {
                var unserializablePath = data.unserializable[0];
                var isMatch = unserializablePath.length === path.length;
                for (var i = 0; i < path.length; i++) {
                  if (path[i] !== unserializablePath[i]) {
                    isMatch = false;
                    break;
                  }
                }
                if (isMatch) {
                  upgradeUnserializable(value, value);
                }
              }
              setInObject(object, path, value);
            }
            __name(fillInPath, "fillInPath");
            function hydrate(object, cleaned, unserializable) {
              cleaned.forEach(function(path) {
                var length = path.length;
                var last = path[length - 1];
                var parent = getInObject(object, path.slice(0, length - 1));
                if (!parent || !parent.hasOwnProperty(last)) {
                  return;
                }
                var value = parent[last];
                if (!value) {
                  return;
                } else if (value.type === "infinity") {
                  parent[last] = Infinity;
                } else if (value.type === "nan") {
                  parent[last] = NaN;
                } else if (value.type === "undefined") {
                  parent[last] = void 0;
                } else {
                  var replaced = {};
                  replaced[meta.inspectable] = !!value.inspectable;
                  replaced[meta.inspected] = false;
                  replaced[meta.name] = value.name;
                  replaced[meta.preview_long] = value.preview_long;
                  replaced[meta.preview_short] = value.preview_short;
                  replaced[meta.size] = value.size;
                  replaced[meta.readonly] = !!value.readonly;
                  replaced[meta.type] = value.type;
                  parent[last] = replaced;
                }
              });
              unserializable.forEach(function(path) {
                var length = path.length;
                var last = path[length - 1];
                var parent = getInObject(object, path.slice(0, length - 1));
                if (!parent || !parent.hasOwnProperty(last)) {
                  return;
                }
                var node = parent[last];
                var replacement = hydration_objectSpread({}, node);
                upgradeUnserializable(replacement, node);
                parent[last] = replacement;
              });
              return object;
            }
            __name(hydrate, "hydrate");
            function upgradeUnserializable(destination, source) {
              Object.defineProperties(destination, hydration_defineProperty(hydration_defineProperty(hydration_defineProperty(hydration_defineProperty(hydration_defineProperty(hydration_defineProperty(hydration_defineProperty(hydration_defineProperty({}, meta.inspected, {
                configurable: true,
                enumerable: false,
                value: !!source.inspected
              }), meta.name, {
                configurable: true,
                enumerable: false,
                value: source.name
              }), meta.preview_long, {
                configurable: true,
                enumerable: false,
                value: source.preview_long
              }), meta.preview_short, {
                configurable: true,
                enumerable: false,
                value: source.preview_short
              }), meta.size, {
                configurable: true,
                enumerable: false,
                value: source.size
              }), meta.readonly, {
                configurable: true,
                enumerable: false,
                value: !!source.readonly
              }), meta.type, {
                configurable: true,
                enumerable: false,
                value: source.type
              }), meta.unserializable, {
                configurable: true,
                enumerable: false,
                value: !!source.unserializable
              }));
              delete destination.inspected;
              delete destination.name;
              delete destination.preview_long;
              delete destination.preview_short;
              delete destination.size;
              delete destination.readonly;
              delete destination.type;
              delete destination.unserializable;
            }
            __name(upgradeUnserializable, "upgradeUnserializable");
            ;
            var isArrayImpl = Array.isArray;
            function isArray_isArray(a) {
              return isArrayImpl(a);
            }
            __name(isArray_isArray, "isArray_isArray");
            const shared_isArray = isArray_isArray;
            ;
            function backend_utils_typeof(o) {
              "@babel/helpers - typeof";
              return backend_utils_typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                return typeof o2;
              } : function(o2) {
                return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
              }, backend_utils_typeof(o);
            }
            __name(backend_utils_typeof, "backend_utils_typeof");
            function utils_ownKeys(e, r) {
              var t = Object.keys(e);
              if (Object.getOwnPropertySymbols) {
                var o = Object.getOwnPropertySymbols(e);
                r && (o = o.filter(function(r2) {
                  return Object.getOwnPropertyDescriptor(e, r2).enumerable;
                })), t.push.apply(t, o);
              }
              return t;
            }
            __name(utils_ownKeys, "utils_ownKeys");
            function utils_objectSpread(e) {
              for (var r = 1; r < arguments.length; r++) {
                var t = null != arguments[r] ? arguments[r] : {};
                r % 2 ? utils_ownKeys(Object(t), true).forEach(function(r2) {
                  backend_utils_defineProperty(e, r2, t[r2]);
                }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : utils_ownKeys(Object(t)).forEach(function(r2) {
                  Object.defineProperty(e, r2, Object.getOwnPropertyDescriptor(t, r2));
                });
              }
              return e;
            }
            __name(utils_objectSpread, "utils_objectSpread");
            function backend_utils_defineProperty(obj, key, value) {
              key = backend_utils_toPropertyKey(key);
              if (key in obj) {
                Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
              } else {
                obj[key] = value;
              }
              return obj;
            }
            __name(backend_utils_defineProperty, "backend_utils_defineProperty");
            function backend_utils_toPropertyKey(t) {
              var i = backend_utils_toPrimitive(t, "string");
              return "symbol" == backend_utils_typeof(i) ? i : i + "";
            }
            __name(backend_utils_toPropertyKey, "backend_utils_toPropertyKey");
            function backend_utils_toPrimitive(t, r) {
              if ("object" != backend_utils_typeof(t) || !t) return t;
              var e = t[Symbol.toPrimitive];
              if (void 0 !== e) {
                var i = e.call(t, r || "default");
                if ("object" != backend_utils_typeof(i)) return i;
                throw new TypeError("@@toPrimitive must return a primitive value.");
              }
              return ("string" === r ? String : Number)(t);
            }
            __name(backend_utils_toPrimitive, "backend_utils_toPrimitive");
            var FIRST_DEVTOOLS_BACKEND_LOCKSTEP_VER = "999.9.9";
            function hasAssignedBackend(version) {
              if (version == null || version === "") {
                return false;
              }
              return gte(version, FIRST_DEVTOOLS_BACKEND_LOCKSTEP_VER);
            }
            __name(hasAssignedBackend, "hasAssignedBackend");
            function cleanForBridge(data, isPathAllowed) {
              var path = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : [];
              if (data !== null) {
                var cleanedPaths = [];
                var unserializablePaths = [];
                var cleanedData = dehydrate(data, cleanedPaths, unserializablePaths, path, isPathAllowed);
                return {
                  data: cleanedData,
                  cleaned: cleanedPaths,
                  unserializable: unserializablePaths
                };
              } else {
                return null;
              }
            }
            __name(cleanForBridge, "cleanForBridge");
            function copyWithDelete(obj, path) {
              var index = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : 0;
              var key = path[index];
              var updated = shared_isArray(obj) ? obj.slice() : utils_objectSpread({}, obj);
              if (index + 1 === path.length) {
                if (shared_isArray(updated)) {
                  updated.splice(key, 1);
                } else {
                  delete updated[key];
                }
              } else {
                updated[key] = copyWithDelete(obj[key], path, index + 1);
              }
              return updated;
            }
            __name(copyWithDelete, "copyWithDelete");
            function copyWithRename(obj, oldPath, newPath) {
              var index = arguments.length > 3 && arguments[3] !== void 0 ? arguments[3] : 0;
              var oldKey = oldPath[index];
              var updated = shared_isArray(obj) ? obj.slice() : utils_objectSpread({}, obj);
              if (index + 1 === oldPath.length) {
                var newKey = newPath[index];
                updated[newKey] = updated[oldKey];
                if (shared_isArray(updated)) {
                  updated.splice(oldKey, 1);
                } else {
                  delete updated[oldKey];
                }
              } else {
                updated[oldKey] = copyWithRename(obj[oldKey], oldPath, newPath, index + 1);
              }
              return updated;
            }
            __name(copyWithRename, "copyWithRename");
            function copyWithSet(obj, path, value) {
              var index = arguments.length > 3 && arguments[3] !== void 0 ? arguments[3] : 0;
              if (index >= path.length) {
                return value;
              }
              var key = path[index];
              var updated = shared_isArray(obj) ? obj.slice() : utils_objectSpread({}, obj);
              updated[key] = copyWithSet(obj[key], path, value, index + 1);
              return updated;
            }
            __name(copyWithSet, "copyWithSet");
            function getEffectDurations(root) {
              var effectDuration = null;
              var passiveEffectDuration = null;
              var hostRoot = root.current;
              if (hostRoot != null) {
                var stateNode = hostRoot.stateNode;
                if (stateNode != null) {
                  effectDuration = stateNode.effectDuration != null ? stateNode.effectDuration : null;
                  passiveEffectDuration = stateNode.passiveEffectDuration != null ? stateNode.passiveEffectDuration : null;
                }
              }
              return {
                effectDuration,
                passiveEffectDuration
              };
            }
            __name(getEffectDurations, "getEffectDurations");
            function serializeToString(data) {
              if (data === void 0) {
                return "undefined";
              }
              if (typeof data === "function") {
                return data.toString();
              }
              var cache = /* @__PURE__ */ new Set();
              return JSON.stringify(data, function(key, value) {
                if (backend_utils_typeof(value) === "object" && value !== null) {
                  if (cache.has(value)) {
                    return;
                  }
                  cache.add(value);
                }
                if (typeof value === "bigint") {
                  return value.toString() + "n";
                }
                return value;
              }, 2);
            }
            __name(serializeToString, "serializeToString");
            function safeToString(val) {
              try {
                return String(val);
              } catch (err) {
                if (backend_utils_typeof(val) === "object") {
                  return "[object Object]";
                }
                throw err;
              }
            }
            __name(safeToString, "safeToString");
            function formatConsoleArgumentsToSingleString(maybeMessage) {
              for (var _len = arguments.length, inputArgs = new Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
                inputArgs[_key - 1] = arguments[_key];
              }
              var args = inputArgs.slice();
              var formatted = safeToString(maybeMessage);
              if (typeof maybeMessage === "string") {
                if (args.length) {
                  var REGEXP = /(%?)(%([jds]))/g;
                  formatted = formatted.replace(REGEXP, function(match, escaped, ptn, flag) {
                    var arg = args.shift();
                    switch (flag) {
                      case "s":
                        arg += "";
                        break;
                      case "d":
                      case "i":
                        arg = parseInt(arg, 10).toString();
                        break;
                      case "f":
                        arg = parseFloat(arg).toString();
                        break;
                    }
                    if (!escaped) {
                      return arg;
                    }
                    args.unshift(arg);
                    return match;
                  });
                }
              }
              if (args.length) {
                for (var i = 0; i < args.length; i++) {
                  formatted += " " + safeToString(args[i]);
                }
              }
              formatted = formatted.replace(/%{2,2}/g, "%");
              return String(formatted);
            }
            __name(formatConsoleArgumentsToSingleString, "formatConsoleArgumentsToSingleString");
            function isSynchronousXHRSupported() {
              return !!(window.document && window.document.featurePolicy && window.document.featurePolicy.allowsFeature("sync-xhr"));
            }
            __name(isSynchronousXHRSupported, "isSynchronousXHRSupported");
            function gt() {
              var a = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : "";
              var b = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : "";
              return compareVersions(a, b) === 1;
            }
            __name(gt, "gt");
            function gte() {
              var a = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : "";
              var b = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : "";
              return compareVersions(a, b) > -1;
            }
            __name(gte, "gte");
            var isReactNativeEnvironment = /* @__PURE__ */ __name(function isReactNativeEnvironment2() {
              return window.document == null;
            }, "isReactNativeEnvironment");
            function formatDurationToMicrosecondsGranularity(duration) {
              return Math.round(duration * 1e3) / 1e3;
            }
            __name(formatDurationToMicrosecondsGranularity, "formatDurationToMicrosecondsGranularity");
            ;
            function utils_slicedToArray(arr, i) {
              return utils_arrayWithHoles(arr) || utils_iterableToArrayLimit(arr, i) || views_utils_unsupportedIterableToArray(arr, i) || utils_nonIterableRest();
            }
            __name(utils_slicedToArray, "utils_slicedToArray");
            function utils_nonIterableRest() {
              throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
            }
            __name(utils_nonIterableRest, "utils_nonIterableRest");
            function views_utils_unsupportedIterableToArray(o, minLen) {
              if (!o) return;
              if (typeof o === "string") return views_utils_arrayLikeToArray(o, minLen);
              var n = Object.prototype.toString.call(o).slice(8, -1);
              if (n === "Object" && o.constructor) n = o.constructor.name;
              if (n === "Map" || n === "Set") return Array.from(o);
              if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return views_utils_arrayLikeToArray(o, minLen);
            }
            __name(views_utils_unsupportedIterableToArray, "views_utils_unsupportedIterableToArray");
            function views_utils_arrayLikeToArray(arr, len) {
              if (len == null || len > arr.length) len = arr.length;
              for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i];
              return arr2;
            }
            __name(views_utils_arrayLikeToArray, "views_utils_arrayLikeToArray");
            function utils_iterableToArrayLimit(r, l) {
              var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"];
              if (null != t) {
                var e, n, i, u, a = [], f = true, o = false;
                try {
                  if (i = (t = t.call(r)).next, 0 === l) {
                    if (Object(t) !== t) return;
                    f = false;
                  } else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = true) ;
                } catch (r2) {
                  o = true, n = r2;
                } finally {
                  try {
                    if (!f && null != t.return && (u = t.return(), Object(u) !== u)) return;
                  } finally {
                    if (o) throw n;
                  }
                }
                return a;
              }
            }
            __name(utils_iterableToArrayLimit, "utils_iterableToArrayLimit");
            function utils_arrayWithHoles(arr) {
              if (Array.isArray(arr)) return arr;
            }
            __name(utils_arrayWithHoles, "utils_arrayWithHoles");
            function getOwnerWindow(node) {
              if (!node.ownerDocument) {
                return null;
              }
              return node.ownerDocument.defaultView;
            }
            __name(getOwnerWindow, "getOwnerWindow");
            function getOwnerIframe(node) {
              var nodeWindow = getOwnerWindow(node);
              if (nodeWindow) {
                return nodeWindow.frameElement;
              }
              return null;
            }
            __name(getOwnerIframe, "getOwnerIframe");
            function getBoundingClientRectWithBorderOffset(node) {
              var dimensions = getElementDimensions(node);
              return mergeRectOffsets([node.getBoundingClientRect(), {
                top: dimensions.borderTop,
                left: dimensions.borderLeft,
                bottom: dimensions.borderBottom,
                right: dimensions.borderRight,
                width: 0,
                height: 0
              }]);
            }
            __name(getBoundingClientRectWithBorderOffset, "getBoundingClientRectWithBorderOffset");
            function mergeRectOffsets(rects) {
              return rects.reduce(function(previousRect, rect) {
                if (previousRect == null) {
                  return rect;
                }
                return {
                  top: previousRect.top + rect.top,
                  left: previousRect.left + rect.left,
                  width: previousRect.width,
                  height: previousRect.height,
                  bottom: previousRect.bottom + rect.bottom,
                  right: previousRect.right + rect.right
                };
              });
            }
            __name(mergeRectOffsets, "mergeRectOffsets");
            function getNestedBoundingClientRect(node, boundaryWindow) {
              var ownerIframe = getOwnerIframe(node);
              if (ownerIframe && ownerIframe !== boundaryWindow) {
                var rects = [node.getBoundingClientRect()];
                var currentIframe = ownerIframe;
                var onlyOneMore = false;
                while (currentIframe) {
                  var rect = getBoundingClientRectWithBorderOffset(currentIframe);
                  rects.push(rect);
                  currentIframe = getOwnerIframe(currentIframe);
                  if (onlyOneMore) {
                    break;
                  }
                  if (currentIframe && getOwnerWindow(currentIframe) === boundaryWindow) {
                    onlyOneMore = true;
                  }
                }
                return mergeRectOffsets(rects);
              } else {
                return node.getBoundingClientRect();
              }
            }
            __name(getNestedBoundingClientRect, "getNestedBoundingClientRect");
            function getElementDimensions(domElement) {
              var calculatedStyle = window.getComputedStyle(domElement);
              return {
                borderLeft: parseInt(calculatedStyle.borderLeftWidth, 10),
                borderRight: parseInt(calculatedStyle.borderRightWidth, 10),
                borderTop: parseInt(calculatedStyle.borderTopWidth, 10),
                borderBottom: parseInt(calculatedStyle.borderBottomWidth, 10),
                marginLeft: parseInt(calculatedStyle.marginLeft, 10),
                marginRight: parseInt(calculatedStyle.marginRight, 10),
                marginTop: parseInt(calculatedStyle.marginTop, 10),
                marginBottom: parseInt(calculatedStyle.marginBottom, 10),
                paddingLeft: parseInt(calculatedStyle.paddingLeft, 10),
                paddingRight: parseInt(calculatedStyle.paddingRight, 10),
                paddingTop: parseInt(calculatedStyle.paddingTop, 10),
                paddingBottom: parseInt(calculatedStyle.paddingBottom, 10)
              };
            }
            __name(getElementDimensions, "getElementDimensions");
            function extractHOCNames(displayName) {
              if (!displayName) return {
                baseComponentName: "",
                hocNames: []
              };
              var hocRegex = /([A-Z][a-zA-Z0-9]*?)\((.*)\)/g;
              var hocNames = [];
              var baseComponentName = displayName;
              var match;
              while ((match = hocRegex.exec(baseComponentName)) != null) {
                if (Array.isArray(match)) {
                  var _match = match, _match2 = utils_slicedToArray(_match, 3), hocName = _match2[1], inner = _match2[2];
                  hocNames.push(hocName);
                  baseComponentName = inner;
                }
              }
              return {
                baseComponentName,
                hocNames
              };
            }
            __name(extractHOCNames, "extractHOCNames");
            ;
            function Overlay_typeof(o) {
              "@babel/helpers - typeof";
              return Overlay_typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                return typeof o2;
              } : function(o2) {
                return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
              }, Overlay_typeof(o);
            }
            __name(Overlay_typeof, "Overlay_typeof");
            function Overlay_classCallCheck(instance, Constructor) {
              if (!(instance instanceof Constructor)) {
                throw new TypeError("Cannot call a class as a function");
              }
            }
            __name(Overlay_classCallCheck, "Overlay_classCallCheck");
            function Overlay_defineProperties(target, props) {
              for (var i = 0; i < props.length; i++) {
                var descriptor = props[i];
                descriptor.enumerable = descriptor.enumerable || false;
                descriptor.configurable = true;
                if ("value" in descriptor) descriptor.writable = true;
                Object.defineProperty(target, Overlay_toPropertyKey(descriptor.key), descriptor);
              }
            }
            __name(Overlay_defineProperties, "Overlay_defineProperties");
            function Overlay_createClass(Constructor, protoProps, staticProps) {
              if (protoProps) Overlay_defineProperties(Constructor.prototype, protoProps);
              if (staticProps) Overlay_defineProperties(Constructor, staticProps);
              Object.defineProperty(Constructor, "prototype", { writable: false });
              return Constructor;
            }
            __name(Overlay_createClass, "Overlay_createClass");
            function Overlay_toPropertyKey(t) {
              var i = Overlay_toPrimitive(t, "string");
              return "symbol" == Overlay_typeof(i) ? i : i + "";
            }
            __name(Overlay_toPropertyKey, "Overlay_toPropertyKey");
            function Overlay_toPrimitive(t, r) {
              if ("object" != Overlay_typeof(t) || !t) return t;
              var e = t[Symbol.toPrimitive];
              if (void 0 !== e) {
                var i = e.call(t, r || "default");
                if ("object" != Overlay_typeof(i)) return i;
                throw new TypeError("@@toPrimitive must return a primitive value.");
              }
              return ("string" === r ? String : Number)(t);
            }
            __name(Overlay_toPrimitive, "Overlay_toPrimitive");
            var Overlay_assign = Object.assign;
            var OverlayRect = /* @__PURE__ */ function() {
              function OverlayRect2(doc, container) {
                Overlay_classCallCheck(this, OverlayRect2);
                this.node = doc.createElement("div");
                this.border = doc.createElement("div");
                this.padding = doc.createElement("div");
                this.content = doc.createElement("div");
                this.border.style.borderColor = overlayStyles.border;
                this.padding.style.borderColor = overlayStyles.padding;
                this.content.style.backgroundColor = overlayStyles.background;
                Overlay_assign(this.node.style, {
                  borderColor: overlayStyles.margin,
                  pointerEvents: "none",
                  position: "fixed"
                });
                this.node.style.zIndex = "10000000";
                this.node.appendChild(this.border);
                this.border.appendChild(this.padding);
                this.padding.appendChild(this.content);
                container.appendChild(this.node);
              }
              __name(OverlayRect2, "OverlayRect");
              return Overlay_createClass(OverlayRect2, [{
                key: "remove",
                value: /* @__PURE__ */ __name(function remove() {
                  if (this.node.parentNode) {
                    this.node.parentNode.removeChild(this.node);
                  }
                }, "remove")
              }, {
                key: "update",
                value: /* @__PURE__ */ __name(function update(box, dims) {
                  boxWrap(dims, "margin", this.node);
                  boxWrap(dims, "border", this.border);
                  boxWrap(dims, "padding", this.padding);
                  Overlay_assign(this.content.style, {
                    height: box.height - dims.borderTop - dims.borderBottom - dims.paddingTop - dims.paddingBottom + "px",
                    width: box.width - dims.borderLeft - dims.borderRight - dims.paddingLeft - dims.paddingRight + "px"
                  });
                  Overlay_assign(this.node.style, {
                    top: box.top - dims.marginTop + "px",
                    left: box.left - dims.marginLeft + "px"
                  });
                }, "update")
              }]);
            }();
            var OverlayTip = /* @__PURE__ */ function() {
              function OverlayTip2(doc, container) {
                Overlay_classCallCheck(this, OverlayTip2);
                this.tip = doc.createElement("div");
                Overlay_assign(this.tip.style, {
                  display: "flex",
                  flexFlow: "row nowrap",
                  backgroundColor: "#333740",
                  borderRadius: "2px",
                  fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace',
                  fontWeight: "bold",
                  padding: "3px 5px",
                  pointerEvents: "none",
                  position: "fixed",
                  fontSize: "12px",
                  whiteSpace: "nowrap"
                });
                this.nameSpan = doc.createElement("span");
                this.tip.appendChild(this.nameSpan);
                Overlay_assign(this.nameSpan.style, {
                  color: "#ee78e6",
                  borderRight: "1px solid #aaaaaa",
                  paddingRight: "0.5rem",
                  marginRight: "0.5rem"
                });
                this.dimSpan = doc.createElement("span");
                this.tip.appendChild(this.dimSpan);
                Overlay_assign(this.dimSpan.style, {
                  color: "#d7d7d7"
                });
                this.tip.style.zIndex = "10000000";
                container.appendChild(this.tip);
              }
              __name(OverlayTip2, "OverlayTip");
              return Overlay_createClass(OverlayTip2, [{
                key: "remove",
                value: /* @__PURE__ */ __name(function remove() {
                  if (this.tip.parentNode) {
                    this.tip.parentNode.removeChild(this.tip);
                  }
                }, "remove")
              }, {
                key: "updateText",
                value: /* @__PURE__ */ __name(function updateText(name, width, height) {
                  this.nameSpan.textContent = name;
                  this.dimSpan.textContent = Math.round(width) + "px \xD7 " + Math.round(height) + "px";
                }, "updateText")
              }, {
                key: "updatePosition",
                value: /* @__PURE__ */ __name(function updatePosition(dims, bounds) {
                  var tipRect = this.tip.getBoundingClientRect();
                  var tipPos = findTipPos(dims, bounds, {
                    width: tipRect.width,
                    height: tipRect.height
                  });
                  Overlay_assign(this.tip.style, tipPos.style);
                }, "updatePosition")
              }]);
            }();
            var Overlay = /* @__PURE__ */ function() {
              function Overlay2(agent2) {
                Overlay_classCallCheck(this, Overlay2);
                var currentWindow = window.__REACT_DEVTOOLS_TARGET_WINDOW__ || window;
                this.window = currentWindow;
                var tipBoundsWindow = window.__REACT_DEVTOOLS_TARGET_WINDOW__ || window;
                this.tipBoundsWindow = tipBoundsWindow;
                var doc = currentWindow.document;
                this.container = doc.createElement("div");
                this.container.style.zIndex = "10000000";
                this.tip = new OverlayTip(doc, this.container);
                this.rects = [];
                this.agent = agent2;
                doc.body.appendChild(this.container);
              }
              __name(Overlay2, "Overlay");
              return Overlay_createClass(Overlay2, [{
                key: "remove",
                value: /* @__PURE__ */ __name(function remove() {
                  this.tip.remove();
                  this.rects.forEach(function(rect) {
                    rect.remove();
                  });
                  this.rects.length = 0;
                  if (this.container.parentNode) {
                    this.container.parentNode.removeChild(this.container);
                  }
                }, "remove")
              }, {
                key: "inspect",
                value: /* @__PURE__ */ __name(function inspect(nodes, name) {
                  var _this = this;
                  var elements = nodes.filter(function(node2) {
                    return node2.nodeType === Node.ELEMENT_NODE;
                  });
                  while (this.rects.length > elements.length) {
                    var rect = this.rects.pop();
                    rect.remove();
                  }
                  if (elements.length === 0) {
                    return;
                  }
                  while (this.rects.length < elements.length) {
                    this.rects.push(new OverlayRect(this.window.document, this.container));
                  }
                  var outerBox = {
                    top: Number.POSITIVE_INFINITY,
                    right: Number.NEGATIVE_INFINITY,
                    bottom: Number.NEGATIVE_INFINITY,
                    left: Number.POSITIVE_INFINITY
                  };
                  elements.forEach(function(element, index) {
                    var box = getNestedBoundingClientRect(element, _this.window);
                    var dims = getElementDimensions(element);
                    outerBox.top = Math.min(outerBox.top, box.top - dims.marginTop);
                    outerBox.right = Math.max(outerBox.right, box.left + box.width + dims.marginRight);
                    outerBox.bottom = Math.max(outerBox.bottom, box.top + box.height + dims.marginBottom);
                    outerBox.left = Math.min(outerBox.left, box.left - dims.marginLeft);
                    var rect2 = _this.rects[index];
                    rect2.update(box, dims);
                  });
                  if (!name) {
                    name = elements[0].nodeName.toLowerCase();
                    var node = elements[0];
                    var ownerName = this.agent.getComponentNameForHostInstance(node);
                    if (ownerName) {
                      name += " (in " + ownerName + ")";
                    }
                  }
                  this.tip.updateText(name, outerBox.right - outerBox.left, outerBox.bottom - outerBox.top);
                  var tipBounds = getNestedBoundingClientRect(this.tipBoundsWindow.document.documentElement, this.window);
                  this.tip.updatePosition({
                    top: outerBox.top,
                    left: outerBox.left,
                    height: outerBox.bottom - outerBox.top,
                    width: outerBox.right - outerBox.left
                  }, {
                    top: tipBounds.top + this.tipBoundsWindow.scrollY,
                    left: tipBounds.left + this.tipBoundsWindow.scrollX,
                    height: this.tipBoundsWindow.innerHeight,
                    width: this.tipBoundsWindow.innerWidth
                  });
                }, "inspect")
              }]);
            }();
            function findTipPos(dims, bounds, tipSize) {
              var tipHeight = Math.max(tipSize.height, 20);
              var tipWidth = Math.max(tipSize.width, 60);
              var margin = 5;
              var top;
              if (dims.top + dims.height + tipHeight <= bounds.top + bounds.height) {
                if (dims.top + dims.height < bounds.top + 0) {
                  top = bounds.top + margin;
                } else {
                  top = dims.top + dims.height + margin;
                }
              } else if (dims.top - tipHeight <= bounds.top + bounds.height) {
                if (dims.top - tipHeight - margin < bounds.top + margin) {
                  top = bounds.top + margin;
                } else {
                  top = dims.top - tipHeight - margin;
                }
              } else {
                top = bounds.top + bounds.height - tipHeight - margin;
              }
              var left = dims.left + margin;
              if (dims.left < bounds.left) {
                left = bounds.left + margin;
              }
              if (dims.left + tipWidth > bounds.left + bounds.width) {
                left = bounds.left + bounds.width - tipWidth - margin;
              }
              top += "px";
              left += "px";
              return {
                style: {
                  top,
                  left
                }
              };
            }
            __name(findTipPos, "findTipPos");
            function boxWrap(dims, what, node) {
              Overlay_assign(node.style, {
                borderTopWidth: dims[what + "Top"] + "px",
                borderLeftWidth: dims[what + "Left"] + "px",
                borderRightWidth: dims[what + "Right"] + "px",
                borderBottomWidth: dims[what + "Bottom"] + "px",
                borderStyle: "solid"
              });
            }
            __name(boxWrap, "boxWrap");
            var overlayStyles = {
              background: "rgba(120, 170, 210, 0.7)",
              padding: "rgba(77, 200, 0, 0.3)",
              margin: "rgba(255, 155, 0, 0.3)",
              border: "rgba(255, 200, 50, 0.3)"
            };
            ;
            var SHOW_DURATION = 2e3;
            var timeoutID = null;
            var overlay = null;
            function hideOverlayNative(agent2) {
              agent2.emit("hideNativeHighlight");
            }
            __name(hideOverlayNative, "hideOverlayNative");
            function hideOverlayWeb() {
              timeoutID = null;
              if (overlay !== null) {
                overlay.remove();
                overlay = null;
              }
            }
            __name(hideOverlayWeb, "hideOverlayWeb");
            function hideOverlay(agent2) {
              return isReactNativeEnvironment() ? hideOverlayNative(agent2) : hideOverlayWeb();
            }
            __name(hideOverlay, "hideOverlay");
            function showOverlayNative(elements, agent2) {
              agent2.emit("showNativeHighlight", elements);
            }
            __name(showOverlayNative, "showOverlayNative");
            function showOverlayWeb(elements, componentName, agent2, hideAfterTimeout) {
              if (timeoutID !== null) {
                clearTimeout(timeoutID);
              }
              if (overlay === null) {
                overlay = new Overlay(agent2);
              }
              overlay.inspect(elements, componentName);
              if (hideAfterTimeout) {
                timeoutID = setTimeout(function() {
                  return hideOverlay(agent2);
                }, SHOW_DURATION);
              }
            }
            __name(showOverlayWeb, "showOverlayWeb");
            function showOverlay(elements, componentName, agent2, hideAfterTimeout) {
              return isReactNativeEnvironment() ? showOverlayNative(elements, agent2) : showOverlayWeb(elements, componentName, agent2, hideAfterTimeout);
            }
            __name(showOverlay, "showOverlay");
            ;
            var iframesListeningTo = /* @__PURE__ */ new Set();
            var inspectOnlySuspenseNodes = false;
            function setupHighlighter(bridge, agent2) {
              bridge.addListener("clearHostInstanceHighlight", clearHostInstanceHighlight);
              bridge.addListener("highlightHostInstance", highlightHostInstance);
              bridge.addListener("highlightHostInstances", highlightHostInstances);
              bridge.addListener("scrollToHostInstance", scrollToHostInstance);
              bridge.addListener("shutdown", stopInspectingHost);
              bridge.addListener("startInspectingHost", startInspectingHost);
              bridge.addListener("stopInspectingHost", stopInspectingHost);
              function startInspectingHost(onlySuspenseNodes) {
                inspectOnlySuspenseNodes = onlySuspenseNodes;
                registerListenersOnWindow(window);
              }
              __name(startInspectingHost, "startInspectingHost");
              function registerListenersOnWindow(window2) {
                if (window2 && typeof window2.addEventListener === "function") {
                  window2.addEventListener("click", onClick, true);
                  window2.addEventListener("mousedown", onMouseEvent, true);
                  window2.addEventListener("mouseover", onMouseEvent, true);
                  window2.addEventListener("mouseup", onMouseEvent, true);
                  window2.addEventListener("pointerdown", onPointerDown, true);
                  window2.addEventListener("pointermove", onPointerMove, true);
                  window2.addEventListener("pointerup", onPointerUp, true);
                } else {
                  agent2.emit("startInspectingNative");
                }
              }
              __name(registerListenersOnWindow, "registerListenersOnWindow");
              function stopInspectingHost() {
                hideOverlay(agent2);
                removeListenersOnWindow(window);
                iframesListeningTo.forEach(function(frame) {
                  try {
                    removeListenersOnWindow(frame.contentWindow);
                  } catch (error) {
                  }
                });
                iframesListeningTo = /* @__PURE__ */ new Set();
              }
              __name(stopInspectingHost, "stopInspectingHost");
              function removeListenersOnWindow(window2) {
                if (window2 && typeof window2.removeEventListener === "function") {
                  window2.removeEventListener("click", onClick, true);
                  window2.removeEventListener("mousedown", onMouseEvent, true);
                  window2.removeEventListener("mouseover", onMouseEvent, true);
                  window2.removeEventListener("mouseup", onMouseEvent, true);
                  window2.removeEventListener("pointerdown", onPointerDown, true);
                  window2.removeEventListener("pointermove", onPointerMove, true);
                  window2.removeEventListener("pointerup", onPointerUp, true);
                } else {
                  agent2.emit("stopInspectingNative");
                }
              }
              __name(removeListenersOnWindow, "removeListenersOnWindow");
              function clearHostInstanceHighlight() {
                hideOverlay(agent2);
              }
              __name(clearHostInstanceHighlight, "clearHostInstanceHighlight");
              function highlightHostInstance(_ref) {
                var displayName = _ref.displayName, hideAfterTimeout = _ref.hideAfterTimeout, id = _ref.id, openBuiltinElementsPanel = _ref.openBuiltinElementsPanel, rendererID = _ref.rendererID, scrollIntoView = _ref.scrollIntoView;
                var renderer = agent2.rendererInterfaces[rendererID];
                if (renderer == null) {
                  console.warn('Invalid renderer id "'.concat(rendererID, '" for element "').concat(id, '"'));
                  hideOverlay(agent2);
                  return;
                }
                if (!renderer.hasElementWithId(id)) {
                  hideOverlay(agent2);
                  return;
                }
                var nodes = renderer.findHostInstancesForElementID(id);
                if (nodes != null) {
                  for (var i = 0; i < nodes.length; i++) {
                    var node = nodes[i];
                    if (node === null) {
                      continue;
                    }
                    var nodeRects = typeof node.getClientRects === "function" ? node.getClientRects() : [];
                    if (nodeRects.length > 0 && (nodeRects.length > 2 || nodeRects[0].width > 0 || nodeRects[0].height > 0)) {
                      if (scrollIntoView && typeof node.scrollIntoView === "function") {
                        if (scrollDelayTimer) {
                          clearTimeout(scrollDelayTimer);
                          scrollDelayTimer = null;
                        }
                        node.scrollIntoView({
                          block: "nearest",
                          inline: "nearest"
                        });
                      }
                      showOverlay(nodes, displayName, agent2, hideAfterTimeout);
                      if (openBuiltinElementsPanel) {
                        window.__REACT_DEVTOOLS_GLOBAL_HOOK__.$0 = node;
                        bridge.send("syncSelectionToBuiltinElementsPanel");
                      }
                      return;
                    }
                  }
                }
                hideOverlay(agent2);
              }
              __name(highlightHostInstance, "highlightHostInstance");
              function highlightHostInstances(_ref2) {
                var displayName = _ref2.displayName, hideAfterTimeout = _ref2.hideAfterTimeout, elements = _ref2.elements, scrollIntoView = _ref2.scrollIntoView;
                var nodes = [];
                for (var i = 0; i < elements.length; i++) {
                  var _elements$i = elements[i], id = _elements$i.id, rendererID = _elements$i.rendererID;
                  var renderer = agent2.rendererInterfaces[rendererID];
                  if (renderer == null) {
                    console.warn('Invalid renderer id "'.concat(rendererID, '" for element "').concat(id, '"'));
                    continue;
                  }
                  if (!renderer.hasElementWithId(id)) {
                    continue;
                  }
                  var hostInstances = renderer.findHostInstancesForElementID(id);
                  if (hostInstances !== null) {
                    for (var j = 0; j < hostInstances.length; j++) {
                      nodes.push(hostInstances[j]);
                    }
                  }
                }
                if (nodes.length > 0) {
                  var node = nodes[0];
                  if (scrollIntoView && typeof node.scrollIntoView === "function") {
                    node.scrollIntoView({
                      block: "nearest",
                      inline: "nearest"
                    });
                  }
                }
                showOverlay(nodes, displayName, agent2, hideAfterTimeout);
              }
              __name(highlightHostInstances, "highlightHostInstances");
              function attemptScrollToHostInstance(renderer, id) {
                var nodes = renderer.findHostInstancesForElementID(id);
                if (nodes != null) {
                  for (var i = 0; i < nodes.length; i++) {
                    var node = nodes[i];
                    if (node === null) {
                      continue;
                    }
                    var nodeRects = typeof node.getClientRects === "function" ? node.getClientRects() : [];
                    if (nodeRects.length > 0 && (nodeRects.length > 2 || nodeRects[0].width > 0 || nodeRects[0].height > 0)) {
                      if (typeof node.scrollIntoView === "function") {
                        node.scrollIntoView({
                          block: "nearest",
                          inline: "nearest",
                          behavior: "smooth"
                        });
                        return true;
                      }
                    }
                  }
                }
                return false;
              }
              __name(attemptScrollToHostInstance, "attemptScrollToHostInstance");
              var scrollDelayTimer = null;
              function scrollToHostInstance(_ref3) {
                var id = _ref3.id, rendererID = _ref3.rendererID;
                hideOverlay(agent2);
                if (scrollDelayTimer) {
                  clearTimeout(scrollDelayTimer);
                  scrollDelayTimer = null;
                }
                var renderer = agent2.rendererInterfaces[rendererID];
                if (renderer == null) {
                  console.warn('Invalid renderer id "'.concat(rendererID, '" for element "').concat(id, '"'));
                  return;
                }
                if (!renderer.hasElementWithId(id)) {
                  return;
                }
                if (attemptScrollToHostInstance(renderer, id)) {
                  return;
                }
                var rects = renderer.findLastKnownRectsForID(id);
                if (rects !== null && rects.length > 0) {
                  var x = Infinity;
                  var y = Infinity;
                  for (var i = 0; i < rects.length; i++) {
                    var rect = rects[i];
                    if (rect.x < x) {
                      x = rect.x;
                    }
                    if (rect.y < y) {
                      y = rect.y;
                    }
                  }
                  var element = document.documentElement;
                  if (!element) {
                    return;
                  }
                  if (x < window.scrollX || y < window.scrollY || x > window.scrollX + element.clientWidth || y > window.scrollY + element.clientHeight) {
                    window.scrollTo({
                      top: y,
                      left: x,
                      behavior: "smooth"
                    });
                  }
                  scrollDelayTimer = setTimeout(function() {
                    attemptScrollToHostInstance(renderer, id);
                  }, 100);
                }
              }
              __name(scrollToHostInstance, "scrollToHostInstance");
              function onClick(event) {
                event.preventDefault();
                event.stopPropagation();
                stopInspectingHost();
                bridge.send("stopInspectingHost", true);
              }
              __name(onClick, "onClick");
              function onMouseEvent(event) {
                event.preventDefault();
                event.stopPropagation();
              }
              __name(onMouseEvent, "onMouseEvent");
              function onPointerDown(event) {
                event.preventDefault();
                event.stopPropagation();
                selectElementForNode(getEventTarget(event));
              }
              __name(onPointerDown, "onPointerDown");
              var lastHoveredNode = null;
              function onPointerMove(event) {
                event.preventDefault();
                event.stopPropagation();
                var target = getEventTarget(event);
                if (lastHoveredNode === target) return;
                lastHoveredNode = target;
                if (target.tagName === "IFRAME") {
                  var iframe = target;
                  try {
                    if (!iframesListeningTo.has(iframe)) {
                      var _window = iframe.contentWindow;
                      registerListenersOnWindow(_window);
                      iframesListeningTo.add(iframe);
                    }
                  } catch (error) {
                  }
                }
                if (inspectOnlySuspenseNodes) {
                  var match = agent2.getIDForHostInstance(target, inspectOnlySuspenseNodes);
                  if (match !== null) {
                    var renderer = agent2.rendererInterfaces[match.rendererID];
                    if (renderer == null) {
                      console.warn('Invalid renderer id "'.concat(match.rendererID, '" for element "').concat(match.id, '"'));
                      return;
                    }
                    highlightHostInstance({
                      displayName: renderer.getDisplayNameForElementID(match.id),
                      hideAfterTimeout: false,
                      id: match.id,
                      openBuiltinElementsPanel: false,
                      rendererID: match.rendererID,
                      scrollIntoView: false
                    });
                  }
                } else {
                  showOverlay([target], null, agent2, false);
                }
              }
              __name(onPointerMove, "onPointerMove");
              function onPointerUp(event) {
                event.preventDefault();
                event.stopPropagation();
              }
              __name(onPointerUp, "onPointerUp");
              var selectElementForNode = /* @__PURE__ */ __name(function selectElementForNode2(node) {
                var match = agent2.getIDForHostInstance(node, inspectOnlySuspenseNodes);
                if (match !== null) {
                  bridge.send("selectElement", match.id);
                }
              }, "selectElementForNode");
              function getEventTarget(event) {
                if (event.composed) {
                  return event.composedPath()[0];
                }
                return event.target;
              }
              __name(getEventTarget, "getEventTarget");
            }
            __name(setupHighlighter, "setupHighlighter");
            ;
            function canvas_toConsumableArray(arr) {
              return canvas_arrayWithoutHoles(arr) || canvas_iterableToArray(arr) || canvas_unsupportedIterableToArray(arr) || canvas_nonIterableSpread();
            }
            __name(canvas_toConsumableArray, "canvas_toConsumableArray");
            function canvas_nonIterableSpread() {
              throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
            }
            __name(canvas_nonIterableSpread, "canvas_nonIterableSpread");
            function canvas_unsupportedIterableToArray(o, minLen) {
              if (!o) return;
              if (typeof o === "string") return canvas_arrayLikeToArray(o, minLen);
              var n = Object.prototype.toString.call(o).slice(8, -1);
              if (n === "Object" && o.constructor) n = o.constructor.name;
              if (n === "Map" || n === "Set") return Array.from(o);
              if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return canvas_arrayLikeToArray(o, minLen);
            }
            __name(canvas_unsupportedIterableToArray, "canvas_unsupportedIterableToArray");
            function canvas_iterableToArray(iter) {
              if (typeof Symbol !== "undefined" && iter[Symbol.iterator] != null || iter["@@iterator"] != null) return Array.from(iter);
            }
            __name(canvas_iterableToArray, "canvas_iterableToArray");
            function canvas_arrayWithoutHoles(arr) {
              if (Array.isArray(arr)) return canvas_arrayLikeToArray(arr);
            }
            __name(canvas_arrayWithoutHoles, "canvas_arrayWithoutHoles");
            function canvas_arrayLikeToArray(arr, len) {
              if (len == null || len > arr.length) len = arr.length;
              for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i];
              return arr2;
            }
            __name(canvas_arrayLikeToArray, "canvas_arrayLikeToArray");
            var COLORS = ["#37afa9", "#63b19e", "#80b393", "#97b488", "#abb67d", "#beb771", "#cfb965", "#dfba57", "#efbb49", "#febc38"];
            var canvas = null;
            function drawNative(nodeToData2, agent2) {
              var nodesToDraw = [];
              iterateNodes(nodeToData2, function(_ref) {
                var color = _ref.color, node = _ref.node;
                nodesToDraw.push({
                  node,
                  color
                });
              });
              agent2.emit("drawTraceUpdates", nodesToDraw);
              var mergedNodes = groupAndSortNodes(nodeToData2);
              agent2.emit("drawGroupedTraceUpdatesWithNames", mergedNodes);
            }
            __name(drawNative, "drawNative");
            function drawWeb(nodeToData2) {
              if (canvas === null) {
                initialize();
              }
              var dpr = window.devicePixelRatio || 1;
              var canvasFlow = canvas;
              canvasFlow.width = window.innerWidth * dpr;
              canvasFlow.height = window.innerHeight * dpr;
              canvasFlow.style.width = "".concat(window.innerWidth, "px");
              canvasFlow.style.height = "".concat(window.innerHeight, "px");
              var context = canvasFlow.getContext("2d");
              context.scale(dpr, dpr);
              context.clearRect(0, 0, canvasFlow.width / dpr, canvasFlow.height / dpr);
              var mergedNodes = groupAndSortNodes(nodeToData2);
              mergedNodes.forEach(function(group) {
                drawGroupBorders(context, group);
                drawGroupLabel(context, group);
              });
              if (canvas !== null) {
                if (nodeToData2.size === 0 && canvas.matches(":popover-open")) {
                  canvas.hidePopover();
                  return;
                }
                if (canvas.matches(":popover-open")) {
                  canvas.hidePopover();
                }
                canvas.showPopover();
              }
            }
            __name(drawWeb, "drawWeb");
            function groupAndSortNodes(nodeToData2) {
              var positionGroups = /* @__PURE__ */ new Map();
              iterateNodes(nodeToData2, function(_ref2) {
                var _positionGroups$get;
                var rect = _ref2.rect, color = _ref2.color, displayName = _ref2.displayName, count = _ref2.count;
                if (!rect) return;
                var key = "".concat(rect.left, ",").concat(rect.top);
                if (!positionGroups.has(key)) positionGroups.set(key, []);
                (_positionGroups$get = positionGroups.get(key)) === null || _positionGroups$get === void 0 || _positionGroups$get.push({
                  rect,
                  color,
                  displayName,
                  count
                });
              });
              return Array.from(positionGroups.values()).sort(function(groupA, groupB) {
                var maxCountA = Math.max.apply(Math, canvas_toConsumableArray(groupA.map(function(item) {
                  return item.count;
                })));
                var maxCountB = Math.max.apply(Math, canvas_toConsumableArray(groupB.map(function(item) {
                  return item.count;
                })));
                return maxCountA - maxCountB;
              });
            }
            __name(groupAndSortNodes, "groupAndSortNodes");
            function drawGroupBorders(context, group) {
              group.forEach(function(_ref3) {
                var color = _ref3.color, rect = _ref3.rect;
                context.beginPath();
                context.strokeStyle = color;
                context.rect(rect.left, rect.top, rect.width - 1, rect.height - 1);
                context.stroke();
              });
            }
            __name(drawGroupBorders, "drawGroupBorders");
            function drawGroupLabel(context, group) {
              var mergedName = group.map(function(_ref4) {
                var displayName = _ref4.displayName, count = _ref4.count;
                return displayName ? "".concat(displayName).concat(count > 1 ? " x".concat(count) : "") : "";
              }).filter(Boolean).join(", ");
              if (mergedName) {
                drawLabel(context, group[0].rect, mergedName, group[0].color);
              }
            }
            __name(drawGroupLabel, "drawGroupLabel");
            function draw(nodeToData2, agent2) {
              return isReactNativeEnvironment() ? drawNative(nodeToData2, agent2) : drawWeb(nodeToData2);
            }
            __name(draw, "draw");
            function iterateNodes(nodeToData2, execute) {
              nodeToData2.forEach(function(data, node) {
                var colorIndex = Math.min(COLORS.length - 1, data.count - 1);
                var color = COLORS[colorIndex];
                execute({
                  color,
                  node,
                  count: data.count,
                  displayName: data.displayName,
                  expirationTime: data.expirationTime,
                  lastMeasuredAt: data.lastMeasuredAt,
                  rect: data.rect
                });
              });
            }
            __name(iterateNodes, "iterateNodes");
            function drawLabel(context, rect, text, color) {
              var left = rect.left, top = rect.top;
              context.font = "10px monospace";
              context.textBaseline = "middle";
              context.textAlign = "center";
              var padding = 2;
              var textHeight = 14;
              var metrics = context.measureText(text);
              var backgroundWidth = metrics.width + padding * 2;
              var backgroundHeight = textHeight;
              var labelX = left;
              var labelY = top - backgroundHeight;
              context.fillStyle = color;
              context.fillRect(labelX, labelY, backgroundWidth, backgroundHeight);
              context.fillStyle = "#000000";
              context.fillText(text, labelX + backgroundWidth / 2, labelY + backgroundHeight / 2);
            }
            __name(drawLabel, "drawLabel");
            function destroyNative(agent2) {
              agent2.emit("disableTraceUpdates");
            }
            __name(destroyNative, "destroyNative");
            function destroyWeb() {
              if (canvas !== null) {
                if (canvas.matches(":popover-open")) {
                  canvas.hidePopover();
                }
                if (canvas.parentNode != null) {
                  canvas.parentNode.removeChild(canvas);
                }
                canvas = null;
              }
            }
            __name(destroyWeb, "destroyWeb");
            function destroy(agent2) {
              return isReactNativeEnvironment() ? destroyNative(agent2) : destroyWeb();
            }
            __name(destroy, "destroy");
            function initialize() {
              canvas = window.document.createElement("canvas");
              canvas.setAttribute("popover", "manual");
              canvas.style.cssText = "\n    xx-background-color: red;\n    xx-opacity: 0.5;\n    bottom: 0;\n    left: 0;\n    pointer-events: none;\n    position: fixed;\n    right: 0;\n    top: 0;\n    background-color: transparent;\n    outline: none;\n    box-shadow: none;\n    border: none;\n  ";
              var root = window.document.documentElement;
              root.insertBefore(canvas, root.firstChild);
            }
            __name(initialize, "initialize");
            ;
            function TraceUpdates_typeof(o) {
              "@babel/helpers - typeof";
              return TraceUpdates_typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                return typeof o2;
              } : function(o2) {
                return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
              }, TraceUpdates_typeof(o);
            }
            __name(TraceUpdates_typeof, "TraceUpdates_typeof");
            var DISPLAY_DURATION = 250;
            var MAX_DISPLAY_DURATION = 3e3;
            var REMEASUREMENT_AFTER_DURATION = 250;
            var HOC_MARKERS = /* @__PURE__ */ new Map([["Forget", "\u2728"], ["Memo", "\u{1F9E0}"]]);
            var getCurrentTime = (typeof performance === "undefined" ? "undefined" : TraceUpdates_typeof(performance)) === "object" && typeof performance.now === "function" ? function() {
              return performance.now();
            } : function() {
              return Date.now();
            };
            var nodeToData = /* @__PURE__ */ new Map();
            var agent = null;
            var drawAnimationFrameID = null;
            var isEnabled = false;
            var redrawTimeoutID = null;
            function TraceUpdates_initialize(injectedAgent) {
              agent = injectedAgent;
              agent.addListener("traceUpdates", traceUpdates);
            }
            __name(TraceUpdates_initialize, "TraceUpdates_initialize");
            function toggleEnabled(value) {
              isEnabled = value;
              if (!isEnabled) {
                nodeToData.clear();
                if (drawAnimationFrameID !== null) {
                  cancelAnimationFrame(drawAnimationFrameID);
                  drawAnimationFrameID = null;
                }
                if (redrawTimeoutID !== null) {
                  clearTimeout(redrawTimeoutID);
                  redrawTimeoutID = null;
                }
                destroy(agent);
              }
            }
            __name(toggleEnabled, "toggleEnabled");
            function traceUpdates(nodes) {
              if (!isEnabled) return;
              nodes.forEach(function(node) {
                var data = nodeToData.get(node);
                var now = getCurrentTime();
                var lastMeasuredAt = data != null ? data.lastMeasuredAt : 0;
                var rect = data != null ? data.rect : null;
                if (rect === null || lastMeasuredAt + REMEASUREMENT_AFTER_DURATION < now) {
                  lastMeasuredAt = now;
                  rect = measureNode(node);
                }
                var displayName = agent.getComponentNameForHostInstance(node);
                if (displayName) {
                  var _extractHOCNames = extractHOCNames(displayName), baseComponentName = _extractHOCNames.baseComponentName, hocNames = _extractHOCNames.hocNames;
                  var markers = hocNames.map(function(hoc) {
                    return HOC_MARKERS.get(hoc) || "";
                  }).join("");
                  var enhancedDisplayName = markers ? "".concat(markers).concat(baseComponentName) : baseComponentName;
                  displayName = enhancedDisplayName;
                }
                nodeToData.set(node, {
                  count: data != null ? data.count + 1 : 1,
                  expirationTime: data != null ? Math.min(now + MAX_DISPLAY_DURATION, data.expirationTime + DISPLAY_DURATION) : now + DISPLAY_DURATION,
                  lastMeasuredAt,
                  rect,
                  displayName
                });
              });
              if (redrawTimeoutID !== null) {
                clearTimeout(redrawTimeoutID);
                redrawTimeoutID = null;
              }
              if (drawAnimationFrameID === null) {
                drawAnimationFrameID = requestAnimationFrame(prepareToDraw);
              }
            }
            __name(traceUpdates, "traceUpdates");
            function prepareToDraw() {
              drawAnimationFrameID = null;
              redrawTimeoutID = null;
              var now = getCurrentTime();
              var earliestExpiration = Number.MAX_VALUE;
              nodeToData.forEach(function(data, node) {
                if (data.expirationTime < now) {
                  nodeToData.delete(node);
                } else {
                  earliestExpiration = Math.min(earliestExpiration, data.expirationTime);
                }
              });
              draw(nodeToData, agent);
              if (earliestExpiration !== Number.MAX_VALUE) {
                redrawTimeoutID = setTimeout(prepareToDraw, earliestExpiration - now);
              }
            }
            __name(prepareToDraw, "prepareToDraw");
            function measureNode(node) {
              if (!node || typeof node.getBoundingClientRect !== "function") {
                return null;
              }
              var currentWindow = window.__REACT_DEVTOOLS_TARGET_WINDOW__ || window;
              return getNestedBoundingClientRect(node, currentWindow);
            }
            __name(measureNode, "measureNode");
            ;
            function bridge_typeof(o) {
              "@babel/helpers - typeof";
              return bridge_typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                return typeof o2;
              } : function(o2) {
                return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
              }, bridge_typeof(o);
            }
            __name(bridge_typeof, "bridge_typeof");
            function bridge_toConsumableArray(arr) {
              return bridge_arrayWithoutHoles(arr) || bridge_iterableToArray(arr) || bridge_unsupportedIterableToArray(arr) || bridge_nonIterableSpread();
            }
            __name(bridge_toConsumableArray, "bridge_toConsumableArray");
            function bridge_nonIterableSpread() {
              throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
            }
            __name(bridge_nonIterableSpread, "bridge_nonIterableSpread");
            function bridge_unsupportedIterableToArray(o, minLen) {
              if (!o) return;
              if (typeof o === "string") return bridge_arrayLikeToArray(o, minLen);
              var n = Object.prototype.toString.call(o).slice(8, -1);
              if (n === "Object" && o.constructor) n = o.constructor.name;
              if (n === "Map" || n === "Set") return Array.from(o);
              if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return bridge_arrayLikeToArray(o, minLen);
            }
            __name(bridge_unsupportedIterableToArray, "bridge_unsupportedIterableToArray");
            function bridge_iterableToArray(iter) {
              if (typeof Symbol !== "undefined" && iter[Symbol.iterator] != null || iter["@@iterator"] != null) return Array.from(iter);
            }
            __name(bridge_iterableToArray, "bridge_iterableToArray");
            function bridge_arrayWithoutHoles(arr) {
              if (Array.isArray(arr)) return bridge_arrayLikeToArray(arr);
            }
            __name(bridge_arrayWithoutHoles, "bridge_arrayWithoutHoles");
            function bridge_arrayLikeToArray(arr, len) {
              if (len == null || len > arr.length) len = arr.length;
              for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i];
              return arr2;
            }
            __name(bridge_arrayLikeToArray, "bridge_arrayLikeToArray");
            function bridge_classCallCheck(instance, Constructor) {
              if (!(instance instanceof Constructor)) {
                throw new TypeError("Cannot call a class as a function");
              }
            }
            __name(bridge_classCallCheck, "bridge_classCallCheck");
            function bridge_defineProperties(target, props) {
              for (var i = 0; i < props.length; i++) {
                var descriptor = props[i];
                descriptor.enumerable = descriptor.enumerable || false;
                descriptor.configurable = true;
                if ("value" in descriptor) descriptor.writable = true;
                Object.defineProperty(target, bridge_toPropertyKey(descriptor.key), descriptor);
              }
            }
            __name(bridge_defineProperties, "bridge_defineProperties");
            function bridge_createClass(Constructor, protoProps, staticProps) {
              if (protoProps) bridge_defineProperties(Constructor.prototype, protoProps);
              if (staticProps) bridge_defineProperties(Constructor, staticProps);
              Object.defineProperty(Constructor, "prototype", { writable: false });
              return Constructor;
            }
            __name(bridge_createClass, "bridge_createClass");
            function _callSuper(t, o, e) {
              return o = _getPrototypeOf(o), _possibleConstructorReturn(t, _isNativeReflectConstruct() ? Reflect.construct(o, e || [], _getPrototypeOf(t).constructor) : o.apply(t, e));
            }
            __name(_callSuper, "_callSuper");
            function _possibleConstructorReturn(self2, call) {
              if (call && (bridge_typeof(call) === "object" || typeof call === "function")) {
                return call;
              } else if (call !== void 0) {
                throw new TypeError("Derived constructors may only return object or undefined");
              }
              return _assertThisInitialized(self2);
            }
            __name(_possibleConstructorReturn, "_possibleConstructorReturn");
            function _assertThisInitialized(self2) {
              if (self2 === void 0) {
                throw new ReferenceError("this hasn't been initialised - super() hasn't been called");
              }
              return self2;
            }
            __name(_assertThisInitialized, "_assertThisInitialized");
            function _isNativeReflectConstruct() {
              try {
                var t = !Boolean.prototype.valueOf.call(Reflect.construct(Boolean, [], function() {
                }));
              } catch (t2) {
              }
              return (_isNativeReflectConstruct = /* @__PURE__ */ __name(function _isNativeReflectConstruct2() {
                return !!t;
              }, "_isNativeReflectConstruct"))();
            }
            __name(_isNativeReflectConstruct, "_isNativeReflectConstruct");
            function _getPrototypeOf(o) {
              _getPrototypeOf = Object.setPrototypeOf ? Object.getPrototypeOf.bind() : /* @__PURE__ */ __name(function _getPrototypeOf2(o2) {
                return o2.__proto__ || Object.getPrototypeOf(o2);
              }, "_getPrototypeOf");
              return _getPrototypeOf(o);
            }
            __name(_getPrototypeOf, "_getPrototypeOf");
            function _inherits(subClass, superClass) {
              if (typeof superClass !== "function" && superClass !== null) {
                throw new TypeError("Super expression must either be null or a function");
              }
              subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, writable: true, configurable: true } });
              Object.defineProperty(subClass, "prototype", { writable: false });
              if (superClass) _setPrototypeOf(subClass, superClass);
            }
            __name(_inherits, "_inherits");
            function _setPrototypeOf(o, p) {
              _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : /* @__PURE__ */ __name(function _setPrototypeOf2(o2, p2) {
                o2.__proto__ = p2;
                return o2;
              }, "_setPrototypeOf");
              return _setPrototypeOf(o, p);
            }
            __name(_setPrototypeOf, "_setPrototypeOf");
            function bridge_defineProperty(obj, key, value) {
              key = bridge_toPropertyKey(key);
              if (key in obj) {
                Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
              } else {
                obj[key] = value;
              }
              return obj;
            }
            __name(bridge_defineProperty, "bridge_defineProperty");
            function bridge_toPropertyKey(t) {
              var i = bridge_toPrimitive(t, "string");
              return "symbol" == bridge_typeof(i) ? i : i + "";
            }
            __name(bridge_toPropertyKey, "bridge_toPropertyKey");
            function bridge_toPrimitive(t, r) {
              if ("object" != bridge_typeof(t) || !t) return t;
              var e = t[Symbol.toPrimitive];
              if (void 0 !== e) {
                var i = e.call(t, r || "default");
                if ("object" != bridge_typeof(i)) return i;
                throw new TypeError("@@toPrimitive must return a primitive value.");
              }
              return ("string" === r ? String : Number)(t);
            }
            __name(bridge_toPrimitive, "bridge_toPrimitive");
            var BRIDGE_PROTOCOL = [{
              version: 0,
              minNpmVersion: '"<4.11.0"',
              maxNpmVersion: '"<4.11.0"'
            }, {
              version: 1,
              minNpmVersion: "4.13.0",
              maxNpmVersion: "4.21.0"
            }, {
              version: 2,
              minNpmVersion: "4.22.0",
              maxNpmVersion: null
            }];
            var currentBridgeProtocol = BRIDGE_PROTOCOL[BRIDGE_PROTOCOL.length - 1];
            var Bridge = /* @__PURE__ */ function(_EventEmitter) {
              function Bridge2(wall) {
                var _this;
                bridge_classCallCheck(this, Bridge2);
                _this = _callSuper(this, Bridge2);
                bridge_defineProperty(_this, "_isShutdown", false);
                bridge_defineProperty(_this, "_messageQueue", []);
                bridge_defineProperty(_this, "_scheduledFlush", false);
                bridge_defineProperty(_this, "_wallUnlisten", null);
                bridge_defineProperty(_this, "_flush", function() {
                  try {
                    if (_this._messageQueue.length) {
                      for (var i = 0; i < _this._messageQueue.length; i += 2) {
                        var _this$_wall;
                        (_this$_wall = _this._wall).send.apply(_this$_wall, [_this._messageQueue[i]].concat(bridge_toConsumableArray(_this._messageQueue[i + 1])));
                      }
                      _this._messageQueue.length = 0;
                    }
                  } finally {
                    _this._scheduledFlush = false;
                  }
                });
                bridge_defineProperty(_this, "overrideValueAtPath", function(_ref) {
                  var id = _ref.id, path = _ref.path, rendererID = _ref.rendererID, type = _ref.type, value = _ref.value;
                  switch (type) {
                    case "context":
                      _this.send("overrideContext", {
                        id,
                        path,
                        rendererID,
                        wasForwarded: true,
                        value
                      });
                      break;
                    case "hooks":
                      _this.send("overrideHookState", {
                        id,
                        path,
                        rendererID,
                        wasForwarded: true,
                        value
                      });
                      break;
                    case "props":
                      _this.send("overrideProps", {
                        id,
                        path,
                        rendererID,
                        wasForwarded: true,
                        value
                      });
                      break;
                    case "state":
                      _this.send("overrideState", {
                        id,
                        path,
                        rendererID,
                        wasForwarded: true,
                        value
                      });
                      break;
                  }
                });
                _this._wall = wall;
                _this._wallUnlisten = wall.listen(function(message) {
                  if (message && message.event) {
                    _this.emit(message.event, message.payload);
                  }
                }) || null;
                _this.addListener("overrideValueAtPath", _this.overrideValueAtPath);
                return _this;
              }
              __name(Bridge2, "Bridge");
              _inherits(Bridge2, _EventEmitter);
              return bridge_createClass(Bridge2, [{
                key: "wall",
                get: /* @__PURE__ */ __name(function get() {
                  return this._wall;
                }, "get")
              }, {
                key: "send",
                value: /* @__PURE__ */ __name(function send(event) {
                  if (this._isShutdown) {
                    console.warn('Cannot send message "'.concat(event, '" through a Bridge that has been shutdown.'));
                    return;
                  }
                  for (var _len = arguments.length, payload = new Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
                    payload[_key - 1] = arguments[_key];
                  }
                  this._messageQueue.push(event, payload);
                  if (!this._scheduledFlush) {
                    this._scheduledFlush = true;
                    if (typeof devtoolsJestTestScheduler === "function") {
                      devtoolsJestTestScheduler(this._flush);
                    } else {
                      queueMicrotask(this._flush);
                    }
                  }
                }, "send")
              }, {
                key: "shutdown",
                value: /* @__PURE__ */ __name(function shutdown() {
                  if (this._isShutdown) {
                    console.warn("Bridge was already shutdown.");
                    return;
                  }
                  this.emit("shutdown");
                  this.send("shutdown");
                  this._isShutdown = true;
                  this.addListener = function() {
                  };
                  this.emit = function() {
                  };
                  this.removeAllListeners();
                  var wallUnlisten = this._wallUnlisten;
                  if (wallUnlisten) {
                    wallUnlisten();
                  }
                  do {
                    this._flush();
                  } while (this._messageQueue.length);
                }, "shutdown")
              }]);
            }(EventEmitter);
            const src_bridge = Bridge;
            ;
            function storage_localStorageGetItem(key) {
              try {
                return localStorage.getItem(key);
              } catch (error) {
                return null;
              }
            }
            __name(storage_localStorageGetItem, "storage_localStorageGetItem");
            function localStorageRemoveItem(key) {
              try {
                localStorage.removeItem(key);
              } catch (error) {
              }
            }
            __name(localStorageRemoveItem, "localStorageRemoveItem");
            function storage_localStorageSetItem(key, value) {
              try {
                return localStorage.setItem(key, value);
              } catch (error) {
              }
            }
            __name(storage_localStorageSetItem, "storage_localStorageSetItem");
            function storage_sessionStorageGetItem(key) {
              try {
                return sessionStorage.getItem(key);
              } catch (error) {
                return null;
              }
            }
            __name(storage_sessionStorageGetItem, "storage_sessionStorageGetItem");
            function storage_sessionStorageRemoveItem(key) {
              try {
                sessionStorage.removeItem(key);
              } catch (error) {
              }
            }
            __name(storage_sessionStorageRemoveItem, "storage_sessionStorageRemoveItem");
            function storage_sessionStorageSetItem(key, value) {
              try {
                return sessionStorage.setItem(key, value);
              } catch (error) {
              }
            }
            __name(storage_sessionStorageSetItem, "storage_sessionStorageSetItem");
            ;
            function agent_typeof(o) {
              "@babel/helpers - typeof";
              return agent_typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                return typeof o2;
              } : function(o2) {
                return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
              }, agent_typeof(o);
            }
            __name(agent_typeof, "agent_typeof");
            function agent_classCallCheck(instance, Constructor) {
              if (!(instance instanceof Constructor)) {
                throw new TypeError("Cannot call a class as a function");
              }
            }
            __name(agent_classCallCheck, "agent_classCallCheck");
            function agent_defineProperties(target, props) {
              for (var i = 0; i < props.length; i++) {
                var descriptor = props[i];
                descriptor.enumerable = descriptor.enumerable || false;
                descriptor.configurable = true;
                if ("value" in descriptor) descriptor.writable = true;
                Object.defineProperty(target, agent_toPropertyKey(descriptor.key), descriptor);
              }
            }
            __name(agent_defineProperties, "agent_defineProperties");
            function agent_createClass(Constructor, protoProps, staticProps) {
              if (protoProps) agent_defineProperties(Constructor.prototype, protoProps);
              if (staticProps) agent_defineProperties(Constructor, staticProps);
              Object.defineProperty(Constructor, "prototype", { writable: false });
              return Constructor;
            }
            __name(agent_createClass, "agent_createClass");
            function agent_callSuper(t, o, e) {
              return o = agent_getPrototypeOf(o), agent_possibleConstructorReturn(t, agent_isNativeReflectConstruct() ? Reflect.construct(o, e || [], agent_getPrototypeOf(t).constructor) : o.apply(t, e));
            }
            __name(agent_callSuper, "agent_callSuper");
            function agent_possibleConstructorReturn(self2, call) {
              if (call && (agent_typeof(call) === "object" || typeof call === "function")) {
                return call;
              } else if (call !== void 0) {
                throw new TypeError("Derived constructors may only return object or undefined");
              }
              return agent_assertThisInitialized(self2);
            }
            __name(agent_possibleConstructorReturn, "agent_possibleConstructorReturn");
            function agent_assertThisInitialized(self2) {
              if (self2 === void 0) {
                throw new ReferenceError("this hasn't been initialised - super() hasn't been called");
              }
              return self2;
            }
            __name(agent_assertThisInitialized, "agent_assertThisInitialized");
            function agent_isNativeReflectConstruct() {
              try {
                var t = !Boolean.prototype.valueOf.call(Reflect.construct(Boolean, [], function() {
                }));
              } catch (t2) {
              }
              return (agent_isNativeReflectConstruct = /* @__PURE__ */ __name(function _isNativeReflectConstruct2() {
                return !!t;
              }, "_isNativeReflectConstruct"))();
            }
            __name(agent_isNativeReflectConstruct, "agent_isNativeReflectConstruct");
            function agent_getPrototypeOf(o) {
              agent_getPrototypeOf = Object.setPrototypeOf ? Object.getPrototypeOf.bind() : /* @__PURE__ */ __name(function _getPrototypeOf2(o2) {
                return o2.__proto__ || Object.getPrototypeOf(o2);
              }, "_getPrototypeOf");
              return agent_getPrototypeOf(o);
            }
            __name(agent_getPrototypeOf, "agent_getPrototypeOf");
            function agent_inherits(subClass, superClass) {
              if (typeof superClass !== "function" && superClass !== null) {
                throw new TypeError("Super expression must either be null or a function");
              }
              subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, writable: true, configurable: true } });
              Object.defineProperty(subClass, "prototype", { writable: false });
              if (superClass) agent_setPrototypeOf(subClass, superClass);
            }
            __name(agent_inherits, "agent_inherits");
            function agent_setPrototypeOf(o, p) {
              agent_setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : /* @__PURE__ */ __name(function _setPrototypeOf2(o2, p2) {
                o2.__proto__ = p2;
                return o2;
              }, "_setPrototypeOf");
              return agent_setPrototypeOf(o, p);
            }
            __name(agent_setPrototypeOf, "agent_setPrototypeOf");
            function agent_defineProperty(obj, key, value) {
              key = agent_toPropertyKey(key);
              if (key in obj) {
                Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
              } else {
                obj[key] = value;
              }
              return obj;
            }
            __name(agent_defineProperty, "agent_defineProperty");
            function agent_toPropertyKey(t) {
              var i = agent_toPrimitive(t, "string");
              return "symbol" == agent_typeof(i) ? i : i + "";
            }
            __name(agent_toPropertyKey, "agent_toPropertyKey");
            function agent_toPrimitive(t, r) {
              if ("object" != agent_typeof(t) || !t) return t;
              var e = t[Symbol.toPrimitive];
              if (void 0 !== e) {
                var i = e.call(t, r || "default");
                if ("object" != agent_typeof(i)) return i;
                throw new TypeError("@@toPrimitive must return a primitive value.");
              }
              return ("string" === r ? String : Number)(t);
            }
            __name(agent_toPrimitive, "agent_toPrimitive");
            var debug = /* @__PURE__ */ __name(function debug2(methodName) {
              if (__DEBUG__) {
                var _console;
                for (var _len = arguments.length, args = new Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
                  args[_key - 1] = arguments[_key];
                }
                (_console = console).log.apply(_console, ["%cAgent %c".concat(methodName), "color: purple; font-weight: bold;", "font-weight: bold;"].concat(args));
              }
            }, "debug");
            function createEmptyInspectedScreen(arbitraryRootID, type) {
              var suspendedBy = {
                cleaned: [],
                data: [],
                unserializable: []
              };
              return {
                id: arbitraryRootID,
                type,
                isErrored: false,
                errors: [],
                warnings: [],
                suspendedBy,
                suspendedByRange: null,
                unknownSuspenders: UNKNOWN_SUSPENDERS_NONE,
                rootType: null,
                plugins: {
                  stylex: null
                },
                nativeTag: null,
                env: null,
                source: null,
                stack: null,
                rendererPackageName: null,
                rendererVersion: null,
                key: null,
                canEditFunctionProps: false,
                canEditHooks: false,
                canEditFunctionPropsDeletePaths: false,
                canEditFunctionPropsRenamePaths: false,
                canEditHooksAndDeletePaths: false,
                canEditHooksAndRenamePaths: false,
                canToggleError: false,
                canToggleSuspense: false,
                isSuspended: false,
                hasLegacyContext: false,
                context: null,
                hooks: null,
                props: null,
                state: null,
                owners: null
              };
            }
            __name(createEmptyInspectedScreen, "createEmptyInspectedScreen");
            function mergeRoots(left, right, suspendedByOffset) {
              var leftSuspendedByRange = left.suspendedByRange;
              var rightSuspendedByRange = right.suspendedByRange;
              if (right.isErrored) {
                left.isErrored = true;
              }
              for (var i = 0; i < right.errors.length; i++) {
                left.errors.push(right.errors[i]);
              }
              for (var _i = 0; _i < right.warnings.length; _i++) {
                left.warnings.push(right.warnings[_i]);
              }
              var leftSuspendedBy = left.suspendedBy;
              var _ref = right.suspendedBy, data = _ref.data, cleaned = _ref.cleaned, unserializable = _ref.unserializable;
              var leftSuspendedByData = leftSuspendedBy.data;
              var rightSuspendedByData = data;
              for (var _i2 = 0; _i2 < rightSuspendedByData.length; _i2++) {
                leftSuspendedByData.push(rightSuspendedByData[_i2]);
              }
              for (var _i3 = 0; _i3 < cleaned.length; _i3++) {
                leftSuspendedBy.cleaned.push([suspendedByOffset + cleaned[_i3][0]].concat(cleaned[_i3].slice(1)));
              }
              for (var _i4 = 0; _i4 < unserializable.length; _i4++) {
                leftSuspendedBy.unserializable.push([suspendedByOffset + unserializable[_i4][0]].concat(unserializable[_i4].slice(1)));
              }
              if (rightSuspendedByRange !== null) {
                if (leftSuspendedByRange === null) {
                  left.suspendedByRange = [rightSuspendedByRange[0], rightSuspendedByRange[1]];
                } else {
                  if (rightSuspendedByRange[0] < leftSuspendedByRange[0]) {
                    leftSuspendedByRange[0] = rightSuspendedByRange[0];
                  }
                  if (rightSuspendedByRange[1] > leftSuspendedByRange[1]) {
                    leftSuspendedByRange[1] = rightSuspendedByRange[1];
                  }
                }
              }
            }
            __name(mergeRoots, "mergeRoots");
            var Agent = /* @__PURE__ */ function(_EventEmitter) {
              function Agent2(bridge) {
                var _this;
                var isProfiling = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : false;
                var onReloadAndProfile2 = arguments.length > 2 ? arguments[2] : void 0;
                agent_classCallCheck(this, Agent2);
                _this = agent_callSuper(this, Agent2);
                agent_defineProperty(_this, "_isProfiling", false);
                agent_defineProperty(_this, "_rendererInterfaces", {});
                agent_defineProperty(_this, "_persistedSelection", null);
                agent_defineProperty(_this, "_persistedSelectionMatch", null);
                agent_defineProperty(_this, "_traceUpdatesEnabled", false);
                agent_defineProperty(_this, "clearErrorsAndWarnings", function(_ref2) {
                  var rendererID = _ref2.rendererID;
                  var renderer = _this._rendererInterfaces[rendererID];
                  if (renderer == null) {
                    console.warn('Invalid renderer id "'.concat(rendererID, '"'));
                  } else {
                    renderer.clearErrorsAndWarnings();
                  }
                });
                agent_defineProperty(_this, "clearErrorsForElementID", function(_ref3) {
                  var id = _ref3.id, rendererID = _ref3.rendererID;
                  var renderer = _this._rendererInterfaces[rendererID];
                  if (renderer == null) {
                    console.warn('Invalid renderer id "'.concat(rendererID, '"'));
                  } else {
                    renderer.clearErrorsForElementID(id);
                  }
                });
                agent_defineProperty(_this, "clearWarningsForElementID", function(_ref4) {
                  var id = _ref4.id, rendererID = _ref4.rendererID;
                  var renderer = _this._rendererInterfaces[rendererID];
                  if (renderer == null) {
                    console.warn('Invalid renderer id "'.concat(rendererID, '"'));
                  } else {
                    renderer.clearWarningsForElementID(id);
                  }
                });
                agent_defineProperty(_this, "copyElementPath", function(_ref5) {
                  var id = _ref5.id, path = _ref5.path, rendererID = _ref5.rendererID;
                  var renderer = _this._rendererInterfaces[rendererID];
                  if (renderer == null) {
                    console.warn('Invalid renderer id "'.concat(rendererID, '" for element "').concat(id, '"'));
                  } else {
                    var value = renderer.getSerializedElementValueByPath(id, path);
                    if (value != null) {
                      _this._bridge.send("saveToClipboard", value);
                    } else {
                      console.warn('Unable to obtain serialized value for element "'.concat(id, '"'));
                    }
                  }
                });
                agent_defineProperty(_this, "deletePath", function(_ref6) {
                  var hookID = _ref6.hookID, id = _ref6.id, path = _ref6.path, rendererID = _ref6.rendererID, type = _ref6.type;
                  var renderer = _this._rendererInterfaces[rendererID];
                  if (renderer == null) {
                    console.warn('Invalid renderer id "'.concat(rendererID, '" for element "').concat(id, '"'));
                  } else {
                    renderer.deletePath(type, id, hookID, path);
                  }
                });
                agent_defineProperty(_this, "getBackendVersion", function() {
                  var version = "7.0.1-3cde211b0c";
                  if (version) {
                    _this._bridge.send("backendVersion", version);
                  }
                });
                agent_defineProperty(_this, "getBridgeProtocol", function() {
                  _this._bridge.send("bridgeProtocol", currentBridgeProtocol);
                });
                agent_defineProperty(_this, "getProfilingData", function(_ref7) {
                  var rendererID = _ref7.rendererID;
                  var renderer = _this._rendererInterfaces[rendererID];
                  if (renderer == null) {
                    console.warn('Invalid renderer id "'.concat(rendererID, '"'));
                  }
                  _this._bridge.send("profilingData", renderer.getProfilingData());
                });
                agent_defineProperty(_this, "getProfilingStatus", function() {
                  _this._bridge.send("profilingStatus", _this._isProfiling);
                });
                agent_defineProperty(_this, "getOwnersList", function(_ref8) {
                  var id = _ref8.id, rendererID = _ref8.rendererID;
                  var renderer = _this._rendererInterfaces[rendererID];
                  if (renderer == null) {
                    console.warn('Invalid renderer id "'.concat(rendererID, '" for element "').concat(id, '"'));
                  } else {
                    var owners = renderer.getOwnersList(id);
                    _this._bridge.send("ownersList", {
                      id,
                      owners
                    });
                  }
                });
                agent_defineProperty(_this, "inspectElement", function(_ref9) {
                  var forceFullData = _ref9.forceFullData, id = _ref9.id, path = _ref9.path, rendererID = _ref9.rendererID, requestID = _ref9.requestID;
                  var renderer = _this._rendererInterfaces[rendererID];
                  if (renderer == null) {
                    console.warn('Invalid renderer id "'.concat(rendererID, '" for element "').concat(id, '"'));
                  } else {
                    _this._bridge.send("inspectedElement", renderer.inspectElement(requestID, id, path, forceFullData));
                    if (_this._persistedSelectionMatch === null || _this._persistedSelectionMatch.id !== id) {
                      _this._persistedSelection = null;
                      _this._persistedSelectionMatch = null;
                      renderer.setTrackedPath(null);
                      _this._lastSelectedElementID = id;
                      _this._lastSelectedRendererID = rendererID;
                      if (!_this._persistSelectionTimerScheduled) {
                        _this._persistSelectionTimerScheduled = true;
                        setTimeout(_this._persistSelection, 1e3);
                      }
                    }
                  }
                });
                agent_defineProperty(_this, "inspectScreen", function(_ref10) {
                  var requestID = _ref10.requestID, id = _ref10.id, forceFullData = _ref10.forceFullData, screenPath = _ref10.path;
                  var inspectedScreen = null;
                  var found = false;
                  var suspendedByOffset = 0;
                  var suspendedByPathIndex = null;
                  var rendererPath = null;
                  if (screenPath !== null && screenPath.length > 1) {
                    var secondaryCategory = screenPath[0];
                    if (secondaryCategory !== "suspendedBy") {
                      throw new Error("Only hydrating suspendedBy paths is supported. This is a bug.");
                    }
                    if (typeof screenPath[1] !== "number") {
                      throw new Error("Expected suspendedBy index to be a number. Received '".concat(screenPath[1], "' instead. This is a bug."));
                    }
                    suspendedByPathIndex = screenPath[1];
                    rendererPath = screenPath.slice(2);
                  }
                  for (var rendererID in _this._rendererInterfaces) {
                    var renderer = _this._rendererInterfaces[rendererID];
                    var path = null;
                    if (suspendedByPathIndex !== null && rendererPath !== null) {
                      var suspendedByPathRendererIndex = suspendedByPathIndex - suspendedByOffset;
                      var rendererHasRequestedSuspendedByPath = renderer.getElementAttributeByPath(id, ["suspendedBy", suspendedByPathRendererIndex]) !== void 0;
                      if (rendererHasRequestedSuspendedByPath) {
                        path = ["suspendedBy", suspendedByPathRendererIndex].concat(rendererPath);
                      }
                    }
                    var inspectedRootsPayload = renderer.inspectElement(requestID, id, path, forceFullData);
                    switch (inspectedRootsPayload.type) {
                      case "hydrated-path":
                        inspectedRootsPayload.path[1] += suspendedByOffset;
                        if (inspectedRootsPayload.value !== null) {
                          for (var i = 0; i < inspectedRootsPayload.value.cleaned.length; i++) {
                            inspectedRootsPayload.value.cleaned[i][1] += suspendedByOffset;
                          }
                        }
                        _this._bridge.send("inspectedScreen", inspectedRootsPayload);
                        return;
                      case "full-data":
                        var inspectedRoots = inspectedRootsPayload.value;
                        if (inspectedScreen === null) {
                          inspectedScreen = createEmptyInspectedScreen(inspectedRoots.id, inspectedRoots.type);
                        }
                        mergeRoots(inspectedScreen, inspectedRoots, suspendedByOffset);
                        var dehydratedSuspendedBy = inspectedRoots.suspendedBy;
                        var suspendedBy = dehydratedSuspendedBy.data;
                        suspendedByOffset += suspendedBy.length;
                        found = true;
                        break;
                      case "no-change":
                        found = true;
                        var rootsSuspendedBy = renderer.getElementAttributeByPath(id, ["suspendedBy"]);
                        suspendedByOffset += rootsSuspendedBy.length;
                        break;
                      case "not-found":
                        break;
                      case "error":
                        _this._bridge.send("inspectedScreen", inspectedRootsPayload);
                        return;
                    }
                  }
                  if (inspectedScreen === null) {
                    if (found) {
                      _this._bridge.send("inspectedScreen", {
                        type: "no-change",
                        responseID: requestID,
                        id
                      });
                    } else {
                      _this._bridge.send("inspectedScreen", {
                        type: "not-found",
                        responseID: requestID,
                        id
                      });
                    }
                  } else {
                    _this._bridge.send("inspectedScreen", {
                      type: "full-data",
                      responseID: requestID,
                      id,
                      value: inspectedScreen
                    });
                  }
                });
                agent_defineProperty(_this, "logElementToConsole", function(_ref11) {
                  var id = _ref11.id, rendererID = _ref11.rendererID;
                  var renderer = _this._rendererInterfaces[rendererID];
                  if (renderer == null) {
                    console.warn('Invalid renderer id "'.concat(rendererID, '" for element "').concat(id, '"'));
                  } else {
                    renderer.logElementToConsole(id);
                  }
                });
                agent_defineProperty(_this, "overrideError", function(_ref12) {
                  var id = _ref12.id, rendererID = _ref12.rendererID, forceError = _ref12.forceError;
                  var renderer = _this._rendererInterfaces[rendererID];
                  if (renderer == null) {
                    console.warn('Invalid renderer id "'.concat(rendererID, '" for element "').concat(id, '"'));
                  } else {
                    renderer.overrideError(id, forceError);
                  }
                });
                agent_defineProperty(_this, "overrideSuspense", function(_ref13) {
                  var id = _ref13.id, rendererID = _ref13.rendererID, forceFallback = _ref13.forceFallback;
                  var renderer = _this._rendererInterfaces[rendererID];
                  if (renderer == null) {
                    console.warn('Invalid renderer id "'.concat(rendererID, '" for element "').concat(id, '"'));
                  } else {
                    renderer.overrideSuspense(id, forceFallback);
                  }
                });
                agent_defineProperty(_this, "overrideSuspenseMilestone", function(_ref14) {
                  var suspendedSet = _ref14.suspendedSet;
                  for (var rendererID in _this._rendererInterfaces) {
                    var renderer = _this._rendererInterfaces[rendererID];
                    if (renderer.supportsTogglingSuspense) {
                      renderer.overrideSuspenseMilestone(suspendedSet);
                    }
                  }
                });
                agent_defineProperty(_this, "overrideValueAtPath", function(_ref15) {
                  var hookID = _ref15.hookID, id = _ref15.id, path = _ref15.path, rendererID = _ref15.rendererID, type = _ref15.type, value = _ref15.value;
                  var renderer = _this._rendererInterfaces[rendererID];
                  if (renderer == null) {
                    console.warn('Invalid renderer id "'.concat(rendererID, '" for element "').concat(id, '"'));
                  } else {
                    renderer.overrideValueAtPath(type, id, hookID, path, value);
                  }
                });
                agent_defineProperty(_this, "overrideContext", function(_ref16) {
                  var id = _ref16.id, path = _ref16.path, rendererID = _ref16.rendererID, wasForwarded = _ref16.wasForwarded, value = _ref16.value;
                  if (!wasForwarded) {
                    _this.overrideValueAtPath({
                      id,
                      path,
                      rendererID,
                      type: "context",
                      value
                    });
                  }
                });
                agent_defineProperty(_this, "overrideHookState", function(_ref17) {
                  var id = _ref17.id, hookID = _ref17.hookID, path = _ref17.path, rendererID = _ref17.rendererID, wasForwarded = _ref17.wasForwarded, value = _ref17.value;
                  if (!wasForwarded) {
                    _this.overrideValueAtPath({
                      id,
                      path,
                      rendererID,
                      type: "hooks",
                      value
                    });
                  }
                });
                agent_defineProperty(_this, "overrideProps", function(_ref18) {
                  var id = _ref18.id, path = _ref18.path, rendererID = _ref18.rendererID, wasForwarded = _ref18.wasForwarded, value = _ref18.value;
                  if (!wasForwarded) {
                    _this.overrideValueAtPath({
                      id,
                      path,
                      rendererID,
                      type: "props",
                      value
                    });
                  }
                });
                agent_defineProperty(_this, "overrideState", function(_ref19) {
                  var id = _ref19.id, path = _ref19.path, rendererID = _ref19.rendererID, wasForwarded = _ref19.wasForwarded, value = _ref19.value;
                  if (!wasForwarded) {
                    _this.overrideValueAtPath({
                      id,
                      path,
                      rendererID,
                      type: "state",
                      value
                    });
                  }
                });
                agent_defineProperty(_this, "onReloadAndProfileSupportedByHost", function() {
                  _this._bridge.send("isReloadAndProfileSupportedByBackend", true);
                });
                agent_defineProperty(_this, "reloadAndProfile", function(_ref20) {
                  var recordChangeDescriptions = _ref20.recordChangeDescriptions, recordTimeline = _ref20.recordTimeline;
                  if (typeof _this._onReloadAndProfile === "function") {
                    _this._onReloadAndProfile(recordChangeDescriptions, recordTimeline);
                  }
                  _this._bridge.send("reloadAppForProfiling");
                });
                agent_defineProperty(_this, "renamePath", function(_ref21) {
                  var hookID = _ref21.hookID, id = _ref21.id, newPath = _ref21.newPath, oldPath = _ref21.oldPath, rendererID = _ref21.rendererID, type = _ref21.type;
                  var renderer = _this._rendererInterfaces[rendererID];
                  if (renderer == null) {
                    console.warn('Invalid renderer id "'.concat(rendererID, '" for element "').concat(id, '"'));
                  } else {
                    renderer.renamePath(type, id, hookID, oldPath, newPath);
                  }
                });
                agent_defineProperty(_this, "setTraceUpdatesEnabled", function(traceUpdatesEnabled) {
                  _this._traceUpdatesEnabled = traceUpdatesEnabled;
                  toggleEnabled(traceUpdatesEnabled);
                  for (var rendererID in _this._rendererInterfaces) {
                    var renderer = _this._rendererInterfaces[rendererID];
                    renderer.setTraceUpdatesEnabled(traceUpdatesEnabled);
                  }
                });
                agent_defineProperty(_this, "syncSelectionFromBuiltinElementsPanel", function() {
                  var target = window.__REACT_DEVTOOLS_GLOBAL_HOOK__.$0;
                  if (target == null) {
                    return;
                  }
                  _this.selectNode(target);
                });
                agent_defineProperty(_this, "shutdown", function() {
                  _this.emit("shutdown");
                  _this._bridge.removeAllListeners();
                  _this.removeAllListeners();
                });
                agent_defineProperty(_this, "startProfiling", function(_ref22) {
                  var recordChangeDescriptions = _ref22.recordChangeDescriptions, recordTimeline = _ref22.recordTimeline;
                  _this._isProfiling = true;
                  for (var rendererID in _this._rendererInterfaces) {
                    var renderer = _this._rendererInterfaces[rendererID];
                    renderer.startProfiling(recordChangeDescriptions, recordTimeline);
                  }
                  _this._bridge.send("profilingStatus", _this._isProfiling);
                });
                agent_defineProperty(_this, "stopProfiling", function() {
                  _this._isProfiling = false;
                  for (var rendererID in _this._rendererInterfaces) {
                    var renderer = _this._rendererInterfaces[rendererID];
                    renderer.stopProfiling();
                  }
                  _this._bridge.send("profilingStatus", _this._isProfiling);
                });
                agent_defineProperty(_this, "stopInspectingNative", function(selected) {
                  _this._bridge.send("stopInspectingHost", selected);
                });
                agent_defineProperty(_this, "storeAsGlobal", function(_ref23) {
                  var count = _ref23.count, id = _ref23.id, path = _ref23.path, rendererID = _ref23.rendererID;
                  var renderer = _this._rendererInterfaces[rendererID];
                  if (renderer == null) {
                    console.warn('Invalid renderer id "'.concat(rendererID, '" for element "').concat(id, '"'));
                  } else {
                    renderer.storeAsGlobal(id, path, count);
                  }
                });
                agent_defineProperty(_this, "updateHookSettings", function(settings) {
                  _this.emit("updateHookSettings", settings);
                });
                agent_defineProperty(_this, "getHookSettings", function() {
                  _this.emit("getHookSettings");
                });
                agent_defineProperty(_this, "onHookSettings", function(settings) {
                  _this._bridge.send("hookSettings", settings);
                });
                agent_defineProperty(_this, "updateComponentFilters", function(componentFilters) {
                  for (var rendererIDString in _this._rendererInterfaces) {
                    var rendererID = +rendererIDString;
                    var renderer = _this._rendererInterfaces[rendererID];
                    if (_this._lastSelectedRendererID === rendererID) {
                      var path = renderer.getPathForElement(_this._lastSelectedElementID);
                      if (path !== null) {
                        renderer.setTrackedPath(path);
                        _this._persistedSelection = {
                          rendererID,
                          path
                        };
                      }
                    }
                    renderer.updateComponentFilters(componentFilters);
                  }
                });
                agent_defineProperty(_this, "getEnvironmentNames", function() {
                  var accumulatedNames = null;
                  for (var rendererID in _this._rendererInterfaces) {
                    var renderer = _this._rendererInterfaces[+rendererID];
                    var names = renderer.getEnvironmentNames();
                    if (accumulatedNames === null) {
                      accumulatedNames = names;
                    } else {
                      for (var i = 0; i < names.length; i++) {
                        if (accumulatedNames.indexOf(names[i]) === -1) {
                          accumulatedNames.push(names[i]);
                        }
                      }
                    }
                  }
                  _this._bridge.send("environmentNames", accumulatedNames || []);
                });
                agent_defineProperty(_this, "onTraceUpdates", function(nodes) {
                  _this.emit("traceUpdates", nodes);
                });
                agent_defineProperty(_this, "onFastRefreshScheduled", function() {
                  if (__DEBUG__) {
                    debug("onFastRefreshScheduled");
                  }
                  _this._bridge.send("fastRefreshScheduled");
                });
                agent_defineProperty(_this, "onHookOperations", function(operations) {
                  if (__DEBUG__) {
                    debug("onHookOperations", "(".concat(operations.length, ") [").concat(operations.join(", "), "]"));
                  }
                  _this._bridge.send("operations", operations);
                  if (_this._persistedSelection !== null) {
                    var rendererID = operations[0];
                    if (_this._persistedSelection.rendererID === rendererID) {
                      var renderer = _this._rendererInterfaces[rendererID];
                      if (renderer == null) {
                        console.warn('Invalid renderer id "'.concat(rendererID, '"'));
                      } else {
                        var prevMatch = _this._persistedSelectionMatch;
                        var nextMatch = renderer.getBestMatchForTrackedPath();
                        _this._persistedSelectionMatch = nextMatch;
                        var prevMatchID = prevMatch !== null ? prevMatch.id : null;
                        var nextMatchID = nextMatch !== null ? nextMatch.id : null;
                        if (prevMatchID !== nextMatchID) {
                          if (nextMatchID !== null) {
                            _this._bridge.send("selectElement", nextMatchID);
                          }
                        }
                        if (nextMatch !== null && nextMatch.isFullMatch) {
                          _this._persistedSelection = null;
                          _this._persistedSelectionMatch = null;
                          renderer.setTrackedPath(null);
                        }
                      }
                    }
                  }
                });
                agent_defineProperty(_this, "getIfHasUnsupportedRendererVersion", function() {
                  _this.emit("getIfHasUnsupportedRendererVersion");
                });
                agent_defineProperty(_this, "_persistSelectionTimerScheduled", false);
                agent_defineProperty(_this, "_lastSelectedRendererID", -1);
                agent_defineProperty(_this, "_lastSelectedElementID", -1);
                agent_defineProperty(_this, "_persistSelection", function() {
                  _this._persistSelectionTimerScheduled = false;
                  var rendererID = _this._lastSelectedRendererID;
                  var id = _this._lastSelectedElementID;
                  var renderer = _this._rendererInterfaces[rendererID];
                  var path = renderer != null ? renderer.getPathForElement(id) : null;
                  if (path !== null) {
                    storage_sessionStorageSetItem(SESSION_STORAGE_LAST_SELECTION_KEY, JSON.stringify({
                      rendererID,
                      path
                    }));
                  } else {
                    storage_sessionStorageRemoveItem(SESSION_STORAGE_LAST_SELECTION_KEY);
                  }
                });
                _this._isProfiling = isProfiling;
                _this._onReloadAndProfile = onReloadAndProfile2;
                var persistedSelectionString = storage_sessionStorageGetItem(SESSION_STORAGE_LAST_SELECTION_KEY);
                if (persistedSelectionString != null) {
                  _this._persistedSelection = JSON.parse(persistedSelectionString);
                }
                _this._bridge = bridge;
                bridge.addListener("clearErrorsAndWarnings", _this.clearErrorsAndWarnings);
                bridge.addListener("clearErrorsForElementID", _this.clearErrorsForElementID);
                bridge.addListener("clearWarningsForElementID", _this.clearWarningsForElementID);
                bridge.addListener("copyElementPath", _this.copyElementPath);
                bridge.addListener("deletePath", _this.deletePath);
                bridge.addListener("getBackendVersion", _this.getBackendVersion);
                bridge.addListener("getBridgeProtocol", _this.getBridgeProtocol);
                bridge.addListener("getProfilingData", _this.getProfilingData);
                bridge.addListener("getProfilingStatus", _this.getProfilingStatus);
                bridge.addListener("getOwnersList", _this.getOwnersList);
                bridge.addListener("inspectElement", _this.inspectElement);
                bridge.addListener("inspectScreen", _this.inspectScreen);
                bridge.addListener("logElementToConsole", _this.logElementToConsole);
                bridge.addListener("overrideError", _this.overrideError);
                bridge.addListener("overrideSuspense", _this.overrideSuspense);
                bridge.addListener("overrideSuspenseMilestone", _this.overrideSuspenseMilestone);
                bridge.addListener("overrideValueAtPath", _this.overrideValueAtPath);
                bridge.addListener("reloadAndProfile", _this.reloadAndProfile);
                bridge.addListener("renamePath", _this.renamePath);
                bridge.addListener("setTraceUpdatesEnabled", _this.setTraceUpdatesEnabled);
                bridge.addListener("startProfiling", _this.startProfiling);
                bridge.addListener("stopProfiling", _this.stopProfiling);
                bridge.addListener("storeAsGlobal", _this.storeAsGlobal);
                bridge.addListener("syncSelectionFromBuiltinElementsPanel", _this.syncSelectionFromBuiltinElementsPanel);
                bridge.addListener("shutdown", _this.shutdown);
                bridge.addListener("updateHookSettings", _this.updateHookSettings);
                bridge.addListener("getHookSettings", _this.getHookSettings);
                bridge.addListener("updateComponentFilters", _this.updateComponentFilters);
                bridge.addListener("getEnvironmentNames", _this.getEnvironmentNames);
                bridge.addListener("getIfHasUnsupportedRendererVersion", _this.getIfHasUnsupportedRendererVersion);
                bridge.addListener("overrideContext", _this.overrideContext);
                bridge.addListener("overrideHookState", _this.overrideHookState);
                bridge.addListener("overrideProps", _this.overrideProps);
                bridge.addListener("overrideState", _this.overrideState);
                setupHighlighter(bridge, _this);
                TraceUpdates_initialize(_this);
                bridge.send("backendInitialized");
                if (_this._isProfiling) {
                  bridge.send("profilingStatus", true);
                }
                return _this;
              }
              __name(Agent2, "Agent");
              agent_inherits(Agent2, _EventEmitter);
              return agent_createClass(Agent2, [{
                key: "rendererInterfaces",
                get: /* @__PURE__ */ __name(function get() {
                  return this._rendererInterfaces;
                }, "get")
              }, {
                key: "getInstanceAndStyle",
                value: /* @__PURE__ */ __name(function getInstanceAndStyle(_ref24) {
                  var id = _ref24.id, rendererID = _ref24.rendererID;
                  var renderer = this._rendererInterfaces[rendererID];
                  if (renderer == null) {
                    console.warn('Invalid renderer id "'.concat(rendererID, '"'));
                    return null;
                  }
                  return renderer.getInstanceAndStyle(id);
                }, "getInstanceAndStyle")
              }, {
                key: "getIDForHostInstance",
                value: /* @__PURE__ */ __name(function getIDForHostInstance(target, onlySuspenseNodes) {
                  if (isReactNativeEnvironment() || typeof target.nodeType !== "number") {
                    for (var rendererID in this._rendererInterfaces) {
                      var renderer = this._rendererInterfaces[rendererID];
                      try {
                        var id = onlySuspenseNodes ? renderer.getSuspenseNodeIDForHostInstance(target) : renderer.getElementIDForHostInstance(target);
                        if (id !== null) {
                          return {
                            id,
                            rendererID: +rendererID
                          };
                        }
                      } catch (error) {
                      }
                    }
                    return null;
                  } else {
                    var bestMatch = null;
                    var bestRenderer = null;
                    var bestRendererID = 0;
                    for (var _rendererID in this._rendererInterfaces) {
                      var _renderer = this._rendererInterfaces[_rendererID];
                      var nearestNode = _renderer.getNearestMountedDOMNode(target);
                      if (nearestNode !== null) {
                        if (nearestNode === target) {
                          bestMatch = nearestNode;
                          bestRenderer = _renderer;
                          bestRendererID = +_rendererID;
                          break;
                        }
                        if (bestMatch === null || bestMatch.contains(nearestNode)) {
                          bestMatch = nearestNode;
                          bestRenderer = _renderer;
                          bestRendererID = +_rendererID;
                        }
                      }
                    }
                    if (bestRenderer != null && bestMatch != null) {
                      try {
                        var _id = onlySuspenseNodes ? bestRenderer.getSuspenseNodeIDForHostInstance(bestMatch) : bestRenderer.getElementIDForHostInstance(bestMatch);
                        if (_id !== null) {
                          return {
                            id: _id,
                            rendererID: bestRendererID
                          };
                        }
                      } catch (error) {
                      }
                    }
                    return null;
                  }
                }, "getIDForHostInstance")
              }, {
                key: "getComponentNameForHostInstance",
                value: /* @__PURE__ */ __name(function getComponentNameForHostInstance(target) {
                  var match = this.getIDForHostInstance(target);
                  if (match !== null) {
                    var renderer = this._rendererInterfaces[match.rendererID];
                    return renderer.getDisplayNameForElementID(match.id);
                  }
                  return null;
                }, "getComponentNameForHostInstance")
              }, {
                key: "selectNode",
                value: /* @__PURE__ */ __name(function selectNode(target) {
                  var match = this.getIDForHostInstance(target);
                  if (match !== null) {
                    this._bridge.send("selectElement", match.id);
                  }
                }, "selectNode")
              }, {
                key: "registerRendererInterface",
                value: /* @__PURE__ */ __name(function registerRendererInterface(rendererID, rendererInterface) {
                  this._rendererInterfaces[rendererID] = rendererInterface;
                  rendererInterface.setTraceUpdatesEnabled(this._traceUpdatesEnabled);
                  var renderer = rendererInterface.renderer;
                  if (renderer !== null) {
                    var devRenderer = renderer.bundleType === 1;
                    var enableSuspenseTab = devRenderer && gte(renderer.version, "19.3.0-canary");
                    if (enableSuspenseTab) {
                      this._bridge.send("enableSuspenseTab");
                    }
                  }
                  var selection = this._persistedSelection;
                  if (selection !== null && selection.rendererID === rendererID) {
                    rendererInterface.setTrackedPath(selection.path);
                  }
                }, "registerRendererInterface")
              }, {
                key: "onUnsupportedRenderer",
                value: /* @__PURE__ */ __name(function onUnsupportedRenderer() {
                  this._bridge.send("unsupportedRendererVersion");
                }, "onUnsupportedRenderer")
              }]);
            }(EventEmitter);
            ;
            function DevToolsConsolePatching_typeof(o) {
              "@babel/helpers - typeof";
              return DevToolsConsolePatching_typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                return typeof o2;
              } : function(o2) {
                return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
              }, DevToolsConsolePatching_typeof(o);
            }
            __name(DevToolsConsolePatching_typeof, "DevToolsConsolePatching_typeof");
            function DevToolsConsolePatching_ownKeys(e, r) {
              var t = Object.keys(e);
              if (Object.getOwnPropertySymbols) {
                var o = Object.getOwnPropertySymbols(e);
                r && (o = o.filter(function(r2) {
                  return Object.getOwnPropertyDescriptor(e, r2).enumerable;
                })), t.push.apply(t, o);
              }
              return t;
            }
            __name(DevToolsConsolePatching_ownKeys, "DevToolsConsolePatching_ownKeys");
            function DevToolsConsolePatching_objectSpread(e) {
              for (var r = 1; r < arguments.length; r++) {
                var t = null != arguments[r] ? arguments[r] : {};
                r % 2 ? DevToolsConsolePatching_ownKeys(Object(t), true).forEach(function(r2) {
                  DevToolsConsolePatching_defineProperty(e, r2, t[r2]);
                }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : DevToolsConsolePatching_ownKeys(Object(t)).forEach(function(r2) {
                  Object.defineProperty(e, r2, Object.getOwnPropertyDescriptor(t, r2));
                });
              }
              return e;
            }
            __name(DevToolsConsolePatching_objectSpread, "DevToolsConsolePatching_objectSpread");
            function DevToolsConsolePatching_defineProperty(obj, key, value) {
              key = DevToolsConsolePatching_toPropertyKey(key);
              if (key in obj) {
                Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
              } else {
                obj[key] = value;
              }
              return obj;
            }
            __name(DevToolsConsolePatching_defineProperty, "DevToolsConsolePatching_defineProperty");
            function DevToolsConsolePatching_toPropertyKey(t) {
              var i = DevToolsConsolePatching_toPrimitive(t, "string");
              return "symbol" == DevToolsConsolePatching_typeof(i) ? i : i + "";
            }
            __name(DevToolsConsolePatching_toPropertyKey, "DevToolsConsolePatching_toPropertyKey");
            function DevToolsConsolePatching_toPrimitive(t, r) {
              if ("object" != DevToolsConsolePatching_typeof(t) || !t) return t;
              var e = t[Symbol.toPrimitive];
              if (void 0 !== e) {
                var i = e.call(t, r || "default");
                if ("object" != DevToolsConsolePatching_typeof(i)) return i;
                throw new TypeError("@@toPrimitive must return a primitive value.");
              }
              return ("string" === r ? String : Number)(t);
            }
            __name(DevToolsConsolePatching_toPrimitive, "DevToolsConsolePatching_toPrimitive");
            var disabledDepth = 0;
            var prevLog;
            var prevInfo;
            var prevWarn;
            var prevError;
            var prevGroup;
            var prevGroupCollapsed;
            var prevGroupEnd;
            function disabledLog() {
            }
            __name(disabledLog, "disabledLog");
            disabledLog.__reactDisabledLog = true;
            function disableLogs() {
              if (disabledDepth === 0) {
                prevLog = console.log;
                prevInfo = console.info;
                prevWarn = console.warn;
                prevError = console.error;
                prevGroup = console.group;
                prevGroupCollapsed = console.groupCollapsed;
                prevGroupEnd = console.groupEnd;
                var props = {
                  configurable: true,
                  enumerable: true,
                  value: disabledLog,
                  writable: true
                };
                Object.defineProperties(console, {
                  info: props,
                  log: props,
                  warn: props,
                  error: props,
                  group: props,
                  groupCollapsed: props,
                  groupEnd: props
                });
              }
              disabledDepth++;
            }
            __name(disableLogs, "disableLogs");
            function reenableLogs() {
              disabledDepth--;
              if (disabledDepth === 0) {
                var props = {
                  configurable: true,
                  enumerable: true,
                  writable: true
                };
                Object.defineProperties(console, {
                  log: DevToolsConsolePatching_objectSpread(DevToolsConsolePatching_objectSpread({}, props), {}, {
                    value: prevLog
                  }),
                  info: DevToolsConsolePatching_objectSpread(DevToolsConsolePatching_objectSpread({}, props), {}, {
                    value: prevInfo
                  }),
                  warn: DevToolsConsolePatching_objectSpread(DevToolsConsolePatching_objectSpread({}, props), {}, {
                    value: prevWarn
                  }),
                  error: DevToolsConsolePatching_objectSpread(DevToolsConsolePatching_objectSpread({}, props), {}, {
                    value: prevError
                  }),
                  group: DevToolsConsolePatching_objectSpread(DevToolsConsolePatching_objectSpread({}, props), {}, {
                    value: prevGroup
                  }),
                  groupCollapsed: DevToolsConsolePatching_objectSpread(DevToolsConsolePatching_objectSpread({}, props), {}, {
                    value: prevGroupCollapsed
                  }),
                  groupEnd: DevToolsConsolePatching_objectSpread(DevToolsConsolePatching_objectSpread({}, props), {}, {
                    value: prevGroupEnd
                  })
                });
              }
              if (disabledDepth < 0) {
                console.error("disabledDepth fell below zero. This is a bug in React. Please file an issue.");
              }
            }
            __name(reenableLogs, "reenableLogs");
            ;
            function DevToolsComponentStackFrame_slicedToArray(arr, i) {
              return DevToolsComponentStackFrame_arrayWithHoles(arr) || DevToolsComponentStackFrame_iterableToArrayLimit(arr, i) || DevToolsComponentStackFrame_unsupportedIterableToArray(arr, i) || DevToolsComponentStackFrame_nonIterableRest();
            }
            __name(DevToolsComponentStackFrame_slicedToArray, "DevToolsComponentStackFrame_slicedToArray");
            function DevToolsComponentStackFrame_nonIterableRest() {
              throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
            }
            __name(DevToolsComponentStackFrame_nonIterableRest, "DevToolsComponentStackFrame_nonIterableRest");
            function DevToolsComponentStackFrame_unsupportedIterableToArray(o, minLen) {
              if (!o) return;
              if (typeof o === "string") return DevToolsComponentStackFrame_arrayLikeToArray(o, minLen);
              var n = Object.prototype.toString.call(o).slice(8, -1);
              if (n === "Object" && o.constructor) n = o.constructor.name;
              if (n === "Map" || n === "Set") return Array.from(o);
              if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return DevToolsComponentStackFrame_arrayLikeToArray(o, minLen);
            }
            __name(DevToolsComponentStackFrame_unsupportedIterableToArray, "DevToolsComponentStackFrame_unsupportedIterableToArray");
            function DevToolsComponentStackFrame_arrayLikeToArray(arr, len) {
              if (len == null || len > arr.length) len = arr.length;
              for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i];
              return arr2;
            }
            __name(DevToolsComponentStackFrame_arrayLikeToArray, "DevToolsComponentStackFrame_arrayLikeToArray");
            function DevToolsComponentStackFrame_iterableToArrayLimit(r, l) {
              var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"];
              if (null != t) {
                var e, n, i, u, a = [], f = true, o = false;
                try {
                  if (i = (t = t.call(r)).next, 0 === l) {
                    if (Object(t) !== t) return;
                    f = false;
                  } else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = true) ;
                } catch (r2) {
                  o = true, n = r2;
                } finally {
                  try {
                    if (!f && null != t.return && (u = t.return(), Object(u) !== u)) return;
                  } finally {
                    if (o) throw n;
                  }
                }
                return a;
              }
            }
            __name(DevToolsComponentStackFrame_iterableToArrayLimit, "DevToolsComponentStackFrame_iterableToArrayLimit");
            function DevToolsComponentStackFrame_arrayWithHoles(arr) {
              if (Array.isArray(arr)) return arr;
            }
            __name(DevToolsComponentStackFrame_arrayWithHoles, "DevToolsComponentStackFrame_arrayWithHoles");
            function DevToolsComponentStackFrame_typeof(o) {
              "@babel/helpers - typeof";
              return DevToolsComponentStackFrame_typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                return typeof o2;
              } : function(o2) {
                return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
              }, DevToolsComponentStackFrame_typeof(o);
            }
            __name(DevToolsComponentStackFrame_typeof, "DevToolsComponentStackFrame_typeof");
            var prefix;
            function describeBuiltInComponentFrame(name) {
              if (prefix === void 0) {
                try {
                  throw Error();
                } catch (x) {
                  var match = x.stack.trim().match(/\n( *(at )?)/);
                  prefix = match && match[1] || "";
                }
              }
              var suffix = "";
              if (true) {
                suffix = " (<anonymous>)";
              } else {
              }
              return "\n" + prefix + name + suffix;
            }
            __name(describeBuiltInComponentFrame, "describeBuiltInComponentFrame");
            function describeDebugInfoFrame(name, env) {
              return describeBuiltInComponentFrame(name + (env ? " [" + env + "]" : ""));
            }
            __name(describeDebugInfoFrame, "describeDebugInfoFrame");
            var reentry = false;
            var componentFrameCache;
            if (false) {
              var PossiblyWeakMap;
            }
            function describeNativeComponentFrame(fn, construct, currentDispatcherRef) {
              if (!fn || reentry) {
                return "";
              }
              if (false) {
                var frame;
              }
              var previousPrepareStackTrace = Error.prepareStackTrace;
              Error.prepareStackTrace = void 0;
              reentry = true;
              var previousDispatcher = currentDispatcherRef.H;
              currentDispatcherRef.H = null;
              disableLogs();
              try {
                var RunInRootFrame = {
                  DetermineComponentFrameRoot: /* @__PURE__ */ __name(function DetermineComponentFrameRoot() {
                    var control;
                    try {
                      if (construct) {
                        var Fake = /* @__PURE__ */ __name(function Fake2() {
                          throw Error();
                        }, "Fake");
                        Object.defineProperty(Fake.prototype, "props", {
                          set: /* @__PURE__ */ __name(function set() {
                            throw Error();
                          }, "set")
                        });
                        if ((typeof Reflect === "undefined" ? "undefined" : DevToolsComponentStackFrame_typeof(Reflect)) === "object" && Reflect.construct) {
                          try {
                            Reflect.construct(Fake, []);
                          } catch (x) {
                            control = x;
                          }
                          Reflect.construct(fn, [], Fake);
                        } else {
                          try {
                            Fake.call();
                          } catch (x) {
                            control = x;
                          }
                          fn.call(Fake.prototype);
                        }
                      } else {
                        try {
                          throw Error();
                        } catch (x) {
                          control = x;
                        }
                        var maybePromise = fn();
                        if (maybePromise && typeof maybePromise.catch === "function") {
                          maybePromise.catch(function() {
                          });
                        }
                      }
                    } catch (sample) {
                      if (sample && control && typeof sample.stack === "string") {
                        return [sample.stack, control.stack];
                      }
                    }
                    return [null, null];
                  }, "DetermineComponentFrameRoot")
                };
                RunInRootFrame.DetermineComponentFrameRoot.displayName = "DetermineComponentFrameRoot";
                var namePropDescriptor = Object.getOwnPropertyDescriptor(RunInRootFrame.DetermineComponentFrameRoot, "name");
                if (namePropDescriptor && namePropDescriptor.configurable) {
                  Object.defineProperty(RunInRootFrame.DetermineComponentFrameRoot, "name", {
                    value: "DetermineComponentFrameRoot"
                  });
                }
                var _RunInRootFrame$Deter = RunInRootFrame.DetermineComponentFrameRoot(), _RunInRootFrame$Deter2 = DevToolsComponentStackFrame_slicedToArray(_RunInRootFrame$Deter, 2), sampleStack = _RunInRootFrame$Deter2[0], controlStack = _RunInRootFrame$Deter2[1];
                if (sampleStack && controlStack) {
                  var sampleLines = sampleStack.split("\n");
                  var controlLines = controlStack.split("\n");
                  var s = 0;
                  var c = 0;
                  while (s < sampleLines.length && !sampleLines[s].includes("DetermineComponentFrameRoot")) {
                    s++;
                  }
                  while (c < controlLines.length && !controlLines[c].includes("DetermineComponentFrameRoot")) {
                    c++;
                  }
                  if (s === sampleLines.length || c === controlLines.length) {
                    s = sampleLines.length - 1;
                    c = controlLines.length - 1;
                    while (s >= 1 && c >= 0 && sampleLines[s] !== controlLines[c]) {
                      c--;
                    }
                  }
                  for (; s >= 1 && c >= 0; s--, c--) {
                    if (sampleLines[s] !== controlLines[c]) {
                      if (s !== 1 || c !== 1) {
                        do {
                          s--;
                          c--;
                          if (c < 0 || sampleLines[s] !== controlLines[c]) {
                            var _frame = "\n" + sampleLines[s].replace(" at new ", " at ");
                            if (fn.displayName && _frame.includes("<anonymous>")) {
                              _frame = _frame.replace("<anonymous>", fn.displayName);
                            }
                            if (false) {
                            }
                            return _frame;
                          }
                        } while (s >= 1 && c >= 0);
                      }
                      break;
                    }
                  }
                }
              } finally {
                reentry = false;
                Error.prepareStackTrace = previousPrepareStackTrace;
                currentDispatcherRef.H = previousDispatcher;
                reenableLogs();
              }
              var name = fn ? fn.displayName || fn.name : "";
              var syntheticFrame = name ? describeBuiltInComponentFrame(name) : "";
              if (false) {
              }
              return syntheticFrame;
            }
            __name(describeNativeComponentFrame, "describeNativeComponentFrame");
            function describeClassComponentFrame(ctor, currentDispatcherRef) {
              return describeNativeComponentFrame(ctor, true, currentDispatcherRef);
            }
            __name(describeClassComponentFrame, "describeClassComponentFrame");
            function describeFunctionComponentFrame(fn, currentDispatcherRef) {
              return describeNativeComponentFrame(fn, false, currentDispatcherRef);
            }
            __name(describeFunctionComponentFrame, "describeFunctionComponentFrame");
            ;
            function formatOwnerStack(error) {
              var prevPrepareStackTrace = Error.prepareStackTrace;
              Error.prepareStackTrace = void 0;
              var stack = error.stack;
              Error.prepareStackTrace = prevPrepareStackTrace;
              if (stack.startsWith("Error: react-stack-top-frame\n")) {
                stack = stack.slice(29);
              }
              var idx = stack.indexOf("\n");
              if (idx !== -1) {
                stack = stack.slice(idx + 1);
              }
              idx = stack.indexOf("react_stack_bottom_frame");
              if (idx === -1) {
                idx = stack.indexOf("react-stack-bottom-frame");
              }
              if (idx !== -1) {
                idx = stack.lastIndexOf("\n", idx);
              }
              if (idx !== -1) {
                stack = stack.slice(0, idx);
              } else {
                return "";
              }
              return stack;
            }
            __name(formatOwnerStack, "formatOwnerStack");
            ;
            function getOwnerStackByComponentInfoInDev(componentInfo) {
              try {
                var info = "";
                if (!componentInfo.owner && typeof componentInfo.name === "string") {
                  return describeBuiltInComponentFrame(componentInfo.name);
                }
                var owner = componentInfo;
                while (owner) {
                  var ownerStack = owner.debugStack;
                  if (ownerStack != null) {
                    owner = owner.owner;
                    if (owner) {
                      info += "\n" + formatOwnerStack(ownerStack);
                    }
                  } else {
                    break;
                  }
                }
                return info;
              } catch (x) {
                return "\nError generating stack: " + x.message + "\n" + x.stack;
              }
            }
            __name(getOwnerStackByComponentInfoInDev, "getOwnerStackByComponentInfoInDev");
            ;
            var componentInfoToComponentLogsMap = /* @__PURE__ */ new WeakMap();
            ;
            function renderer_toConsumableArray(arr) {
              return renderer_arrayWithoutHoles(arr) || renderer_iterableToArray(arr) || renderer_unsupportedIterableToArray(arr) || renderer_nonIterableSpread();
            }
            __name(renderer_toConsumableArray, "renderer_toConsumableArray");
            function renderer_nonIterableSpread() {
              throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
            }
            __name(renderer_nonIterableSpread, "renderer_nonIterableSpread");
            function renderer_unsupportedIterableToArray(o, minLen) {
              if (!o) return;
              if (typeof o === "string") return renderer_arrayLikeToArray(o, minLen);
              var n = Object.prototype.toString.call(o).slice(8, -1);
              if (n === "Object" && o.constructor) n = o.constructor.name;
              if (n === "Map" || n === "Set") return Array.from(o);
              if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return renderer_arrayLikeToArray(o, minLen);
            }
            __name(renderer_unsupportedIterableToArray, "renderer_unsupportedIterableToArray");
            function renderer_iterableToArray(iter) {
              if (typeof Symbol !== "undefined" && iter[Symbol.iterator] != null || iter["@@iterator"] != null) return Array.from(iter);
            }
            __name(renderer_iterableToArray, "renderer_iterableToArray");
            function renderer_arrayWithoutHoles(arr) {
              if (Array.isArray(arr)) return renderer_arrayLikeToArray(arr);
            }
            __name(renderer_arrayWithoutHoles, "renderer_arrayWithoutHoles");
            function renderer_arrayLikeToArray(arr, len) {
              if (len == null || len > arr.length) len = arr.length;
              for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i];
              return arr2;
            }
            __name(renderer_arrayLikeToArray, "renderer_arrayLikeToArray");
            function supportsConsoleTasks(componentInfo) {
              return !!componentInfo.debugTask;
            }
            __name(supportsConsoleTasks, "supportsConsoleTasks");
            function attach(hook, rendererID, renderer, global) {
              var getCurrentComponentInfo = renderer.getCurrentComponentInfo;
              function getComponentStack(topFrame) {
                if (getCurrentComponentInfo === void 0) {
                  return null;
                }
                var current = getCurrentComponentInfo();
                if (current === null) {
                  return null;
                }
                if (supportsConsoleTasks(current)) {
                  return null;
                }
                var enableOwnerStacks = current.debugStack != null;
                var componentStack = "";
                if (enableOwnerStacks) {
                  var topStackFrames = formatOwnerStack(topFrame);
                  if (topStackFrames) {
                    componentStack += "\n" + topStackFrames;
                  }
                  componentStack += getOwnerStackByComponentInfoInDev(current);
                }
                return {
                  enableOwnerStacks,
                  componentStack
                };
              }
              __name(getComponentStack, "getComponentStack");
              function onErrorOrWarning(type, args) {
                if (getCurrentComponentInfo === void 0) {
                  return;
                }
                var componentInfo = getCurrentComponentInfo();
                if (componentInfo === null) {
                  return;
                }
                if (args.length > 3 && typeof args[0] === "string" && args[0].startsWith("%c%s%c ") && typeof args[1] === "string" && typeof args[2] === "string" && typeof args[3] === "string") {
                  var format = args[0].slice(7);
                  var env = args[2].trim();
                  args = args.slice(4);
                  if (env !== componentInfo.env) {
                    args.unshift("[" + env + "] " + format);
                  } else {
                    args.unshift(format);
                  }
                }
                var message = formatConsoleArgumentsToSingleString.apply(void 0, renderer_toConsumableArray(args));
                var componentLogsEntry = componentInfoToComponentLogsMap.get(componentInfo);
                if (componentLogsEntry === void 0) {
                  componentLogsEntry = {
                    errors: /* @__PURE__ */ new Map(),
                    errorsCount: 0,
                    warnings: /* @__PURE__ */ new Map(),
                    warningsCount: 0
                  };
                  componentInfoToComponentLogsMap.set(componentInfo, componentLogsEntry);
                }
                var messageMap = type === "error" ? componentLogsEntry.errors : componentLogsEntry.warnings;
                var count = messageMap.get(message) || 0;
                messageMap.set(message, count + 1);
                if (type === "error") {
                  componentLogsEntry.errorsCount++;
                } else {
                  componentLogsEntry.warningsCount++;
                }
              }
              __name(onErrorOrWarning, "onErrorOrWarning");
              var supportsTogglingSuspense = false;
              return {
                cleanup: /* @__PURE__ */ __name(function cleanup() {
                }, "cleanup"),
                clearErrorsAndWarnings: /* @__PURE__ */ __name(function clearErrorsAndWarnings() {
                }, "clearErrorsAndWarnings"),
                clearErrorsForElementID: /* @__PURE__ */ __name(function clearErrorsForElementID() {
                }, "clearErrorsForElementID"),
                clearWarningsForElementID: /* @__PURE__ */ __name(function clearWarningsForElementID() {
                }, "clearWarningsForElementID"),
                getSerializedElementValueByPath: /* @__PURE__ */ __name(function getSerializedElementValueByPath() {
                }, "getSerializedElementValueByPath"),
                deletePath: /* @__PURE__ */ __name(function deletePath() {
                }, "deletePath"),
                findHostInstancesForElementID: /* @__PURE__ */ __name(function findHostInstancesForElementID() {
                  return null;
                }, "findHostInstancesForElementID"),
                findLastKnownRectsForID: /* @__PURE__ */ __name(function findLastKnownRectsForID() {
                  return null;
                }, "findLastKnownRectsForID"),
                flushInitialOperations: /* @__PURE__ */ __name(function flushInitialOperations() {
                }, "flushInitialOperations"),
                getBestMatchForTrackedPath: /* @__PURE__ */ __name(function getBestMatchForTrackedPath() {
                  return null;
                }, "getBestMatchForTrackedPath"),
                getComponentStack,
                getDisplayNameForElementID: /* @__PURE__ */ __name(function getDisplayNameForElementID() {
                  return null;
                }, "getDisplayNameForElementID"),
                getNearestMountedDOMNode: /* @__PURE__ */ __name(function getNearestMountedDOMNode() {
                  return null;
                }, "getNearestMountedDOMNode"),
                getElementIDForHostInstance: /* @__PURE__ */ __name(function getElementIDForHostInstance() {
                  return null;
                }, "getElementIDForHostInstance"),
                getSuspenseNodeIDForHostInstance: /* @__PURE__ */ __name(function getSuspenseNodeIDForHostInstance() {
                  return null;
                }, "getSuspenseNodeIDForHostInstance"),
                getInstanceAndStyle: /* @__PURE__ */ __name(function getInstanceAndStyle() {
                  return {
                    instance: null,
                    style: null
                  };
                }, "getInstanceAndStyle"),
                getOwnersList: /* @__PURE__ */ __name(function getOwnersList() {
                  return null;
                }, "getOwnersList"),
                getPathForElement: /* @__PURE__ */ __name(function getPathForElement() {
                  return null;
                }, "getPathForElement"),
                getProfilingData: /* @__PURE__ */ __name(function getProfilingData() {
                  throw new Error("getProfilingData not supported by this renderer");
                }, "getProfilingData"),
                handleCommitFiberRoot: /* @__PURE__ */ __name(function handleCommitFiberRoot() {
                }, "handleCommitFiberRoot"),
                handleCommitFiberUnmount: /* @__PURE__ */ __name(function handleCommitFiberUnmount() {
                }, "handleCommitFiberUnmount"),
                handlePostCommitFiberRoot: /* @__PURE__ */ __name(function handlePostCommitFiberRoot() {
                }, "handlePostCommitFiberRoot"),
                hasElementWithId: /* @__PURE__ */ __name(function hasElementWithId() {
                  return false;
                }, "hasElementWithId"),
                inspectElement: /* @__PURE__ */ __name(function inspectElement(requestID, id, path) {
                  return {
                    id,
                    responseID: requestID,
                    type: "not-found"
                  };
                }, "inspectElement"),
                logElementToConsole: /* @__PURE__ */ __name(function logElementToConsole() {
                }, "logElementToConsole"),
                getElementAttributeByPath: /* @__PURE__ */ __name(function getElementAttributeByPath() {
                }, "getElementAttributeByPath"),
                getElementSourceFunctionById: /* @__PURE__ */ __name(function getElementSourceFunctionById() {
                }, "getElementSourceFunctionById"),
                onErrorOrWarning,
                overrideError: /* @__PURE__ */ __name(function overrideError() {
                }, "overrideError"),
                overrideSuspense: /* @__PURE__ */ __name(function overrideSuspense() {
                }, "overrideSuspense"),
                overrideSuspenseMilestone: /* @__PURE__ */ __name(function overrideSuspenseMilestone() {
                }, "overrideSuspenseMilestone"),
                overrideValueAtPath: /* @__PURE__ */ __name(function overrideValueAtPath() {
                }, "overrideValueAtPath"),
                renamePath: /* @__PURE__ */ __name(function renamePath() {
                }, "renamePath"),
                renderer,
                setTraceUpdatesEnabled: /* @__PURE__ */ __name(function setTraceUpdatesEnabled() {
                }, "setTraceUpdatesEnabled"),
                setTrackedPath: /* @__PURE__ */ __name(function setTrackedPath() {
                }, "setTrackedPath"),
                startProfiling: /* @__PURE__ */ __name(function startProfiling() {
                }, "startProfiling"),
                stopProfiling: /* @__PURE__ */ __name(function stopProfiling() {
                }, "stopProfiling"),
                storeAsGlobal: /* @__PURE__ */ __name(function storeAsGlobal() {
                }, "storeAsGlobal"),
                supportsTogglingSuspense,
                updateComponentFilters: /* @__PURE__ */ __name(function updateComponentFilters() {
                }, "updateComponentFilters"),
                getEnvironmentNames: /* @__PURE__ */ __name(function getEnvironmentNames() {
                  return [];
                }, "getEnvironmentNames")
              };
            }
            __name(attach, "attach");
            ;
            function parseStackTrace_slicedToArray(arr, i) {
              return parseStackTrace_arrayWithHoles(arr) || parseStackTrace_iterableToArrayLimit(arr, i) || parseStackTrace_unsupportedIterableToArray(arr, i) || parseStackTrace_nonIterableRest();
            }
            __name(parseStackTrace_slicedToArray, "parseStackTrace_slicedToArray");
            function parseStackTrace_nonIterableRest() {
              throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
            }
            __name(parseStackTrace_nonIterableRest, "parseStackTrace_nonIterableRest");
            function parseStackTrace_unsupportedIterableToArray(o, minLen) {
              if (!o) return;
              if (typeof o === "string") return parseStackTrace_arrayLikeToArray(o, minLen);
              var n = Object.prototype.toString.call(o).slice(8, -1);
              if (n === "Object" && o.constructor) n = o.constructor.name;
              if (n === "Map" || n === "Set") return Array.from(o);
              if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return parseStackTrace_arrayLikeToArray(o, minLen);
            }
            __name(parseStackTrace_unsupportedIterableToArray, "parseStackTrace_unsupportedIterableToArray");
            function parseStackTrace_arrayLikeToArray(arr, len) {
              if (len == null || len > arr.length) len = arr.length;
              for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i];
              return arr2;
            }
            __name(parseStackTrace_arrayLikeToArray, "parseStackTrace_arrayLikeToArray");
            function parseStackTrace_iterableToArrayLimit(r, l) {
              var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"];
              if (null != t) {
                var e, n, i, u, a = [], f = true, o = false;
                try {
                  if (i = (t = t.call(r)).next, 0 === l) {
                    if (Object(t) !== t) return;
                    f = false;
                  } else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = true) ;
                } catch (r2) {
                  o = true, n = r2;
                } finally {
                  try {
                    if (!f && null != t.return && (u = t.return(), Object(u) !== u)) return;
                  } finally {
                    if (o) throw n;
                  }
                }
                return a;
              }
            }
            __name(parseStackTrace_iterableToArrayLimit, "parseStackTrace_iterableToArrayLimit");
            function parseStackTrace_arrayWithHoles(arr) {
              if (Array.isArray(arr)) return arr;
            }
            __name(parseStackTrace_arrayWithHoles, "parseStackTrace_arrayWithHoles");
            function parseStackTraceFromChromeStack(stack, skipFrames) {
              if (stack.startsWith("Error: react-stack-top-frame\n")) {
                stack = stack.slice(29);
              }
              var idx = stack.indexOf("react_stack_bottom_frame");
              if (idx === -1) {
                idx = stack.indexOf("react-stack-bottom-frame");
              }
              if (idx !== -1) {
                idx = stack.lastIndexOf("\n", idx);
              }
              if (idx !== -1) {
                stack = stack.slice(0, idx);
              }
              var frames = stack.split("\n");
              var parsedFrames = [];
              for (var i = skipFrames; i < frames.length; i++) {
                var parsed = chromeFrameRegExp.exec(frames[i]);
                if (!parsed) {
                  continue;
                }
                var name = parsed[1] || "";
                var isAsync = parsed[8] === "async ";
                if (name === "<anonymous>") {
                  name = "";
                } else if (name.startsWith("async ")) {
                  name = name.slice(5);
                  isAsync = true;
                }
                var filename = parsed[2] || parsed[5] || "";
                if (filename === "<anonymous>") {
                  filename = "";
                }
                var line = +(parsed[3] || parsed[6] || 0);
                var col = +(parsed[4] || parsed[7] || 0);
                parsedFrames.push([name, filename, line, col, 0, 0, isAsync]);
              }
              return parsedFrames;
            }
            __name(parseStackTraceFromChromeStack, "parseStackTraceFromChromeStack");
            var firefoxFrameRegExp = /^((?:.*".+")?[^@]*)@(.+):(\d+):(\d+)$/;
            function parseStackTraceFromFirefoxStack(stack, skipFrames) {
              var idx = stack.indexOf("react_stack_bottom_frame");
              if (idx === -1) {
                idx = stack.indexOf("react-stack-bottom-frame");
              }
              if (idx !== -1) {
                idx = stack.lastIndexOf("\n", idx);
              }
              if (idx !== -1) {
                stack = stack.slice(0, idx);
              }
              var frames = stack.split("\n");
              var parsedFrames = [];
              for (var i = skipFrames; i < frames.length; i++) {
                var parsed = firefoxFrameRegExp.exec(frames[i]);
                if (!parsed) {
                  continue;
                }
                var name = parsed[1] || "";
                var filename = parsed[2] || "";
                var line = +parsed[3];
                var col = +parsed[4];
                parsedFrames.push([name, filename, line, col, 0, 0, false]);
              }
              return parsedFrames;
            }
            __name(parseStackTraceFromFirefoxStack, "parseStackTraceFromFirefoxStack");
            var CHROME_STACK_REGEXP = /^\s*at .*(\S+:\d+|\(native\))/m;
            function parseStackTraceFromString(stack, skipFrames) {
              if (stack.match(CHROME_STACK_REGEXP)) {
                return parseStackTraceFromChromeStack(stack, skipFrames);
              }
              return parseStackTraceFromFirefoxStack(stack, skipFrames);
            }
            __name(parseStackTraceFromString, "parseStackTraceFromString");
            var framesToSkip = 0;
            var collectedStackTrace = null;
            var identifierRegExp = /^[a-zA-Z_$][0-9a-zA-Z_$]*$/;
            function getMethodCallName(callSite) {
              var typeName = callSite.getTypeName();
              var methodName = callSite.getMethodName();
              var functionName = callSite.getFunctionName();
              var result = "";
              if (functionName) {
                if (typeName && identifierRegExp.test(functionName) && functionName !== typeName) {
                  result += typeName + ".";
                }
                result += functionName;
                if (methodName && functionName !== methodName && !functionName.endsWith("." + methodName) && !functionName.endsWith(" " + methodName)) {
                  result += " [as " + methodName + "]";
                }
              } else {
                if (typeName) {
                  result += typeName + ".";
                }
                if (methodName) {
                  result += methodName;
                } else {
                  result += "<anonymous>";
                }
              }
              return result;
            }
            __name(getMethodCallName, "getMethodCallName");
            function collectStackTrace(error, structuredStackTrace) {
              var result = [];
              for (var i = framesToSkip; i < structuredStackTrace.length; i++) {
                var callSite = structuredStackTrace[i];
                var _name = callSite.getFunctionName() || "<anonymous>";
                if (_name.includes("react_stack_bottom_frame") || _name.includes("react-stack-bottom-frame")) {
                  break;
                } else if (callSite.isNative()) {
                  var isAsync = callSite.isAsync();
                  result.push([_name, "", 0, 0, 0, 0, isAsync]);
                } else {
                  if (callSite.isConstructor()) {
                    _name = "new " + _name;
                  } else if (!callSite.isToplevel()) {
                    _name = getMethodCallName(callSite);
                  }
                  if (_name === "<anonymous>") {
                    _name = "";
                  }
                  var filename = callSite.getScriptNameOrSourceURL() || "<anonymous>";
                  if (filename === "<anonymous>") {
                    filename = "";
                    if (callSite.isEval()) {
                      var origin = callSite.getEvalOrigin();
                      if (origin) {
                        filename = origin.toString() + ", <anonymous>";
                      }
                    }
                  }
                  var line = callSite.getLineNumber() || 0;
                  var col = callSite.getColumnNumber() || 0;
                  var enclosingLine = typeof callSite.getEnclosingLineNumber === "function" ? callSite.getEnclosingLineNumber() || 0 : 0;
                  var enclosingCol = typeof callSite.getEnclosingColumnNumber === "function" ? callSite.getEnclosingColumnNumber() || 0 : 0;
                  var _isAsync = callSite.isAsync();
                  result.push([_name, filename, line, col, enclosingLine, enclosingCol, _isAsync]);
                }
              }
              collectedStackTrace = result;
              var name = error.name || "Error";
              var message = error.message || "";
              var stack = name + ": " + message;
              for (var _i = 0; _i < structuredStackTrace.length; _i++) {
                stack += "\n    at " + structuredStackTrace[_i].toString();
              }
              return stack;
            }
            __name(collectStackTrace, "collectStackTrace");
            var chromeFrameRegExp = /^ *at (?:(.+) \((?:(.+):(\d+):(\d+)|\<anonymous\>)\)|(?:async )?(.+):(\d+):(\d+)|\<anonymous\>)$/;
            var stackTraceCache = /* @__PURE__ */ new WeakMap();
            function parseStackTrace(error, skipFrames) {
              var existing = stackTraceCache.get(error);
              if (existing !== void 0) {
                return existing;
              }
              collectedStackTrace = null;
              framesToSkip = skipFrames;
              var previousPrepare = Error.prepareStackTrace;
              Error.prepareStackTrace = collectStackTrace;
              var stack;
              try {
                stack = String(error.stack);
              } finally {
                Error.prepareStackTrace = previousPrepare;
              }
              if (collectedStackTrace !== null) {
                var result = collectedStackTrace;
                collectedStackTrace = null;
                stackTraceCache.set(error, result);
                return result;
              }
              var parsedFrames = parseStackTraceFromString(stack, skipFrames);
              stackTraceCache.set(error, parsedFrames);
              return parsedFrames;
            }
            __name(parseStackTrace, "parseStackTrace");
            function extractLocationFromOwnerStack(error) {
              var stackTrace = parseStackTrace(error, 1);
              var stack = error.stack;
              if (!stack.includes("react_stack_bottom_frame") && !stack.includes("react-stack-bottom-frame")) {
                return null;
              }
              for (var i = stackTrace.length - 1; i >= 0; i--) {
                var _stackTrace$i = parseStackTrace_slicedToArray(stackTrace[i], 6), functionName = _stackTrace$i[0], fileName = _stackTrace$i[1], line = _stackTrace$i[2], col = _stackTrace$i[3], encLine = _stackTrace$i[4], encCol = _stackTrace$i[5];
                if (fileName.indexOf(":") !== -1) {
                  return [functionName, fileName, encLine || line, encCol || col];
                }
              }
              return null;
            }
            __name(extractLocationFromOwnerStack, "extractLocationFromOwnerStack");
            function extractLocationFromComponentStack(stack) {
              var stackTrace = parseStackTraceFromString(stack, 0);
              for (var i = 0; i < stackTrace.length; i++) {
                var _stackTrace$i2 = parseStackTrace_slicedToArray(stackTrace[i], 6), functionName = _stackTrace$i2[0], fileName = _stackTrace$i2[1], line = _stackTrace$i2[2], col = _stackTrace$i2[3], encLine = _stackTrace$i2[4], encCol = _stackTrace$i2[5];
                if (fileName.indexOf(":") !== -1) {
                  return [functionName, fileName, encLine || line, encCol || col];
                }
              }
              return null;
            }
            __name(extractLocationFromComponentStack, "extractLocationFromComponentStack");
            var react_debug_tools = __webpack_require__(987);
            ;
            var CONCURRENT_MODE_NUMBER = 60111;
            var CONCURRENT_MODE_SYMBOL_STRING = "Symbol(react.concurrent_mode)";
            var CONTEXT_NUMBER = 60110;
            var CONTEXT_SYMBOL_STRING = "Symbol(react.context)";
            var SERVER_CONTEXT_SYMBOL_STRING = "Symbol(react.server_context)";
            var DEPRECATED_ASYNC_MODE_SYMBOL_STRING = "Symbol(react.async_mode)";
            var ELEMENT_SYMBOL_STRING = "Symbol(react.transitional.element)";
            var LEGACY_ELEMENT_NUMBER = 60103;
            var LEGACY_ELEMENT_SYMBOL_STRING = "Symbol(react.element)";
            var DEBUG_TRACING_MODE_NUMBER = 60129;
            var DEBUG_TRACING_MODE_SYMBOL_STRING = "Symbol(react.debug_trace_mode)";
            var FORWARD_REF_NUMBER = 60112;
            var FORWARD_REF_SYMBOL_STRING = "Symbol(react.forward_ref)";
            var FRAGMENT_NUMBER = 60107;
            var FRAGMENT_SYMBOL_STRING = "Symbol(react.fragment)";
            var LAZY_NUMBER = 60116;
            var LAZY_SYMBOL_STRING = "Symbol(react.lazy)";
            var MEMO_NUMBER = 60115;
            var MEMO_SYMBOL_STRING = "Symbol(react.memo)";
            var PORTAL_NUMBER = 60106;
            var PORTAL_SYMBOL_STRING = "Symbol(react.portal)";
            var PROFILER_NUMBER = 60114;
            var PROFILER_SYMBOL_STRING = "Symbol(react.profiler)";
            var PROVIDER_NUMBER = 60109;
            var PROVIDER_SYMBOL_STRING = "Symbol(react.provider)";
            var CONSUMER_SYMBOL_STRING = "Symbol(react.consumer)";
            var SCOPE_NUMBER = 60119;
            var SCOPE_SYMBOL_STRING = "Symbol(react.scope)";
            var STRICT_MODE_NUMBER = 60108;
            var STRICT_MODE_SYMBOL_STRING = "Symbol(react.strict_mode)";
            var SUSPENSE_NUMBER = 60113;
            var SUSPENSE_SYMBOL_STRING = "Symbol(react.suspense)";
            var SUSPENSE_LIST_NUMBER = 60120;
            var SUSPENSE_LIST_SYMBOL_STRING = "Symbol(react.suspense_list)";
            var SERVER_CONTEXT_DEFAULT_VALUE_NOT_LOADED_SYMBOL_STRING = "Symbol(react.server_context.defaultValue)";
            var ReactSymbols_REACT_MEMO_CACHE_SENTINEL = Symbol.for("react.memo_cache_sentinel");
            ;
            var enableLogger = false;
            var enableStyleXFeatures = false;
            var isInternalFacebookBuild = false;
            null;
            ;
            function is(x, y) {
              return x === y && (x !== 0 || 1 / x === 1 / y) || x !== x && y !== y;
            }
            __name(is, "is");
            var objectIs = typeof Object.is === "function" ? Object.is : is;
            const shared_objectIs = objectIs;
            ;
            var hasOwnProperty_hasOwnProperty = Object.prototype.hasOwnProperty;
            const shared_hasOwnProperty = hasOwnProperty_hasOwnProperty;
            ;
            function ReactIODescription_typeof(o) {
              "@babel/helpers - typeof";
              return ReactIODescription_typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                return typeof o2;
              } : function(o2) {
                return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
              }, ReactIODescription_typeof(o);
            }
            __name(ReactIODescription_typeof, "ReactIODescription_typeof");
            function getIODescription(value) {
              if (true) {
                return "";
              }
              try {
                switch (ReactIODescription_typeof(value)) {
                  case "function":
                    return value.name || "";
                  case "object":
                    if (value === null) {
                      return "";
                    } else if (value instanceof Error) {
                      return String(value.message);
                    } else if (typeof value.url === "string") {
                      return value.url;
                    } else if (typeof value.href === "string") {
                      return value.href;
                    } else if (typeof value.src === "string") {
                      return value.src;
                    } else if (typeof value.currentSrc === "string") {
                      return value.currentSrc;
                    } else if (typeof value.command === "string") {
                      return value.command;
                    } else if (ReactIODescription_typeof(value.request) === "object" && value.request !== null && typeof value.request.url === "string") {
                      return value.request.url;
                    } else if (ReactIODescription_typeof(value.response) === "object" && value.response !== null && typeof value.response.url === "string") {
                      return value.response.url;
                    } else if (typeof value.id === "string" || typeof value.id === "number" || typeof value.id === "bigint") {
                      return String(value.id);
                    } else if (typeof value.name === "string") {
                      return value.name;
                    } else {
                      var str = value.toString();
                      if (str.startsWith("[object ") || str.length < 5 || str.length > 500) {
                        return "";
                      }
                      return str;
                    }
                  case "string":
                    if (value.length < 5 || value.length > 500) {
                      return "";
                    }
                    return value;
                  case "number":
                  case "bigint":
                    return String(value);
                  default:
                    return "";
                }
              } catch (x) {
                return "";
              }
            }
            __name(getIODescription, "getIODescription");
            ;
            function describeFiber(workTagMap, workInProgress, currentDispatcherRef) {
              var HostHoistable = workTagMap.HostHoistable, HostSingleton = workTagMap.HostSingleton, HostComponent = workTagMap.HostComponent, LazyComponent = workTagMap.LazyComponent, SuspenseComponent = workTagMap.SuspenseComponent, SuspenseListComponent = workTagMap.SuspenseListComponent, FunctionComponent = workTagMap.FunctionComponent, IndeterminateComponent = workTagMap.IndeterminateComponent, SimpleMemoComponent = workTagMap.SimpleMemoComponent, ForwardRef = workTagMap.ForwardRef, ClassComponent = workTagMap.ClassComponent, ViewTransitionComponent = workTagMap.ViewTransitionComponent, ActivityComponent = workTagMap.ActivityComponent;
              switch (workInProgress.tag) {
                case HostHoistable:
                case HostSingleton:
                case HostComponent:
                  return describeBuiltInComponentFrame(workInProgress.type);
                case LazyComponent:
                  return describeBuiltInComponentFrame("Lazy");
                case SuspenseComponent:
                  return describeBuiltInComponentFrame("Suspense");
                case SuspenseListComponent:
                  return describeBuiltInComponentFrame("SuspenseList");
                case ViewTransitionComponent:
                  return describeBuiltInComponentFrame("ViewTransition");
                case ActivityComponent:
                  return describeBuiltInComponentFrame("Activity");
                case FunctionComponent:
                case IndeterminateComponent:
                case SimpleMemoComponent:
                  return describeFunctionComponentFrame(workInProgress.type, currentDispatcherRef);
                case ForwardRef:
                  return describeFunctionComponentFrame(workInProgress.type.render, currentDispatcherRef);
                case ClassComponent:
                  return describeClassComponentFrame(workInProgress.type, currentDispatcherRef);
                default:
                  return "";
              }
            }
            __name(describeFiber, "describeFiber");
            function getStackByFiberInDevAndProd(workTagMap, workInProgress, currentDispatcherRef) {
              try {
                var info = "";
                var node = workInProgress;
                do {
                  info += describeFiber(workTagMap, node, currentDispatcherRef);
                  var debugInfo = node._debugInfo;
                  if (debugInfo) {
                    for (var i = debugInfo.length - 1; i >= 0; i--) {
                      var entry = debugInfo[i];
                      if (typeof entry.name === "string") {
                        info += describeDebugInfoFrame(entry.name, entry.env);
                      }
                    }
                  }
                  node = node.return;
                } while (node);
                return info;
              } catch (x) {
                return "\nError generating stack: " + x.message + "\n" + x.stack;
              }
            }
            __name(getStackByFiberInDevAndProd, "getStackByFiberInDevAndProd");
            function getSourceLocationByFiber(workTagMap, fiber, currentDispatcherRef) {
              try {
                var info = describeFiber(workTagMap, fiber, currentDispatcherRef);
                if (info !== "") {
                  return info.slice(1);
                }
              } catch (x) {
                console.error(x);
              }
              return null;
            }
            __name(getSourceLocationByFiber, "getSourceLocationByFiber");
            function DevToolsFiberComponentStack_supportsConsoleTasks(fiber) {
              return !!fiber._debugTask;
            }
            __name(DevToolsFiberComponentStack_supportsConsoleTasks, "DevToolsFiberComponentStack_supportsConsoleTasks");
            function supportsOwnerStacks(fiber) {
              return fiber._debugStack !== void 0;
            }
            __name(supportsOwnerStacks, "supportsOwnerStacks");
            function getOwnerStackByFiberInDev(workTagMap, workInProgress, currentDispatcherRef) {
              var HostHoistable = workTagMap.HostHoistable, HostSingleton = workTagMap.HostSingleton, HostText = workTagMap.HostText, HostComponent = workTagMap.HostComponent, SuspenseComponent = workTagMap.SuspenseComponent, SuspenseListComponent = workTagMap.SuspenseListComponent, ViewTransitionComponent = workTagMap.ViewTransitionComponent, ActivityComponent = workTagMap.ActivityComponent;
              try {
                var info = "";
                if (workInProgress.tag === HostText) {
                  workInProgress = workInProgress.return;
                }
                switch (workInProgress.tag) {
                  case HostHoistable:
                  case HostSingleton:
                  case HostComponent:
                    info += describeBuiltInComponentFrame(workInProgress.type);
                    break;
                  case SuspenseComponent:
                    info += describeBuiltInComponentFrame("Suspense");
                    break;
                  case SuspenseListComponent:
                    info += describeBuiltInComponentFrame("SuspenseList");
                    break;
                  case ViewTransitionComponent:
                    info += describeBuiltInComponentFrame("ViewTransition");
                    break;
                  case ActivityComponent:
                    info += describeBuiltInComponentFrame("Activity");
                    break;
                }
                var owner = workInProgress;
                while (owner) {
                  if (typeof owner.tag === "number") {
                    var fiber = owner;
                    owner = fiber._debugOwner;
                    var debugStack = fiber._debugStack;
                    if (owner && debugStack) {
                      if (typeof debugStack !== "string") {
                        debugStack = formatOwnerStack(debugStack);
                      }
                      if (debugStack !== "") {
                        info += "\n" + debugStack;
                      }
                    }
                  } else if (owner.debugStack != null) {
                    var ownerStack = owner.debugStack;
                    owner = owner.owner;
                    if (owner && ownerStack) {
                      info += "\n" + formatOwnerStack(ownerStack);
                    }
                  } else {
                    break;
                  }
                }
                return info;
              } catch (x) {
                return "\nError generating stack: " + x.message + "\n" + x.stack;
              }
            }
            __name(getOwnerStackByFiberInDev, "getOwnerStackByFiberInDev");
            ;
            var cachedStyleNameToValueMap = /* @__PURE__ */ new Map();
            function getStyleXData(data) {
              var sources = /* @__PURE__ */ new Set();
              var resolvedStyles = {};
              crawlData(data, sources, resolvedStyles);
              return {
                sources: Array.from(sources).sort(),
                resolvedStyles
              };
            }
            __name(getStyleXData, "getStyleXData");
            function crawlData(data, sources, resolvedStyles) {
              if (data == null) {
                return;
              }
              if (src_isArray(data)) {
                data.forEach(function(entry) {
                  if (entry == null) {
                    return;
                  }
                  if (src_isArray(entry)) {
                    crawlData(entry, sources, resolvedStyles);
                  } else {
                    crawlObjectProperties(entry, sources, resolvedStyles);
                  }
                });
              } else {
                crawlObjectProperties(data, sources, resolvedStyles);
              }
              resolvedStyles = Object.fromEntries(Object.entries(resolvedStyles).sort());
            }
            __name(crawlData, "crawlData");
            function crawlObjectProperties(entry, sources, resolvedStyles) {
              var keys = Object.keys(entry);
              keys.forEach(function(key) {
                var value = entry[key];
                if (typeof value === "string") {
                  if (key === value) {
                    sources.add(key);
                  } else {
                    var propertyValue = getPropertyValueForStyleName(value);
                    if (propertyValue != null) {
                      resolvedStyles[key] = propertyValue;
                    }
                  }
                } else {
                  var nestedStyle = {};
                  resolvedStyles[key] = nestedStyle;
                  crawlData([value], sources, nestedStyle);
                }
              });
            }
            __name(crawlObjectProperties, "crawlObjectProperties");
            function getPropertyValueForStyleName(styleName) {
              if (cachedStyleNameToValueMap.has(styleName)) {
                return cachedStyleNameToValueMap.get(styleName);
              }
              for (var styleSheetIndex = 0; styleSheetIndex < document.styleSheets.length; styleSheetIndex++) {
                var styleSheet = document.styleSheets[styleSheetIndex];
                var rules = null;
                try {
                  rules = styleSheet.cssRules;
                } catch (_e) {
                  continue;
                }
                for (var ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
                  if (!(rules[ruleIndex] instanceof CSSStyleRule)) {
                    continue;
                  }
                  var rule = rules[ruleIndex];
                  var cssText = rule.cssText, selectorText = rule.selectorText, style = rule.style;
                  if (selectorText != null) {
                    if (selectorText.startsWith(".".concat(styleName))) {
                      var match = cssText.match(/{ *([a-z\-]+):/);
                      if (match !== null) {
                        var property = match[1];
                        var value = style.getPropertyValue(property);
                        cachedStyleNameToValueMap.set(styleName, value);
                        return value;
                      } else {
                        return null;
                      }
                    }
                  }
                }
              }
              return null;
            }
            __name(getPropertyValueForStyleName, "getPropertyValueForStyleName");
            ;
            var CHANGE_LOG_URL = "https://github.com/facebook/react/blob/main/packages/react-devtools/CHANGELOG.md";
            var UNSUPPORTED_VERSION_URL = "https://reactjs.org/blog/2019/08/15/new-react-devtools.html#how-do-i-get-the-old-version-back";
            var REACT_DEVTOOLS_WORKPLACE_URL = "https://fburl.com/react-devtools-workplace-group";
            var THEME_STYLES = {
              light: {
                "--color-attribute-name": "#ef6632",
                "--color-attribute-name-not-editable": "#23272f",
                "--color-attribute-name-inverted": "rgba(255, 255, 255, 0.7)",
                "--color-attribute-value": "#1a1aa6",
                "--color-attribute-value-inverted": "#ffffff",
                "--color-attribute-editable-value": "#1a1aa6",
                "--color-background": "#ffffff",
                "--color-background-hover": "rgba(0, 136, 250, 0.1)",
                "--color-background-inactive": "#e5e5e5",
                "--color-background-invalid": "#fff0f0",
                "--color-background-selected": "#0088fa",
                "--color-button-background": "#ffffff",
                "--color-button-background-focus": "#ededed",
                "--color-button-background-hover": "rgba(0, 0, 0, 0.2)",
                "--color-button": "#5f6673",
                "--color-button-disabled": "#cfd1d5",
                "--color-button-active": "#0088fa",
                "--color-button-focus": "#23272f",
                "--color-button-hover": "#23272f",
                "--color-border": "#eeeeee",
                "--color-commit-did-not-render-fill": "#cfd1d5",
                "--color-commit-did-not-render-fill-text": "#000000",
                "--color-commit-did-not-render-pattern": "#cfd1d5",
                "--color-commit-did-not-render-pattern-text": "#333333",
                "--color-commit-gradient-0": "#37afa9",
                "--color-commit-gradient-1": "#63b19e",
                "--color-commit-gradient-2": "#80b393",
                "--color-commit-gradient-3": "#97b488",
                "--color-commit-gradient-4": "#abb67d",
                "--color-commit-gradient-5": "#beb771",
                "--color-commit-gradient-6": "#cfb965",
                "--color-commit-gradient-7": "#dfba57",
                "--color-commit-gradient-8": "#efbb49",
                "--color-commit-gradient-9": "#febc38",
                "--color-commit-gradient-text": "#000000",
                "--color-component-name": "#6a51b2",
                "--color-component-name-inverted": "#ffffff",
                "--color-component-badge-background": "#e6e6e6",
                "--color-component-badge-background-inverted": "rgba(255, 255, 255, 0.25)",
                "--color-component-badge-count": "#777d88",
                "--color-component-badge-count-inverted": "rgba(255, 255, 255, 0.7)",
                "--color-console-error-badge-text": "#ffffff",
                "--color-console-error-background": "#fff0f0",
                "--color-console-error-border": "#ffd6d6",
                "--color-console-error-icon": "#eb3941",
                "--color-console-error-text": "#fe2e31",
                "--color-console-warning-badge-text": "#000000",
                "--color-console-warning-background": "#fffbe5",
                "--color-console-warning-border": "#fff5c1",
                "--color-console-warning-icon": "#f4bd00",
                "--color-console-warning-text": "#64460c",
                "--color-context-background": "rgba(0,0,0,.9)",
                "--color-context-background-hover": "rgba(255, 255, 255, 0.1)",
                "--color-context-background-selected": "#178fb9",
                "--color-context-border": "#3d424a",
                "--color-context-text": "#ffffff",
                "--color-context-text-selected": "#ffffff",
                "--color-dim": "#777d88",
                "--color-dimmer": "#cfd1d5",
                "--color-dimmest": "#eff0f1",
                "--color-error-background": "hsl(0, 100%, 97%)",
                "--color-error-border": "hsl(0, 100%, 92%)",
                "--color-error-text": "#ff0000",
                "--color-expand-collapse-toggle": "#777d88",
                "--color-forget-badge-background": "#2683e2",
                "--color-forget-badge-background-inverted": "#1a6bbc",
                "--color-forget-text": "#fff",
                "--color-link": "#0000ff",
                "--color-modal-background": "rgba(255, 255, 255, 0.75)",
                "--color-bridge-version-npm-background": "#eff0f1",
                "--color-bridge-version-npm-text": "#000000",
                "--color-bridge-version-number": "#0088fa",
                "--color-primitive-hook-badge-background": "#e5e5e5",
                "--color-primitive-hook-badge-text": "#5f6673",
                "--color-record-active": "#fc3a4b",
                "--color-record-hover": "#3578e5",
                "--color-record-inactive": "#0088fa",
                "--color-resize-bar": "#eeeeee",
                "--color-resize-bar-active": "#dcdcdc",
                "--color-resize-bar-border": "#d1d1d1",
                "--color-resize-bar-dot": "#333333",
                "--color-timeline-internal-module": "#d1d1d1",
                "--color-timeline-internal-module-hover": "#c9c9c9",
                "--color-timeline-internal-module-text": "#444",
                "--color-timeline-native-event": "#ccc",
                "--color-timeline-native-event-hover": "#aaa",
                "--color-timeline-network-primary": "#fcf3dc",
                "--color-timeline-network-primary-hover": "#f0e7d1",
                "--color-timeline-network-secondary": "#efc457",
                "--color-timeline-network-secondary-hover": "#e3ba52",
                "--color-timeline-priority-background": "#f6f6f6",
                "--color-timeline-priority-border": "#eeeeee",
                "--color-timeline-user-timing": "#c9cacd",
                "--color-timeline-user-timing-hover": "#93959a",
                "--color-timeline-react-idle": "#d3e5f6",
                "--color-timeline-react-idle-hover": "#c3d9ef",
                "--color-timeline-react-render": "#9fc3f3",
                "--color-timeline-react-render-hover": "#83afe9",
                "--color-timeline-react-render-text": "#11365e",
                "--color-timeline-react-commit": "#c88ff0",
                "--color-timeline-react-commit-hover": "#b281d6",
                "--color-timeline-react-commit-text": "#3e2c4a",
                "--color-timeline-react-layout-effects": "#b281d6",
                "--color-timeline-react-layout-effects-hover": "#9d71bd",
                "--color-timeline-react-layout-effects-text": "#3e2c4a",
                "--color-timeline-react-passive-effects": "#b281d6",
                "--color-timeline-react-passive-effects-hover": "#9d71bd",
                "--color-timeline-react-passive-effects-text": "#3e2c4a",
                "--color-timeline-react-schedule": "#9fc3f3",
                "--color-timeline-react-schedule-hover": "#2683E2",
                "--color-timeline-react-suspense-rejected": "#f1cc14",
                "--color-timeline-react-suspense-rejected-hover": "#ffdf37",
                "--color-timeline-react-suspense-resolved": "#a6e59f",
                "--color-timeline-react-suspense-resolved-hover": "#89d281",
                "--color-timeline-react-suspense-unresolved": "#c9cacd",
                "--color-timeline-react-suspense-unresolved-hover": "#93959a",
                "--color-timeline-thrown-error": "#ee1638",
                "--color-timeline-thrown-error-hover": "#da1030",
                "--color-timeline-text-color": "#000000",
                "--color-timeline-text-dim-color": "#ccc",
                "--color-timeline-react-work-border": "#eeeeee",
                "--color-timebar-background": "#f6f6f6",
                "--color-search-match": "yellow",
                "--color-search-match-current": "#f7923b",
                "--color-selected-tree-highlight-active": "rgba(0, 136, 250, 0.1)",
                "--color-selected-tree-highlight-inactive": "rgba(0, 0, 0, 0.05)",
                "--color-scroll-caret": "rgba(150, 150, 150, 0.5)",
                "--color-tab-selected-border": "#0088fa",
                "--color-text": "#000000",
                "--color-text-invalid": "#ff0000",
                "--color-text-selected": "#ffffff",
                "--color-toggle-background-invalid": "#fc3a4b",
                "--color-toggle-background-on": "#0088fa",
                "--color-toggle-background-off": "#cfd1d5",
                "--color-toggle-text": "#ffffff",
                "--color-warning-background": "#fb3655",
                "--color-warning-background-hover": "#f82042",
                "--color-warning-text-color": "#ffffff",
                "--color-warning-text-color-inverted": "#fd4d69",
                "--color-suspense-default": "#0088fa",
                "--color-transition-default": "#6a51b2",
                "--color-suspense-server": "#62bc6a",
                "--color-transition-server": "#3f7844",
                "--color-suspense-other": "#f3ce49",
                "--color-transition-other": "#917b2c",
                "--color-suspense-errored": "#d57066",
                "--color-scroll-thumb": "#c2c2c2",
                "--color-scroll-track": "#fafafa",
                "--color-tooltip-background": "rgba(0, 0, 0, 0.9)",
                "--color-tooltip-text": "#ffffff",
                "--elevation-4": "0 2px 4px -1px rgba(0,0,0,.2),0 4px 5px 0 rgba(0,0,0,.14),0 1px 10px 0 rgba(0,0,0,.12)"
              },
              dark: {
                "--color-attribute-name": "#9d87d2",
                "--color-attribute-name-not-editable": "#ededed",
                "--color-attribute-name-inverted": "#282828",
                "--color-attribute-value": "#cedae0",
                "--color-attribute-value-inverted": "#ffffff",
                "--color-attribute-editable-value": "yellow",
                "--color-background": "#282c34",
                "--color-background-hover": "rgba(255, 255, 255, 0.1)",
                "--color-background-inactive": "#3d424a",
                "--color-background-invalid": "#5c0000",
                "--color-background-selected": "#178fb9",
                "--color-button-background": "#282c34",
                "--color-button-background-focus": "#3d424a",
                "--color-button-background-hover": "rgba(255, 255, 255, 0.2)",
                "--color-button": "#afb3b9",
                "--color-button-active": "#61dafb",
                "--color-button-disabled": "#4f5766",
                "--color-button-focus": "#a2e9fc",
                "--color-button-hover": "#ededed",
                "--color-border": "#3d424a",
                "--color-commit-did-not-render-fill": "#777d88",
                "--color-commit-did-not-render-fill-text": "#000000",
                "--color-commit-did-not-render-pattern": "#666c77",
                "--color-commit-did-not-render-pattern-text": "#ffffff",
                "--color-commit-gradient-0": "#37afa9",
                "--color-commit-gradient-1": "#63b19e",
                "--color-commit-gradient-2": "#80b393",
                "--color-commit-gradient-3": "#97b488",
                "--color-commit-gradient-4": "#abb67d",
                "--color-commit-gradient-5": "#beb771",
                "--color-commit-gradient-6": "#cfb965",
                "--color-commit-gradient-7": "#dfba57",
                "--color-commit-gradient-8": "#efbb49",
                "--color-commit-gradient-9": "#febc38",
                "--color-commit-gradient-text": "#000000",
                "--color-component-name": "#61dafb",
                "--color-component-name-inverted": "#282828",
                "--color-component-badge-background": "#5e6167",
                "--color-component-badge-background-inverted": "#46494e",
                "--color-component-badge-count": "#8f949d",
                "--color-component-badge-count-inverted": "rgba(255, 255, 255, 0.85)",
                "--color-console-error-badge-text": "#000000",
                "--color-console-error-background": "#290000",
                "--color-console-error-border": "#5c0000",
                "--color-console-error-icon": "#eb3941",
                "--color-console-error-text": "#fc7f7f",
                "--color-console-warning-badge-text": "#000000",
                "--color-console-warning-background": "#332b00",
                "--color-console-warning-border": "#665500",
                "--color-console-warning-icon": "#f4bd00",
                "--color-console-warning-text": "#f5f2ed",
                "--color-context-background": "rgba(255,255,255,.95)",
                "--color-context-background-hover": "rgba(0, 136, 250, 0.1)",
                "--color-context-background-selected": "#0088fa",
                "--color-context-border": "#eeeeee",
                "--color-context-text": "#000000",
                "--color-context-text-selected": "#ffffff",
                "--color-dim": "#8f949d",
                "--color-dimmer": "#777d88",
                "--color-dimmest": "#4f5766",
                "--color-error-background": "#200",
                "--color-error-border": "#900",
                "--color-error-text": "#f55",
                "--color-expand-collapse-toggle": "#8f949d",
                "--color-forget-badge-background": "#2683e2",
                "--color-forget-badge-background-inverted": "#1a6bbc",
                "--color-forget-text": "#fff",
                "--color-link": "#61dafb",
                "--color-modal-background": "rgba(0, 0, 0, 0.75)",
                "--color-bridge-version-npm-background": "rgba(0, 0, 0, 0.25)",
                "--color-bridge-version-npm-text": "#ffffff",
                "--color-bridge-version-number": "yellow",
                "--color-primitive-hook-badge-background": "rgba(0, 0, 0, 0.25)",
                "--color-primitive-hook-badge-text": "rgba(255, 255, 255, 0.7)",
                "--color-record-active": "#fc3a4b",
                "--color-record-hover": "#a2e9fc",
                "--color-record-inactive": "#61dafb",
                "--color-resize-bar": "#282c34",
                "--color-resize-bar-active": "#31363f",
                "--color-resize-bar-border": "#3d424a",
                "--color-resize-bar-dot": "#cfd1d5",
                "--color-timeline-internal-module": "#303542",
                "--color-timeline-internal-module-hover": "#363b4a",
                "--color-timeline-internal-module-text": "#7f8899",
                "--color-timeline-native-event": "#b2b2b2",
                "--color-timeline-native-event-hover": "#949494",
                "--color-timeline-network-primary": "#fcf3dc",
                "--color-timeline-network-primary-hover": "#e3dbc5",
                "--color-timeline-network-secondary": "#efc457",
                "--color-timeline-network-secondary-hover": "#d6af4d",
                "--color-timeline-priority-background": "#1d2129",
                "--color-timeline-priority-border": "#282c34",
                "--color-timeline-user-timing": "#c9cacd",
                "--color-timeline-user-timing-hover": "#93959a",
                "--color-timeline-react-idle": "#3d485b",
                "--color-timeline-react-idle-hover": "#465269",
                "--color-timeline-react-render": "#2683E2",
                "--color-timeline-react-render-hover": "#1a76d4",
                "--color-timeline-react-render-text": "#11365e",
                "--color-timeline-react-commit": "#731fad",
                "--color-timeline-react-commit-hover": "#611b94",
                "--color-timeline-react-commit-text": "#e5c1ff",
                "--color-timeline-react-layout-effects": "#611b94",
                "--color-timeline-react-layout-effects-hover": "#51167a",
                "--color-timeline-react-layout-effects-text": "#e5c1ff",
                "--color-timeline-react-passive-effects": "#611b94",
                "--color-timeline-react-passive-effects-hover": "#51167a",
                "--color-timeline-react-passive-effects-text": "#e5c1ff",
                "--color-timeline-react-schedule": "#2683E2",
                "--color-timeline-react-schedule-hover": "#1a76d4",
                "--color-timeline-react-suspense-rejected": "#f1cc14",
                "--color-timeline-react-suspense-rejected-hover": "#e4c00f",
                "--color-timeline-react-suspense-resolved": "#a6e59f",
                "--color-timeline-react-suspense-resolved-hover": "#89d281",
                "--color-timeline-react-suspense-unresolved": "#c9cacd",
                "--color-timeline-react-suspense-unresolved-hover": "#93959a",
                "--color-timeline-thrown-error": "#fb3655",
                "--color-timeline-thrown-error-hover": "#f82042",
                "--color-timeline-text-color": "#282c34",
                "--color-timeline-text-dim-color": "#555b66",
                "--color-timeline-react-work-border": "#3d424a",
                "--color-timebar-background": "#1d2129",
                "--color-search-match": "yellow",
                "--color-search-match-current": "#f7923b",
                "--color-selected-tree-highlight-active": "rgba(23, 143, 185, 0.15)",
                "--color-selected-tree-highlight-inactive": "rgba(255, 255, 255, 0.05)",
                "--color-scroll-caret": "#4f5766",
                "--color-shadow": "rgba(0, 0, 0, 0.5)",
                "--color-tab-selected-border": "#178fb9",
                "--color-text": "#ffffff",
                "--color-text-invalid": "#ff8080",
                "--color-text-selected": "#ffffff",
                "--color-toggle-background-invalid": "#fc3a4b",
                "--color-toggle-background-on": "#178fb9",
                "--color-toggle-background-off": "#777d88",
                "--color-toggle-text": "#ffffff",
                "--color-warning-background": "#ee1638",
                "--color-warning-background-hover": "#da1030",
                "--color-warning-text-color": "#ffffff",
                "--color-warning-text-color-inverted": "#ee1638",
                "--color-suspense-default": "#61dafb",
                "--color-transition-default": "#6a51b2",
                "--color-suspense-server": "#62bc6a",
                "--color-transition-server": "#3f7844",
                "--color-suspense-other": "#f3ce49",
                "--color-transition-other": "#917b2c",
                "--color-suspense-errored": "#d57066",
                "--color-scroll-thumb": "#afb3b9",
                "--color-scroll-track": "#313640",
                "--color-tooltip-background": "rgba(255, 255, 255, 0.95)",
                "--color-tooltip-text": "#000000",
                "--elevation-4": "0 2px 8px 0 rgba(0,0,0,0.32),0 4px 12px 0 rgba(0,0,0,0.24),0 1px 10px 0 rgba(0,0,0,0.18)"
              },
              compact: {
                "--font-size-monospace-small": "9px",
                "--font-size-monospace-normal": "11px",
                "--font-size-monospace-large": "15px",
                "--font-size-sans-small": "10px",
                "--font-size-sans-normal": "12px",
                "--font-size-sans-large": "14px",
                "--line-height-data": "18px"
              },
              comfortable: {
                "--font-size-monospace-small": "10px",
                "--font-size-monospace-normal": "13px",
                "--font-size-monospace-large": "17px",
                "--font-size-sans-small": "12px",
                "--font-size-sans-normal": "14px",
                "--font-size-sans-large": "16px",
                "--line-height-data": "22px"
              }
            };
            var COMFORTABLE_LINE_HEIGHT = parseInt(THEME_STYLES.comfortable["--line-height-data"], 10);
            var COMPACT_LINE_HEIGHT = parseInt(THEME_STYLES.compact["--line-height-data"], 10);
            ;
            var REACT_TOTAL_NUM_LANES = 31;
            var SCHEDULING_PROFILER_VERSION = 1;
            var SNAPSHOT_MAX_HEIGHT = 60;
            ;
            function profilingHooks_slicedToArray(arr, i) {
              return profilingHooks_arrayWithHoles(arr) || profilingHooks_iterableToArrayLimit(arr, i) || profilingHooks_unsupportedIterableToArray(arr, i) || profilingHooks_nonIterableRest();
            }
            __name(profilingHooks_slicedToArray, "profilingHooks_slicedToArray");
            function profilingHooks_nonIterableRest() {
              throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
            }
            __name(profilingHooks_nonIterableRest, "profilingHooks_nonIterableRest");
            function profilingHooks_unsupportedIterableToArray(o, minLen) {
              if (!o) return;
              if (typeof o === "string") return profilingHooks_arrayLikeToArray(o, minLen);
              var n = Object.prototype.toString.call(o).slice(8, -1);
              if (n === "Object" && o.constructor) n = o.constructor.name;
              if (n === "Map" || n === "Set") return Array.from(o);
              if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return profilingHooks_arrayLikeToArray(o, minLen);
            }
            __name(profilingHooks_unsupportedIterableToArray, "profilingHooks_unsupportedIterableToArray");
            function profilingHooks_arrayLikeToArray(arr, len) {
              if (len == null || len > arr.length) len = arr.length;
              for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i];
              return arr2;
            }
            __name(profilingHooks_arrayLikeToArray, "profilingHooks_arrayLikeToArray");
            function profilingHooks_iterableToArrayLimit(r, l) {
              var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"];
              if (null != t) {
                var e, n, i, u, a = [], f = true, o = false;
                try {
                  if (i = (t = t.call(r)).next, 0 === l) {
                    if (Object(t) !== t) return;
                    f = false;
                  } else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = true) ;
                } catch (r2) {
                  o = true, n = r2;
                } finally {
                  try {
                    if (!f && null != t.return && (u = t.return(), Object(u) !== u)) return;
                  } finally {
                    if (o) throw n;
                  }
                }
                return a;
              }
            }
            __name(profilingHooks_iterableToArrayLimit, "profilingHooks_iterableToArrayLimit");
            function profilingHooks_arrayWithHoles(arr) {
              if (Array.isArray(arr)) return arr;
            }
            __name(profilingHooks_arrayWithHoles, "profilingHooks_arrayWithHoles");
            function profilingHooks_typeof(o) {
              "@babel/helpers - typeof";
              return profilingHooks_typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                return typeof o2;
              } : function(o2) {
                return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
              }, profilingHooks_typeof(o);
            }
            __name(profilingHooks_typeof, "profilingHooks_typeof");
            var TIME_OFFSET = 10;
            var performanceTarget = null;
            var supportsUserTiming = typeof performance !== "undefined" && typeof performance.mark === "function" && typeof performance.clearMarks === "function";
            var supportsUserTimingV3 = false;
            if (supportsUserTiming) {
              var CHECK_V3_MARK = "__v3";
              var markOptions = {};
              Object.defineProperty(markOptions, "startTime", {
                get: /* @__PURE__ */ __name(function get() {
                  supportsUserTimingV3 = true;
                  return 0;
                }, "get"),
                set: /* @__PURE__ */ __name(function set() {
                }, "set")
              });
              try {
                performance.mark(CHECK_V3_MARK, markOptions);
              } catch (error) {
              } finally {
                performance.clearMarks(CHECK_V3_MARK);
              }
            }
            if (supportsUserTimingV3) {
              performanceTarget = performance;
            }
            var profilingHooks_getCurrentTime = (typeof performance === "undefined" ? "undefined" : profilingHooks_typeof(performance)) === "object" && typeof performance.now === "function" ? function() {
              return performance.now();
            } : function() {
              return Date.now();
            };
            function setPerformanceMock_ONLY_FOR_TESTING(performanceMock) {
              performanceTarget = performanceMock;
              supportsUserTiming = performanceMock !== null;
              supportsUserTimingV3 = performanceMock !== null;
            }
            __name(setPerformanceMock_ONLY_FOR_TESTING, "setPerformanceMock_ONLY_FOR_TESTING");
            function createProfilingHooks(_ref) {
              var getDisplayNameForFiber = _ref.getDisplayNameForFiber, getIsProfiling = _ref.getIsProfiling, getLaneLabelMap = _ref.getLaneLabelMap, workTagMap = _ref.workTagMap, currentDispatcherRef = _ref.currentDispatcherRef, reactVersion = _ref.reactVersion;
              var currentBatchUID = 0;
              var currentReactComponentMeasure = null;
              var currentReactMeasuresStack = [];
              var currentTimelineData = null;
              var currentFiberStacks = /* @__PURE__ */ new Map();
              var isProfiling = false;
              var nextRenderShouldStartNewBatch = false;
              function getRelativeTime() {
                var currentTime = profilingHooks_getCurrentTime();
                if (currentTimelineData) {
                  if (currentTimelineData.startTime === 0) {
                    currentTimelineData.startTime = currentTime - TIME_OFFSET;
                  }
                  return currentTime - currentTimelineData.startTime;
                }
                return 0;
              }
              __name(getRelativeTime, "getRelativeTime");
              function getInternalModuleRanges() {
                if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== "undefined" && typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.getInternalModuleRanges === "function") {
                  var ranges = __REACT_DEVTOOLS_GLOBAL_HOOK__.getInternalModuleRanges();
                  if (shared_isArray(ranges)) {
                    return ranges;
                  }
                }
                return null;
              }
              __name(getInternalModuleRanges, "getInternalModuleRanges");
              function getTimelineData() {
                return currentTimelineData;
              }
              __name(getTimelineData, "getTimelineData");
              function laneToLanesArray(lanes) {
                var lanesArray = [];
                var lane = 1;
                for (var index = 0; index < REACT_TOTAL_NUM_LANES; index++) {
                  if (lane & lanes) {
                    lanesArray.push(lane);
                  }
                  lane *= 2;
                }
                return lanesArray;
              }
              __name(laneToLanesArray, "laneToLanesArray");
              var laneToLabelMap = typeof getLaneLabelMap === "function" ? getLaneLabelMap() : null;
              function markMetadata() {
                markAndClear("--react-version-".concat(reactVersion));
                markAndClear("--profiler-version-".concat(SCHEDULING_PROFILER_VERSION));
                var ranges = getInternalModuleRanges();
                if (ranges) {
                  for (var i = 0; i < ranges.length; i++) {
                    var range = ranges[i];
                    if (shared_isArray(range) && range.length === 2) {
                      var _ranges$i = profilingHooks_slicedToArray(ranges[i], 2), startStackFrame = _ranges$i[0], stopStackFrame = _ranges$i[1];
                      markAndClear("--react-internal-module-start-".concat(startStackFrame));
                      markAndClear("--react-internal-module-stop-".concat(stopStackFrame));
                    }
                  }
                }
                if (laneToLabelMap != null) {
                  var labels = Array.from(laneToLabelMap.values()).join(",");
                  markAndClear("--react-lane-labels-".concat(labels));
                }
              }
              __name(markMetadata, "markMetadata");
              function markAndClear(markName) {
                performanceTarget.mark(markName);
                performanceTarget.clearMarks(markName);
              }
              __name(markAndClear, "markAndClear");
              function recordReactMeasureStarted(type, lanes) {
                var depth = 0;
                if (currentReactMeasuresStack.length > 0) {
                  var top = currentReactMeasuresStack[currentReactMeasuresStack.length - 1];
                  depth = top.type === "render-idle" ? top.depth : top.depth + 1;
                }
                var lanesArray = laneToLanesArray(lanes);
                var reactMeasure = {
                  type,
                  batchUID: currentBatchUID,
                  depth,
                  lanes: lanesArray,
                  timestamp: getRelativeTime(),
                  duration: 0
                };
                currentReactMeasuresStack.push(reactMeasure);
                if (currentTimelineData) {
                  var _currentTimelineData = currentTimelineData, batchUIDToMeasuresMap = _currentTimelineData.batchUIDToMeasuresMap, laneToReactMeasureMap = _currentTimelineData.laneToReactMeasureMap;
                  var reactMeasures = batchUIDToMeasuresMap.get(currentBatchUID);
                  if (reactMeasures != null) {
                    reactMeasures.push(reactMeasure);
                  } else {
                    batchUIDToMeasuresMap.set(currentBatchUID, [reactMeasure]);
                  }
                  lanesArray.forEach(function(lane) {
                    reactMeasures = laneToReactMeasureMap.get(lane);
                    if (reactMeasures) {
                      reactMeasures.push(reactMeasure);
                    }
                  });
                }
              }
              __name(recordReactMeasureStarted, "recordReactMeasureStarted");
              function recordReactMeasureCompleted(type) {
                var currentTime = getRelativeTime();
                if (currentReactMeasuresStack.length === 0) {
                  console.error('Unexpected type "%s" completed at %sms while currentReactMeasuresStack is empty.', type, currentTime);
                  return;
                }
                var top = currentReactMeasuresStack.pop();
                if (top.type !== type) {
                  console.error('Unexpected type "%s" completed at %sms before "%s" completed.', type, currentTime, top.type);
                }
                top.duration = currentTime - top.timestamp;
                if (currentTimelineData) {
                  currentTimelineData.duration = getRelativeTime() + TIME_OFFSET;
                }
              }
              __name(recordReactMeasureCompleted, "recordReactMeasureCompleted");
              function markCommitStarted(lanes) {
                if (!isProfiling) {
                  return;
                }
                recordReactMeasureStarted("commit", lanes);
                nextRenderShouldStartNewBatch = true;
                if (supportsUserTimingV3) {
                  markAndClear("--commit-start-".concat(lanes));
                  markMetadata();
                }
              }
              __name(markCommitStarted, "markCommitStarted");
              function markCommitStopped() {
                if (!isProfiling) {
                  return;
                }
                recordReactMeasureCompleted("commit");
                recordReactMeasureCompleted("render-idle");
                if (supportsUserTimingV3) {
                  markAndClear("--commit-stop");
                }
              }
              __name(markCommitStopped, "markCommitStopped");
              function markComponentRenderStarted(fiber) {
                if (!isProfiling) {
                  return;
                }
                var componentName = getDisplayNameForFiber(fiber) || "Unknown";
                currentReactComponentMeasure = {
                  componentName,
                  duration: 0,
                  timestamp: getRelativeTime(),
                  type: "render",
                  warning: null
                };
                if (supportsUserTimingV3) {
                  markAndClear("--component-render-start-".concat(componentName));
                }
              }
              __name(markComponentRenderStarted, "markComponentRenderStarted");
              function markComponentRenderStopped() {
                if (!isProfiling) {
                  return;
                }
                if (currentReactComponentMeasure) {
                  if (currentTimelineData) {
                    currentTimelineData.componentMeasures.push(currentReactComponentMeasure);
                  }
                  currentReactComponentMeasure.duration = getRelativeTime() - currentReactComponentMeasure.timestamp;
                  currentReactComponentMeasure = null;
                }
                if (supportsUserTimingV3) {
                  markAndClear("--component-render-stop");
                }
              }
              __name(markComponentRenderStopped, "markComponentRenderStopped");
              function markComponentLayoutEffectMountStarted(fiber) {
                if (!isProfiling) {
                  return;
                }
                var componentName = getDisplayNameForFiber(fiber) || "Unknown";
                currentReactComponentMeasure = {
                  componentName,
                  duration: 0,
                  timestamp: getRelativeTime(),
                  type: "layout-effect-mount",
                  warning: null
                };
                if (supportsUserTimingV3) {
                  markAndClear("--component-layout-effect-mount-start-".concat(componentName));
                }
              }
              __name(markComponentLayoutEffectMountStarted, "markComponentLayoutEffectMountStarted");
              function markComponentLayoutEffectMountStopped() {
                if (!isProfiling) {
                  return;
                }
                if (currentReactComponentMeasure) {
                  if (currentTimelineData) {
                    currentTimelineData.componentMeasures.push(currentReactComponentMeasure);
                  }
                  currentReactComponentMeasure.duration = getRelativeTime() - currentReactComponentMeasure.timestamp;
                  currentReactComponentMeasure = null;
                }
                if (supportsUserTimingV3) {
                  markAndClear("--component-layout-effect-mount-stop");
                }
              }
              __name(markComponentLayoutEffectMountStopped, "markComponentLayoutEffectMountStopped");
              function markComponentLayoutEffectUnmountStarted(fiber) {
                if (!isProfiling) {
                  return;
                }
                var componentName = getDisplayNameForFiber(fiber) || "Unknown";
                currentReactComponentMeasure = {
                  componentName,
                  duration: 0,
                  timestamp: getRelativeTime(),
                  type: "layout-effect-unmount",
                  warning: null
                };
                if (supportsUserTimingV3) {
                  markAndClear("--component-layout-effect-unmount-start-".concat(componentName));
                }
              }
              __name(markComponentLayoutEffectUnmountStarted, "markComponentLayoutEffectUnmountStarted");
              function markComponentLayoutEffectUnmountStopped() {
                if (!isProfiling) {
                  return;
                }
                if (currentReactComponentMeasure) {
                  if (currentTimelineData) {
                    currentTimelineData.componentMeasures.push(currentReactComponentMeasure);
                  }
                  currentReactComponentMeasure.duration = getRelativeTime() - currentReactComponentMeasure.timestamp;
                  currentReactComponentMeasure = null;
                }
                if (supportsUserTimingV3) {
                  markAndClear("--component-layout-effect-unmount-stop");
                }
              }
              __name(markComponentLayoutEffectUnmountStopped, "markComponentLayoutEffectUnmountStopped");
              function markComponentPassiveEffectMountStarted(fiber) {
                if (!isProfiling) {
                  return;
                }
                var componentName = getDisplayNameForFiber(fiber) || "Unknown";
                currentReactComponentMeasure = {
                  componentName,
                  duration: 0,
                  timestamp: getRelativeTime(),
                  type: "passive-effect-mount",
                  warning: null
                };
                if (supportsUserTimingV3) {
                  markAndClear("--component-passive-effect-mount-start-".concat(componentName));
                }
              }
              __name(markComponentPassiveEffectMountStarted, "markComponentPassiveEffectMountStarted");
              function markComponentPassiveEffectMountStopped() {
                if (!isProfiling) {
                  return;
                }
                if (currentReactComponentMeasure) {
                  if (currentTimelineData) {
                    currentTimelineData.componentMeasures.push(currentReactComponentMeasure);
                  }
                  currentReactComponentMeasure.duration = getRelativeTime() - currentReactComponentMeasure.timestamp;
                  currentReactComponentMeasure = null;
                }
                if (supportsUserTimingV3) {
                  markAndClear("--component-passive-effect-mount-stop");
                }
              }
              __name(markComponentPassiveEffectMountStopped, "markComponentPassiveEffectMountStopped");
              function markComponentPassiveEffectUnmountStarted(fiber) {
                if (!isProfiling) {
                  return;
                }
                var componentName = getDisplayNameForFiber(fiber) || "Unknown";
                currentReactComponentMeasure = {
                  componentName,
                  duration: 0,
                  timestamp: getRelativeTime(),
                  type: "passive-effect-unmount",
                  warning: null
                };
                if (supportsUserTimingV3) {
                  markAndClear("--component-passive-effect-unmount-start-".concat(componentName));
                }
              }
              __name(markComponentPassiveEffectUnmountStarted, "markComponentPassiveEffectUnmountStarted");
              function markComponentPassiveEffectUnmountStopped() {
                if (!isProfiling) {
                  return;
                }
                if (currentReactComponentMeasure) {
                  if (currentTimelineData) {
                    currentTimelineData.componentMeasures.push(currentReactComponentMeasure);
                  }
                  currentReactComponentMeasure.duration = getRelativeTime() - currentReactComponentMeasure.timestamp;
                  currentReactComponentMeasure = null;
                }
                if (supportsUserTimingV3) {
                  markAndClear("--component-passive-effect-unmount-stop");
                }
              }
              __name(markComponentPassiveEffectUnmountStopped, "markComponentPassiveEffectUnmountStopped");
              function markComponentErrored(fiber, thrownValue, lanes) {
                if (!isProfiling) {
                  return;
                }
                var componentName = getDisplayNameForFiber(fiber) || "Unknown";
                var phase = fiber.alternate === null ? "mount" : "update";
                var message = "";
                if (thrownValue !== null && profilingHooks_typeof(thrownValue) === "object" && typeof thrownValue.message === "string") {
                  message = thrownValue.message;
                } else if (typeof thrownValue === "string") {
                  message = thrownValue;
                }
                if (currentTimelineData) {
                  currentTimelineData.thrownErrors.push({
                    componentName,
                    message,
                    phase,
                    timestamp: getRelativeTime(),
                    type: "thrown-error"
                  });
                }
                if (supportsUserTimingV3) {
                  markAndClear("--error-".concat(componentName, "-").concat(phase, "-").concat(message));
                }
              }
              __name(markComponentErrored, "markComponentErrored");
              var PossiblyWeakMap2 = typeof WeakMap === "function" ? WeakMap : Map;
              var wakeableIDs = new PossiblyWeakMap2();
              var wakeableID = 0;
              function getWakeableID(wakeable) {
                if (!wakeableIDs.has(wakeable)) {
                  wakeableIDs.set(wakeable, wakeableID++);
                }
                return wakeableIDs.get(wakeable);
              }
              __name(getWakeableID, "getWakeableID");
              function markComponentSuspended(fiber, wakeable, lanes) {
                if (!isProfiling) {
                  return;
                }
                var eventType = wakeableIDs.has(wakeable) ? "resuspend" : "suspend";
                var id = getWakeableID(wakeable);
                var componentName = getDisplayNameForFiber(fiber) || "Unknown";
                var phase = fiber.alternate === null ? "mount" : "update";
                var displayName = wakeable.displayName || "";
                var suspenseEvent = null;
                suspenseEvent = {
                  componentName,
                  depth: 0,
                  duration: 0,
                  id: "".concat(id),
                  phase,
                  promiseName: displayName,
                  resolution: "unresolved",
                  timestamp: getRelativeTime(),
                  type: "suspense",
                  warning: null
                };
                if (currentTimelineData) {
                  currentTimelineData.suspenseEvents.push(suspenseEvent);
                }
                if (supportsUserTimingV3) {
                  markAndClear("--suspense-".concat(eventType, "-").concat(id, "-").concat(componentName, "-").concat(phase, "-").concat(lanes, "-").concat(displayName));
                  wakeable.then(function() {
                    if (suspenseEvent) {
                      suspenseEvent.duration = getRelativeTime() - suspenseEvent.timestamp;
                      suspenseEvent.resolution = "resolved";
                    }
                    if (supportsUserTimingV3) {
                      markAndClear("--suspense-resolved-".concat(id, "-").concat(componentName));
                    }
                  }, function() {
                    if (suspenseEvent) {
                      suspenseEvent.duration = getRelativeTime() - suspenseEvent.timestamp;
                      suspenseEvent.resolution = "rejected";
                    }
                    if (supportsUserTimingV3) {
                      markAndClear("--suspense-rejected-".concat(id, "-").concat(componentName));
                    }
                  });
                }
              }
              __name(markComponentSuspended, "markComponentSuspended");
              function markLayoutEffectsStarted(lanes) {
                if (!isProfiling) {
                  return;
                }
                recordReactMeasureStarted("layout-effects", lanes);
                if (supportsUserTimingV3) {
                  markAndClear("--layout-effects-start-".concat(lanes));
                }
              }
              __name(markLayoutEffectsStarted, "markLayoutEffectsStarted");
              function markLayoutEffectsStopped() {
                if (!isProfiling) {
                  return;
                }
                recordReactMeasureCompleted("layout-effects");
                if (supportsUserTimingV3) {
                  markAndClear("--layout-effects-stop");
                }
              }
              __name(markLayoutEffectsStopped, "markLayoutEffectsStopped");
              function markPassiveEffectsStarted(lanes) {
                if (!isProfiling) {
                  return;
                }
                recordReactMeasureStarted("passive-effects", lanes);
                if (supportsUserTimingV3) {
                  markAndClear("--passive-effects-start-".concat(lanes));
                }
              }
              __name(markPassiveEffectsStarted, "markPassiveEffectsStarted");
              function markPassiveEffectsStopped() {
                if (!isProfiling) {
                  return;
                }
                recordReactMeasureCompleted("passive-effects");
                if (supportsUserTimingV3) {
                  markAndClear("--passive-effects-stop");
                }
              }
              __name(markPassiveEffectsStopped, "markPassiveEffectsStopped");
              function markRenderStarted(lanes) {
                if (!isProfiling) {
                  return;
                }
                if (nextRenderShouldStartNewBatch) {
                  nextRenderShouldStartNewBatch = false;
                  currentBatchUID++;
                }
                if (currentReactMeasuresStack.length === 0 || currentReactMeasuresStack[currentReactMeasuresStack.length - 1].type !== "render-idle") {
                  recordReactMeasureStarted("render-idle", lanes);
                }
                recordReactMeasureStarted("render", lanes);
                if (supportsUserTimingV3) {
                  markAndClear("--render-start-".concat(lanes));
                }
              }
              __name(markRenderStarted, "markRenderStarted");
              function markRenderYielded() {
                if (!isProfiling) {
                  return;
                }
                recordReactMeasureCompleted("render");
                if (supportsUserTimingV3) {
                  markAndClear("--render-yield");
                }
              }
              __name(markRenderYielded, "markRenderYielded");
              function markRenderStopped() {
                if (!isProfiling) {
                  return;
                }
                recordReactMeasureCompleted("render");
                if (supportsUserTimingV3) {
                  markAndClear("--render-stop");
                }
              }
              __name(markRenderStopped, "markRenderStopped");
              function markRenderScheduled(lane) {
                if (!isProfiling) {
                  return;
                }
                if (currentTimelineData) {
                  currentTimelineData.schedulingEvents.push({
                    lanes: laneToLanesArray(lane),
                    timestamp: getRelativeTime(),
                    type: "schedule-render",
                    warning: null
                  });
                }
                if (supportsUserTimingV3) {
                  markAndClear("--schedule-render-".concat(lane));
                }
              }
              __name(markRenderScheduled, "markRenderScheduled");
              function markForceUpdateScheduled(fiber, lane) {
                if (!isProfiling) {
                  return;
                }
                var componentName = getDisplayNameForFiber(fiber) || "Unknown";
                if (currentTimelineData) {
                  currentTimelineData.schedulingEvents.push({
                    componentName,
                    lanes: laneToLanesArray(lane),
                    timestamp: getRelativeTime(),
                    type: "schedule-force-update",
                    warning: null
                  });
                }
                if (supportsUserTimingV3) {
                  markAndClear("--schedule-forced-update-".concat(lane, "-").concat(componentName));
                }
              }
              __name(markForceUpdateScheduled, "markForceUpdateScheduled");
              function getParentFibers(fiber) {
                var parents = [];
                var parent = fiber;
                while (parent !== null) {
                  parents.push(parent);
                  parent = parent.return;
                }
                return parents;
              }
              __name(getParentFibers, "getParentFibers");
              function markStateUpdateScheduled(fiber, lane) {
                if (!isProfiling) {
                  return;
                }
                var componentName = getDisplayNameForFiber(fiber) || "Unknown";
                if (currentTimelineData) {
                  var event = {
                    componentName,
                    lanes: laneToLanesArray(lane),
                    timestamp: getRelativeTime(),
                    type: "schedule-state-update",
                    warning: null
                  };
                  currentFiberStacks.set(event, getParentFibers(fiber));
                  currentTimelineData.schedulingEvents.push(event);
                }
                if (supportsUserTimingV3) {
                  markAndClear("--schedule-state-update-".concat(lane, "-").concat(componentName));
                }
              }
              __name(markStateUpdateScheduled, "markStateUpdateScheduled");
              function toggleProfilingStatus(value) {
                var recordTimeline = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : false;
                if (isProfiling !== value) {
                  isProfiling = value;
                  if (isProfiling) {
                    var internalModuleSourceToRanges = /* @__PURE__ */ new Map();
                    if (supportsUserTimingV3) {
                      var ranges = getInternalModuleRanges();
                      if (ranges) {
                        for (var i = 0; i < ranges.length; i++) {
                          var range = ranges[i];
                          if (shared_isArray(range) && range.length === 2) {
                            var _ranges$i2 = profilingHooks_slicedToArray(ranges[i], 2), startStackFrame = _ranges$i2[0], stopStackFrame = _ranges$i2[1];
                            markAndClear("--react-internal-module-start-".concat(startStackFrame));
                            markAndClear("--react-internal-module-stop-".concat(stopStackFrame));
                          }
                        }
                      }
                    }
                    var laneToReactMeasureMap = /* @__PURE__ */ new Map();
                    var lane = 1;
                    for (var index = 0; index < REACT_TOTAL_NUM_LANES; index++) {
                      laneToReactMeasureMap.set(lane, []);
                      lane *= 2;
                    }
                    currentBatchUID = 0;
                    currentReactComponentMeasure = null;
                    currentReactMeasuresStack = [];
                    currentFiberStacks = /* @__PURE__ */ new Map();
                    if (recordTimeline) {
                      currentTimelineData = {
                        internalModuleSourceToRanges,
                        laneToLabelMap: laneToLabelMap || /* @__PURE__ */ new Map(),
                        reactVersion,
                        componentMeasures: [],
                        schedulingEvents: [],
                        suspenseEvents: [],
                        thrownErrors: [],
                        batchUIDToMeasuresMap: /* @__PURE__ */ new Map(),
                        duration: 0,
                        laneToReactMeasureMap,
                        startTime: 0,
                        flamechart: [],
                        nativeEvents: [],
                        networkMeasures: [],
                        otherUserTimingMarks: [],
                        snapshots: [],
                        snapshotHeight: 0
                      };
                    }
                    nextRenderShouldStartNewBatch = true;
                  } else {
                    if (currentTimelineData !== null) {
                      currentTimelineData.schedulingEvents.forEach(function(event) {
                        if (event.type === "schedule-state-update") {
                          var fiberStack = currentFiberStacks.get(event);
                          if (fiberStack && currentDispatcherRef != null) {
                            event.componentStack = fiberStack.reduce(function(trace, fiber) {
                              return trace + describeFiber(workTagMap, fiber, currentDispatcherRef);
                            }, "");
                          }
                        }
                      });
                    }
                    currentFiberStacks.clear();
                  }
                }
              }
              __name(toggleProfilingStatus, "toggleProfilingStatus");
              return {
                getTimelineData,
                profilingHooks: {
                  markCommitStarted,
                  markCommitStopped,
                  markComponentRenderStarted,
                  markComponentRenderStopped,
                  markComponentPassiveEffectMountStarted,
                  markComponentPassiveEffectMountStopped,
                  markComponentPassiveEffectUnmountStarted,
                  markComponentPassiveEffectUnmountStopped,
                  markComponentLayoutEffectMountStarted,
                  markComponentLayoutEffectMountStopped,
                  markComponentLayoutEffectUnmountStarted,
                  markComponentLayoutEffectUnmountStopped,
                  markComponentErrored,
                  markComponentSuspended,
                  markLayoutEffectsStarted,
                  markLayoutEffectsStopped,
                  markPassiveEffectsStarted,
                  markPassiveEffectsStopped,
                  markRenderStarted,
                  markRenderYielded,
                  markRenderStopped,
                  markRenderScheduled,
                  markForceUpdateScheduled,
                  markStateUpdateScheduled
                },
                toggleProfilingStatus
              };
            }
            __name(createProfilingHooks, "createProfilingHooks");
            ;
            var _excluded = ["batchUIDToMeasuresMap", "internalModuleSourceToRanges", "laneToLabelMap", "laneToReactMeasureMap"];
            function _objectWithoutProperties(source, excluded) {
              if (source == null) return {};
              var target = _objectWithoutPropertiesLoose(source, excluded);
              var key, i;
              if (Object.getOwnPropertySymbols) {
                var sourceSymbolKeys = Object.getOwnPropertySymbols(source);
                for (i = 0; i < sourceSymbolKeys.length; i++) {
                  key = sourceSymbolKeys[i];
                  if (excluded.indexOf(key) >= 0) continue;
                  if (!Object.prototype.propertyIsEnumerable.call(source, key)) continue;
                  target[key] = source[key];
                }
              }
              return target;
            }
            __name(_objectWithoutProperties, "_objectWithoutProperties");
            function _objectWithoutPropertiesLoose(source, excluded) {
              if (source == null) return {};
              var target = {};
              for (var key in source) {
                if (Object.prototype.hasOwnProperty.call(source, key)) {
                  if (excluded.indexOf(key) >= 0) continue;
                  target[key] = source[key];
                }
              }
              return target;
            }
            __name(_objectWithoutPropertiesLoose, "_objectWithoutPropertiesLoose");
            function renderer_ownKeys(e, r) {
              var t = Object.keys(e);
              if (Object.getOwnPropertySymbols) {
                var o = Object.getOwnPropertySymbols(e);
                r && (o = o.filter(function(r2) {
                  return Object.getOwnPropertyDescriptor(e, r2).enumerable;
                })), t.push.apply(t, o);
              }
              return t;
            }
            __name(renderer_ownKeys, "renderer_ownKeys");
            function renderer_objectSpread(e) {
              for (var r = 1; r < arguments.length; r++) {
                var t = null != arguments[r] ? arguments[r] : {};
                r % 2 ? renderer_ownKeys(Object(t), true).forEach(function(r2) {
                  renderer_defineProperty(e, r2, t[r2]);
                }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : renderer_ownKeys(Object(t)).forEach(function(r2) {
                  Object.defineProperty(e, r2, Object.getOwnPropertyDescriptor(t, r2));
                });
              }
              return e;
            }
            __name(renderer_objectSpread, "renderer_objectSpread");
            function renderer_defineProperty(obj, key, value) {
              key = renderer_toPropertyKey(key);
              if (key in obj) {
                Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
              } else {
                obj[key] = value;
              }
              return obj;
            }
            __name(renderer_defineProperty, "renderer_defineProperty");
            function renderer_toPropertyKey(t) {
              var i = renderer_toPrimitive(t, "string");
              return "symbol" == renderer_typeof(i) ? i : i + "";
            }
            __name(renderer_toPropertyKey, "renderer_toPropertyKey");
            function renderer_toPrimitive(t, r) {
              if ("object" != renderer_typeof(t) || !t) return t;
              var e = t[Symbol.toPrimitive];
              if (void 0 !== e) {
                var i = e.call(t, r || "default");
                if ("object" != renderer_typeof(i)) return i;
                throw new TypeError("@@toPrimitive must return a primitive value.");
              }
              return ("string" === r ? String : Number)(t);
            }
            __name(renderer_toPrimitive, "renderer_toPrimitive");
            function fiber_renderer_toConsumableArray(arr) {
              return fiber_renderer_arrayWithoutHoles(arr) || fiber_renderer_iterableToArray(arr) || fiber_renderer_unsupportedIterableToArray(arr) || fiber_renderer_nonIterableSpread();
            }
            __name(fiber_renderer_toConsumableArray, "fiber_renderer_toConsumableArray");
            function fiber_renderer_nonIterableSpread() {
              throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
            }
            __name(fiber_renderer_nonIterableSpread, "fiber_renderer_nonIterableSpread");
            function fiber_renderer_iterableToArray(iter) {
              if (typeof Symbol !== "undefined" && iter[Symbol.iterator] != null || iter["@@iterator"] != null) return Array.from(iter);
            }
            __name(fiber_renderer_iterableToArray, "fiber_renderer_iterableToArray");
            function fiber_renderer_arrayWithoutHoles(arr) {
              if (Array.isArray(arr)) return fiber_renderer_arrayLikeToArray(arr);
            }
            __name(fiber_renderer_arrayWithoutHoles, "fiber_renderer_arrayWithoutHoles");
            function _createForOfIteratorHelper(o, allowArrayLike) {
              var it = typeof Symbol !== "undefined" && o[Symbol.iterator] || o["@@iterator"];
              if (!it) {
                if (Array.isArray(o) || (it = fiber_renderer_unsupportedIterableToArray(o)) || allowArrayLike && o && typeof o.length === "number") {
                  if (it) o = it;
                  var i = 0;
                  var F = /* @__PURE__ */ __name(function F2() {
                  }, "F");
                  return { s: F, n: /* @__PURE__ */ __name(function n() {
                    if (i >= o.length) return { done: true };
                    return { done: false, value: o[i++] };
                  }, "n"), e: /* @__PURE__ */ __name(function e(_e) {
                    throw _e;
                  }, "e"), f: F };
                }
                throw new TypeError("Invalid attempt to iterate non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
              }
              var normalCompletion = true, didErr = false, err;
              return { s: /* @__PURE__ */ __name(function s() {
                it = it.call(o);
              }, "s"), n: /* @__PURE__ */ __name(function n() {
                var step = it.next();
                normalCompletion = step.done;
                return step;
              }, "n"), e: /* @__PURE__ */ __name(function e(_e2) {
                didErr = true;
                err = _e2;
              }, "e"), f: /* @__PURE__ */ __name(function f() {
                try {
                  if (!normalCompletion && it.return != null) it.return();
                } finally {
                  if (didErr) throw err;
                }
              }, "f") };
            }
            __name(_createForOfIteratorHelper, "_createForOfIteratorHelper");
            function fiber_renderer_unsupportedIterableToArray(o, minLen) {
              if (!o) return;
              if (typeof o === "string") return fiber_renderer_arrayLikeToArray(o, minLen);
              var n = Object.prototype.toString.call(o).slice(8, -1);
              if (n === "Object" && o.constructor) n = o.constructor.name;
              if (n === "Map" || n === "Set") return Array.from(o);
              if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return fiber_renderer_arrayLikeToArray(o, minLen);
            }
            __name(fiber_renderer_unsupportedIterableToArray, "fiber_renderer_unsupportedIterableToArray");
            function fiber_renderer_arrayLikeToArray(arr, len) {
              if (len == null || len > arr.length) len = arr.length;
              for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i];
              return arr2;
            }
            __name(fiber_renderer_arrayLikeToArray, "fiber_renderer_arrayLikeToArray");
            function renderer_typeof(o) {
              "@babel/helpers - typeof";
              return renderer_typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                return typeof o2;
              } : function(o2) {
                return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
              }, renderer_typeof(o);
            }
            __name(renderer_typeof, "renderer_typeof");
            var renderer_toString = Object.prototype.toString;
            function renderer_isError(object) {
              return renderer_toString.call(object) === "[object Error]";
            }
            __name(renderer_isError, "renderer_isError");
            var FIBER_INSTANCE = 0;
            var VIRTUAL_INSTANCE = 1;
            var FILTERED_FIBER_INSTANCE = 2;
            function createFiberInstance(fiber) {
              return {
                kind: FIBER_INSTANCE,
                id: getUID(),
                parent: null,
                firstChild: null,
                nextSibling: null,
                source: null,
                logCount: 0,
                treeBaseDuration: 0,
                suspendedBy: null,
                suspenseNode: null,
                data: fiber
              };
            }
            __name(createFiberInstance, "createFiberInstance");
            function createFilteredFiberInstance(fiber) {
              return {
                kind: FILTERED_FIBER_INSTANCE,
                id: 0,
                parent: null,
                firstChild: null,
                nextSibling: null,
                source: null,
                logCount: 0,
                treeBaseDuration: 0,
                suspendedBy: null,
                suspenseNode: null,
                data: fiber
              };
            }
            __name(createFilteredFiberInstance, "createFilteredFiberInstance");
            function createVirtualInstance(debugEntry) {
              return {
                kind: VIRTUAL_INSTANCE,
                id: getUID(),
                parent: null,
                firstChild: null,
                nextSibling: null,
                source: null,
                logCount: 0,
                treeBaseDuration: 0,
                suspendedBy: null,
                suspenseNode: null,
                data: debugEntry
              };
            }
            __name(createVirtualInstance, "createVirtualInstance");
            var NoUpdate = 0;
            var ShouldResetChildren = 1;
            var ShouldResetSuspenseChildren = 2;
            var ShouldResetParentSuspenseChildren = 4;
            function createSuspenseNode(instance) {
              return instance.suspenseNode = {
                instance,
                parent: null,
                firstChild: null,
                nextSibling: null,
                rects: null,
                suspendedBy: /* @__PURE__ */ new Map(),
                environments: /* @__PURE__ */ new Map(),
                hasUniqueSuspenders: false,
                hasUnknownSuspenders: false
              };
            }
            __name(createSuspenseNode, "createSuspenseNode");
            function getDispatcherRef(renderer) {
              if (renderer.currentDispatcherRef === void 0) {
                return void 0;
              }
              var injectedRef = renderer.currentDispatcherRef;
              if (typeof injectedRef.H === "undefined" && typeof injectedRef.current !== "undefined") {
                return {
                  get H() {
                    return injectedRef.current;
                  },
                  set H(value) {
                    injectedRef.current = value;
                  }
                };
              }
              return injectedRef;
            }
            __name(getDispatcherRef, "getDispatcherRef");
            function getFiberFlags(fiber) {
              return fiber.flags !== void 0 ? fiber.flags : fiber.effectTag;
            }
            __name(getFiberFlags, "getFiberFlags");
            var renderer_getCurrentTime = (typeof performance === "undefined" ? "undefined" : renderer_typeof(performance)) === "object" && typeof performance.now === "function" ? function() {
              return performance.now();
            } : function() {
              return Date.now();
            };
            function getInternalReactConstants(version) {
              var ReactPriorityLevels = {
                ImmediatePriority: 99,
                UserBlockingPriority: 98,
                NormalPriority: 97,
                LowPriority: 96,
                IdlePriority: 95,
                NoPriority: 90
              };
              if (gt(version, "17.0.2")) {
                ReactPriorityLevels = {
                  ImmediatePriority: 1,
                  UserBlockingPriority: 2,
                  NormalPriority: 3,
                  LowPriority: 4,
                  IdlePriority: 5,
                  NoPriority: 0
                };
              }
              var StrictModeBits = 0;
              if (gte(version, "18.0.0-alpha")) {
                StrictModeBits = 24;
              } else if (gte(version, "16.9.0")) {
                StrictModeBits = 1;
              } else if (gte(version, "16.3.0")) {
                StrictModeBits = 2;
              }
              var SuspenseyImagesMode = 32;
              var ReactTypeOfWork = null;
              if (gt(version, "17.0.1")) {
                ReactTypeOfWork = {
                  CacheComponent: 24,
                  ClassComponent: 1,
                  ContextConsumer: 9,
                  ContextProvider: 10,
                  CoroutineComponent: -1,
                  CoroutineHandlerPhase: -1,
                  DehydratedSuspenseComponent: 18,
                  ForwardRef: 11,
                  Fragment: 7,
                  FunctionComponent: 0,
                  HostComponent: 5,
                  HostPortal: 4,
                  HostRoot: 3,
                  HostHoistable: 26,
                  HostSingleton: 27,
                  HostText: 6,
                  IncompleteClassComponent: 17,
                  IncompleteFunctionComponent: 28,
                  IndeterminateComponent: 2,
                  LazyComponent: 16,
                  LegacyHiddenComponent: 23,
                  MemoComponent: 14,
                  Mode: 8,
                  OffscreenComponent: 22,
                  Profiler: 12,
                  ScopeComponent: 21,
                  SimpleMemoComponent: 15,
                  SuspenseComponent: 13,
                  SuspenseListComponent: 19,
                  TracingMarkerComponent: 25,
                  YieldComponent: -1,
                  Throw: 29,
                  ViewTransitionComponent: 30,
                  ActivityComponent: 31
                };
              } else if (gte(version, "17.0.0-alpha")) {
                ReactTypeOfWork = {
                  CacheComponent: -1,
                  ClassComponent: 1,
                  ContextConsumer: 9,
                  ContextProvider: 10,
                  CoroutineComponent: -1,
                  CoroutineHandlerPhase: -1,
                  DehydratedSuspenseComponent: 18,
                  ForwardRef: 11,
                  Fragment: 7,
                  FunctionComponent: 0,
                  HostComponent: 5,
                  HostPortal: 4,
                  HostRoot: 3,
                  HostHoistable: -1,
                  HostSingleton: -1,
                  HostText: 6,
                  IncompleteClassComponent: 17,
                  IncompleteFunctionComponent: -1,
                  IndeterminateComponent: 2,
                  LazyComponent: 16,
                  LegacyHiddenComponent: 24,
                  MemoComponent: 14,
                  Mode: 8,
                  OffscreenComponent: 23,
                  Profiler: 12,
                  ScopeComponent: 21,
                  SimpleMemoComponent: 15,
                  SuspenseComponent: 13,
                  SuspenseListComponent: 19,
                  TracingMarkerComponent: -1,
                  YieldComponent: -1,
                  Throw: -1,
                  ViewTransitionComponent: -1,
                  ActivityComponent: -1
                };
              } else if (gte(version, "16.6.0-beta.0")) {
                ReactTypeOfWork = {
                  CacheComponent: -1,
                  ClassComponent: 1,
                  ContextConsumer: 9,
                  ContextProvider: 10,
                  CoroutineComponent: -1,
                  CoroutineHandlerPhase: -1,
                  DehydratedSuspenseComponent: 18,
                  ForwardRef: 11,
                  Fragment: 7,
                  FunctionComponent: 0,
                  HostComponent: 5,
                  HostPortal: 4,
                  HostRoot: 3,
                  HostHoistable: -1,
                  HostSingleton: -1,
                  HostText: 6,
                  IncompleteClassComponent: 17,
                  IncompleteFunctionComponent: -1,
                  IndeterminateComponent: 2,
                  LazyComponent: 16,
                  LegacyHiddenComponent: -1,
                  MemoComponent: 14,
                  Mode: 8,
                  OffscreenComponent: -1,
                  Profiler: 12,
                  ScopeComponent: -1,
                  SimpleMemoComponent: 15,
                  SuspenseComponent: 13,
                  SuspenseListComponent: 19,
                  TracingMarkerComponent: -1,
                  YieldComponent: -1,
                  Throw: -1,
                  ViewTransitionComponent: -1,
                  ActivityComponent: -1
                };
              } else if (gte(version, "16.4.3-alpha")) {
                ReactTypeOfWork = {
                  CacheComponent: -1,
                  ClassComponent: 2,
                  ContextConsumer: 11,
                  ContextProvider: 12,
                  CoroutineComponent: -1,
                  CoroutineHandlerPhase: -1,
                  DehydratedSuspenseComponent: -1,
                  ForwardRef: 13,
                  Fragment: 9,
                  FunctionComponent: 0,
                  HostComponent: 7,
                  HostPortal: 6,
                  HostRoot: 5,
                  HostHoistable: -1,
                  HostSingleton: -1,
                  HostText: 8,
                  IncompleteClassComponent: -1,
                  IncompleteFunctionComponent: -1,
                  IndeterminateComponent: 4,
                  LazyComponent: -1,
                  LegacyHiddenComponent: -1,
                  MemoComponent: -1,
                  Mode: 10,
                  OffscreenComponent: -1,
                  Profiler: 15,
                  ScopeComponent: -1,
                  SimpleMemoComponent: -1,
                  SuspenseComponent: 16,
                  SuspenseListComponent: -1,
                  TracingMarkerComponent: -1,
                  YieldComponent: -1,
                  Throw: -1,
                  ViewTransitionComponent: -1,
                  ActivityComponent: -1
                };
              } else {
                ReactTypeOfWork = {
                  CacheComponent: -1,
                  ClassComponent: 2,
                  ContextConsumer: 12,
                  ContextProvider: 13,
                  CoroutineComponent: 7,
                  CoroutineHandlerPhase: 8,
                  DehydratedSuspenseComponent: -1,
                  ForwardRef: 14,
                  Fragment: 10,
                  FunctionComponent: 1,
                  HostComponent: 5,
                  HostPortal: 4,
                  HostRoot: 3,
                  HostHoistable: -1,
                  HostSingleton: -1,
                  HostText: 6,
                  IncompleteClassComponent: -1,
                  IncompleteFunctionComponent: -1,
                  IndeterminateComponent: 0,
                  LazyComponent: -1,
                  LegacyHiddenComponent: -1,
                  MemoComponent: -1,
                  Mode: 11,
                  OffscreenComponent: -1,
                  Profiler: 15,
                  ScopeComponent: -1,
                  SimpleMemoComponent: -1,
                  SuspenseComponent: 16,
                  SuspenseListComponent: -1,
                  TracingMarkerComponent: -1,
                  YieldComponent: 9,
                  Throw: -1,
                  ViewTransitionComponent: -1,
                  ActivityComponent: -1
                };
              }
              function getTypeSymbol(type) {
                var symbolOrNumber = renderer_typeof(type) === "object" && type !== null ? type.$$typeof : type;
                return renderer_typeof(symbolOrNumber) === "symbol" ? symbolOrNumber.toString() : symbolOrNumber;
              }
              __name(getTypeSymbol, "getTypeSymbol");
              var _ReactTypeOfWork = ReactTypeOfWork, CacheComponent = _ReactTypeOfWork.CacheComponent, ClassComponent = _ReactTypeOfWork.ClassComponent, IncompleteClassComponent = _ReactTypeOfWork.IncompleteClassComponent, IncompleteFunctionComponent = _ReactTypeOfWork.IncompleteFunctionComponent, FunctionComponent = _ReactTypeOfWork.FunctionComponent, IndeterminateComponent = _ReactTypeOfWork.IndeterminateComponent, ForwardRef = _ReactTypeOfWork.ForwardRef, HostRoot = _ReactTypeOfWork.HostRoot, HostHoistable = _ReactTypeOfWork.HostHoistable, HostSingleton = _ReactTypeOfWork.HostSingleton, HostComponent = _ReactTypeOfWork.HostComponent, HostPortal = _ReactTypeOfWork.HostPortal, HostText = _ReactTypeOfWork.HostText, Fragment = _ReactTypeOfWork.Fragment, LazyComponent = _ReactTypeOfWork.LazyComponent, LegacyHiddenComponent = _ReactTypeOfWork.LegacyHiddenComponent, MemoComponent = _ReactTypeOfWork.MemoComponent, OffscreenComponent = _ReactTypeOfWork.OffscreenComponent, Profiler = _ReactTypeOfWork.Profiler, ScopeComponent = _ReactTypeOfWork.ScopeComponent, SimpleMemoComponent = _ReactTypeOfWork.SimpleMemoComponent, SuspenseComponent = _ReactTypeOfWork.SuspenseComponent, SuspenseListComponent = _ReactTypeOfWork.SuspenseListComponent, TracingMarkerComponent = _ReactTypeOfWork.TracingMarkerComponent, Throw = _ReactTypeOfWork.Throw, ViewTransitionComponent = _ReactTypeOfWork.ViewTransitionComponent, ActivityComponent = _ReactTypeOfWork.ActivityComponent;
              function resolveFiberType(type) {
                var typeSymbol = getTypeSymbol(type);
                switch (typeSymbol) {
                  case MEMO_NUMBER:
                  case MEMO_SYMBOL_STRING:
                    return resolveFiberType(type.type);
                  case FORWARD_REF_NUMBER:
                  case FORWARD_REF_SYMBOL_STRING:
                    return type.render;
                  default:
                    return type;
                }
              }
              __name(resolveFiberType, "resolveFiberType");
              function getDisplayNameForFiber(fiber) {
                var _fiber$updateQueue, _fiber$memoizedState, _fiber$memoizedState$, _fiber$memoizedState2;
                var shouldSkipForgetCheck = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : false;
                var elementType = fiber.elementType, type = fiber.type, tag = fiber.tag;
                var resolvedType = type;
                if (renderer_typeof(type) === "object" && type !== null) {
                  resolvedType = resolveFiberType(type);
                }
                var resolvedContext = null;
                if (!shouldSkipForgetCheck && (((_fiber$updateQueue = fiber.updateQueue) === null || _fiber$updateQueue === void 0 ? void 0 : _fiber$updateQueue.memoCache) != null || Array.isArray((_fiber$memoizedState = fiber.memoizedState) === null || _fiber$memoizedState === void 0 ? void 0 : _fiber$memoizedState.memoizedState) && (_fiber$memoizedState$ = fiber.memoizedState.memoizedState[0]) !== null && _fiber$memoizedState$ !== void 0 && _fiber$memoizedState$[ReactSymbols_REACT_MEMO_CACHE_SENTINEL] || (_fiber$memoizedState2 = fiber.memoizedState) !== null && _fiber$memoizedState2 !== void 0 && (_fiber$memoizedState2 = _fiber$memoizedState2.memoizedState) !== null && _fiber$memoizedState2 !== void 0 && _fiber$memoizedState2[ReactSymbols_REACT_MEMO_CACHE_SENTINEL])) {
                  var displayNameWithoutForgetWrapper = getDisplayNameForFiber(fiber, true);
                  if (displayNameWithoutForgetWrapper == null) {
                    return null;
                  }
                  return "Forget(".concat(displayNameWithoutForgetWrapper, ")");
                }
                switch (tag) {
                  case ActivityComponent:
                    return "Activity";
                  case CacheComponent:
                    return "Cache";
                  case ClassComponent:
                  case IncompleteClassComponent:
                  case IncompleteFunctionComponent:
                  case FunctionComponent:
                  case IndeterminateComponent:
                    return getDisplayName(resolvedType);
                  case ForwardRef:
                    return getWrappedDisplayName(elementType, resolvedType, "ForwardRef", "Anonymous");
                  case HostRoot:
                    var fiberRoot = fiber.stateNode;
                    if (fiberRoot != null && fiberRoot._debugRootType !== null) {
                      return fiberRoot._debugRootType;
                    }
                    return null;
                  case HostComponent:
                  case HostSingleton:
                  case HostHoistable:
                    return type;
                  case HostPortal:
                  case HostText:
                    return null;
                  case Fragment:
                    return "Fragment";
                  case LazyComponent:
                    return "Lazy";
                  case MemoComponent:
                  case SimpleMemoComponent:
                    return getWrappedDisplayName(elementType, resolvedType, "Memo", "Anonymous");
                  case SuspenseComponent:
                    return "Suspense";
                  case LegacyHiddenComponent:
                    return "LegacyHidden";
                  case OffscreenComponent:
                    return "Offscreen";
                  case ScopeComponent:
                    return "Scope";
                  case SuspenseListComponent:
                    return "SuspenseList";
                  case Profiler:
                    return "Profiler";
                  case TracingMarkerComponent:
                    return "TracingMarker";
                  case ViewTransitionComponent:
                    return "ViewTransition";
                  case Throw:
                    return "Error";
                  default:
                    var typeSymbol = getTypeSymbol(type);
                    switch (typeSymbol) {
                      case CONCURRENT_MODE_NUMBER:
                      case CONCURRENT_MODE_SYMBOL_STRING:
                      case DEPRECATED_ASYNC_MODE_SYMBOL_STRING:
                        return null;
                      case PROVIDER_NUMBER:
                      case PROVIDER_SYMBOL_STRING:
                        resolvedContext = fiber.type._context || fiber.type.context;
                        return "".concat(resolvedContext.displayName || "Context", ".Provider");
                      case CONTEXT_NUMBER:
                      case CONTEXT_SYMBOL_STRING:
                      case SERVER_CONTEXT_SYMBOL_STRING:
                        if (fiber.type._context === void 0 && fiber.type.Provider === fiber.type) {
                          resolvedContext = fiber.type;
                          return "".concat(resolvedContext.displayName || "Context", ".Provider");
                        }
                        resolvedContext = fiber.type._context || fiber.type;
                        return "".concat(resolvedContext.displayName || "Context", ".Consumer");
                      case CONSUMER_SYMBOL_STRING:
                        resolvedContext = fiber.type._context;
                        return "".concat(resolvedContext.displayName || "Context", ".Consumer");
                      case STRICT_MODE_NUMBER:
                      case STRICT_MODE_SYMBOL_STRING:
                        return null;
                      case PROFILER_NUMBER:
                      case PROFILER_SYMBOL_STRING:
                        return "Profiler(".concat(fiber.memoizedProps.id, ")");
                      case SCOPE_NUMBER:
                      case SCOPE_SYMBOL_STRING:
                        return "Scope";
                      default:
                        return null;
                    }
                }
              }
              __name(getDisplayNameForFiber, "getDisplayNameForFiber");
              return {
                getDisplayNameForFiber,
                getTypeSymbol,
                ReactPriorityLevels,
                ReactTypeOfWork,
                StrictModeBits,
                SuspenseyImagesMode
              };
            }
            __name(getInternalReactConstants, "getInternalReactConstants");
            var knownEnvironmentNames = /* @__PURE__ */ new Set();
            var rootToFiberInstanceMap = /* @__PURE__ */ new Map();
            var idToDevToolsInstanceMap = /* @__PURE__ */ new Map();
            var idToSuspenseNodeMap = /* @__PURE__ */ new Map();
            var publicInstanceToDevToolsInstanceMap = /* @__PURE__ */ new Map();
            var hostResourceToDevToolsInstanceMap = /* @__PURE__ */ new Map();
            function getPublicInstance(instance) {
              if (renderer_typeof(instance) === "object" && instance !== null) {
                if (renderer_typeof(instance.canonical) === "object" && instance.canonical !== null) {
                  if (renderer_typeof(instance.canonical.publicInstance) === "object" && instance.canonical.publicInstance !== null) {
                    return instance.canonical.publicInstance;
                  }
                }
                if (typeof instance._nativeTag === "number") {
                  return instance._nativeTag;
                }
              }
              return instance;
            }
            __name(getPublicInstance, "getPublicInstance");
            function getNativeTag(instance) {
              if (renderer_typeof(instance) !== "object" || instance === null) {
                return null;
              }
              if (instance.canonical != null && typeof instance.canonical.nativeTag === "number") {
                return instance.canonical.nativeTag;
              }
              if (typeof instance._nativeTag === "number") {
                return instance._nativeTag;
              }
              return null;
            }
            __name(getNativeTag, "getNativeTag");
            function aquireHostInstance(nearestInstance, hostInstance) {
              var publicInstance = getPublicInstance(hostInstance);
              publicInstanceToDevToolsInstanceMap.set(publicInstance, nearestInstance);
            }
            __name(aquireHostInstance, "aquireHostInstance");
            function releaseHostInstance(nearestInstance, hostInstance) {
              var publicInstance = getPublicInstance(hostInstance);
              if (publicInstanceToDevToolsInstanceMap.get(publicInstance) === nearestInstance) {
                publicInstanceToDevToolsInstanceMap.delete(publicInstance);
              }
            }
            __name(releaseHostInstance, "releaseHostInstance");
            function aquireHostResource(nearestInstance, resource) {
              var hostInstance = resource && resource.instance;
              if (hostInstance) {
                var publicInstance = getPublicInstance(hostInstance);
                var resourceInstances = hostResourceToDevToolsInstanceMap.get(publicInstance);
                if (resourceInstances === void 0) {
                  resourceInstances = /* @__PURE__ */ new Set();
                  hostResourceToDevToolsInstanceMap.set(publicInstance, resourceInstances);
                  publicInstanceToDevToolsInstanceMap.set(publicInstance, nearestInstance);
                }
                resourceInstances.add(nearestInstance);
              }
            }
            __name(aquireHostResource, "aquireHostResource");
            function releaseHostResource(nearestInstance, resource) {
              var hostInstance = resource && resource.instance;
              if (hostInstance) {
                var publicInstance = getPublicInstance(hostInstance);
                var resourceInstances = hostResourceToDevToolsInstanceMap.get(publicInstance);
                if (resourceInstances !== void 0) {
                  resourceInstances.delete(nearestInstance);
                  if (resourceInstances.size === 0) {
                    hostResourceToDevToolsInstanceMap.delete(publicInstance);
                    publicInstanceToDevToolsInstanceMap.delete(publicInstance);
                  } else if (publicInstanceToDevToolsInstanceMap.get(publicInstance) === nearestInstance) {
                    var _iterator = _createForOfIteratorHelper(resourceInstances), _step;
                    try {
                      for (_iterator.s(); !(_step = _iterator.n()).done; ) {
                        var firstInstance = _step.value;
                        publicInstanceToDevToolsInstanceMap.set(firstInstance, nearestInstance);
                        break;
                      }
                    } catch (err) {
                      _iterator.e(err);
                    } finally {
                      _iterator.f();
                    }
                  }
                }
              }
            }
            __name(releaseHostResource, "releaseHostResource");
            function renderer_attach(hook, rendererID, renderer, global, shouldStartProfilingNow, profilingSettings) {
              var version = renderer.reconcilerVersion || renderer.version;
              var _getInternalReactCons = getInternalReactConstants(version), getDisplayNameForFiber = _getInternalReactCons.getDisplayNameForFiber, getTypeSymbol = _getInternalReactCons.getTypeSymbol, ReactPriorityLevels = _getInternalReactCons.ReactPriorityLevels, ReactTypeOfWork = _getInternalReactCons.ReactTypeOfWork, StrictModeBits = _getInternalReactCons.StrictModeBits, SuspenseyImagesMode = _getInternalReactCons.SuspenseyImagesMode;
              var ActivityComponent = ReactTypeOfWork.ActivityComponent, ClassComponent = ReactTypeOfWork.ClassComponent, ContextConsumer = ReactTypeOfWork.ContextConsumer, DehydratedSuspenseComponent = ReactTypeOfWork.DehydratedSuspenseComponent, ForwardRef = ReactTypeOfWork.ForwardRef, Fragment = ReactTypeOfWork.Fragment, FunctionComponent = ReactTypeOfWork.FunctionComponent, HostRoot = ReactTypeOfWork.HostRoot, HostHoistable = ReactTypeOfWork.HostHoistable, HostSingleton = ReactTypeOfWork.HostSingleton, HostPortal = ReactTypeOfWork.HostPortal, HostComponent = ReactTypeOfWork.HostComponent, HostText = ReactTypeOfWork.HostText, IncompleteClassComponent = ReactTypeOfWork.IncompleteClassComponent, IncompleteFunctionComponent = ReactTypeOfWork.IncompleteFunctionComponent, IndeterminateComponent = ReactTypeOfWork.IndeterminateComponent, LegacyHiddenComponent = ReactTypeOfWork.LegacyHiddenComponent, MemoComponent = ReactTypeOfWork.MemoComponent, OffscreenComponent = ReactTypeOfWork.OffscreenComponent, SimpleMemoComponent = ReactTypeOfWork.SimpleMemoComponent, SuspenseComponent = ReactTypeOfWork.SuspenseComponent, SuspenseListComponent = ReactTypeOfWork.SuspenseListComponent, TracingMarkerComponent = ReactTypeOfWork.TracingMarkerComponent, Throw = ReactTypeOfWork.Throw, ViewTransitionComponent = ReactTypeOfWork.ViewTransitionComponent;
              var ImmediatePriority = ReactPriorityLevels.ImmediatePriority, UserBlockingPriority = ReactPriorityLevels.UserBlockingPriority, NormalPriority = ReactPriorityLevels.NormalPriority, LowPriority = ReactPriorityLevels.LowPriority, IdlePriority = ReactPriorityLevels.IdlePriority, NoPriority = ReactPriorityLevels.NoPriority;
              var getLaneLabelMap = renderer.getLaneLabelMap, injectProfilingHooks = renderer.injectProfilingHooks, overrideHookState = renderer.overrideHookState, overrideHookStateDeletePath = renderer.overrideHookStateDeletePath, overrideHookStateRenamePath = renderer.overrideHookStateRenamePath, overrideProps = renderer.overrideProps, overridePropsDeletePath = renderer.overridePropsDeletePath, overridePropsRenamePath = renderer.overridePropsRenamePath, scheduleRefresh = renderer.scheduleRefresh, setErrorHandler = renderer.setErrorHandler, setSuspenseHandler = renderer.setSuspenseHandler, scheduleUpdate = renderer.scheduleUpdate, scheduleRetry = renderer.scheduleRetry, getCurrentFiber = renderer.getCurrentFiber;
              var supportsTogglingError = typeof setErrorHandler === "function" && typeof scheduleUpdate === "function";
              var supportsTogglingSuspense = typeof setSuspenseHandler === "function" && typeof scheduleUpdate === "function";
              var supportsPerformanceTracks = gte(version, "19.2.0");
              if (typeof scheduleRefresh === "function") {
                renderer.scheduleRefresh = function() {
                  try {
                    hook.emit("fastRefreshScheduled");
                  } finally {
                    return scheduleRefresh.apply(void 0, arguments);
                  }
                };
              }
              var getTimelineData = null;
              var toggleProfilingStatus = null;
              if (typeof injectProfilingHooks === "function") {
                var response = createProfilingHooks({
                  getDisplayNameForFiber,
                  getIsProfiling: /* @__PURE__ */ __name(function getIsProfiling() {
                    return isProfiling;
                  }, "getIsProfiling"),
                  getLaneLabelMap,
                  currentDispatcherRef: getDispatcherRef(renderer),
                  workTagMap: ReactTypeOfWork,
                  reactVersion: version
                });
                injectProfilingHooks(response.profilingHooks);
                getTimelineData = response.getTimelineData;
                toggleProfilingStatus = response.toggleProfilingStatus;
              }
              var fiberToComponentLogsMap = /* @__PURE__ */ new WeakMap();
              var needsToFlushComponentLogs = false;
              function bruteForceFlushErrorsAndWarnings() {
                var hasChanges = false;
                var _iterator2 = _createForOfIteratorHelper(idToDevToolsInstanceMap.values()), _step2;
                try {
                  for (_iterator2.s(); !(_step2 = _iterator2.n()).done; ) {
                    var devtoolsInstance = _step2.value;
                    if (devtoolsInstance.kind === FIBER_INSTANCE) {
                      var _fiber = devtoolsInstance.data;
                      var componentLogsEntry = fiberToComponentLogsMap.get(_fiber);
                      var changed = recordConsoleLogs(devtoolsInstance, componentLogsEntry);
                      if (changed) {
                        hasChanges = true;
                        updateMostRecentlyInspectedElementIfNecessary(devtoolsInstance.id);
                      }
                    } else {
                    }
                  }
                } catch (err) {
                  _iterator2.e(err);
                } finally {
                  _iterator2.f();
                }
                if (hasChanges) {
                  flushPendingEvents();
                }
              }
              __name(bruteForceFlushErrorsAndWarnings, "bruteForceFlushErrorsAndWarnings");
              function clearErrorsAndWarnings() {
                var _iterator3 = _createForOfIteratorHelper(idToDevToolsInstanceMap.values()), _step3;
                try {
                  for (_iterator3.s(); !(_step3 = _iterator3.n()).done; ) {
                    var devtoolsInstance = _step3.value;
                    if (devtoolsInstance.kind === FIBER_INSTANCE) {
                      var _fiber2 = devtoolsInstance.data;
                      fiberToComponentLogsMap.delete(_fiber2);
                      if (_fiber2.alternate) {
                        fiberToComponentLogsMap.delete(_fiber2.alternate);
                      }
                    } else {
                      componentInfoToComponentLogsMap["delete"](devtoolsInstance.data);
                    }
                    var changed = recordConsoleLogs(devtoolsInstance, void 0);
                    if (changed) {
                      updateMostRecentlyInspectedElementIfNecessary(devtoolsInstance.id);
                    }
                  }
                } catch (err) {
                  _iterator3.e(err);
                } finally {
                  _iterator3.f();
                }
                flushPendingEvents();
              }
              __name(clearErrorsAndWarnings, "clearErrorsAndWarnings");
              function clearConsoleLogsHelper(instanceID, type) {
                var devtoolsInstance = idToDevToolsInstanceMap.get(instanceID);
                if (devtoolsInstance !== void 0) {
                  var componentLogsEntry;
                  if (devtoolsInstance.kind === FIBER_INSTANCE) {
                    var _fiber3 = devtoolsInstance.data;
                    componentLogsEntry = fiberToComponentLogsMap.get(_fiber3);
                    if (componentLogsEntry === void 0 && _fiber3.alternate !== null) {
                      componentLogsEntry = fiberToComponentLogsMap.get(_fiber3.alternate);
                    }
                  } else {
                    var componentInfo = devtoolsInstance.data;
                    componentLogsEntry = componentInfoToComponentLogsMap.get(componentInfo);
                  }
                  if (componentLogsEntry !== void 0) {
                    if (type === "error") {
                      componentLogsEntry.errors.clear();
                      componentLogsEntry.errorsCount = 0;
                    } else {
                      componentLogsEntry.warnings.clear();
                      componentLogsEntry.warningsCount = 0;
                    }
                    var changed = recordConsoleLogs(devtoolsInstance, componentLogsEntry);
                    if (changed) {
                      flushPendingEvents();
                      updateMostRecentlyInspectedElementIfNecessary(devtoolsInstance.id);
                    }
                  }
                }
              }
              __name(clearConsoleLogsHelper, "clearConsoleLogsHelper");
              function clearErrorsForElementID(instanceID) {
                clearConsoleLogsHelper(instanceID, "error");
              }
              __name(clearErrorsForElementID, "clearErrorsForElementID");
              function clearWarningsForElementID(instanceID) {
                clearConsoleLogsHelper(instanceID, "warn");
              }
              __name(clearWarningsForElementID, "clearWarningsForElementID");
              function updateMostRecentlyInspectedElementIfNecessary(fiberID) {
                if (mostRecentlyInspectedElement !== null && mostRecentlyInspectedElement.id === fiberID) {
                  hasElementUpdatedSinceLastInspected = true;
                }
              }
              __name(updateMostRecentlyInspectedElementIfNecessary, "updateMostRecentlyInspectedElementIfNecessary");
              function getComponentStack(topFrame) {
                if (getCurrentFiber == null) {
                  return null;
                }
                var current = getCurrentFiber();
                if (current === null) {
                  return null;
                }
                if (DevToolsFiberComponentStack_supportsConsoleTasks(current)) {
                  return null;
                }
                var dispatcherRef = getDispatcherRef(renderer);
                if (dispatcherRef === void 0) {
                  return null;
                }
                var enableOwnerStacks = supportsOwnerStacks(current);
                var componentStack = "";
                if (enableOwnerStacks) {
                  var topStackFrames = formatOwnerStack(topFrame);
                  if (topStackFrames) {
                    componentStack += "\n" + topStackFrames;
                  }
                  componentStack += getOwnerStackByFiberInDev(ReactTypeOfWork, current, dispatcherRef);
                } else {
                  componentStack = getStackByFiberInDevAndProd(ReactTypeOfWork, current, dispatcherRef);
                }
                return {
                  enableOwnerStacks,
                  componentStack
                };
              }
              __name(getComponentStack, "getComponentStack");
              function onErrorOrWarning(type, args) {
                if (getCurrentFiber == null) {
                  return;
                }
                var fiber = getCurrentFiber();
                if (fiber === null) {
                  return;
                }
                if (type === "error") {
                  if (forceErrorForFibers.get(fiber) === true || fiber.alternate !== null && forceErrorForFibers.get(fiber.alternate) === true) {
                    return;
                  }
                }
                var message = formatConsoleArgumentsToSingleString.apply(void 0, fiber_renderer_toConsumableArray(args));
                var componentLogsEntry = fiberToComponentLogsMap.get(fiber);
                if (componentLogsEntry === void 0 && fiber.alternate !== null) {
                  componentLogsEntry = fiberToComponentLogsMap.get(fiber.alternate);
                  if (componentLogsEntry !== void 0) {
                    fiberToComponentLogsMap.set(fiber, componentLogsEntry);
                  }
                }
                if (componentLogsEntry === void 0) {
                  componentLogsEntry = {
                    errors: /* @__PURE__ */ new Map(),
                    errorsCount: 0,
                    warnings: /* @__PURE__ */ new Map(),
                    warningsCount: 0
                  };
                  fiberToComponentLogsMap.set(fiber, componentLogsEntry);
                }
                var messageMap = type === "error" ? componentLogsEntry.errors : componentLogsEntry.warnings;
                var count = messageMap.get(message) || 0;
                messageMap.set(message, count + 1);
                if (type === "error") {
                  componentLogsEntry.errorsCount++;
                } else {
                  componentLogsEntry.warningsCount++;
                }
                needsToFlushComponentLogs = true;
              }
              __name(onErrorOrWarning, "onErrorOrWarning");
              function debug2(name, instance, parentInstance) {
                var extraString = arguments.length > 3 && arguments[3] !== void 0 ? arguments[3] : "";
                if (__DEBUG__) {
                  var displayName = instance.kind === VIRTUAL_INSTANCE ? instance.data.name || "null" : instance.data.tag + ":" + (getDisplayNameForFiber(instance.data) || "null");
                  var maybeID = instance.kind === FILTERED_FIBER_INSTANCE ? "<no id>" : instance.id;
                  var parentDisplayName = parentInstance === null ? "" : parentInstance.kind === VIRTUAL_INSTANCE ? parentInstance.data.name || "null" : parentInstance.data.tag + ":" + (getDisplayNameForFiber(parentInstance.data) || "null");
                  var maybeParentID = parentInstance === null || parentInstance.kind === FILTERED_FIBER_INSTANCE ? "<no id>" : parentInstance.id;
                  console.groupCollapsed("[renderer] %c".concat(name, " %c").concat(displayName, " (").concat(maybeID, ") %c").concat(parentInstance ? "".concat(parentDisplayName, " (").concat(maybeParentID, ")") : "", " %c").concat(extraString), "color: red; font-weight: bold;", "color: blue;", "color: purple;", "color: black;");
                  console.log(new Error().stack.split("\n").slice(1).join("\n"));
                  console.groupEnd();
                }
              }
              __name(debug2, "debug");
              function debugTree(instance) {
                var indent = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : 0;
                if (__DEBUG__) {
                  var name = (instance.kind !== VIRTUAL_INSTANCE ? getDisplayNameForFiber(instance.data) : instance.data.name) || "";
                  console.log("  ".repeat(indent) + "- " + (instance.kind === FILTERED_FIBER_INSTANCE ? 0 : instance.id) + " (" + name + ")", "parent", instance.parent === null ? " " : instance.parent.kind === FILTERED_FIBER_INSTANCE ? 0 : instance.parent.id, "next", instance.nextSibling === null ? " " : instance.nextSibling.id);
                  var child = instance.firstChild;
                  while (child !== null) {
                    debugTree(child, indent + 1);
                    child = child.nextSibling;
                  }
                }
              }
              __name(debugTree, "debugTree");
              var hideElementsWithDisplayNames = /* @__PURE__ */ new Set();
              var hideElementsWithPaths = /* @__PURE__ */ new Set();
              var hideElementsWithTypes = /* @__PURE__ */ new Set();
              var hideElementsWithEnvs = /* @__PURE__ */ new Set();
              var traceUpdatesEnabled = false;
              var traceUpdatesForNodes = /* @__PURE__ */ new Set();
              function applyComponentFilters(componentFilters) {
                hideElementsWithTypes.clear();
                hideElementsWithDisplayNames.clear();
                hideElementsWithPaths.clear();
                hideElementsWithEnvs.clear();
                componentFilters.forEach(function(componentFilter) {
                  if (!componentFilter.isEnabled) {
                    return;
                  }
                  switch (componentFilter.type) {
                    case ComponentFilterDisplayName:
                      if (componentFilter.isValid && componentFilter.value !== "") {
                        hideElementsWithDisplayNames.add(new RegExp(componentFilter.value, "i"));
                      }
                      break;
                    case ComponentFilterElementType:
                      hideElementsWithTypes.add(componentFilter.value);
                      break;
                    case ComponentFilterLocation:
                      if (componentFilter.isValid && componentFilter.value !== "") {
                        hideElementsWithPaths.add(new RegExp(componentFilter.value, "i"));
                      }
                      break;
                    case ComponentFilterHOC:
                      hideElementsWithDisplayNames.add(new RegExp("\\("));
                      break;
                    case ComponentFilterEnvironmentName:
                      hideElementsWithEnvs.add(componentFilter.value);
                      break;
                    default:
                      console.warn('Invalid component filter type "'.concat(componentFilter.type, '"'));
                      break;
                  }
                });
              }
              __name(applyComponentFilters, "applyComponentFilters");
              if (window.__REACT_DEVTOOLS_COMPONENT_FILTERS__ != null) {
                var componentFiltersWithoutLocationBasedOnes = filterOutLocationComponentFilters(window.__REACT_DEVTOOLS_COMPONENT_FILTERS__);
                applyComponentFilters(componentFiltersWithoutLocationBasedOnes);
              } else {
                applyComponentFilters(getDefaultComponentFilters());
              }
              function updateComponentFilters(componentFilters) {
                if (isProfiling) {
                  throw Error("Cannot modify filter preferences while profiling");
                }
                hook.getFiberRoots(rendererID).forEach(function(root) {
                  var rootInstance = rootToFiberInstanceMap.get(root);
                  if (rootInstance === void 0) {
                    throw new Error("Expected the root instance to already exist when applying filters");
                  }
                  currentRoot = rootInstance;
                  unmountInstanceRecursively(rootInstance);
                  rootToFiberInstanceMap.delete(root);
                  flushPendingEvents();
                  currentRoot = null;
                });
                applyComponentFilters(componentFilters);
                rootDisplayNameCounter.clear();
                hook.getFiberRoots(rendererID).forEach(function(root) {
                  var current = root.current;
                  var newRoot = createFiberInstance(current);
                  rootToFiberInstanceMap.set(root, newRoot);
                  idToDevToolsInstanceMap.set(newRoot.id, newRoot);
                  if (trackedPath !== null) {
                    mightBeOnTrackedPath = true;
                  }
                  currentRoot = newRoot;
                  setRootPseudoKey(currentRoot.id, root.current);
                  mountFiberRecursively(root.current, false);
                  flushPendingEvents();
                  currentRoot = null;
                });
                flushPendingEvents();
                needsToFlushComponentLogs = false;
              }
              __name(updateComponentFilters, "updateComponentFilters");
              function getEnvironmentNames() {
                return Array.from(knownEnvironmentNames);
              }
              __name(getEnvironmentNames, "getEnvironmentNames");
              function isFiberHydrated(fiber) {
                if (OffscreenComponent === -1) {
                  throw new Error("not implemented for legacy suspense");
                }
                switch (fiber.tag) {
                  case HostRoot:
                    var rootState = fiber.memoizedState;
                    return !rootState.isDehydrated;
                  case SuspenseComponent:
                    var suspenseState = fiber.memoizedState;
                    return suspenseState === null || suspenseState.dehydrated === null;
                  default:
                    throw new Error("not implemented for work tag " + fiber.tag);
                }
              }
              __name(isFiberHydrated, "isFiberHydrated");
              function shouldFilterVirtual(data, secondaryEnv) {
                if (hideElementsWithTypes.has(types_ElementTypeFunction)) {
                  return true;
                }
                if (hideElementsWithDisplayNames.size > 0) {
                  var displayName = data.name;
                  if (displayName != null) {
                    var _iterator4 = _createForOfIteratorHelper(hideElementsWithDisplayNames), _step4;
                    try {
                      for (_iterator4.s(); !(_step4 = _iterator4.n()).done; ) {
                        var displayNameRegExp = _step4.value;
                        if (displayNameRegExp.test(displayName)) {
                          return true;
                        }
                      }
                    } catch (err) {
                      _iterator4.e(err);
                    } finally {
                      _iterator4.f();
                    }
                  }
                }
                if ((data.env == null || hideElementsWithEnvs.has(data.env)) && (secondaryEnv === null || hideElementsWithEnvs.has(secondaryEnv))) {
                  return true;
                }
                return false;
              }
              __name(shouldFilterVirtual, "shouldFilterVirtual");
              function shouldFilterFiber(fiber) {
                var tag = fiber.tag, type = fiber.type, key = fiber.key;
                switch (tag) {
                  case DehydratedSuspenseComponent:
                    return true;
                  case HostPortal:
                  case HostText:
                  case LegacyHiddenComponent:
                  case OffscreenComponent:
                  case Throw:
                    return true;
                  case HostRoot:
                    return false;
                  case Fragment:
                    return key === null;
                  default:
                    var typeSymbol = getTypeSymbol(type);
                    switch (typeSymbol) {
                      case CONCURRENT_MODE_NUMBER:
                      case CONCURRENT_MODE_SYMBOL_STRING:
                      case DEPRECATED_ASYNC_MODE_SYMBOL_STRING:
                      case STRICT_MODE_NUMBER:
                      case STRICT_MODE_SYMBOL_STRING:
                        return true;
                      default:
                        break;
                    }
                }
                var elementType = getElementTypeForFiber(fiber);
                if (hideElementsWithTypes.has(elementType)) {
                  return true;
                }
                if (hideElementsWithDisplayNames.size > 0) {
                  var displayName = getDisplayNameForFiber(fiber);
                  if (displayName != null) {
                    var _iterator5 = _createForOfIteratorHelper(hideElementsWithDisplayNames), _step5;
                    try {
                      for (_iterator5.s(); !(_step5 = _iterator5.n()).done; ) {
                        var displayNameRegExp = _step5.value;
                        if (displayNameRegExp.test(displayName)) {
                          return true;
                        }
                      }
                    } catch (err) {
                      _iterator5.e(err);
                    } finally {
                      _iterator5.f();
                    }
                  }
                }
                if (hideElementsWithEnvs.has("Client")) {
                  switch (tag) {
                    case ClassComponent:
                    case IncompleteClassComponent:
                    case IncompleteFunctionComponent:
                    case FunctionComponent:
                    case IndeterminateComponent:
                    case ForwardRef:
                    case MemoComponent:
                    case SimpleMemoComponent:
                      return true;
                  }
                }
                return false;
              }
              __name(shouldFilterFiber, "shouldFilterFiber");
              function getElementTypeForFiber(fiber) {
                var type = fiber.type, tag = fiber.tag;
                switch (tag) {
                  case ActivityComponent:
                    return ElementTypeActivity;
                  case ClassComponent:
                  case IncompleteClassComponent:
                    return types_ElementTypeClass;
                  case IncompleteFunctionComponent:
                  case FunctionComponent:
                  case IndeterminateComponent:
                    return types_ElementTypeFunction;
                  case ForwardRef:
                    return types_ElementTypeForwardRef;
                  case HostRoot:
                    return ElementTypeRoot;
                  case HostComponent:
                  case HostHoistable:
                  case HostSingleton:
                    return ElementTypeHostComponent;
                  case HostPortal:
                  case HostText:
                  case Fragment:
                    return ElementTypeOtherOrUnknown;
                  case MemoComponent:
                  case SimpleMemoComponent:
                    return types_ElementTypeMemo;
                  case SuspenseComponent:
                    return ElementTypeSuspense;
                  case SuspenseListComponent:
                    return ElementTypeSuspenseList;
                  case TracingMarkerComponent:
                    return ElementTypeTracingMarker;
                  case ViewTransitionComponent:
                    return ElementTypeViewTransition;
                  default:
                    var typeSymbol = getTypeSymbol(type);
                    switch (typeSymbol) {
                      case CONCURRENT_MODE_NUMBER:
                      case CONCURRENT_MODE_SYMBOL_STRING:
                      case DEPRECATED_ASYNC_MODE_SYMBOL_STRING:
                        return ElementTypeOtherOrUnknown;
                      case PROVIDER_NUMBER:
                      case PROVIDER_SYMBOL_STRING:
                        return ElementTypeContext;
                      case CONTEXT_NUMBER:
                      case CONTEXT_SYMBOL_STRING:
                        return ElementTypeContext;
                      case STRICT_MODE_NUMBER:
                      case STRICT_MODE_SYMBOL_STRING:
                        return ElementTypeOtherOrUnknown;
                      case PROFILER_NUMBER:
                      case PROFILER_SYMBOL_STRING:
                        return ElementTypeProfiler;
                      default:
                        return ElementTypeOtherOrUnknown;
                    }
                }
              }
              __name(getElementTypeForFiber, "getElementTypeForFiber");
              var currentRoot = null;
              function untrackFiber(nearestInstance, fiber) {
                if (forceErrorForFibers.size > 0) {
                  forceErrorForFibers.delete(fiber);
                  if (fiber.alternate) {
                    forceErrorForFibers.delete(fiber.alternate);
                  }
                  if (forceErrorForFibers.size === 0 && setErrorHandler != null) {
                    setErrorHandler(shouldErrorFiberAlwaysNull);
                  }
                }
                if (forceFallbackForFibers.size > 0) {
                  forceFallbackForFibers.delete(fiber);
                  if (fiber.alternate) {
                    forceFallbackForFibers.delete(fiber.alternate);
                  }
                  if (forceFallbackForFibers.size === 0 && setSuspenseHandler != null) {
                    setSuspenseHandler(shouldSuspendFiberAlwaysFalse);
                  }
                }
                if (fiber.tag === HostHoistable) {
                  releaseHostResource(nearestInstance, fiber.memoizedState);
                } else if (fiber.tag === HostComponent || fiber.tag === HostText || fiber.tag === HostSingleton) {
                  releaseHostInstance(nearestInstance, fiber.stateNode);
                }
                for (var child = fiber.child; child !== null; child = child.sibling) {
                  if (shouldFilterFiber(child)) {
                    untrackFiber(nearestInstance, child);
                  }
                }
              }
              __name(untrackFiber, "untrackFiber");
              function getChangeDescription(prevFiber, nextFiber) {
                switch (nextFiber.tag) {
                  case ClassComponent:
                    if (prevFiber === null) {
                      return {
                        context: null,
                        didHooksChange: false,
                        isFirstMount: true,
                        props: null,
                        state: null
                      };
                    } else {
                      var data = {
                        context: getContextChanged(prevFiber, nextFiber),
                        didHooksChange: false,
                        isFirstMount: false,
                        props: getChangedKeys(prevFiber.memoizedProps, nextFiber.memoizedProps),
                        state: getChangedKeys(prevFiber.memoizedState, nextFiber.memoizedState)
                      };
                      return data;
                    }
                  case IncompleteFunctionComponent:
                  case FunctionComponent:
                  case IndeterminateComponent:
                  case ForwardRef:
                  case MemoComponent:
                  case SimpleMemoComponent:
                    if (prevFiber === null) {
                      return {
                        context: null,
                        didHooksChange: false,
                        isFirstMount: true,
                        props: null,
                        state: null
                      };
                    } else {
                      var indices = getChangedHooksIndices(prevFiber.memoizedState, nextFiber.memoizedState);
                      var _data = {
                        context: getContextChanged(prevFiber, nextFiber),
                        didHooksChange: indices !== null && indices.length > 0,
                        isFirstMount: false,
                        props: getChangedKeys(prevFiber.memoizedProps, nextFiber.memoizedProps),
                        state: null,
                        hooks: indices
                      };
                      return _data;
                    }
                  default:
                    return null;
                }
              }
              __name(getChangeDescription, "getChangeDescription");
              function getContextChanged(prevFiber, nextFiber) {
                var prevContext = prevFiber.dependencies && prevFiber.dependencies.firstContext;
                var nextContext = nextFiber.dependencies && nextFiber.dependencies.firstContext;
                while (prevContext && nextContext) {
                  if (prevContext.context !== nextContext.context) {
                    return false;
                  }
                  if (!shared_objectIs(prevContext.memoizedValue, nextContext.memoizedValue)) {
                    return true;
                  }
                  prevContext = prevContext.next;
                  nextContext = nextContext.next;
                }
                return false;
              }
              __name(getContextChanged, "getContextChanged");
              function isHookThatCanScheduleUpdate(hookObject) {
                var queue = hookObject.queue;
                if (!queue) {
                  return false;
                }
                var boundHasOwnProperty = shared_hasOwnProperty.bind(queue);
                if (boundHasOwnProperty("pending")) {
                  return true;
                }
                return boundHasOwnProperty("value") && boundHasOwnProperty("getSnapshot") && typeof queue.getSnapshot === "function";
              }
              __name(isHookThatCanScheduleUpdate, "isHookThatCanScheduleUpdate");
              function didStatefulHookChange(prev, next) {
                var prevMemoizedState = prev.memoizedState;
                var nextMemoizedState = next.memoizedState;
                if (isHookThatCanScheduleUpdate(prev)) {
                  return prevMemoizedState !== nextMemoizedState;
                }
                return false;
              }
              __name(didStatefulHookChange, "didStatefulHookChange");
              function getChangedHooksIndices(prev, next) {
                if (prev == null || next == null) {
                  return null;
                }
                var indices = [];
                var index = 0;
                while (next !== null) {
                  if (didStatefulHookChange(prev, next)) {
                    indices.push(index);
                  }
                  next = next.next;
                  prev = prev.next;
                  index++;
                }
                return indices;
              }
              __name(getChangedHooksIndices, "getChangedHooksIndices");
              function getChangedKeys(prev, next) {
                if (prev == null || next == null) {
                  return null;
                }
                var keys = new Set([].concat(fiber_renderer_toConsumableArray(Object.keys(prev)), fiber_renderer_toConsumableArray(Object.keys(next))));
                var changedKeys = [];
                var _iterator6 = _createForOfIteratorHelper(keys), _step6;
                try {
                  for (_iterator6.s(); !(_step6 = _iterator6.n()).done; ) {
                    var key = _step6.value;
                    if (prev[key] !== next[key]) {
                      changedKeys.push(key);
                    }
                  }
                } catch (err) {
                  _iterator6.e(err);
                } finally {
                  _iterator6.f();
                }
                return changedKeys;
              }
              __name(getChangedKeys, "getChangedKeys");
              function didFiberRender(prevFiber, nextFiber) {
                switch (nextFiber.tag) {
                  case ClassComponent:
                  case FunctionComponent:
                  case ContextConsumer:
                  case MemoComponent:
                  case SimpleMemoComponent:
                  case ForwardRef:
                    var PerformedWork = 1;
                    return (getFiberFlags(nextFiber) & PerformedWork) === PerformedWork;
                  default:
                    return prevFiber.memoizedProps !== nextFiber.memoizedProps || prevFiber.memoizedState !== nextFiber.memoizedState || prevFiber.ref !== nextFiber.ref;
                }
              }
              __name(didFiberRender, "didFiberRender");
              var pendingOperations = [];
              var pendingRealUnmountedIDs = [];
              var pendingRealUnmountedSuspenseIDs = [];
              var pendingSuspenderChanges = /* @__PURE__ */ new Set();
              var pendingOperationsQueue = [];
              var pendingStringTable = /* @__PURE__ */ new Map();
              var pendingStringTableLength = 0;
              var pendingUnmountedRootID = null;
              function pushOperation(op) {
                if (false) {
                }
                pendingOperations.push(op);
              }
              __name(pushOperation, "pushOperation");
              function shouldBailoutWithPendingOperations() {
                if (isProfiling) {
                  if (currentCommitProfilingMetadata != null && currentCommitProfilingMetadata.durations.length > 0) {
                    return false;
                  }
                }
                return pendingOperations.length === 0 && pendingRealUnmountedIDs.length === 0 && pendingRealUnmountedSuspenseIDs.length === 0 && pendingSuspenderChanges.size === 0 && pendingUnmountedRootID === null;
              }
              __name(shouldBailoutWithPendingOperations, "shouldBailoutWithPendingOperations");
              function flushOrQueueOperations(operations) {
                if (shouldBailoutWithPendingOperations()) {
                  return;
                }
                if (pendingOperationsQueue !== null) {
                  pendingOperationsQueue.push(operations);
                } else {
                  hook.emit("operations", operations);
                }
              }
              __name(flushOrQueueOperations, "flushOrQueueOperations");
              function recordConsoleLogs(instance, componentLogsEntry) {
                if (componentLogsEntry === void 0) {
                  if (instance.logCount === 0) {
                    return false;
                  }
                  instance.logCount = 0;
                  pushOperation(TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS);
                  pushOperation(instance.id);
                  pushOperation(0);
                  pushOperation(0);
                  return true;
                } else {
                  var totalCount = componentLogsEntry.errorsCount + componentLogsEntry.warningsCount;
                  if (instance.logCount === totalCount) {
                    return false;
                  }
                  instance.logCount = totalCount;
                  pushOperation(TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS);
                  pushOperation(instance.id);
                  pushOperation(componentLogsEntry.errorsCount);
                  pushOperation(componentLogsEntry.warningsCount);
                  return true;
                }
              }
              __name(recordConsoleLogs, "recordConsoleLogs");
              function flushPendingEvents() {
                if (shouldBailoutWithPendingOperations()) {
                  return;
                }
                var numUnmountIDs = pendingRealUnmountedIDs.length + (pendingUnmountedRootID === null ? 0 : 1);
                var numUnmountSuspenseIDs = pendingRealUnmountedSuspenseIDs.length;
                var numSuspenderChanges = pendingSuspenderChanges.size;
                var operations = new Array(2 + 1 + pendingStringTableLength + (numUnmountSuspenseIDs > 0 ? 2 + numUnmountSuspenseIDs : 0) + (numUnmountIDs > 0 ? 2 + numUnmountIDs : 0) + pendingOperations.length + (numSuspenderChanges > 0 ? 2 + numSuspenderChanges * 3 : 0));
                var i = 0;
                operations[i++] = rendererID;
                if (currentRoot === null) {
                  operations[i++] = -1;
                } else {
                  operations[i++] = currentRoot.id;
                }
                operations[i++] = pendingStringTableLength;
                pendingStringTable.forEach(function(entry, stringKey) {
                  var encodedString = entry.encodedString;
                  var length = encodedString.length;
                  operations[i++] = length;
                  for (var j2 = 0; j2 < length; j2++) {
                    operations[i + j2] = encodedString[j2];
                  }
                  i += length;
                });
                if (numUnmountSuspenseIDs > 0) {
                  operations[i++] = SUSPENSE_TREE_OPERATION_REMOVE;
                  operations[i++] = numUnmountSuspenseIDs;
                  for (var j = 0; j < pendingRealUnmountedSuspenseIDs.length; j++) {
                    operations[i++] = pendingRealUnmountedSuspenseIDs[j];
                  }
                }
                if (numUnmountIDs > 0) {
                  operations[i++] = TREE_OPERATION_REMOVE;
                  operations[i++] = numUnmountIDs;
                  for (var _j = 0; _j < pendingRealUnmountedIDs.length; _j++) {
                    operations[i++] = pendingRealUnmountedIDs[_j];
                  }
                  if (pendingUnmountedRootID !== null) {
                    operations[i] = pendingUnmountedRootID;
                    i++;
                  }
                }
                for (var _j2 = 0; _j2 < pendingOperations.length; _j2++) {
                  operations[i + _j2] = pendingOperations[_j2];
                }
                i += pendingOperations.length;
                if (numSuspenderChanges > 0) {
                  operations[i++] = SUSPENSE_TREE_OPERATION_SUSPENDERS;
                  operations[i++] = numSuspenderChanges;
                  pendingSuspenderChanges.forEach(function(fiberIdWithChanges) {
                    var suspense = idToSuspenseNodeMap.get(fiberIdWithChanges);
                    if (suspense === void 0) {
                      throw new Error('Could not send suspender changes for "'.concat(fiberIdWithChanges, '" since the Fiber no longer exists.'));
                    }
                    operations[i++] = fiberIdWithChanges;
                    operations[i++] = suspense.hasUniqueSuspenders ? 1 : 0;
                    var instance = suspense.instance;
                    var isSuspended = (instance.kind === FIBER_INSTANCE || instance.kind === FILTERED_FIBER_INSTANCE) && instance.data.tag === SuspenseComponent && instance.data.memoizedState !== null;
                    operations[i++] = isSuspended ? 1 : 0;
                    operations[i++] = suspense.environments.size;
                    suspense.environments.forEach(function(count, env) {
                      operations[i++] = getStringID(env);
                    });
                  });
                }
                flushOrQueueOperations(operations);
                pendingOperations.length = 0;
                pendingRealUnmountedIDs.length = 0;
                pendingRealUnmountedSuspenseIDs.length = 0;
                pendingSuspenderChanges.clear();
                pendingUnmountedRootID = null;
                pendingStringTable.clear();
                pendingStringTableLength = 0;
              }
              __name(flushPendingEvents, "flushPendingEvents");
              function measureHostInstance(instance) {
                if (renderer_typeof(instance) !== "object" || instance === null) {
                  return null;
                }
                if (typeof instance.getClientRects === "function" || instance.nodeType === 3) {
                  var doc = instance.ownerDocument;
                  if (instance === doc.documentElement) {
                    return [{
                      x: 0,
                      y: 0,
                      width: instance.scrollWidth,
                      height: instance.scrollHeight
                    }];
                  }
                  var result = [];
                  var win = doc && doc.defaultView;
                  var scrollX = win ? win.scrollX : 0;
                  var scrollY = win ? win.scrollY : 0;
                  var rects;
                  if (instance.nodeType === 3) {
                    if (typeof doc.createRange !== "function") {
                      return null;
                    }
                    var range = doc.createRange();
                    if (typeof range.getClientRects !== "function") {
                      return null;
                    }
                    range.selectNodeContents(instance);
                    rects = range.getClientRects();
                  } else {
                    rects = instance.getClientRects();
                  }
                  for (var i = 0; i < rects.length; i++) {
                    var rect = rects[i];
                    result.push({
                      x: rect.x + scrollX,
                      y: rect.y + scrollY,
                      width: rect.width,
                      height: rect.height
                    });
                  }
                  return result;
                }
                if (instance.canonical) {
                  var publicInstance = instance.canonical.publicInstance;
                  if (!publicInstance) {
                    return null;
                  }
                  if (typeof publicInstance.getBoundingClientRect === "function") {
                    return [publicInstance.getBoundingClientRect()];
                  }
                  if (typeof publicInstance.unstable_getBoundingClientRect === "function") {
                    return [publicInstance.unstable_getBoundingClientRect()];
                  }
                }
                return null;
              }
              __name(measureHostInstance, "measureHostInstance");
              function measureInstance(instance) {
                var hostInstances = findAllCurrentHostInstances(instance);
                var result = null;
                for (var i = 0; i < hostInstances.length; i++) {
                  var childResult = measureHostInstance(hostInstances[i]);
                  if (childResult !== null) {
                    if (result === null) {
                      result = childResult;
                    } else {
                      result = result.concat(childResult);
                    }
                  }
                }
                return result;
              }
              __name(measureInstance, "measureInstance");
              function getStringID(string) {
                if (string === null) {
                  return 0;
                }
                var existingEntry = pendingStringTable.get(string);
                if (existingEntry !== void 0) {
                  return existingEntry.id;
                }
                var id = pendingStringTable.size + 1;
                var encodedString = utfEncodeString(string);
                pendingStringTable.set(string, {
                  encodedString,
                  id
                });
                pendingStringTableLength += encodedString.length + 1;
                return id;
              }
              __name(getStringID, "getStringID");
              var isInDisconnectedSubtree = false;
              function recordMount(fiber, parentInstance) {
                var isRoot = fiber.tag === HostRoot;
                var fiberInstance;
                if (isRoot) {
                  var entry = rootToFiberInstanceMap.get(fiber.stateNode);
                  if (entry === void 0) {
                    throw new Error("The root should have been registered at this point");
                  }
                  fiberInstance = entry;
                } else {
                  fiberInstance = createFiberInstance(fiber);
                }
                idToDevToolsInstanceMap.set(fiberInstance.id, fiberInstance);
                if (__DEBUG__) {
                  debug2("recordMount()", fiberInstance, parentInstance);
                }
                recordReconnect(fiberInstance, parentInstance);
                return fiberInstance;
              }
              __name(recordMount, "recordMount");
              function recordReconnect(fiberInstance, parentInstance) {
                if (isInDisconnectedSubtree) {
                  return;
                }
                var id = fiberInstance.id;
                var fiber = fiberInstance.data;
                var isProfilingSupported = fiber.hasOwnProperty("treeBaseDuration");
                var isRoot = fiber.tag === HostRoot;
                if (isRoot) {
                  var hasOwnerMetadata = fiber.hasOwnProperty("_debugOwner");
                  var profilingFlags = 0;
                  if (isProfilingSupported) {
                    profilingFlags = PROFILING_FLAG_BASIC_SUPPORT;
                    if (typeof injectProfilingHooks === "function") {
                      profilingFlags |= PROFILING_FLAG_TIMELINE_SUPPORT;
                    }
                    if (supportsPerformanceTracks) {
                      profilingFlags |= PROFILING_FLAG_PERFORMANCE_TRACKS_SUPPORT;
                    }
                  }
                  var isProductionBuildOfRenderer = renderer.bundleType === 0;
                  pushOperation(TREE_OPERATION_ADD);
                  pushOperation(id);
                  pushOperation(ElementTypeRoot);
                  pushOperation((fiber.mode & StrictModeBits) !== 0 ? 1 : 0);
                  pushOperation(profilingFlags);
                  pushOperation(!isProductionBuildOfRenderer && StrictModeBits !== 0 ? 1 : 0);
                  pushOperation(hasOwnerMetadata ? 1 : 0);
                  if (isProfiling) {
                    if (displayNamesByRootID !== null) {
                      displayNamesByRootID.set(id, getDisplayNameForRoot(fiber));
                    }
                  }
                } else {
                  var key = fiber.key;
                  var displayName = getDisplayNameForFiber(fiber);
                  var elementType = getElementTypeForFiber(fiber);
                  var debugOwner = getUnfilteredOwner(fiber);
                  var ownerInstance = findNearestOwnerInstance(parentInstance, debugOwner);
                  if (ownerInstance !== null && debugOwner === fiber._debugOwner && fiber._debugStack != null && ownerInstance.source === null) {
                    ownerInstance.source = fiber._debugStack;
                  }
                  var unfilteredParent = parentInstance;
                  while (unfilteredParent !== null && unfilteredParent.kind === FILTERED_FIBER_INSTANCE) {
                    unfilteredParent = unfilteredParent.parent;
                  }
                  var ownerID = ownerInstance === null ? 0 : ownerInstance.id;
                  var parentID = unfilteredParent === null ? 0 : unfilteredParent.id;
                  var displayNameStringID = getStringID(displayName);
                  var keyString = key === null ? null : String(key);
                  var keyStringID = getStringID(keyString);
                  var nameProp = fiber.tag === SuspenseComponent ? fiber.memoizedProps.name : fiber.tag === ActivityComponent ? fiber.memoizedProps.name : null;
                  var namePropString = nameProp == null ? null : String(nameProp);
                  var namePropStringID = getStringID(namePropString);
                  pushOperation(TREE_OPERATION_ADD);
                  pushOperation(id);
                  pushOperation(elementType);
                  pushOperation(parentID);
                  pushOperation(ownerID);
                  pushOperation(displayNameStringID);
                  pushOperation(keyStringID);
                  pushOperation(namePropStringID);
                  if ((fiber.mode & StrictModeBits) !== 0) {
                    var parentFiber = null;
                    var parentFiberInstance = parentInstance;
                    while (parentFiberInstance !== null) {
                      if (parentFiberInstance.kind === FIBER_INSTANCE) {
                        parentFiber = parentFiberInstance.data;
                        break;
                      }
                      parentFiberInstance = parentFiberInstance.parent;
                    }
                    if (parentFiber === null || (parentFiber.mode & StrictModeBits) === 0) {
                      pushOperation(TREE_OPERATION_SET_SUBTREE_MODE);
                      pushOperation(id);
                      pushOperation(StrictMode);
                    }
                  }
                }
                var componentLogsEntry = fiberToComponentLogsMap.get(fiber);
                if (componentLogsEntry === void 0 && fiber.alternate !== null) {
                  componentLogsEntry = fiberToComponentLogsMap.get(fiber.alternate);
                }
                recordConsoleLogs(fiberInstance, componentLogsEntry);
                if (isProfilingSupported) {
                  recordProfilingDurations(fiberInstance, null);
                }
              }
              __name(recordReconnect, "recordReconnect");
              function recordVirtualMount(instance, parentInstance, secondaryEnv) {
                var id = instance.id;
                idToDevToolsInstanceMap.set(id, instance);
                recordVirtualReconnect(instance, parentInstance, secondaryEnv);
              }
              __name(recordVirtualMount, "recordVirtualMount");
              function recordVirtualReconnect(instance, parentInstance, secondaryEnv) {
                if (isInDisconnectedSubtree) {
                  return;
                }
                var componentInfo = instance.data;
                var key = typeof componentInfo.key === "string" ? componentInfo.key : null;
                var env = componentInfo.env;
                var displayName = componentInfo.name || "";
                if (typeof env === "string") {
                  if (secondaryEnv !== null) {
                    displayName = secondaryEnv + "(" + displayName + ")";
                  }
                  displayName = env + "(" + displayName + ")";
                }
                var elementType = types_ElementTypeVirtual;
                var debugOwner = getUnfilteredOwner(componentInfo);
                var ownerInstance = findNearestOwnerInstance(parentInstance, debugOwner);
                if (ownerInstance !== null && debugOwner === componentInfo.owner && componentInfo.debugStack != null && ownerInstance.source === null) {
                  ownerInstance.source = componentInfo.debugStack;
                }
                var unfilteredParent = parentInstance;
                while (unfilteredParent !== null && unfilteredParent.kind === FILTERED_FIBER_INSTANCE) {
                  unfilteredParent = unfilteredParent.parent;
                }
                var ownerID = ownerInstance === null ? 0 : ownerInstance.id;
                var parentID = unfilteredParent === null ? 0 : unfilteredParent.id;
                var displayNameStringID = getStringID(displayName);
                var keyString = key === null ? null : String(key);
                var keyStringID = getStringID(keyString);
                var namePropStringID = getStringID(null);
                var id = instance.id;
                pushOperation(TREE_OPERATION_ADD);
                pushOperation(id);
                pushOperation(elementType);
                pushOperation(parentID);
                pushOperation(ownerID);
                pushOperation(displayNameStringID);
                pushOperation(keyStringID);
                pushOperation(namePropStringID);
                var componentLogsEntry = componentInfoToComponentLogsMap.get(componentInfo);
                recordConsoleLogs(instance, componentLogsEntry);
              }
              __name(recordVirtualReconnect, "recordVirtualReconnect");
              function recordSuspenseMount(suspenseInstance, parentSuspenseInstance) {
                var fiberInstance = suspenseInstance.instance;
                if (fiberInstance.kind === FILTERED_FIBER_INSTANCE) {
                  throw new Error("Cannot record a mount for a filtered Fiber instance.");
                }
                var fiberID = fiberInstance.id;
                var unfilteredParent = parentSuspenseInstance;
                while (unfilteredParent !== null && unfilteredParent.instance.kind === FILTERED_FIBER_INSTANCE) {
                  unfilteredParent = unfilteredParent.parent;
                }
                var unfilteredParentInstance = unfilteredParent !== null ? unfilteredParent.instance : null;
                if (unfilteredParentInstance !== null && unfilteredParentInstance.kind === FILTERED_FIBER_INSTANCE) {
                  throw new Error("Should not have a filtered instance at this point. This is a bug.");
                }
                var parentID = unfilteredParentInstance === null ? 0 : unfilteredParentInstance.id;
                var fiber = fiberInstance.data;
                var props = fiber.memoizedProps;
                var name = fiber.tag !== SuspenseComponent || props === null ? null : props.name || null;
                var nameStringID = getStringID(name);
                var isSuspended = fiber.tag === SuspenseComponent && fiber.memoizedState !== null;
                if (__DEBUG__) {
                  console.log("recordSuspenseMount()", suspenseInstance);
                }
                idToSuspenseNodeMap.set(fiberID, suspenseInstance);
                pushOperation(SUSPENSE_TREE_OPERATION_ADD);
                pushOperation(fiberID);
                pushOperation(parentID);
                pushOperation(nameStringID);
                pushOperation(isSuspended ? 1 : 0);
                var rects = suspenseInstance.rects;
                if (rects === null) {
                  pushOperation(-1);
                } else {
                  pushOperation(rects.length);
                  for (var i = 0; i < rects.length; ++i) {
                    var rect = rects[i];
                    pushOperation(Math.round(rect.x * 1e3));
                    pushOperation(Math.round(rect.y * 1e3));
                    pushOperation(Math.round(rect.width * 1e3));
                    pushOperation(Math.round(rect.height * 1e3));
                  }
                }
              }
              __name(recordSuspenseMount, "recordSuspenseMount");
              function recordUnmount(fiberInstance) {
                if (__DEBUG__) {
                  debug2("recordUnmount()", fiberInstance, reconcilingParent);
                }
                recordDisconnect(fiberInstance);
                var suspenseNode = fiberInstance.suspenseNode;
                if (suspenseNode !== null) {
                  recordSuspenseUnmount(suspenseNode);
                }
                idToDevToolsInstanceMap.delete(fiberInstance.id);
                untrackFiber(fiberInstance, fiberInstance.data);
              }
              __name(recordUnmount, "recordUnmount");
              function recordDisconnect(fiberInstance) {
                if (isInDisconnectedSubtree) {
                  return;
                }
                var fiber = fiberInstance.data;
                if (trackedPathMatchInstance === fiberInstance) {
                  setTrackedPath(null);
                }
                var id = fiberInstance.id;
                var isRoot = fiber.tag === HostRoot;
                if (isRoot) {
                  pendingUnmountedRootID = id;
                } else {
                  pendingRealUnmountedIDs.push(id);
                }
              }
              __name(recordDisconnect, "recordDisconnect");
              function recordSuspenseResize(suspenseNode) {
                if (__DEBUG__) {
                  console.log("recordSuspenseResize()", suspenseNode);
                }
                var fiberInstance = suspenseNode.instance;
                if (fiberInstance.kind !== FIBER_INSTANCE) {
                  return;
                }
                pushOperation(SUSPENSE_TREE_OPERATION_RESIZE);
                pushOperation(fiberInstance.id);
                var rects = suspenseNode.rects;
                if (rects === null) {
                  pushOperation(-1);
                } else {
                  pushOperation(rects.length);
                  for (var i = 0; i < rects.length; ++i) {
                    var rect = rects[i];
                    pushOperation(Math.round(rect.x * 1e3));
                    pushOperation(Math.round(rect.y * 1e3));
                    pushOperation(Math.round(rect.width * 1e3));
                    pushOperation(Math.round(rect.height * 1e3));
                  }
                }
              }
              __name(recordSuspenseResize, "recordSuspenseResize");
              function recordSuspenseSuspenders(suspenseNode) {
                if (__DEBUG__) {
                  console.log("recordSuspenseSuspenders()", suspenseNode);
                }
                var fiberInstance = suspenseNode.instance;
                if (fiberInstance.kind !== FIBER_INSTANCE) {
                  return;
                }
                suspenseNode.environments.forEach(function(count, env) {
                  getStringID(env);
                });
                pendingSuspenderChanges.add(fiberInstance.id);
              }
              __name(recordSuspenseSuspenders, "recordSuspenseSuspenders");
              function recordSuspenseUnmount(suspenseInstance) {
                if (__DEBUG__) {
                  console.log("recordSuspenseUnmount()", suspenseInstance, reconcilingParentSuspenseNode);
                }
                var devtoolsInstance = suspenseInstance.instance;
                if (devtoolsInstance.kind !== FIBER_INSTANCE) {
                  throw new Error("Can't unmount a filtered SuspenseNode. This is a bug.");
                }
                var fiberInstance = devtoolsInstance;
                var id = fiberInstance.id;
                pendingRealUnmountedSuspenseIDs.push(id);
                pendingSuspenderChanges.delete(id);
                idToSuspenseNodeMap.delete(id);
              }
              __name(recordSuspenseUnmount, "recordSuspenseUnmount");
              var remainingReconcilingChildren = null;
              var previouslyReconciledSibling = null;
              var reconcilingParent = null;
              var remainingReconcilingChildrenSuspenseNodes = null;
              var previouslyReconciledSiblingSuspenseNode = null;
              var reconcilingParentSuspenseNode = null;
              function ioExistsInSuspenseAncestor(suspenseNode, ioInfo) {
                var ancestor = suspenseNode.parent;
                while (ancestor !== null) {
                  if (ancestor.suspendedBy.has(ioInfo)) {
                    return true;
                  }
                  ancestor = ancestor.parent;
                }
                return false;
              }
              __name(ioExistsInSuspenseAncestor, "ioExistsInSuspenseAncestor");
              function insertSuspendedBy(asyncInfo) {
                if (reconcilingParent === null || reconcilingParentSuspenseNode === null) {
                  throw new Error("It should not be possible to have suspended data outside the root. Even suspending at the first position is still a child of the root.");
                }
                var parentSuspenseNode = reconcilingParentSuspenseNode;
                var parentInstance = reconcilingParent;
                while (parentInstance.kind === FILTERED_FIBER_INSTANCE && parentInstance.parent !== null && parentInstance !== parentSuspenseNode.instance) {
                  parentInstance = parentInstance.parent;
                }
                var suspenseNodeSuspendedBy = parentSuspenseNode.suspendedBy;
                var ioInfo = asyncInfo.awaited;
                var suspendedBySet = suspenseNodeSuspendedBy.get(ioInfo);
                if (suspendedBySet === void 0) {
                  suspendedBySet = /* @__PURE__ */ new Set();
                  suspenseNodeSuspendedBy.set(ioInfo, suspendedBySet);
                  var env = ioInfo.env;
                  if (env != null) {
                    var environmentCounts = parentSuspenseNode.environments;
                    var count = environmentCounts.get(env);
                    if (count === void 0 || count === 0) {
                      environmentCounts.set(env, 1);
                      recordSuspenseSuspenders(parentSuspenseNode);
                    } else {
                      environmentCounts.set(env, count + 1);
                    }
                  }
                }
                if (!suspendedBySet.has(parentInstance)) {
                  suspendedBySet.add(parentInstance);
                  if (!parentSuspenseNode.hasUniqueSuspenders && !ioExistsInSuspenseAncestor(parentSuspenseNode, ioInfo)) {
                    parentSuspenseNode.hasUniqueSuspenders = true;
                    recordSuspenseSuspenders(parentSuspenseNode);
                  }
                }
                parentSuspenseNode.hasUnknownSuspenders = false;
                var suspendedBy = parentInstance.suspendedBy;
                if (suspendedBy === null) {
                  parentInstance.suspendedBy = [asyncInfo];
                } else if (suspendedBy.indexOf(asyncInfo) === -1) {
                  suspendedBy.push(asyncInfo);
                }
              }
              __name(insertSuspendedBy, "insertSuspendedBy");
              function getAwaitInSuspendedByFromIO(suspensedBy, ioInfo) {
                for (var i = 0; i < suspensedBy.length; i++) {
                  var asyncInfo = suspensedBy[i];
                  if (asyncInfo.awaited === ioInfo) {
                    return asyncInfo;
                  }
                }
                return null;
              }
              __name(getAwaitInSuspendedByFromIO, "getAwaitInSuspendedByFromIO");
              function unblockSuspendedBy(parentSuspenseNode, ioInfo) {
                var firstChild = parentSuspenseNode.firstChild;
                if (firstChild === null) {
                  return;
                }
                var node = firstChild;
                while (node !== null) {
                  if (node.suspendedBy.has(ioInfo)) {
                    if (!node.hasUniqueSuspenders) {
                      recordSuspenseSuspenders(node);
                    }
                    node.hasUniqueSuspenders = true;
                    node.hasUnknownSuspenders = false;
                  } else if (node.firstChild !== null) {
                    node = node.firstChild;
                    continue;
                  }
                  while (node.nextSibling === null) {
                    if (node.parent === null || node.parent === parentSuspenseNode) {
                      return;
                    }
                    node = node.parent;
                  }
                  node = node.nextSibling;
                }
              }
              __name(unblockSuspendedBy, "unblockSuspendedBy");
              function removePreviousSuspendedBy(instance, previousSuspendedBy, parentSuspenseNode) {
                var suspenseNode = instance.suspenseNode === null ? parentSuspenseNode : instance.suspenseNode;
                if (previousSuspendedBy !== null && suspenseNode !== null) {
                  var nextSuspendedBy = instance.suspendedBy;
                  var changedEnvironment = false;
                  for (var i = 0; i < previousSuspendedBy.length; i++) {
                    var asyncInfo = previousSuspendedBy[i];
                    if (nextSuspendedBy === null || nextSuspendedBy.indexOf(asyncInfo) === -1 && getAwaitInSuspendedByFromIO(nextSuspendedBy, asyncInfo.awaited) === null) {
                      var ioInfo = asyncInfo.awaited;
                      var suspendedBySet = suspenseNode.suspendedBy.get(ioInfo);
                      if (suspendedBySet === void 0 || !suspendedBySet.delete(instance)) {
                        var alreadyRemovedIO = false;
                        for (var j = 0; j < i; j++) {
                          var removedIOInfo = previousSuspendedBy[j].awaited;
                          if (removedIOInfo === ioInfo) {
                            alreadyRemovedIO = true;
                            break;
                          }
                        }
                        if (!alreadyRemovedIO) {
                          throw new Error("We are cleaning up async info that was not on the parent Suspense boundary. This is a bug in React.");
                        }
                      }
                      if (suspendedBySet !== void 0 && suspendedBySet.size === 0) {
                        suspenseNode.suspendedBy.delete(ioInfo);
                        var env = ioInfo.env;
                        if (env != null) {
                          var environmentCounts = suspenseNode.environments;
                          var count = environmentCounts.get(env);
                          if (count === void 0 || count === 0) {
                            throw new Error("We are removing an environment but it was not in the set. This is a bug in React.");
                          }
                          if (count === 1) {
                            environmentCounts.delete(env);
                            changedEnvironment = true;
                          } else {
                            environmentCounts.set(env, count - 1);
                          }
                        }
                      }
                      if (suspenseNode.hasUniqueSuspenders && !ioExistsInSuspenseAncestor(suspenseNode, ioInfo)) {
                        unblockSuspendedBy(suspenseNode, ioInfo);
                      }
                    }
                  }
                  if (changedEnvironment) {
                    recordSuspenseSuspenders(suspenseNode);
                  }
                }
              }
              __name(removePreviousSuspendedBy, "removePreviousSuspendedBy");
              function insertChild(instance) {
                var parentInstance = reconcilingParent;
                if (parentInstance === null) {
                  return;
                }
                instance.parent = parentInstance;
                if (previouslyReconciledSibling === null) {
                  previouslyReconciledSibling = instance;
                  parentInstance.firstChild = instance;
                } else {
                  previouslyReconciledSibling.nextSibling = instance;
                  previouslyReconciledSibling = instance;
                }
                instance.nextSibling = null;
                var suspenseNode = instance.suspenseNode;
                if (suspenseNode !== null) {
                  var parentNode = reconcilingParentSuspenseNode;
                  if (parentNode !== null) {
                    suspenseNode.parent = parentNode;
                    if (previouslyReconciledSiblingSuspenseNode === null) {
                      previouslyReconciledSiblingSuspenseNode = suspenseNode;
                      parentNode.firstChild = suspenseNode;
                    } else {
                      previouslyReconciledSiblingSuspenseNode.nextSibling = suspenseNode;
                      previouslyReconciledSiblingSuspenseNode = suspenseNode;
                    }
                    suspenseNode.nextSibling = null;
                  }
                }
              }
              __name(insertChild, "insertChild");
              function moveChild(instance, previousSibling) {
                removeChild(instance, previousSibling);
                insertChild(instance);
              }
              __name(moveChild, "moveChild");
              function removeChild(instance, previousSibling) {
                if (instance.parent === null) {
                  if (remainingReconcilingChildren === instance) {
                    throw new Error("Remaining children should not have items with no parent");
                  } else if (instance.nextSibling !== null) {
                    throw new Error("A deleted instance should not have next siblings");
                  }
                  return;
                }
                var parentInstance = reconcilingParent;
                if (parentInstance === null) {
                  throw new Error("Should not have a parent if we are at the root");
                }
                if (instance.parent !== parentInstance) {
                  throw new Error("Cannot remove a node from a different parent than is being reconciled.");
                }
                if (previousSibling === null) {
                  if (remainingReconcilingChildren !== instance) {
                    throw new Error("Expected a placed child to be moved from the remaining set.");
                  }
                  remainingReconcilingChildren = instance.nextSibling;
                } else {
                  previousSibling.nextSibling = instance.nextSibling;
                }
                instance.nextSibling = null;
                instance.parent = null;
                var suspenseNode = instance.suspenseNode;
                if (suspenseNode !== null && suspenseNode.parent !== null) {
                  var parentNode = reconcilingParentSuspenseNode;
                  if (parentNode === null) {
                    throw new Error("Should not have a parent if we are at the root");
                  }
                  if (suspenseNode.parent !== parentNode) {
                    throw new Error("Cannot remove a Suspense node from a different parent than is being reconciled.");
                  }
                  var previousSuspenseSibling = remainingReconcilingChildrenSuspenseNodes;
                  if (previousSuspenseSibling === suspenseNode) {
                    remainingReconcilingChildrenSuspenseNodes = suspenseNode.nextSibling;
                  } else {
                    while (previousSuspenseSibling !== null) {
                      if (previousSuspenseSibling.nextSibling === suspenseNode) {
                        previousSuspenseSibling.nextSibling = suspenseNode.nextSibling;
                        break;
                      }
                      previousSuspenseSibling = previousSuspenseSibling.nextSibling;
                    }
                  }
                  suspenseNode.nextSibling = null;
                  suspenseNode.parent = null;
                }
              }
              __name(removeChild, "removeChild");
              function isHiddenOffscreen(fiber) {
                switch (fiber.tag) {
                  case LegacyHiddenComponent:
                  case OffscreenComponent:
                    return fiber.memoizedState !== null;
                  default:
                    return false;
                }
              }
              __name(isHiddenOffscreen, "isHiddenOffscreen");
              function isSuspendedOffscreen(fiber) {
                switch (fiber.tag) {
                  case LegacyHiddenComponent:
                  case OffscreenComponent:
                    return fiber.memoizedState !== null && fiber.return !== null && fiber.return.tag === SuspenseComponent;
                  default:
                    return false;
                }
              }
              __name(isSuspendedOffscreen, "isSuspendedOffscreen");
              function unmountRemainingChildren() {
                if (reconcilingParent !== null && (reconcilingParent.kind === FIBER_INSTANCE || reconcilingParent.kind === FILTERED_FIBER_INSTANCE) && isSuspendedOffscreen(reconcilingParent.data) && !isInDisconnectedSubtree) {
                  isInDisconnectedSubtree = true;
                  try {
                    var child = remainingReconcilingChildren;
                    while (child !== null) {
                      unmountInstanceRecursively(child);
                      child = remainingReconcilingChildren;
                    }
                  } finally {
                    isInDisconnectedSubtree = false;
                  }
                } else {
                  var _child = remainingReconcilingChildren;
                  while (_child !== null) {
                    unmountInstanceRecursively(_child);
                    _child = remainingReconcilingChildren;
                  }
                }
              }
              __name(unmountRemainingChildren, "unmountRemainingChildren");
              function unmountSuspenseChildrenRecursively(contentInstance, stashedSuspenseParent, stashedSuspensePrevious, stashedSuspenseRemaining) {
                unmountInstanceRecursively(contentInstance);
                reconcilingParentSuspenseNode = stashedSuspenseParent;
                previouslyReconciledSiblingSuspenseNode = stashedSuspensePrevious;
                remainingReconcilingChildrenSuspenseNodes = stashedSuspenseRemaining;
                unmountRemainingChildren();
              }
              __name(unmountSuspenseChildrenRecursively, "unmountSuspenseChildrenRecursively");
              function isChildOf(parentInstance, childInstance, grandParent) {
                var instance = childInstance.parent;
                while (instance !== null) {
                  if (parentInstance === instance) {
                    return true;
                  }
                  if (instance === parentInstance.parent || instance === grandParent) {
                    break;
                  }
                  instance = instance.parent;
                }
                return false;
              }
              __name(isChildOf, "isChildOf");
              function areEqualRects(a, b) {
                if (a === null) {
                  return b === null;
                }
                if (b === null) {
                  return false;
                }
                if (a.length !== b.length) {
                  return false;
                }
                for (var i = 0; i < a.length; i++) {
                  var aRect = a[i];
                  var bRect = b[i];
                  if (aRect.x !== bRect.x || aRect.y !== bRect.y || aRect.width !== bRect.width || aRect.height !== bRect.height) {
                    return false;
                  }
                }
                return true;
              }
              __name(areEqualRects, "areEqualRects");
              function measureUnchangedSuspenseNodesRecursively(suspenseNode) {
                if (isInDisconnectedSubtree) {
                  return;
                }
                var instance = suspenseNode.instance;
                var isSuspendedSuspenseComponent = (instance.kind === FIBER_INSTANCE || instance.kind === FILTERED_FIBER_INSTANCE) && instance.data.tag === SuspenseComponent && instance.data.memoizedState !== null;
                if (isSuspendedSuspenseComponent) {
                  return;
                }
                var parent = instance.parent;
                while (parent !== null) {
                  if ((parent.kind === FIBER_INSTANCE || parent.kind === FILTERED_FIBER_INSTANCE) && isHiddenOffscreen(parent.data)) {
                    return;
                  }
                  if (parent.suspenseNode !== null) {
                    break;
                  }
                  parent = parent.parent;
                }
                var nextRects = measureInstance(suspenseNode.instance);
                var prevRects = suspenseNode.rects;
                if (areEqualRects(prevRects, nextRects)) {
                  return;
                }
                for (var child = suspenseNode.firstChild; child !== null; child = child.nextSibling) {
                  measureUnchangedSuspenseNodesRecursively(child);
                }
                suspenseNode.rects = nextRects;
                recordSuspenseResize(suspenseNode);
              }
              __name(measureUnchangedSuspenseNodesRecursively, "measureUnchangedSuspenseNodesRecursively");
              function consumeSuspenseNodesOfExistingInstance(instance) {
                var suspenseNode = remainingReconcilingChildrenSuspenseNodes;
                if (suspenseNode === null) {
                  return;
                }
                var parentSuspenseNode = reconcilingParentSuspenseNode;
                if (parentSuspenseNode === null) {
                  throw new Error("The should not be any remaining suspense node children if there is no parent.");
                }
                var foundOne = false;
                var previousSkippedSibling = null;
                while (suspenseNode !== null) {
                  if (isChildOf(instance, suspenseNode.instance, parentSuspenseNode.instance)) {
                    foundOne = true;
                    var nextRemainingSibling = suspenseNode.nextSibling;
                    if (previousSkippedSibling === null) {
                      remainingReconcilingChildrenSuspenseNodes = nextRemainingSibling;
                    } else {
                      previousSkippedSibling.nextSibling = nextRemainingSibling;
                    }
                    suspenseNode.nextSibling = null;
                    if (previouslyReconciledSiblingSuspenseNode === null) {
                      parentSuspenseNode.firstChild = suspenseNode;
                    } else {
                      previouslyReconciledSiblingSuspenseNode.nextSibling = suspenseNode;
                    }
                    previouslyReconciledSiblingSuspenseNode = suspenseNode;
                    measureUnchangedSuspenseNodesRecursively(suspenseNode);
                    suspenseNode = nextRemainingSibling;
                  } else if (foundOne) {
                    break;
                  } else {
                    previousSkippedSibling = suspenseNode;
                    suspenseNode = suspenseNode.nextSibling;
                  }
                }
              }
              __name(consumeSuspenseNodesOfExistingInstance, "consumeSuspenseNodesOfExistingInstance");
              function mountVirtualInstanceRecursively(virtualInstance, firstChild, lastChild, traceNearestHostComponentUpdate, virtualLevel) {
                var mightSiblingsBeOnTrackedPath = updateVirtualTrackedPathStateBeforeMount(virtualInstance, reconcilingParent);
                var stashedParent = reconcilingParent;
                var stashedPrevious = previouslyReconciledSibling;
                var stashedRemaining = remainingReconcilingChildren;
                reconcilingParent = virtualInstance;
                previouslyReconciledSibling = null;
                remainingReconcilingChildren = null;
                try {
                  mountVirtualChildrenRecursively(firstChild, lastChild, traceNearestHostComponentUpdate, virtualLevel + 1);
                  recordVirtualProfilingDurations(virtualInstance);
                } finally {
                  reconcilingParent = stashedParent;
                  previouslyReconciledSibling = stashedPrevious;
                  remainingReconcilingChildren = stashedRemaining;
                  updateTrackedPathStateAfterMount(mightSiblingsBeOnTrackedPath);
                }
              }
              __name(mountVirtualInstanceRecursively, "mountVirtualInstanceRecursively");
              function recordVirtualUnmount(instance) {
                recordVirtualDisconnect(instance);
                idToDevToolsInstanceMap.delete(instance.id);
              }
              __name(recordVirtualUnmount, "recordVirtualUnmount");
              function recordVirtualDisconnect(instance) {
                if (isInDisconnectedSubtree) {
                  return;
                }
                if (trackedPathMatchInstance === instance) {
                  setTrackedPath(null);
                }
                var id = instance.id;
                pendingRealUnmountedIDs.push(id);
              }
              __name(recordVirtualDisconnect, "recordVirtualDisconnect");
              function getSecondaryEnvironmentName(debugInfo, index) {
                if (debugInfo != null) {
                  var componentInfo = debugInfo[index];
                  for (var i = index + 1; i < debugInfo.length; i++) {
                    var debugEntry = debugInfo[i];
                    if (typeof debugEntry.env === "string") {
                      return componentInfo.env !== debugEntry.env ? debugEntry.env : null;
                    }
                  }
                }
                return null;
              }
              __name(getSecondaryEnvironmentName, "getSecondaryEnvironmentName");
              function trackDebugInfoFromLazyType(fiber) {
                var type = fiber.elementType;
                var typeSymbol = getTypeSymbol(type);
                if (typeSymbol === LAZY_SYMBOL_STRING) {
                  var debugInfo = type._debugInfo;
                  if (debugInfo) {
                    for (var i = 0; i < debugInfo.length; i++) {
                      var debugEntry = debugInfo[i];
                      if (debugEntry.awaited) {
                        var asyncInfo = debugEntry;
                        insertSuspendedBy(asyncInfo);
                      }
                    }
                  }
                }
              }
              __name(trackDebugInfoFromLazyType, "trackDebugInfoFromLazyType");
              function trackDebugInfoFromUsedThenables(fiber) {
                var dependencies = fiber.dependencies;
                if (dependencies == null) {
                  return;
                }
                var thenableState = dependencies._debugThenableState;
                if (thenableState == null) {
                  return;
                }
                var usedThenables = thenableState.thenables || thenableState;
                if (!Array.isArray(usedThenables)) {
                  return;
                }
                for (var i = 0; i < usedThenables.length; i++) {
                  var thenable = usedThenables[i];
                  var debugInfo = thenable._debugInfo;
                  if (debugInfo) {
                    for (var j = 0; j < debugInfo.length; j++) {
                      var debugEntry = debugInfo[j];
                      if (debugEntry.awaited) {
                        var asyncInfo = debugEntry;
                        insertSuspendedBy(asyncInfo);
                      }
                    }
                  }
                }
              }
              __name(trackDebugInfoFromUsedThenables, "trackDebugInfoFromUsedThenables");
              var hostAsyncInfoCache = /* @__PURE__ */ new WeakMap();
              function trackDebugInfoFromHostResource(devtoolsInstance, fiber) {
                var resource = fiber.memoizedState;
                if (resource == null) {
                  return;
                }
                var existingEntry = hostAsyncInfoCache.get(resource);
                if (existingEntry !== void 0) {
                  insertSuspendedBy(existingEntry);
                  return;
                }
                var props = fiber.memoizedProps;
                var mayResourceSuspendCommit = resource.type === "stylesheet" && (typeof props.media !== "string" || typeof matchMedia !== "function" || matchMedia(props.media));
                if (!mayResourceSuspendCommit) {
                  return;
                }
                var instance = resource.instance;
                if (instance == null) {
                  return;
                }
                var href = instance.href;
                if (typeof href !== "string") {
                  return;
                }
                var start = -1;
                var end = -1;
                var byteSize = 0;
                if (typeof performance.getEntriesByType === "function") {
                  var resourceEntries = performance.getEntriesByType("resource");
                  for (var i = 0; i < resourceEntries.length; i++) {
                    var resourceEntry = resourceEntries[i];
                    if (resourceEntry.name === href) {
                      start = resourceEntry.startTime;
                      end = start + resourceEntry.duration;
                      byteSize = resourceEntry.transferSize || 0;
                    }
                  }
                }
                var value = instance.sheet;
                var promise = Promise.resolve(value);
                promise.status = "fulfilled";
                promise.value = value;
                var ioInfo = {
                  name: "stylesheet",
                  start,
                  end,
                  value: promise,
                  owner: fiber
                };
                if (byteSize > 0) {
                  ioInfo.byteSize = byteSize;
                }
                var asyncInfo = {
                  awaited: ioInfo,
                  owner: fiber._debugOwner == null ? null : fiber._debugOwner,
                  debugStack: fiber._debugStack == null ? null : fiber._debugStack,
                  debugTask: fiber._debugTask == null ? null : fiber._debugTask
                };
                hostAsyncInfoCache.set(resource, asyncInfo);
                insertSuspendedBy(asyncInfo);
              }
              __name(trackDebugInfoFromHostResource, "trackDebugInfoFromHostResource");
              function trackDebugInfoFromHostComponent(devtoolsInstance, fiber) {
                if (fiber.tag !== HostComponent) {
                  return;
                }
                if ((fiber.mode & SuspenseyImagesMode) === 0) {
                  return;
                }
                var type = fiber.type;
                var props = fiber.memoizedProps;
                var maySuspendCommit = type === "img" && props.src != null && props.src !== "" && props.onLoad == null && props.loading !== "lazy";
                if (!maySuspendCommit) {
                  return;
                }
                var instance = fiber.stateNode;
                if (instance == null) {
                  return;
                }
                var src = instance.currentSrc;
                if (typeof src !== "string" || src === "") {
                  return;
                }
                var start = -1;
                var end = -1;
                var byteSize = 0;
                var fileSize = 0;
                if (typeof performance.getEntriesByType === "function") {
                  var resourceEntries = performance.getEntriesByType("resource");
                  for (var i = 0; i < resourceEntries.length; i++) {
                    var resourceEntry = resourceEntries[i];
                    if (resourceEntry.name === src) {
                      start = resourceEntry.startTime;
                      end = start + resourceEntry.duration;
                      fileSize = resourceEntry.decodedBodySize || 0;
                      byteSize = resourceEntry.transferSize || 0;
                    }
                  }
                }
                var value = {
                  currentSrc: src
                };
                if (instance.naturalWidth > 0 && instance.naturalHeight > 0) {
                  value.naturalWidth = instance.naturalWidth;
                  value.naturalHeight = instance.naturalHeight;
                }
                if (fileSize > 0) {
                  value.fileSize = fileSize;
                }
                var promise = Promise.resolve(value);
                promise.status = "fulfilled";
                promise.value = value;
                var ioInfo = {
                  name: "img",
                  start,
                  end,
                  value: promise,
                  owner: fiber
                };
                if (byteSize > 0) {
                  ioInfo.byteSize = byteSize;
                }
                var asyncInfo = {
                  awaited: ioInfo,
                  owner: fiber._debugOwner == null ? null : fiber._debugOwner,
                  debugStack: fiber._debugStack == null ? null : fiber._debugStack,
                  debugTask: fiber._debugTask == null ? null : fiber._debugTask
                };
                insertSuspendedBy(asyncInfo);
              }
              __name(trackDebugInfoFromHostComponent, "trackDebugInfoFromHostComponent");
              function trackThrownPromisesFromRetryCache(suspenseNode, retryCache) {
                if (retryCache != null) {
                  if (!suspenseNode.hasUniqueSuspenders) {
                    recordSuspenseSuspenders(suspenseNode);
                  }
                  suspenseNode.hasUniqueSuspenders = true;
                  suspenseNode.hasUnknownSuspenders = true;
                }
              }
              __name(trackThrownPromisesFromRetryCache, "trackThrownPromisesFromRetryCache");
              function mountVirtualChildrenRecursively(firstChild, lastChild, traceNearestHostComponentUpdate, virtualLevel) {
                var fiber = firstChild;
                var previousVirtualInstance = null;
                var previousVirtualInstanceFirstFiber = firstChild;
                while (fiber !== null && fiber !== lastChild) {
                  var level = 0;
                  if (fiber._debugInfo) {
                    for (var i = 0; i < fiber._debugInfo.length; i++) {
                      var debugEntry = fiber._debugInfo[i];
                      if (debugEntry.awaited) {
                        var asyncInfo = debugEntry;
                        if (level === virtualLevel) {
                          insertSuspendedBy(asyncInfo);
                        }
                        continue;
                      }
                      if (typeof debugEntry.name !== "string") {
                        continue;
                      }
                      var componentInfo = debugEntry;
                      var secondaryEnv = getSecondaryEnvironmentName(fiber._debugInfo, i);
                      if (componentInfo.env != null) {
                        knownEnvironmentNames.add(componentInfo.env);
                      }
                      if (secondaryEnv !== null) {
                        knownEnvironmentNames.add(secondaryEnv);
                      }
                      if (shouldFilterVirtual(componentInfo, secondaryEnv)) {
                        continue;
                      }
                      if (level === virtualLevel) {
                        if (previousVirtualInstance === null || previousVirtualInstance.data !== debugEntry) {
                          if (previousVirtualInstance !== null) {
                            mountVirtualInstanceRecursively(previousVirtualInstance, previousVirtualInstanceFirstFiber, fiber, traceNearestHostComponentUpdate, virtualLevel);
                          }
                          previousVirtualInstance = createVirtualInstance(componentInfo);
                          recordVirtualMount(previousVirtualInstance, reconcilingParent, secondaryEnv);
                          insertChild(previousVirtualInstance);
                          previousVirtualInstanceFirstFiber = fiber;
                        }
                        level++;
                        break;
                      } else {
                        level++;
                      }
                    }
                  }
                  if (level === virtualLevel) {
                    if (previousVirtualInstance !== null) {
                      mountVirtualInstanceRecursively(previousVirtualInstance, previousVirtualInstanceFirstFiber, fiber, traceNearestHostComponentUpdate, virtualLevel);
                      previousVirtualInstance = null;
                    }
                    mountFiberRecursively(fiber, traceNearestHostComponentUpdate);
                  }
                  fiber = fiber.sibling;
                }
                if (previousVirtualInstance !== null) {
                  mountVirtualInstanceRecursively(previousVirtualInstance, previousVirtualInstanceFirstFiber, null, traceNearestHostComponentUpdate, virtualLevel);
                }
              }
              __name(mountVirtualChildrenRecursively, "mountVirtualChildrenRecursively");
              function mountChildrenRecursively(firstChild, traceNearestHostComponentUpdate) {
                mountVirtualChildrenRecursively(firstChild, null, traceNearestHostComponentUpdate, 0);
              }
              __name(mountChildrenRecursively, "mountChildrenRecursively");
              function mountSuspenseChildrenRecursively(contentFiber, traceNearestHostComponentUpdate, stashedSuspenseParent, stashedSuspensePrevious, stashedSuspenseRemaining) {
                var fallbackFiber = contentFiber.sibling;
                mountVirtualChildrenRecursively(contentFiber, fallbackFiber, traceNearestHostComponentUpdate, 0);
                reconcilingParentSuspenseNode = stashedSuspenseParent;
                previouslyReconciledSiblingSuspenseNode = stashedSuspensePrevious;
                remainingReconcilingChildrenSuspenseNodes = stashedSuspenseRemaining;
                if (fallbackFiber !== null) {
                  mountVirtualChildrenRecursively(fallbackFiber, null, traceNearestHostComponentUpdate, 0);
                }
              }
              __name(mountSuspenseChildrenRecursively, "mountSuspenseChildrenRecursively");
              function mountFiberRecursively(fiber, traceNearestHostComponentUpdate) {
                var shouldIncludeInTree = !shouldFilterFiber(fiber);
                var newInstance = null;
                var newSuspenseNode = null;
                if (shouldIncludeInTree) {
                  newInstance = recordMount(fiber, reconcilingParent);
                  if (fiber.tag === SuspenseComponent || fiber.tag === HostRoot) {
                    newSuspenseNode = createSuspenseNode(newInstance);
                    if (fiber.tag === SuspenseComponent) {
                      if (OffscreenComponent === -1) {
                        var isTimedOut = fiber.memoizedState !== null;
                        if (!isTimedOut) {
                          newSuspenseNode.rects = measureInstance(newInstance);
                        }
                      } else {
                        var hydrated = isFiberHydrated(fiber);
                        if (hydrated) {
                          var contentFiber = fiber.child;
                          if (contentFiber === null) {
                            throw new Error("There should always be an Offscreen Fiber child in a hydrated Suspense boundary.");
                          }
                        } else {
                        }
                        var _isTimedOut = fiber.memoizedState !== null;
                        if (!_isTimedOut) {
                          newSuspenseNode.rects = measureInstance(newInstance);
                        }
                      }
                    } else {
                      newSuspenseNode.rects = measureInstance(newInstance);
                    }
                    recordSuspenseMount(newSuspenseNode, reconcilingParentSuspenseNode);
                  }
                  insertChild(newInstance);
                  if (__DEBUG__) {
                    debug2("mountFiberRecursively()", newInstance, reconcilingParent);
                  }
                } else if (reconcilingParent !== null && reconcilingParent.kind === VIRTUAL_INSTANCE || fiber.tag === SuspenseComponent || fiber.tag === OffscreenComponent || fiber.tag === LegacyHiddenComponent) {
                  if (reconcilingParent !== null && reconcilingParent.kind === VIRTUAL_INSTANCE && reconcilingParent.data === fiber._debugOwner && fiber._debugStack != null && reconcilingParent.source === null) {
                    reconcilingParent.source = fiber._debugStack;
                  }
                  newInstance = createFilteredFiberInstance(fiber);
                  if (fiber.tag === SuspenseComponent) {
                    newSuspenseNode = createSuspenseNode(newInstance);
                    if (OffscreenComponent === -1) {
                      var _isTimedOut2 = fiber.memoizedState !== null;
                      if (!_isTimedOut2) {
                        newSuspenseNode.rects = measureInstance(newInstance);
                      }
                    } else {
                      var _hydrated = isFiberHydrated(fiber);
                      if (_hydrated) {
                        var _contentFiber = fiber.child;
                        if (_contentFiber === null) {
                          throw new Error("There should always be an Offscreen Fiber child in a hydrated Suspense boundary.");
                        }
                      } else {
                      }
                      var suspenseState = fiber.memoizedState;
                      var _isTimedOut3 = suspenseState !== null;
                      if (!_isTimedOut3) {
                        newSuspenseNode.rects = measureInstance(newInstance);
                      }
                    }
                  }
                  insertChild(newInstance);
                  if (__DEBUG__) {
                    debug2("mountFiberRecursively()", newInstance, reconcilingParent);
                  }
                }
                var mightSiblingsBeOnTrackedPath = updateTrackedPathStateBeforeMount(fiber, newInstance);
                var stashedParent = reconcilingParent;
                var stashedPrevious = previouslyReconciledSibling;
                var stashedRemaining = remainingReconcilingChildren;
                var stashedSuspenseParent = reconcilingParentSuspenseNode;
                var stashedSuspensePrevious = previouslyReconciledSiblingSuspenseNode;
                var stashedSuspenseRemaining = remainingReconcilingChildrenSuspenseNodes;
                if (newInstance !== null) {
                  reconcilingParent = newInstance;
                  previouslyReconciledSibling = null;
                  remainingReconcilingChildren = null;
                }
                var shouldPopSuspenseNode = false;
                if (newSuspenseNode !== null) {
                  reconcilingParentSuspenseNode = newSuspenseNode;
                  previouslyReconciledSiblingSuspenseNode = null;
                  remainingReconcilingChildrenSuspenseNodes = null;
                  shouldPopSuspenseNode = true;
                }
                try {
                  if (traceUpdatesEnabled) {
                    if (traceNearestHostComponentUpdate) {
                      var elementType = getElementTypeForFiber(fiber);
                      if (elementType === ElementTypeHostComponent) {
                        traceUpdatesForNodes.add(fiber.stateNode);
                        traceNearestHostComponentUpdate = false;
                      }
                    }
                  }
                  trackDebugInfoFromLazyType(fiber);
                  trackDebugInfoFromUsedThenables(fiber);
                  if (fiber.tag === HostHoistable) {
                    var nearestInstance = reconcilingParent;
                    if (nearestInstance === null) {
                      throw new Error("Did not expect a host hoistable to be the root");
                    }
                    aquireHostResource(nearestInstance, fiber.memoizedState);
                    trackDebugInfoFromHostResource(nearestInstance, fiber);
                  } else if (fiber.tag === HostComponent || fiber.tag === HostText || fiber.tag === HostSingleton) {
                    var _nearestInstance = reconcilingParent;
                    if (_nearestInstance === null) {
                      throw new Error("Did not expect a host hoistable to be the root");
                    }
                    aquireHostInstance(_nearestInstance, fiber.stateNode);
                    trackDebugInfoFromHostComponent(_nearestInstance, fiber);
                  }
                  if (isSuspendedOffscreen(fiber)) {
                    var stashedDisconnected = isInDisconnectedSubtree;
                    isInDisconnectedSubtree = true;
                    try {
                      if (fiber.child !== null) {
                        mountChildrenRecursively(fiber.child, false);
                      }
                    } finally {
                      isInDisconnectedSubtree = stashedDisconnected;
                    }
                  } else if (isHiddenOffscreen(fiber)) {
                  } else if (fiber.tag === SuspenseComponent && OffscreenComponent === -1) {
                    if (newSuspenseNode !== null) {
                      trackThrownPromisesFromRetryCache(newSuspenseNode, fiber.stateNode);
                    }
                    var _isTimedOut4 = fiber.memoizedState !== null;
                    if (_isTimedOut4) {
                      var primaryChildFragment = fiber.child;
                      var fallbackChildFragment = primaryChildFragment ? primaryChildFragment.sibling : null;
                      if (fallbackChildFragment) {
                        var fallbackChild = fallbackChildFragment.child;
                        if (fallbackChild !== null) {
                          updateTrackedPathStateBeforeMount(fallbackChildFragment, null);
                          mountChildrenRecursively(fallbackChild, traceNearestHostComponentUpdate);
                        }
                      }
                    } else {
                      var primaryChild = fiber.child;
                      if (primaryChild !== null) {
                        mountChildrenRecursively(primaryChild, traceNearestHostComponentUpdate);
                      }
                    }
                  } else if (fiber.tag === SuspenseComponent && OffscreenComponent !== -1 && newInstance !== null && newSuspenseNode !== null) {
                    var _contentFiber2 = fiber.child;
                    var _hydrated2 = isFiberHydrated(fiber);
                    if (_hydrated2) {
                      if (_contentFiber2 === null) {
                        throw new Error("There should always be an Offscreen Fiber child in a hydrated Suspense boundary.");
                      }
                      trackThrownPromisesFromRetryCache(newSuspenseNode, fiber.stateNode);
                      mountSuspenseChildrenRecursively(_contentFiber2, traceNearestHostComponentUpdate, stashedSuspenseParent, stashedSuspensePrevious, stashedSuspenseRemaining);
                      shouldPopSuspenseNode = false;
                    } else {
                    }
                  } else {
                    if (fiber.child !== null) {
                      mountChildrenRecursively(fiber.child, traceNearestHostComponentUpdate);
                    }
                  }
                } finally {
                  if (newInstance !== null) {
                    reconcilingParent = stashedParent;
                    previouslyReconciledSibling = stashedPrevious;
                    remainingReconcilingChildren = stashedRemaining;
                  }
                  if (shouldPopSuspenseNode) {
                    reconcilingParentSuspenseNode = stashedSuspenseParent;
                    previouslyReconciledSiblingSuspenseNode = stashedSuspensePrevious;
                    remainingReconcilingChildrenSuspenseNodes = stashedSuspenseRemaining;
                  }
                }
                updateTrackedPathStateAfterMount(mightSiblingsBeOnTrackedPath);
              }
              __name(mountFiberRecursively, "mountFiberRecursively");
              function unmountInstanceRecursively(instance) {
                if (__DEBUG__) {
                  debug2("unmountInstanceRecursively()", instance, reconcilingParent);
                }
                var shouldPopSuspenseNode = false;
                var stashedParent = reconcilingParent;
                var stashedPrevious = previouslyReconciledSibling;
                var stashedRemaining = remainingReconcilingChildren;
                var stashedSuspenseParent = reconcilingParentSuspenseNode;
                var stashedSuspensePrevious = previouslyReconciledSiblingSuspenseNode;
                var stashedSuspenseRemaining = remainingReconcilingChildrenSuspenseNodes;
                var previousSuspendedBy = instance.suspendedBy;
                reconcilingParent = instance;
                previouslyReconciledSibling = null;
                remainingReconcilingChildren = instance.firstChild;
                instance.firstChild = null;
                instance.suspendedBy = null;
                if (instance.suspenseNode !== null) {
                  reconcilingParentSuspenseNode = instance.suspenseNode;
                  previouslyReconciledSiblingSuspenseNode = null;
                  remainingReconcilingChildrenSuspenseNodes = instance.suspenseNode.firstChild;
                  shouldPopSuspenseNode = true;
                }
                try {
                  if ((instance.kind === FIBER_INSTANCE || instance.kind === FILTERED_FIBER_INSTANCE) && instance.data.tag === SuspenseComponent && OffscreenComponent !== -1) {
                    var _fiber4 = instance.data;
                    var contentFiberInstance = remainingReconcilingChildren;
                    var hydrated = isFiberHydrated(_fiber4);
                    if (hydrated) {
                      if (contentFiberInstance === null) {
                        throw new Error("There should always be an Offscreen Fiber child in a hydrated Suspense boundary.");
                      }
                      unmountSuspenseChildrenRecursively(contentFiberInstance, stashedSuspenseParent, stashedSuspensePrevious, stashedSuspenseRemaining);
                      shouldPopSuspenseNode = false;
                    } else {
                      if (contentFiberInstance !== null) {
                        throw new Error("A dehydrated Suspense node should not have a content Fiber.");
                      }
                    }
                  } else {
                    unmountRemainingChildren();
                  }
                  removePreviousSuspendedBy(instance, previousSuspendedBy, reconcilingParentSuspenseNode);
                } finally {
                  reconcilingParent = stashedParent;
                  previouslyReconciledSibling = stashedPrevious;
                  remainingReconcilingChildren = stashedRemaining;
                  if (shouldPopSuspenseNode) {
                    reconcilingParentSuspenseNode = stashedSuspenseParent;
                    previouslyReconciledSiblingSuspenseNode = stashedSuspensePrevious;
                    remainingReconcilingChildrenSuspenseNodes = stashedSuspenseRemaining;
                  }
                }
                if (instance.kind === FIBER_INSTANCE) {
                  recordUnmount(instance);
                } else if (instance.kind === VIRTUAL_INSTANCE) {
                  recordVirtualUnmount(instance);
                } else {
                  untrackFiber(instance, instance.data);
                }
                removeChild(instance, null);
              }
              __name(unmountInstanceRecursively, "unmountInstanceRecursively");
              function recordProfilingDurations(fiberInstance, prevFiber) {
                var id = fiberInstance.id;
                var fiber = fiberInstance.data;
                var actualDuration = fiber.actualDuration, treeBaseDuration = fiber.treeBaseDuration;
                fiberInstance.treeBaseDuration = treeBaseDuration || 0;
                if (isProfiling) {
                  if (prevFiber == null || treeBaseDuration !== prevFiber.treeBaseDuration) {
                    var convertedTreeBaseDuration = Math.floor((treeBaseDuration || 0) * 1e3);
                    pushOperation(TREE_OPERATION_UPDATE_TREE_BASE_DURATION);
                    pushOperation(id);
                    pushOperation(convertedTreeBaseDuration);
                  }
                  if (prevFiber == null || didFiberRender(prevFiber, fiber)) {
                    if (actualDuration != null) {
                      var selfDuration = actualDuration;
                      var child = fiber.child;
                      while (child !== null) {
                        selfDuration -= child.actualDuration || 0;
                        child = child.sibling;
                      }
                      var metadata = currentCommitProfilingMetadata;
                      metadata.durations.push(id, actualDuration, selfDuration);
                      metadata.maxActualDuration = Math.max(metadata.maxActualDuration, actualDuration);
                      if (recordChangeDescriptions) {
                        var changeDescription = getChangeDescription(prevFiber, fiber);
                        if (changeDescription !== null) {
                          if (metadata.changeDescriptions !== null) {
                            metadata.changeDescriptions.set(id, changeDescription);
                          }
                        }
                      }
                    }
                  }
                  var fiberRoot = currentRoot.data.stateNode;
                  var updaters = fiberRoot.memoizedUpdaters;
                  if (updaters != null && (updaters.has(fiber) || fiber.alternate !== null && updaters.has(fiber.alternate))) {
                    var _metadata = currentCommitProfilingMetadata;
                    if (_metadata.updaters === null) {
                      _metadata.updaters = [];
                    }
                    _metadata.updaters.push(instanceToSerializedElement(fiberInstance));
                  }
                }
              }
              __name(recordProfilingDurations, "recordProfilingDurations");
              function recordVirtualProfilingDurations(virtualInstance) {
                var id = virtualInstance.id;
                var treeBaseDuration = 0;
                for (var child = virtualInstance.firstChild; child !== null; child = child.nextSibling) {
                  treeBaseDuration += child.treeBaseDuration;
                }
                if (isProfiling) {
                  var previousTreeBaseDuration = virtualInstance.treeBaseDuration;
                  if (treeBaseDuration !== previousTreeBaseDuration) {
                    var convertedTreeBaseDuration = Math.floor((treeBaseDuration || 0) * 1e3);
                    pushOperation(TREE_OPERATION_UPDATE_TREE_BASE_DURATION);
                    pushOperation(id);
                    pushOperation(convertedTreeBaseDuration);
                  }
                }
                virtualInstance.treeBaseDuration = treeBaseDuration;
              }
              __name(recordVirtualProfilingDurations, "recordVirtualProfilingDurations");
              function addUnfilteredChildrenIDs(parentInstance, nextChildren) {
                var child = parentInstance.firstChild;
                while (child !== null) {
                  if (child.kind === FILTERED_FIBER_INSTANCE) {
                    var _fiber5 = child.data;
                    if (isHiddenOffscreen(_fiber5)) {
                    } else {
                      addUnfilteredChildrenIDs(child, nextChildren);
                    }
                  } else {
                    nextChildren.push(child.id);
                  }
                  child = child.nextSibling;
                }
              }
              __name(addUnfilteredChildrenIDs, "addUnfilteredChildrenIDs");
              function recordResetChildren(parentInstance) {
                if (__DEBUG__) {
                  if (parentInstance.firstChild !== null) {
                    debug2("recordResetChildren()", parentInstance.firstChild, parentInstance);
                  }
                }
                var nextChildren = [];
                addUnfilteredChildrenIDs(parentInstance, nextChildren);
                var numChildren = nextChildren.length;
                if (numChildren < 2) {
                  return;
                }
                pushOperation(TREE_OPERATION_REORDER_CHILDREN);
                pushOperation(parentInstance.id);
                pushOperation(numChildren);
                for (var i = 0; i < nextChildren.length; i++) {
                  pushOperation(nextChildren[i]);
                }
              }
              __name(recordResetChildren, "recordResetChildren");
              function addUnfilteredSuspenseChildrenIDs(parentInstance, nextChildren) {
                var child = parentInstance.firstChild;
                while (child !== null) {
                  if (child.instance.kind === FILTERED_FIBER_INSTANCE) {
                    addUnfilteredSuspenseChildrenIDs(child, nextChildren);
                  } else {
                    nextChildren.push(child.instance.id);
                  }
                  child = child.nextSibling;
                }
              }
              __name(addUnfilteredSuspenseChildrenIDs, "addUnfilteredSuspenseChildrenIDs");
              function recordResetSuspenseChildren(parentInstance) {
                if (__DEBUG__) {
                  if (parentInstance.firstChild !== null) {
                    console.log("recordResetSuspenseChildren()", parentInstance.firstChild, parentInstance);
                  }
                }
                var nextChildren = [];
                addUnfilteredSuspenseChildrenIDs(parentInstance, nextChildren);
                var numChildren = nextChildren.length;
                if (numChildren < 2) {
                  return;
                }
                pushOperation(SUSPENSE_TREE_OPERATION_REORDER_CHILDREN);
                pushOperation(parentInstance.instance.id);
                pushOperation(numChildren);
                for (var i = 0; i < nextChildren.length; i++) {
                  pushOperation(nextChildren[i]);
                }
              }
              __name(recordResetSuspenseChildren, "recordResetSuspenseChildren");
              function updateVirtualInstanceRecursively(virtualInstance, nextFirstChild, nextLastChild, prevFirstChild, traceNearestHostComponentUpdate, virtualLevel) {
                var stashedParent = reconcilingParent;
                var stashedPrevious = previouslyReconciledSibling;
                var stashedRemaining = remainingReconcilingChildren;
                var previousSuspendedBy = virtualInstance.suspendedBy;
                reconcilingParent = virtualInstance;
                previouslyReconciledSibling = null;
                remainingReconcilingChildren = virtualInstance.firstChild;
                virtualInstance.firstChild = null;
                virtualInstance.suspendedBy = null;
                try {
                  var updateFlags = updateVirtualChildrenRecursively(nextFirstChild, nextLastChild, prevFirstChild, traceNearestHostComponentUpdate, virtualLevel + 1);
                  if ((updateFlags & ShouldResetChildren) !== NoUpdate) {
                    if (!isInDisconnectedSubtree) {
                      recordResetChildren(virtualInstance);
                    }
                    updateFlags &= ~ShouldResetChildren;
                  }
                  removePreviousSuspendedBy(virtualInstance, previousSuspendedBy, reconcilingParentSuspenseNode);
                  var componentLogsEntry = componentInfoToComponentLogsMap.get(virtualInstance.data);
                  recordConsoleLogs(virtualInstance, componentLogsEntry);
                  recordVirtualProfilingDurations(virtualInstance);
                  return updateFlags;
                } finally {
                  unmountRemainingChildren();
                  reconcilingParent = stashedParent;
                  previouslyReconciledSibling = stashedPrevious;
                  remainingReconcilingChildren = stashedRemaining;
                }
              }
              __name(updateVirtualInstanceRecursively, "updateVirtualInstanceRecursively");
              function updateVirtualChildrenRecursively(nextFirstChild, nextLastChild, prevFirstChild, traceNearestHostComponentUpdate, virtualLevel) {
                var updateFlags = NoUpdate;
                var nextChild = nextFirstChild;
                var prevChildAtSameIndex = prevFirstChild;
                var previousVirtualInstance = null;
                var previousVirtualInstanceWasMount = false;
                var previousVirtualInstanceNextFirstFiber = nextFirstChild;
                var previousVirtualInstancePrevFirstFiber = prevFirstChild;
                while (nextChild !== null && nextChild !== nextLastChild) {
                  var level = 0;
                  if (nextChild._debugInfo) {
                    for (var i = 0; i < nextChild._debugInfo.length; i++) {
                      var debugEntry = nextChild._debugInfo[i];
                      if (debugEntry.awaited) {
                        var asyncInfo = debugEntry;
                        if (level === virtualLevel) {
                          insertSuspendedBy(asyncInfo);
                        }
                        continue;
                      }
                      if (typeof debugEntry.name !== "string") {
                        continue;
                      }
                      var componentInfo = debugEntry;
                      var secondaryEnv = getSecondaryEnvironmentName(nextChild._debugInfo, i);
                      if (componentInfo.env != null) {
                        knownEnvironmentNames.add(componentInfo.env);
                      }
                      if (secondaryEnv !== null) {
                        knownEnvironmentNames.add(secondaryEnv);
                      }
                      if (shouldFilterVirtual(componentInfo, secondaryEnv)) {
                        continue;
                      }
                      if (level === virtualLevel) {
                        if (previousVirtualInstance === null || previousVirtualInstance.data !== componentInfo) {
                          if (previousVirtualInstance !== null) {
                            if (previousVirtualInstanceWasMount) {
                              mountVirtualInstanceRecursively(previousVirtualInstance, previousVirtualInstanceNextFirstFiber, nextChild, traceNearestHostComponentUpdate, virtualLevel);
                              updateFlags |= ShouldResetChildren | ShouldResetSuspenseChildren;
                            } else {
                              updateFlags |= updateVirtualInstanceRecursively(previousVirtualInstance, previousVirtualInstanceNextFirstFiber, nextChild, previousVirtualInstancePrevFirstFiber, traceNearestHostComponentUpdate, virtualLevel);
                            }
                          }
                          var previousSiblingOfBestMatch = null;
                          var bestMatch = remainingReconcilingChildren;
                          if (componentInfo.key != null) {
                            bestMatch = remainingReconcilingChildren;
                            while (bestMatch !== null) {
                              if (bestMatch.kind === VIRTUAL_INSTANCE && bestMatch.data.key === componentInfo.key) {
                                break;
                              }
                              previousSiblingOfBestMatch = bestMatch;
                              bestMatch = bestMatch.nextSibling;
                            }
                          }
                          if (bestMatch !== null && bestMatch.kind === VIRTUAL_INSTANCE && bestMatch.data.name === componentInfo.name && bestMatch.data.env === componentInfo.env && bestMatch.data.key === componentInfo.key) {
                            bestMatch.data = componentInfo;
                            moveChild(bestMatch, previousSiblingOfBestMatch);
                            previousVirtualInstance = bestMatch;
                            previousVirtualInstanceWasMount = false;
                          } else {
                            var newVirtualInstance = createVirtualInstance(componentInfo);
                            recordVirtualMount(newVirtualInstance, reconcilingParent, secondaryEnv);
                            insertChild(newVirtualInstance);
                            previousVirtualInstance = newVirtualInstance;
                            previousVirtualInstanceWasMount = true;
                            updateFlags |= ShouldResetChildren;
                          }
                          previousVirtualInstanceNextFirstFiber = nextChild;
                          previousVirtualInstancePrevFirstFiber = prevChildAtSameIndex;
                        }
                        level++;
                        break;
                      } else {
                        level++;
                      }
                    }
                  }
                  if (level === virtualLevel) {
                    if (previousVirtualInstance !== null) {
                      if (previousVirtualInstanceWasMount) {
                        mountVirtualInstanceRecursively(previousVirtualInstance, previousVirtualInstanceNextFirstFiber, nextChild, traceNearestHostComponentUpdate, virtualLevel);
                        updateFlags |= ShouldResetChildren | ShouldResetSuspenseChildren;
                      } else {
                        updateFlags |= updateVirtualInstanceRecursively(previousVirtualInstance, previousVirtualInstanceNextFirstFiber, nextChild, previousVirtualInstancePrevFirstFiber, traceNearestHostComponentUpdate, virtualLevel);
                      }
                      previousVirtualInstance = null;
                    }
                    var prevChild = void 0;
                    if (prevChildAtSameIndex === nextChild) {
                      prevChild = nextChild;
                    } else {
                      prevChild = nextChild.alternate;
                    }
                    var previousSiblingOfExistingInstance = null;
                    var existingInstance = null;
                    if (prevChild !== null) {
                      existingInstance = remainingReconcilingChildren;
                      while (existingInstance !== null) {
                        if (existingInstance.data === prevChild) {
                          break;
                        }
                        previousSiblingOfExistingInstance = existingInstance;
                        existingInstance = existingInstance.nextSibling;
                      }
                    }
                    if (existingInstance !== null) {
                      var fiberInstance = existingInstance;
                      if (prevChild !== prevChildAtSameIndex) {
                        updateFlags |= ShouldResetChildren | ShouldResetSuspenseChildren;
                      }
                      moveChild(fiberInstance, previousSiblingOfExistingInstance);
                      updateFlags |= updateFiberRecursively(fiberInstance, nextChild, prevChild, traceNearestHostComponentUpdate);
                    } else if (prevChild !== null && shouldFilterFiber(nextChild)) {
                      if (prevChild !== prevChildAtSameIndex) {
                        updateFlags |= ShouldResetChildren | ShouldResetSuspenseChildren;
                      }
                      updateFlags |= updateFiberRecursively(null, nextChild, prevChild, traceNearestHostComponentUpdate);
                    } else {
                      mountFiberRecursively(nextChild, traceNearestHostComponentUpdate);
                      updateFlags |= ShouldResetChildren | ShouldResetSuspenseChildren;
                    }
                  }
                  nextChild = nextChild.sibling;
                  if ((updateFlags & ShouldResetChildren) === NoUpdate && prevChildAtSameIndex !== null) {
                    prevChildAtSameIndex = prevChildAtSameIndex.sibling;
                  }
                }
                if (previousVirtualInstance !== null) {
                  if (previousVirtualInstanceWasMount) {
                    mountVirtualInstanceRecursively(previousVirtualInstance, previousVirtualInstanceNextFirstFiber, null, traceNearestHostComponentUpdate, virtualLevel);
                    updateFlags |= ShouldResetChildren | ShouldResetSuspenseChildren;
                  } else {
                    updateFlags |= updateVirtualInstanceRecursively(previousVirtualInstance, previousVirtualInstanceNextFirstFiber, null, previousVirtualInstancePrevFirstFiber, traceNearestHostComponentUpdate, virtualLevel);
                  }
                }
                if (prevChildAtSameIndex !== null) {
                  updateFlags |= ShouldResetChildren | ShouldResetSuspenseChildren;
                }
                return updateFlags;
              }
              __name(updateVirtualChildrenRecursively, "updateVirtualChildrenRecursively");
              function updateChildrenRecursively(nextFirstChild, prevFirstChild, traceNearestHostComponentUpdate) {
                if (nextFirstChild === null) {
                  return prevFirstChild !== null ? ShouldResetChildren : NoUpdate;
                }
                return updateVirtualChildrenRecursively(nextFirstChild, null, prevFirstChild, traceNearestHostComponentUpdate, 0);
              }
              __name(updateChildrenRecursively, "updateChildrenRecursively");
              function updateSuspenseChildrenRecursively(nextContentFiber, prevContentFiber, traceNearestHostComponentUpdate, stashedSuspenseParent, stashedSuspensePrevious, stashedSuspenseRemaining) {
                var updateFlags = NoUpdate;
                var prevFallbackFiber = prevContentFiber.sibling;
                var nextFallbackFiber = nextContentFiber.sibling;
                updateFlags |= updateVirtualChildrenRecursively(nextContentFiber, nextFallbackFiber, prevContentFiber, traceNearestHostComponentUpdate, 0);
                reconcilingParentSuspenseNode = stashedSuspenseParent;
                previouslyReconciledSiblingSuspenseNode = stashedSuspensePrevious;
                remainingReconcilingChildrenSuspenseNodes = stashedSuspenseRemaining;
                if (prevFallbackFiber !== null || nextFallbackFiber !== null) {
                  if (nextFallbackFiber === null) {
                    unmountRemainingChildren();
                  } else {
                    updateFlags |= updateVirtualChildrenRecursively(nextFallbackFiber, null, prevFallbackFiber, traceNearestHostComponentUpdate, 0);
                    if ((updateFlags & ShouldResetSuspenseChildren) !== NoUpdate) {
                      updateFlags |= ShouldResetParentSuspenseChildren;
                      updateFlags &= ~ShouldResetSuspenseChildren;
                    }
                  }
                }
                return updateFlags;
              }
              __name(updateSuspenseChildrenRecursively, "updateSuspenseChildrenRecursively");
              function updateFiberRecursively(fiberInstance, nextFiber, prevFiber, traceNearestHostComponentUpdate) {
                if (__DEBUG__) {
                  if (fiberInstance !== null) {
                    debug2("updateFiberRecursively()", fiberInstance, reconcilingParent);
                  }
                }
                if (traceUpdatesEnabled) {
                  var elementType = getElementTypeForFiber(nextFiber);
                  if (traceNearestHostComponentUpdate) {
                    if (elementType === ElementTypeHostComponent) {
                      traceUpdatesForNodes.add(nextFiber.stateNode);
                      traceNearestHostComponentUpdate = false;
                    }
                  } else {
                    if (elementType === types_ElementTypeFunction || elementType === types_ElementTypeClass || elementType === ElementTypeContext || elementType === types_ElementTypeMemo || elementType === types_ElementTypeForwardRef) {
                      traceNearestHostComponentUpdate = didFiberRender(prevFiber, nextFiber);
                    }
                  }
                }
                var stashedParent = reconcilingParent;
                var stashedPrevious = previouslyReconciledSibling;
                var stashedRemaining = remainingReconcilingChildren;
                var stashedSuspenseParent = reconcilingParentSuspenseNode;
                var stashedSuspensePrevious = previouslyReconciledSiblingSuspenseNode;
                var stashedSuspenseRemaining = remainingReconcilingChildrenSuspenseNodes;
                var updateFlags = NoUpdate;
                var shouldMeasureSuspenseNode = false;
                var shouldPopSuspenseNode = false;
                var previousSuspendedBy = null;
                if (fiberInstance !== null) {
                  previousSuspendedBy = fiberInstance.suspendedBy;
                  fiberInstance.data = nextFiber;
                  if (mostRecentlyInspectedElement !== null && (mostRecentlyInspectedElement.id === fiberInstance.id || mostRecentlyInspectedElement.type === ElementTypeRoot && nextFiber.tag === HostRoot) && didFiberRender(prevFiber, nextFiber)) {
                    hasElementUpdatedSinceLastInspected = true;
                  }
                  reconcilingParent = fiberInstance;
                  previouslyReconciledSibling = null;
                  remainingReconcilingChildren = fiberInstance.firstChild;
                  fiberInstance.firstChild = null;
                  fiberInstance.suspendedBy = null;
                  var suspenseNode = fiberInstance.suspenseNode;
                  if (suspenseNode !== null) {
                    reconcilingParentSuspenseNode = suspenseNode;
                    previouslyReconciledSiblingSuspenseNode = null;
                    remainingReconcilingChildrenSuspenseNodes = suspenseNode.firstChild;
                    suspenseNode.firstChild = null;
                    shouldMeasureSuspenseNode = true;
                    shouldPopSuspenseNode = true;
                  }
                }
                try {
                  trackDebugInfoFromLazyType(nextFiber);
                  trackDebugInfoFromUsedThenables(nextFiber);
                  if (nextFiber.tag === HostHoistable) {
                    var nearestInstance = reconcilingParent;
                    if (nearestInstance === null) {
                      throw new Error("Did not expect a host hoistable to be the root");
                    }
                    if (prevFiber.memoizedState !== nextFiber.memoizedState) {
                      releaseHostResource(nearestInstance, prevFiber.memoizedState);
                      aquireHostResource(nearestInstance, nextFiber.memoizedState);
                    }
                    trackDebugInfoFromHostResource(nearestInstance, nextFiber);
                  } else if (nextFiber.tag === HostComponent || nextFiber.tag === HostText || nextFiber.tag === HostSingleton) {
                    var _nearestInstance2 = reconcilingParent;
                    if (_nearestInstance2 === null) {
                      throw new Error("Did not expect a host hoistable to be the root");
                    }
                    if (prevFiber.stateNode !== nextFiber.stateNode) {
                      releaseHostInstance(_nearestInstance2, prevFiber.stateNode);
                      aquireHostInstance(_nearestInstance2, nextFiber.stateNode);
                    }
                    trackDebugInfoFromHostComponent(_nearestInstance2, nextFiber);
                  }
                  var isLegacySuspense = nextFiber.tag === SuspenseComponent && OffscreenComponent === -1;
                  var prevDidTimeout = isLegacySuspense && prevFiber.memoizedState !== null;
                  var nextDidTimeOut = isLegacySuspense && nextFiber.memoizedState !== null;
                  var prevWasHidden = isHiddenOffscreen(prevFiber);
                  var nextIsHidden = isHiddenOffscreen(nextFiber);
                  var prevWasSuspended = isSuspendedOffscreen(prevFiber);
                  var nextIsSuspended = isSuspendedOffscreen(nextFiber);
                  if (isLegacySuspense) {
                    if (fiberInstance !== null && fiberInstance.suspenseNode !== null) {
                      var _suspenseNode = fiberInstance.suspenseNode;
                      if (prevFiber.stateNode === null !== (nextFiber.stateNode === null)) {
                        trackThrownPromisesFromRetryCache(_suspenseNode, nextFiber.stateNode);
                      }
                      if (prevFiber.memoizedState === null !== (nextFiber.memoizedState === null)) {
                        recordSuspenseSuspenders(_suspenseNode);
                      }
                    }
                  }
                  if (prevDidTimeout && nextDidTimeOut) {
                    var nextFiberChild = nextFiber.child;
                    var nextFallbackChildSet = nextFiberChild ? nextFiberChild.sibling : null;
                    var prevFiberChild = prevFiber.child;
                    var prevFallbackChildSet = prevFiberChild ? prevFiberChild.sibling : null;
                    if (prevFallbackChildSet == null && nextFallbackChildSet != null) {
                      mountChildrenRecursively(nextFallbackChildSet, traceNearestHostComponentUpdate);
                      updateFlags |= ShouldResetChildren | ShouldResetSuspenseChildren;
                    }
                    var childrenUpdateFlags = nextFallbackChildSet != null && prevFallbackChildSet != null ? updateChildrenRecursively(nextFallbackChildSet, prevFallbackChildSet, traceNearestHostComponentUpdate) : NoUpdate;
                    updateFlags |= childrenUpdateFlags;
                  } else if (prevDidTimeout && !nextDidTimeOut) {
                    var nextPrimaryChildSet = nextFiber.child;
                    if (nextPrimaryChildSet !== null) {
                      mountChildrenRecursively(nextPrimaryChildSet, traceNearestHostComponentUpdate);
                      updateFlags |= ShouldResetChildren | ShouldResetSuspenseChildren;
                    }
                  } else if (!prevDidTimeout && nextDidTimeOut) {
                    var _nextFiberChild = nextFiber.child;
                    var _nextFallbackChildSet = _nextFiberChild ? _nextFiberChild.sibling : null;
                    if (_nextFallbackChildSet != null) {
                      mountChildrenRecursively(_nextFallbackChildSet, traceNearestHostComponentUpdate);
                      updateFlags |= ShouldResetChildren | ShouldResetSuspenseChildren;
                    }
                  } else if (nextIsSuspended) {
                    if (!prevWasSuspended) {
                      if (fiberInstance !== null && !isInDisconnectedSubtree) {
                        disconnectChildrenRecursively(remainingReconcilingChildren);
                      }
                    }
                    var stashedDisconnected = isInDisconnectedSubtree;
                    isInDisconnectedSubtree = true;
                    try {
                      updateFlags |= updateChildrenRecursively(nextFiber.child, prevFiber.child, false);
                    } finally {
                      isInDisconnectedSubtree = stashedDisconnected;
                    }
                  } else if (prevWasSuspended && !nextIsSuspended) {
                    var _stashedDisconnected = isInDisconnectedSubtree;
                    isInDisconnectedSubtree = true;
                    try {
                      if (nextFiber.child !== null) {
                        updateFlags |= updateChildrenRecursively(nextFiber.child, prevFiber.child, false);
                      }
                      unmountRemainingChildren();
                      remainingReconcilingChildren = null;
                    } finally {
                      isInDisconnectedSubtree = _stashedDisconnected;
                    }
                    if (fiberInstance !== null && !isInDisconnectedSubtree) {
                      reconnectChildrenRecursively(fiberInstance);
                      updateFlags |= ShouldResetChildren | ShouldResetSuspenseChildren;
                    }
                  } else if (nextIsHidden) {
                    if (prevWasHidden) {
                    } else {
                      unmountRemainingChildren();
                    }
                  } else if (nextFiber.tag === SuspenseComponent && OffscreenComponent !== -1 && fiberInstance !== null && fiberInstance.suspenseNode !== null) {
                    var _suspenseNode2 = fiberInstance.suspenseNode;
                    var prevContentFiber = prevFiber.child;
                    var nextContentFiber = nextFiber.child;
                    var previousHydrated = isFiberHydrated(prevFiber);
                    var nextHydrated = isFiberHydrated(nextFiber);
                    if (previousHydrated && nextHydrated) {
                      if (nextContentFiber === null || prevContentFiber === null) {
                        throw new Error("There should always be an Offscreen Fiber child in a hydrated Suspense boundary.");
                      }
                      if (prevFiber.stateNode === null !== (nextFiber.stateNode === null)) {
                        trackThrownPromisesFromRetryCache(_suspenseNode2, nextFiber.stateNode);
                      }
                      if (prevFiber.memoizedState === null !== (nextFiber.memoizedState === null)) {
                        recordSuspenseSuspenders(_suspenseNode2);
                      }
                      shouldMeasureSuspenseNode = false;
                      updateFlags |= updateSuspenseChildrenRecursively(nextContentFiber, prevContentFiber, traceNearestHostComponentUpdate, stashedSuspenseParent, stashedSuspensePrevious, stashedSuspenseRemaining);
                      shouldPopSuspenseNode = false;
                      if (nextFiber.memoizedState === null) {
                        shouldMeasureSuspenseNode = !isInDisconnectedSubtree;
                      }
                    } else if (!previousHydrated && nextHydrated) {
                      if (nextContentFiber === null) {
                        throw new Error("There should always be an Offscreen Fiber child in a hydrated Suspense boundary.");
                      }
                      trackThrownPromisesFromRetryCache(_suspenseNode2, nextFiber.stateNode);
                      recordSuspenseSuspenders(_suspenseNode2);
                      mountSuspenseChildrenRecursively(nextContentFiber, traceNearestHostComponentUpdate, stashedSuspenseParent, stashedSuspensePrevious, stashedSuspenseRemaining);
                      shouldPopSuspenseNode = false;
                    } else if (previousHydrated && !nextHydrated) {
                      throw new Error("Encountered a dehydrated Suspense boundary that was previously hydrated.");
                    } else {
                    }
                  } else {
                    if (nextFiber.child !== prevFiber.child) {
                      updateFlags |= updateChildrenRecursively(nextFiber.child, prevFiber.child, traceNearestHostComponentUpdate);
                    } else {
                      if (fiberInstance !== null) {
                        fiberInstance.firstChild = remainingReconcilingChildren;
                        remainingReconcilingChildren = null;
                        consumeSuspenseNodesOfExistingInstance(fiberInstance);
                        if (traceUpdatesEnabled) {
                          if (traceNearestHostComponentUpdate) {
                            var hostInstances = findAllCurrentHostInstances(fiberInstance);
                            hostInstances.forEach(function(hostInstance) {
                              traceUpdatesForNodes.add(hostInstance);
                            });
                          }
                        }
                      } else {
                        var _childrenUpdateFlags = updateChildrenRecursively(nextFiber.child, prevFiber.child, false);
                        if ((_childrenUpdateFlags & ShouldResetChildren) !== NoUpdate) {
                          throw new Error("The children should not have changed if we pass in the same set.");
                        }
                        updateFlags |= _childrenUpdateFlags;
                      }
                    }
                  }
                  if (fiberInstance !== null) {
                    removePreviousSuspendedBy(fiberInstance, previousSuspendedBy, shouldPopSuspenseNode ? reconcilingParentSuspenseNode : stashedSuspenseParent);
                    if (fiberInstance.kind === FIBER_INSTANCE) {
                      var componentLogsEntry = fiberToComponentLogsMap.get(fiberInstance.data);
                      if (componentLogsEntry === void 0 && fiberInstance.data.alternate) {
                        componentLogsEntry = fiberToComponentLogsMap.get(fiberInstance.data.alternate);
                      }
                      recordConsoleLogs(fiberInstance, componentLogsEntry);
                      var isProfilingSupported = nextFiber.hasOwnProperty("treeBaseDuration");
                      if (isProfilingSupported) {
                        recordProfilingDurations(fiberInstance, prevFiber);
                      }
                    }
                  }
                  if ((updateFlags & ShouldResetChildren) !== NoUpdate) {
                    if (fiberInstance !== null && fiberInstance.kind === FIBER_INSTANCE) {
                      if (!nextIsSuspended && !isInDisconnectedSubtree) {
                        recordResetChildren(fiberInstance);
                      }
                      updateFlags &= ~ShouldResetChildren;
                    } else {
                    }
                  } else {
                  }
                  if ((updateFlags & ShouldResetSuspenseChildren) !== NoUpdate) {
                    if (fiberInstance !== null && fiberInstance.kind === FIBER_INSTANCE) {
                      var _suspenseNode3 = fiberInstance.suspenseNode;
                      if (_suspenseNode3 !== null) {
                        recordResetSuspenseChildren(_suspenseNode3);
                        updateFlags &= ~ShouldResetSuspenseChildren;
                      }
                    } else {
                    }
                  }
                  if ((updateFlags & ShouldResetParentSuspenseChildren) !== NoUpdate) {
                    if (fiberInstance !== null && fiberInstance.kind === FIBER_INSTANCE) {
                      var _suspenseNode4 = fiberInstance.suspenseNode;
                      if (_suspenseNode4 !== null) {
                        updateFlags &= ~ShouldResetParentSuspenseChildren;
                        updateFlags |= ShouldResetSuspenseChildren;
                      }
                    } else {
                    }
                  }
                  return updateFlags;
                } finally {
                  if (fiberInstance !== null) {
                    unmountRemainingChildren();
                    reconcilingParent = stashedParent;
                    previouslyReconciledSibling = stashedPrevious;
                    remainingReconcilingChildren = stashedRemaining;
                    if (shouldMeasureSuspenseNode) {
                      if (!isInDisconnectedSubtree) {
                        var _suspenseNode5 = fiberInstance.suspenseNode;
                        if (_suspenseNode5 === null) {
                          throw new Error("Attempted to measure a Suspense node that does not exist.");
                        }
                        var prevRects = _suspenseNode5.rects;
                        var nextRects = measureInstance(fiberInstance);
                        if (!areEqualRects(prevRects, nextRects)) {
                          _suspenseNode5.rects = nextRects;
                          recordSuspenseResize(_suspenseNode5);
                        }
                      }
                    }
                    if (shouldPopSuspenseNode) {
                      reconcilingParentSuspenseNode = stashedSuspenseParent;
                      previouslyReconciledSiblingSuspenseNode = stashedSuspensePrevious;
                      remainingReconcilingChildrenSuspenseNodes = stashedSuspenseRemaining;
                    }
                  }
                }
              }
              __name(updateFiberRecursively, "updateFiberRecursively");
              function disconnectChildrenRecursively(firstChild) {
                for (var child = firstChild; child !== null; child = child.nextSibling) {
                  if ((child.kind === FIBER_INSTANCE || child.kind === FILTERED_FIBER_INSTANCE) && isSuspendedOffscreen(child.data)) {
                  } else {
                    disconnectChildrenRecursively(child.firstChild);
                  }
                  if (child.kind === FIBER_INSTANCE) {
                    recordDisconnect(child);
                  } else if (child.kind === VIRTUAL_INSTANCE) {
                    recordVirtualDisconnect(child);
                  }
                }
              }
              __name(disconnectChildrenRecursively, "disconnectChildrenRecursively");
              function reconnectChildrenRecursively(parentInstance) {
                for (var child = parentInstance.firstChild; child !== null; child = child.nextSibling) {
                  if (child.kind === FIBER_INSTANCE) {
                    recordReconnect(child, parentInstance);
                  } else if (child.kind === VIRTUAL_INSTANCE) {
                    var secondaryEnv = null;
                    recordVirtualReconnect(child, parentInstance, secondaryEnv);
                  }
                  if ((child.kind === FIBER_INSTANCE || child.kind === FILTERED_FIBER_INSTANCE) && isHiddenOffscreen(child.data)) {
                  } else {
                    reconnectChildrenRecursively(child);
                  }
                }
              }
              __name(reconnectChildrenRecursively, "reconnectChildrenRecursively");
              function cleanup() {
                isProfiling = false;
              }
              __name(cleanup, "cleanup");
              function rootSupportsProfiling(root) {
                if (root.memoizedInteractions != null) {
                  return true;
                } else if (root.current != null && root.current.hasOwnProperty("treeBaseDuration")) {
                  return true;
                } else {
                  return false;
                }
              }
              __name(rootSupportsProfiling, "rootSupportsProfiling");
              function flushInitialOperations() {
                var localPendingOperationsQueue = pendingOperationsQueue;
                pendingOperationsQueue = null;
                if (localPendingOperationsQueue !== null && localPendingOperationsQueue.length > 0) {
                  localPendingOperationsQueue.forEach(function(operations) {
                    hook.emit("operations", operations);
                  });
                } else {
                  if (trackedPath !== null) {
                    mightBeOnTrackedPath = true;
                  }
                  hook.getFiberRoots(rendererID).forEach(function(root) {
                    var current = root.current;
                    var newRoot = createFiberInstance(current);
                    rootToFiberInstanceMap.set(root, newRoot);
                    idToDevToolsInstanceMap.set(newRoot.id, newRoot);
                    currentRoot = newRoot;
                    setRootPseudoKey(currentRoot.id, root.current);
                    if (isProfiling && rootSupportsProfiling(root)) {
                      currentCommitProfilingMetadata = {
                        changeDescriptions: recordChangeDescriptions ? /* @__PURE__ */ new Map() : null,
                        durations: [],
                        commitTime: renderer_getCurrentTime() - profilingStartTime,
                        maxActualDuration: 0,
                        priorityLevel: null,
                        updaters: null,
                        effectDuration: null,
                        passiveEffectDuration: null
                      };
                    }
                    mountFiberRecursively(root.current, false);
                    flushPendingEvents();
                    needsToFlushComponentLogs = false;
                    currentRoot = null;
                  });
                }
              }
              __name(flushInitialOperations, "flushInitialOperations");
              function handleCommitFiberUnmount(fiber) {
              }
              __name(handleCommitFiberUnmount, "handleCommitFiberUnmount");
              function handlePostCommitFiberRoot(root) {
                if (isProfiling && rootSupportsProfiling(root)) {
                  if (currentCommitProfilingMetadata !== null) {
                    var _getEffectDurations = getEffectDurations(root), effectDuration = _getEffectDurations.effectDuration, passiveEffectDuration = _getEffectDurations.passiveEffectDuration;
                    currentCommitProfilingMetadata.effectDuration = effectDuration;
                    currentCommitProfilingMetadata.passiveEffectDuration = passiveEffectDuration;
                  }
                }
                if (needsToFlushComponentLogs) {
                  bruteForceFlushErrorsAndWarnings();
                }
              }
              __name(handlePostCommitFiberRoot, "handlePostCommitFiberRoot");
              function handleCommitFiberRoot(root, priorityLevel) {
                var nextFiber = root.current;
                var prevFiber = null;
                var rootInstance = rootToFiberInstanceMap.get(root);
                if (!rootInstance) {
                  rootInstance = createFiberInstance(nextFiber);
                  rootToFiberInstanceMap.set(root, rootInstance);
                  idToDevToolsInstanceMap.set(rootInstance.id, rootInstance);
                } else {
                  prevFiber = rootInstance.data;
                }
                currentRoot = rootInstance;
                if (trackedPath !== null) {
                  mightBeOnTrackedPath = true;
                }
                if (traceUpdatesEnabled) {
                  traceUpdatesForNodes.clear();
                }
                var isProfilingSupported = rootSupportsProfiling(root);
                if (isProfiling && isProfilingSupported) {
                  currentCommitProfilingMetadata = {
                    changeDescriptions: recordChangeDescriptions ? /* @__PURE__ */ new Map() : null,
                    durations: [],
                    commitTime: renderer_getCurrentTime() - profilingStartTime,
                    maxActualDuration: 0,
                    priorityLevel: priorityLevel == null ? null : formatPriorityLevel(priorityLevel),
                    updaters: null,
                    effectDuration: null,
                    passiveEffectDuration: null
                  };
                }
                var nextIsMounted = nextFiber.child !== null;
                var prevWasMounted = prevFiber !== null && prevFiber.child !== null;
                if (!prevWasMounted && nextIsMounted) {
                  setRootPseudoKey(currentRoot.id, nextFiber);
                  mountFiberRecursively(nextFiber, false);
                } else if (prevWasMounted && nextIsMounted) {
                  if (prevFiber === null) {
                    throw new Error("Expected a previous Fiber when updating an existing root.");
                  }
                  updateFiberRecursively(rootInstance, nextFiber, prevFiber, false);
                } else if (prevWasMounted && !nextIsMounted) {
                  unmountInstanceRecursively(rootInstance);
                  removeRootPseudoKey(currentRoot.id);
                  rootToFiberInstanceMap.delete(root);
                } else if (!prevWasMounted && !nextIsMounted) {
                  rootToFiberInstanceMap.delete(root);
                }
                if (isProfiling && isProfilingSupported) {
                  if (!shouldBailoutWithPendingOperations()) {
                    var commitProfilingMetadata = rootToCommitProfilingMetadataMap.get(currentRoot.id);
                    if (commitProfilingMetadata != null) {
                      commitProfilingMetadata.push(currentCommitProfilingMetadata);
                    } else {
                      rootToCommitProfilingMetadataMap.set(currentRoot.id, [currentCommitProfilingMetadata]);
                    }
                  }
                }
                flushPendingEvents();
                needsToFlushComponentLogs = false;
                if (traceUpdatesEnabled) {
                  hook.emit("traceUpdates", traceUpdatesForNodes);
                }
                currentRoot = null;
              }
              __name(handleCommitFiberRoot, "handleCommitFiberRoot");
              function getResourceInstance(fiber) {
                if (fiber.tag === HostHoistable) {
                  var resource = fiber.memoizedState;
                  if (renderer_typeof(resource) === "object" && resource !== null && resource.instance != null) {
                    return resource.instance;
                  }
                }
                return null;
              }
              __name(getResourceInstance, "getResourceInstance");
              function appendHostInstancesByDevToolsInstance(devtoolsInstance, hostInstances) {
                if (devtoolsInstance.kind !== VIRTUAL_INSTANCE) {
                  var _fiber6 = devtoolsInstance.data;
                  appendHostInstancesByFiber(_fiber6, hostInstances);
                  return;
                }
                for (var child = devtoolsInstance.firstChild; child !== null; child = child.nextSibling) {
                  appendHostInstancesByDevToolsInstance(child, hostInstances);
                }
              }
              __name(appendHostInstancesByDevToolsInstance, "appendHostInstancesByDevToolsInstance");
              function appendHostInstancesByFiber(fiber, hostInstances) {
                var node = fiber;
                while (true) {
                  if (node.tag === HostComponent || node.tag === HostText || node.tag === HostSingleton || node.tag === HostHoistable) {
                    var hostInstance = node.stateNode || getResourceInstance(node);
                    if (hostInstance) {
                      hostInstances.push(hostInstance);
                    }
                  } else if (node.child) {
                    node.child.return = node;
                    node = node.child;
                    continue;
                  }
                  if (node === fiber) {
                    return;
                  }
                  while (!node.sibling) {
                    if (!node.return || node.return === fiber) {
                      return;
                    }
                    node = node.return;
                  }
                  node.sibling.return = node.return;
                  node = node.sibling;
                }
              }
              __name(appendHostInstancesByFiber, "appendHostInstancesByFiber");
              function findAllCurrentHostInstances(devtoolsInstance) {
                var hostInstances = [];
                appendHostInstancesByDevToolsInstance(devtoolsInstance, hostInstances);
                return hostInstances;
              }
              __name(findAllCurrentHostInstances, "findAllCurrentHostInstances");
              function findHostInstancesForElementID(id) {
                try {
                  var devtoolsInstance = idToDevToolsInstanceMap.get(id);
                  if (devtoolsInstance === void 0) {
                    console.warn('Could not find DevToolsInstance with id "'.concat(id, '"'));
                    return null;
                  }
                  return findAllCurrentHostInstances(devtoolsInstance);
                } catch (err) {
                  return null;
                }
              }
              __name(findHostInstancesForElementID, "findHostInstancesForElementID");
              function findLastKnownRectsForID(id) {
                try {
                  var devtoolsInstance = idToDevToolsInstanceMap.get(id);
                  if (devtoolsInstance === void 0) {
                    console.warn('Could not find DevToolsInstance with id "'.concat(id, '"'));
                    return null;
                  }
                  if (devtoolsInstance.suspenseNode === null) {
                    return null;
                  }
                  return devtoolsInstance.suspenseNode.rects;
                } catch (err) {
                  return null;
                }
              }
              __name(findLastKnownRectsForID, "findLastKnownRectsForID");
              function getDisplayNameForElementID(id) {
                var devtoolsInstance = idToDevToolsInstanceMap.get(id);
                if (devtoolsInstance === void 0) {
                  return null;
                }
                if (devtoolsInstance.kind === FIBER_INSTANCE) {
                  var _fiber7 = devtoolsInstance.data;
                  if (_fiber7.tag === HostRoot) {
                    return "Initial Paint";
                  }
                  if (_fiber7.tag === SuspenseComponent || _fiber7.tag === ActivityComponent) {
                    var props = _fiber7.memoizedProps;
                    if (props.name != null) {
                      return props.name;
                    }
                    var owner = getUnfilteredOwner(_fiber7);
                    if (owner != null) {
                      if (typeof owner.tag === "number") {
                        return getDisplayNameForFiber(owner);
                      } else {
                        return owner.name || "";
                      }
                    }
                  }
                  return getDisplayNameForFiber(_fiber7);
                } else {
                  return devtoolsInstance.data.name || "";
                }
              }
              __name(getDisplayNameForElementID, "getDisplayNameForElementID");
              function getNearestSuspenseNode(instance) {
                while (instance.suspenseNode === null) {
                  if (instance.parent === null) {
                    throw new Error("There should always be a SuspenseNode parent on a mounted instance.");
                  }
                  instance = instance.parent;
                }
                return instance.suspenseNode;
              }
              __name(getNearestSuspenseNode, "getNearestSuspenseNode");
              function getNearestMountedDOMNode(publicInstance) {
                var domNode = publicInstance;
                while (domNode && !publicInstanceToDevToolsInstanceMap.has(domNode)) {
                  domNode = domNode.parentNode;
                }
                return domNode;
              }
              __name(getNearestMountedDOMNode, "getNearestMountedDOMNode");
              function getElementIDForHostInstance(publicInstance) {
                var instance = publicInstanceToDevToolsInstanceMap.get(publicInstance);
                if (instance !== void 0) {
                  if (instance.kind === FILTERED_FIBER_INSTANCE) {
                    return instance.parent.id;
                  }
                  return instance.id;
                }
                return null;
              }
              __name(getElementIDForHostInstance, "getElementIDForHostInstance");
              function getSuspenseNodeIDForHostInstance(publicInstance) {
                var instance = publicInstanceToDevToolsInstanceMap.get(publicInstance);
                if (instance !== void 0) {
                  var suspenseInstance = instance;
                  while (suspenseInstance.suspenseNode === null || suspenseInstance.kind === FILTERED_FIBER_INSTANCE) {
                    if (suspenseInstance.parent === null) {
                      return null;
                    }
                    suspenseInstance = suspenseInstance.parent;
                  }
                  return suspenseInstance.id;
                }
                return null;
              }
              __name(getSuspenseNodeIDForHostInstance, "getSuspenseNodeIDForHostInstance");
              function getElementAttributeByPath(id, path) {
                if (isMostRecentlyInspectedElement(id)) {
                  return utils_getInObject(mostRecentlyInspectedElement, path);
                }
                return void 0;
              }
              __name(getElementAttributeByPath, "getElementAttributeByPath");
              function getElementSourceFunctionById(id) {
                var devtoolsInstance = idToDevToolsInstanceMap.get(id);
                if (devtoolsInstance === void 0) {
                  console.warn('Could not find DevToolsInstance with id "'.concat(id, '"'));
                  return null;
                }
                if (devtoolsInstance.kind !== FIBER_INSTANCE) {
                  return null;
                }
                var fiber = devtoolsInstance.data;
                var elementType = fiber.elementType, tag = fiber.tag, type = fiber.type;
                switch (tag) {
                  case ClassComponent:
                  case IncompleteClassComponent:
                  case IncompleteFunctionComponent:
                  case IndeterminateComponent:
                  case FunctionComponent:
                    return type;
                  case ForwardRef:
                    return type.render;
                  case MemoComponent:
                  case SimpleMemoComponent:
                    return elementType != null && elementType.type != null ? elementType.type : type;
                  default:
                    return null;
                }
              }
              __name(getElementSourceFunctionById, "getElementSourceFunctionById");
              function instanceToSerializedElement(instance) {
                if (instance.kind === FIBER_INSTANCE) {
                  var _fiber8 = instance.data;
                  return {
                    displayName: getDisplayNameForFiber(_fiber8) || "Anonymous",
                    id: instance.id,
                    key: _fiber8.key,
                    env: null,
                    stack: _fiber8._debugOwner == null || _fiber8._debugStack == null ? null : parseStackTrace(_fiber8._debugStack, 1),
                    type: getElementTypeForFiber(_fiber8)
                  };
                } else {
                  var componentInfo = instance.data;
                  return {
                    displayName: componentInfo.name || "Anonymous",
                    id: instance.id,
                    key: componentInfo.key == null ? null : componentInfo.key,
                    env: componentInfo.env == null ? null : componentInfo.env,
                    stack: componentInfo.owner == null || componentInfo.debugStack == null ? null : parseStackTrace(componentInfo.debugStack, 1),
                    type: types_ElementTypeVirtual
                  };
                }
              }
              __name(instanceToSerializedElement, "instanceToSerializedElement");
              function getOwnersList(id) {
                var devtoolsInstance = idToDevToolsInstanceMap.get(id);
                if (devtoolsInstance === void 0) {
                  console.warn('Could not find DevToolsInstance with id "'.concat(id, '"'));
                  return null;
                }
                var self2 = instanceToSerializedElement(devtoolsInstance);
                var owners = getOwnersListFromInstance(devtoolsInstance);
                if (owners === null) {
                  return [self2];
                }
                owners.unshift(self2);
                owners.reverse();
                return owners;
              }
              __name(getOwnersList, "getOwnersList");
              function getOwnersListFromInstance(instance) {
                var owner = getUnfilteredOwner(instance.data);
                if (owner === null) {
                  return null;
                }
                var owners = [];
                var parentInstance = instance.parent;
                while (parentInstance !== null && owner !== null) {
                  var ownerInstance = findNearestOwnerInstance(parentInstance, owner);
                  if (ownerInstance !== null) {
                    owners.push(instanceToSerializedElement(ownerInstance));
                    owner = getUnfilteredOwner(owner);
                    parentInstance = ownerInstance.parent;
                  } else {
                    break;
                  }
                }
                return owners;
              }
              __name(getOwnersListFromInstance, "getOwnersListFromInstance");
              function getUnfilteredOwner(owner) {
                if (owner == null) {
                  return null;
                }
                if (typeof owner.tag === "number") {
                  var ownerFiber = owner;
                  owner = ownerFiber._debugOwner;
                } else {
                  var ownerInfo = owner;
                  owner = ownerInfo.owner;
                }
                while (owner) {
                  if (typeof owner.tag === "number") {
                    var _ownerFiber = owner;
                    if (!shouldFilterFiber(_ownerFiber)) {
                      return _ownerFiber;
                    }
                    owner = _ownerFiber._debugOwner;
                  } else {
                    var _ownerInfo = owner;
                    if (!shouldFilterVirtual(_ownerInfo, null)) {
                      return _ownerInfo;
                    }
                    owner = _ownerInfo.owner;
                  }
                }
                return null;
              }
              __name(getUnfilteredOwner, "getUnfilteredOwner");
              function findNearestOwnerInstance(parentInstance, owner) {
                if (owner == null) {
                  return null;
                }
                while (parentInstance !== null) {
                  if (parentInstance.data === owner || parentInstance.data === owner.alternate) {
                    if (parentInstance.kind === FILTERED_FIBER_INSTANCE) {
                      return null;
                    }
                    return parentInstance;
                  }
                  parentInstance = parentInstance.parent;
                }
                return null;
              }
              __name(findNearestOwnerInstance, "findNearestOwnerInstance");
              function inspectHooks(fiber) {
                var originalConsoleMethods = {};
                for (var method in console) {
                  try {
                    originalConsoleMethods[method] = console[method];
                    console[method] = function() {
                    };
                  } catch (error) {
                  }
                }
                try {
                  return (0, react_debug_tools.inspectHooksOfFiber)(fiber, getDispatcherRef(renderer));
                } finally {
                  for (var _method in originalConsoleMethods) {
                    try {
                      console[_method] = originalConsoleMethods[_method];
                    } catch (error) {
                    }
                  }
                }
              }
              __name(inspectHooks, "inspectHooks");
              function getSuspendedByOfSuspenseNode(suspenseNode, filterByChildInstance) {
                var result = [];
                if (!suspenseNode.hasUniqueSuspenders) {
                  return result;
                }
                var hooksCacheKey = null;
                var hooksCache = null;
                var streamEntries = /* @__PURE__ */ new Map();
                suspenseNode.suspendedBy.forEach(function(set, ioInfo) {
                  var parentNode = suspenseNode.parent;
                  while (parentNode !== null) {
                    if (parentNode.suspendedBy.has(ioInfo)) {
                      return;
                    }
                    parentNode = parentNode.parent;
                  }
                  if (set.size === 0) {
                    return;
                  }
                  var firstInstance = null;
                  if (filterByChildInstance === null) {
                    firstInstance = set.values().next().value;
                  } else {
                    var _iterator7 = _createForOfIteratorHelper(set.values()), _step7;
                    try {
                      for (_iterator7.s(); !(_step7 = _iterator7.n()).done; ) {
                        var childInstance = _step7.value;
                        if (firstInstance === null) {
                          firstInstance = childInstance;
                        }
                        if (childInstance !== filterByChildInstance && !isChildOf(filterByChildInstance, childInstance, suspenseNode.instance)) {
                          return;
                        }
                      }
                    } catch (err) {
                      _iterator7.e(err);
                    } finally {
                      _iterator7.f();
                    }
                  }
                  if (firstInstance !== null && firstInstance.suspendedBy !== null) {
                    var asyncInfo = getAwaitInSuspendedByFromIO(firstInstance.suspendedBy, ioInfo);
                    if (asyncInfo !== null) {
                      var hooks = null;
                      if (asyncInfo.stack == null && asyncInfo.owner == null) {
                        if (hooksCacheKey === firstInstance) {
                          hooks = hooksCache;
                        } else if (firstInstance.kind !== VIRTUAL_INSTANCE) {
                          var _fiber9 = firstInstance.data;
                          if (_fiber9.dependencies && _fiber9.dependencies._debugThenableState) {
                            hooksCacheKey = firstInstance;
                            hooksCache = hooks = inspectHooks(_fiber9);
                          }
                        }
                      }
                      var newIO = asyncInfo.awaited;
                      if ((newIO.name === "RSC stream" || newIO.name === "rsc stream") && newIO.value != null) {
                        var streamPromise = newIO.value;
                        var existingEntry = streamEntries.get(streamPromise);
                        if (existingEntry === void 0) {
                          streamEntries.set(streamPromise, {
                            asyncInfo,
                            instance: firstInstance,
                            hooks
                          });
                        } else {
                          var existingIO = existingEntry.asyncInfo.awaited;
                          if (newIO !== existingIO && (newIO.byteSize !== void 0 && existingIO.byteSize !== void 0 && newIO.byteSize > existingIO.byteSize || newIO.end > existingIO.end)) {
                            existingEntry.asyncInfo = asyncInfo;
                            existingEntry.instance = firstInstance;
                            existingEntry.hooks = hooks;
                          }
                        }
                      } else {
                        result.push(serializeAsyncInfo(asyncInfo, firstInstance, hooks));
                      }
                    }
                  }
                });
                streamEntries.forEach(function(_ref) {
                  var asyncInfo = _ref.asyncInfo, instance = _ref.instance, hooks = _ref.hooks;
                  result.push(serializeAsyncInfo(asyncInfo, instance, hooks));
                });
                return result;
              }
              __name(getSuspendedByOfSuspenseNode, "getSuspendedByOfSuspenseNode");
              function getSuspendedByOfInstance(devtoolsInstance, hooks) {
                var suspendedBy = devtoolsInstance.suspendedBy;
                if (suspendedBy === null) {
                  return [];
                }
                var foundIOEntries = /* @__PURE__ */ new Set();
                var streamEntries = /* @__PURE__ */ new Map();
                var result = [];
                for (var i = 0; i < suspendedBy.length; i++) {
                  var asyncInfo = suspendedBy[i];
                  var ioInfo = asyncInfo.awaited;
                  if (foundIOEntries.has(ioInfo)) {
                    continue;
                  }
                  foundIOEntries.add(ioInfo);
                  if ((ioInfo.name === "RSC stream" || ioInfo.name === "rsc stream") && ioInfo.value != null) {
                    var streamPromise = ioInfo.value;
                    var existingEntry = streamEntries.get(streamPromise);
                    if (existingEntry === void 0) {
                      streamEntries.set(streamPromise, asyncInfo);
                    } else {
                      var existingIO = existingEntry.awaited;
                      if (ioInfo !== existingIO && (ioInfo.byteSize !== void 0 && existingIO.byteSize !== void 0 && ioInfo.byteSize > existingIO.byteSize || ioInfo.end > existingIO.end)) {
                        streamEntries.set(streamPromise, asyncInfo);
                      }
                    }
                  } else {
                    result.push(serializeAsyncInfo(asyncInfo, devtoolsInstance, hooks));
                  }
                }
                streamEntries.forEach(function(asyncInfo2) {
                  result.push(serializeAsyncInfo(asyncInfo2, devtoolsInstance, hooks));
                });
                return result;
              }
              __name(getSuspendedByOfInstance, "getSuspendedByOfInstance");
              function getSuspendedByOfInstanceSubtree(devtoolsInstance) {
                var suspenseParentInstance = devtoolsInstance;
                while (suspenseParentInstance.suspenseNode === null) {
                  if (suspenseParentInstance.parent === null) {
                    return [];
                  }
                  suspenseParentInstance = suspenseParentInstance.parent;
                }
                var suspenseNode = suspenseParentInstance.suspenseNode;
                return getSuspendedByOfSuspenseNode(suspenseNode, devtoolsInstance);
              }
              __name(getSuspendedByOfInstanceSubtree, "getSuspendedByOfInstanceSubtree");
              var FALLBACK_THROTTLE_MS = 300;
              function getSuspendedByRange(suspenseNode) {
                var min = Infinity;
                var max = -Infinity;
                suspenseNode.suspendedBy.forEach(function(_, ioInfo) {
                  if (ioInfo.end > max) {
                    max = ioInfo.end;
                  }
                  if (ioInfo.start < min) {
                    min = ioInfo.start;
                  }
                });
                var parentSuspenseNode = suspenseNode.parent;
                if (parentSuspenseNode !== null) {
                  var parentMax = -Infinity;
                  parentSuspenseNode.suspendedBy.forEach(function(_, ioInfo) {
                    if (ioInfo.end > parentMax) {
                      parentMax = ioInfo.end;
                    }
                  });
                  var throttleTime = parentMax + FALLBACK_THROTTLE_MS;
                  if (throttleTime > max) {
                    max = throttleTime;
                  }
                  var startTime = max - FALLBACK_THROTTLE_MS;
                  if (parentMax > startTime) {
                    startTime = parentMax;
                  }
                  if (startTime < min) {
                    min = startTime;
                  }
                }
                if (min < Infinity && max > -Infinity) {
                  return [min, max];
                }
                return null;
              }
              __name(getSuspendedByRange, "getSuspendedByRange");
              function getAwaitStackFromHooks(hooks, asyncInfo) {
                for (var i = 0; i < hooks.length; i++) {
                  var node = hooks[i];
                  var debugInfo = node.debugInfo;
                  if (debugInfo != null && debugInfo.indexOf(asyncInfo) !== -1) {
                    var source = node.hookSource;
                    if (source != null && source.functionName !== null && source.fileName !== null && source.lineNumber !== null && source.columnNumber !== null) {
                      var callSite = [source.functionName, source.fileName, source.lineNumber, source.columnNumber, 0, 0, false];
                      return [callSite];
                    } else {
                      return [];
                    }
                  }
                  var matchedStack = getAwaitStackFromHooks(node.subHooks, asyncInfo);
                  if (matchedStack !== null) {
                    var _source = node.hookSource;
                    if (_source != null && _source.functionName !== null && _source.fileName !== null && _source.lineNumber !== null && _source.columnNumber !== null) {
                      var _callSite = [_source.functionName, _source.fileName, _source.lineNumber, _source.columnNumber, 0, 0, false];
                      matchedStack.push(_callSite);
                    }
                    return matchedStack;
                  }
                }
                return null;
              }
              __name(getAwaitStackFromHooks, "getAwaitStackFromHooks");
              function serializeAsyncInfo(asyncInfo, parentInstance, hooks) {
                var ioInfo = asyncInfo.awaited;
                var ioOwnerInstance = findNearestOwnerInstance(parentInstance, ioInfo.owner);
                var awaitStack = asyncInfo.debugStack == null ? null : parseStackTrace(asyncInfo.debugStack, 1);
                var awaitOwnerInstance;
                if (asyncInfo.owner == null && (awaitStack === null || awaitStack.length === 0)) {
                  awaitStack = null;
                  awaitOwnerInstance = parentInstance.kind === FILTERED_FIBER_INSTANCE ? null : parentInstance;
                  if (parentInstance.kind === FIBER_INSTANCE || parentInstance.kind === FILTERED_FIBER_INSTANCE) {
                    var _fiber10 = parentInstance.data;
                    switch (_fiber10.tag) {
                      case ClassComponent:
                      case FunctionComponent:
                      case IncompleteClassComponent:
                      case IncompleteFunctionComponent:
                      case IndeterminateComponent:
                      case MemoComponent:
                      case SimpleMemoComponent:
                        if (hooks !== null) {
                          awaitStack = getAwaitStackFromHooks(hooks, asyncInfo);
                        }
                        break;
                      default:
                        if (_fiber10._debugOwner != null && _fiber10._debugStack != null && typeof _fiber10._debugStack !== "string") {
                          awaitStack = parseStackTrace(_fiber10._debugStack, 1);
                          awaitOwnerInstance = findNearestOwnerInstance(parentInstance, _fiber10._debugOwner);
                        }
                    }
                  }
                } else {
                  awaitOwnerInstance = findNearestOwnerInstance(parentInstance, asyncInfo.owner);
                }
                var value = ioInfo.value;
                var resolvedValue = void 0;
                if (renderer_typeof(value) === "object" && value !== null && typeof value.then === "function") {
                  switch (value.status) {
                    case "fulfilled":
                      resolvedValue = value.value;
                      break;
                    case "rejected":
                      resolvedValue = value.reason;
                      break;
                  }
                }
                return {
                  awaited: {
                    name: ioInfo.name,
                    description: getIODescription(resolvedValue),
                    start: ioInfo.start,
                    end: ioInfo.end,
                    byteSize: ioInfo.byteSize == null ? null : ioInfo.byteSize,
                    value: ioInfo.value == null ? null : ioInfo.value,
                    env: ioInfo.env == null ? null : ioInfo.env,
                    owner: ioOwnerInstance === null ? null : instanceToSerializedElement(ioOwnerInstance),
                    stack: ioInfo.debugStack == null ? null : parseStackTrace(ioInfo.debugStack, 1)
                  },
                  env: asyncInfo.env == null ? null : asyncInfo.env,
                  owner: awaitOwnerInstance === null ? null : instanceToSerializedElement(awaitOwnerInstance),
                  stack: awaitStack
                };
              }
              __name(serializeAsyncInfo, "serializeAsyncInfo");
              function getInstanceAndStyle(id) {
                var instance = null;
                var style = null;
                var devtoolsInstance = idToDevToolsInstanceMap.get(id);
                if (devtoolsInstance === void 0) {
                  console.warn('Could not find DevToolsInstance with id "'.concat(id, '"'));
                  return {
                    instance,
                    style
                  };
                }
                if (devtoolsInstance.kind !== FIBER_INSTANCE) {
                  return {
                    instance,
                    style
                  };
                }
                var fiber = devtoolsInstance.data;
                if (fiber !== null) {
                  instance = fiber.stateNode;
                  if (fiber.memoizedProps !== null) {
                    style = fiber.memoizedProps.style;
                  }
                }
                return {
                  instance,
                  style
                };
              }
              __name(getInstanceAndStyle, "getInstanceAndStyle");
              function isErrorBoundary(fiber) {
                var tag = fiber.tag, type = fiber.type;
                switch (tag) {
                  case ClassComponent:
                  case IncompleteClassComponent:
                    var instance = fiber.stateNode;
                    return typeof type.getDerivedStateFromError === "function" || instance !== null && typeof instance.componentDidCatch === "function";
                  default:
                    return false;
                }
              }
              __name(isErrorBoundary, "isErrorBoundary");
              function inspectElementRaw(id) {
                var devtoolsInstance = idToDevToolsInstanceMap.get(id);
                if (devtoolsInstance === void 0) {
                  console.warn('Could not find DevToolsInstance with id "'.concat(id, '"'));
                  return null;
                }
                if (devtoolsInstance.kind === VIRTUAL_INSTANCE) {
                  return inspectVirtualInstanceRaw(devtoolsInstance);
                }
                if (devtoolsInstance.kind === FIBER_INSTANCE) {
                  var isRoot = devtoolsInstance.parent === null;
                  return isRoot ? inspectRootsRaw(devtoolsInstance.id) : inspectFiberInstanceRaw(devtoolsInstance);
                }
                devtoolsInstance;
                throw new Error("Unsupported instance kind");
              }
              __name(inspectElementRaw, "inspectElementRaw");
              function inspectFiberInstanceRaw(fiberInstance) {
                var fiber = fiberInstance.data;
                if (fiber == null) {
                  return null;
                }
                var stateNode = fiber.stateNode, key = fiber.key, memoizedProps = fiber.memoizedProps, memoizedState = fiber.memoizedState, dependencies = fiber.dependencies, tag = fiber.tag, type = fiber.type;
                var elementType = getElementTypeForFiber(fiber);
                var usesHooks = (tag === FunctionComponent || tag === SimpleMemoComponent || tag === ForwardRef) && (!!memoizedState || !!dependencies);
                var showState = tag === ClassComponent || tag === IncompleteClassComponent;
                var typeSymbol = getTypeSymbol(type);
                var canViewSource = false;
                var context = null;
                if (tag === ClassComponent || tag === FunctionComponent || tag === IncompleteClassComponent || tag === IncompleteFunctionComponent || tag === IndeterminateComponent || tag === MemoComponent || tag === ForwardRef || tag === SimpleMemoComponent) {
                  canViewSource = true;
                  if (stateNode && stateNode.context != null) {
                    var shouldHideContext = elementType === types_ElementTypeClass && !(type.contextTypes || type.contextType);
                    if (!shouldHideContext) {
                      context = stateNode.context;
                    }
                  }
                } else if ((typeSymbol === CONTEXT_NUMBER || typeSymbol === CONTEXT_SYMBOL_STRING) && !(type._context === void 0 && type.Provider === type)) {
                  var consumerResolvedContext = type._context || type;
                  context = consumerResolvedContext._currentValue || null;
                  var _current = fiber.return;
                  while (_current !== null) {
                    var currentType = _current.type;
                    var currentTypeSymbol = getTypeSymbol(currentType);
                    if (currentTypeSymbol === PROVIDER_NUMBER || currentTypeSymbol === PROVIDER_SYMBOL_STRING) {
                      var providerResolvedContext = currentType._context || currentType.context;
                      if (providerResolvedContext === consumerResolvedContext) {
                        context = _current.memoizedProps.value;
                        break;
                      }
                    }
                    _current = _current.return;
                  }
                } else if (typeSymbol === CONSUMER_SYMBOL_STRING) {
                  var _consumerResolvedContext = type._context;
                  context = _consumerResolvedContext._currentValue || null;
                  var _current2 = fiber.return;
                  while (_current2 !== null) {
                    var _currentType = _current2.type;
                    var _currentTypeSymbol = getTypeSymbol(_currentType);
                    if (_currentTypeSymbol === CONTEXT_SYMBOL_STRING) {
                      var _providerResolvedContext = _currentType;
                      if (_providerResolvedContext === _consumerResolvedContext) {
                        context = _current2.memoizedProps.value;
                        break;
                      }
                    }
                    _current2 = _current2.return;
                  }
                }
                var hasLegacyContext = false;
                if (context !== null) {
                  hasLegacyContext = !!type.contextTypes;
                  context = {
                    value: context
                  };
                }
                var owners = getOwnersListFromInstance(fiberInstance);
                var hooks = null;
                if (usesHooks) {
                  hooks = inspectHooks(fiber);
                }
                var rootType = null;
                var current = fiber;
                var hasErrorBoundary = false;
                var hasSuspenseBoundary = false;
                while (current.return !== null) {
                  var temp = current;
                  current = current.return;
                  if (temp.tag === SuspenseComponent) {
                    hasSuspenseBoundary = true;
                  } else if (isErrorBoundary(temp)) {
                    hasErrorBoundary = true;
                  }
                }
                var fiberRoot = current.stateNode;
                if (fiberRoot != null && fiberRoot._debugRootType !== null) {
                  rootType = fiberRoot._debugRootType;
                }
                var isErrored = false;
                if (isErrorBoundary(fiber)) {
                  var DidCapture = 128;
                  isErrored = (fiber.flags & DidCapture) !== 0 || forceErrorForFibers.get(fiber) === true || fiber.alternate !== null && forceErrorForFibers.get(fiber.alternate) === true;
                }
                var plugins = {
                  stylex: null
                };
                if (enableStyleXFeatures) {
                  if (memoizedProps != null && memoizedProps.hasOwnProperty("xstyle")) {
                    plugins.stylex = getStyleXData(memoizedProps.xstyle);
                  }
                }
                var source = null;
                if (canViewSource) {
                  source = getSourceForFiberInstance(fiberInstance);
                }
                var componentLogsEntry = fiberToComponentLogsMap.get(fiber);
                if (componentLogsEntry === void 0 && fiber.alternate !== null) {
                  componentLogsEntry = fiberToComponentLogsMap.get(fiber.alternate);
                }
                var nativeTag = null;
                if (elementType === ElementTypeHostComponent) {
                  nativeTag = getNativeTag(fiber.stateNode);
                }
                var isSuspended = null;
                if (tag === SuspenseComponent) {
                  isSuspended = memoizedState !== null;
                }
                var suspendedBy = fiberInstance.suspenseNode !== null ? getSuspendedByOfSuspenseNode(fiberInstance.suspenseNode, null) : tag === ActivityComponent ? getSuspendedByOfInstanceSubtree(fiberInstance) : getSuspendedByOfInstance(fiberInstance, hooks);
                var suspendedByRange = getSuspendedByRange(getNearestSuspenseNode(fiberInstance));
                var unknownSuspenders = UNKNOWN_SUSPENDERS_NONE;
                if (fiberInstance.suspenseNode !== null && fiberInstance.suspenseNode.hasUnknownSuspenders && !isSuspended) {
                  if (renderer.bundleType === 0) {
                    unknownSuspenders = UNKNOWN_SUSPENDERS_REASON_PRODUCTION;
                  } else if (!("_debugInfo" in fiber)) {
                    unknownSuspenders = UNKNOWN_SUSPENDERS_REASON_OLD_VERSION;
                  } else {
                    unknownSuspenders = UNKNOWN_SUSPENDERS_REASON_THROWN_PROMISE;
                  }
                }
                return {
                  id: fiberInstance.id,
                  canEditHooks: typeof overrideHookState === "function",
                  canEditFunctionProps: typeof overrideProps === "function",
                  canEditHooksAndDeletePaths: typeof overrideHookStateDeletePath === "function",
                  canEditHooksAndRenamePaths: typeof overrideHookStateRenamePath === "function",
                  canEditFunctionPropsDeletePaths: typeof overridePropsDeletePath === "function",
                  canEditFunctionPropsRenamePaths: typeof overridePropsRenamePath === "function",
                  canToggleError: supportsTogglingError && hasErrorBoundary,
                  isErrored,
                  canToggleSuspense: supportsTogglingSuspense && hasSuspenseBoundary && (!isSuspended || forceFallbackForFibers.has(fiber) || fiber.alternate !== null && forceFallbackForFibers.has(fiber.alternate)),
                  isSuspended,
                  source,
                  stack: fiber._debugOwner == null || fiber._debugStack == null ? null : parseStackTrace(fiber._debugStack, 1),
                  hasLegacyContext,
                  key: key != null ? key : null,
                  type: elementType,
                  context,
                  hooks,
                  props: memoizedProps,
                  state: showState ? memoizedState : null,
                  errors: componentLogsEntry === void 0 ? [] : Array.from(componentLogsEntry.errors.entries()),
                  warnings: componentLogsEntry === void 0 ? [] : Array.from(componentLogsEntry.warnings.entries()),
                  suspendedBy,
                  suspendedByRange,
                  unknownSuspenders,
                  owners,
                  env: null,
                  rootType,
                  rendererPackageName: renderer.rendererPackageName,
                  rendererVersion: renderer.version,
                  plugins,
                  nativeTag
                };
              }
              __name(inspectFiberInstanceRaw, "inspectFiberInstanceRaw");
              function inspectVirtualInstanceRaw(virtualInstance) {
                var source = getSourceForInstance(virtualInstance);
                var componentInfo = virtualInstance.data;
                var key = typeof componentInfo.key === "string" ? componentInfo.key : null;
                var props = componentInfo.props == null ? null : componentInfo.props;
                var owners = getOwnersListFromInstance(virtualInstance);
                var rootType = null;
                var hasErrorBoundary = false;
                var hasSuspenseBoundary = false;
                var nearestFiber = getNearestFiber(virtualInstance);
                if (nearestFiber !== null) {
                  var current = nearestFiber;
                  while (current.return !== null) {
                    var temp = current;
                    current = current.return;
                    if (temp.tag === SuspenseComponent) {
                      hasSuspenseBoundary = true;
                    } else if (isErrorBoundary(temp)) {
                      hasErrorBoundary = true;
                    }
                  }
                  var fiberRoot = current.stateNode;
                  if (fiberRoot != null && fiberRoot._debugRootType !== null) {
                    rootType = fiberRoot._debugRootType;
                  }
                }
                var plugins = {
                  stylex: null
                };
                var componentLogsEntry = componentInfoToComponentLogsMap.get(componentInfo);
                var isSuspended = null;
                var suspendedBy = getSuspendedByOfInstance(virtualInstance, null);
                var suspendedByRange = getSuspendedByRange(getNearestSuspenseNode(virtualInstance));
                return {
                  id: virtualInstance.id,
                  canEditHooks: false,
                  canEditFunctionProps: false,
                  canEditHooksAndDeletePaths: false,
                  canEditHooksAndRenamePaths: false,
                  canEditFunctionPropsDeletePaths: false,
                  canEditFunctionPropsRenamePaths: false,
                  canToggleError: supportsTogglingError && hasErrorBoundary,
                  isErrored: false,
                  canToggleSuspense: supportsTogglingSuspense && hasSuspenseBoundary,
                  isSuspended,
                  source,
                  stack: componentInfo.owner == null || componentInfo.debugStack == null ? null : parseStackTrace(componentInfo.debugStack, 1),
                  hasLegacyContext: false,
                  key,
                  type: types_ElementTypeVirtual,
                  context: null,
                  hooks: null,
                  props,
                  state: null,
                  errors: componentLogsEntry === void 0 ? [] : Array.from(componentLogsEntry.errors.entries()),
                  warnings: componentLogsEntry === void 0 ? [] : Array.from(componentLogsEntry.warnings.entries()),
                  suspendedBy,
                  suspendedByRange,
                  unknownSuspenders: UNKNOWN_SUSPENDERS_NONE,
                  owners,
                  env: componentInfo.env == null ? null : componentInfo.env,
                  rootType,
                  rendererPackageName: renderer.rendererPackageName,
                  rendererVersion: renderer.version,
                  plugins,
                  nativeTag: null
                };
              }
              __name(inspectVirtualInstanceRaw, "inspectVirtualInstanceRaw");
              var mostRecentlyInspectedElement = null;
              var hasElementUpdatedSinceLastInspected = false;
              var currentlyInspectedPaths = {};
              function isMostRecentlyInspectedElement(id) {
                if (mostRecentlyInspectedElement === null) {
                  return false;
                }
                if (mostRecentlyInspectedElement.id === id) {
                  return true;
                }
                if (mostRecentlyInspectedElement.type === ElementTypeRoot) {
                  var instance = idToDevToolsInstanceMap.get(id);
                  return instance !== void 0 && instance.kind === FIBER_INSTANCE && instance.parent === null;
                }
                return false;
              }
              __name(isMostRecentlyInspectedElement, "isMostRecentlyInspectedElement");
              function isMostRecentlyInspectedElementCurrent(id) {
                return isMostRecentlyInspectedElement(id) && !hasElementUpdatedSinceLastInspected;
              }
              __name(isMostRecentlyInspectedElementCurrent, "isMostRecentlyInspectedElementCurrent");
              function mergeInspectedPaths(path) {
                var current = currentlyInspectedPaths;
                path.forEach(function(key) {
                  if (!current[key]) {
                    current[key] = {};
                  }
                  current = current[key];
                });
              }
              __name(mergeInspectedPaths, "mergeInspectedPaths");
              function createIsPathAllowed(key, secondaryCategory) {
                return /* @__PURE__ */ __name(function isPathAllowed(path) {
                  switch (secondaryCategory) {
                    case "hooks":
                      if (path.length === 1) {
                        return true;
                      }
                      if (path[path.length - 2] === "hookSource" && path[path.length - 1] === "fileName") {
                        return true;
                      }
                      if (path[path.length - 1] === "subHooks" || path[path.length - 2] === "subHooks") {
                        return true;
                      }
                      break;
                    case "suspendedBy":
                      if (path.length < 5) {
                        return true;
                      }
                      break;
                    default:
                      break;
                  }
                  var current = key === null ? currentlyInspectedPaths : currentlyInspectedPaths[key];
                  if (!current) {
                    return false;
                  }
                  for (var i = 0; i < path.length; i++) {
                    current = current[path[i]];
                    if (!current) {
                      return false;
                    }
                  }
                  return true;
                }, "isPathAllowed");
              }
              __name(createIsPathAllowed, "createIsPathAllowed");
              function updateSelectedElement(inspectedElement) {
                var hooks = inspectedElement.hooks, id = inspectedElement.id, props = inspectedElement.props;
                var devtoolsInstance = idToDevToolsInstanceMap.get(id);
                if (devtoolsInstance === void 0) {
                  console.warn('Could not find DevToolsInstance with id "'.concat(id, '"'));
                  return;
                }
                if (devtoolsInstance.kind !== FIBER_INSTANCE) {
                  return;
                }
                var fiber = devtoolsInstance.data;
                var elementType = fiber.elementType, stateNode = fiber.stateNode, tag = fiber.tag, type = fiber.type;
                switch (tag) {
                  case ClassComponent:
                  case IncompleteClassComponent:
                  case IndeterminateComponent:
                    global.$r = stateNode;
                    break;
                  case IncompleteFunctionComponent:
                  case FunctionComponent:
                    global.$r = {
                      hooks,
                      props,
                      type
                    };
                    break;
                  case ForwardRef:
                    global.$r = {
                      hooks,
                      props,
                      type: type.render
                    };
                    break;
                  case MemoComponent:
                  case SimpleMemoComponent:
                    global.$r = {
                      hooks,
                      props,
                      type: elementType != null && elementType.type != null ? elementType.type : type
                    };
                    break;
                  default:
                    global.$r = null;
                    break;
                }
              }
              __name(updateSelectedElement, "updateSelectedElement");
              function storeAsGlobal(id, path, count) {
                if (isMostRecentlyInspectedElement(id)) {
                  var value = utils_getInObject(mostRecentlyInspectedElement, path);
                  var key = "$reactTemp".concat(count);
                  window[key] = value;
                  console.log(key);
                  console.log(value);
                }
              }
              __name(storeAsGlobal, "storeAsGlobal");
              function getSerializedElementValueByPath(id, path) {
                if (isMostRecentlyInspectedElement(id)) {
                  var valueToCopy = utils_getInObject(mostRecentlyInspectedElement, path);
                  return serializeToString(valueToCopy);
                }
              }
              __name(getSerializedElementValueByPath, "getSerializedElementValueByPath");
              function inspectElement(requestID, id, path, forceFullData) {
                if (path !== null) {
                  mergeInspectedPaths(path);
                }
                if (isMostRecentlyInspectedElement(id) && !forceFullData) {
                  if (!hasElementUpdatedSinceLastInspected) {
                    if (path !== null) {
                      var secondaryCategory = null;
                      if (path[0] === "hooks" || path[0] === "suspendedBy") {
                        secondaryCategory = path[0];
                      }
                      return {
                        id,
                        responseID: requestID,
                        type: "hydrated-path",
                        path,
                        value: cleanForBridge(utils_getInObject(mostRecentlyInspectedElement, path), createIsPathAllowed(null, secondaryCategory), path)
                      };
                    } else {
                      return {
                        id,
                        responseID: requestID,
                        type: "no-change"
                      };
                    }
                  }
                } else {
                  currentlyInspectedPaths = {};
                }
                hasElementUpdatedSinceLastInspected = false;
                try {
                  mostRecentlyInspectedElement = inspectElementRaw(id);
                } catch (error) {
                  if (error.name === "ReactDebugToolsRenderError") {
                    var message = "Error rendering inspected element.";
                    var stack;
                    console.error(message + "\n\n", error);
                    if (error.cause != null) {
                      var componentName = getDisplayNameForElementID(id);
                      console.error("React DevTools encountered an error while trying to inspect hooks. This is most likely caused by an error in current inspected component" + (componentName != null ? ': "'.concat(componentName, '".') : ".") + "\nThe error thrown in the component is: \n\n", error.cause);
                      if (error.cause instanceof Error) {
                        message = error.cause.message || message;
                        stack = error.cause.stack;
                      }
                    }
                    return {
                      type: "error",
                      errorType: "user",
                      id,
                      responseID: requestID,
                      message,
                      stack
                    };
                  }
                  if (error.name === "ReactDebugToolsUnsupportedHookError") {
                    return {
                      type: "error",
                      errorType: "unknown-hook",
                      id,
                      responseID: requestID,
                      message: "Unsupported hook in the react-debug-tools package: " + error.message
                    };
                  }
                  console.error("Error inspecting element.\n\n", error);
                  return {
                    type: "error",
                    errorType: "uncaught",
                    id,
                    responseID: requestID,
                    message: error.message,
                    stack: error.stack
                  };
                }
                if (mostRecentlyInspectedElement === null) {
                  return {
                    id,
                    responseID: requestID,
                    type: "not-found"
                  };
                }
                var inspectedElement = mostRecentlyInspectedElement;
                updateSelectedElement(inspectedElement);
                var cleanedInspectedElement = renderer_objectSpread({}, inspectedElement);
                cleanedInspectedElement.context = cleanForBridge(inspectedElement.context, createIsPathAllowed("context", null));
                cleanedInspectedElement.hooks = cleanForBridge(inspectedElement.hooks, createIsPathAllowed("hooks", "hooks"));
                cleanedInspectedElement.props = cleanForBridge(inspectedElement.props, createIsPathAllowed("props", null));
                cleanedInspectedElement.state = cleanForBridge(inspectedElement.state, createIsPathAllowed("state", null));
                cleanedInspectedElement.suspendedBy = cleanForBridge(inspectedElement.suspendedBy, createIsPathAllowed("suspendedBy", "suspendedBy"));
                return {
                  id,
                  responseID: requestID,
                  type: "full-data",
                  value: cleanedInspectedElement
                };
              }
              __name(inspectElement, "inspectElement");
              function inspectRootsRaw(arbitraryRootID) {
                var roots = hook.getFiberRoots(rendererID);
                if (roots.size === 0) {
                  return null;
                }
                var inspectedRoots = {
                  id: arbitraryRootID,
                  type: ElementTypeRoot,
                  isErrored: false,
                  errors: [],
                  warnings: [],
                  suspendedBy: [],
                  suspendedByRange: null,
                  unknownSuspenders: UNKNOWN_SUSPENDERS_NONE,
                  rootType: null,
                  plugins: {
                    stylex: null
                  },
                  nativeTag: null,
                  env: null,
                  source: null,
                  stack: null,
                  rendererPackageName: null,
                  rendererVersion: null,
                  key: null,
                  canEditFunctionProps: false,
                  canEditHooks: false,
                  canEditFunctionPropsDeletePaths: false,
                  canEditFunctionPropsRenamePaths: false,
                  canEditHooksAndDeletePaths: false,
                  canEditHooksAndRenamePaths: false,
                  canToggleError: false,
                  canToggleSuspense: false,
                  isSuspended: false,
                  hasLegacyContext: false,
                  context: null,
                  hooks: null,
                  props: null,
                  state: null,
                  owners: null
                };
                var minSuspendedByRange = Infinity;
                var maxSuspendedByRange = -Infinity;
                roots.forEach(function(root) {
                  var rootInstance = rootToFiberInstanceMap.get(root);
                  if (rootInstance === void 0) {
                    throw new Error("Expected a root instance to exist for this Fiber root");
                  }
                  var inspectedRoot = inspectFiberInstanceRaw(rootInstance);
                  if (inspectedRoot === null) {
                    return;
                  }
                  if (inspectedRoot.isErrored) {
                    inspectedRoots.isErrored = true;
                  }
                  for (var i = 0; i < inspectedRoot.errors.length; i++) {
                    inspectedRoots.errors.push(inspectedRoot.errors[i]);
                  }
                  for (var _i = 0; _i < inspectedRoot.warnings.length; _i++) {
                    inspectedRoots.warnings.push(inspectedRoot.warnings[_i]);
                  }
                  for (var _i2 = 0; _i2 < inspectedRoot.suspendedBy.length; _i2++) {
                    inspectedRoots.suspendedBy.push(inspectedRoot.suspendedBy[_i2]);
                  }
                  var suspendedByRange = inspectedRoot.suspendedByRange;
                  if (suspendedByRange !== null) {
                    if (suspendedByRange[0] < minSuspendedByRange) {
                      minSuspendedByRange = suspendedByRange[0];
                    }
                    if (suspendedByRange[1] > maxSuspendedByRange) {
                      maxSuspendedByRange = suspendedByRange[1];
                    }
                  }
                });
                if (minSuspendedByRange !== Infinity || maxSuspendedByRange !== -Infinity) {
                  inspectedRoots.suspendedByRange = [minSuspendedByRange, maxSuspendedByRange];
                }
                return inspectedRoots;
              }
              __name(inspectRootsRaw, "inspectRootsRaw");
              function logElementToConsole(id) {
                var result = isMostRecentlyInspectedElementCurrent(id) ? mostRecentlyInspectedElement : inspectElementRaw(id);
                if (result === null) {
                  console.warn('Could not find DevToolsInstance with id "'.concat(id, '"'));
                  return;
                }
                var displayName = getDisplayNameForElementID(id);
                var supportsGroup = typeof console.groupCollapsed === "function";
                if (supportsGroup) {
                  console.groupCollapsed("[Click to expand] %c<".concat(displayName || "Component", " />"), "color: var(--dom-tag-name-color); font-weight: normal;");
                }
                if (result.props !== null) {
                  console.log("Props:", result.props);
                }
                if (result.state !== null) {
                  console.log("State:", result.state);
                }
                if (result.hooks !== null) {
                  console.log("Hooks:", result.hooks);
                }
                var hostInstances = findHostInstancesForElementID(id);
                if (hostInstances !== null) {
                  console.log("Nodes:", hostInstances);
                }
                if (window.chrome || /firefox/i.test(navigator.userAgent)) {
                  console.log("Right-click any value to save it as a global variable for further inspection.");
                }
                if (supportsGroup) {
                  console.groupEnd();
                }
              }
              __name(logElementToConsole, "logElementToConsole");
              function deletePath(type, id, hookID, path) {
                var devtoolsInstance = idToDevToolsInstanceMap.get(id);
                if (devtoolsInstance === void 0) {
                  console.warn('Could not find DevToolsInstance with id "'.concat(id, '"'));
                  return;
                }
                if (devtoolsInstance.kind !== FIBER_INSTANCE) {
                  return;
                }
                var fiber = devtoolsInstance.data;
                if (fiber !== null) {
                  var instance = fiber.stateNode;
                  switch (type) {
                    case "context":
                      path = path.slice(1);
                      switch (fiber.tag) {
                        case ClassComponent:
                          if (path.length === 0) {
                          } else {
                            deletePathInObject(instance.context, path);
                          }
                          instance.forceUpdate();
                          break;
                        case FunctionComponent:
                          break;
                      }
                      break;
                    case "hooks":
                      if (typeof overrideHookStateDeletePath === "function") {
                        overrideHookStateDeletePath(fiber, hookID, path);
                      }
                      break;
                    case "props":
                      if (instance === null) {
                        if (typeof overridePropsDeletePath === "function") {
                          overridePropsDeletePath(fiber, path);
                        }
                      } else {
                        fiber.pendingProps = copyWithDelete(instance.props, path);
                        instance.forceUpdate();
                      }
                      break;
                    case "state":
                      deletePathInObject(instance.state, path);
                      instance.forceUpdate();
                      break;
                  }
                }
              }
              __name(deletePath, "deletePath");
              function renamePath(type, id, hookID, oldPath, newPath) {
                var devtoolsInstance = idToDevToolsInstanceMap.get(id);
                if (devtoolsInstance === void 0) {
                  console.warn('Could not find DevToolsInstance with id "'.concat(id, '"'));
                  return;
                }
                if (devtoolsInstance.kind !== FIBER_INSTANCE) {
                  return;
                }
                var fiber = devtoolsInstance.data;
                if (fiber !== null) {
                  var instance = fiber.stateNode;
                  switch (type) {
                    case "context":
                      oldPath = oldPath.slice(1);
                      newPath = newPath.slice(1);
                      switch (fiber.tag) {
                        case ClassComponent:
                          if (oldPath.length === 0) {
                          } else {
                            renamePathInObject(instance.context, oldPath, newPath);
                          }
                          instance.forceUpdate();
                          break;
                        case FunctionComponent:
                          break;
                      }
                      break;
                    case "hooks":
                      if (typeof overrideHookStateRenamePath === "function") {
                        overrideHookStateRenamePath(fiber, hookID, oldPath, newPath);
                      }
                      break;
                    case "props":
                      if (instance === null) {
                        if (typeof overridePropsRenamePath === "function") {
                          overridePropsRenamePath(fiber, oldPath, newPath);
                        }
                      } else {
                        fiber.pendingProps = copyWithRename(instance.props, oldPath, newPath);
                        instance.forceUpdate();
                      }
                      break;
                    case "state":
                      renamePathInObject(instance.state, oldPath, newPath);
                      instance.forceUpdate();
                      break;
                  }
                }
              }
              __name(renamePath, "renamePath");
              function overrideValueAtPath(type, id, hookID, path, value) {
                var devtoolsInstance = idToDevToolsInstanceMap.get(id);
                if (devtoolsInstance === void 0) {
                  console.warn('Could not find DevToolsInstance with id "'.concat(id, '"'));
                  return;
                }
                if (devtoolsInstance.kind !== FIBER_INSTANCE) {
                  return;
                }
                var fiber = devtoolsInstance.data;
                if (fiber !== null) {
                  var instance = fiber.stateNode;
                  switch (type) {
                    case "context":
                      path = path.slice(1);
                      switch (fiber.tag) {
                        case ClassComponent:
                          if (path.length === 0) {
                            instance.context = value;
                          } else {
                            utils_setInObject(instance.context, path, value);
                          }
                          instance.forceUpdate();
                          break;
                        case FunctionComponent:
                          break;
                      }
                      break;
                    case "hooks":
                      if (typeof overrideHookState === "function") {
                        overrideHookState(fiber, hookID, path, value);
                      }
                      break;
                    case "props":
                      switch (fiber.tag) {
                        case ClassComponent:
                          fiber.pendingProps = copyWithSet(instance.props, path, value);
                          instance.forceUpdate();
                          break;
                        default:
                          if (typeof overrideProps === "function") {
                            overrideProps(fiber, path, value);
                          }
                          break;
                      }
                      break;
                    case "state":
                      switch (fiber.tag) {
                        case ClassComponent:
                          utils_setInObject(instance.state, path, value);
                          instance.forceUpdate();
                          break;
                      }
                      break;
                  }
                }
              }
              __name(overrideValueAtPath, "overrideValueAtPath");
              var currentCommitProfilingMetadata = null;
              var displayNamesByRootID = null;
              var initialTreeBaseDurationsMap = null;
              var isProfiling = false;
              var profilingStartTime = 0;
              var recordChangeDescriptions = false;
              var recordTimeline = false;
              var rootToCommitProfilingMetadataMap = null;
              function getProfilingData() {
                var dataForRoots = [];
                if (rootToCommitProfilingMetadataMap === null) {
                  throw Error("getProfilingData() called before any profiling data was recorded");
                }
                rootToCommitProfilingMetadataMap.forEach(function(commitProfilingMetadata, rootID) {
                  var commitData = [];
                  var displayName = displayNamesByRootID !== null && displayNamesByRootID.get(rootID) || "Unknown";
                  var initialTreeBaseDurations = initialTreeBaseDurationsMap !== null && initialTreeBaseDurationsMap.get(rootID) || [];
                  commitProfilingMetadata.forEach(function(commitProfilingData, commitIndex) {
                    var changeDescriptions = commitProfilingData.changeDescriptions, durations = commitProfilingData.durations, effectDuration = commitProfilingData.effectDuration, maxActualDuration = commitProfilingData.maxActualDuration, passiveEffectDuration = commitProfilingData.passiveEffectDuration, priorityLevel = commitProfilingData.priorityLevel, commitTime = commitProfilingData.commitTime, updaters = commitProfilingData.updaters;
                    var fiberActualDurations = [];
                    var fiberSelfDurations = [];
                    for (var i = 0; i < durations.length; i += 3) {
                      var fiberID = durations[i];
                      fiberActualDurations.push([fiberID, formatDurationToMicrosecondsGranularity(durations[i + 1])]);
                      fiberSelfDurations.push([fiberID, formatDurationToMicrosecondsGranularity(durations[i + 2])]);
                    }
                    commitData.push({
                      changeDescriptions: changeDescriptions !== null ? Array.from(changeDescriptions.entries()) : null,
                      duration: formatDurationToMicrosecondsGranularity(maxActualDuration),
                      effectDuration: effectDuration !== null ? formatDurationToMicrosecondsGranularity(effectDuration) : null,
                      fiberActualDurations,
                      fiberSelfDurations,
                      passiveEffectDuration: passiveEffectDuration !== null ? formatDurationToMicrosecondsGranularity(passiveEffectDuration) : null,
                      priorityLevel,
                      timestamp: commitTime,
                      updaters
                    });
                  });
                  dataForRoots.push({
                    commitData,
                    displayName,
                    initialTreeBaseDurations,
                    rootID
                  });
                });
                var timelineData = null;
                if (typeof getTimelineData === "function") {
                  var currentTimelineData = getTimelineData();
                  if (currentTimelineData) {
                    var batchUIDToMeasuresMap = currentTimelineData.batchUIDToMeasuresMap, internalModuleSourceToRanges = currentTimelineData.internalModuleSourceToRanges, laneToLabelMap = currentTimelineData.laneToLabelMap, laneToReactMeasureMap = currentTimelineData.laneToReactMeasureMap, rest = _objectWithoutProperties(currentTimelineData, _excluded);
                    timelineData = renderer_objectSpread(renderer_objectSpread({}, rest), {}, {
                      batchUIDToMeasuresKeyValueArray: Array.from(batchUIDToMeasuresMap.entries()),
                      internalModuleSourceToRanges: Array.from(internalModuleSourceToRanges.entries()),
                      laneToLabelKeyValueArray: Array.from(laneToLabelMap.entries()),
                      laneToReactMeasureKeyValueArray: Array.from(laneToReactMeasureMap.entries())
                    });
                  }
                }
                return {
                  dataForRoots,
                  rendererID,
                  timelineData
                };
              }
              __name(getProfilingData, "getProfilingData");
              function snapshotTreeBaseDurations(instance, target) {
                if (instance.kind !== FILTERED_FIBER_INSTANCE) {
                  target.push([instance.id, instance.treeBaseDuration]);
                }
                for (var child = instance.firstChild; child !== null; child = child.nextSibling) {
                  snapshotTreeBaseDurations(child, target);
                }
              }
              __name(snapshotTreeBaseDurations, "snapshotTreeBaseDurations");
              function startProfiling(shouldRecordChangeDescriptions, shouldRecordTimeline) {
                if (isProfiling) {
                  return;
                }
                recordChangeDescriptions = shouldRecordChangeDescriptions;
                recordTimeline = shouldRecordTimeline;
                displayNamesByRootID = /* @__PURE__ */ new Map();
                initialTreeBaseDurationsMap = /* @__PURE__ */ new Map();
                hook.getFiberRoots(rendererID).forEach(function(root) {
                  var rootInstance = rootToFiberInstanceMap.get(root);
                  if (rootInstance === void 0) {
                    throw new Error("Expected the root instance to already exist when starting profiling");
                  }
                  var rootID = rootInstance.id;
                  displayNamesByRootID.set(rootID, getDisplayNameForRoot(root.current));
                  var initialTreeBaseDurations = [];
                  snapshotTreeBaseDurations(rootInstance, initialTreeBaseDurations);
                  initialTreeBaseDurationsMap.set(rootID, initialTreeBaseDurations);
                });
                isProfiling = true;
                profilingStartTime = renderer_getCurrentTime();
                rootToCommitProfilingMetadataMap = /* @__PURE__ */ new Map();
                if (toggleProfilingStatus !== null) {
                  toggleProfilingStatus(true, recordTimeline);
                }
              }
              __name(startProfiling, "startProfiling");
              function stopProfiling() {
                isProfiling = false;
                recordChangeDescriptions = false;
                if (toggleProfilingStatus !== null) {
                  toggleProfilingStatus(false, recordTimeline);
                }
                recordTimeline = false;
              }
              __name(stopProfiling, "stopProfiling");
              if (shouldStartProfilingNow) {
                startProfiling(profilingSettings.recordChangeDescriptions, profilingSettings.recordTimeline);
              }
              function getNearestFiber(devtoolsInstance) {
                if (devtoolsInstance.kind === VIRTUAL_INSTANCE) {
                  var inst = devtoolsInstance;
                  while (inst.kind === VIRTUAL_INSTANCE) {
                    if (inst.firstChild === null) {
                      return null;
                    }
                    inst = inst.firstChild;
                  }
                  return inst.data.return;
                } else {
                  return devtoolsInstance.data;
                }
              }
              __name(getNearestFiber, "getNearestFiber");
              function shouldErrorFiberAlwaysNull() {
                return null;
              }
              __name(shouldErrorFiberAlwaysNull, "shouldErrorFiberAlwaysNull");
              var forceErrorForFibers = /* @__PURE__ */ new Map();
              function shouldErrorFiberAccordingToMap(fiber) {
                if (typeof setErrorHandler !== "function") {
                  throw new Error("Expected overrideError() to not get called for earlier React versions.");
                }
                var status = forceErrorForFibers.get(fiber);
                if (status === false) {
                  forceErrorForFibers.delete(fiber);
                  if (forceErrorForFibers.size === 0) {
                    setErrorHandler(shouldErrorFiberAlwaysNull);
                  }
                  return false;
                }
                if (status === void 0 && fiber.alternate !== null) {
                  status = forceErrorForFibers.get(fiber.alternate);
                  if (status === false) {
                    forceErrorForFibers.delete(fiber.alternate);
                    if (forceErrorForFibers.size === 0) {
                      setErrorHandler(shouldErrorFiberAlwaysNull);
                    }
                  }
                }
                if (status === void 0) {
                  return false;
                }
                return status;
              }
              __name(shouldErrorFiberAccordingToMap, "shouldErrorFiberAccordingToMap");
              function overrideError(id, forceError) {
                if (typeof setErrorHandler !== "function" || typeof scheduleUpdate !== "function") {
                  throw new Error("Expected overrideError() to not get called for earlier React versions.");
                }
                var devtoolsInstance = idToDevToolsInstanceMap.get(id);
                if (devtoolsInstance === void 0) {
                  return;
                }
                var nearestFiber = getNearestFiber(devtoolsInstance);
                if (nearestFiber === null) {
                  return;
                }
                var fiber = nearestFiber;
                while (!isErrorBoundary(fiber)) {
                  if (fiber.return === null) {
                    return;
                  }
                  fiber = fiber.return;
                }
                forceErrorForFibers.set(fiber, forceError);
                if (fiber.alternate !== null) {
                  forceErrorForFibers.delete(fiber.alternate);
                }
                if (forceErrorForFibers.size === 1) {
                  setErrorHandler(shouldErrorFiberAccordingToMap);
                }
                if (!forceError && typeof scheduleRetry === "function") {
                  scheduleRetry(fiber);
                } else {
                  scheduleUpdate(fiber);
                }
              }
              __name(overrideError, "overrideError");
              function shouldSuspendFiberAlwaysFalse() {
                return false;
              }
              __name(shouldSuspendFiberAlwaysFalse, "shouldSuspendFiberAlwaysFalse");
              var forceFallbackForFibers = /* @__PURE__ */ new Set();
              function shouldSuspendFiberAccordingToSet(fiber) {
                return forceFallbackForFibers.has(fiber) || fiber.alternate !== null && forceFallbackForFibers.has(fiber.alternate);
              }
              __name(shouldSuspendFiberAccordingToSet, "shouldSuspendFiberAccordingToSet");
              function overrideSuspense(id, forceFallback) {
                if (typeof setSuspenseHandler !== "function" || typeof scheduleUpdate !== "function") {
                  throw new Error("Expected overrideSuspense() to not get called for earlier React versions.");
                }
                var devtoolsInstance = idToDevToolsInstanceMap.get(id);
                if (devtoolsInstance === void 0) {
                  return;
                }
                var nearestFiber = getNearestFiber(devtoolsInstance);
                if (nearestFiber === null) {
                  return;
                }
                var fiber = nearestFiber;
                while (fiber.tag !== SuspenseComponent) {
                  if (fiber.return === null) {
                    return;
                  }
                  fiber = fiber.return;
                }
                if (fiber.alternate !== null) {
                  forceFallbackForFibers.delete(fiber.alternate);
                }
                if (forceFallback) {
                  forceFallbackForFibers.add(fiber);
                  if (forceFallbackForFibers.size === 1) {
                    setSuspenseHandler(shouldSuspendFiberAccordingToSet);
                  }
                } else {
                  forceFallbackForFibers.delete(fiber);
                  if (forceFallbackForFibers.size === 0) {
                    setSuspenseHandler(shouldSuspendFiberAlwaysFalse);
                  }
                }
                if (!forceFallback && typeof scheduleRetry === "function") {
                  scheduleRetry(fiber);
                } else {
                  scheduleUpdate(fiber);
                }
              }
              __name(overrideSuspense, "overrideSuspense");
              function overrideSuspenseMilestone(suspendedSet) {
                if (typeof setSuspenseHandler !== "function" || typeof scheduleUpdate !== "function") {
                  throw new Error("Expected overrideSuspenseMilestone() to not get called for earlier React versions.");
                }
                var unsuspendedSet = new Set(forceFallbackForFibers);
                var resuspended = false;
                for (var i = 0; i < suspendedSet.length; ++i) {
                  var instance = idToDevToolsInstanceMap.get(suspendedSet[i]);
                  if (instance === void 0) {
                    console.warn("Could not suspend ID '".concat(suspendedSet[i], "' since the instance can't be found."));
                    continue;
                  }
                  if (instance.kind === FIBER_INSTANCE) {
                    var _fiber11 = instance.data;
                    if (forceFallbackForFibers.has(_fiber11) || _fiber11.alternate !== null && forceFallbackForFibers.has(_fiber11.alternate)) {
                      unsuspendedSet.delete(_fiber11);
                      if (_fiber11.alternate !== null) {
                        unsuspendedSet.delete(_fiber11.alternate);
                      }
                    } else {
                      forceFallbackForFibers.add(_fiber11);
                      scheduleUpdate(_fiber11);
                      resuspended = true;
                    }
                  } else {
                    console.warn("Cannot not suspend ID '".concat(suspendedSet[i], "'."));
                  }
                }
                unsuspendedSet.forEach(function(fiber) {
                  forceFallbackForFibers.delete(fiber);
                  if (!resuspended && typeof scheduleRetry === "function") {
                    scheduleRetry(fiber);
                  } else {
                    scheduleUpdate(fiber);
                  }
                });
                if (forceFallbackForFibers.size > 0) {
                  setSuspenseHandler(shouldSuspendFiberAccordingToSet);
                } else {
                  setSuspenseHandler(shouldSuspendFiberAlwaysFalse);
                }
              }
              __name(overrideSuspenseMilestone, "overrideSuspenseMilestone");
              var trackedPath = null;
              var trackedPathMatchFiber = null;
              var trackedPathMatchInstance = null;
              var trackedPathMatchDepth = -1;
              var mightBeOnTrackedPath = false;
              function setTrackedPath(path) {
                if (path === null) {
                  trackedPathMatchFiber = null;
                  trackedPathMatchInstance = null;
                  trackedPathMatchDepth = -1;
                  mightBeOnTrackedPath = false;
                }
                trackedPath = path;
              }
              __name(setTrackedPath, "setTrackedPath");
              function updateTrackedPathStateBeforeMount(fiber, fiberInstance) {
                if (trackedPath === null || !mightBeOnTrackedPath) {
                  return false;
                }
                var returnFiber = fiber.return;
                var returnAlternate = returnFiber !== null ? returnFiber.alternate : null;
                if (trackedPathMatchFiber === returnFiber || trackedPathMatchFiber === returnAlternate && returnAlternate !== null) {
                  var actualFrame = getPathFrame(fiber);
                  var expectedFrame = trackedPath[trackedPathMatchDepth + 1];
                  if (expectedFrame === void 0) {
                    throw new Error("Expected to see a frame at the next depth.");
                  }
                  if (actualFrame.index === expectedFrame.index && actualFrame.key === expectedFrame.key && actualFrame.displayName === expectedFrame.displayName) {
                    trackedPathMatchFiber = fiber;
                    if (fiberInstance !== null && fiberInstance.kind === FIBER_INSTANCE) {
                      trackedPathMatchInstance = fiberInstance;
                    }
                    trackedPathMatchDepth++;
                    if (trackedPathMatchDepth === trackedPath.length - 1) {
                      mightBeOnTrackedPath = false;
                    } else {
                      mightBeOnTrackedPath = true;
                    }
                    return false;
                  }
                }
                if (trackedPathMatchFiber === null && fiberInstance === null) {
                  return true;
                }
                mightBeOnTrackedPath = false;
                return true;
              }
              __name(updateTrackedPathStateBeforeMount, "updateTrackedPathStateBeforeMount");
              function updateVirtualTrackedPathStateBeforeMount(virtualInstance, parentInstance) {
                if (trackedPath === null || !mightBeOnTrackedPath) {
                  return false;
                }
                if (trackedPathMatchInstance === parentInstance) {
                  var actualFrame = getVirtualPathFrame(virtualInstance);
                  var expectedFrame = trackedPath[trackedPathMatchDepth + 1];
                  if (expectedFrame === void 0) {
                    throw new Error("Expected to see a frame at the next depth.");
                  }
                  if (actualFrame.index === expectedFrame.index && actualFrame.key === expectedFrame.key && actualFrame.displayName === expectedFrame.displayName) {
                    trackedPathMatchFiber = null;
                    trackedPathMatchInstance = virtualInstance;
                    trackedPathMatchDepth++;
                    if (trackedPathMatchDepth === trackedPath.length - 1) {
                      mightBeOnTrackedPath = false;
                    } else {
                      mightBeOnTrackedPath = true;
                    }
                    return false;
                  }
                }
                if (trackedPathMatchFiber !== null) {
                  return true;
                }
                mightBeOnTrackedPath = false;
                return true;
              }
              __name(updateVirtualTrackedPathStateBeforeMount, "updateVirtualTrackedPathStateBeforeMount");
              function updateTrackedPathStateAfterMount(mightSiblingsBeOnTrackedPath) {
                mightBeOnTrackedPath = mightSiblingsBeOnTrackedPath;
              }
              __name(updateTrackedPathStateAfterMount, "updateTrackedPathStateAfterMount");
              var rootPseudoKeys = /* @__PURE__ */ new Map();
              var rootDisplayNameCounter = /* @__PURE__ */ new Map();
              function setRootPseudoKey(id, fiber) {
                var name = getDisplayNameForRoot(fiber);
                var counter = rootDisplayNameCounter.get(name) || 0;
                rootDisplayNameCounter.set(name, counter + 1);
                var pseudoKey = "".concat(name, ":").concat(counter);
                rootPseudoKeys.set(id, pseudoKey);
              }
              __name(setRootPseudoKey, "setRootPseudoKey");
              function removeRootPseudoKey(id) {
                var pseudoKey = rootPseudoKeys.get(id);
                if (pseudoKey === void 0) {
                  throw new Error("Expected root pseudo key to be known.");
                }
                var name = pseudoKey.slice(0, pseudoKey.lastIndexOf(":"));
                var counter = rootDisplayNameCounter.get(name);
                if (counter === void 0) {
                  throw new Error("Expected counter to be known.");
                }
                if (counter > 1) {
                  rootDisplayNameCounter.set(name, counter - 1);
                } else {
                  rootDisplayNameCounter.delete(name);
                }
                rootPseudoKeys.delete(id);
              }
              __name(removeRootPseudoKey, "removeRootPseudoKey");
              function getDisplayNameForRoot(fiber) {
                var preferredDisplayName = null;
                var fallbackDisplayName = null;
                var child = fiber.child;
                for (var i = 0; i < 3; i++) {
                  if (child === null) {
                    break;
                  }
                  var displayName = getDisplayNameForFiber(child);
                  if (displayName !== null) {
                    if (typeof child.type === "function") {
                      preferredDisplayName = displayName;
                    } else if (fallbackDisplayName === null) {
                      fallbackDisplayName = displayName;
                    }
                  }
                  if (preferredDisplayName !== null) {
                    break;
                  }
                  child = child.child;
                }
                return preferredDisplayName || fallbackDisplayName || "Anonymous";
              }
              __name(getDisplayNameForRoot, "getDisplayNameForRoot");
              function getPathFrame(fiber) {
                var key = fiber.key;
                var displayName = getDisplayNameForFiber(fiber);
                var index = fiber.index;
                switch (fiber.tag) {
                  case HostRoot:
                    var rootInstance = rootToFiberInstanceMap.get(fiber.stateNode);
                    if (rootInstance === void 0) {
                      throw new Error("Expected the root instance to exist when computing a path");
                    }
                    var pseudoKey = rootPseudoKeys.get(rootInstance.id);
                    if (pseudoKey === void 0) {
                      throw new Error("Expected mounted root to have known pseudo key.");
                    }
                    displayName = pseudoKey;
                    break;
                  case HostComponent:
                    displayName = fiber.type;
                    break;
                  default:
                    break;
                }
                return {
                  displayName,
                  key,
                  index
                };
              }
              __name(getPathFrame, "getPathFrame");
              function getVirtualPathFrame(virtualInstance) {
                return {
                  displayName: virtualInstance.data.name || "",
                  key: virtualInstance.data.key == null ? null : virtualInstance.data.key,
                  index: -1
                };
              }
              __name(getVirtualPathFrame, "getVirtualPathFrame");
              function getPathForElement(id) {
                var devtoolsInstance = idToDevToolsInstanceMap.get(id);
                if (devtoolsInstance === void 0) {
                  return null;
                }
                var keyPath = [];
                var inst = devtoolsInstance;
                while (inst.kind === VIRTUAL_INSTANCE) {
                  keyPath.push(getVirtualPathFrame(inst));
                  if (inst.parent === null) {
                    return null;
                  }
                  inst = inst.parent;
                }
                var fiber = inst.data;
                while (fiber !== null) {
                  keyPath.push(getPathFrame(fiber));
                  fiber = fiber.return;
                }
                keyPath.reverse();
                return keyPath;
              }
              __name(getPathForElement, "getPathForElement");
              function getBestMatchForTrackedPath() {
                if (trackedPath === null) {
                  return null;
                }
                if (trackedPathMatchInstance === null) {
                  return null;
                }
                return {
                  id: trackedPathMatchInstance.id,
                  isFullMatch: trackedPathMatchDepth === trackedPath.length - 1
                };
              }
              __name(getBestMatchForTrackedPath, "getBestMatchForTrackedPath");
              var formatPriorityLevel = /* @__PURE__ */ __name(function formatPriorityLevel2(priorityLevel) {
                if (priorityLevel == null) {
                  return "Unknown";
                }
                switch (priorityLevel) {
                  case ImmediatePriority:
                    return "Immediate";
                  case UserBlockingPriority:
                    return "User-Blocking";
                  case NormalPriority:
                    return "Normal";
                  case LowPriority:
                    return "Low";
                  case IdlePriority:
                    return "Idle";
                  case NoPriority:
                  default:
                    return "Unknown";
                }
              }, "formatPriorityLevel");
              function setTraceUpdatesEnabled(isEnabled2) {
                traceUpdatesEnabled = isEnabled2;
              }
              __name(setTraceUpdatesEnabled, "setTraceUpdatesEnabled");
              function hasElementWithId(id) {
                return idToDevToolsInstanceMap.has(id);
              }
              __name(hasElementWithId, "hasElementWithId");
              function getSourceForFiberInstance(fiberInstance) {
                var ownerSource = getSourceForInstance(fiberInstance);
                if (ownerSource !== null) {
                  return ownerSource;
                }
                var dispatcherRef = getDispatcherRef(renderer);
                var stackFrame = dispatcherRef == null ? null : getSourceLocationByFiber(ReactTypeOfWork, fiberInstance.data, dispatcherRef);
                if (stackFrame === null) {
                  return null;
                }
                var source = extractLocationFromComponentStack(stackFrame);
                fiberInstance.source = source;
                return source;
              }
              __name(getSourceForFiberInstance, "getSourceForFiberInstance");
              function getSourceForInstance(instance) {
                var unresolvedSource = instance.source;
                if (unresolvedSource === null) {
                  return null;
                }
                if (instance.kind === VIRTUAL_INSTANCE) {
                  var debugLocation = instance.data.debugLocation;
                  if (debugLocation != null) {
                    unresolvedSource = debugLocation;
                  }
                }
                if (renderer_isError(unresolvedSource)) {
                  return instance.source = extractLocationFromOwnerStack(unresolvedSource);
                }
                if (typeof unresolvedSource === "string") {
                  var idx = unresolvedSource.lastIndexOf("\n");
                  var lastLine = idx === -1 ? unresolvedSource : unresolvedSource.slice(idx + 1);
                  return instance.source = extractLocationFromComponentStack(lastLine);
                }
                return unresolvedSource;
              }
              __name(getSourceForInstance, "getSourceForInstance");
              var internalMcpFunctions = {};
              if (false) {
              }
              return renderer_objectSpread({
                cleanup,
                clearErrorsAndWarnings,
                clearErrorsForElementID,
                clearWarningsForElementID,
                getSerializedElementValueByPath,
                deletePath,
                findHostInstancesForElementID,
                findLastKnownRectsForID,
                flushInitialOperations,
                getBestMatchForTrackedPath,
                getDisplayNameForElementID,
                getNearestMountedDOMNode,
                getElementIDForHostInstance,
                getSuspenseNodeIDForHostInstance,
                getInstanceAndStyle,
                getOwnersList,
                getPathForElement,
                getProfilingData,
                handleCommitFiberRoot,
                handleCommitFiberUnmount,
                handlePostCommitFiberRoot,
                hasElementWithId,
                inspectElement,
                logElementToConsole,
                getComponentStack,
                getElementAttributeByPath,
                getElementSourceFunctionById,
                onErrorOrWarning,
                overrideError,
                overrideSuspense,
                overrideSuspenseMilestone,
                overrideValueAtPath,
                renamePath,
                renderer,
                setTraceUpdatesEnabled,
                setTrackedPath,
                startProfiling,
                stopProfiling,
                storeAsGlobal,
                supportsTogglingSuspense,
                updateComponentFilters,
                getEnvironmentNames
              }, internalMcpFunctions);
            }
            __name(renderer_attach, "renderer_attach");
            ;
            function decorate(object, attr, fn) {
              var old = object[attr];
              object[attr] = function(instance) {
                return fn.call(this, old, arguments);
              };
              return old;
            }
            __name(decorate, "decorate");
            function decorateMany(source, fns) {
              var olds = {};
              for (var name in fns) {
                olds[name] = decorate(source, name, fns[name]);
              }
              return olds;
            }
            __name(decorateMany, "decorateMany");
            function restoreMany(source, olds) {
              for (var name in olds) {
                source[name] = olds[name];
              }
            }
            __name(restoreMany, "restoreMany");
            function forceUpdate(instance) {
              if (typeof instance.forceUpdate === "function") {
                instance.forceUpdate();
              } else if (instance.updater != null && typeof instance.updater.enqueueForceUpdate === "function") {
                instance.updater.enqueueForceUpdate(this, function() {
                }, "forceUpdate");
              }
            }
            __name(forceUpdate, "forceUpdate");
            ;
            function legacy_renderer_ownKeys(e, r) {
              var t = Object.keys(e);
              if (Object.getOwnPropertySymbols) {
                var o = Object.getOwnPropertySymbols(e);
                r && (o = o.filter(function(r2) {
                  return Object.getOwnPropertyDescriptor(e, r2).enumerable;
                })), t.push.apply(t, o);
              }
              return t;
            }
            __name(legacy_renderer_ownKeys, "legacy_renderer_ownKeys");
            function legacy_renderer_objectSpread(e) {
              for (var r = 1; r < arguments.length; r++) {
                var t = null != arguments[r] ? arguments[r] : {};
                r % 2 ? legacy_renderer_ownKeys(Object(t), true).forEach(function(r2) {
                  legacy_renderer_defineProperty(e, r2, t[r2]);
                }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : legacy_renderer_ownKeys(Object(t)).forEach(function(r2) {
                  Object.defineProperty(e, r2, Object.getOwnPropertyDescriptor(t, r2));
                });
              }
              return e;
            }
            __name(legacy_renderer_objectSpread, "legacy_renderer_objectSpread");
            function legacy_renderer_defineProperty(obj, key, value) {
              key = legacy_renderer_toPropertyKey(key);
              if (key in obj) {
                Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
              } else {
                obj[key] = value;
              }
              return obj;
            }
            __name(legacy_renderer_defineProperty, "legacy_renderer_defineProperty");
            function legacy_renderer_toPropertyKey(t) {
              var i = legacy_renderer_toPrimitive(t, "string");
              return "symbol" == legacy_renderer_typeof(i) ? i : i + "";
            }
            __name(legacy_renderer_toPropertyKey, "legacy_renderer_toPropertyKey");
            function legacy_renderer_toPrimitive(t, r) {
              if ("object" != legacy_renderer_typeof(t) || !t) return t;
              var e = t[Symbol.toPrimitive];
              if (void 0 !== e) {
                var i = e.call(t, r || "default");
                if ("object" != legacy_renderer_typeof(i)) return i;
                throw new TypeError("@@toPrimitive must return a primitive value.");
              }
              return ("string" === r ? String : Number)(t);
            }
            __name(legacy_renderer_toPrimitive, "legacy_renderer_toPrimitive");
            function legacy_renderer_typeof(o) {
              "@babel/helpers - typeof";
              return legacy_renderer_typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                return typeof o2;
              } : function(o2) {
                return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
              }, legacy_renderer_typeof(o);
            }
            __name(legacy_renderer_typeof, "legacy_renderer_typeof");
            function getData(internalInstance) {
              var displayName = null;
              var key = null;
              if (internalInstance._currentElement != null) {
                if (internalInstance._currentElement.key) {
                  key = String(internalInstance._currentElement.key);
                }
                var elementType = internalInstance._currentElement.type;
                if (typeof elementType === "string") {
                  displayName = elementType;
                } else if (typeof elementType === "function") {
                  displayName = getDisplayName(elementType);
                }
              }
              return {
                displayName,
                key
              };
            }
            __name(getData, "getData");
            function getElementType(internalInstance) {
              if (internalInstance._currentElement != null) {
                var elementType = internalInstance._currentElement.type;
                if (typeof elementType === "function") {
                  var publicInstance = internalInstance.getPublicInstance();
                  if (publicInstance !== null) {
                    return types_ElementTypeClass;
                  } else {
                    return types_ElementTypeFunction;
                  }
                } else if (typeof elementType === "string") {
                  return ElementTypeHostComponent;
                }
              }
              return ElementTypeOtherOrUnknown;
            }
            __name(getElementType, "getElementType");
            function getChildren(internalInstance) {
              var children = [];
              if (legacy_renderer_typeof(internalInstance) !== "object") {
              } else if (internalInstance._currentElement === null || internalInstance._currentElement === false) {
              } else if (internalInstance._renderedComponent) {
                var child = internalInstance._renderedComponent;
                if (getElementType(child) !== ElementTypeOtherOrUnknown) {
                  children.push(child);
                }
              } else if (internalInstance._renderedChildren) {
                var renderedChildren = internalInstance._renderedChildren;
                for (var name in renderedChildren) {
                  var _child = renderedChildren[name];
                  if (getElementType(_child) !== ElementTypeOtherOrUnknown) {
                    children.push(_child);
                  }
                }
              }
              return children;
            }
            __name(getChildren, "getChildren");
            function legacy_renderer_attach(hook, rendererID, renderer, global) {
              var idToInternalInstanceMap = /* @__PURE__ */ new Map();
              var internalInstanceToIDMap = /* @__PURE__ */ new WeakMap();
              var internalInstanceToRootIDMap = /* @__PURE__ */ new WeakMap();
              var getElementIDForHostInstance = null;
              var findHostInstanceForInternalID;
              var getNearestMountedDOMNode = /* @__PURE__ */ __name(function getNearestMountedDOMNode2(node) {
                return null;
              }, "getNearestMountedDOMNode");
              if (renderer.ComponentTree) {
                getElementIDForHostInstance = /* @__PURE__ */ __name(function getElementIDForHostInstance2(node) {
                  var internalInstance = renderer.ComponentTree.getClosestInstanceFromNode(node);
                  return internalInstanceToIDMap.get(internalInstance) || null;
                }, "getElementIDForHostInstance");
                findHostInstanceForInternalID = /* @__PURE__ */ __name(function findHostInstanceForInternalID2(id) {
                  var internalInstance = idToInternalInstanceMap.get(id);
                  return renderer.ComponentTree.getNodeFromInstance(internalInstance);
                }, "findHostInstanceForInternalID");
                getNearestMountedDOMNode = /* @__PURE__ */ __name(function getNearestMountedDOMNode2(node) {
                  var internalInstance = renderer.ComponentTree.getClosestInstanceFromNode(node);
                  if (internalInstance != null) {
                    return renderer.ComponentTree.getNodeFromInstance(internalInstance);
                  }
                  return null;
                }, "getNearestMountedDOMNode");
              } else if (renderer.Mount.getID && renderer.Mount.getNode) {
                getElementIDForHostInstance = /* @__PURE__ */ __name(function getElementIDForHostInstance2(node) {
                  return null;
                }, "getElementIDForHostInstance");
                findHostInstanceForInternalID = /* @__PURE__ */ __name(function findHostInstanceForInternalID2(id) {
                  return null;
                }, "findHostInstanceForInternalID");
              }
              var supportsTogglingSuspense = false;
              function getDisplayNameForElementID(id) {
                var internalInstance = idToInternalInstanceMap.get(id);
                return internalInstance ? getData(internalInstance).displayName : null;
              }
              __name(getDisplayNameForElementID, "getDisplayNameForElementID");
              function getID(internalInstance) {
                if (legacy_renderer_typeof(internalInstance) !== "object" || internalInstance === null) {
                  throw new Error("Invalid internal instance: " + internalInstance);
                }
                if (!internalInstanceToIDMap.has(internalInstance)) {
                  var _id = getUID();
                  internalInstanceToIDMap.set(internalInstance, _id);
                  idToInternalInstanceMap.set(_id, internalInstance);
                }
                return internalInstanceToIDMap.get(internalInstance);
              }
              __name(getID, "getID");
              function areEqualArrays(a, b) {
                if (a.length !== b.length) {
                  return false;
                }
                for (var i = 0; i < a.length; i++) {
                  if (a[i] !== b[i]) {
                    return false;
                  }
                }
                return true;
              }
              __name(areEqualArrays, "areEqualArrays");
              var parentIDStack = [];
              var oldReconcilerMethods = null;
              if (renderer.Reconciler) {
                oldReconcilerMethods = decorateMany(renderer.Reconciler, {
                  mountComponent: /* @__PURE__ */ __name(function mountComponent(fn, args) {
                    var internalInstance = args[0];
                    var hostContainerInfo = args[3];
                    if (getElementType(internalInstance) === ElementTypeOtherOrUnknown) {
                      return fn.apply(this, args);
                    }
                    if (hostContainerInfo._topLevelWrapper === void 0) {
                      return fn.apply(this, args);
                    }
                    var id = getID(internalInstance);
                    var parentID = parentIDStack.length > 0 ? parentIDStack[parentIDStack.length - 1] : 0;
                    recordMount(internalInstance, id, parentID);
                    parentIDStack.push(id);
                    internalInstanceToRootIDMap.set(internalInstance, getID(hostContainerInfo._topLevelWrapper));
                    try {
                      var result = fn.apply(this, args);
                      parentIDStack.pop();
                      return result;
                    } catch (err) {
                      parentIDStack = [];
                      throw err;
                    } finally {
                      if (parentIDStack.length === 0) {
                        var rootID = internalInstanceToRootIDMap.get(internalInstance);
                        if (rootID === void 0) {
                          throw new Error("Expected to find root ID.");
                        }
                        flushPendingEvents(rootID);
                      }
                    }
                  }, "mountComponent"),
                  performUpdateIfNecessary: /* @__PURE__ */ __name(function performUpdateIfNecessary(fn, args) {
                    var internalInstance = args[0];
                    if (getElementType(internalInstance) === ElementTypeOtherOrUnknown) {
                      return fn.apply(this, args);
                    }
                    var id = getID(internalInstance);
                    parentIDStack.push(id);
                    var prevChildren = getChildren(internalInstance);
                    try {
                      var result = fn.apply(this, args);
                      var nextChildren = getChildren(internalInstance);
                      if (!areEqualArrays(prevChildren, nextChildren)) {
                        recordReorder(internalInstance, id, nextChildren);
                      }
                      parentIDStack.pop();
                      return result;
                    } catch (err) {
                      parentIDStack = [];
                      throw err;
                    } finally {
                      if (parentIDStack.length === 0) {
                        var rootID = internalInstanceToRootIDMap.get(internalInstance);
                        if (rootID === void 0) {
                          throw new Error("Expected to find root ID.");
                        }
                        flushPendingEvents(rootID);
                      }
                    }
                  }, "performUpdateIfNecessary"),
                  receiveComponent: /* @__PURE__ */ __name(function receiveComponent(fn, args) {
                    var internalInstance = args[0];
                    if (getElementType(internalInstance) === ElementTypeOtherOrUnknown) {
                      return fn.apply(this, args);
                    }
                    var id = getID(internalInstance);
                    parentIDStack.push(id);
                    var prevChildren = getChildren(internalInstance);
                    try {
                      var result = fn.apply(this, args);
                      var nextChildren = getChildren(internalInstance);
                      if (!areEqualArrays(prevChildren, nextChildren)) {
                        recordReorder(internalInstance, id, nextChildren);
                      }
                      parentIDStack.pop();
                      return result;
                    } catch (err) {
                      parentIDStack = [];
                      throw err;
                    } finally {
                      if (parentIDStack.length === 0) {
                        var rootID = internalInstanceToRootIDMap.get(internalInstance);
                        if (rootID === void 0) {
                          throw new Error("Expected to find root ID.");
                        }
                        flushPendingEvents(rootID);
                      }
                    }
                  }, "receiveComponent"),
                  unmountComponent: /* @__PURE__ */ __name(function unmountComponent(fn, args) {
                    var internalInstance = args[0];
                    if (getElementType(internalInstance) === ElementTypeOtherOrUnknown) {
                      return fn.apply(this, args);
                    }
                    var id = getID(internalInstance);
                    parentIDStack.push(id);
                    try {
                      var result = fn.apply(this, args);
                      parentIDStack.pop();
                      recordUnmount(internalInstance, id);
                      return result;
                    } catch (err) {
                      parentIDStack = [];
                      throw err;
                    } finally {
                      if (parentIDStack.length === 0) {
                        var rootID = internalInstanceToRootIDMap.get(internalInstance);
                        if (rootID === void 0) {
                          throw new Error("Expected to find root ID.");
                        }
                        flushPendingEvents(rootID);
                      }
                    }
                  }, "unmountComponent")
                });
              }
              function cleanup() {
                if (oldReconcilerMethods !== null) {
                  if (renderer.Component) {
                    restoreMany(renderer.Component.Mixin, oldReconcilerMethods);
                  } else {
                    restoreMany(renderer.Reconciler, oldReconcilerMethods);
                  }
                }
                oldReconcilerMethods = null;
              }
              __name(cleanup, "cleanup");
              function recordMount(internalInstance, id, parentID) {
                var isRoot = parentID === 0;
                if (__DEBUG__) {
                  console.log("%crecordMount()", "color: green; font-weight: bold;", id, getData(internalInstance).displayName);
                }
                if (isRoot) {
                  var hasOwnerMetadata = internalInstance._currentElement != null && internalInstance._currentElement._owner != null;
                  pushOperation(TREE_OPERATION_ADD);
                  pushOperation(id);
                  pushOperation(ElementTypeRoot);
                  pushOperation(0);
                  pushOperation(0);
                  pushOperation(0);
                  pushOperation(hasOwnerMetadata ? 1 : 0);
                  pushOperation(SUSPENSE_TREE_OPERATION_ADD);
                  pushOperation(id);
                  pushOperation(parentID);
                  pushOperation(getStringID(null));
                  pushOperation(0);
                  pushOperation(-1);
                } else {
                  var type = getElementType(internalInstance);
                  var _getData = getData(internalInstance), displayName = _getData.displayName, key = _getData.key;
                  var ownerID = internalInstance._currentElement != null && internalInstance._currentElement._owner != null ? getID(internalInstance._currentElement._owner) : 0;
                  var displayNameStringID = getStringID(displayName);
                  var keyStringID = getStringID(key);
                  pushOperation(TREE_OPERATION_ADD);
                  pushOperation(id);
                  pushOperation(type);
                  pushOperation(parentID);
                  pushOperation(ownerID);
                  pushOperation(displayNameStringID);
                  pushOperation(keyStringID);
                  pushOperation(getStringID(null));
                }
              }
              __name(recordMount, "recordMount");
              function recordReorder(internalInstance, id, nextChildren) {
                pushOperation(TREE_OPERATION_REORDER_CHILDREN);
                pushOperation(id);
                var nextChildIDs = nextChildren.map(getID);
                pushOperation(nextChildIDs.length);
                for (var i = 0; i < nextChildIDs.length; i++) {
                  pushOperation(nextChildIDs[i]);
                }
              }
              __name(recordReorder, "recordReorder");
              function recordUnmount(internalInstance, id) {
                var isRoot = parentIDStack.length === 0;
                if (isRoot) {
                  pendingUnmountedRootID = id;
                } else {
                  pendingUnmountedIDs.push(id);
                }
                idToInternalInstanceMap.delete(id);
              }
              __name(recordUnmount, "recordUnmount");
              function crawlAndRecordInitialMounts(id, parentID, rootID) {
                if (__DEBUG__) {
                  console.group("crawlAndRecordInitialMounts() id:", id);
                }
                var internalInstance = idToInternalInstanceMap.get(id);
                if (internalInstance != null) {
                  internalInstanceToRootIDMap.set(internalInstance, rootID);
                  recordMount(internalInstance, id, parentID);
                  getChildren(internalInstance).forEach(function(child) {
                    return crawlAndRecordInitialMounts(getID(child), id, rootID);
                  });
                }
                if (__DEBUG__) {
                  console.groupEnd();
                }
              }
              __name(crawlAndRecordInitialMounts, "crawlAndRecordInitialMounts");
              function flushInitialOperations() {
                var roots = renderer.Mount._instancesByReactRootID || renderer.Mount._instancesByContainerID;
                for (var key in roots) {
                  var internalInstance = roots[key];
                  var _id2 = getID(internalInstance);
                  crawlAndRecordInitialMounts(_id2, 0, _id2);
                  flushPendingEvents(_id2);
                }
              }
              __name(flushInitialOperations, "flushInitialOperations");
              var pendingOperations = [];
              var pendingStringTable = /* @__PURE__ */ new Map();
              var pendingUnmountedIDs = [];
              var pendingStringTableLength = 0;
              var pendingUnmountedRootID = null;
              function flushPendingEvents(rootID) {
                if (pendingOperations.length === 0 && pendingUnmountedIDs.length === 0 && pendingUnmountedRootID === null) {
                  return;
                }
                var numUnmountIDs = pendingUnmountedIDs.length + (pendingUnmountedRootID === null ? 0 : 1);
                var operations = new Array(2 + 1 + pendingStringTableLength + (numUnmountIDs > 0 ? 2 + numUnmountIDs : 0) + (pendingUnmountedRootID === null ? 0 : 3) + pendingOperations.length);
                var i = 0;
                operations[i++] = rendererID;
                operations[i++] = rootID;
                operations[i++] = pendingStringTableLength;
                pendingStringTable.forEach(function(value, key) {
                  operations[i++] = key.length;
                  var encodedKey = utfEncodeString(key);
                  for (var j2 = 0; j2 < encodedKey.length; j2++) {
                    operations[i + j2] = encodedKey[j2];
                  }
                  i += key.length;
                });
                if (numUnmountIDs > 0) {
                  operations[i++] = TREE_OPERATION_REMOVE;
                  operations[i++] = numUnmountIDs;
                  for (var j = 0; j < pendingUnmountedIDs.length; j++) {
                    operations[i++] = pendingUnmountedIDs[j];
                  }
                  if (pendingUnmountedRootID !== null) {
                    operations[i] = pendingUnmountedRootID;
                    i++;
                    operations[i++] = SUSPENSE_TREE_OPERATION_REMOVE;
                    operations[i++] = 1;
                    operations[i++] = pendingUnmountedRootID;
                  }
                }
                for (var _j = 0; _j < pendingOperations.length; _j++) {
                  operations[i + _j] = pendingOperations[_j];
                }
                i += pendingOperations.length;
                if (__DEBUG__) {
                  printOperationsArray(operations);
                }
                hook.emit("operations", operations);
                pendingOperations.length = 0;
                pendingUnmountedIDs = [];
                pendingUnmountedRootID = null;
                pendingStringTable.clear();
                pendingStringTableLength = 0;
              }
              __name(flushPendingEvents, "flushPendingEvents");
              function pushOperation(op) {
                if (false) {
                }
                pendingOperations.push(op);
              }
              __name(pushOperation, "pushOperation");
              function getStringID(str) {
                if (str === null) {
                  return 0;
                }
                var existingID = pendingStringTable.get(str);
                if (existingID !== void 0) {
                  return existingID;
                }
                var stringID = pendingStringTable.size + 1;
                pendingStringTable.set(str, stringID);
                pendingStringTableLength += str.length + 1;
                return stringID;
              }
              __name(getStringID, "getStringID");
              var currentlyInspectedElementID = null;
              var currentlyInspectedPaths = {};
              function mergeInspectedPaths(path) {
                var current = currentlyInspectedPaths;
                path.forEach(function(key) {
                  if (!current[key]) {
                    current[key] = {};
                  }
                  current = current[key];
                });
              }
              __name(mergeInspectedPaths, "mergeInspectedPaths");
              function createIsPathAllowed(key) {
                return /* @__PURE__ */ __name(function isPathAllowed(path) {
                  var current = currentlyInspectedPaths[key];
                  if (!current) {
                    return false;
                  }
                  for (var i = 0; i < path.length; i++) {
                    current = current[path[i]];
                    if (!current) {
                      return false;
                    }
                  }
                  return true;
                }, "isPathAllowed");
              }
              __name(createIsPathAllowed, "createIsPathAllowed");
              function getInstanceAndStyle(id) {
                var instance = null;
                var style = null;
                var internalInstance = idToInternalInstanceMap.get(id);
                if (internalInstance != null) {
                  instance = internalInstance._instance || null;
                  var element = internalInstance._currentElement;
                  if (element != null && element.props != null) {
                    style = element.props.style || null;
                  }
                }
                return {
                  instance,
                  style
                };
              }
              __name(getInstanceAndStyle, "getInstanceAndStyle");
              function updateSelectedElement(id) {
                var internalInstance = idToInternalInstanceMap.get(id);
                if (internalInstance == null) {
                  console.warn('Could not find instance with id "'.concat(id, '"'));
                  return;
                }
                switch (getElementType(internalInstance)) {
                  case types_ElementTypeClass:
                    global.$r = internalInstance._instance;
                    break;
                  case types_ElementTypeFunction:
                    var element = internalInstance._currentElement;
                    if (element == null) {
                      console.warn('Could not find element with id "'.concat(id, '"'));
                      return;
                    }
                    global.$r = {
                      props: element.props,
                      type: element.type
                    };
                    break;
                  default:
                    global.$r = null;
                    break;
                }
              }
              __name(updateSelectedElement, "updateSelectedElement");
              function storeAsGlobal(id, path, count) {
                var inspectedElement = inspectElementRaw(id);
                if (inspectedElement !== null) {
                  var value = utils_getInObject(inspectedElement, path);
                  var key = "$reactTemp".concat(count);
                  window[key] = value;
                  console.log(key);
                  console.log(value);
                }
              }
              __name(storeAsGlobal, "storeAsGlobal");
              function getSerializedElementValueByPath(id, path) {
                var inspectedElement = inspectElementRaw(id);
                if (inspectedElement !== null) {
                  var valueToCopy = utils_getInObject(inspectedElement, path);
                  return serializeToString(valueToCopy);
                }
              }
              __name(getSerializedElementValueByPath, "getSerializedElementValueByPath");
              function inspectElement(requestID, id, path, forceFullData) {
                if (forceFullData || currentlyInspectedElementID !== id) {
                  currentlyInspectedElementID = id;
                  currentlyInspectedPaths = {};
                }
                var inspectedElement = inspectElementRaw(id);
                if (inspectedElement === null) {
                  return {
                    id,
                    responseID: requestID,
                    type: "not-found"
                  };
                }
                if (path !== null) {
                  mergeInspectedPaths(path);
                }
                updateSelectedElement(id);
                inspectedElement.context = cleanForBridge(inspectedElement.context, createIsPathAllowed("context"));
                inspectedElement.props = cleanForBridge(inspectedElement.props, createIsPathAllowed("props"));
                inspectedElement.state = cleanForBridge(inspectedElement.state, createIsPathAllowed("state"));
                inspectedElement.suspendedBy = cleanForBridge(inspectedElement.suspendedBy, createIsPathAllowed("suspendedBy"));
                return {
                  id,
                  responseID: requestID,
                  type: "full-data",
                  value: inspectedElement
                };
              }
              __name(inspectElement, "inspectElement");
              function inspectElementRaw(id) {
                var internalInstance = idToInternalInstanceMap.get(id);
                if (internalInstance == null) {
                  return null;
                }
                var rootID = internalInstanceToRootIDMap.get(internalInstance);
                if (rootID === void 0) {
                  throw new Error("Expected to find root ID.");
                }
                var isRoot = rootID === id;
                return isRoot ? inspectRootsRaw(rootID) : inspectInternalInstanceRaw(id, internalInstance);
              }
              __name(inspectElementRaw, "inspectElementRaw");
              function inspectInternalInstanceRaw(id, internalInstance) {
                var _getData2 = getData(internalInstance), key = _getData2.key;
                var type = getElementType(internalInstance);
                var context = null;
                var owners = null;
                var props = null;
                var state = null;
                var element = internalInstance._currentElement;
                if (element !== null) {
                  props = element.props;
                  var owner = element._owner;
                  if (owner) {
                    owners = [];
                    while (owner != null) {
                      owners.push({
                        displayName: getData(owner).displayName || "Unknown",
                        id: getID(owner),
                        key: element.key,
                        env: null,
                        stack: null,
                        type: getElementType(owner)
                      });
                      if (owner._currentElement) {
                        owner = owner._currentElement._owner;
                      }
                    }
                  }
                }
                var publicInstance = internalInstance._instance;
                if (publicInstance != null) {
                  context = publicInstance.context || null;
                  state = publicInstance.state || null;
                }
                var errors = [];
                var warnings = [];
                return {
                  id,
                  canEditHooks: false,
                  canEditFunctionProps: false,
                  canEditHooksAndDeletePaths: false,
                  canEditHooksAndRenamePaths: false,
                  canEditFunctionPropsDeletePaths: false,
                  canEditFunctionPropsRenamePaths: false,
                  canToggleError: false,
                  isErrored: false,
                  canToggleSuspense: false,
                  isSuspended: null,
                  source: null,
                  stack: null,
                  hasLegacyContext: true,
                  type,
                  key: key != null ? key : null,
                  context,
                  hooks: null,
                  props,
                  state,
                  errors,
                  warnings,
                  suspendedBy: [],
                  suspendedByRange: null,
                  unknownSuspenders: UNKNOWN_SUSPENDERS_NONE,
                  owners,
                  env: null,
                  rootType: null,
                  rendererPackageName: null,
                  rendererVersion: null,
                  plugins: {
                    stylex: null
                  },
                  nativeTag: null
                };
              }
              __name(inspectInternalInstanceRaw, "inspectInternalInstanceRaw");
              function inspectRootsRaw(arbitraryRootID) {
                var roots = renderer.Mount._instancesByReactRootID || renderer.Mount._instancesByContainerID;
                var inspectedRoots = {
                  id: arbitraryRootID,
                  type: ElementTypeRoot,
                  isErrored: false,
                  errors: [],
                  warnings: [],
                  suspendedBy: [],
                  suspendedByRange: null,
                  unknownSuspenders: UNKNOWN_SUSPENDERS_NONE,
                  rootType: null,
                  plugins: {
                    stylex: null
                  },
                  nativeTag: null,
                  env: null,
                  source: null,
                  stack: null,
                  rendererPackageName: null,
                  rendererVersion: null,
                  key: null,
                  canEditFunctionProps: false,
                  canEditHooks: false,
                  canEditFunctionPropsDeletePaths: false,
                  canEditFunctionPropsRenamePaths: false,
                  canEditHooksAndDeletePaths: false,
                  canEditHooksAndRenamePaths: false,
                  canToggleError: false,
                  canToggleSuspense: false,
                  isSuspended: false,
                  hasLegacyContext: false,
                  context: null,
                  hooks: null,
                  props: null,
                  state: null,
                  owners: null
                };
                var minSuspendedByRange = Infinity;
                var maxSuspendedByRange = -Infinity;
                for (var rootKey in roots) {
                  var internalInstance = roots[rootKey];
                  var _id3 = getID(internalInstance);
                  var inspectedRoot = inspectInternalInstanceRaw(_id3, internalInstance);
                  if (inspectedRoot === null) {
                    return null;
                  }
                  if (inspectedRoot.isErrored) {
                    inspectedRoots.isErrored = true;
                  }
                  for (var i = 0; i < inspectedRoot.errors.length; i++) {
                    inspectedRoots.errors.push(inspectedRoot.errors[i]);
                  }
                  for (var _i = 0; _i < inspectedRoot.warnings.length; _i++) {
                    inspectedRoots.warnings.push(inspectedRoot.warnings[_i]);
                  }
                  for (var _i2 = 0; _i2 < inspectedRoot.suspendedBy.length; _i2++) {
                    inspectedRoots.suspendedBy.push(inspectedRoot.suspendedBy[_i2]);
                  }
                  var suspendedByRange = inspectedRoot.suspendedByRange;
                  if (suspendedByRange !== null) {
                    if (suspendedByRange[0] < minSuspendedByRange) {
                      minSuspendedByRange = suspendedByRange[0];
                    }
                    if (suspendedByRange[1] > maxSuspendedByRange) {
                      maxSuspendedByRange = suspendedByRange[1];
                    }
                  }
                }
                if (minSuspendedByRange !== Infinity || maxSuspendedByRange !== -Infinity) {
                  inspectedRoots.suspendedByRange = [minSuspendedByRange, maxSuspendedByRange];
                }
                return inspectedRoots;
              }
              __name(inspectRootsRaw, "inspectRootsRaw");
              function logElementToConsole(id) {
                var result = inspectElementRaw(id);
                if (result === null) {
                  console.warn('Could not find element with id "'.concat(id, '"'));
                  return;
                }
                var displayName = getDisplayNameForElementID(id);
                var supportsGroup = typeof console.groupCollapsed === "function";
                if (supportsGroup) {
                  console.groupCollapsed("[Click to expand] %c<".concat(displayName || "Component", " />"), "color: var(--dom-tag-name-color); font-weight: normal;");
                }
                if (result.props !== null) {
                  console.log("Props:", result.props);
                }
                if (result.state !== null) {
                  console.log("State:", result.state);
                }
                if (result.context !== null) {
                  console.log("Context:", result.context);
                }
                var hostInstance = findHostInstanceForInternalID(id);
                if (hostInstance !== null) {
                  console.log("Node:", hostInstance);
                }
                if (window.chrome || /firefox/i.test(navigator.userAgent)) {
                  console.log("Right-click any value to save it as a global variable for further inspection.");
                }
                if (supportsGroup) {
                  console.groupEnd();
                }
              }
              __name(logElementToConsole, "logElementToConsole");
              function getElementAttributeByPath(id, path) {
                var inspectedElement = inspectElementRaw(id);
                if (inspectedElement !== null) {
                  return utils_getInObject(inspectedElement, path);
                }
                return void 0;
              }
              __name(getElementAttributeByPath, "getElementAttributeByPath");
              function getElementSourceFunctionById(id) {
                var internalInstance = idToInternalInstanceMap.get(id);
                if (internalInstance == null) {
                  console.warn('Could not find instance with id "'.concat(id, '"'));
                  return null;
                }
                var element = internalInstance._currentElement;
                if (element == null) {
                  console.warn('Could not find element with id "'.concat(id, '"'));
                  return null;
                }
                return element.type;
              }
              __name(getElementSourceFunctionById, "getElementSourceFunctionById");
              function deletePath(type, id, hookID, path) {
                var internalInstance = idToInternalInstanceMap.get(id);
                if (internalInstance != null) {
                  var publicInstance = internalInstance._instance;
                  if (publicInstance != null) {
                    switch (type) {
                      case "context":
                        deletePathInObject(publicInstance.context, path);
                        forceUpdate(publicInstance);
                        break;
                      case "hooks":
                        throw new Error("Hooks not supported by this renderer");
                      case "props":
                        var element = internalInstance._currentElement;
                        internalInstance._currentElement = legacy_renderer_objectSpread(legacy_renderer_objectSpread({}, element), {}, {
                          props: copyWithDelete(element.props, path)
                        });
                        forceUpdate(publicInstance);
                        break;
                      case "state":
                        deletePathInObject(publicInstance.state, path);
                        forceUpdate(publicInstance);
                        break;
                    }
                  }
                }
              }
              __name(deletePath, "deletePath");
              function renamePath(type, id, hookID, oldPath, newPath) {
                var internalInstance = idToInternalInstanceMap.get(id);
                if (internalInstance != null) {
                  var publicInstance = internalInstance._instance;
                  if (publicInstance != null) {
                    switch (type) {
                      case "context":
                        renamePathInObject(publicInstance.context, oldPath, newPath);
                        forceUpdate(publicInstance);
                        break;
                      case "hooks":
                        throw new Error("Hooks not supported by this renderer");
                      case "props":
                        var element = internalInstance._currentElement;
                        internalInstance._currentElement = legacy_renderer_objectSpread(legacy_renderer_objectSpread({}, element), {}, {
                          props: copyWithRename(element.props, oldPath, newPath)
                        });
                        forceUpdate(publicInstance);
                        break;
                      case "state":
                        renamePathInObject(publicInstance.state, oldPath, newPath);
                        forceUpdate(publicInstance);
                        break;
                    }
                  }
                }
              }
              __name(renamePath, "renamePath");
              function overrideValueAtPath(type, id, hookID, path, value) {
                var internalInstance = idToInternalInstanceMap.get(id);
                if (internalInstance != null) {
                  var publicInstance = internalInstance._instance;
                  if (publicInstance != null) {
                    switch (type) {
                      case "context":
                        utils_setInObject(publicInstance.context, path, value);
                        forceUpdate(publicInstance);
                        break;
                      case "hooks":
                        throw new Error("Hooks not supported by this renderer");
                      case "props":
                        var element = internalInstance._currentElement;
                        internalInstance._currentElement = legacy_renderer_objectSpread(legacy_renderer_objectSpread({}, element), {}, {
                          props: copyWithSet(element.props, path, value)
                        });
                        forceUpdate(publicInstance);
                        break;
                      case "state":
                        utils_setInObject(publicInstance.state, path, value);
                        forceUpdate(publicInstance);
                        break;
                    }
                  }
                }
              }
              __name(overrideValueAtPath, "overrideValueAtPath");
              var getProfilingData = /* @__PURE__ */ __name(function getProfilingData2() {
                throw new Error("getProfilingData not supported by this renderer");
              }, "getProfilingData");
              var handleCommitFiberRoot = /* @__PURE__ */ __name(function handleCommitFiberRoot2() {
                throw new Error("handleCommitFiberRoot not supported by this renderer");
              }, "handleCommitFiberRoot");
              var handleCommitFiberUnmount = /* @__PURE__ */ __name(function handleCommitFiberUnmount2() {
                throw new Error("handleCommitFiberUnmount not supported by this renderer");
              }, "handleCommitFiberUnmount");
              var handlePostCommitFiberRoot = /* @__PURE__ */ __name(function handlePostCommitFiberRoot2() {
                throw new Error("handlePostCommitFiberRoot not supported by this renderer");
              }, "handlePostCommitFiberRoot");
              var overrideError = /* @__PURE__ */ __name(function overrideError2() {
                throw new Error("overrideError not supported by this renderer");
              }, "overrideError");
              var overrideSuspense = /* @__PURE__ */ __name(function overrideSuspense2() {
                throw new Error("overrideSuspense not supported by this renderer");
              }, "overrideSuspense");
              var overrideSuspenseMilestone = /* @__PURE__ */ __name(function overrideSuspenseMilestone2() {
                throw new Error("overrideSuspenseMilestone not supported by this renderer");
              }, "overrideSuspenseMilestone");
              var startProfiling = /* @__PURE__ */ __name(function startProfiling2() {
              }, "startProfiling");
              var stopProfiling = /* @__PURE__ */ __name(function stopProfiling2() {
              }, "stopProfiling");
              function getBestMatchForTrackedPath() {
                return null;
              }
              __name(getBestMatchForTrackedPath, "getBestMatchForTrackedPath");
              function getPathForElement(id) {
                return null;
              }
              __name(getPathForElement, "getPathForElement");
              function updateComponentFilters(componentFilters) {
              }
              __name(updateComponentFilters, "updateComponentFilters");
              function getEnvironmentNames() {
                return [];
              }
              __name(getEnvironmentNames, "getEnvironmentNames");
              function setTraceUpdatesEnabled(enabled) {
              }
              __name(setTraceUpdatesEnabled, "setTraceUpdatesEnabled");
              function setTrackedPath(path) {
              }
              __name(setTrackedPath, "setTrackedPath");
              function getOwnersList(id) {
                return null;
              }
              __name(getOwnersList, "getOwnersList");
              function clearErrorsAndWarnings() {
              }
              __name(clearErrorsAndWarnings, "clearErrorsAndWarnings");
              function clearErrorsForElementID(id) {
              }
              __name(clearErrorsForElementID, "clearErrorsForElementID");
              function clearWarningsForElementID(id) {
              }
              __name(clearWarningsForElementID, "clearWarningsForElementID");
              function hasElementWithId(id) {
                return idToInternalInstanceMap.has(id);
              }
              __name(hasElementWithId, "hasElementWithId");
              return {
                clearErrorsAndWarnings,
                clearErrorsForElementID,
                clearWarningsForElementID,
                cleanup,
                getSerializedElementValueByPath,
                deletePath,
                flushInitialOperations,
                getBestMatchForTrackedPath,
                getDisplayNameForElementID,
                getNearestMountedDOMNode,
                getElementIDForHostInstance,
                getSuspenseNodeIDForHostInstance: /* @__PURE__ */ __name(function getSuspenseNodeIDForHostInstance(id) {
                  return null;
                }, "getSuspenseNodeIDForHostInstance"),
                getInstanceAndStyle,
                findHostInstancesForElementID: /* @__PURE__ */ __name(function findHostInstancesForElementID(id) {
                  var hostInstance = findHostInstanceForInternalID(id);
                  return hostInstance == null ? null : [hostInstance];
                }, "findHostInstancesForElementID"),
                findLastKnownRectsForID: /* @__PURE__ */ __name(function findLastKnownRectsForID() {
                  return null;
                }, "findLastKnownRectsForID"),
                getOwnersList,
                getPathForElement,
                getProfilingData,
                handleCommitFiberRoot,
                handleCommitFiberUnmount,
                handlePostCommitFiberRoot,
                hasElementWithId,
                inspectElement,
                logElementToConsole,
                overrideError,
                overrideSuspense,
                overrideSuspenseMilestone,
                overrideValueAtPath,
                renamePath,
                getElementAttributeByPath,
                getElementSourceFunctionById,
                renderer,
                setTraceUpdatesEnabled,
                setTrackedPath,
                startProfiling,
                stopProfiling,
                storeAsGlobal,
                supportsTogglingSuspense,
                updateComponentFilters,
                getEnvironmentNames
              };
            }
            __name(legacy_renderer_attach, "legacy_renderer_attach");
            ;
            function isMatchingRender(version) {
              return !hasAssignedBackend(version);
            }
            __name(isMatchingRender, "isMatchingRender");
            function attachRenderer(hook, id, renderer, global, shouldStartProfilingNow, profilingSettings) {
              if (!isMatchingRender(renderer.reconcilerVersion || renderer.version)) {
                return;
              }
              var rendererInterface = hook.rendererInterfaces.get(id);
              if (rendererInterface == null) {
                if (typeof renderer.getCurrentComponentInfo === "function") {
                  rendererInterface = attach(hook, id, renderer, global);
                } else if (typeof renderer.findFiberByHostInstance === "function" || renderer.currentDispatcherRef != null) {
                  rendererInterface = renderer_attach(hook, id, renderer, global, shouldStartProfilingNow, profilingSettings);
                } else if (renderer.ComponentTree) {
                  rendererInterface = legacy_renderer_attach(hook, id, renderer, global);
                } else {
                }
              }
              return rendererInterface;
            }
            __name(attachRenderer, "attachRenderer");
            ;
            function formatConsoleArguments_toConsumableArray(arr) {
              return formatConsoleArguments_arrayWithoutHoles(arr) || formatConsoleArguments_iterableToArray(arr) || formatConsoleArguments_unsupportedIterableToArray(arr) || formatConsoleArguments_nonIterableSpread();
            }
            __name(formatConsoleArguments_toConsumableArray, "formatConsoleArguments_toConsumableArray");
            function formatConsoleArguments_nonIterableSpread() {
              throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
            }
            __name(formatConsoleArguments_nonIterableSpread, "formatConsoleArguments_nonIterableSpread");
            function formatConsoleArguments_iterableToArray(iter) {
              if (typeof Symbol !== "undefined" && iter[Symbol.iterator] != null || iter["@@iterator"] != null) return Array.from(iter);
            }
            __name(formatConsoleArguments_iterableToArray, "formatConsoleArguments_iterableToArray");
            function formatConsoleArguments_arrayWithoutHoles(arr) {
              if (Array.isArray(arr)) return formatConsoleArguments_arrayLikeToArray(arr);
            }
            __name(formatConsoleArguments_arrayWithoutHoles, "formatConsoleArguments_arrayWithoutHoles");
            function formatConsoleArguments_slicedToArray(arr, i) {
              return formatConsoleArguments_arrayWithHoles(arr) || formatConsoleArguments_iterableToArrayLimit(arr, i) || formatConsoleArguments_unsupportedIterableToArray(arr, i) || formatConsoleArguments_nonIterableRest();
            }
            __name(formatConsoleArguments_slicedToArray, "formatConsoleArguments_slicedToArray");
            function formatConsoleArguments_nonIterableRest() {
              throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
            }
            __name(formatConsoleArguments_nonIterableRest, "formatConsoleArguments_nonIterableRest");
            function formatConsoleArguments_unsupportedIterableToArray(o, minLen) {
              if (!o) return;
              if (typeof o === "string") return formatConsoleArguments_arrayLikeToArray(o, minLen);
              var n = Object.prototype.toString.call(o).slice(8, -1);
              if (n === "Object" && o.constructor) n = o.constructor.name;
              if (n === "Map" || n === "Set") return Array.from(o);
              if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return formatConsoleArguments_arrayLikeToArray(o, minLen);
            }
            __name(formatConsoleArguments_unsupportedIterableToArray, "formatConsoleArguments_unsupportedIterableToArray");
            function formatConsoleArguments_arrayLikeToArray(arr, len) {
              if (len == null || len > arr.length) len = arr.length;
              for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i];
              return arr2;
            }
            __name(formatConsoleArguments_arrayLikeToArray, "formatConsoleArguments_arrayLikeToArray");
            function formatConsoleArguments_iterableToArrayLimit(r, l) {
              var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"];
              if (null != t) {
                var e, n, i, u, a = [], f = true, o = false;
                try {
                  if (i = (t = t.call(r)).next, 0 === l) {
                    if (Object(t) !== t) return;
                    f = false;
                  } else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = true) ;
                } catch (r2) {
                  o = true, n = r2;
                } finally {
                  try {
                    if (!f && null != t.return && (u = t.return(), Object(u) !== u)) return;
                  } finally {
                    if (o) throw n;
                  }
                }
                return a;
              }
            }
            __name(formatConsoleArguments_iterableToArrayLimit, "formatConsoleArguments_iterableToArrayLimit");
            function formatConsoleArguments_arrayWithHoles(arr) {
              if (Array.isArray(arr)) return arr;
            }
            __name(formatConsoleArguments_arrayWithHoles, "formatConsoleArguments_arrayWithHoles");
            function formatConsoleArguments(maybeMessage) {
              for (var _len = arguments.length, inputArgs = new Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
                inputArgs[_key - 1] = arguments[_key];
              }
              if (inputArgs.length === 0 || typeof maybeMessage !== "string") {
                return [maybeMessage].concat(inputArgs);
              }
              var args = inputArgs.slice();
              var template = "";
              var argumentsPointer = 0;
              for (var i = 0; i < maybeMessage.length; ++i) {
                var currentChar = maybeMessage[i];
                if (currentChar !== "%") {
                  template += currentChar;
                  continue;
                }
                var nextChar = maybeMessage[i + 1];
                ++i;
                switch (nextChar) {
                  case "c":
                  case "O":
                  case "o": {
                    ++argumentsPointer;
                    template += "%".concat(nextChar);
                    break;
                  }
                  case "d":
                  case "i": {
                    var _args$splice = args.splice(argumentsPointer, 1), _args$splice2 = formatConsoleArguments_slicedToArray(_args$splice, 1), arg = _args$splice2[0];
                    template += parseInt(arg, 10).toString();
                    break;
                  }
                  case "f": {
                    var _args$splice3 = args.splice(argumentsPointer, 1), _args$splice4 = formatConsoleArguments_slicedToArray(_args$splice3, 1), _arg = _args$splice4[0];
                    template += parseFloat(_arg).toString();
                    break;
                  }
                  case "s": {
                    var _args$splice5 = args.splice(argumentsPointer, 1), _args$splice6 = formatConsoleArguments_slicedToArray(_args$splice5, 1), _arg2 = _args$splice6[0];
                    template += String(_arg2);
                    break;
                  }
                  default:
                    template += "%".concat(nextChar);
                }
              }
              return [template].concat(formatConsoleArguments_toConsumableArray(args));
            }
            __name(formatConsoleArguments, "formatConsoleArguments");
            ;
            function hook_createForOfIteratorHelper(o, allowArrayLike) {
              var it = typeof Symbol !== "undefined" && o[Symbol.iterator] || o["@@iterator"];
              if (!it) {
                if (Array.isArray(o) || (it = hook_unsupportedIterableToArray(o)) || allowArrayLike && o && typeof o.length === "number") {
                  if (it) o = it;
                  var i = 0;
                  var F = /* @__PURE__ */ __name(function F2() {
                  }, "F");
                  return { s: F, n: /* @__PURE__ */ __name(function n() {
                    if (i >= o.length) return { done: true };
                    return { done: false, value: o[i++] };
                  }, "n"), e: /* @__PURE__ */ __name(function e(_e) {
                    throw _e;
                  }, "e"), f: F };
                }
                throw new TypeError("Invalid attempt to iterate non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
              }
              var normalCompletion = true, didErr = false, err;
              return { s: /* @__PURE__ */ __name(function s() {
                it = it.call(o);
              }, "s"), n: /* @__PURE__ */ __name(function n() {
                var step = it.next();
                normalCompletion = step.done;
                return step;
              }, "n"), e: /* @__PURE__ */ __name(function e(_e2) {
                didErr = true;
                err = _e2;
              }, "e"), f: /* @__PURE__ */ __name(function f() {
                try {
                  if (!normalCompletion && it.return != null) it.return();
                } finally {
                  if (didErr) throw err;
                }
              }, "f") };
            }
            __name(hook_createForOfIteratorHelper, "hook_createForOfIteratorHelper");
            function hook_toConsumableArray(arr) {
              return hook_arrayWithoutHoles(arr) || hook_iterableToArray(arr) || hook_unsupportedIterableToArray(arr) || hook_nonIterableSpread();
            }
            __name(hook_toConsumableArray, "hook_toConsumableArray");
            function hook_nonIterableSpread() {
              throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
            }
            __name(hook_nonIterableSpread, "hook_nonIterableSpread");
            function hook_unsupportedIterableToArray(o, minLen) {
              if (!o) return;
              if (typeof o === "string") return hook_arrayLikeToArray(o, minLen);
              var n = Object.prototype.toString.call(o).slice(8, -1);
              if (n === "Object" && o.constructor) n = o.constructor.name;
              if (n === "Map" || n === "Set") return Array.from(o);
              if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return hook_arrayLikeToArray(o, minLen);
            }
            __name(hook_unsupportedIterableToArray, "hook_unsupportedIterableToArray");
            function hook_iterableToArray(iter) {
              if (typeof Symbol !== "undefined" && iter[Symbol.iterator] != null || iter["@@iterator"] != null) return Array.from(iter);
            }
            __name(hook_iterableToArray, "hook_iterableToArray");
            function hook_arrayWithoutHoles(arr) {
              if (Array.isArray(arr)) return hook_arrayLikeToArray(arr);
            }
            __name(hook_arrayWithoutHoles, "hook_arrayWithoutHoles");
            function hook_arrayLikeToArray(arr, len) {
              if (len == null || len > arr.length) len = arr.length;
              for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i];
              return arr2;
            }
            __name(hook_arrayLikeToArray, "hook_arrayLikeToArray");
            var PREFIX_REGEX = /\s{4}(in|at)\s{1}/;
            var ROW_COLUMN_NUMBER_REGEX = /:\d+:\d+(\n|$)/;
            function isStringComponentStack(text) {
              return PREFIX_REGEX.test(text) || ROW_COLUMN_NUMBER_REGEX.test(text);
            }
            __name(isStringComponentStack, "isStringComponentStack");
            var frameDiffs = / \(\<anonymous\>\)$|\@unknown\:0\:0$|\(|\)|\[|\]/gm;
            function areStackTracesEqual(a, b) {
              return a.replace(frameDiffs, "") === b.replace(frameDiffs, "");
            }
            __name(areStackTracesEqual, "areStackTracesEqual");
            var targetConsole = console;
            var defaultProfilingSettings = {
              recordChangeDescriptions: false,
              recordTimeline: false
            };
            function installHook(target, maybeSettingsOrSettingsPromise) {
              var shouldStartProfilingNow = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : false;
              var profilingSettings = arguments.length > 3 && arguments[3] !== void 0 ? arguments[3] : defaultProfilingSettings;
              if (target.hasOwnProperty("__REACT_DEVTOOLS_GLOBAL_HOOK__")) {
                return null;
              }
              function detectReactBuildType(renderer) {
                try {
                  if (typeof renderer.version === "string") {
                    if (renderer.bundleType > 0) {
                      return "development";
                    }
                    return "production";
                  }
                  var _toString = Function.prototype.toString;
                  if (renderer.Mount && renderer.Mount._renderNewRootComponent) {
                    var renderRootCode = _toString.call(renderer.Mount._renderNewRootComponent);
                    if (renderRootCode.indexOf("function") !== 0) {
                      return "production";
                    }
                    if (renderRootCode.indexOf("storedMeasure") !== -1) {
                      return "development";
                    }
                    if (renderRootCode.indexOf("should be a pure function") !== -1) {
                      if (renderRootCode.indexOf("NODE_ENV") !== -1) {
                        return "development";
                      }
                      if (renderRootCode.indexOf("development") !== -1) {
                        return "development";
                      }
                      if (renderRootCode.indexOf("true") !== -1) {
                        return "development";
                      }
                      if (renderRootCode.indexOf("nextElement") !== -1 || renderRootCode.indexOf("nextComponent") !== -1) {
                        return "unminified";
                      } else {
                        return "development";
                      }
                    }
                    if (renderRootCode.indexOf("nextElement") !== -1 || renderRootCode.indexOf("nextComponent") !== -1) {
                      return "unminified";
                    }
                    return "outdated";
                  }
                } catch (err) {
                }
                return "production";
              }
              __name(detectReactBuildType, "detectReactBuildType");
              function checkDCE(fn) {
                try {
                  var _toString2 = Function.prototype.toString;
                  var code = _toString2.call(fn);
                  if (code.indexOf("^_^") > -1) {
                    hasDetectedBadDCE = true;
                    setTimeout(function() {
                      throw new Error("React is running in production mode, but dead code elimination has not been applied. Read how to correctly configure React for production: https://react.dev/link/perf-use-production-build");
                    });
                  }
                } catch (err) {
                }
              }
              __name(checkDCE, "checkDCE");
              var isProfiling = shouldStartProfilingNow;
              var uidCounter2 = 0;
              function inject(renderer) {
                var id = ++uidCounter2;
                renderers.set(id, renderer);
                var reactBuildType = hasDetectedBadDCE ? "deadcode" : detectReactBuildType(renderer);
                hook.emit("renderer", {
                  id,
                  renderer,
                  reactBuildType
                });
                var rendererInterface = attachRenderer(hook, id, renderer, target, isProfiling, profilingSettings);
                if (rendererInterface != null) {
                  hook.rendererInterfaces.set(id, rendererInterface);
                  hook.emit("renderer-attached", {
                    id,
                    rendererInterface
                  });
                } else {
                  hook.hasUnsupportedRendererAttached = true;
                  hook.emit("unsupported-renderer-version");
                }
                return id;
              }
              __name(inject, "inject");
              var hasDetectedBadDCE = false;
              function sub(event, fn) {
                hook.on(event, fn);
                return function() {
                  return hook.off(event, fn);
                };
              }
              __name(sub, "sub");
              function on(event, fn) {
                if (!listeners[event]) {
                  listeners[event] = [];
                }
                listeners[event].push(fn);
              }
              __name(on, "on");
              function off(event, fn) {
                if (!listeners[event]) {
                  return;
                }
                var index = listeners[event].indexOf(fn);
                if (index !== -1) {
                  listeners[event].splice(index, 1);
                }
                if (!listeners[event].length) {
                  delete listeners[event];
                }
              }
              __name(off, "off");
              function emit(event, data) {
                if (listeners[event]) {
                  listeners[event].map(function(fn) {
                    return fn(data);
                  });
                }
              }
              __name(emit, "emit");
              function getFiberRoots(rendererID) {
                var roots = fiberRoots;
                if (!roots[rendererID]) {
                  roots[rendererID] = /* @__PURE__ */ new Set();
                }
                return roots[rendererID];
              }
              __name(getFiberRoots, "getFiberRoots");
              function onCommitFiberUnmount(rendererID, fiber) {
                var rendererInterface = rendererInterfaces.get(rendererID);
                if (rendererInterface != null) {
                  rendererInterface.handleCommitFiberUnmount(fiber);
                }
              }
              __name(onCommitFiberUnmount, "onCommitFiberUnmount");
              function onCommitFiberRoot(rendererID, root, priorityLevel) {
                var mountedRoots = hook.getFiberRoots(rendererID);
                var current = root.current;
                var isKnownRoot = mountedRoots.has(root);
                var isUnmounting = current.memoizedState == null || current.memoizedState.element == null;
                if (!isKnownRoot && !isUnmounting) {
                  mountedRoots.add(root);
                } else if (isKnownRoot && isUnmounting) {
                  mountedRoots.delete(root);
                }
                var rendererInterface = rendererInterfaces.get(rendererID);
                if (rendererInterface != null) {
                  rendererInterface.handleCommitFiberRoot(root, priorityLevel);
                }
              }
              __name(onCommitFiberRoot, "onCommitFiberRoot");
              function onPostCommitFiberRoot(rendererID, root) {
                var rendererInterface = rendererInterfaces.get(rendererID);
                if (rendererInterface != null) {
                  rendererInterface.handlePostCommitFiberRoot(root);
                }
              }
              __name(onPostCommitFiberRoot, "onPostCommitFiberRoot");
              var isRunningDuringStrictModeInvocation = false;
              function setStrictMode(rendererID, isStrictMode) {
                isRunningDuringStrictModeInvocation = isStrictMode;
                if (isStrictMode) {
                  patchConsoleForStrictMode();
                } else {
                  unpatchConsoleForStrictMode();
                }
              }
              __name(setStrictMode, "setStrictMode");
              var unpatchConsoleCallbacks = [];
              function patchConsoleForStrictMode() {
                if (!hook.settings) {
                  return;
                }
                if (unpatchConsoleCallbacks.length > 0) {
                  return;
                }
                var consoleMethodsToOverrideForStrictMode = ["group", "groupCollapsed", "info", "log"];
                var _loop = /* @__PURE__ */ __name(function _loop2() {
                  var method = _consoleMethodsToOver[_i];
                  var originalMethod = targetConsole[method];
                  var overrideMethod = /* @__PURE__ */ __name(function overrideMethod2() {
                    var settings = hook.settings;
                    for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
                      args[_key] = arguments[_key];
                    }
                    if (settings == null) {
                      originalMethod.apply(void 0, args);
                      return;
                    }
                    if (settings.hideConsoleLogsInStrictMode) {
                      return;
                    }
                    if (false) {
                    } else {
                      originalMethod.apply(void 0, [ANSI_STYLE_DIMMING_TEMPLATE].concat(hook_toConsumableArray(formatConsoleArguments.apply(void 0, args))));
                    }
                  }, "overrideMethod");
                  targetConsole[method] = overrideMethod;
                  unpatchConsoleCallbacks.push(function() {
                    targetConsole[method] = originalMethod;
                  });
                }, "_loop");
                for (var _i = 0, _consoleMethodsToOver = consoleMethodsToOverrideForStrictMode; _i < _consoleMethodsToOver.length; _i++) {
                  _loop();
                }
              }
              __name(patchConsoleForStrictMode, "patchConsoleForStrictMode");
              function unpatchConsoleForStrictMode() {
                unpatchConsoleCallbacks.forEach(function(callback) {
                  return callback();
                });
                unpatchConsoleCallbacks.length = 0;
              }
              __name(unpatchConsoleForStrictMode, "unpatchConsoleForStrictMode");
              var openModuleRangesStack = [];
              var moduleRanges = [];
              function getTopStackFrameString(error) {
                var frames = error.stack.split("\n");
                var frame = frames.length > 1 ? frames[1] : null;
                return frame;
              }
              __name(getTopStackFrameString, "getTopStackFrameString");
              function getInternalModuleRanges() {
                return moduleRanges;
              }
              __name(getInternalModuleRanges, "getInternalModuleRanges");
              function registerInternalModuleStart(error) {
                var startStackFrame = getTopStackFrameString(error);
                if (startStackFrame !== null) {
                  openModuleRangesStack.push(startStackFrame);
                }
              }
              __name(registerInternalModuleStart, "registerInternalModuleStart");
              function registerInternalModuleStop(error) {
                if (openModuleRangesStack.length > 0) {
                  var startStackFrame = openModuleRangesStack.pop();
                  var stopStackFrame = getTopStackFrameString(error);
                  if (stopStackFrame !== null) {
                    moduleRanges.push([startStackFrame, stopStackFrame]);
                  }
                }
              }
              __name(registerInternalModuleStop, "registerInternalModuleStop");
              function patchConsoleForErrorsAndWarnings() {
                if (!hook.settings) {
                  return;
                }
                var consoleMethodsToOverrideForErrorsAndWarnings = ["error", "trace", "warn"];
                var _loop2 = /* @__PURE__ */ __name(function _loop22() {
                  var method = _consoleMethodsToOver2[_i2];
                  var originalMethod = targetConsole[method];
                  var overrideMethod = /* @__PURE__ */ __name(function overrideMethod2() {
                    var settings = hook.settings;
                    for (var _len2 = arguments.length, args = new Array(_len2), _key2 = 0; _key2 < _len2; _key2++) {
                      args[_key2] = arguments[_key2];
                    }
                    if (settings == null) {
                      originalMethod.apply(void 0, args);
                      return;
                    }
                    if (isRunningDuringStrictModeInvocation && settings.hideConsoleLogsInStrictMode) {
                      return;
                    }
                    var injectedComponentStackAsFakeError = false;
                    var alreadyHasComponentStack = false;
                    if (settings.appendComponentStack) {
                      var lastArg = args.length > 0 ? args[args.length - 1] : null;
                      alreadyHasComponentStack = typeof lastArg === "string" && isStringComponentStack(lastArg);
                    }
                    var shouldShowInlineWarningsAndErrors = settings.showInlineWarningsAndErrors && (method === "error" || method === "warn");
                    var _iterator = hook_createForOfIteratorHelper(hook.rendererInterfaces.values()), _step;
                    try {
                      var _loop3 = /* @__PURE__ */ __name(function _loop32() {
                        var rendererInterface = _step.value;
                        var onErrorOrWarning = rendererInterface.onErrorOrWarning, getComponentStack = rendererInterface.getComponentStack;
                        try {
                          if (shouldShowInlineWarningsAndErrors) {
                            if (onErrorOrWarning != null) {
                              onErrorOrWarning(method, args.slice());
                            }
                          }
                        } catch (error) {
                          setTimeout(function() {
                            throw error;
                          }, 0);
                        }
                        try {
                          if (settings.appendComponentStack && getComponentStack != null) {
                            var topFrame = Error("react-stack-top-frame");
                            var match = getComponentStack(topFrame);
                            if (match !== null) {
                              var enableOwnerStacks = match.enableOwnerStacks, componentStack = match.componentStack;
                              if (componentStack !== "") {
                                var fakeError = new Error("");
                                if (false) {
                                } else {
                                  fakeError.name = enableOwnerStacks ? "Stack" : "Component Stack";
                                }
                                fakeError.stack = true ? (enableOwnerStacks ? "Error Stack:" : "Error Component Stack:") + componentStack : 0;
                                if (alreadyHasComponentStack) {
                                  if (areStackTracesEqual(args[args.length - 1], componentStack)) {
                                    var firstArg = args[0];
                                    if (args.length > 1 && typeof firstArg === "string" && firstArg.endsWith("%s")) {
                                      args[0] = firstArg.slice(0, firstArg.length - 2);
                                    }
                                    args[args.length - 1] = fakeError;
                                    injectedComponentStackAsFakeError = true;
                                  }
                                } else {
                                  args.push(fakeError);
                                  injectedComponentStackAsFakeError = true;
                                }
                              }
                              return 1;
                            }
                          }
                        } catch (error) {
                          setTimeout(function() {
                            throw error;
                          }, 0);
                        }
                      }, "_loop3");
                      for (_iterator.s(); !(_step = _iterator.n()).done; ) {
                        if (_loop3()) break;
                      }
                    } catch (err) {
                      _iterator.e(err);
                    } finally {
                      _iterator.f();
                    }
                    if (settings.breakOnConsoleErrors) {
                      debugger;
                    }
                    if (isRunningDuringStrictModeInvocation) {
                      if (false) {
                        var argsWithCSSStyles;
                      } else {
                        originalMethod.apply(void 0, [injectedComponentStackAsFakeError ? ANSI_STYLE_DIMMING_TEMPLATE_WITH_COMPONENT_STACK : ANSI_STYLE_DIMMING_TEMPLATE].concat(hook_toConsumableArray(formatConsoleArguments.apply(void 0, args))));
                      }
                    } else {
                      originalMethod.apply(void 0, args);
                    }
                  }, "overrideMethod");
                  targetConsole[method] = overrideMethod;
                }, "_loop2");
                for (var _i2 = 0, _consoleMethodsToOver2 = consoleMethodsToOverrideForErrorsAndWarnings; _i2 < _consoleMethodsToOver2.length; _i2++) {
                  _loop2();
                }
              }
              __name(patchConsoleForErrorsAndWarnings, "patchConsoleForErrorsAndWarnings");
              var fiberRoots = {};
              var rendererInterfaces = /* @__PURE__ */ new Map();
              var listeners = {};
              var renderers = /* @__PURE__ */ new Map();
              var backends = /* @__PURE__ */ new Map();
              var hook = {
                rendererInterfaces,
                listeners,
                backends,
                renderers,
                hasUnsupportedRendererAttached: false,
                emit,
                getFiberRoots,
                inject,
                on,
                off,
                sub,
                supportsFiber: true,
                supportsFlight: true,
                checkDCE,
                onCommitFiberUnmount,
                onCommitFiberRoot,
                onPostCommitFiberRoot,
                setStrictMode,
                getInternalModuleRanges,
                registerInternalModuleStart,
                registerInternalModuleStop
              };
              if (maybeSettingsOrSettingsPromise == null) {
                hook.settings = {
                  appendComponentStack: true,
                  breakOnConsoleErrors: false,
                  showInlineWarningsAndErrors: true,
                  hideConsoleLogsInStrictMode: false
                };
                patchConsoleForErrorsAndWarnings();
              } else {
                Promise.resolve(maybeSettingsOrSettingsPromise).then(function(settings) {
                  hook.settings = settings;
                  hook.emit("settingsInitialized", settings);
                  patchConsoleForErrorsAndWarnings();
                }).catch(function() {
                  targetConsole.error("React DevTools failed to get Console Patching settings. Console won't be patched and some console features will not work.");
                });
              }
              Object.defineProperty(target, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
                configurable: false,
                enumerable: false,
                get: /* @__PURE__ */ __name(function get() {
                  return hook;
                }, "get")
              });
              return hook;
            }
            __name(installHook, "installHook");
            ;
            function initBackend(hook, agent2, global, isReloadAndProfileSupported) {
              if (hook == null) {
                return function() {
                };
              }
              function registerRendererInterface(id, rendererInterface) {
                agent2.registerRendererInterface(id, rendererInterface);
                rendererInterface.flushInitialOperations();
              }
              __name(registerRendererInterface, "registerRendererInterface");
              var subs = [hook.sub("renderer-attached", function(_ref) {
                var id = _ref.id, rendererInterface = _ref.rendererInterface;
                registerRendererInterface(id, rendererInterface);
              }), hook.sub("unsupported-renderer-version", function() {
                agent2.onUnsupportedRenderer();
              }), hook.sub("fastRefreshScheduled", agent2.onFastRefreshScheduled), hook.sub("operations", agent2.onHookOperations), hook.sub("traceUpdates", agent2.onTraceUpdates), hook.sub("settingsInitialized", agent2.onHookSettings)];
              agent2.addListener("getIfHasUnsupportedRendererVersion", function() {
                if (hook.hasUnsupportedRendererAttached) {
                  agent2.onUnsupportedRenderer();
                }
              });
              hook.rendererInterfaces.forEach(function(rendererInterface, id) {
                registerRendererInterface(id, rendererInterface);
              });
              hook.emit("react-devtools", agent2);
              hook.reactDevtoolsAgent = agent2;
              var onAgentShutdown = /* @__PURE__ */ __name(function onAgentShutdown2() {
                subs.forEach(function(fn) {
                  return fn();
                });
                hook.rendererInterfaces.forEach(function(rendererInterface) {
                  rendererInterface.cleanup();
                });
                hook.reactDevtoolsAgent = null;
              }, "onAgentShutdown");
              agent2.addListener("shutdown", onAgentShutdown);
              agent2.addListener("updateHookSettings", function(settings) {
                hook.settings = settings;
              });
              agent2.addListener("getHookSettings", function() {
                if (hook.settings != null) {
                  agent2.onHookSettings(hook.settings);
                }
              });
              if (isReloadAndProfileSupported) {
                agent2.onReloadAndProfileSupportedByHost();
              }
              return function() {
                subs.forEach(function(fn) {
                  return fn();
                });
              };
            }
            __name(initBackend, "initBackend");
            ;
            function resolveBoxStyle(prefix2, style) {
              var hasParts = false;
              var result = {
                bottom: 0,
                left: 0,
                right: 0,
                top: 0
              };
              var styleForAll = style[prefix2];
              if (styleForAll != null) {
                for (var _i = 0, _Object$keys = Object.keys(result); _i < _Object$keys.length; _i++) {
                  var key = _Object$keys[_i];
                  result[key] = styleForAll;
                }
                hasParts = true;
              }
              var styleForHorizontal = style[prefix2 + "Horizontal"];
              if (styleForHorizontal != null) {
                result.left = styleForHorizontal;
                result.right = styleForHorizontal;
                hasParts = true;
              } else {
                var styleForLeft = style[prefix2 + "Left"];
                if (styleForLeft != null) {
                  result.left = styleForLeft;
                  hasParts = true;
                }
                var styleForRight = style[prefix2 + "Right"];
                if (styleForRight != null) {
                  result.right = styleForRight;
                  hasParts = true;
                }
                var styleForEnd = style[prefix2 + "End"];
                if (styleForEnd != null) {
                  result.right = styleForEnd;
                  hasParts = true;
                }
                var styleForStart = style[prefix2 + "Start"];
                if (styleForStart != null) {
                  result.left = styleForStart;
                  hasParts = true;
                }
              }
              var styleForVertical = style[prefix2 + "Vertical"];
              if (styleForVertical != null) {
                result.bottom = styleForVertical;
                result.top = styleForVertical;
                hasParts = true;
              } else {
                var styleForBottom = style[prefix2 + "Bottom"];
                if (styleForBottom != null) {
                  result.bottom = styleForBottom;
                  hasParts = true;
                }
                var styleForTop = style[prefix2 + "Top"];
                if (styleForTop != null) {
                  result.top = styleForTop;
                  hasParts = true;
                }
              }
              return hasParts ? result : null;
            }
            __name(resolveBoxStyle, "resolveBoxStyle");
            ;
            function setupNativeStyleEditor_typeof(o) {
              "@babel/helpers - typeof";
              return setupNativeStyleEditor_typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
                return typeof o2;
              } : function(o2) {
                return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
              }, setupNativeStyleEditor_typeof(o);
            }
            __name(setupNativeStyleEditor_typeof, "setupNativeStyleEditor_typeof");
            function setupNativeStyleEditor_defineProperty(obj, key, value) {
              key = setupNativeStyleEditor_toPropertyKey(key);
              if (key in obj) {
                Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
              } else {
                obj[key] = value;
              }
              return obj;
            }
            __name(setupNativeStyleEditor_defineProperty, "setupNativeStyleEditor_defineProperty");
            function setupNativeStyleEditor_toPropertyKey(t) {
              var i = setupNativeStyleEditor_toPrimitive(t, "string");
              return "symbol" == setupNativeStyleEditor_typeof(i) ? i : i + "";
            }
            __name(setupNativeStyleEditor_toPropertyKey, "setupNativeStyleEditor_toPropertyKey");
            function setupNativeStyleEditor_toPrimitive(t, r) {
              if ("object" != setupNativeStyleEditor_typeof(t) || !t) return t;
              var e = t[Symbol.toPrimitive];
              if (void 0 !== e) {
                var i = e.call(t, r || "default");
                if ("object" != setupNativeStyleEditor_typeof(i)) return i;
                throw new TypeError("@@toPrimitive must return a primitive value.");
              }
              return ("string" === r ? String : Number)(t);
            }
            __name(setupNativeStyleEditor_toPrimitive, "setupNativeStyleEditor_toPrimitive");
            function setupNativeStyleEditor(bridge, agent2, resolveNativeStyle, validAttributes) {
              bridge.addListener("NativeStyleEditor_measure", function(_ref) {
                var id = _ref.id, rendererID = _ref.rendererID;
                measureStyle(agent2, bridge, resolveNativeStyle, id, rendererID);
              });
              bridge.addListener("NativeStyleEditor_renameAttribute", function(_ref2) {
                var id = _ref2.id, rendererID = _ref2.rendererID, oldName = _ref2.oldName, newName = _ref2.newName, value = _ref2.value;
                renameStyle(agent2, id, rendererID, oldName, newName, value);
                setTimeout(function() {
                  return measureStyle(agent2, bridge, resolveNativeStyle, id, rendererID);
                });
              });
              bridge.addListener("NativeStyleEditor_setValue", function(_ref3) {
                var id = _ref3.id, rendererID = _ref3.rendererID, name = _ref3.name, value = _ref3.value;
                setStyle(agent2, id, rendererID, name, value);
                setTimeout(function() {
                  return measureStyle(agent2, bridge, resolveNativeStyle, id, rendererID);
                });
              });
              bridge.send("isNativeStyleEditorSupported", {
                isSupported: true,
                validAttributes
              });
            }
            __name(setupNativeStyleEditor, "setupNativeStyleEditor");
            var EMPTY_BOX_STYLE = {
              top: 0,
              left: 0,
              right: 0,
              bottom: 0
            };
            var componentIDToStyleOverrides = /* @__PURE__ */ new Map();
            function measureStyle(agent2, bridge, resolveNativeStyle, id, rendererID) {
              var data = agent2.getInstanceAndStyle({
                id,
                rendererID
              });
              if (!data || !data.style) {
                bridge.send("NativeStyleEditor_styleAndLayout", {
                  id,
                  layout: null,
                  style: null
                });
                return;
              }
              var instance = data.instance, style = data.style;
              var resolvedStyle = resolveNativeStyle(style);
              var styleOverrides = componentIDToStyleOverrides.get(id);
              if (styleOverrides != null) {
                resolvedStyle = Object.assign({}, resolvedStyle, styleOverrides);
              }
              if (!instance || typeof instance.measure !== "function") {
                bridge.send("NativeStyleEditor_styleAndLayout", {
                  id,
                  layout: null,
                  style: resolvedStyle || null
                });
                return;
              }
              instance.measure(function(x, y, width, height, left, top) {
                if (typeof x !== "number") {
                  bridge.send("NativeStyleEditor_styleAndLayout", {
                    id,
                    layout: null,
                    style: resolvedStyle || null
                  });
                  return;
                }
                var margin = resolvedStyle != null && resolveBoxStyle("margin", resolvedStyle) || EMPTY_BOX_STYLE;
                var padding = resolvedStyle != null && resolveBoxStyle("padding", resolvedStyle) || EMPTY_BOX_STYLE;
                bridge.send("NativeStyleEditor_styleAndLayout", {
                  id,
                  layout: {
                    x,
                    y,
                    width,
                    height,
                    left,
                    top,
                    margin,
                    padding
                  },
                  style: resolvedStyle || null
                });
              });
            }
            __name(measureStyle, "measureStyle");
            function shallowClone(object) {
              var cloned = {};
              for (var n in object) {
                cloned[n] = object[n];
              }
              return cloned;
            }
            __name(shallowClone, "shallowClone");
            function renameStyle(agent2, id, rendererID, oldName, newName, value) {
              var data = agent2.getInstanceAndStyle({
                id,
                rendererID
              });
              if (!data || !data.style) {
                return;
              }
              var instance = data.instance, style = data.style;
              var newStyle = newName ? setupNativeStyleEditor_defineProperty(setupNativeStyleEditor_defineProperty({}, oldName, void 0), newName, value) : setupNativeStyleEditor_defineProperty({}, oldName, void 0);
              var customStyle;
              if (instance !== null && typeof instance.setNativeProps === "function") {
                var styleOverrides = componentIDToStyleOverrides.get(id);
                if (!styleOverrides) {
                  componentIDToStyleOverrides.set(id, newStyle);
                } else {
                  Object.assign(styleOverrides, newStyle);
                }
                instance.setNativeProps({
                  style: newStyle
                });
              } else if (src_isArray(style)) {
                var lastIndex = style.length - 1;
                if (setupNativeStyleEditor_typeof(style[lastIndex]) === "object" && !src_isArray(style[lastIndex])) {
                  customStyle = shallowClone(style[lastIndex]);
                  delete customStyle[oldName];
                  if (newName) {
                    customStyle[newName] = value;
                  } else {
                    customStyle[oldName] = void 0;
                  }
                  agent2.overrideValueAtPath({
                    type: "props",
                    id,
                    rendererID,
                    path: ["style", lastIndex],
                    value: customStyle
                  });
                } else {
                  agent2.overrideValueAtPath({
                    type: "props",
                    id,
                    rendererID,
                    path: ["style"],
                    value: style.concat([newStyle])
                  });
                }
              } else if (setupNativeStyleEditor_typeof(style) === "object") {
                customStyle = shallowClone(style);
                delete customStyle[oldName];
                if (newName) {
                  customStyle[newName] = value;
                } else {
                  customStyle[oldName] = void 0;
                }
                agent2.overrideValueAtPath({
                  type: "props",
                  id,
                  rendererID,
                  path: ["style"],
                  value: customStyle
                });
              } else {
                agent2.overrideValueAtPath({
                  type: "props",
                  id,
                  rendererID,
                  path: ["style"],
                  value: [style, newStyle]
                });
              }
              agent2.emit("hideNativeHighlight");
            }
            __name(renameStyle, "renameStyle");
            function setStyle(agent2, id, rendererID, name, value) {
              var data = agent2.getInstanceAndStyle({
                id,
                rendererID
              });
              if (!data || !data.style) {
                return;
              }
              var instance = data.instance, style = data.style;
              var newStyle = setupNativeStyleEditor_defineProperty({}, name, value);
              if (instance !== null && typeof instance.setNativeProps === "function") {
                var styleOverrides = componentIDToStyleOverrides.get(id);
                if (!styleOverrides) {
                  componentIDToStyleOverrides.set(id, newStyle);
                } else {
                  Object.assign(styleOverrides, newStyle);
                }
                instance.setNativeProps({
                  style: newStyle
                });
              } else if (src_isArray(style)) {
                var lastLength = style.length - 1;
                if (setupNativeStyleEditor_typeof(style[lastLength]) === "object" && !src_isArray(style[lastLength])) {
                  agent2.overrideValueAtPath({
                    type: "props",
                    id,
                    rendererID,
                    path: ["style", lastLength, name],
                    value
                  });
                } else {
                  agent2.overrideValueAtPath({
                    type: "props",
                    id,
                    rendererID,
                    path: ["style"],
                    value: style.concat([newStyle])
                  });
                }
              } else {
                agent2.overrideValueAtPath({
                  type: "props",
                  id,
                  rendererID,
                  path: ["style"],
                  value: [style, newStyle]
                });
              }
              agent2.emit("hideNativeHighlight");
            }
            __name(setStyle, "setStyle");
            ;
            var savedComponentFilters = getDefaultComponentFilters();
            function backend_debug(methodName) {
              if (__DEBUG__) {
                var _console;
                for (var _len = arguments.length, args = new Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
                  args[_key - 1] = arguments[_key];
                }
                (_console = console).log.apply(_console, ["%c[core/backend] %c".concat(methodName), "color: teal; font-weight: bold;", "font-weight: bold;"].concat(args));
              }
            }
            __name(backend_debug, "backend_debug");
            function backend_initialize(maybeSettingsOrSettingsPromise) {
              var shouldStartProfilingNow = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : false;
              var profilingSettings = arguments.length > 2 ? arguments[2] : void 0;
              installHook(window, maybeSettingsOrSettingsPromise, shouldStartProfilingNow, profilingSettings);
            }
            __name(backend_initialize, "backend_initialize");
            function connectToDevTools(options) {
              var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
              if (hook == null) {
                return;
              }
              var _ref = options || {}, _ref$host = _ref.host, host = _ref$host === void 0 ? "localhost" : _ref$host, nativeStyleEditorValidAttributes = _ref.nativeStyleEditorValidAttributes, _ref$useHttps = _ref.useHttps, useHttps = _ref$useHttps === void 0 ? false : _ref$useHttps, _ref$port = _ref.port, port = _ref$port === void 0 ? 8097 : _ref$port, websocket = _ref.websocket, _ref$resolveRNStyle = _ref.resolveRNStyle, resolveRNStyle = _ref$resolveRNStyle === void 0 ? null : _ref$resolveRNStyle, _ref$retryConnectionD = _ref.retryConnectionDelay, retryConnectionDelay = _ref$retryConnectionD === void 0 ? 2e3 : _ref$retryConnectionD, _ref$isAppActive = _ref.isAppActive, isAppActive = _ref$isAppActive === void 0 ? function() {
                return true;
              } : _ref$isAppActive, onSettingsUpdated = _ref.onSettingsUpdated, _ref$isReloadAndProfi = _ref.isReloadAndProfileSupported, isReloadAndProfileSupported = _ref$isReloadAndProfi === void 0 ? getIsReloadAndProfileSupported() : _ref$isReloadAndProfi, isProfiling = _ref.isProfiling, onReloadAndProfile2 = _ref.onReloadAndProfile, onReloadAndProfileFlagsReset2 = _ref.onReloadAndProfileFlagsReset;
              var protocol = useHttps ? "wss" : "ws";
              var retryTimeoutID = null;
              function scheduleRetry() {
                if (retryTimeoutID === null) {
                  retryTimeoutID = setTimeout(function() {
                    return connectToDevTools(options);
                  }, retryConnectionDelay);
                }
              }
              __name(scheduleRetry, "scheduleRetry");
              if (!isAppActive()) {
                scheduleRetry();
                return;
              }
              var bridge = null;
              var messageListeners = [];
              var uri = protocol + "://" + host + ":" + port;
              var ws = websocket ? websocket : new window.WebSocket(uri);
              ws.onclose = handleClose;
              ws.onerror = handleFailed;
              ws.onmessage = handleMessage;
              ws.onopen = function() {
                bridge = new src_bridge({
                  listen: /* @__PURE__ */ __name(function listen(fn) {
                    messageListeners.push(fn);
                    return function() {
                      var index = messageListeners.indexOf(fn);
                      if (index >= 0) {
                        messageListeners.splice(index, 1);
                      }
                    };
                  }, "listen"),
                  send: /* @__PURE__ */ __name(function send(event, payload, transferable) {
                    if (ws.readyState === ws.OPEN) {
                      if (__DEBUG__) {
                        backend_debug("wall.send()", event, payload);
                      }
                      ws.send(JSON.stringify({
                        event,
                        payload
                      }));
                    } else {
                      if (__DEBUG__) {
                        backend_debug("wall.send()", "Shutting down bridge because of closed WebSocket connection");
                      }
                      if (bridge !== null) {
                        bridge.shutdown();
                      }
                      scheduleRetry();
                    }
                  }, "send")
                });
                bridge.addListener("updateComponentFilters", function(componentFilters) {
                  savedComponentFilters = componentFilters;
                });
                if (window.__REACT_DEVTOOLS_COMPONENT_FILTERS__ == null) {
                  bridge.send("overrideComponentFilters", savedComponentFilters);
                }
                var agent2 = new Agent(bridge, isProfiling, onReloadAndProfile2);
                if (typeof onReloadAndProfileFlagsReset2 === "function") {
                  onReloadAndProfileFlagsReset2();
                }
                if (onSettingsUpdated != null) {
                  agent2.addListener("updateHookSettings", onSettingsUpdated);
                }
                agent2.addListener("shutdown", function() {
                  if (onSettingsUpdated != null) {
                    agent2.removeListener("updateHookSettings", onSettingsUpdated);
                  }
                  hook.emit("shutdown");
                });
                initBackend(hook, agent2, window, isReloadAndProfileSupported);
                if (resolveRNStyle != null || hook.resolveRNStyle != null) {
                  setupNativeStyleEditor(bridge, agent2, resolveRNStyle || hook.resolveRNStyle, nativeStyleEditorValidAttributes || hook.nativeStyleEditorValidAttributes || null);
                } else {
                  var lazyResolveRNStyle;
                  var lazyNativeStyleEditorValidAttributes;
                  var initAfterTick = /* @__PURE__ */ __name(function initAfterTick2() {
                    if (bridge !== null) {
                      setupNativeStyleEditor(bridge, agent2, lazyResolveRNStyle, lazyNativeStyleEditorValidAttributes);
                    }
                  }, "initAfterTick");
                  if (!hook.hasOwnProperty("resolveRNStyle")) {
                    Object.defineProperty(hook, "resolveRNStyle", {
                      enumerable: false,
                      get: /* @__PURE__ */ __name(function get() {
                        return lazyResolveRNStyle;
                      }, "get"),
                      set: /* @__PURE__ */ __name(function set(value) {
                        lazyResolveRNStyle = value;
                        initAfterTick();
                      }, "set")
                    });
                  }
                  if (!hook.hasOwnProperty("nativeStyleEditorValidAttributes")) {
                    Object.defineProperty(hook, "nativeStyleEditorValidAttributes", {
                      enumerable: false,
                      get: /* @__PURE__ */ __name(function get() {
                        return lazyNativeStyleEditorValidAttributes;
                      }, "get"),
                      set: /* @__PURE__ */ __name(function set(value) {
                        lazyNativeStyleEditorValidAttributes = value;
                        initAfterTick();
                      }, "set")
                    });
                  }
                }
              };
              function handleClose() {
                if (__DEBUG__) {
                  backend_debug("WebSocket.onclose");
                }
                if (bridge !== null) {
                  bridge.emit("shutdown");
                }
                scheduleRetry();
              }
              __name(handleClose, "handleClose");
              function handleFailed() {
                if (__DEBUG__) {
                  backend_debug("WebSocket.onerror");
                }
                scheduleRetry();
              }
              __name(handleFailed, "handleFailed");
              function handleMessage(event) {
                var data;
                try {
                  if (typeof event.data === "string") {
                    data = JSON.parse(event.data);
                    if (__DEBUG__) {
                      backend_debug("WebSocket.onmessage", data);
                    }
                  } else {
                    throw Error();
                  }
                } catch (e) {
                  console.error("[React DevTools] Failed to parse JSON: " + event.data);
                  return;
                }
                messageListeners.forEach(function(fn) {
                  try {
                    fn(data);
                  } catch (error) {
                    console.log("[React DevTools] Error calling listener", data);
                    console.log("error:", error);
                    throw error;
                  }
                });
              }
              __name(handleMessage, "handleMessage");
            }
            __name(connectToDevTools, "connectToDevTools");
            function connectWithCustomMessagingProtocol(_ref2) {
              var onSubscribe = _ref2.onSubscribe, onUnsubscribe = _ref2.onUnsubscribe, onMessage = _ref2.onMessage, nativeStyleEditorValidAttributes = _ref2.nativeStyleEditorValidAttributes, resolveRNStyle = _ref2.resolveRNStyle, onSettingsUpdated = _ref2.onSettingsUpdated, _ref2$isReloadAndProf = _ref2.isReloadAndProfileSupported, isReloadAndProfileSupported = _ref2$isReloadAndProf === void 0 ? getIsReloadAndProfileSupported() : _ref2$isReloadAndProf, isProfiling = _ref2.isProfiling, onReloadAndProfile2 = _ref2.onReloadAndProfile, onReloadAndProfileFlagsReset2 = _ref2.onReloadAndProfileFlagsReset;
              var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
              if (hook == null) {
                return;
              }
              var wall = {
                listen: /* @__PURE__ */ __name(function listen(fn) {
                  onSubscribe(fn);
                  return function() {
                    onUnsubscribe(fn);
                  };
                }, "listen"),
                send: /* @__PURE__ */ __name(function send(event, payload) {
                  onMessage(event, payload);
                }, "send")
              };
              var bridge = new src_bridge(wall);
              bridge.addListener("updateComponentFilters", function(componentFilters) {
                savedComponentFilters = componentFilters;
              });
              if (window.__REACT_DEVTOOLS_COMPONENT_FILTERS__ == null) {
                bridge.send("overrideComponentFilters", savedComponentFilters);
              }
              var agent2 = new Agent(bridge, isProfiling, onReloadAndProfile2);
              if (typeof onReloadAndProfileFlagsReset2 === "function") {
                onReloadAndProfileFlagsReset2();
              }
              if (onSettingsUpdated != null) {
                agent2.addListener("updateHookSettings", onSettingsUpdated);
              }
              agent2.addListener("shutdown", function() {
                if (onSettingsUpdated != null) {
                  agent2.removeListener("updateHookSettings", onSettingsUpdated);
                }
                hook.emit("shutdown");
              });
              var unsubscribeBackend = initBackend(hook, agent2, window, isReloadAndProfileSupported);
              var nativeStyleResolver = resolveRNStyle || hook.resolveRNStyle;
              if (nativeStyleResolver != null) {
                var validAttributes = nativeStyleEditorValidAttributes || hook.nativeStyleEditorValidAttributes || null;
                setupNativeStyleEditor(bridge, agent2, nativeStyleResolver, validAttributes);
              }
              return unsubscribeBackend;
            }
            __name(connectWithCustomMessagingProtocol, "connectWithCustomMessagingProtocol");
          })();
          return __webpack_exports__;
        })()
      );
    });
  }
});

// packages/cli/node_modules/@opentui/react/chunk-bdqvmfwv.js
init_esbuild_shims();
var import_react_devtools_core = __toESM(require_backend(), 1);
var g = globalThis;
if (typeof g.WebSocket === "undefined") {
  try {
    const ws = await import("./wrapper-JH3IFHT2.js");
    g.WebSocket = ws.default;
  } catch {
  }
}
g.window ||= globalThis;
g.self ||= globalThis;
g.window.__REACT_DEVTOOLS_COMPONENT_FILTERS__ = [
  {
    type: 2,
    value: "ErrorBoundary",
    isEnabled: true,
    isValid: true
  }
];
import_react_devtools_core.default.initialize();
import_react_devtools_core.default.connectToDevTools();
/*! Bundled license information:

react-devtools-core/dist/backend.js:
  (*! regenerator-runtime -- Copyright (c) 2014-present, Facebook, Inc. -- license (MIT): https://github.com/facebook/regenerator/blob/main/LICENSE *)
*/
