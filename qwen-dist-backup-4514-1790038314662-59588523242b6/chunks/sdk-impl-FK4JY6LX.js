// Force strict mode and setup for ESM
"use strict";
import {
  setDaemonFallbackPropagator
} from "./chunk-GVTAFLWB.js";
import {
  require_src as require_src3,
  require_src2 as require_src4,
  require_src3 as require_src5
} from "./chunk-7NXSVSFB.js";
import {
  safeJsonStringify
} from "./chunk-HHJLM3WQ.js";
import {
  SERVICE_NAME,
  configureContextUsageAttributeLengthLimit
} from "./chunk-B3XJFEEH.js";
import {
  SemanticResourceAttributes,
  esm_exports as esm_exports2,
  init_esm as init_esm2,
  require_src as require_src2
} from "./chunk-74TONY4F.js";
import {
  createDebugLogger,
  getCurrentSessionId,
  getSessionIdFromContext,
  sessionIdContext
} from "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import {
  diag,
  esm_exports,
  init_esm
} from "./chunk-TBWQLLFO.js";
import {
  require_src
} from "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __commonJS,
  __name,
  __require,
  __toCommonJS,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/utils/validation.js
var require_validation = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/utils/validation.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.normalizeScopeAttributes = exports.addAttribute = exports.AddAttributeDecision = exports.isLogAttributeValue = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    function isLogAttributeValue(val) {
      return isLogAttributeValueInternal(val, /* @__PURE__ */ new WeakSet());
    }
    __name(isLogAttributeValue, "isLogAttributeValue");
    exports.isLogAttributeValue = isLogAttributeValue;
    function isLogAttributeValueInternal(val, visited) {
      if (val == null) {
        return true;
      }
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
        return true;
      }
      if (val instanceof Uint8Array) {
        return true;
      }
      if (typeof val === "object") {
        if (visited.has(val)) {
          return false;
        }
        visited.add(val);
        if (Array.isArray(val)) {
          for (const item of val) {
            if (!isLogAttributeValueInternal(item, visited)) {
              return false;
            }
          }
          return true;
        }
        const obj = val;
        if (obj.constructor !== Object && obj.constructor !== void 0) {
          return false;
        }
        for (const key in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, key) && !isLogAttributeValueInternal(obj[key], visited)) {
            return false;
          }
        }
        return true;
      }
      return false;
    }
    __name(isLogAttributeValueInternal, "isLogAttributeValueInternal");
    var AddAttributeDecision;
    (function(AddAttributeDecision2) {
      AddAttributeDecision2[AddAttributeDecision2["DROP_INVALID"] = 0] = "DROP_INVALID";
      AddAttributeDecision2[AddAttributeDecision2["DROP_LIMIT_REACHED"] = 1] = "DROP_LIMIT_REACHED";
      AddAttributeDecision2[AddAttributeDecision2["ADD_NEW"] = 2] = "ADD_NEW";
      AddAttributeDecision2[AddAttributeDecision2["ADD_OVERWRITE_EXISTING"] = 3] = "ADD_OVERWRITE_EXISTING";
    })(AddAttributeDecision || (exports.AddAttributeDecision = AddAttributeDecision = {}));
    function addAttribute(attributes, limits, currentAttributesCount, key, value) {
      if (key.length === 0) {
        api_1.diag.warn(`Invalid attribute key: ${key}`);
        return AddAttributeDecision.DROP_INVALID;
      }
      if (!isLogAttributeValue(value)) {
        api_1.diag.warn(`Invalid attribute value set for key: ${key}`);
        return AddAttributeDecision.DROP_INVALID;
      }
      const isNewKey = !Object.prototype.hasOwnProperty.call(attributes, key);
      if (isNewKey && currentAttributesCount >= limits.attributeCountLimit) {
        return AddAttributeDecision.DROP_LIMIT_REACHED;
      }
      attributes[key] = truncateToSize(value, limits.attributeValueLengthLimit);
      if (isNewKey) {
        return AddAttributeDecision.ADD_NEW;
      }
      return AddAttributeDecision.ADD_OVERWRITE_EXISTING;
    }
    __name(addAttribute, "addAttribute");
    exports.addAttribute = addAttribute;
    function truncateToSize(value, limit) {
      if (limit <= 0) {
        api_1.diag.warn(`Attribute value limit must be positive, got ${limit}`);
        return value;
      }
      if (value == null) {
        return value;
      }
      if (typeof value === "string") {
        if (value.length <= limit) {
          return value;
        }
        return value.substring(0, limit);
      }
      if (value instanceof Uint8Array) {
        return value;
      }
      if (Array.isArray(value)) {
        return value.map((val) => truncateToSize(val, limit));
      }
      if (typeof value === "object") {
        const truncatedObj = {};
        for (const [k, v] of Object.entries(value)) {
          truncatedObj[k] = truncateToSize(v, limit);
        }
        return truncatedObj;
      }
      return value;
    }
    __name(truncateToSize, "truncateToSize");
    function normalizeScopeAttributes(limits, attributes) {
      if (attributes == null) {
        return {};
      }
      const normalizedAttributes = {};
      let currentAttributesCount = 0;
      let droppedAttributesCount = 0;
      for (const [key, value] of Object.entries(attributes)) {
        const decision = addAttribute(normalizedAttributes, limits, currentAttributesCount, key, value);
        if (decision === AddAttributeDecision.ADD_NEW) {
          currentAttributesCount += 1;
        } else if (decision === AddAttributeDecision.DROP_INVALID) {
          droppedAttributesCount += 1;
        } else if (decision === AddAttributeDecision.DROP_LIMIT_REACHED) {
          droppedAttributesCount += 1;
        } else {
        }
      }
      return {
        attributes: currentAttributesCount > 0 ? normalizedAttributes : void 0,
        droppedAttributesCount
      };
    }
    __name(normalizeScopeAttributes, "normalizeScopeAttributes");
    exports.normalizeScopeAttributes = normalizeScopeAttributes;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/LogRecordImpl.js
var require_LogRecordImpl = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/LogRecordImpl.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.LogRecordImpl = void 0;
    var api = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src3();
    var semantic_conventions_1 = (init_esm2(), __toCommonJS(esm_exports2));
    var validation_1 = require_validation();
    var LogRecordImpl = class {
      static {
        __name(this, "LogRecordImpl");
      }
      resource;
      instrumentationScope;
      attributes = {};
      _hrTime;
      _hrTimeObserved;
      _spanContext;
      _severityText;
      _severityNumber;
      _body;
      _eventName;
      _attributesCount = 0;
      _droppedAttributesCount = 0;
      _isReadonly = false;
      _logRecordLimits;
      get hrTime() {
        return this._hrTime;
      }
      set hrTime(hrTime) {
        if (this._isLogRecordReadonly()) {
          return;
        }
        this._hrTime = hrTime;
      }
      get hrTimeObserved() {
        return this._hrTimeObserved;
      }
      set hrTimeObserved(hrTimeObserved) {
        if (this._isLogRecordReadonly()) {
          return;
        }
        this._hrTimeObserved = hrTimeObserved;
      }
      get spanContext() {
        return this._spanContext;
      }
      set spanContext(spanContext) {
        if (this._isLogRecordReadonly()) {
          return;
        }
        this._spanContext = spanContext;
      }
      set severityText(severityText) {
        if (this._isLogRecordReadonly()) {
          return;
        }
        this._severityText = severityText;
      }
      get severityText() {
        return this._severityText;
      }
      set severityNumber(severityNumber) {
        if (this._isLogRecordReadonly()) {
          return;
        }
        this._severityNumber = severityNumber;
      }
      get severityNumber() {
        return this._severityNumber;
      }
      set body(body) {
        if (this._isLogRecordReadonly()) {
          return;
        }
        this._body = body;
      }
      get body() {
        return this._body;
      }
      get eventName() {
        return this._eventName;
      }
      set eventName(eventName) {
        if (this._isLogRecordReadonly()) {
          return;
        }
        this._eventName = eventName;
      }
      get droppedAttributesCount() {
        return this._droppedAttributesCount;
      }
      constructor(_sharedState, instrumentationScope, logRecord) {
        const { timestamp, observedTimestamp, eventName, severityNumber, severityText, body, attributes = {}, exception, context } = logRecord;
        const now = Date.now();
        this._hrTime = (0, core_1.timeInputToHrTime)(timestamp ?? now);
        this._hrTimeObserved = (0, core_1.timeInputToHrTime)(observedTimestamp ?? now);
        if (context) {
          const spanContext = api.trace.getSpanContext(context);
          if (spanContext && api.isSpanContextValid(spanContext)) {
            this._spanContext = spanContext;
          }
        }
        this.severityNumber = severityNumber;
        this.severityText = severityText;
        this.body = body;
        this.resource = _sharedState.resource;
        this.instrumentationScope = instrumentationScope;
        this._logRecordLimits = _sharedState.logRecordLimits;
        this._eventName = eventName;
        this.setAttributes(attributes);
        if (exception != null) {
          this._setException(exception);
        }
      }
      setAttribute(key, value) {
        if (this._isLogRecordReadonly()) {
          return this;
        }
        const decision = (0, validation_1.addAttribute)(this.attributes, this._logRecordLimits, this._attributesCount, key, value);
        if (decision === validation_1.AddAttributeDecision.DROP_LIMIT_REACHED) {
          this._droppedAttributesCount++;
          if (this._droppedAttributesCount === 1) {
            api.diag.warn("Dropping extra attributes.");
          }
        } else if (decision === validation_1.AddAttributeDecision.ADD_NEW) {
          this._attributesCount++;
        }
        return this;
      }
      setAttributes(attributes) {
        for (const [k, v] of Object.entries(attributes)) {
          this.setAttribute(k, v);
        }
        return this;
      }
      setBody(body) {
        this.body = body;
        return this;
      }
      setEventName(eventName) {
        this.eventName = eventName;
        return this;
      }
      setSeverityNumber(severityNumber) {
        this.severityNumber = severityNumber;
        return this;
      }
      setSeverityText(severityText) {
        this.severityText = severityText;
        return this;
      }
      /**
       * @internal
       * A LogRecordProcessor may freely modify logRecord for the duration of the OnEmit call.
       * If logRecord is needed after OnEmit returns (i.e. for asynchronous processing) only reads are permitted.
       */
      _makeReadonly() {
        this._isReadonly = true;
      }
      _setException(exception) {
        let hasMinimumAttributes = false;
        if (typeof exception === "string" || typeof exception === "number") {
          if (!Object.hasOwn(this.attributes, semantic_conventions_1.ATTR_EXCEPTION_MESSAGE)) {
            this.setAttribute(semantic_conventions_1.ATTR_EXCEPTION_MESSAGE, String(exception));
          }
          hasMinimumAttributes = true;
        } else if (exception && typeof exception === "object") {
          const exceptionObj = exception;
          if (exceptionObj.code) {
            if (!Object.hasOwn(this.attributes, semantic_conventions_1.ATTR_EXCEPTION_TYPE)) {
              this.setAttribute(semantic_conventions_1.ATTR_EXCEPTION_TYPE, exceptionObj.code.toString());
            }
            hasMinimumAttributes = true;
          } else if (exceptionObj.name) {
            if (!Object.hasOwn(this.attributes, semantic_conventions_1.ATTR_EXCEPTION_TYPE)) {
              this.setAttribute(semantic_conventions_1.ATTR_EXCEPTION_TYPE, exceptionObj.name);
            }
            hasMinimumAttributes = true;
          }
          if (exceptionObj.message) {
            if (!Object.hasOwn(this.attributes, semantic_conventions_1.ATTR_EXCEPTION_MESSAGE)) {
              this.setAttribute(semantic_conventions_1.ATTR_EXCEPTION_MESSAGE, exceptionObj.message);
            }
            hasMinimumAttributes = true;
          }
          if (exceptionObj.stack) {
            if (!Object.hasOwn(this.attributes, semantic_conventions_1.ATTR_EXCEPTION_STACKTRACE)) {
              this.setAttribute(semantic_conventions_1.ATTR_EXCEPTION_STACKTRACE, exceptionObj.stack);
            }
            hasMinimumAttributes = true;
          }
        }
        if (!hasMinimumAttributes) {
          api.diag.warn(`Failed to record an exception ${exception}`);
        }
      }
      _isLogRecordReadonly() {
        if (this._isReadonly) {
          api.diag.warn("Can not execute the operation on emitted log record");
        }
        return this._isReadonly;
      }
    };
    exports.LogRecordImpl = LogRecordImpl;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/Logger.js
var require_Logger = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/Logger.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Logger = void 0;
    var api_logs_1 = require_src2();
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var LogRecordImpl_1 = require_LogRecordImpl();
    var Logger = class {
      static {
        __name(this, "Logger");
      }
      _instrumentationScope;
      _sharedState;
      _loggerConfig;
      constructor(instrumentationScope, sharedState) {
        this._instrumentationScope = instrumentationScope;
        this._sharedState = sharedState;
        this._loggerConfig = this._sharedState.getLoggerConfig(this._instrumentationScope);
      }
      emit(logRecord) {
        const currentContext = logRecord.context || api_1.context.active();
        if (!this.enabled(logRecord)) {
          return;
        }
        const logRecordInstance = new LogRecordImpl_1.LogRecordImpl(this._sharedState, this._instrumentationScope, {
          context: currentContext,
          ...logRecord
        });
        this._sharedState.loggerMetrics.emitLog();
        this._sharedState.activeProcessor.onEmit(logRecordInstance, currentContext);
        logRecordInstance._makeReadonly();
      }
      enabled(options) {
        if (this._sharedState.hasShutdown) {
          return false;
        }
        const loggerConfig = this._loggerConfig;
        if (loggerConfig.disabled) {
          return false;
        }
        const severityNumber = options?.severityNumber;
        if (typeof severityNumber === "number" && severityNumber !== api_logs_1.SeverityNumber.UNSPECIFIED && severityNumber < loggerConfig.minimumSeverity) {
          return false;
        }
        const currentContext = options?.context || api_1.context.active();
        if (loggerConfig.traceBased) {
          const spanContext = api_1.trace.getSpanContext(currentContext);
          if (spanContext && (0, api_1.isSpanContextValid)(spanContext)) {
            const isSampled = (spanContext.traceFlags & api_1.TraceFlags.SAMPLED) === api_1.TraceFlags.SAMPLED;
            if (!isSampled) {
              return false;
            }
          }
        }
        const enabledOpts = {
          context: currentContext,
          instrumentationScope: this._instrumentationScope,
          severityNumber: options?.severityNumber,
          eventName: options?.eventName
        };
        for (const processor of this._sharedState.processors) {
          if (!processor.enabled || processor.enabled(enabledOpts)) {
            return true;
          }
        }
        return false;
      }
    };
    exports.Logger = Logger;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/export/NoopLogRecordProcessor.js
var require_NoopLogRecordProcessor = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/export/NoopLogRecordProcessor.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.NoopLogRecordProcessor = void 0;
    var NoopLogRecordProcessor = class {
      static {
        __name(this, "NoopLogRecordProcessor");
      }
      forceFlush() {
        return Promise.resolve();
      }
      onEmit(_logRecord, _context) {
      }
      shutdown() {
        return Promise.resolve();
      }
      enabled(_options) {
        return false;
      }
    };
    exports.NoopLogRecordProcessor = NoopLogRecordProcessor;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/MultiLogRecordProcessor.js
var require_MultiLogRecordProcessor = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/MultiLogRecordProcessor.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MultiLogRecordProcessor = void 0;
    var core_1 = require_src3();
    var MultiLogRecordProcessor = class {
      static {
        __name(this, "MultiLogRecordProcessor");
      }
      processors;
      constructor(processors) {
        this.processors = processors;
      }
      async forceFlush(options) {
        const timeout = options?.timeoutMillis ?? 3e4;
        await Promise.all(this.processors.map((processor) => (0, core_1.callWithTimeout)(processor.forceFlush(), timeout)));
      }
      onEmit(logRecord, context) {
        this.processors.forEach((processors) => processors.onEmit(logRecord, context));
      }
      async shutdown() {
        await Promise.all(this.processors.map((processor) => processor.shutdown()));
      }
      enabled(options) {
        for (const processor of this.processors) {
          if (!processor.enabled || processor.enabled(options)) {
            return true;
          }
        }
        return false;
      }
    };
    exports.MultiLogRecordProcessor = MultiLogRecordProcessor;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/internal/utils.js
var require_utils = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/internal/utils.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getInstrumentationScopeKey = void 0;
    function normalizeAnyValue(value) {
      if (value === void 0) {
        return ["u", null];
      }
      if (value === null) {
        return ["n", null];
      }
      const valueType = typeof value;
      if (valueType === "string") {
        return ["s", value];
      }
      if (valueType === "boolean") {
        return ["b", value];
      }
      if (valueType === "number") {
        if (Number.isNaN(value))
          return ["nan", null];
        if (value === Infinity)
          return ["inf", null];
        if (value === -Infinity)
          return ["-inf", null];
        if (Object.is(value, -0))
          return ["n0", null];
        return ["d", value];
      }
      if (value instanceof Uint8Array) {
        return ["bytes", Array.from(value)];
      }
      if (Array.isArray(value)) {
        return ["arr", value.map(normalizeAnyValue)];
      }
      return [
        "map",
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalizeAnyValue(v)])
      ];
    }
    __name(normalizeAnyValue, "normalizeAnyValue");
    function getInstrumentationScopeKey(scope) {
      return JSON.stringify([
        scope.name,
        scope.version || "",
        scope.schemaUrl || "",
        normalizeAnyValue(scope.attributes),
        // we include the dropped attributes count to avoid collisions between scopes with the same identifying
        // characteristics, but different dropped counts. While there still can be collisions this is the best we can do if
        // we want to resolve the same logger without relying on object identity.
        scope.droppedAttributesCount ?? 0
      ]);
    }
    __name(getInstrumentationScopeKey, "getInstrumentationScopeKey");
    exports.getInstrumentationScopeKey = getInstrumentationScopeKey;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/semconv.js
var require_semconv = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/semconv.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ATTR_ERROR_TYPE = exports.OTEL_COMPONENT_TYPE_VALUE_SIMPLE_LOG_PROCESSOR = exports.OTEL_COMPONENT_TYPE_VALUE_BATCHING_LOG_PROCESSOR = exports.ATTR_OTEL_COMPONENT_TYPE = exports.ATTR_OTEL_COMPONENT_NAME = exports.METRIC_OTEL_SDK_PROCESSOR_LOG_QUEUE_SIZE = exports.METRIC_OTEL_SDK_PROCESSOR_LOG_QUEUE_CAPACITY = exports.METRIC_OTEL_SDK_PROCESSOR_LOG_PROCESSED = exports.METRIC_OTEL_SDK_LOG_CREATED = void 0;
    exports.METRIC_OTEL_SDK_LOG_CREATED = "otel.sdk.log.created";
    exports.METRIC_OTEL_SDK_PROCESSOR_LOG_PROCESSED = "otel.sdk.processor.log.processed";
    exports.METRIC_OTEL_SDK_PROCESSOR_LOG_QUEUE_CAPACITY = "otel.sdk.processor.log.queue.capacity";
    exports.METRIC_OTEL_SDK_PROCESSOR_LOG_QUEUE_SIZE = "otel.sdk.processor.log.queue.size";
    exports.ATTR_OTEL_COMPONENT_NAME = "otel.component.name";
    exports.ATTR_OTEL_COMPONENT_TYPE = "otel.component.type";
    exports.OTEL_COMPONENT_TYPE_VALUE_BATCHING_LOG_PROCESSOR = "batching_log_processor";
    exports.OTEL_COMPONENT_TYPE_VALUE_SIMPLE_LOG_PROCESSOR = "simple_log_processor";
    exports.ATTR_ERROR_TYPE = "error.type";
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/LoggerMetrics.js
var require_LoggerMetrics = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/LoggerMetrics.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.LoggerMetrics = void 0;
    var semconv_1 = require_semconv();
    var LoggerMetrics = class {
      static {
        __name(this, "LoggerMetrics");
      }
      createdLogs;
      constructor(meter) {
        this.createdLogs = meter.createCounter(semconv_1.METRIC_OTEL_SDK_LOG_CREATED, {
          unit: "{log_record}",
          description: "The number of logs submitted to enabled SDK Loggers."
        });
      }
      emitLog() {
        this.createdLogs.add(1);
      }
    };
    exports.LoggerMetrics = LoggerMetrics;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/version.js
var require_version = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/version.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.VERSION = void 0;
    exports.VERSION = "0.221.0";
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/internal/LoggerProviderSharedState.js
var require_LoggerProviderSharedState = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/internal/LoggerProviderSharedState.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.LoggerProviderSharedState = exports.DEFAULT_LOGGER_CONFIGURATOR = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var api_logs_1 = require_src2();
    var NoopLogRecordProcessor_1 = require_NoopLogRecordProcessor();
    var MultiLogRecordProcessor_1 = require_MultiLogRecordProcessor();
    var utils_1 = require_utils();
    var LoggerMetrics_1 = require_LoggerMetrics();
    var version_1 = require_version();
    var DEFAULT_LOGGER_CONFIG = {
      disabled: false,
      minimumSeverity: api_logs_1.SeverityNumber.UNSPECIFIED,
      traceBased: false
    };
    var DEFAULT_LOGGER_CONFIGURATOR = /* @__PURE__ */ __name(() => ({
      ...DEFAULT_LOGGER_CONFIG
    }), "DEFAULT_LOGGER_CONFIGURATOR");
    exports.DEFAULT_LOGGER_CONFIGURATOR = DEFAULT_LOGGER_CONFIGURATOR;
    var LoggerProviderSharedState = class {
      static {
        __name(this, "LoggerProviderSharedState");
      }
      loggers = /* @__PURE__ */ new Map();
      activeProcessor;
      registeredLogRecordProcessors = [];
      resource;
      logRecordLimits;
      processors;
      loggerMetrics;
      hasShutdown = false;
      _loggerConfigurator;
      _loggerConfigs = /* @__PURE__ */ new Map();
      constructor(resource, logRecordLimits, processors, loggerConfigurator, meterProvider) {
        this.resource = resource;
        this.logRecordLimits = logRecordLimits;
        this.processors = processors;
        if (processors.length > 0) {
          this.registeredLogRecordProcessors = processors;
          this.activeProcessor = new MultiLogRecordProcessor_1.MultiLogRecordProcessor(this.registeredLogRecordProcessors);
        } else {
          this.activeProcessor = new NoopLogRecordProcessor_1.NoopLogRecordProcessor();
        }
        this._loggerConfigurator = loggerConfigurator ?? exports.DEFAULT_LOGGER_CONFIGURATOR;
        const meter = meterProvider ? meterProvider.getMeter("@opentelemetry/sdk-logs", version_1.VERSION) : (0, api_1.createNoopMeter)();
        this.loggerMetrics = new LoggerMetrics_1.LoggerMetrics(meter);
      }
      /**
       * Get the LoggerConfig for a given instrumentation scope.
       * Uses the LoggerConfigurator function to compute the config on first access
       * and caches the result.
       *
       * @experimental This feature is in development as per the OpenTelemetry specification.
       */
      getLoggerConfig(instrumentationScope) {
        const key = (0, utils_1.getInstrumentationScopeKey)(instrumentationScope);
        let config = this._loggerConfigs.get(key);
        if (config) {
          return config;
        }
        config = this._loggerConfigurator(instrumentationScope);
        this._loggerConfigs.set(key, config);
        return config;
      }
    };
    exports.LoggerProviderSharedState = LoggerProviderSharedState;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/LoggerProvider.js
var require_LoggerProvider = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/LoggerProvider.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.LoggerProvider = exports.DEFAULT_LOGGER_NAME = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var api_logs_1 = require_src2();
    var resources_1 = require_src4();
    var core_1 = require_src3();
    var Logger_1 = require_Logger();
    var LoggerProviderSharedState_1 = require_LoggerProviderSharedState();
    var utils_1 = require_utils();
    var validation_1 = require_validation();
    exports.DEFAULT_LOGGER_NAME = "unknown";
    var LoggerProvider = class {
      static {
        __name(this, "LoggerProvider");
      }
      _shutdownOnce;
      _sharedState;
      constructor(config = {}) {
        const mergedConfig = {
          resource: config.resource ?? (0, resources_1.defaultResource)(),
          logRecordLimits: {
            attributeCountLimit: config.logRecordLimits?.attributeCountLimit ?? 128,
            attributeValueLengthLimit: config.logRecordLimits?.attributeValueLengthLimit ?? Infinity
          },
          loggerConfigurator: config.loggerConfigurator ?? LoggerProviderSharedState_1.DEFAULT_LOGGER_CONFIGURATOR,
          processors: config.processors ?? [],
          meterProvider: config.meterProvider
        };
        this._sharedState = new LoggerProviderSharedState_1.LoggerProviderSharedState(mergedConfig.resource, mergedConfig.logRecordLimits, mergedConfig.processors, mergedConfig.loggerConfigurator, mergedConfig.meterProvider);
        this._shutdownOnce = new core_1.BindOnceFuture(this._shutdown, this);
      }
      /**
       * Get a logger with the configuration of the LoggerProvider.
       */
      getLogger(name, version, options) {
        if (this._shutdownOnce.isCalled) {
          api_1.diag.warn("A shutdown LoggerProvider cannot provide a Logger");
          return (0, api_logs_1.createNoopLogger)();
        }
        if (!name) {
          api_1.diag.warn("Logger requested without instrumentation scope name.");
        }
        const loggerName = name || exports.DEFAULT_LOGGER_NAME;
        const instrumentationScope = {
          name: loggerName,
          version,
          schemaUrl: options?.schemaUrl,
          ...(0, validation_1.normalizeScopeAttributes)(this._sharedState.logRecordLimits, options?.attributes)
        };
        const key = (0, utils_1.getInstrumentationScopeKey)(instrumentationScope);
        if (!this._sharedState.loggers.has(key)) {
          this._sharedState.loggers.set(key, new Logger_1.Logger(instrumentationScope, this._sharedState));
        }
        return this._sharedState.loggers.get(key);
      }
      /**
       * Notifies all registered LogRecordProcessor to flush any buffered data.
       *
       * Returns a promise which is resolved when all flushes are complete.
       */
      forceFlush(options) {
        if (this._shutdownOnce.isCalled) {
          api_1.diag.warn("invalid attempt to force flush after LoggerProvider shutdown");
          return this._shutdownOnce.promise;
        }
        return this._sharedState.activeProcessor.forceFlush(options);
      }
      /**
       * Flush all buffered data and shut down the LoggerProvider and all registered
       * LogRecordProcessor.
       *
       * Returns a promise which is resolved when all flushes are complete.
       */
      shutdown() {
        if (this._shutdownOnce.isCalled) {
          api_1.diag.warn("shutdown may only be called once per LoggerProvider");
          return this._shutdownOnce.promise;
        }
        return this._shutdownOnce.call();
      }
      _shutdown() {
        this._sharedState.hasShutdown = true;
        return this._sharedState.activeProcessor.shutdown();
      }
    };
    exports.LoggerProvider = LoggerProvider;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/export/ConsoleLogRecordExporter.js
var require_ConsoleLogRecordExporter = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/export/ConsoleLogRecordExporter.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ConsoleLogRecordExporter = void 0;
    var core_1 = require_src3();
    var ConsoleLogRecordExporter = class {
      static {
        __name(this, "ConsoleLogRecordExporter");
      }
      /**
       * Export logs.
       * @param logs
       * @param resultCallback
       */
      export(logs, resultCallback) {
        this._sendLogRecords(logs, resultCallback);
      }
      /**
       * ForceFlush the exporter.
       * No-op for {@link ConsoleLogRecordExporter}
       */
      async forceFlush() {
      }
      /**
       * Shutdown the exporter.
       */
      async shutdown() {
      }
      /**
       * converts logRecord info into more readable format
       * @param logRecord
       */
      _exportInfo(logRecord) {
        return {
          resource: {
            attributes: logRecord.resource.attributes
          },
          instrumentationScope: logRecord.instrumentationScope,
          timestamp: (0, core_1.hrTimeToMicroseconds)(logRecord.hrTime),
          traceId: logRecord.spanContext?.traceId,
          spanId: logRecord.spanContext?.spanId,
          traceFlags: logRecord.spanContext?.traceFlags,
          severityText: logRecord.severityText,
          severityNumber: logRecord.severityNumber,
          eventName: logRecord.eventName,
          body: logRecord.body,
          attributes: logRecord.attributes
        };
      }
      /**
       * Showing logs  in console
       * @param logRecords
       * @param done
       */
      _sendLogRecords(logRecords, done) {
        for (const logRecord of logRecords) {
          console.dir(this._exportInfo(logRecord), { depth: 3 });
        }
        done?.({ code: core_1.ExportResultCode.SUCCESS });
      }
    };
    exports.ConsoleLogRecordExporter = ConsoleLogRecordExporter;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/export/LogRecordProcessorMetrics.js
var require_LogRecordProcessorMetrics = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/export/LogRecordProcessorMetrics.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.LogRecordProcessorMetrics = void 0;
    var semconv_1 = require_semconv();
    var componentCounter = /* @__PURE__ */ new Map();
    var LogRecordProcessorMetrics = class {
      static {
        __name(this, "LogRecordProcessorMetrics");
      }
      processedLogs;
      queueSize;
      queueSizeCallback;
      standardAttrs;
      droppedAttrs;
      constructor(componentType, meter, queueConfig) {
        const counter = componentCounter.get(componentType) ?? 0;
        componentCounter.set(componentType, counter + 1);
        this.standardAttrs = {
          [semconv_1.ATTR_OTEL_COMPONENT_TYPE]: componentType,
          [semconv_1.ATTR_OTEL_COMPONENT_NAME]: `${componentType}/${counter}`
        };
        this.droppedAttrs = {
          ...this.standardAttrs,
          [semconv_1.ATTR_ERROR_TYPE]: "queue_full"
        };
        this.processedLogs = meter.createCounter(semconv_1.METRIC_OTEL_SDK_PROCESSOR_LOG_PROCESSED, {
          unit: "{log_record}",
          description: "The number of log records for which the processing has finished, either successful or failed."
        });
        if (queueConfig) {
          const { capacity, getQueueSize } = queueConfig;
          const queueCapacity = meter.createUpDownCounter(semconv_1.METRIC_OTEL_SDK_PROCESSOR_LOG_QUEUE_CAPACITY, {
            unit: "{log_record}",
            description: "The maximum number of log records the queue of a given instance of an SDK log processor can hold."
          });
          queueCapacity.add(capacity, this.standardAttrs);
          this.queueSize = meter.createObservableUpDownCounter(semconv_1.METRIC_OTEL_SDK_PROCESSOR_LOG_QUEUE_SIZE, {
            unit: "{log_record}",
            description: "The number of log records in the queue of a given instance of an SDK log processor."
          });
          this.queueSizeCallback = (result) => result.observe(getQueueSize(), this.standardAttrs);
          this.queueSize.addCallback(this.queueSizeCallback);
        }
      }
      dropLogs(count) {
        this.processedLogs.add(count, this.droppedAttrs);
      }
      finishLogs(count, error) {
        if (!error) {
          this.processedLogs.add(count, this.standardAttrs);
          return;
        }
        const attrs = {
          ...this.standardAttrs,
          [semconv_1.ATTR_ERROR_TYPE]: error.name
        };
        this.processedLogs.add(count, attrs);
      }
      shutdown() {
        if (this.queueSize && this.queueSizeCallback) {
          this.queueSize.removeCallback(this.queueSizeCallback);
        }
      }
    };
    exports.LogRecordProcessorMetrics = LogRecordProcessorMetrics;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/export/SimpleLogRecordProcessor.js
var require_SimpleLogRecordProcessor = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/export/SimpleLogRecordProcessor.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SimpleLogRecordProcessor = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src3();
    var semconv_1 = require_semconv();
    var LogRecordProcessorMetrics_1 = require_LogRecordProcessorMetrics();
    var SimpleLogRecordProcessor = class {
      static {
        __name(this, "SimpleLogRecordProcessor");
      }
      _exporter;
      _metrics;
      _shutdownOnce;
      _unresolvedExports;
      constructor(options) {
        this._exporter = options.exporter;
        this._shutdownOnce = new core_1.BindOnceFuture(this._shutdown, this);
        this._unresolvedExports = /* @__PURE__ */ new Set();
        const meter = options?.selfObsMeterProvider ? options.selfObsMeterProvider.getMeter("@opentelemetry/sdk-logs") : (0, api_1.createNoopMeter)();
        this._metrics = new LogRecordProcessorMetrics_1.LogRecordProcessorMetrics(semconv_1.OTEL_COMPONENT_TYPE_VALUE_SIMPLE_LOG_PROCESSOR, meter);
      }
      onEmit(logRecord, _context) {
        if (this._shutdownOnce.isCalled) {
          return;
        }
        const doExport = /* @__PURE__ */ __name(() => core_1.internal._export(this._exporter, [logRecord]).then((result) => {
          this._metrics.finishLogs(1, result.error);
          if (result.code !== core_1.ExportResultCode.SUCCESS) {
            (0, core_1.globalErrorHandler)(result.error ?? new Error(`SimpleLogRecordProcessor: log record export failed (status ${result})`));
          }
        }).catch(core_1.globalErrorHandler), "doExport");
        if (logRecord.resource.asyncAttributesPending) {
          const exportPromise = logRecord.resource.waitForAsyncAttributes?.().then(() => {
            this._unresolvedExports.delete(exportPromise);
            return doExport();
          }, core_1.globalErrorHandler);
          if (exportPromise != null) {
            this._unresolvedExports.add(exportPromise);
          }
        } else {
          void doExport();
        }
      }
      async forceFlush() {
        await Promise.all(Array.from(this._unresolvedExports));
      }
      shutdown() {
        return this._shutdownOnce.call();
      }
      _shutdown() {
        this._metrics.shutdown();
        return this._exporter.shutdown();
      }
    };
    exports.SimpleLogRecordProcessor = SimpleLogRecordProcessor;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/export/InMemoryLogRecordExporter.js
var require_InMemoryLogRecordExporter = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/export/InMemoryLogRecordExporter.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.InMemoryLogRecordExporter = void 0;
    var core_1 = require_src3();
    var InMemoryLogRecordExporter = class {
      static {
        __name(this, "InMemoryLogRecordExporter");
      }
      _finishedLogRecords = [];
      /**
       * Indicates if the exporter has been "shutdown."
       * When false, exported log records will not be stored in-memory.
       */
      _stopped = false;
      export(logs, resultCallback) {
        if (this._stopped) {
          return resultCallback({
            code: core_1.ExportResultCode.FAILED,
            error: new Error("Exporter has been stopped")
          });
        }
        this._finishedLogRecords.push(...logs);
        resultCallback({ code: core_1.ExportResultCode.SUCCESS });
      }
      async shutdown() {
        this._stopped = true;
        this.reset();
      }
      async forceFlush() {
      }
      getFinishedLogRecords() {
        return this._finishedLogRecords;
      }
      reset() {
        this._finishedLogRecords = [];
      }
    };
    exports.InMemoryLogRecordExporter = InMemoryLogRecordExporter;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/export/BatchLogRecordProcessorBase.js
var require_BatchLogRecordProcessorBase = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/export/BatchLogRecordProcessorBase.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BatchLogRecordProcessorBase = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src3();
    var LogRecordProcessorMetrics_1 = require_LogRecordProcessorMetrics();
    var semconv_1 = require_semconv();
    async function waitForResources(logRecords) {
      const pendingResources = [];
      for (let i = 0, len = logRecords.length; i < len; i++) {
        const logRecord = logRecords[i];
        if (logRecord.resource.asyncAttributesPending && logRecord.resource.waitForAsyncAttributes) {
          pendingResources.push(logRecord.resource.waitForAsyncAttributes());
        }
      }
      if (pendingResources != null && pendingResources.length > 0) {
        await Promise.all(pendingResources);
      }
    }
    __name(waitForResources, "waitForResources");
    var ExportOperation = class {
      static {
        __name(this, "ExportOperation");
      }
      _exportCompleted;
      _exportScheduledPromise;
      _metrics;
      _exportScheduledResolve;
      constructor(exporter, logRecords, exportTimeoutMillis, metrics) {
        this._exportScheduledPromise = new Promise((resolve) => {
          this._exportScheduledResolve = resolve;
        });
        this._exportCompleted = this._executeExport(exporter, logRecords, exportTimeoutMillis);
        this._metrics = metrics;
      }
      /** Get the promise that resolves when the export completes */
      get exportCompleted() {
        return this._exportCompleted;
      }
      /** Get the promise that resolves when exporter.export() has been called */
      get exportScheduled() {
        return this._exportScheduledPromise;
      }
      async _executeExport(exporter, logRecords, exportTimeoutMillis) {
        try {
          await waitForResources(logRecords);
          await api_1.context.with((0, core_1.suppressTracing)(api_1.context.active()), async () => {
            return this._exportWithTimeout(exporter, logRecords, exportTimeoutMillis);
          });
        } catch (e) {
          (0, core_1.globalErrorHandler)(e);
          this._exportScheduledResolve();
        }
      }
      async _exportWithTimeout(exporter, logRecords, exportTimeoutMillis) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error("Timeout"));
          }, exportTimeoutMillis);
          exporter.export(logRecords, (result) => {
            this._metrics.finishLogs(logRecords.length, result.error);
            clearTimeout(timer);
            if (result.code === core_1.ExportResultCode.SUCCESS) {
              resolve();
            } else {
              reject(result.error ?? new Error("BatchLogRecordProcessor: log record export failed"));
            }
          });
          this._exportScheduledResolve();
        });
      }
    };
    var BatchLogRecordProcessorBase = class {
      static {
        __name(this, "BatchLogRecordProcessorBase");
      }
      _maxExportBatchSize;
      _maxQueueSize;
      _scheduledDelayMillis;
      _exportTimeoutMillis;
      _exporter;
      _metrics;
      _currentExport = null;
      _finishedLogRecords = [];
      _timer;
      _shutdownOnce;
      _flushing = false;
      constructor(options) {
        this._exporter = options.exporter;
        this._maxExportBatchSize = options.maxExportBatchSize ?? 512;
        this._maxQueueSize = options.maxQueueSize ?? 2048;
        this._scheduledDelayMillis = options.scheduledDelayMillis ?? 1e3;
        this._exportTimeoutMillis = options.exportTimeoutMillis ?? 3e4;
        this._shutdownOnce = new core_1.BindOnceFuture(this._shutdown, this);
        if (this._maxExportBatchSize > this._maxQueueSize) {
          api_1.diag.warn("BatchLogRecordProcessor: maxExportBatchSize must be smaller or equal to maxQueueSize, setting maxExportBatchSize to match maxQueueSize");
          this._maxExportBatchSize = this._maxQueueSize;
        }
        const meter = options?.selfObsMeterProvider ? options.selfObsMeterProvider.getMeter("@opentelemetry/sdk-logs") : (0, api_1.createNoopMeter)();
        this._metrics = new LogRecordProcessorMetrics_1.LogRecordProcessorMetrics(semconv_1.OTEL_COMPONENT_TYPE_VALUE_BATCHING_LOG_PROCESSOR, meter, {
          capacity: this._maxQueueSize,
          getQueueSize: /* @__PURE__ */ __name(() => this._finishedLogRecords.length, "getQueueSize")
        });
      }
      onEmit(logRecord) {
        if (this._shutdownOnce.isCalled) {
          return;
        }
        this._addToBuffer(logRecord);
      }
      forceFlush() {
        if (this._shutdownOnce.isCalled) {
          return this._shutdownOnce.promise;
        }
        return this._flushAll();
      }
      /** Add a LogRecord in the buffer. */
      _addToBuffer(logRecord) {
        if (this._finishedLogRecords.length >= this._maxQueueSize) {
          this._metrics.dropLogs(1);
          return;
        }
        this._finishedLogRecords.push(logRecord);
        this._maybeStartTimer();
      }
      shutdown() {
        return this._shutdownOnce.call();
      }
      async _shutdown() {
        this.onShutdown();
        await this._flushAll();
        this._metrics.shutdown();
        await this._exporter.shutdown();
      }
      /**
       * Send all LogRecords to the exporter respecting the batch size limit
       * This function is used only on forceFlush or shutdown,
       * for all other cases _exportOneBatch should be used
       * */
      async _flushAll() {
        if (this._flushing) {
          return;
        }
        this._flushing = true;
        let toFlush = this._finishedLogRecords;
        this._finishedLogRecords = [];
        this._clearTimer();
        const inFlight = this._currentExport;
        if (inFlight !== null) {
          await this._exporter.forceFlush();
          await inFlight.exportCompleted;
          this._currentExport = null;
        }
        while (toFlush.length > 0) {
          let batch;
          if (toFlush.length <= this._maxExportBatchSize) {
            batch = toFlush;
            toFlush = [];
          } else {
            batch = toFlush.splice(0, this._maxExportBatchSize);
          }
          const exportOp = new ExportOperation(this._exporter, batch, this._exportTimeoutMillis, this._metrics);
          this._currentExport = exportOp;
          try {
            await exportOp.exportScheduled;
            await this._exporter.forceFlush();
            await exportOp.exportCompleted;
          } catch (e) {
            (0, core_1.globalErrorHandler)(e);
          } finally {
            this._currentExport = null;
          }
        }
        this._flushing = false;
        this._maybeStartTimer();
      }
      /**
       * Extracts one batch from the buffer.
       * Returns null if buffer is empty.
       */
      _extractBatch() {
        if (this._finishedLogRecords.length === 0) {
          return null;
        }
        if (this._finishedLogRecords.length <= this._maxExportBatchSize) {
          const batch = this._finishedLogRecords;
          this._finishedLogRecords = [];
          return batch;
        } else {
          return this._finishedLogRecords.splice(0, this._maxExportBatchSize);
        }
      }
      _exportOneBatch() {
        this._clearTimer();
        const logRecords = this._extractBatch();
        if (logRecords === null) {
          return;
        }
        const exportOp = new ExportOperation(this._exporter, logRecords, this._exportTimeoutMillis, this._metrics);
        this._currentExport = exportOp;
        exportOp.exportCompleted.then(() => {
          this._currentExport = null;
          this._maybeStartTimer();
        }).catch((error) => {
          this._currentExport = null;
          (0, core_1.globalErrorHandler)(error);
          this._maybeStartTimer();
        });
      }
      _maybeStartTimer() {
        if (this._shutdownOnce.isCalled) {
          return;
        }
        if (this._flushing) {
          return;
        }
        if (this._finishedLogRecords.length === 0) {
          return;
        }
        if (this._currentExport !== null) {
          return;
        }
        if (this._finishedLogRecords.length >= this._maxExportBatchSize) {
          this._exportOneBatch();
          return;
        }
        if (this._timer !== void 0) {
          return;
        }
        this._timer = setTimeout(() => {
          this._timer = void 0;
          this._exportOneBatch();
        }, this._scheduledDelayMillis);
        if (typeof this._timer !== "number") {
          this._timer.unref();
        }
      }
      _clearTimer() {
        if (this._timer !== void 0) {
          clearTimeout(this._timer);
          this._timer = void 0;
        }
      }
    };
    exports.BatchLogRecordProcessorBase = BatchLogRecordProcessorBase;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/platform/node/export/BatchLogRecordProcessor.js
var require_BatchLogRecordProcessor = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/platform/node/export/BatchLogRecordProcessor.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BatchLogRecordProcessor = void 0;
    var BatchLogRecordProcessorBase_1 = require_BatchLogRecordProcessorBase();
    var BatchLogRecordProcessor2 = class extends BatchLogRecordProcessorBase_1.BatchLogRecordProcessorBase {
      static {
        __name(this, "BatchLogRecordProcessor");
      }
      onShutdown() {
      }
    };
    exports.BatchLogRecordProcessor = BatchLogRecordProcessor2;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/platform/node/index.js
var require_node = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/platform/node/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BatchLogRecordProcessor = void 0;
    var BatchLogRecordProcessor_1 = require_BatchLogRecordProcessor();
    Object.defineProperty(exports, "BatchLogRecordProcessor", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return BatchLogRecordProcessor_1.BatchLogRecordProcessor;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/platform/index.js
var require_platform = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/platform/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BatchLogRecordProcessor = void 0;
    var node_1 = require_node();
    Object.defineProperty(exports, "BatchLogRecordProcessor", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.BatchLogRecordProcessor;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/config/LoggerConfigurators.js
var require_LoggerConfigurators = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/config/LoggerConfigurators.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createLoggerConfigurator = void 0;
    var api_logs_1 = require_src2();
    var DEFAULT_LOGGER_CONFIG = {
      disabled: false,
      minimumSeverity: api_logs_1.SeverityNumber.UNSPECIFIED,
      traceBased: false
    };
    function createLoggerConfigurator(patterns) {
      return (loggerScope) => {
        const loggerName = loggerScope.name;
        for (const { pattern, config } of patterns) {
          if (matchesPattern(loggerName, pattern)) {
            return {
              disabled: config.disabled ?? DEFAULT_LOGGER_CONFIG.disabled,
              minimumSeverity: config.minimumSeverity ?? DEFAULT_LOGGER_CONFIG.minimumSeverity,
              traceBased: config.traceBased ?? DEFAULT_LOGGER_CONFIG.traceBased
            };
          }
        }
        return { ...DEFAULT_LOGGER_CONFIG };
      };
    }
    __name(createLoggerConfigurator, "createLoggerConfigurator");
    exports.createLoggerConfigurator = createLoggerConfigurator;
    function matchesPattern(name, pattern) {
      if (pattern === name) {
        return true;
      }
      if (pattern.includes("*")) {
        const regexPattern = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(name);
      }
      return false;
    }
    __name(matchesPattern, "matchesPattern");
  }
});

// packages/core/node_modules/@opentelemetry/sdk-logs/build/src/index.js
var require_src6 = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-logs/build/src/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createLoggerConfigurator = exports.BatchLogRecordProcessor = exports.InMemoryLogRecordExporter = exports.SimpleLogRecordProcessor = exports.ConsoleLogRecordExporter = exports.LoggerProvider = void 0;
    var LoggerProvider_1 = require_LoggerProvider();
    Object.defineProperty(exports, "LoggerProvider", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return LoggerProvider_1.LoggerProvider;
    }, "get") });
    var ConsoleLogRecordExporter_1 = require_ConsoleLogRecordExporter();
    Object.defineProperty(exports, "ConsoleLogRecordExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ConsoleLogRecordExporter_1.ConsoleLogRecordExporter;
    }, "get") });
    var SimpleLogRecordProcessor_1 = require_SimpleLogRecordProcessor();
    Object.defineProperty(exports, "SimpleLogRecordProcessor", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return SimpleLogRecordProcessor_1.SimpleLogRecordProcessor;
    }, "get") });
    var InMemoryLogRecordExporter_1 = require_InMemoryLogRecordExporter();
    Object.defineProperty(exports, "InMemoryLogRecordExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return InMemoryLogRecordExporter_1.InMemoryLogRecordExporter;
    }, "get") });
    var platform_1 = require_platform();
    Object.defineProperty(exports, "BatchLogRecordProcessor", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.BatchLogRecordProcessor;
    }, "get") });
    var LoggerConfigurators_1 = require_LoggerConfigurators();
    Object.defineProperty(exports, "createLoggerConfigurator", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return LoggerConfigurators_1.createLoggerConfigurator;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/context-async-hooks/build/src/AbstractAsyncHooksContextManager.js
var require_AbstractAsyncHooksContextManager = __commonJS({
  "packages/core/node_modules/@opentelemetry/context-async-hooks/build/src/AbstractAsyncHooksContextManager.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AbstractAsyncHooksContextManager = void 0;
    var events_1 = __require("events");
    var ADD_LISTENER_METHODS = [
      "addListener",
      "on",
      "once",
      "prependListener",
      "prependOnceListener"
    ];
    var AbstractAsyncHooksContextManager = class {
      static {
        __name(this, "AbstractAsyncHooksContextManager");
      }
      /**
       * Binds a the certain context or the active one to the target function and then returns the target
       * @param context A context (span) to be bind to target
       * @param target a function or event emitter. When target or one of its callbacks is called,
       *  the provided context will be used as the active context for the duration of the call.
       */
      bind(context, target) {
        if (target instanceof events_1.EventEmitter) {
          return this._bindEventEmitter(context, target);
        }
        if (typeof target === "function") {
          return this._bindFunction(context, target);
        }
        return target;
      }
      _bindFunction(context, target) {
        const manager = this;
        const contextWrapper = /* @__PURE__ */ __name(function(...args) {
          return manager.with(context, () => target.apply(this, args));
        }, "contextWrapper");
        Object.defineProperty(contextWrapper, "length", {
          enumerable: false,
          configurable: true,
          writable: false,
          value: target.length
        });
        return contextWrapper;
      }
      /**
       * By default, EventEmitter call their callback with their context, which we do
       * not want, instead we will bind a specific context to all callbacks that
       * go through it.
       * @param context the context we want to bind
       * @param ee EventEmitter an instance of EventEmitter to patch
       */
      _bindEventEmitter(context, ee) {
        const map = this._getPatchMap(ee);
        if (map !== void 0)
          return ee;
        this._createPatchMap(ee);
        ADD_LISTENER_METHODS.forEach((methodName) => {
          if (ee[methodName] === void 0)
            return;
          ee[methodName] = this._patchAddListener(ee, ee[methodName], context);
        });
        if (typeof ee.removeListener === "function") {
          ee.removeListener = this._patchRemoveListener(ee, ee.removeListener);
        }
        if (typeof ee.off === "function") {
          ee.off = this._patchRemoveListener(ee, ee.off);
        }
        if (typeof ee.removeAllListeners === "function") {
          ee.removeAllListeners = this._patchRemoveAllListeners(ee, ee.removeAllListeners);
        }
        return ee;
      }
      /**
       * Patch methods that remove a given listener so that we match the "patched"
       * version of that listener (the one that propagate context).
       * @param ee EventEmitter instance
       * @param original reference to the patched method
       */
      _patchRemoveListener(ee, original) {
        const contextManager = this;
        return function(event, listener) {
          const events = contextManager._getPatchMap(ee)?.[event];
          if (events === void 0) {
            return original.call(this, event, listener);
          }
          const patchedListener = events.get(listener);
          return original.call(this, event, patchedListener || listener);
        };
      }
      /**
       * Patch methods that remove all listeners so we remove our
       * internal references for a given event.
       * @param ee EventEmitter instance
       * @param original reference to the patched method
       */
      _patchRemoveAllListeners(ee, original) {
        const contextManager = this;
        return function(event) {
          const map = contextManager._getPatchMap(ee);
          if (map !== void 0) {
            if (arguments.length === 0) {
              contextManager._createPatchMap(ee);
            } else if (map[event] !== void 0) {
              delete map[event];
            }
          }
          return original.apply(this, arguments);
        };
      }
      /**
       * Patch methods on an event emitter instance that can add listeners so we
       * can force them to propagate a given context.
       * @param ee EventEmitter instance
       * @param original reference to the patched method
       * @param [context] context to propagate when calling listeners
       */
      _patchAddListener(ee, original, context) {
        const contextManager = this;
        return function(event, listener) {
          if (contextManager._wrapped) {
            return original.call(this, event, listener);
          }
          let map = contextManager._getPatchMap(ee);
          if (map === void 0) {
            map = contextManager._createPatchMap(ee);
          }
          let listeners = map[event];
          if (listeners === void 0) {
            listeners = /* @__PURE__ */ new WeakMap();
            map[event] = listeners;
          }
          const patchedListener = contextManager.bind(context, listener);
          listeners.set(listener, patchedListener);
          contextManager._wrapped = true;
          try {
            return original.call(this, event, patchedListener);
          } finally {
            contextManager._wrapped = false;
          }
        };
      }
      _createPatchMap(ee) {
        const map = /* @__PURE__ */ Object.create(null);
        ee[this._kOtListeners] = map;
        return map;
      }
      _getPatchMap(ee) {
        return ee[this._kOtListeners];
      }
      _kOtListeners = Symbol("OtListeners");
      _wrapped = false;
    };
    exports.AbstractAsyncHooksContextManager = AbstractAsyncHooksContextManager;
  }
});

// packages/core/node_modules/@opentelemetry/context-async-hooks/build/src/AsyncHooksContextManager.js
var require_AsyncHooksContextManager = __commonJS({
  "packages/core/node_modules/@opentelemetry/context-async-hooks/build/src/AsyncHooksContextManager.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AsyncHooksContextManager = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var asyncHooks = __require("async_hooks");
    var AbstractAsyncHooksContextManager_1 = require_AbstractAsyncHooksContextManager();
    var AsyncHooksContextManager = class extends AbstractAsyncHooksContextManager_1.AbstractAsyncHooksContextManager {
      static {
        __name(this, "AsyncHooksContextManager");
      }
      _asyncHook;
      _contexts = /* @__PURE__ */ new Map();
      _stack = [];
      constructor() {
        super();
        this._asyncHook = asyncHooks.createHook({
          init: this._init.bind(this),
          before: this._before.bind(this),
          after: this._after.bind(this),
          destroy: this._destroy.bind(this),
          promiseResolve: this._destroy.bind(this)
        });
      }
      active() {
        return this._stack[this._stack.length - 1] ?? api_1.ROOT_CONTEXT;
      }
      with(context, fn, thisArg, ...args) {
        this._enterContext(context);
        try {
          return fn.call(thisArg, ...args);
        } finally {
          this._exitContext();
        }
      }
      enable() {
        this._asyncHook.enable();
        return this;
      }
      disable() {
        this._asyncHook.disable();
        this._contexts.clear();
        this._stack = [];
        return this;
      }
      /**
       * Init hook will be called when userland create a async context, setting the
       * context as the current one if it exist.
       * @param uid id of the async context
       * @param type the resource type
       */
      _init(uid, type) {
        if (type === "TIMERWRAP")
          return;
        const context = this._stack[this._stack.length - 1];
        if (context !== void 0) {
          this._contexts.set(uid, context);
        }
      }
      /**
       * Destroy hook will be called when a given context is no longer used so we can
       * remove its attached context.
       * @param uid uid of the async context
       */
      _destroy(uid) {
        this._contexts.delete(uid);
      }
      /**
       * Before hook is called just before executing a async context.
       * @param uid uid of the async context
       */
      _before(uid) {
        const context = this._contexts.get(uid);
        if (context !== void 0) {
          this._enterContext(context);
        }
      }
      /**
       * After hook is called just after completing the execution of a async context.
       */
      _after() {
        this._exitContext();
      }
      /**
       * Set the given context as active
       */
      _enterContext(context) {
        this._stack.push(context);
      }
      /**
       * Remove the context at the root of the stack
       */
      _exitContext() {
        this._stack.pop();
      }
    };
    exports.AsyncHooksContextManager = AsyncHooksContextManager;
  }
});

// packages/core/node_modules/@opentelemetry/context-async-hooks/build/src/AsyncLocalStorageContextManager.js
var require_AsyncLocalStorageContextManager = __commonJS({
  "packages/core/node_modules/@opentelemetry/context-async-hooks/build/src/AsyncLocalStorageContextManager.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AsyncLocalStorageContextManager = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var async_hooks_1 = __require("async_hooks");
    var AbstractAsyncHooksContextManager_1 = require_AbstractAsyncHooksContextManager();
    var AsyncLocalStorageContextManager = class extends AbstractAsyncHooksContextManager_1.AbstractAsyncHooksContextManager {
      static {
        __name(this, "AsyncLocalStorageContextManager");
      }
      _asyncLocalStorage;
      constructor() {
        super();
        this._asyncLocalStorage = new async_hooks_1.AsyncLocalStorage();
      }
      active() {
        return this._asyncLocalStorage.getStore() ?? api_1.ROOT_CONTEXT;
      }
      with(context, fn, thisArg, ...args) {
        const cb = thisArg == null ? fn : fn.bind(thisArg);
        return this._asyncLocalStorage.run(context, cb, ...args);
      }
      enable() {
        return this;
      }
      disable() {
        this._asyncLocalStorage.disable();
        return this;
      }
    };
    exports.AsyncLocalStorageContextManager = AsyncLocalStorageContextManager;
  }
});

// packages/core/node_modules/@opentelemetry/context-async-hooks/build/src/index.js
var require_src7 = __commonJS({
  "packages/core/node_modules/@opentelemetry/context-async-hooks/build/src/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AsyncLocalStorageContextManager = exports.AsyncHooksContextManager = void 0;
    var AsyncHooksContextManager_1 = require_AsyncHooksContextManager();
    Object.defineProperty(exports, "AsyncHooksContextManager", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return AsyncHooksContextManager_1.AsyncHooksContextManager;
    }, "get") });
    var AsyncLocalStorageContextManager_1 = require_AsyncLocalStorageContextManager();
    Object.defineProperty(exports, "AsyncLocalStorageContextManager", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return AsyncLocalStorageContextManager_1.AsyncLocalStorageContextManager;
    }, "get") });
  }
});

// node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/default-service-name.js
var require_default_service_name = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/default-service-name.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports._clearDefaultServiceNameCache = exports.defaultServiceName = void 0;
    var serviceName;
    function defaultServiceName() {
      if (serviceName === void 0) {
        try {
          const argv0 = globalThis.process.argv0;
          serviceName = argv0 ? `unknown_service:${argv0}` : "unknown_service";
        } catch {
          serviceName = "unknown_service";
        }
      }
      return serviceName;
    }
    __name(defaultServiceName, "defaultServiceName");
    exports.defaultServiceName = defaultServiceName;
    function _clearDefaultServiceNameCache() {
      serviceName = void 0;
    }
    __name(_clearDefaultServiceNameCache, "_clearDefaultServiceNameCache");
    exports._clearDefaultServiceNameCache = _clearDefaultServiceNameCache;
  }
});

// node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/utils.js
var require_utils2 = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/utils.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isPromiseLike = void 0;
    var isPromiseLike = /* @__PURE__ */ __name((val) => {
      return val !== null && typeof val === "object" && typeof val.then === "function";
    }, "isPromiseLike");
    exports.isPromiseLike = isPromiseLike;
  }
});

// node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/ResourceImpl.js
var require_ResourceImpl = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/ResourceImpl.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.defaultResource = exports.emptyResource = exports.resourceFromDetectedResource = exports.resourceFromAttributes = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src3();
    var semantic_conventions_1 = (init_esm2(), __toCommonJS(esm_exports2));
    var default_service_name_1 = require_default_service_name();
    var utils_1 = require_utils2();
    var ResourceImpl = class _ResourceImpl {
      static {
        __name(this, "ResourceImpl");
      }
      _rawAttributes;
      _asyncAttributesPending = false;
      _schemaUrl;
      _memoizedAttributes;
      static FromAttributeList(attributes, options) {
        const res = new _ResourceImpl({}, options);
        res._rawAttributes = guardedRawAttributes(attributes);
        res._asyncAttributesPending = attributes.filter(([_, val]) => (0, utils_1.isPromiseLike)(val)).length > 0;
        return res;
      }
      constructor(resource, options) {
        const attributes = resource.attributes ?? {};
        this._rawAttributes = Object.entries(attributes).map(([k, v]) => {
          if ((0, utils_1.isPromiseLike)(v)) {
            this._asyncAttributesPending = true;
          }
          return [k, v];
        });
        this._rawAttributes = guardedRawAttributes(this._rawAttributes);
        this._schemaUrl = validateSchemaUrl(options?.schemaUrl);
      }
      get asyncAttributesPending() {
        return this._asyncAttributesPending;
      }
      async waitForAsyncAttributes() {
        if (!this.asyncAttributesPending) {
          return;
        }
        for (let i = 0; i < this._rawAttributes.length; i++) {
          const [k, v] = this._rawAttributes[i];
          this._rawAttributes[i] = [k, (0, utils_1.isPromiseLike)(v) ? await v : v];
        }
        this._asyncAttributesPending = false;
      }
      get attributes() {
        if (this.asyncAttributesPending) {
          api_1.diag.error("Accessing resource attributes before async attributes settled");
        }
        if (this._memoizedAttributes) {
          return this._memoizedAttributes;
        }
        const attrs = {};
        for (const [k, v] of this._rawAttributes) {
          if ((0, utils_1.isPromiseLike)(v)) {
            api_1.diag.debug(`Unsettled resource attribute ${k} skipped`);
            continue;
          }
          if (v != null) {
            attrs[k] ??= v;
          }
        }
        if (!this._asyncAttributesPending) {
          this._memoizedAttributes = attrs;
        }
        return attrs;
      }
      getRawAttributes() {
        return this._rawAttributes;
      }
      get schemaUrl() {
        return this._schemaUrl;
      }
      merge(resource) {
        if (resource == null)
          return this;
        const mergedSchemaUrl = mergeSchemaUrl(this, resource);
        const mergedOptions = mergedSchemaUrl ? { schemaUrl: mergedSchemaUrl } : void 0;
        return _ResourceImpl.FromAttributeList([...resource.getRawAttributes(), ...this.getRawAttributes()], mergedOptions);
      }
    };
    function resourceFromAttributes2(attributes, options) {
      return ResourceImpl.FromAttributeList(Object.entries(attributes), options);
    }
    __name(resourceFromAttributes2, "resourceFromAttributes");
    exports.resourceFromAttributes = resourceFromAttributes2;
    function resourceFromDetectedResource(detectedResource, options) {
      return new ResourceImpl(detectedResource, options);
    }
    __name(resourceFromDetectedResource, "resourceFromDetectedResource");
    exports.resourceFromDetectedResource = resourceFromDetectedResource;
    function emptyResource() {
      return resourceFromAttributes2({});
    }
    __name(emptyResource, "emptyResource");
    exports.emptyResource = emptyResource;
    function defaultResource() {
      return resourceFromAttributes2({
        [semantic_conventions_1.ATTR_SERVICE_NAME]: (0, default_service_name_1.defaultServiceName)(),
        [semantic_conventions_1.ATTR_TELEMETRY_SDK_LANGUAGE]: core_1.SDK_INFO[semantic_conventions_1.ATTR_TELEMETRY_SDK_LANGUAGE],
        [semantic_conventions_1.ATTR_TELEMETRY_SDK_NAME]: core_1.SDK_INFO[semantic_conventions_1.ATTR_TELEMETRY_SDK_NAME],
        [semantic_conventions_1.ATTR_TELEMETRY_SDK_VERSION]: core_1.SDK_INFO[semantic_conventions_1.ATTR_TELEMETRY_SDK_VERSION]
      });
    }
    __name(defaultResource, "defaultResource");
    exports.defaultResource = defaultResource;
    function guardedRawAttributes(attributes) {
      return attributes.map(([k, v]) => {
        if ((0, utils_1.isPromiseLike)(v)) {
          return [
            k,
            v.catch((err) => {
              api_1.diag.debug("promise rejection for resource attribute: %s - %s", k, err);
              return void 0;
            })
          ];
        }
        return [k, v];
      });
    }
    __name(guardedRawAttributes, "guardedRawAttributes");
    function validateSchemaUrl(schemaUrl) {
      if (typeof schemaUrl === "string" || schemaUrl === void 0) {
        return schemaUrl;
      }
      api_1.diag.warn("Schema URL must be string or undefined, got %s. Schema URL will be ignored.", schemaUrl);
      return void 0;
    }
    __name(validateSchemaUrl, "validateSchemaUrl");
    function mergeSchemaUrl(old, updating) {
      const oldSchemaUrl = old?.schemaUrl;
      const updatingSchemaUrl = updating?.schemaUrl;
      const isOldEmpty = oldSchemaUrl === void 0 || oldSchemaUrl === "";
      const isUpdatingEmpty = updatingSchemaUrl === void 0 || updatingSchemaUrl === "";
      if (isOldEmpty) {
        return updatingSchemaUrl;
      }
      if (isUpdatingEmpty) {
        return oldSchemaUrl;
      }
      if (oldSchemaUrl === updatingSchemaUrl) {
        return oldSchemaUrl;
      }
      api_1.diag.warn('Schema URL merge conflict: old resource has "%s", updating resource has "%s". Resulting resource will have undefined Schema URL.', oldSchemaUrl, updatingSchemaUrl);
      return void 0;
    }
    __name(mergeSchemaUrl, "mergeSchemaUrl");
  }
});

// node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detect-resources.js
var require_detect_resources = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detect-resources.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.detectResources = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var ResourceImpl_1 = require_ResourceImpl();
    var detectResources = /* @__PURE__ */ __name((config = {}) => {
      const resources = (config.detectors || []).map((d) => {
        try {
          const resource = (0, ResourceImpl_1.resourceFromDetectedResource)(d.detect(config));
          api_1.diag.debug(`${d.constructor.name} found resource.`, resource);
          return resource;
        } catch (e) {
          api_1.diag.debug(`${d.constructor.name} failed: ${e.message}`);
          return (0, ResourceImpl_1.emptyResource)();
        }
      });
      return resources.reduce((acc, resource) => acc.merge(resource), (0, ResourceImpl_1.emptyResource)());
    }, "detectResources");
    exports.detectResources = detectResources;
  }
});

// node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/EnvDetector.js
var require_EnvDetector = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/EnvDetector.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.envDetector = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var semantic_conventions_1 = (init_esm2(), __toCommonJS(esm_exports2));
    var core_1 = require_src3();
    var EnvDetector = class {
      static {
        __name(this, "EnvDetector");
      }
      // Type, attribute keys, and attribute values should not exceed 256 characters.
      _MAX_LENGTH = 255;
      // OTEL_RESOURCE_ATTRIBUTES is a comma-separated list of attributes.
      _COMMA_SEPARATOR = ",";
      // OTEL_RESOURCE_ATTRIBUTES contains key value pair separated by '='.
      _LABEL_KEY_VALUE_SPLITTER = "=";
      /**
       * Returns a {@link Resource} populated with attributes from the
       * OTEL_RESOURCE_ATTRIBUTES environment variable. Note this is an async
       * function to conform to the Detector interface.
       *
       * @param config The resource detection config
       */
      detect(_config) {
        const attributes = {};
        const rawAttributes = (0, core_1.getStringFromEnv)("OTEL_RESOURCE_ATTRIBUTES");
        const serviceName = (0, core_1.getStringFromEnv)("OTEL_SERVICE_NAME");
        if (rawAttributes) {
          try {
            const parsedAttributes = this._parseResourceAttributes(rawAttributes);
            Object.assign(attributes, parsedAttributes);
          } catch (e) {
            api_1.diag.debug(`EnvDetector failed: ${e instanceof Error ? e.message : e}`);
          }
        }
        if (serviceName) {
          attributes[semantic_conventions_1.ATTR_SERVICE_NAME] = serviceName;
        }
        return { attributes };
      }
      /**
       * Creates an attribute map from the OTEL_RESOURCE_ATTRIBUTES environment
       * variable.
       *
       * OTEL_RESOURCE_ATTRIBUTES: A comma-separated list of attributes in the
       * format "key1=value1,key2=value2". The ',' and '=' characters in keys
       * and values MUST be percent-encoded. Other characters MAY be percent-encoded.
       *
       * Per the spec, on any error (e.g., decoding failure), the entire environment
       * variable value is discarded.
       *
       * @param rawEnvAttributes The resource attributes as a comma-separated list
       * of key/value pairs.
       * @returns The parsed resource attributes.
       * @throws Error if parsing fails (caller handles by discarding all attributes)
       */
      _parseResourceAttributes(rawEnvAttributes) {
        if (!rawEnvAttributes)
          return {};
        const attributes = {};
        const rawAttributes = rawEnvAttributes.split(this._COMMA_SEPARATOR).filter((attr) => attr.trim() !== "");
        for (const rawAttribute of rawAttributes) {
          const keyValuePair = rawAttribute.split(this._LABEL_KEY_VALUE_SPLITTER);
          if (keyValuePair.length !== 2) {
            throw new Error(`Invalid format for OTEL_RESOURCE_ATTRIBUTES: "${rawAttribute}". Expected format: key=value. The ',' and '=' characters must be percent-encoded in keys and values.`);
          }
          const [rawKey, rawValue] = keyValuePair;
          const key = rawKey.trim();
          const value = rawValue.trim();
          if (key.length === 0) {
            throw new Error(`Invalid OTEL_RESOURCE_ATTRIBUTES: empty attribute key in "${rawAttribute}".`);
          }
          let decodedKey;
          let decodedValue;
          try {
            decodedKey = decodeURIComponent(key);
            decodedValue = decodeURIComponent(value);
          } catch (e) {
            throw new Error(`Failed to percent-decode OTEL_RESOURCE_ATTRIBUTES entry "${rawAttribute}": ${e instanceof Error ? e.message : e}`, { cause: e });
          }
          if (decodedKey.length > this._MAX_LENGTH) {
            throw new Error(`Attribute key exceeds the maximum length of ${this._MAX_LENGTH} characters: "${decodedKey}".`);
          }
          if (decodedValue.length > this._MAX_LENGTH) {
            throw new Error(`Attribute value exceeds the maximum length of ${this._MAX_LENGTH} characters for key "${decodedKey}".`);
          }
          attributes[decodedKey] = decodedValue;
        }
        return attributes;
      }
    };
    exports.envDetector = new EnvDetector();
  }
});

// node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/semconv.js
var require_semconv2 = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/semconv.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ATTR_WEBENGINE_VERSION = exports.ATTR_WEBENGINE_NAME = exports.ATTR_WEBENGINE_DESCRIPTION = exports.ATTR_SERVICE_NAMESPACE = exports.ATTR_SERVICE_INSTANCE_ID = exports.ATTR_PROCESS_RUNTIME_VERSION = exports.ATTR_PROCESS_RUNTIME_NAME = exports.ATTR_PROCESS_RUNTIME_DESCRIPTION = exports.ATTR_PROCESS_PID = exports.ATTR_PROCESS_OWNER = exports.ATTR_PROCESS_EXECUTABLE_PATH = exports.ATTR_PROCESS_EXECUTABLE_NAME = exports.ATTR_PROCESS_COMMAND_ARGS = exports.ATTR_PROCESS_COMMAND = exports.ATTR_OS_VERSION = exports.ATTR_OS_TYPE = exports.ATTR_K8S_POD_NAME = exports.ATTR_K8S_NAMESPACE_NAME = exports.ATTR_K8S_DEPLOYMENT_NAME = exports.ATTR_K8S_CLUSTER_NAME = exports.ATTR_HOST_TYPE = exports.ATTR_HOST_NAME = exports.ATTR_HOST_IMAGE_VERSION = exports.ATTR_HOST_IMAGE_NAME = exports.ATTR_HOST_IMAGE_ID = exports.ATTR_HOST_ID = exports.ATTR_HOST_ARCH = exports.ATTR_CONTAINER_NAME = exports.ATTR_CONTAINER_IMAGE_TAGS = exports.ATTR_CONTAINER_IMAGE_NAME = exports.ATTR_CONTAINER_ID = exports.ATTR_CLOUD_REGION = exports.ATTR_CLOUD_PROVIDER = exports.ATTR_CLOUD_AVAILABILITY_ZONE = exports.ATTR_CLOUD_ACCOUNT_ID = void 0;
    exports.ATTR_CLOUD_ACCOUNT_ID = "cloud.account.id";
    exports.ATTR_CLOUD_AVAILABILITY_ZONE = "cloud.availability_zone";
    exports.ATTR_CLOUD_PROVIDER = "cloud.provider";
    exports.ATTR_CLOUD_REGION = "cloud.region";
    exports.ATTR_CONTAINER_ID = "container.id";
    exports.ATTR_CONTAINER_IMAGE_NAME = "container.image.name";
    exports.ATTR_CONTAINER_IMAGE_TAGS = "container.image.tags";
    exports.ATTR_CONTAINER_NAME = "container.name";
    exports.ATTR_HOST_ARCH = "host.arch";
    exports.ATTR_HOST_ID = "host.id";
    exports.ATTR_HOST_IMAGE_ID = "host.image.id";
    exports.ATTR_HOST_IMAGE_NAME = "host.image.name";
    exports.ATTR_HOST_IMAGE_VERSION = "host.image.version";
    exports.ATTR_HOST_NAME = "host.name";
    exports.ATTR_HOST_TYPE = "host.type";
    exports.ATTR_K8S_CLUSTER_NAME = "k8s.cluster.name";
    exports.ATTR_K8S_DEPLOYMENT_NAME = "k8s.deployment.name";
    exports.ATTR_K8S_NAMESPACE_NAME = "k8s.namespace.name";
    exports.ATTR_K8S_POD_NAME = "k8s.pod.name";
    exports.ATTR_OS_TYPE = "os.type";
    exports.ATTR_OS_VERSION = "os.version";
    exports.ATTR_PROCESS_COMMAND = "process.command";
    exports.ATTR_PROCESS_COMMAND_ARGS = "process.command_args";
    exports.ATTR_PROCESS_EXECUTABLE_NAME = "process.executable.name";
    exports.ATTR_PROCESS_EXECUTABLE_PATH = "process.executable.path";
    exports.ATTR_PROCESS_OWNER = "process.owner";
    exports.ATTR_PROCESS_PID = "process.pid";
    exports.ATTR_PROCESS_RUNTIME_DESCRIPTION = "process.runtime.description";
    exports.ATTR_PROCESS_RUNTIME_NAME = "process.runtime.name";
    exports.ATTR_PROCESS_RUNTIME_VERSION = "process.runtime.version";
    exports.ATTR_SERVICE_INSTANCE_ID = "service.instance.id";
    exports.ATTR_SERVICE_NAMESPACE = "service.namespace";
    exports.ATTR_WEBENGINE_DESCRIPTION = "webengine.description";
    exports.ATTR_WEBENGINE_NAME = "webengine.name";
    exports.ATTR_WEBENGINE_VERSION = "webengine.version";
  }
});

// node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/getMachineId.js
var require_getMachineId = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/getMachineId.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getMachineId = void 0;
    var process2 = __require("process");
    var getMachineIdImpl;
    async function getMachineId() {
      if (!getMachineIdImpl) {
        switch (process2.platform) {
          case "darwin":
            getMachineIdImpl = (await import("./getMachineId-darwin-RNJLJUXY.js")).getMachineId;
            break;
          case "linux":
            getMachineIdImpl = (await import("./getMachineId-linux-UEVRAIAB.js")).getMachineId;
            break;
          case "freebsd":
            getMachineIdImpl = (await import("./getMachineId-bsd-FBOAYNSY.js")).getMachineId;
            break;
          case "win32":
            getMachineIdImpl = (await import("./getMachineId-win-LRVGMHLW.js")).getMachineId;
            break;
          default:
            getMachineIdImpl = (await import("./getMachineId-unsupported-FWXYJ7HW.js")).getMachineId;
            break;
        }
      }
      return getMachineIdImpl();
    }
    __name(getMachineId, "getMachineId");
    exports.getMachineId = getMachineId;
  }
});

// node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/utils.js
var require_utils3 = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/utils.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.normalizeType = exports.normalizeArch = void 0;
    var normalizeArch = /* @__PURE__ */ __name((nodeArchString) => {
      switch (nodeArchString) {
        case "arm":
          return "arm32";
        case "ppc":
          return "ppc32";
        case "x64":
          return "amd64";
        default:
          return nodeArchString;
      }
    }, "normalizeArch");
    exports.normalizeArch = normalizeArch;
    var normalizeType = /* @__PURE__ */ __name((nodePlatform) => {
      switch (nodePlatform) {
        case "sunos":
          return "solaris";
        case "win32":
          return "windows";
        default:
          return nodePlatform;
      }
    }, "normalizeType");
    exports.normalizeType = normalizeType;
  }
});

// node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/HostDetector.js
var require_HostDetector = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/HostDetector.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.hostDetector = void 0;
    var semconv_1 = require_semconv2();
    var os_1 = __require("os");
    var getMachineId_1 = require_getMachineId();
    var utils_1 = require_utils3();
    var HostDetector = class {
      static {
        __name(this, "HostDetector");
      }
      detect(_config) {
        const attributes = {
          [semconv_1.ATTR_HOST_NAME]: (0, os_1.hostname)(),
          [semconv_1.ATTR_HOST_ARCH]: (0, utils_1.normalizeArch)((0, os_1.arch)()),
          [semconv_1.ATTR_HOST_ID]: (0, getMachineId_1.getMachineId)()
        };
        return { attributes };
      }
    };
    exports.hostDetector = new HostDetector();
  }
});

// node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/OSDetector.js
var require_OSDetector = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/OSDetector.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.osDetector = void 0;
    var semconv_1 = require_semconv2();
    var os_1 = __require("os");
    var utils_1 = require_utils3();
    var OSDetector = class {
      static {
        __name(this, "OSDetector");
      }
      detect(_config) {
        const attributes = {
          [semconv_1.ATTR_OS_TYPE]: (0, utils_1.normalizeType)((0, os_1.platform)()),
          [semconv_1.ATTR_OS_VERSION]: (0, os_1.release)()
        };
        return { attributes };
      }
    };
    exports.osDetector = new OSDetector();
  }
});

// node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/ProcessDetector.js
var require_ProcessDetector = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/ProcessDetector.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.processDetector = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var semconv_1 = require_semconv2();
    var os = __require("os");
    var ProcessDetector = class {
      static {
        __name(this, "ProcessDetector");
      }
      detect(_config) {
        const attributes = {
          [semconv_1.ATTR_PROCESS_PID]: process.pid,
          [semconv_1.ATTR_PROCESS_EXECUTABLE_NAME]: process.title,
          [semconv_1.ATTR_PROCESS_EXECUTABLE_PATH]: process.execPath,
          [semconv_1.ATTR_PROCESS_COMMAND_ARGS]: [
            process.argv[0],
            ...process.execArgv,
            ...process.argv.slice(1)
          ],
          [semconv_1.ATTR_PROCESS_RUNTIME_VERSION]: process.versions.node,
          [semconv_1.ATTR_PROCESS_RUNTIME_NAME]: "nodejs",
          [semconv_1.ATTR_PROCESS_RUNTIME_DESCRIPTION]: "Node.js"
        };
        if (process.argv.length > 1) {
          attributes[semconv_1.ATTR_PROCESS_COMMAND] = process.argv[1];
        }
        try {
          const userInfo = os.userInfo();
          attributes[semconv_1.ATTR_PROCESS_OWNER] = userInfo.username;
        } catch (e) {
          api_1.diag.debug(`error obtaining process owner: ${e}`);
        }
        return { attributes };
      }
    };
    exports.processDetector = new ProcessDetector();
  }
});

// node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/ServiceInstanceIdDetector.js
var require_ServiceInstanceIdDetector = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/ServiceInstanceIdDetector.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.serviceInstanceIdDetector = void 0;
    var semconv_1 = require_semconv2();
    var crypto_1 = __require("crypto");
    var ServiceInstanceIdDetector = class {
      static {
        __name(this, "ServiceInstanceIdDetector");
      }
      detect(_config) {
        return {
          attributes: {
            [semconv_1.ATTR_SERVICE_INSTANCE_ID]: (0, crypto_1.randomUUID)()
          }
        };
      }
    };
    exports.serviceInstanceIdDetector = new ServiceInstanceIdDetector();
  }
});

// node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/index.js
var require_node2 = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.serviceInstanceIdDetector = exports.processDetector = exports.osDetector = exports.hostDetector = void 0;
    var HostDetector_1 = require_HostDetector();
    Object.defineProperty(exports, "hostDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return HostDetector_1.hostDetector;
    }, "get") });
    var OSDetector_1 = require_OSDetector();
    Object.defineProperty(exports, "osDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return OSDetector_1.osDetector;
    }, "get") });
    var ProcessDetector_1 = require_ProcessDetector();
    Object.defineProperty(exports, "processDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ProcessDetector_1.processDetector;
    }, "get") });
    var ServiceInstanceIdDetector_1 = require_ServiceInstanceIdDetector();
    Object.defineProperty(exports, "serviceInstanceIdDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ServiceInstanceIdDetector_1.serviceInstanceIdDetector;
    }, "get") });
  }
});

// node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/platform/index.js
var require_platform2 = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/platform/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.serviceInstanceIdDetector = exports.processDetector = exports.osDetector = exports.hostDetector = void 0;
    var node_1 = require_node2();
    Object.defineProperty(exports, "hostDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.hostDetector;
    }, "get") });
    Object.defineProperty(exports, "osDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.osDetector;
    }, "get") });
    Object.defineProperty(exports, "processDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.processDetector;
    }, "get") });
    Object.defineProperty(exports, "serviceInstanceIdDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.serviceInstanceIdDetector;
    }, "get") });
  }
});

// node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/NoopDetector.js
var require_NoopDetector = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/NoopDetector.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.noopDetector = exports.NoopDetector = void 0;
    var NoopDetector = class {
      static {
        __name(this, "NoopDetector");
      }
      detect() {
        return {
          attributes: {}
        };
      }
    };
    exports.NoopDetector = NoopDetector;
    exports.noopDetector = new NoopDetector();
  }
});

// node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/index.js
var require_detectors = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/detectors/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.noopDetector = exports.serviceInstanceIdDetector = exports.processDetector = exports.osDetector = exports.hostDetector = exports.envDetector = void 0;
    var EnvDetector_1 = require_EnvDetector();
    Object.defineProperty(exports, "envDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return EnvDetector_1.envDetector;
    }, "get") });
    var platform_1 = require_platform2();
    Object.defineProperty(exports, "hostDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.hostDetector;
    }, "get") });
    Object.defineProperty(exports, "osDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.osDetector;
    }, "get") });
    Object.defineProperty(exports, "processDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.processDetector;
    }, "get") });
    Object.defineProperty(exports, "serviceInstanceIdDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.serviceInstanceIdDetector;
    }, "get") });
    var NoopDetector_1 = require_NoopDetector();
    Object.defineProperty(exports, "noopDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return NoopDetector_1.noopDetector;
    }, "get") });
  }
});

// node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/index.js
var require_src8 = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/node_modules/@opentelemetry/resources/build/src/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.defaultServiceName = exports.emptyResource = exports.defaultResource = exports.resourceFromAttributes = exports.serviceInstanceIdDetector = exports.processDetector = exports.osDetector = exports.hostDetector = exports.envDetector = exports.detectResources = void 0;
    var detect_resources_1 = require_detect_resources();
    Object.defineProperty(exports, "detectResources", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return detect_resources_1.detectResources;
    }, "get") });
    var detectors_1 = require_detectors();
    Object.defineProperty(exports, "envDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return detectors_1.envDetector;
    }, "get") });
    Object.defineProperty(exports, "hostDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return detectors_1.hostDetector;
    }, "get") });
    Object.defineProperty(exports, "osDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return detectors_1.osDetector;
    }, "get") });
    Object.defineProperty(exports, "processDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return detectors_1.processDetector;
    }, "get") });
    Object.defineProperty(exports, "serviceInstanceIdDetector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return detectors_1.serviceInstanceIdDetector;
    }, "get") });
    var ResourceImpl_1 = require_ResourceImpl();
    Object.defineProperty(exports, "resourceFromAttributes", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ResourceImpl_1.resourceFromAttributes;
    }, "get") });
    Object.defineProperty(exports, "defaultResource", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ResourceImpl_1.defaultResource;
    }, "get") });
    Object.defineProperty(exports, "emptyResource", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ResourceImpl_1.emptyResource;
    }, "get") });
    var default_service_name_1 = require_default_service_name();
    Object.defineProperty(exports, "defaultServiceName", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return default_service_name_1.defaultServiceName;
    }, "get") });
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/enums.js
var require_enums = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/enums.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ExceptionEventName = void 0;
    exports.ExceptionEventName = "exception";
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/inspect.js
var require_inspect = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/inspect.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.formatInspect = exports.settledResourceAttributes = exports.inspectCustom = void 0;
    exports.inspectCustom = Symbol.for("nodejs.util.inspect.custom");
    function settledResourceAttributes(resource) {
      const attrs = {};
      for (const [k, v] of resource.getRawAttributes()) {
        if (typeof v?.then === "function") {
          continue;
        }
        if (v != null) {
          attrs[k] ??= v;
        }
      }
      return attrs;
    }
    __name(settledResourceAttributes, "settledResourceAttributes");
    exports.settledResourceAttributes = settledResourceAttributes;
    function formatInspect(className, payload, depth, options, inspect) {
      if (typeof depth === "number" && depth < 0) {
        const tag = `[${className}]`;
        return options?.stylize ? options.stylize(tag, "special") : tag;
      }
      if (typeof inspect !== "function" || !options) {
        return payload;
      }
      const childOptions = {
        ...options,
        depth: options.depth == null ? options.depth : options.depth - 1
      };
      return `${className} ${inspect(payload, childOptions)}`;
    }
    __name(formatInspect, "formatInspect");
    exports.formatInspect = formatInspect;
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/Span.js
var require_Span = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/Span.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SpanImpl = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src3();
    var semantic_conventions_1 = (init_esm2(), __toCommonJS(esm_exports2));
    var enums_1 = require_enums();
    var inspect_1 = require_inspect();
    var SpanImpl = class {
      static {
        __name(this, "SpanImpl");
      }
      // Below properties are included to implement ReadableSpan for export
      // purposes but are not intended to be written-to directly.
      _spanContext;
      kind;
      parentSpanContext;
      attributes = {};
      links = [];
      events = [];
      startTime;
      resource;
      instrumentationScope;
      _droppedAttributesCount = 0;
      _droppedEventsCount = 0;
      _droppedLinksCount = 0;
      _attributesCount = 0;
      name;
      status = {
        code: api_1.SpanStatusCode.UNSET
      };
      endTime = [0, 0];
      _ended = false;
      _duration = [-1, -1];
      _spanProcessor;
      _spanLimits;
      _attributeValueLengthLimit;
      _recordEndMetrics;
      _performanceStartTime;
      _performanceOffset;
      _startTimeProvided;
      /**
       * Constructs a new SpanImpl instance.
       */
      constructor(opts) {
        const now = Date.now();
        this._spanContext = opts.spanContext;
        this._performanceStartTime = core_1.otperformance.now();
        this._performanceOffset = now - (this._performanceStartTime + core_1.otperformance.timeOrigin);
        this._startTimeProvided = opts.startTime != null;
        this._spanLimits = opts.spanLimits;
        this._attributeValueLengthLimit = this._spanLimits.attributeValueLengthLimit ?? 0;
        this._spanProcessor = opts.spanProcessor;
        this.name = opts.name;
        this.parentSpanContext = opts.parentSpanContext;
        this.kind = opts.kind;
        if (opts.links) {
          for (const link of opts.links) {
            this.addLink(link);
          }
        }
        this.startTime = this._getTime(opts.startTime ?? now);
        this.resource = opts.resource;
        this.instrumentationScope = opts.scope;
        this._recordEndMetrics = opts.recordEndMetrics;
        if (opts.attributes != null) {
          this.setAttributes(opts.attributes);
        }
        this._spanProcessor.onStart(this, opts.context);
      }
      spanContext() {
        return this._spanContext;
      }
      setAttribute(key, value) {
        if (value == null || this._isSpanEnded())
          return this;
        if (key.length === 0) {
          api_1.diag.warn(`Invalid attribute key: ${key}`);
          return this;
        }
        if (!(0, core_1.isAttributeValue)(value)) {
          api_1.diag.warn(`Invalid attribute value set for key: ${key}`);
          return this;
        }
        const { attributeCountLimit } = this._spanLimits;
        const isNewKey = !Object.prototype.hasOwnProperty.call(this.attributes, key);
        if (attributeCountLimit !== void 0 && this._attributesCount >= attributeCountLimit && isNewKey) {
          this._droppedAttributesCount++;
          return this;
        }
        this.attributes[key] = this._truncateToSize(value);
        if (isNewKey) {
          this._attributesCount++;
        }
        return this;
      }
      setAttributes(attributes) {
        for (const key in attributes) {
          if (Object.prototype.hasOwnProperty.call(attributes, key)) {
            this.setAttribute(key, attributes[key]);
          }
        }
        return this;
      }
      /**
       *
       * @param name Span Name
       * @param [attributesOrStartTime] Span attributes or start time
       *     if type is {@type TimeInput} and 3rd param is undefined
       * @param [timeStamp] Specified time stamp for the event
       */
      addEvent(name, attributesOrStartTime, timeStamp) {
        if (this._isSpanEnded())
          return this;
        const { eventCountLimit } = this._spanLimits;
        if (eventCountLimit === 0) {
          api_1.diag.warn("No events allowed.");
          this._droppedEventsCount++;
          return this;
        }
        if (eventCountLimit !== void 0 && this.events.length >= eventCountLimit) {
          if (this._droppedEventsCount === 0) {
            api_1.diag.debug("Dropping extra events.");
          }
          this.events.shift();
          this._droppedEventsCount++;
        }
        if ((0, core_1.isTimeInput)(attributesOrStartTime)) {
          if (!(0, core_1.isTimeInput)(timeStamp)) {
            timeStamp = attributesOrStartTime;
          }
          attributesOrStartTime = void 0;
        }
        const sanitized = (0, core_1.sanitizeAttributes)(attributesOrStartTime);
        const { attributePerEventCountLimit } = this._spanLimits;
        const attributes = {};
        let droppedAttributesCount = 0;
        let eventAttributesCount = 0;
        for (const attr in sanitized) {
          if (!Object.prototype.hasOwnProperty.call(sanitized, attr)) {
            continue;
          }
          const attrVal = sanitized[attr];
          if (attributePerEventCountLimit !== void 0 && eventAttributesCount >= attributePerEventCountLimit) {
            droppedAttributesCount++;
            continue;
          }
          attributes[attr] = this._truncateToSize(attrVal);
          eventAttributesCount++;
        }
        this.events.push({
          name,
          attributes,
          time: this._getTime(timeStamp),
          droppedAttributesCount
        });
        return this;
      }
      addLink(link) {
        if (this._isSpanEnded())
          return this;
        const { linkCountLimit } = this._spanLimits;
        if (linkCountLimit === 0) {
          this._droppedLinksCount++;
          return this;
        }
        if (linkCountLimit !== void 0 && this.links.length >= linkCountLimit) {
          if (this._droppedLinksCount === 0) {
            api_1.diag.debug("Dropping extra links.");
          }
          this.links.shift();
          this._droppedLinksCount++;
        }
        const { attributePerLinkCountLimit } = this._spanLimits;
        const sanitized = (0, core_1.sanitizeAttributes)(link.attributes);
        const attributes = {};
        let droppedAttributesCount = 0;
        let linkAttributesCount = 0;
        for (const attr in sanitized) {
          if (!Object.prototype.hasOwnProperty.call(sanitized, attr)) {
            continue;
          }
          const attrVal = sanitized[attr];
          if (attributePerLinkCountLimit !== void 0 && linkAttributesCount >= attributePerLinkCountLimit) {
            droppedAttributesCount++;
            continue;
          }
          attributes[attr] = this._truncateToSize(attrVal);
          linkAttributesCount++;
        }
        const processedLink = { context: link.context };
        if (linkAttributesCount > 0) {
          processedLink.attributes = attributes;
        }
        if (droppedAttributesCount > 0) {
          processedLink.droppedAttributesCount = droppedAttributesCount;
        }
        this.links.push(processedLink);
        return this;
      }
      addLinks(links) {
        for (const link of links) {
          this.addLink(link);
        }
        return this;
      }
      setStatus(status) {
        if (this._isSpanEnded())
          return this;
        if (status.code === api_1.SpanStatusCode.UNSET)
          return this;
        if (this.status.code === api_1.SpanStatusCode.OK)
          return this;
        const newStatus = { code: status.code };
        if (status.code === api_1.SpanStatusCode.ERROR) {
          if (typeof status.message === "string") {
            newStatus.message = status.message;
          } else if (status.message != null) {
            api_1.diag.warn(`Dropping invalid status.message of type '${typeof status.message}', expected 'string'`);
          }
        }
        this.status = newStatus;
        return this;
      }
      updateName(name) {
        if (this._isSpanEnded())
          return this;
        this.name = name;
        return this;
      }
      end(endTime) {
        if (this._isSpanEnded()) {
          api_1.diag.error(`${this.name} ${this._spanContext.traceId}-${this._spanContext.spanId} - You can only call end() on a span once.`);
          return;
        }
        this.endTime = this._getTime(endTime);
        this._duration = (0, core_1.hrTimeDuration)(this.startTime, this.endTime);
        if (this._duration[0] < 0) {
          api_1.diag.warn("Inconsistent start and end time, startTime > endTime. Setting span duration to 0ms.", this.startTime, this.endTime);
          this.endTime = this.startTime.slice();
          this._duration = [0, 0];
        }
        if (this._droppedEventsCount > 0) {
          api_1.diag.warn(`Dropped ${this._droppedEventsCount} events because eventCountLimit reached`);
        }
        if (this._droppedLinksCount > 0) {
          api_1.diag.warn(`Dropped ${this._droppedLinksCount} links because linkCountLimit reached`);
        }
        if (this._spanProcessor.onEnding) {
          this._spanProcessor.onEnding(this);
        }
        this._recordEndMetrics?.();
        this._ended = true;
        this._spanProcessor.onEnd(this);
      }
      _getTime(inp) {
        if (typeof inp === "number" && inp <= core_1.otperformance.now()) {
          return (0, core_1.hrTime)(inp + this._performanceOffset);
        }
        if (typeof inp === "number") {
          return (0, core_1.millisToHrTime)(inp);
        }
        if (inp instanceof Date) {
          return (0, core_1.millisToHrTime)(inp.getTime());
        }
        if ((0, core_1.isTimeInputHrTime)(inp)) {
          return inp;
        }
        if (this._startTimeProvided) {
          return (0, core_1.millisToHrTime)(Date.now());
        }
        const msDuration = core_1.otperformance.now() - this._performanceStartTime;
        return (0, core_1.addHrTimes)(this.startTime, (0, core_1.millisToHrTime)(msDuration));
      }
      isRecording() {
        return this._ended === false;
      }
      recordException(exception, time) {
        const attributes = {};
        if (typeof exception === "string") {
          attributes[semantic_conventions_1.ATTR_EXCEPTION_MESSAGE] = exception;
        } else if (exception) {
          if (exception.code) {
            attributes[semantic_conventions_1.ATTR_EXCEPTION_TYPE] = exception.code.toString();
          } else if (exception.name) {
            attributes[semantic_conventions_1.ATTR_EXCEPTION_TYPE] = exception.name;
          }
          if (exception.message) {
            attributes[semantic_conventions_1.ATTR_EXCEPTION_MESSAGE] = exception.message;
          }
          if (exception.stack) {
            attributes[semantic_conventions_1.ATTR_EXCEPTION_STACKTRACE] = exception.stack;
          }
        }
        if (attributes[semantic_conventions_1.ATTR_EXCEPTION_TYPE] || attributes[semantic_conventions_1.ATTR_EXCEPTION_MESSAGE]) {
          this.addEvent(enums_1.ExceptionEventName, attributes, time);
        } else {
          api_1.diag.warn(`Failed to record an exception ${exception}`);
        }
      }
      get duration() {
        return this._duration;
      }
      get ended() {
        return this._ended;
      }
      get droppedAttributesCount() {
        return this._droppedAttributesCount;
      }
      get droppedEventsCount() {
        return this._droppedEventsCount;
      }
      get droppedLinksCount() {
        return this._droppedLinksCount;
      }
      _isSpanEnded() {
        if (this._ended) {
          const error = new Error(`Operation attempted on ended Span {traceId: ${this._spanContext.traceId}, spanId: ${this._spanContext.spanId}}`);
          api_1.diag.warn(`Cannot execute the operation on ended Span {traceId: ${this._spanContext.traceId}, spanId: ${this._spanContext.spanId}}`, error);
        }
        return this._ended;
      }
      // Utility function to truncate given value within size
      // for value type of string, will truncate to given limit
      // for type of non-string, will return same value
      _truncateToLimitUtil(value, limit) {
        if (value.length <= limit) {
          return value;
        }
        return value.substring(0, limit);
      }
      /**
       * If the given attribute value is of type string and has more characters than given {@code attributeValueLengthLimit} then
       * return string with truncated to {@code attributeValueLengthLimit} characters
       *
       * If the given attribute value is array of strings then
       * return new array of strings with each element truncated to {@code attributeValueLengthLimit} characters
       *
       * Otherwise return same Attribute {@code value}
       *
       * @param value Attribute value
       * @returns truncated attribute value if required, otherwise same value
       */
      _truncateToSize(value) {
        const limit = this._attributeValueLengthLimit;
        if (limit <= 0) {
          api_1.diag.warn(`Attribute value limit must be positive, got ${limit}`);
          return value;
        }
        if (typeof value === "string") {
          return this._truncateToLimitUtil(value, limit);
        }
        if (Array.isArray(value)) {
          return value.map((val) => typeof val === "string" ? this._truncateToLimitUtil(val, limit) : val);
        }
        return value;
      }
      [inspect_1.inspectCustom](depth, options, inspect) {
        const payload = {
          name: this.name,
          kind: this.kind,
          spanContext: this._spanContext,
          parentSpanContext: this.parentSpanContext,
          status: this.status,
          startTime: this.startTime,
          endTime: this.endTime,
          duration: this._duration,
          ended: this._ended,
          attributes: this.attributes,
          events: this.events,
          links: this.links,
          droppedAttributesCount: this._droppedAttributesCount,
          droppedEventsCount: this._droppedEventsCount,
          droppedLinksCount: this._droppedLinksCount,
          instrumentationScope: this.instrumentationScope,
          resource: { attributes: (0, inspect_1.settledResourceAttributes)(this.resource) }
        };
        return (0, inspect_1.formatInspect)("SpanImpl", payload, depth, options, inspect);
      }
    };
    exports.SpanImpl = SpanImpl;
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/Sampler.js
var require_Sampler = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/Sampler.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SamplingDecision = void 0;
    var SamplingDecision;
    (function(SamplingDecision2) {
      SamplingDecision2[SamplingDecision2["NOT_RECORD"] = 0] = "NOT_RECORD";
      SamplingDecision2[SamplingDecision2["RECORD"] = 1] = "RECORD";
      SamplingDecision2[SamplingDecision2["RECORD_AND_SAMPLED"] = 2] = "RECORD_AND_SAMPLED";
    })(SamplingDecision || (exports.SamplingDecision = SamplingDecision = {}));
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/semconv.js
var require_semconv3 = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/semconv.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OTEL_COMPONENT_TYPE_VALUE_SIMPLE_SPAN_PROCESSOR = exports.OTEL_COMPONENT_TYPE_VALUE_BATCHING_SPAN_PROCESSOR = exports.METRIC_OTEL_SDK_SPAN_STARTED = exports.METRIC_OTEL_SDK_SPAN_LIVE = exports.METRIC_OTEL_SDK_PROCESSOR_SPAN_QUEUE_SIZE = exports.METRIC_OTEL_SDK_PROCESSOR_SPAN_QUEUE_CAPACITY = exports.METRIC_OTEL_SDK_PROCESSOR_SPAN_PROCESSED = exports.ATTR_OTEL_SPAN_SAMPLING_RESULT = exports.ATTR_OTEL_SPAN_PARENT_ORIGIN = exports.ATTR_OTEL_COMPONENT_TYPE = exports.ATTR_OTEL_COMPONENT_NAME = void 0;
    exports.ATTR_OTEL_COMPONENT_NAME = "otel.component.name";
    exports.ATTR_OTEL_COMPONENT_TYPE = "otel.component.type";
    exports.ATTR_OTEL_SPAN_PARENT_ORIGIN = "otel.span.parent.origin";
    exports.ATTR_OTEL_SPAN_SAMPLING_RESULT = "otel.span.sampling_result";
    exports.METRIC_OTEL_SDK_PROCESSOR_SPAN_PROCESSED = "otel.sdk.processor.span.processed";
    exports.METRIC_OTEL_SDK_PROCESSOR_SPAN_QUEUE_CAPACITY = "otel.sdk.processor.span.queue.capacity";
    exports.METRIC_OTEL_SDK_PROCESSOR_SPAN_QUEUE_SIZE = "otel.sdk.processor.span.queue.size";
    exports.METRIC_OTEL_SDK_SPAN_LIVE = "otel.sdk.span.live";
    exports.METRIC_OTEL_SDK_SPAN_STARTED = "otel.sdk.span.started";
    exports.OTEL_COMPONENT_TYPE_VALUE_BATCHING_SPAN_PROCESSOR = "batching_span_processor";
    exports.OTEL_COMPONENT_TYPE_VALUE_SIMPLE_SPAN_PROCESSOR = "simple_span_processor";
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/TracerMetrics.js
var require_TracerMetrics = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/TracerMetrics.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.TracerMetrics = void 0;
    var Sampler_1 = require_Sampler();
    var semconv_1 = require_semconv3();
    var TracerMetrics = class {
      static {
        __name(this, "TracerMetrics");
      }
      startedSpans;
      liveSpans;
      constructor(meter) {
        this.startedSpans = meter.createCounter(semconv_1.METRIC_OTEL_SDK_SPAN_STARTED, {
          unit: "{span}",
          description: "The number of created spans."
        });
        this.liveSpans = meter.createUpDownCounter(semconv_1.METRIC_OTEL_SDK_SPAN_LIVE, {
          unit: "{span}",
          description: "The number of currently live spans."
        });
      }
      startSpan(parentSpanCtx, samplingDecision) {
        const samplingDecisionStr = samplingDecisionToString(samplingDecision);
        this.startedSpans.add(1, {
          [semconv_1.ATTR_OTEL_SPAN_PARENT_ORIGIN]: parentOrigin(parentSpanCtx),
          [semconv_1.ATTR_OTEL_SPAN_SAMPLING_RESULT]: samplingDecisionStr
        });
        if (samplingDecision === Sampler_1.SamplingDecision.NOT_RECORD) {
          return () => {
          };
        }
        const liveSpanAttributes = {
          [semconv_1.ATTR_OTEL_SPAN_SAMPLING_RESULT]: samplingDecisionStr
        };
        this.liveSpans.add(1, liveSpanAttributes);
        return () => {
          this.liveSpans.add(-1, liveSpanAttributes);
        };
      }
    };
    exports.TracerMetrics = TracerMetrics;
    function parentOrigin(parentSpanContext) {
      if (!parentSpanContext) {
        return "none";
      }
      if (parentSpanContext.isRemote) {
        return "remote";
      }
      return "local";
    }
    __name(parentOrigin, "parentOrigin");
    function samplingDecisionToString(decision) {
      switch (decision) {
        case Sampler_1.SamplingDecision.RECORD_AND_SAMPLED:
          return "RECORD_AND_SAMPLE";
        case Sampler_1.SamplingDecision.RECORD:
          return "RECORD_ONLY";
        case Sampler_1.SamplingDecision.NOT_RECORD:
          return "DROP";
      }
    }
    __name(samplingDecisionToString, "samplingDecisionToString");
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/version.js
var require_version2 = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/version.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.VERSION = void 0;
    exports.VERSION = "2.10.0";
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/Tracer.js
var require_Tracer = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/Tracer.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Tracer = void 0;
    var api = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src3();
    var Span_1 = require_Span();
    var TracerMetrics_1 = require_TracerMetrics();
    var version_1 = require_version2();
    var inspect_1 = require_inspect();
    var Tracer = class {
      static {
        __name(this, "Tracer");
      }
      _sampler;
      _spanLimits;
      _idGenerator;
      instrumentationScope;
      _resource;
      _spanProcessor;
      _tracerMetrics;
      /**
       * Constructs a new Tracer instance.
       */
      constructor(instrumentationScope, options) {
        this.instrumentationScope = instrumentationScope;
        this._sampler = options.sampler;
        this._spanLimits = options.spanLimits;
        this._resource = options.resource;
        this._idGenerator = options.idGenerator;
        this._spanProcessor = options.spanProcessor;
        const meter = options.meterProvider.getMeter("@opentelemetry/sdk-trace", version_1.VERSION);
        this._tracerMetrics = new TracerMetrics_1.TracerMetrics(meter);
      }
      /**
       * Starts a new Span or returns the default NoopSpan based on the sampling
       * decision.
       */
      startSpan(name, options = {}, context = api.context.active()) {
        if (options.root) {
          context = api.trace.deleteSpan(context);
        }
        const parentSpan = api.trace.getSpan(context);
        if ((0, core_1.isTracingSuppressed)(context)) {
          api.diag.debug("Instrumentation suppressed, returning Noop Span");
          const nonRecordingSpan = api.trace.wrapSpanContext(api.INVALID_SPAN_CONTEXT);
          return nonRecordingSpan;
        }
        const parentSpanContext = parentSpan?.spanContext();
        const spanId = this._idGenerator.generateSpanId();
        let validParentSpanContext;
        let traceId;
        let traceState;
        if (!parentSpanContext || !api.trace.isSpanContextValid(parentSpanContext)) {
          traceId = this._idGenerator.generateTraceId();
        } else {
          traceId = parentSpanContext.traceId;
          traceState = parentSpanContext.traceState;
          validParentSpanContext = parentSpanContext;
        }
        const spanKind = options.kind ?? api.SpanKind.INTERNAL;
        const links = (options.links ?? []).map((link) => {
          return {
            context: link.context,
            attributes: (0, core_1.sanitizeAttributes)(link.attributes)
          };
        });
        const attributes = (0, core_1.sanitizeAttributes)(options.attributes);
        const samplingResult = this._sampler.shouldSample(context, traceId, name, spanKind, attributes, links);
        const recordEndMetrics = this._tracerMetrics.startSpan(parentSpanContext, samplingResult.decision);
        traceState = samplingResult.traceState ?? traceState;
        const traceFlags = samplingResult.decision === api.SamplingDecision.RECORD_AND_SAMPLED ? api.TraceFlags.SAMPLED : api.TraceFlags.NONE;
        const spanContext = { traceId, spanId, traceFlags, traceState };
        if (samplingResult.decision === api.SamplingDecision.NOT_RECORD) {
          api.diag.debug("Recording is off, propagating context in a non-recording span");
          const nonRecordingSpan = api.trace.wrapSpanContext(spanContext);
          return nonRecordingSpan;
        }
        const initAttributes = (0, core_1.sanitizeAttributes)(Object.assign(attributes, samplingResult.attributes));
        const span = new Span_1.SpanImpl({
          resource: this._resource,
          scope: this.instrumentationScope,
          context,
          spanContext,
          name,
          kind: spanKind,
          links,
          parentSpanContext: validParentSpanContext,
          attributes: initAttributes,
          startTime: options.startTime,
          spanProcessor: this._spanProcessor,
          spanLimits: this._spanLimits,
          recordEndMetrics
        });
        return span;
      }
      startActiveSpan(name, arg2, arg3, arg4) {
        let opts;
        let ctx;
        let fn;
        if (arguments.length < 2) {
          return;
        } else if (arguments.length === 2) {
          fn = arg2;
        } else if (arguments.length === 3) {
          opts = arg2;
          fn = arg3;
        } else {
          opts = arg2;
          ctx = arg3;
          fn = arg4;
        }
        const parentContext = ctx ?? api.context.active();
        const span = this.startSpan(name, opts, parentContext);
        const contextWithSpanSet = api.trace.setSpan(parentContext, span);
        return api.context.with(contextWithSpanSet, fn, void 0, span);
      }
      [inspect_1.inspectCustom](depth, options, inspect) {
        const payload = {
          instrumentationScope: this.instrumentationScope,
          resource: { attributes: (0, inspect_1.settledResourceAttributes)(this._resource) },
          spanLimits: this._spanLimits
        };
        return (0, inspect_1.formatInspect)("Tracer", payload, depth, options, inspect);
      }
    };
    exports.Tracer = Tracer;
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/MultiSpanProcessor.js
var require_MultiSpanProcessor = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/MultiSpanProcessor.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MultiSpanProcessor = void 0;
    var core_1 = require_src3();
    var MultiSpanProcessor = class {
      static {
        __name(this, "MultiSpanProcessor");
      }
      _spanProcessors;
      constructor(spanProcessors) {
        this._spanProcessors = spanProcessors;
      }
      forceFlush() {
        const promises = [];
        for (const spanProcessor of this._spanProcessors) {
          promises.push(spanProcessor.forceFlush());
        }
        return new Promise((resolve) => {
          Promise.all(promises).then(() => {
            resolve();
          }).catch((error) => {
            (0, core_1.globalErrorHandler)(error || new Error("MultiSpanProcessor: forceFlush failed"));
            resolve();
          });
        });
      }
      onStart(span, context) {
        for (const spanProcessor of this._spanProcessors) {
          spanProcessor.onStart(span, context);
        }
      }
      onEnding(span) {
        for (const spanProcessor of this._spanProcessors) {
          if (spanProcessor.onEnding) {
            spanProcessor.onEnding(span);
          }
        }
      }
      onEnd(span) {
        for (const spanProcessor of this._spanProcessors) {
          spanProcessor.onEnd(span);
        }
      }
      shutdown() {
        const promises = [];
        for (const spanProcessor of this._spanProcessors) {
          promises.push(spanProcessor.shutdown());
        }
        return new Promise((resolve, reject) => {
          Promise.all(promises).then(() => {
            resolve();
          }, reject);
        });
      }
    };
    exports.MultiSpanProcessor = MultiSpanProcessor;
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/sampler/AlwaysOffSampler.js
var require_AlwaysOffSampler = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/sampler/AlwaysOffSampler.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AlwaysOffSampler = void 0;
    var Sampler_1 = require_Sampler();
    var AlwaysOffSampler = class {
      static {
        __name(this, "AlwaysOffSampler");
      }
      shouldSample() {
        return {
          decision: Sampler_1.SamplingDecision.NOT_RECORD
        };
      }
      toString() {
        return "AlwaysOffSampler";
      }
    };
    exports.AlwaysOffSampler = AlwaysOffSampler;
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/sampler/AlwaysOnSampler.js
var require_AlwaysOnSampler = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/sampler/AlwaysOnSampler.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AlwaysOnSampler = void 0;
    var Sampler_1 = require_Sampler();
    var AlwaysOnSampler = class {
      static {
        __name(this, "AlwaysOnSampler");
      }
      shouldSample() {
        return {
          decision: Sampler_1.SamplingDecision.RECORD_AND_SAMPLED
        };
      }
      toString() {
        return "AlwaysOnSampler";
      }
    };
    exports.AlwaysOnSampler = AlwaysOnSampler;
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/sampler/ParentBasedSampler.js
var require_ParentBasedSampler = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/sampler/ParentBasedSampler.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ParentBasedSampler = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src3();
    var AlwaysOffSampler_1 = require_AlwaysOffSampler();
    var AlwaysOnSampler_1 = require_AlwaysOnSampler();
    var ParentBasedSampler = class {
      static {
        __name(this, "ParentBasedSampler");
      }
      _root;
      _remoteParentSampled;
      _remoteParentNotSampled;
      _localParentSampled;
      _localParentNotSampled;
      constructor(config) {
        this._root = config.root;
        if (!this._root) {
          (0, core_1.globalErrorHandler)(new Error("ParentBasedSampler must have a root sampler configured"));
          this._root = new AlwaysOnSampler_1.AlwaysOnSampler();
        }
        this._remoteParentSampled = config.remoteParentSampled ?? new AlwaysOnSampler_1.AlwaysOnSampler();
        this._remoteParentNotSampled = config.remoteParentNotSampled ?? new AlwaysOffSampler_1.AlwaysOffSampler();
        this._localParentSampled = config.localParentSampled ?? new AlwaysOnSampler_1.AlwaysOnSampler();
        this._localParentNotSampled = config.localParentNotSampled ?? new AlwaysOffSampler_1.AlwaysOffSampler();
      }
      shouldSample(context, traceId, spanName, spanKind, attributes, links) {
        const parentContext = api_1.trace.getSpanContext(context);
        if (!parentContext || !(0, api_1.isSpanContextValid)(parentContext)) {
          return this._root.shouldSample(context, traceId, spanName, spanKind, attributes, links);
        }
        if (parentContext.isRemote) {
          if (parentContext.traceFlags & api_1.TraceFlags.SAMPLED) {
            return this._remoteParentSampled.shouldSample(context, traceId, spanName, spanKind, attributes, links);
          }
          return this._remoteParentNotSampled.shouldSample(context, traceId, spanName, spanKind, attributes, links);
        }
        if (parentContext.traceFlags & api_1.TraceFlags.SAMPLED) {
          return this._localParentSampled.shouldSample(context, traceId, spanName, spanKind, attributes, links);
        }
        return this._localParentNotSampled.shouldSample(context, traceId, spanName, spanKind, attributes, links);
      }
      toString() {
        return `ParentBased{root=${this._root.toString()}, remoteParentSampled=${this._remoteParentSampled.toString()}, remoteParentNotSampled=${this._remoteParentNotSampled.toString()}, localParentSampled=${this._localParentSampled.toString()}, localParentNotSampled=${this._localParentNotSampled.toString()}}`;
      }
    };
    exports.ParentBasedSampler = ParentBasedSampler;
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/export/SpanProcessorMetrics.js
var require_SpanProcessorMetrics = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/export/SpanProcessorMetrics.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SpanProcessorMetrics = void 0;
    var semantic_conventions_1 = (init_esm2(), __toCommonJS(esm_exports2));
    var semconv_1 = require_semconv3();
    var componentCounter = /* @__PURE__ */ new Map();
    var SpanProcessorMetrics = class {
      static {
        __name(this, "SpanProcessorMetrics");
      }
      processedSpans;
      queueSize;
      queueSizeCallback;
      standardAttrs;
      droppedAttrs;
      constructor(componentType, meter, queueConfig) {
        const counter = componentCounter.get(componentType) ?? 0;
        componentCounter.set(componentType, counter + 1);
        this.standardAttrs = {
          [semconv_1.ATTR_OTEL_COMPONENT_TYPE]: componentType,
          [semconv_1.ATTR_OTEL_COMPONENT_NAME]: `${componentType}/${counter}`
        };
        this.droppedAttrs = {
          ...this.standardAttrs,
          [semantic_conventions_1.ATTR_ERROR_TYPE]: "queue_full"
        };
        this.processedSpans = meter.createCounter(semconv_1.METRIC_OTEL_SDK_PROCESSOR_SPAN_PROCESSED, {
          unit: "{span}",
          description: "The number of spans for which the processing has finished, either successful or failed."
        });
        if (queueConfig) {
          const { capacity, getQueueSize } = queueConfig;
          const queueCapacity = meter.createUpDownCounter(semconv_1.METRIC_OTEL_SDK_PROCESSOR_SPAN_QUEUE_CAPACITY, {
            unit: "{span}",
            description: "The maximum number of spans the queue of a given instance of an SDK span processor can hold."
          });
          queueCapacity.add(capacity, this.standardAttrs);
          this.queueSize = meter.createObservableUpDownCounter(semconv_1.METRIC_OTEL_SDK_PROCESSOR_SPAN_QUEUE_SIZE, {
            unit: "{span}",
            description: "The number of spans in the queue of a given instance of an SDK span processor."
          });
          this.queueSizeCallback = (result) => result.observe(getQueueSize(), this.standardAttrs);
          this.queueSize.addCallback(this.queueSizeCallback);
        }
      }
      dropSpans(count) {
        this.processedSpans.add(count, this.droppedAttrs);
      }
      finishSpans(count, error) {
        if (!error) {
          this.processedSpans.add(count, this.standardAttrs);
          return;
        }
        const attrs = {
          ...this.standardAttrs,
          [semantic_conventions_1.ATTR_ERROR_TYPE]: error.name
        };
        this.processedSpans.add(count, attrs);
      }
      shutdown() {
        if (this.queueSize && this.queueSizeCallback) {
          this.queueSize.removeCallback(this.queueSizeCallback);
        }
      }
    };
    exports.SpanProcessorMetrics = SpanProcessorMetrics;
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/export/BatchSpanProcessorBase.js
var require_BatchSpanProcessorBase = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/export/BatchSpanProcessorBase.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BatchSpanProcessorBase = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src3();
    var SpanProcessorMetrics_1 = require_SpanProcessorMetrics();
    var semconv_1 = require_semconv3();
    var BatchSpanProcessorBase = class {
      static {
        __name(this, "BatchSpanProcessorBase");
      }
      _maxExportBatchSize;
      _maxQueueSize;
      _scheduledDelayMillis;
      _exportTimeoutMillis;
      _exporter;
      _metrics;
      _isExporting = false;
      _finishedSpans = [];
      _timer;
      _shutdownOnce;
      _droppedSpansCount = 0;
      constructor(options) {
        this._exporter = options.exporter;
        this._maxExportBatchSize = options.maxExportBatchSize ?? 512;
        this._maxQueueSize = options.maxQueueSize ?? 2048;
        this._scheduledDelayMillis = options.scheduledDelayMillis ?? 5e3;
        this._exportTimeoutMillis = options.exportTimeoutMillis ?? 3e4;
        this._shutdownOnce = new core_1.BindOnceFuture(this._shutdown, this);
        if (this._maxExportBatchSize > this._maxQueueSize) {
          api_1.diag.warn("BatchSpanProcessor: maxExportBatchSize must be smaller or equal to maxQueueSize, setting maxExportBatchSize to match maxQueueSize");
          this._maxExportBatchSize = this._maxQueueSize;
        }
        const meter = options.selfObsMeterProvider ? options.selfObsMeterProvider.getMeter("@opentelemetry/sdk-trace") : (0, api_1.createNoopMeter)();
        this._metrics = new SpanProcessorMetrics_1.SpanProcessorMetrics(semconv_1.OTEL_COMPONENT_TYPE_VALUE_BATCHING_SPAN_PROCESSOR, meter, {
          capacity: this._maxQueueSize,
          getQueueSize: /* @__PURE__ */ __name(() => this._finishedSpans.length, "getQueueSize")
        });
      }
      forceFlush() {
        if (this._shutdownOnce.isCalled) {
          return this._shutdownOnce.promise;
        }
        return this._flushAll();
      }
      // does nothing.
      onStart(_span, _parentContext) {
      }
      onEnd(span) {
        if (this._shutdownOnce.isCalled) {
          return;
        }
        if ((span.spanContext().traceFlags & api_1.TraceFlags.SAMPLED) === 0) {
          return;
        }
        this._addToBuffer(span);
      }
      shutdown() {
        return this._shutdownOnce.call();
      }
      _shutdown() {
        return Promise.resolve().then(() => {
          return this.onShutdown();
        }).then(() => {
          return this._flushAll();
        }).then(() => {
          this._metrics.shutdown();
          return this._exporter.shutdown();
        });
      }
      /** Add a span in the buffer. */
      _addToBuffer(span) {
        if (this._finishedSpans.length >= this._maxQueueSize) {
          if (this._droppedSpansCount === 0) {
            api_1.diag.debug("maxQueueSize reached, dropping spans");
          }
          this._droppedSpansCount++;
          this._metrics.dropSpans(1);
          return;
        }
        if (this._droppedSpansCount > 0) {
          api_1.diag.warn(`Dropped ${this._droppedSpansCount} spans because maxQueueSize reached`);
          this._droppedSpansCount = 0;
        }
        this._finishedSpans.push(span);
        this._maybeStartTimer();
      }
      /**
       * Send all spans to the exporter respecting the batch size limit
       * This function is used only on forceFlush or shutdown,
       * for all other cases _flush should be used
       * */
      _flushAll() {
        return new Promise((resolve, reject) => {
          const promises = [];
          const count = Math.ceil(this._finishedSpans.length / this._maxExportBatchSize);
          for (let i = 0, j = count; i < j; i++) {
            promises.push(this._flushOneBatch());
          }
          Promise.all(promises).then(() => {
            resolve();
          }).catch(reject);
        });
      }
      _flushOneBatch() {
        this._clearTimer();
        if (this._finishedSpans.length === 0) {
          return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error("Timeout"));
          }, this._exportTimeoutMillis);
          api_1.context.with((0, core_1.suppressTracing)(api_1.context.active()), () => {
            let spans;
            if (this._finishedSpans.length <= this._maxExportBatchSize) {
              spans = this._finishedSpans;
              this._finishedSpans = [];
            } else {
              spans = this._finishedSpans.splice(0, this._maxExportBatchSize);
            }
            const doExport = /* @__PURE__ */ __name(() => this._exporter.export(spans, (result) => {
              clearTimeout(timer);
              this._metrics.finishSpans(spans.length, result.error);
              if (result.code === core_1.ExportResultCode.SUCCESS) {
                resolve();
              } else {
                reject(result.error ?? new Error("BatchSpanProcessor: span export failed"));
              }
            }), "doExport");
            let pendingResources = null;
            for (let i = 0, len = spans.length; i < len; i++) {
              const span = spans[i];
              if (span.resource.asyncAttributesPending && span.resource.waitForAsyncAttributes) {
                pendingResources ??= [];
                pendingResources.push(span.resource.waitForAsyncAttributes());
              }
            }
            if (pendingResources === null) {
              doExport();
            } else {
              Promise.all(pendingResources).then(doExport, (err) => {
                (0, core_1.globalErrorHandler)(err);
                reject(err);
              });
            }
          });
        });
      }
      _maybeStartTimer() {
        if (this._isExporting)
          return;
        const flush = /* @__PURE__ */ __name(() => {
          this._isExporting = true;
          this._flushOneBatch().finally(() => {
            this._isExporting = false;
            if (this._finishedSpans.length > 0) {
              this._clearTimer();
              this._maybeStartTimer();
            }
          }).catch((e) => {
            this._isExporting = false;
            (0, core_1.globalErrorHandler)(e);
          });
        }, "flush");
        if (this._finishedSpans.length >= this._maxExportBatchSize) {
          return flush();
        }
        if (this._timer !== void 0)
          return;
        this._timer = setTimeout(() => flush(), this._scheduledDelayMillis);
        if (typeof this._timer !== "number") {
          this._timer.unref();
        }
      }
      _clearTimer() {
        if (this._timer !== void 0) {
          clearTimeout(this._timer);
          this._timer = void 0;
        }
      }
    };
    exports.BatchSpanProcessorBase = BatchSpanProcessorBase;
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/platform/node/export/BatchSpanProcessor.js
var require_BatchSpanProcessor = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/platform/node/export/BatchSpanProcessor.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BatchSpanProcessor = void 0;
    var BatchSpanProcessorBase_1 = require_BatchSpanProcessorBase();
    var BatchSpanProcessor2 = class extends BatchSpanProcessorBase_1.BatchSpanProcessorBase {
      static {
        __name(this, "BatchSpanProcessor");
      }
      onShutdown() {
      }
    };
    exports.BatchSpanProcessor = BatchSpanProcessor2;
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/platform/node/RandomIdGenerator.js
var require_RandomIdGenerator = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/platform/node/RandomIdGenerator.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.RandomIdGenerator = void 0;
    var SPAN_ID_BYTES = 8;
    var TRACE_ID_BYTES = 16;
    var RandomIdGenerator = class {
      static {
        __name(this, "RandomIdGenerator");
      }
      /**
       * Returns a random 16-byte trace ID formatted/encoded as a 32 lowercase hex
       * characters corresponding to 128 bits.
       */
      generateTraceId = getIdGenerator(TRACE_ID_BYTES);
      /**
       * Returns a random 8-byte span ID formatted/encoded as a 16 lowercase hex
       * characters corresponding to 64 bits.
       */
      generateSpanId = getIdGenerator(SPAN_ID_BYTES);
    };
    exports.RandomIdGenerator = RandomIdGenerator;
    var SHARED_BUFFER = Buffer.allocUnsafe(TRACE_ID_BYTES);
    function getIdGenerator(bytes) {
      return /* @__PURE__ */ __name(function generateId() {
        for (let i = 0; i < bytes / 4; i++) {
          SHARED_BUFFER.writeUInt32BE(Math.random() * 2 ** 32 >>> 0, i * 4);
        }
        for (let i = 0; i < bytes; i++) {
          if (SHARED_BUFFER[i] > 0) {
            break;
          } else if (i === bytes - 1) {
            SHARED_BUFFER[bytes - 1] = 1;
          }
        }
        return SHARED_BUFFER.toString("hex", 0, bytes);
      }, "generateId");
    }
    __name(getIdGenerator, "getIdGenerator");
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/platform/node/index.js
var require_node3 = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/platform/node/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.RandomIdGenerator = exports.BatchSpanProcessor = void 0;
    var BatchSpanProcessor_1 = require_BatchSpanProcessor();
    Object.defineProperty(exports, "BatchSpanProcessor", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return BatchSpanProcessor_1.BatchSpanProcessor;
    }, "get") });
    var RandomIdGenerator_1 = require_RandomIdGenerator();
    Object.defineProperty(exports, "RandomIdGenerator", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return RandomIdGenerator_1.RandomIdGenerator;
    }, "get") });
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/platform/index.js
var require_platform3 = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/platform/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.RandomIdGenerator = exports.BatchSpanProcessor = void 0;
    var node_1 = require_node3();
    Object.defineProperty(exports, "BatchSpanProcessor", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.BatchSpanProcessor;
    }, "get") });
    Object.defineProperty(exports, "RandomIdGenerator", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.RandomIdGenerator;
    }, "get") });
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/TracerProvider.js
var require_TracerProvider = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/TracerProvider.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.TracerProvider = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var resources_1 = require_src8();
    var Tracer_1 = require_Tracer();
    var MultiSpanProcessor_1 = require_MultiSpanProcessor();
    var ParentBasedSampler_1 = require_ParentBasedSampler();
    var AlwaysOnSampler_1 = require_AlwaysOnSampler();
    var platform_1 = require_platform3();
    var inspect_1 = require_inspect();
    var ForceFlushState;
    (function(ForceFlushState2) {
      ForceFlushState2[ForceFlushState2["resolved"] = 0] = "resolved";
      ForceFlushState2[ForceFlushState2["timeout"] = 1] = "timeout";
      ForceFlushState2[ForceFlushState2["error"] = 2] = "error";
      ForceFlushState2[ForceFlushState2["unresolved"] = 3] = "unresolved";
    })(ForceFlushState || (ForceFlushState = {}));
    var TracerProvider = class {
      static {
        __name(this, "TracerProvider");
      }
      _resource;
      _activeSpanProcessor;
      _forceFlushTimeoutMillis;
      _tracerOptions;
      _tracers = /* @__PURE__ */ new Map();
      constructor(options = {}) {
        this._forceFlushTimeoutMillis = options.forceFlushTimeoutMillis ?? 3e4;
        this._resource = options.resource ?? (0, resources_1.defaultResource)();
        const spanProcessors = options.spanProcessors ?? [];
        this._activeSpanProcessor = new MultiSpanProcessor_1.MultiSpanProcessor(spanProcessors);
        this._tracerOptions = {
          resource: this._resource,
          sampler: options.sampler ?? new ParentBasedSampler_1.ParentBasedSampler({
            root: new AlwaysOnSampler_1.AlwaysOnSampler()
          }),
          spanLimits: {
            attributeCountLimit: options.spanLimits?.attributeCountLimit ?? 128,
            attributeValueLengthLimit: options.spanLimits?.attributeValueLengthLimit ?? Infinity,
            eventCountLimit: options.spanLimits?.eventCountLimit ?? 128,
            linkCountLimit: options.spanLimits?.linkCountLimit ?? 128,
            attributePerEventCountLimit: options.spanLimits?.attributePerEventCountLimit ?? 128,
            attributePerLinkCountLimit: options.spanLimits?.attributePerLinkCountLimit ?? 128
          },
          idGenerator: options.idGenerator || new platform_1.RandomIdGenerator(),
          spanProcessor: this._activeSpanProcessor,
          meterProvider: options.meterProvider ?? {
            getMeter() {
              return (0, api_1.createNoopMeter)();
            }
          }
        };
      }
      getTracer(name, version, options) {
        const key = `${name}@${version || ""}:${options?.schemaUrl || ""}`;
        if (!this._tracers.has(key)) {
          this._tracers.set(key, new Tracer_1.Tracer({ name, version, schemaUrl: options?.schemaUrl }, this._tracerOptions));
        }
        return this._tracers.get(key);
      }
      forceFlush() {
        const timeout = this._forceFlushTimeoutMillis;
        const promises = this._activeSpanProcessor["_spanProcessors"].map((spanProcessor) => {
          return new Promise((resolve) => {
            let state;
            const timeoutInterval = setTimeout(() => {
              resolve(new Error(`Span processor did not completed within timeout period of ${timeout} ms`));
              state = ForceFlushState.timeout;
            }, timeout);
            spanProcessor.forceFlush().then(() => {
              clearTimeout(timeoutInterval);
              if (state !== ForceFlushState.timeout) {
                state = ForceFlushState.resolved;
                resolve(state);
              }
            }).catch((error) => {
              clearTimeout(timeoutInterval);
              state = ForceFlushState.error;
              resolve(error);
            });
          });
        });
        return new Promise((resolve, reject) => {
          Promise.all(promises).then((results) => {
            const errors = results.filter((result) => result !== ForceFlushState.resolved);
            if (errors.length > 0) {
              reject(errors);
            } else {
              resolve();
            }
          }).catch((error) => reject([error]));
        });
      }
      shutdown() {
        return this._activeSpanProcessor.shutdown();
      }
      [inspect_1.inspectCustom](depth, options, inspect) {
        const processors = this._activeSpanProcessor["_spanProcessors"];
        const payload = {
          resource: { attributes: (0, inspect_1.settledResourceAttributes)(this._resource) },
          tracers: Array.from(this._tracers.keys()),
          spanProcessors: processors.map((p) => p.constructor?.name ?? "SpanProcessor")
        };
        return (0, inspect_1.formatInspect)("TracerProvider", payload, depth, options, inspect);
      }
    };
    exports.TracerProvider = TracerProvider;
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/export/ConsoleSpanExporter.js
var require_ConsoleSpanExporter = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/export/ConsoleSpanExporter.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ConsoleSpanExporter = void 0;
    var core_1 = require_src3();
    var ConsoleSpanExporter = class {
      static {
        __name(this, "ConsoleSpanExporter");
      }
      /**
       * Export spans.
       * @param spans
       * @param resultCallback
       */
      export(spans, resultCallback) {
        return this._sendSpans(spans, resultCallback);
      }
      /**
       * Shutdown the exporter.
       */
      shutdown() {
        this._sendSpans([]);
        return this.forceFlush();
      }
      /**
       * Exports any pending spans in exporter
       */
      forceFlush() {
        return Promise.resolve();
      }
      /**
       * converts span info into more readable format
       * @param span
       */
      _exportInfo(span) {
        return {
          resource: {
            attributes: span.resource.attributes
          },
          instrumentationScope: span.instrumentationScope,
          traceId: span.spanContext().traceId,
          parentSpanContext: span.parentSpanContext,
          traceState: span.spanContext().traceState?.serialize(),
          name: span.name,
          id: span.spanContext().spanId,
          kind: span.kind,
          timestamp: (0, core_1.hrTimeToMicroseconds)(span.startTime),
          duration: (0, core_1.hrTimeToMicroseconds)(span.duration),
          attributes: span.attributes,
          status: span.status,
          events: span.events,
          links: span.links
        };
      }
      /**
       * Showing spans in console
       * @param spans
       * @param done
       */
      _sendSpans(spans, done) {
        for (const span of spans) {
          console.dir(this._exportInfo(span), { depth: 3 });
        }
        if (done) {
          return done({ code: core_1.ExportResultCode.SUCCESS });
        }
      }
    };
    exports.ConsoleSpanExporter = ConsoleSpanExporter;
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/export/InMemorySpanExporter.js
var require_InMemorySpanExporter = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/export/InMemorySpanExporter.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.InMemorySpanExporter = void 0;
    var core_1 = require_src3();
    var InMemorySpanExporter = class {
      static {
        __name(this, "InMemorySpanExporter");
      }
      _finishedSpans = [];
      /**
       * Indicates if the exporter has been "shutdown."
       * When false, exported spans will not be stored in-memory.
       */
      _stopped = false;
      export(spans, resultCallback) {
        if (this._stopped)
          return resultCallback({
            code: core_1.ExportResultCode.FAILED,
            error: new Error("Exporter has been stopped")
          });
        this._finishedSpans.push(...spans);
        setTimeout(() => resultCallback({ code: core_1.ExportResultCode.SUCCESS }), 0);
      }
      shutdown() {
        this._stopped = true;
        this._finishedSpans = [];
        return this.forceFlush();
      }
      /**
       * Exports any pending spans in the exporter
       */
      forceFlush() {
        return Promise.resolve();
      }
      reset() {
        this._finishedSpans = [];
      }
      getFinishedSpans() {
        return this._finishedSpans;
      }
    };
    exports.InMemorySpanExporter = InMemorySpanExporter;
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/export/SimpleSpanProcessor.js
var require_SimpleSpanProcessor = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/export/SimpleSpanProcessor.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SimpleSpanProcessor = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src3();
    var SpanProcessorMetrics_1 = require_SpanProcessorMetrics();
    var semconv_1 = require_semconv3();
    var SimpleSpanProcessor = class {
      static {
        __name(this, "SimpleSpanProcessor");
      }
      _exporter;
      _metrics;
      _shutdownOnce;
      _pendingExports;
      constructor(options) {
        this._exporter = options.exporter;
        this._shutdownOnce = new core_1.BindOnceFuture(this._shutdown, this);
        this._pendingExports = /* @__PURE__ */ new Set();
        const meter = options.selfObsMeterProvider ? options.selfObsMeterProvider.getMeter("@opentelemetry/sdk-trace") : (0, api_1.createNoopMeter)();
        this._metrics = new SpanProcessorMetrics_1.SpanProcessorMetrics(semconv_1.OTEL_COMPONENT_TYPE_VALUE_SIMPLE_SPAN_PROCESSOR, meter);
      }
      async forceFlush() {
        let pendingExportError;
        let pendingExportRejected = false;
        try {
          await Promise.all(Array.from(this._pendingExports));
        } catch (err) {
          pendingExportError = err;
          pendingExportRejected = true;
        }
        if (this._exporter.forceFlush) {
          await this._exporter.forceFlush();
        }
        if (pendingExportRejected) {
          throw pendingExportError;
        }
      }
      onStart(_span, _parentContext) {
      }
      onEnd(span) {
        if (this._shutdownOnce.isCalled) {
          return;
        }
        if ((span.spanContext().traceFlags & api_1.TraceFlags.SAMPLED) === 0) {
          return;
        }
        const pendingExport = this._doExport(span);
        this._pendingExports.add(pendingExport);
        void pendingExport.then(() => {
          this._pendingExports.delete(pendingExport);
        }, (err) => {
          (0, core_1.globalErrorHandler)(err);
          this._pendingExports.delete(pendingExport);
        });
      }
      async _doExport(span) {
        if (span.resource.asyncAttributesPending) {
          await span.resource.waitForAsyncAttributes?.();
        }
        const result = await core_1.internal._export(this._exporter, [span]);
        this._metrics.finishSpans(1, result.error);
        if (result.code !== core_1.ExportResultCode.SUCCESS) {
          throw result.error ?? new Error(`SimpleSpanProcessor: span export failed (status ${result})`);
        }
      }
      shutdown() {
        return this._shutdownOnce.call();
      }
      _shutdown() {
        this._metrics.shutdown();
        return this._exporter.shutdown();
      }
    };
    exports.SimpleSpanProcessor = SimpleSpanProcessor;
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/export/NoopSpanProcessor.js
var require_NoopSpanProcessor = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/export/NoopSpanProcessor.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.NoopSpanProcessor = void 0;
    var NoopSpanProcessor = class {
      static {
        __name(this, "NoopSpanProcessor");
      }
      onStart(_span, _context) {
      }
      onEnd(_span) {
      }
      shutdown() {
        return Promise.resolve();
      }
      forceFlush() {
        return Promise.resolve();
      }
    };
    exports.NoopSpanProcessor = NoopSpanProcessor;
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/sampler/AlwaysRecordSampler.js
var require_AlwaysRecordSampler = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/sampler/AlwaysRecordSampler.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createAlwaysRecordSampler = void 0;
    var Sampler_1 = require_Sampler();
    function createAlwaysRecordSampler(delegate) {
      if (!delegate) {
        throw new Error("createAlwaysRecordSampler requires a delegate sampler");
      }
      return {
        shouldSample(context, traceId, spanName, spanKind, attributes, links) {
          const result = delegate.shouldSample(context, traceId, spanName, spanKind, attributes, links);
          if (result.decision === Sampler_1.SamplingDecision.NOT_RECORD) {
            return {
              decision: Sampler_1.SamplingDecision.RECORD,
              attributes: result.attributes,
              traceState: result.traceState
            };
          }
          return result;
        },
        toString() {
          return `AlwaysRecordSampler{${delegate.toString()}}`;
        }
      };
    }
    __name(createAlwaysRecordSampler, "createAlwaysRecordSampler");
    exports.createAlwaysRecordSampler = createAlwaysRecordSampler;
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/sampler/TraceIdRatioBasedSampler.js
var require_TraceIdRatioBasedSampler = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/sampler/TraceIdRatioBasedSampler.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.TraceIdRatioBasedSampler = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var Sampler_1 = require_Sampler();
    var TraceIdRatioBasedSampler = class {
      static {
        __name(this, "TraceIdRatioBasedSampler");
      }
      _ratio;
      _upperBound;
      constructor(ratio = 0) {
        this._ratio = this._normalize(ratio);
        this._upperBound = this._ratio === 1 ? 4294967296 : Math.floor(this._ratio * 4294967295);
      }
      shouldSample(context, traceId) {
        return {
          decision: (0, api_1.isValidTraceId)(traceId) && this._accumulate(traceId) < this._upperBound ? Sampler_1.SamplingDecision.RECORD_AND_SAMPLED : Sampler_1.SamplingDecision.NOT_RECORD
        };
      }
      toString() {
        return `TraceIdRatioBased{${this._ratio}}`;
      }
      _normalize(ratio) {
        if (typeof ratio !== "number" || isNaN(ratio))
          return 0;
        return ratio >= 1 ? 1 : ratio <= 0 ? 0 : ratio;
      }
      _accumulate(traceId) {
        let accumulation = 0;
        for (let i = 0; i < 32; i += 8) {
          let part = 0;
          for (let j = 0; j < 8; j++) {
            const c = traceId.charCodeAt(i + j);
            const v = c < 58 ? c - 48 : c < 71 ? c - 55 : c - 87;
            part = part << 4 | v;
          }
          accumulation = (accumulation ^ part) >>> 0;
        }
        return accumulation;
      }
    };
    exports.TraceIdRatioBasedSampler = TraceIdRatioBasedSampler;
  }
});

// node_modules/@opentelemetry/sdk-trace/build/src/index.js
var require_src9 = __commonJS({
  "node_modules/@opentelemetry/sdk-trace/build/src/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SamplingDecision = exports.TraceIdRatioBasedSampler = exports.ParentBasedSampler = exports.createAlwaysRecordSampler = exports.AlwaysOnSampler = exports.AlwaysOffSampler = exports.NoopSpanProcessor = exports.SimpleSpanProcessor = exports.InMemorySpanExporter = exports.ConsoleSpanExporter = exports.RandomIdGenerator = exports.BatchSpanProcessor = exports.TracerProvider = void 0;
    var TracerProvider_1 = require_TracerProvider();
    Object.defineProperty(exports, "TracerProvider", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return TracerProvider_1.TracerProvider;
    }, "get") });
    var platform_1 = require_platform3();
    Object.defineProperty(exports, "BatchSpanProcessor", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.BatchSpanProcessor;
    }, "get") });
    Object.defineProperty(exports, "RandomIdGenerator", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.RandomIdGenerator;
    }, "get") });
    var ConsoleSpanExporter_1 = require_ConsoleSpanExporter();
    Object.defineProperty(exports, "ConsoleSpanExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ConsoleSpanExporter_1.ConsoleSpanExporter;
    }, "get") });
    var InMemorySpanExporter_1 = require_InMemorySpanExporter();
    Object.defineProperty(exports, "InMemorySpanExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return InMemorySpanExporter_1.InMemorySpanExporter;
    }, "get") });
    var SimpleSpanProcessor_1 = require_SimpleSpanProcessor();
    Object.defineProperty(exports, "SimpleSpanProcessor", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return SimpleSpanProcessor_1.SimpleSpanProcessor;
    }, "get") });
    var NoopSpanProcessor_1 = require_NoopSpanProcessor();
    Object.defineProperty(exports, "NoopSpanProcessor", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return NoopSpanProcessor_1.NoopSpanProcessor;
    }, "get") });
    var AlwaysOffSampler_1 = require_AlwaysOffSampler();
    Object.defineProperty(exports, "AlwaysOffSampler", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return AlwaysOffSampler_1.AlwaysOffSampler;
    }, "get") });
    var AlwaysOnSampler_1 = require_AlwaysOnSampler();
    Object.defineProperty(exports, "AlwaysOnSampler", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return AlwaysOnSampler_1.AlwaysOnSampler;
    }, "get") });
    var AlwaysRecordSampler_1 = require_AlwaysRecordSampler();
    Object.defineProperty(exports, "createAlwaysRecordSampler", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return AlwaysRecordSampler_1.createAlwaysRecordSampler;
    }, "get") });
    var ParentBasedSampler_1 = require_ParentBasedSampler();
    Object.defineProperty(exports, "ParentBasedSampler", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ParentBasedSampler_1.ParentBasedSampler;
    }, "get") });
    var TraceIdRatioBasedSampler_1 = require_TraceIdRatioBasedSampler();
    Object.defineProperty(exports, "TraceIdRatioBasedSampler", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return TraceIdRatioBasedSampler_1.TraceIdRatioBasedSampler;
    }, "get") });
    var Sampler_1 = require_Sampler();
    Object.defineProperty(exports, "SamplingDecision", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return Sampler_1.SamplingDecision;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/sdk-trace-base/build/src/config.js
var require_config = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-trace-base/build/src/config.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.buildSamplerFromEnv = exports.loadDefaultConfig = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src3();
    var sdk_trace_1 = require_src9();
    var TracesSamplerValues;
    (function(TracesSamplerValues2) {
      TracesSamplerValues2["AlwaysOff"] = "always_off";
      TracesSamplerValues2["AlwaysOn"] = "always_on";
      TracesSamplerValues2["ParentBasedAlwaysOff"] = "parentbased_always_off";
      TracesSamplerValues2["ParentBasedAlwaysOn"] = "parentbased_always_on";
      TracesSamplerValues2["ParentBasedTraceIdRatio"] = "parentbased_traceidratio";
      TracesSamplerValues2["TraceIdRatio"] = "traceidratio";
    })(TracesSamplerValues || (TracesSamplerValues = {}));
    var DEFAULT_RATIO = 1;
    function loadDefaultConfig() {
      return {
        sampler: buildSamplerFromEnv(),
        forceFlushTimeoutMillis: 3e4,
        generalLimits: {
          attributeValueLengthLimit: (0, core_1.getNumberFromEnv)("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT") ?? Infinity,
          attributeCountLimit: (0, core_1.getNumberFromEnv)("OTEL_ATTRIBUTE_COUNT_LIMIT") ?? 128
        },
        spanLimits: {
          attributeValueLengthLimit: (0, core_1.getNumberFromEnv)("OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT") ?? Infinity,
          attributeCountLimit: (0, core_1.getNumberFromEnv)("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT") ?? 128,
          linkCountLimit: (0, core_1.getNumberFromEnv)("OTEL_SPAN_LINK_COUNT_LIMIT") ?? 128,
          eventCountLimit: (0, core_1.getNumberFromEnv)("OTEL_SPAN_EVENT_COUNT_LIMIT") ?? 128,
          attributePerEventCountLimit: (0, core_1.getNumberFromEnv)("OTEL_SPAN_ATTRIBUTE_PER_EVENT_COUNT_LIMIT") ?? 128,
          attributePerLinkCountLimit: (0, core_1.getNumberFromEnv)("OTEL_SPAN_ATTRIBUTE_PER_LINK_COUNT_LIMIT") ?? 128
        }
      };
    }
    __name(loadDefaultConfig, "loadDefaultConfig");
    exports.loadDefaultConfig = loadDefaultConfig;
    function buildSamplerFromEnv() {
      const sampler = (0, core_1.getStringFromEnv)("OTEL_TRACES_SAMPLER") ?? TracesSamplerValues.ParentBasedAlwaysOn;
      switch (sampler) {
        case TracesSamplerValues.AlwaysOn:
          return new sdk_trace_1.AlwaysOnSampler();
        case TracesSamplerValues.AlwaysOff:
          return new sdk_trace_1.AlwaysOffSampler();
        case TracesSamplerValues.ParentBasedAlwaysOn:
          return new sdk_trace_1.ParentBasedSampler({
            root: new sdk_trace_1.AlwaysOnSampler()
          });
        case TracesSamplerValues.ParentBasedAlwaysOff:
          return new sdk_trace_1.ParentBasedSampler({
            root: new sdk_trace_1.AlwaysOffSampler()
          });
        case TracesSamplerValues.TraceIdRatio:
          return new sdk_trace_1.TraceIdRatioBasedSampler(getSamplerProbabilityFromEnv());
        case TracesSamplerValues.ParentBasedTraceIdRatio:
          return new sdk_trace_1.ParentBasedSampler({
            root: new sdk_trace_1.TraceIdRatioBasedSampler(getSamplerProbabilityFromEnv())
          });
        default:
          api_1.diag.error(`OTEL_TRACES_SAMPLER value "${sampler}" invalid, defaulting to "${TracesSamplerValues.ParentBasedAlwaysOn}".`);
          return new sdk_trace_1.ParentBasedSampler({
            root: new sdk_trace_1.AlwaysOnSampler()
          });
      }
    }
    __name(buildSamplerFromEnv, "buildSamplerFromEnv");
    exports.buildSamplerFromEnv = buildSamplerFromEnv;
    function getSamplerProbabilityFromEnv() {
      const probability = (0, core_1.getNumberFromEnv)("OTEL_TRACES_SAMPLER_ARG");
      if (probability == null) {
        api_1.diag.error(`OTEL_TRACES_SAMPLER_ARG is blank, defaulting to ${DEFAULT_RATIO}.`);
        return DEFAULT_RATIO;
      }
      if (probability < 0 || probability > 1) {
        api_1.diag.error(`OTEL_TRACES_SAMPLER_ARG=${probability} was given, but it is out of range ([0..1]), defaulting to ${DEFAULT_RATIO}.`);
        return DEFAULT_RATIO;
      }
      return probability;
    }
    __name(getSamplerProbabilityFromEnv, "getSamplerProbabilityFromEnv");
  }
});

// packages/core/node_modules/@opentelemetry/sdk-trace-base/build/src/utility.js
var require_utility = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-trace-base/build/src/utility.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.reconfigureLimits = exports.DEFAULT_ATTRIBUTE_VALUE_LENGTH_LIMIT = exports.DEFAULT_ATTRIBUTE_COUNT_LIMIT = void 0;
    var core_1 = require_src3();
    exports.DEFAULT_ATTRIBUTE_COUNT_LIMIT = 128;
    exports.DEFAULT_ATTRIBUTE_VALUE_LENGTH_LIMIT = Infinity;
    function reconfigureLimits(userConfig) {
      const spanLimits = Object.assign({}, userConfig.spanLimits);
      spanLimits.attributeCountLimit = userConfig.spanLimits?.attributeCountLimit ?? userConfig.generalLimits?.attributeCountLimit ?? (0, core_1.getNumberFromEnv)("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT") ?? (0, core_1.getNumberFromEnv)("OTEL_ATTRIBUTE_COUNT_LIMIT") ?? exports.DEFAULT_ATTRIBUTE_COUNT_LIMIT;
      spanLimits.attributeValueLengthLimit = userConfig.spanLimits?.attributeValueLengthLimit ?? userConfig.generalLimits?.attributeValueLengthLimit ?? (0, core_1.getNumberFromEnv)("OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT") ?? (0, core_1.getNumberFromEnv)("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT") ?? exports.DEFAULT_ATTRIBUTE_VALUE_LENGTH_LIMIT;
      return Object.assign({}, userConfig, { spanLimits });
    }
    __name(reconfigureLimits, "reconfigureLimits");
    exports.reconfigureLimits = reconfigureLimits;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-trace-base/build/src/BasicTracerProvider-shim.js
var require_BasicTracerProvider_shim = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-trace-base/build/src/BasicTracerProvider-shim.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BasicTracerProvider = void 0;
    var core_1 = require_src3();
    var config_1 = require_config();
    var utility_1 = require_utility();
    var sdk_trace_1 = require_src9();
    var BasicTracerProvider = class extends sdk_trace_1.TracerProvider {
      static {
        __name(this, "BasicTracerProvider");
      }
      constructor(config = {}) {
        const mergedConfig = (0, core_1.merge)({}, (0, config_1.loadDefaultConfig)(), (0, utility_1.reconfigureLimits)(config));
        delete mergedConfig.generalLimits;
        super(mergedConfig);
      }
    };
    exports.BasicTracerProvider = BasicTracerProvider;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-trace-base/build/src/BatchSpanProcessor-shim.js
var require_BatchSpanProcessor_shim = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-trace-base/build/src/BatchSpanProcessor-shim.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BatchSpanProcessor = void 0;
    var core_1 = require_src3();
    var sdk_trace_1 = require_src9();
    var BatchSpanProcessor2 = class extends sdk_trace_1.BatchSpanProcessor {
      static {
        __name(this, "BatchSpanProcessor");
      }
      constructor(exporter, config) {
        if (!config) {
          config = {};
        }
        const envFallbacks = [
          ["maxExportBatchSize", "OTEL_BSP_MAX_EXPORT_BATCH_SIZE"],
          ["maxQueueSize", "OTEL_BSP_MAX_QUEUE_SIZE"],
          ["scheduledDelayMillis", "OTEL_BSP_SCHEDULE_DELAY"],
          ["exportTimeoutMillis", "OTEL_BSP_EXPORT_TIMEOUT"]
        ];
        for (const [configName, envName] of envFallbacks) {
          if (config[configName] === void 0) {
            const envFallback = (0, core_1.getNumberFromEnv)(envName);
            if (envFallback !== void 0) {
              config[configName] = envFallback;
            }
          }
        }
        super({ exporter, ...config });
      }
    };
    exports.BatchSpanProcessor = BatchSpanProcessor2;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-trace-base/build/src/SimpleSpanProcessor-shim.js
var require_SimpleSpanProcessor_shim = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-trace-base/build/src/SimpleSpanProcessor-shim.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SimpleSpanProcessor = void 0;
    var sdk_trace_1 = require_src9();
    var SimpleSpanProcessor = class extends sdk_trace_1.SimpleSpanProcessor {
      static {
        __name(this, "SimpleSpanProcessor");
      }
      constructor(exporter) {
        super({ exporter });
      }
    };
    exports.SimpleSpanProcessor = SimpleSpanProcessor;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-trace-base/build/src/index-shim.js
var require_index_shim = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-trace-base/build/src/index-shim.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SamplingDecision = exports.TraceIdRatioBasedSampler = exports.ParentBasedSampler = exports.AlwaysOnSampler = exports.AlwaysOffSampler = exports.NoopSpanProcessor = exports.InMemorySpanExporter = exports.RandomIdGenerator = exports.ConsoleSpanExporter = exports.SimpleSpanProcessor = exports.BatchSpanProcessor = exports.BasicTracerProvider = void 0;
    var BasicTracerProvider_shim_1 = require_BasicTracerProvider_shim();
    Object.defineProperty(exports, "BasicTracerProvider", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return BasicTracerProvider_shim_1.BasicTracerProvider;
    }, "get") });
    var BatchSpanProcessor_shim_1 = require_BatchSpanProcessor_shim();
    Object.defineProperty(exports, "BatchSpanProcessor", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return BatchSpanProcessor_shim_1.BatchSpanProcessor;
    }, "get") });
    var SimpleSpanProcessor_shim_1 = require_SimpleSpanProcessor_shim();
    Object.defineProperty(exports, "SimpleSpanProcessor", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return SimpleSpanProcessor_shim_1.SimpleSpanProcessor;
    }, "get") });
    var sdk_trace_1 = require_src9();
    Object.defineProperty(exports, "ConsoleSpanExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_1.ConsoleSpanExporter;
    }, "get") });
    Object.defineProperty(exports, "RandomIdGenerator", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_1.RandomIdGenerator;
    }, "get") });
    Object.defineProperty(exports, "InMemorySpanExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_1.InMemorySpanExporter;
    }, "get") });
    Object.defineProperty(exports, "NoopSpanProcessor", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_1.NoopSpanProcessor;
    }, "get") });
    Object.defineProperty(exports, "AlwaysOffSampler", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_1.AlwaysOffSampler;
    }, "get") });
    Object.defineProperty(exports, "AlwaysOnSampler", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_1.AlwaysOnSampler;
    }, "get") });
    Object.defineProperty(exports, "ParentBasedSampler", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_1.ParentBasedSampler;
    }, "get") });
    Object.defineProperty(exports, "TraceIdRatioBasedSampler", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_1.TraceIdRatioBasedSampler;
    }, "get") });
    Object.defineProperty(exports, "SamplingDecision", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_1.SamplingDecision;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/sdk-trace-node/build/src/NodeTracerProvider.js
var require_NodeTracerProvider = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-trace-node/build/src/NodeTracerProvider.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.NodeTracerProvider = void 0;
    var context_async_hooks_1 = require_src7();
    var sdk_trace_base_1 = require_index_shim();
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src3();
    function setupContextManager(contextManager) {
      if (contextManager === null) {
        return;
      }
      if (contextManager === void 0) {
        const defaultContextManager = new context_async_hooks_1.AsyncLocalStorageContextManager();
        defaultContextManager.enable();
        api_1.context.setGlobalContextManager(defaultContextManager);
        return;
      }
      contextManager.enable();
      api_1.context.setGlobalContextManager(contextManager);
    }
    __name(setupContextManager, "setupContextManager");
    function setupPropagator(propagator) {
      if (propagator === null) {
        return;
      }
      if (propagator === void 0) {
        api_1.propagation.setGlobalPropagator(new core_1.CompositePropagator({
          propagators: [
            new core_1.W3CTraceContextPropagator(),
            new core_1.W3CBaggagePropagator()
          ]
        }));
        return;
      }
      api_1.propagation.setGlobalPropagator(propagator);
    }
    __name(setupPropagator, "setupPropagator");
    var NodeTracerProvider = class extends sdk_trace_base_1.BasicTracerProvider {
      static {
        __name(this, "NodeTracerProvider");
      }
      constructor(config = {}) {
        super(config);
      }
      /**
       * Register this TracerProvider for use with the OpenTelemetry API.
       * Undefined values may be replaced with defaults, and
       * null values will be skipped.
       *
       * @param config Configuration object for SDK registration
       */
      register(config = {}) {
        api_1.trace.setGlobalTracerProvider(this);
        setupContextManager(config.contextManager);
        setupPropagator(config.propagator);
      }
    };
    exports.NodeTracerProvider = NodeTracerProvider;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-trace-node/build/src/index.js
var require_src10 = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-trace-node/build/src/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.TraceIdRatioBasedSampler = exports.SimpleSpanProcessor = exports.SamplingDecision = exports.RandomIdGenerator = exports.ParentBasedSampler = exports.NoopSpanProcessor = exports.InMemorySpanExporter = exports.ConsoleSpanExporter = exports.BatchSpanProcessor = exports.BasicTracerProvider = exports.AlwaysOnSampler = exports.AlwaysOffSampler = exports.NodeTracerProvider = void 0;
    var NodeTracerProvider_1 = require_NodeTracerProvider();
    Object.defineProperty(exports, "NodeTracerProvider", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return NodeTracerProvider_1.NodeTracerProvider;
    }, "get") });
    var sdk_trace_base_1 = require_index_shim();
    Object.defineProperty(exports, "AlwaysOffSampler", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_base_1.AlwaysOffSampler;
    }, "get") });
    Object.defineProperty(exports, "AlwaysOnSampler", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_base_1.AlwaysOnSampler;
    }, "get") });
    Object.defineProperty(exports, "BasicTracerProvider", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_base_1.BasicTracerProvider;
    }, "get") });
    Object.defineProperty(exports, "BatchSpanProcessor", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_base_1.BatchSpanProcessor;
    }, "get") });
    Object.defineProperty(exports, "ConsoleSpanExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_base_1.ConsoleSpanExporter;
    }, "get") });
    Object.defineProperty(exports, "InMemorySpanExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_base_1.InMemorySpanExporter;
    }, "get") });
    Object.defineProperty(exports, "NoopSpanProcessor", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_base_1.NoopSpanProcessor;
    }, "get") });
    Object.defineProperty(exports, "ParentBasedSampler", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_base_1.ParentBasedSampler;
    }, "get") });
    Object.defineProperty(exports, "RandomIdGenerator", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_base_1.RandomIdGenerator;
    }, "get") });
    Object.defineProperty(exports, "SamplingDecision", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_base_1.SamplingDecision;
    }, "get") });
    Object.defineProperty(exports, "SimpleSpanProcessor", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_base_1.SimpleSpanProcessor;
    }, "get") });
    Object.defineProperty(exports, "TraceIdRatioBasedSampler", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_trace_base_1.TraceIdRatioBasedSampler;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation/build/src/autoLoaderUtils.js
var require_autoLoaderUtils = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation/build/src/autoLoaderUtils.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.disableInstrumentations = exports.enableInstrumentations = void 0;
    function enableInstrumentations(instrumentations, tracerProvider, meterProvider, loggerProvider) {
      for (let i = 0, j = instrumentations.length; i < j; i++) {
        const instrumentation = instrumentations[i];
        if (tracerProvider) {
          instrumentation.setTracerProvider(tracerProvider);
        }
        if (meterProvider) {
          instrumentation.setMeterProvider(meterProvider);
        }
        if (loggerProvider && instrumentation.setLoggerProvider) {
          instrumentation.setLoggerProvider(loggerProvider);
        }
        if (!instrumentation.getConfig().enabled) {
          instrumentation.enable();
        }
      }
    }
    __name(enableInstrumentations, "enableInstrumentations");
    exports.enableInstrumentations = enableInstrumentations;
    function disableInstrumentations(instrumentations) {
      instrumentations.forEach((instrumentation) => instrumentation.disable());
    }
    __name(disableInstrumentations, "disableInstrumentations");
    exports.disableInstrumentations = disableInstrumentations;
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation/build/src/autoLoader.js
var require_autoLoader = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation/build/src/autoLoader.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.registerInstrumentations = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var api_logs_1 = require_src2();
    var autoLoaderUtils_1 = require_autoLoaderUtils();
    function registerInstrumentations(options) {
      const tracerProvider = options.tracerProvider || api_1.trace.getTracerProvider();
      const meterProvider = options.meterProvider || api_1.metrics.getMeterProvider();
      const loggerProvider = options.loggerProvider || api_logs_1.logs.getLoggerProvider();
      const instrumentations = options.instrumentations?.flat() ?? [];
      (0, autoLoaderUtils_1.enableInstrumentations)(instrumentations, tracerProvider, meterProvider, loggerProvider);
      return () => {
        (0, autoLoaderUtils_1.disableInstrumentations)(instrumentations);
      };
    }
    __name(registerInstrumentations, "registerInstrumentations");
    exports.registerInstrumentations = registerInstrumentations;
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation/build/src/semver.js
var require_semver = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation/build/src/semver.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.satisfies = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var VERSION_REGEXP = /^(?:v)?(?<version>(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*))(?:-(?<prerelease>(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+(?<build>[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
    var RANGE_REGEXP = /^(?<op><|>|=|==|<=|>=|~|\^|~>)?\s*(?:v)?(?<version>(?<major>x|X|\*|0|[1-9]\d*)(?:\.(?<minor>x|X|\*|0|[1-9]\d*))?(?:\.(?<patch>x|X|\*|0|[1-9]\d*))?)(?:-(?<prerelease>(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+(?<build>[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
    var operatorResMap = {
      ">": [1],
      ">=": [0, 1],
      "=": [0],
      "<=": [-1, 0],
      "<": [-1],
      "!=": [-1, 1]
    };
    function satisfies(version, range, options) {
      if (!_validateVersion(version)) {
        api_1.diag.error(`Invalid version: ${version}`);
        return false;
      }
      if (!range) {
        return true;
      }
      range = range.replace(/([<>=~^]+)\s+/g, "$1");
      const parsedVersion = _parseVersion(version);
      if (!parsedVersion) {
        return false;
      }
      const allParsedRanges = [];
      const checkResult = _doSatisfies(parsedVersion, range, allParsedRanges, options);
      if (checkResult && !options?.includePrerelease) {
        return _doPreleaseCheck(parsedVersion, allParsedRanges);
      }
      return checkResult;
    }
    __name(satisfies, "satisfies");
    exports.satisfies = satisfies;
    function _validateVersion(version) {
      return typeof version === "string" && VERSION_REGEXP.test(version);
    }
    __name(_validateVersion, "_validateVersion");
    function _doSatisfies(parsedVersion, range, allParsedRanges, options) {
      if (range.includes("||")) {
        const ranges = range.trim().split("||");
        for (const r of ranges) {
          if (_checkRange(parsedVersion, r, allParsedRanges, options)) {
            return true;
          }
        }
        return false;
      } else if (range.includes(" - ")) {
        range = replaceHyphen(range, options);
      } else if (range.includes(" ")) {
        const ranges = range.trim().replace(/\s{2,}/g, " ").split(" ");
        for (const r of ranges) {
          if (!_checkRange(parsedVersion, r, allParsedRanges, options)) {
            return false;
          }
        }
        return true;
      }
      return _checkRange(parsedVersion, range, allParsedRanges, options);
    }
    __name(_doSatisfies, "_doSatisfies");
    function _checkRange(parsedVersion, range, allParsedRanges, options) {
      range = _normalizeRange(range, options);
      if (range.includes(" ")) {
        return _doSatisfies(parsedVersion, range, allParsedRanges, options);
      } else {
        const parsedRange = _parseRange(range);
        allParsedRanges.push(parsedRange);
        return _satisfies(parsedVersion, parsedRange);
      }
    }
    __name(_checkRange, "_checkRange");
    function _satisfies(parsedVersion, parsedRange) {
      if (parsedRange.invalid) {
        return false;
      }
      if (!parsedRange.version || _isWildcard(parsedRange.version)) {
        return true;
      }
      let comparisonResult = _compareVersionSegments(parsedVersion.versionSegments || [], parsedRange.versionSegments || []);
      if (comparisonResult === 0) {
        const versionPrereleaseSegments = parsedVersion.prereleaseSegments || [];
        const rangePrereleaseSegments = parsedRange.prereleaseSegments || [];
        if (!versionPrereleaseSegments.length && !rangePrereleaseSegments.length) {
          comparisonResult = 0;
        } else if (!versionPrereleaseSegments.length && rangePrereleaseSegments.length) {
          comparisonResult = 1;
        } else if (versionPrereleaseSegments.length && !rangePrereleaseSegments.length) {
          comparisonResult = -1;
        } else {
          comparisonResult = _compareVersionSegments(versionPrereleaseSegments, rangePrereleaseSegments);
        }
      }
      return operatorResMap[parsedRange.op]?.includes(comparisonResult);
    }
    __name(_satisfies, "_satisfies");
    function _doPreleaseCheck(parsedVersion, allParsedRanges) {
      if (parsedVersion.prerelease) {
        return allParsedRanges.some((r) => r.prerelease && r.version === parsedVersion.version);
      }
      return true;
    }
    __name(_doPreleaseCheck, "_doPreleaseCheck");
    function _normalizeRange(range, options) {
      range = range.trim();
      range = replaceCaret(range, options);
      range = replaceTilde(range);
      range = replaceXRange(range, options);
      range = range.trim();
      return range;
    }
    __name(_normalizeRange, "_normalizeRange");
    function isX(id) {
      return !id || id.toLowerCase() === "x" || id === "*";
    }
    __name(isX, "isX");
    function _parseVersion(versionString) {
      const match = versionString.match(VERSION_REGEXP);
      if (!match) {
        api_1.diag.error(`Invalid version: ${versionString}`);
        return void 0;
      }
      const version = match.groups.version;
      const prerelease = match.groups.prerelease;
      const build = match.groups.build;
      const versionSegments = version.split(".");
      const prereleaseSegments = prerelease?.split(".");
      return {
        op: void 0,
        version,
        versionSegments,
        versionSegmentCount: versionSegments.length,
        prerelease,
        prereleaseSegments,
        prereleaseSegmentCount: prereleaseSegments ? prereleaseSegments.length : 0,
        build
      };
    }
    __name(_parseVersion, "_parseVersion");
    function _parseRange(rangeString) {
      if (!rangeString) {
        return {};
      }
      const match = rangeString.match(RANGE_REGEXP);
      if (!match) {
        api_1.diag.error(`Invalid range: ${rangeString}`);
        return {
          invalid: true
        };
      }
      let op = match.groups.op;
      const version = match.groups.version;
      const prerelease = match.groups.prerelease;
      const build = match.groups.build;
      const versionSegments = version.split(".");
      const prereleaseSegments = prerelease?.split(".");
      if (op === "==") {
        op = "=";
      }
      return {
        op: op || "=",
        version,
        versionSegments,
        versionSegmentCount: versionSegments.length,
        prerelease,
        prereleaseSegments,
        prereleaseSegmentCount: prereleaseSegments ? prereleaseSegments.length : 0,
        build
      };
    }
    __name(_parseRange, "_parseRange");
    function _isWildcard(s) {
      return s === "*" || s === "x" || s === "X";
    }
    __name(_isWildcard, "_isWildcard");
    function _parseVersionString(v) {
      const n = parseInt(v, 10);
      return isNaN(n) ? v : n;
    }
    __name(_parseVersionString, "_parseVersionString");
    function _normalizeVersionType(a, b) {
      if (typeof a === typeof b) {
        if (typeof a === "number") {
          return [a, b];
        } else if (typeof a === "string") {
          return [a, b];
        } else {
          throw new Error("Version segments can only be strings or numbers");
        }
      } else {
        return [String(a), String(b)];
      }
    }
    __name(_normalizeVersionType, "_normalizeVersionType");
    function _compareVersionStrings(v1, v2) {
      if (_isWildcard(v1) || _isWildcard(v2)) {
        return 0;
      }
      const [parsedV1, parsedV2] = _normalizeVersionType(_parseVersionString(v1), _parseVersionString(v2));
      if (parsedV1 > parsedV2) {
        return 1;
      } else if (parsedV1 < parsedV2) {
        return -1;
      }
      return 0;
    }
    __name(_compareVersionStrings, "_compareVersionStrings");
    function _compareVersionSegments(v1, v2) {
      for (let i = 0; i < Math.max(v1.length, v2.length); i++) {
        const res = _compareVersionStrings(v1[i] || "0", v2[i] || "0");
        if (res !== 0) {
          return res;
        }
      }
      return 0;
    }
    __name(_compareVersionSegments, "_compareVersionSegments");
    var LETTERDASHNUMBER = "[a-zA-Z0-9-]";
    var NUMERICIDENTIFIER = "0|[1-9]\\d*";
    var NONNUMERICIDENTIFIER = `\\d*[a-zA-Z-]${LETTERDASHNUMBER}*`;
    var GTLT = "((?:<|>)?=?)";
    var PRERELEASEIDENTIFIER = `(?:${NUMERICIDENTIFIER}|${NONNUMERICIDENTIFIER})`;
    var PRERELEASE = `(?:-(${PRERELEASEIDENTIFIER}(?:\\.${PRERELEASEIDENTIFIER})*))`;
    var BUILDIDENTIFIER = `${LETTERDASHNUMBER}+`;
    var BUILD = `(?:\\+(${BUILDIDENTIFIER}(?:\\.${BUILDIDENTIFIER})*))`;
    var XRANGEIDENTIFIER = `${NUMERICIDENTIFIER}|x|X|\\*`;
    var XRANGEPLAIN = `[v=\\s]*(${XRANGEIDENTIFIER})(?:\\.(${XRANGEIDENTIFIER})(?:\\.(${XRANGEIDENTIFIER})(?:${PRERELEASE})?${BUILD}?)?)?`;
    var XRANGE = `^${GTLT}\\s*${XRANGEPLAIN}$`;
    var XRANGE_REGEXP = new RegExp(XRANGE);
    var HYPHENRANGE = `^\\s*(${XRANGEPLAIN})\\s+-\\s+(${XRANGEPLAIN})\\s*$`;
    var HYPHENRANGE_REGEXP = new RegExp(HYPHENRANGE);
    var LONETILDE = "(?:~>?)";
    var TILDE = `^${LONETILDE}${XRANGEPLAIN}$`;
    var TILDE_REGEXP = new RegExp(TILDE);
    var LONECARET = "(?:\\^)";
    var CARET = `^${LONECARET}${XRANGEPLAIN}$`;
    var CARET_REGEXP = new RegExp(CARET);
    function replaceTilde(comp) {
      const r = TILDE_REGEXP;
      return comp.replace(r, (_, M, m, p, pr) => {
        let ret;
        if (isX(M)) {
          ret = "";
        } else if (isX(m)) {
          ret = `>=${M}.0.0 <${+M + 1}.0.0-0`;
        } else if (isX(p)) {
          ret = `>=${M}.${m}.0 <${M}.${+m + 1}.0-0`;
        } else if (pr) {
          ret = `>=${M}.${m}.${p}-${pr} <${M}.${+m + 1}.0-0`;
        } else {
          ret = `>=${M}.${m}.${p} <${M}.${+m + 1}.0-0`;
        }
        return ret;
      });
    }
    __name(replaceTilde, "replaceTilde");
    function replaceCaret(comp, options) {
      const r = CARET_REGEXP;
      const z = options?.includePrerelease ? "-0" : "";
      return comp.replace(r, (_, M, m, p, pr) => {
        let ret;
        if (isX(M)) {
          ret = "";
        } else if (isX(m)) {
          ret = `>=${M}.0.0${z} <${+M + 1}.0.0-0`;
        } else if (isX(p)) {
          if (M === "0") {
            ret = `>=${M}.${m}.0${z} <${M}.${+m + 1}.0-0`;
          } else {
            ret = `>=${M}.${m}.0${z} <${+M + 1}.0.0-0`;
          }
        } else if (pr) {
          if (M === "0") {
            if (m === "0") {
              ret = `>=${M}.${m}.${p}-${pr} <${M}.${m}.${+p + 1}-0`;
            } else {
              ret = `>=${M}.${m}.${p}-${pr} <${M}.${+m + 1}.0-0`;
            }
          } else {
            ret = `>=${M}.${m}.${p}-${pr} <${+M + 1}.0.0-0`;
          }
        } else {
          if (M === "0") {
            if (m === "0") {
              ret = `>=${M}.${m}.${p}${z} <${M}.${m}.${+p + 1}-0`;
            } else {
              ret = `>=${M}.${m}.${p}${z} <${M}.${+m + 1}.0-0`;
            }
          } else {
            ret = `>=${M}.${m}.${p} <${+M + 1}.0.0-0`;
          }
        }
        return ret;
      });
    }
    __name(replaceCaret, "replaceCaret");
    function replaceXRange(comp, options) {
      const r = XRANGE_REGEXP;
      return comp.replace(r, (ret, gtlt, M, m, p, pr) => {
        const xM = isX(M);
        const xm = xM || isX(m);
        const xp = xm || isX(p);
        const anyX = xp;
        if (gtlt === "=" && anyX) {
          gtlt = "";
        }
        pr = options?.includePrerelease ? "-0" : "";
        if (xM) {
          if (gtlt === ">" || gtlt === "<") {
            ret = "<0.0.0-0";
          } else {
            ret = "*";
          }
        } else if (gtlt && anyX) {
          if (xm) {
            m = 0;
          }
          p = 0;
          if (gtlt === ">") {
            gtlt = ">=";
            if (xm) {
              M = +M + 1;
              m = 0;
              p = 0;
            } else {
              m = +m + 1;
              p = 0;
            }
          } else if (gtlt === "<=") {
            gtlt = "<";
            if (xm) {
              M = +M + 1;
            } else {
              m = +m + 1;
            }
          }
          if (gtlt === "<") {
            pr = "-0";
          }
          ret = `${gtlt + M}.${m}.${p}${pr}`;
        } else if (xm) {
          ret = `>=${M}.0.0${pr} <${+M + 1}.0.0-0`;
        } else if (xp) {
          ret = `>=${M}.${m}.0${pr} <${M}.${+m + 1}.0-0`;
        }
        return ret;
      });
    }
    __name(replaceXRange, "replaceXRange");
    function replaceHyphen(comp, options) {
      const r = HYPHENRANGE_REGEXP;
      return comp.replace(r, (_, from, fM, fm, fp, fpr, fb, to, tM, tm, tp, tpr) => {
        if (isX(fM)) {
          from = "";
        } else if (isX(fm)) {
          from = `>=${fM}.0.0${options?.includePrerelease ? "-0" : ""}`;
        } else if (isX(fp)) {
          from = `>=${fM}.${fm}.0${options?.includePrerelease ? "-0" : ""}`;
        } else if (fpr) {
          from = `>=${from}`;
        } else {
          from = `>=${from}${options?.includePrerelease ? "-0" : ""}`;
        }
        if (isX(tM)) {
          to = "";
        } else if (isX(tm)) {
          to = `<${+tM + 1}.0.0-0`;
        } else if (isX(tp)) {
          to = `<${tM}.${+tm + 1}.0-0`;
        } else if (tpr) {
          to = `<=${tM}.${tm}.${tp}-${tpr}`;
        } else if (options?.includePrerelease) {
          to = `<${tM}.${tm}.${+tp + 1}-0`;
        } else {
          to = `<=${to}`;
        }
        return `${from} ${to}`.trim();
      });
    }
    __name(replaceHyphen, "replaceHyphen");
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation/build/src/shimmer.js
var require_shimmer = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation/build/src/shimmer.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.massUnwrap = exports.unwrap = exports.massWrap = exports.wrap = void 0;
    var logger = console.error.bind(console);
    function defineProperty(obj, name, value) {
      const enumerable = !!obj[name] && Object.prototype.propertyIsEnumerable.call(obj, name);
      Object.defineProperty(obj, name, {
        configurable: true,
        enumerable,
        writable: true,
        value
      });
    }
    __name(defineProperty, "defineProperty");
    var wrap = /* @__PURE__ */ __name((nodule, name, wrapper) => {
      if (!nodule || !nodule[name]) {
        logger("no original function " + String(name) + " to wrap");
        return;
      }
      if (!wrapper) {
        logger("no wrapper function");
        logger(new Error().stack);
        return;
      }
      const original = nodule[name];
      if (typeof original !== "function" || typeof wrapper !== "function") {
        logger("original object and wrapper must be functions");
        return;
      }
      const wrapped = wrapper(original, name);
      defineProperty(wrapped, "__original", original);
      defineProperty(wrapped, "__unwrap", () => {
        if (nodule[name] === wrapped) {
          defineProperty(nodule, name, original);
        }
      });
      defineProperty(wrapped, "__wrapped", true);
      defineProperty(nodule, name, wrapped);
      return wrapped;
    }, "wrap");
    exports.wrap = wrap;
    var massWrap = /* @__PURE__ */ __name((nodules, names, wrapper) => {
      if (!nodules) {
        logger("must provide one or more modules to patch");
        logger(new Error().stack);
        return;
      } else if (!Array.isArray(nodules)) {
        nodules = [nodules];
      }
      if (!(names && Array.isArray(names))) {
        logger("must provide one or more functions to wrap on modules");
        return;
      }
      nodules.forEach((nodule) => {
        names.forEach((name) => {
          (0, exports.wrap)(nodule, name, wrapper);
        });
      });
    }, "massWrap");
    exports.massWrap = massWrap;
    var unwrap = /* @__PURE__ */ __name((nodule, name) => {
      if (!nodule || !nodule[name]) {
        logger("no function to unwrap.");
        logger(new Error().stack);
        return;
      }
      const wrapped = nodule[name];
      if (!wrapped.__unwrap) {
        logger("no original to unwrap to -- has " + String(name) + " already been unwrapped?");
      } else {
        wrapped.__unwrap();
        return;
      }
    }, "unwrap");
    exports.unwrap = unwrap;
    var massUnwrap = /* @__PURE__ */ __name((nodules, names) => {
      if (!nodules) {
        logger("must provide one or more modules to patch");
        logger(new Error().stack);
        return;
      } else if (!Array.isArray(nodules)) {
        nodules = [nodules];
      }
      if (!(names && Array.isArray(names))) {
        logger("must provide one or more functions to unwrap on modules");
        return;
      }
      nodules.forEach((nodule) => {
        names.forEach((name) => {
          (0, exports.unwrap)(nodule, name);
        });
      });
    }, "massUnwrap");
    exports.massUnwrap = massUnwrap;
    function shimmer(options) {
      if (options && options.logger) {
        if (typeof options.logger !== "function") {
          logger("new logger isn't a function, not replacing");
        } else {
          logger = options.logger;
        }
      }
    }
    __name(shimmer, "shimmer");
    exports.default = shimmer;
    shimmer.wrap = exports.wrap;
    shimmer.massWrap = exports.massWrap;
    shimmer.unwrap = exports.unwrap;
    shimmer.massUnwrap = exports.massUnwrap;
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation/build/src/instrumentation.js
var require_instrumentation = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation/build/src/instrumentation.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.InstrumentationAbstract = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var api_logs_1 = require_src2();
    var shimmer = require_shimmer();
    var InstrumentationAbstract = class {
      static {
        __name(this, "InstrumentationAbstract");
      }
      _config = {};
      _tracer;
      _meter;
      _logger;
      _diag;
      instrumentationName;
      instrumentationVersion;
      constructor(instrumentationName, instrumentationVersion, config) {
        this.instrumentationName = instrumentationName;
        this.instrumentationVersion = instrumentationVersion;
        this.setConfig(config);
        this._diag = api_1.diag.createComponentLogger({
          namespace: instrumentationName
        });
        this._tracer = api_1.trace.getTracer(instrumentationName, instrumentationVersion);
        this._meter = api_1.metrics.getMeter(instrumentationName, instrumentationVersion);
        this._logger = api_logs_1.logs.getLogger(instrumentationName, instrumentationVersion);
        this._updateMetricInstruments();
      }
      /* Api to wrap instrumented method */
      _wrap = shimmer.wrap;
      /* Api to unwrap instrumented methods */
      _unwrap = shimmer.unwrap;
      /* Api to mass wrap instrumented method */
      _massWrap = shimmer.massWrap;
      /* Api to mass unwrap instrumented methods */
      _massUnwrap = shimmer.massUnwrap;
      /* Returns meter */
      get meter() {
        return this._meter;
      }
      /**
       * Sets MeterProvider to this plugin
       * @param meterProvider
       */
      setMeterProvider(meterProvider) {
        this._meter = meterProvider.getMeter(this.instrumentationName, this.instrumentationVersion);
        this._updateMetricInstruments();
      }
      /* Returns logger */
      get logger() {
        return this._logger;
      }
      /**
       * Sets LoggerProvider to this plugin
       * @param loggerProvider
       */
      setLoggerProvider(loggerProvider) {
        this._logger = loggerProvider.getLogger(this.instrumentationName, this.instrumentationVersion);
      }
      /**
       * @experimental
       *
       * Get module definitions defined by {@link init}.
       * This can be used for experimental compile-time instrumentation.
       *
       * @returns an array of {@link InstrumentationModuleDefinition}
       */
      getModuleDefinitions() {
        const initResult = this.init() ?? [];
        if (!Array.isArray(initResult)) {
          return [initResult];
        }
        return initResult;
      }
      /**
       * Sets the new metric instruments with the current Meter.
       */
      _updateMetricInstruments() {
        return;
      }
      /* Returns InstrumentationConfig */
      getConfig() {
        return this._config;
      }
      /**
       * Sets InstrumentationConfig to this plugin
       * @param config
       */
      setConfig(config) {
        this._config = {
          enabled: true,
          ...config
        };
      }
      /**
       * Sets TracerProvider to this plugin
       * @param tracerProvider
       */
      setTracerProvider(tracerProvider) {
        this._tracer = tracerProvider.getTracer(this.instrumentationName, this.instrumentationVersion);
      }
      /* Returns tracer */
      get tracer() {
        return this._tracer;
      }
      /**
       * Execute span customization hook, if configured, and log any errors.
       * Any semantics of the trigger and info are defined by the specific instrumentation.
       * @param hookHandler The optional hook handler which the user has configured via instrumentation config
       * @param triggerName The name of the trigger for executing the hook for logging purposes
       * @param span The span to which the hook should be applied
       * @param info The info object to be passed to the hook, with useful data the hook may use
       */
      _runSpanCustomizationHook(hookHandler, triggerName, span, info) {
        if (!hookHandler) {
          return;
        }
        try {
          hookHandler(span, info);
        } catch (e) {
          this._diag.error("Error running span customization hook due to exception in handler", { triggerName }, e);
        }
      }
    };
    exports.InstrumentationAbstract = InstrumentationAbstract;
  }
});

// node_modules/module-details-from-path/index.js
var require_module_details_from_path = __commonJS({
  "node_modules/module-details-from-path/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var sep = __require("path").sep;
    module.exports = function(file) {
      var segments = file.split(sep);
      var index = segments.lastIndexOf("node_modules");
      if (index === -1) return;
      if (!segments[index + 1]) return;
      var scoped = segments[index + 1][0] === "@";
      var name = scoped ? segments[index + 1] + "/" + segments[index + 2] : segments[index + 1];
      var offset = scoped ? 3 : 2;
      var basedir = "";
      var lastBaseDirSegmentIndex = index + offset - 1;
      for (var i = 0; i <= lastBaseDirSegmentIndex; i++) {
        if (i === lastBaseDirSegmentIndex) {
          basedir += segments[i];
        } else {
          basedir += segments[i] + sep;
        }
      }
      var path2 = "";
      var lastSegmentIndex = segments.length - 1;
      for (var i2 = index + offset; i2 <= lastSegmentIndex; i2++) {
        if (i2 === lastSegmentIndex) {
          path2 += segments[i2];
        } else {
          path2 += segments[i2] + sep;
        }
      }
      return {
        name,
        basedir,
        path: path2
      };
    };
  }
});

// packages/core/node_modules/require-in-the-middle/index.js
var require_require_in_the_middle = __commonJS({
  "packages/core/node_modules/require-in-the-middle/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var path2 = __require("path");
    var Module = __require("module");
    var debug = require_src()("require-in-the-middle");
    var moduleDetailsFromPath = require_module_details_from_path();
    module.exports = Hook;
    module.exports.Hook = Hook;
    var builtinModules;
    var isCore;
    if (Module.isBuiltin) {
      isCore = Module.isBuiltin;
    } else if (Module.builtinModules) {
      isCore = /* @__PURE__ */ __name((moduleName) => {
        if (moduleName.startsWith("node:")) {
          return true;
        }
        if (builtinModules === void 0) {
          builtinModules = new Set(Module.builtinModules);
        }
        return builtinModules.has(moduleName);
      }, "isCore");
    } else {
      throw new Error("'require-in-the-middle' requires Node.js >=v9.3.0 or >=v8.10.0");
    }
    var normalize = /([/\\]index)?(\.js)?$/;
    var ExportsCache = class {
      static {
        __name(this, "ExportsCache");
      }
      constructor() {
        this._localCache = /* @__PURE__ */ new Map();
        this._kRitmExports = Symbol("RitmExports");
      }
      has(filename, isBuiltin) {
        if (this._localCache.has(filename)) {
          return true;
        } else if (!isBuiltin) {
          const mod = __require.cache[filename];
          return !!(mod && this._kRitmExports in mod);
        } else {
          return false;
        }
      }
      get(filename, isBuiltin) {
        const cachedExports = this._localCache.get(filename);
        if (cachedExports !== void 0) {
          return cachedExports;
        } else if (!isBuiltin) {
          const mod = __require.cache[filename];
          return mod && mod[this._kRitmExports];
        }
      }
      set(filename, exports2, isBuiltin) {
        if (isBuiltin) {
          this._localCache.set(filename, exports2);
        } else if (filename in __require.cache) {
          __require.cache[filename][this._kRitmExports] = exports2;
        } else {
          debug('non-core module is unexpectedly not in require.cache: "%s"', filename);
          this._localCache.set(filename, exports2);
        }
      }
    };
    function Hook(modules, options, onrequire) {
      if (this instanceof Hook === false) return new Hook(modules, options, onrequire);
      if (typeof modules === "function") {
        onrequire = modules;
        modules = null;
        options = null;
      } else if (typeof options === "function") {
        onrequire = options;
        options = null;
      }
      if (typeof Module._resolveFilename !== "function") {
        console.error("Error: Expected Module._resolveFilename to be a function (was: %s) - aborting!", typeof Module._resolveFilename);
        console.error("Please report this error as an issue related to Node.js %s at https://github.com/nodejs/require-in-the-middle/issues", process.version);
        return;
      }
      this._cache = new ExportsCache();
      this._unhooked = false;
      this._origRequire = Module.prototype.require;
      const self = this;
      const patching = /* @__PURE__ */ new Set();
      const internals = options ? options.internals === true : false;
      const hasWhitelist = Array.isArray(modules);
      debug("registering require hook");
      this._require = Module.prototype.require = function(id) {
        if (self._unhooked === true) {
          debug("ignoring require call - module is soft-unhooked");
          return self._origRequire.apply(this, arguments);
        }
        return patchedRequire.call(this, arguments, false);
      };
      if (typeof process.getBuiltinModule === "function") {
        this._origGetBuiltinModule = process.getBuiltinModule;
        this._getBuiltinModule = process.getBuiltinModule = function(id) {
          if (self._unhooked === true) {
            debug("ignoring process.getBuiltinModule call - module is soft-unhooked");
            return self._origGetBuiltinModule.apply(this, arguments);
          }
          return patchedRequire.call(this, arguments, true);
        };
      }
      function patchedRequire(args, coreOnly) {
        const id = args[0];
        const core = isCore(id);
        let filename;
        if (core) {
          filename = id;
          if (id.startsWith("node:")) {
            const idWithoutPrefix = id.slice(5);
            if (isCore(idWithoutPrefix)) {
              filename = idWithoutPrefix;
            }
          }
        } else if (coreOnly) {
          debug("call to process.getBuiltinModule with unknown built-in id");
          return self._origGetBuiltinModule.apply(this, args);
        } else {
          try {
            filename = Module._resolveFilename(id, this);
          } catch (resolveErr) {
            debug('Module._resolveFilename("%s") threw %j, calling original Module.require', id, resolveErr.message);
            return self._origRequire.apply(this, args);
          }
        }
        let moduleName, basedir;
        debug("processing %s module require('%s'): %s", core === true ? "core" : "non-core", id, filename);
        if (self._cache.has(filename, core) === true) {
          debug("returning already patched cached module: %s", filename);
          return self._cache.get(filename, core);
        }
        const isPatching = patching.has(filename);
        if (isPatching === false) {
          patching.add(filename);
        }
        const exports2 = coreOnly ? self._origGetBuiltinModule.apply(this, args) : self._origRequire.apply(this, args);
        if (isPatching === true) {
          debug("module is in the process of being patched already - ignoring: %s", filename);
          return exports2;
        }
        patching.delete(filename);
        if (core === true) {
          if (hasWhitelist === true && modules.includes(filename) === false) {
            debug("ignoring core module not on whitelist: %s", filename);
            return exports2;
          }
          moduleName = filename;
        } else if (hasWhitelist === true && modules.includes(filename)) {
          const parsedPath = path2.parse(filename);
          moduleName = parsedPath.name;
          basedir = parsedPath.dir;
        } else {
          const stat = moduleDetailsFromPath(filename);
          if (stat === void 0) {
            debug("could not parse filename: %s", filename);
            return exports2;
          }
          moduleName = stat.name;
          basedir = stat.basedir;
          const fullModuleName = resolveModuleName(stat);
          debug("resolved filename to module: %s (id: %s, resolved: %s, basedir: %s)", moduleName, id, fullModuleName, basedir);
          let matchFound = false;
          if (hasWhitelist) {
            if (!id.startsWith(".") && modules.includes(id)) {
              moduleName = id;
              matchFound = true;
            }
            if (!modules.includes(moduleName) && !modules.includes(fullModuleName)) {
              return exports2;
            }
            if (modules.includes(fullModuleName) && fullModuleName !== moduleName) {
              moduleName = fullModuleName;
              matchFound = true;
            }
          }
          if (!matchFound) {
            let res;
            try {
              res = __require.resolve(moduleName, { paths: [basedir] });
            } catch (e) {
              debug("could not resolve module: %s", moduleName);
              self._cache.set(filename, exports2, core);
              return exports2;
            }
            if (res !== filename) {
              if (internals === true) {
                moduleName = moduleName + path2.sep + path2.relative(basedir, filename);
                debug("preparing to process require of internal file: %s", moduleName);
              } else {
                debug("ignoring require of non-main module file: %s", res);
                self._cache.set(filename, exports2, core);
                return exports2;
              }
            }
          }
        }
        self._cache.set(filename, exports2, core);
        debug("calling require hook: %s", moduleName);
        const patchedExports = onrequire(exports2, moduleName, basedir);
        self._cache.set(filename, patchedExports, core);
        debug("returning module: %s", moduleName);
        return patchedExports;
      }
      __name(patchedRequire, "patchedRequire");
    }
    __name(Hook, "Hook");
    Hook.prototype.unhook = function() {
      this._unhooked = true;
      if (this._require === Module.prototype.require) {
        Module.prototype.require = this._origRequire;
        debug("require unhook successful");
      } else {
        debug("require unhook unsuccessful");
      }
      if (process.getBuiltinModule !== void 0) {
        if (this._getBuiltinModule === process.getBuiltinModule) {
          process.getBuiltinModule = this._origGetBuiltinModule;
          debug("process.getBuiltinModule unhook successful");
        } else {
          debug("process.getBuiltinModule unhook unsuccessful");
        }
      }
    };
    function resolveModuleName(stat) {
      const normalizedPath = path2.sep !== "/" ? stat.path.split(path2.sep).join("/") : stat.path;
      return path2.posix.join(stat.name, normalizedPath).replace(normalize, "");
    }
    __name(resolveModuleName, "resolveModuleName");
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation/build/src/platform/node/ModuleNameTrie.js
var require_ModuleNameTrie = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation/build/src/platform/node/ModuleNameTrie.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ModuleNameTrie = exports.ModuleNameSeparator = void 0;
    exports.ModuleNameSeparator = "/";
    var ModuleNameTrieNode = class {
      static {
        __name(this, "ModuleNameTrieNode");
      }
      hooks = [];
      children = /* @__PURE__ */ new Map();
    };
    var ModuleNameTrie = class {
      static {
        __name(this, "ModuleNameTrie");
      }
      _trie = new ModuleNameTrieNode();
      _counter = 0;
      /**
       * Insert a module hook into the trie
       *
       * @param {Hooked} hook Hook
       */
      insert(hook) {
        let trieNode = this._trie;
        for (const moduleNamePart of hook.moduleName.split(exports.ModuleNameSeparator)) {
          let nextNode = trieNode.children.get(moduleNamePart);
          if (!nextNode) {
            nextNode = new ModuleNameTrieNode();
            trieNode.children.set(moduleNamePart, nextNode);
          }
          trieNode = nextNode;
        }
        trieNode.hooks.push({ hook, insertedId: this._counter++ });
      }
      /**
       * Search for matching hooks in the trie
       *
       * @param {string} moduleName Module name
       * @param {boolean} maintainInsertionOrder Whether to return the results in insertion order
       * @param {boolean} fullOnly Whether to return only full matches
       * @returns {Hooked[]} Matching hooks
       */
      search(moduleName, { maintainInsertionOrder, fullOnly } = {}) {
        let trieNode = this._trie;
        const results = [];
        let foundFull = true;
        for (const moduleNamePart of moduleName.split(exports.ModuleNameSeparator)) {
          const nextNode = trieNode.children.get(moduleNamePart);
          if (!nextNode) {
            foundFull = false;
            break;
          }
          if (!fullOnly) {
            results.push(...nextNode.hooks);
          }
          trieNode = nextNode;
        }
        if (fullOnly && foundFull) {
          results.push(...trieNode.hooks);
        }
        if (results.length === 0) {
          return [];
        }
        if (results.length === 1) {
          return [results[0].hook];
        }
        if (maintainInsertionOrder) {
          results.sort((a, b) => a.insertedId - b.insertedId);
        }
        return results.map(({ hook }) => hook);
      }
    };
    exports.ModuleNameTrie = ModuleNameTrie;
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation/build/src/platform/node/RequireInTheMiddleSingleton.js
var require_RequireInTheMiddleSingleton = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation/build/src/platform/node/RequireInTheMiddleSingleton.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.RequireInTheMiddleSingleton = void 0;
    var require_in_the_middle_1 = require_require_in_the_middle();
    var path2 = __require("path");
    var ModuleNameTrie_1 = require_ModuleNameTrie();
    var isMocha = [
      "afterEach",
      "after",
      "beforeEach",
      "before",
      "describe",
      "it"
    ].every((fn) => {
      return typeof globalThis[fn] === "function";
    });
    var RequireInTheMiddleSingleton = class _RequireInTheMiddleSingleton {
      static {
        __name(this, "RequireInTheMiddleSingleton");
      }
      _moduleNameTrie = new ModuleNameTrie_1.ModuleNameTrie();
      static _instance;
      constructor() {
        this._initialize();
      }
      _initialize() {
        new require_in_the_middle_1.Hook(
          // Intercept all `require` calls; we will filter the matching ones below
          null,
          { internals: true },
          (exports2, name, basedir) => {
            const normalizedModuleName = normalizePathSeparators(name);
            const matches = this._moduleNameTrie.search(normalizedModuleName, {
              maintainInsertionOrder: true,
              // For core modules (e.g. `fs`), do not match on sub-paths (e.g. `fs/promises').
              // This matches the behavior of `require-in-the-middle`.
              // `basedir` is always `undefined` for core modules.
              fullOnly: basedir === void 0
            });
            for (const { onRequire } of matches) {
              exports2 = onRequire(exports2, name, basedir);
            }
            return exports2;
          }
        );
      }
      /**
       * Register a hook with `require-in-the-middle`
       *
       * @param {string} moduleName Module name
       * @param {OnRequireFn} onRequire Hook function
       * @returns {Hooked} Registered hook
       */
      register(moduleName, onRequire) {
        const hooked = { moduleName, onRequire };
        this._moduleNameTrie.insert(hooked);
        return hooked;
      }
      /**
       * Get the `RequireInTheMiddleSingleton` singleton
       *
       * @returns {RequireInTheMiddleSingleton} Singleton of `RequireInTheMiddleSingleton`
       */
      static getInstance() {
        if (isMocha)
          return new _RequireInTheMiddleSingleton();
        return this._instance = this._instance ?? new _RequireInTheMiddleSingleton();
      }
    };
    exports.RequireInTheMiddleSingleton = RequireInTheMiddleSingleton;
    function normalizePathSeparators(moduleNameOrPath) {
      return path2.sep !== ModuleNameTrie_1.ModuleNameSeparator ? moduleNameOrPath.split(path2.sep).join(ModuleNameTrie_1.ModuleNameSeparator) : moduleNameOrPath;
    }
    __name(normalizePathSeparators, "normalizePathSeparators");
  }
});

// packages/core/node_modules/import-in-the-middle/lib/register.js
var require_register = __commonJS({
  "packages/core/node_modules/import-in-the-middle/lib/register.js"(exports) {
    init_esbuild_shims();
    var importHooks = [];
    var setters = /* @__PURE__ */ new WeakMap();
    var getters = /* @__PURE__ */ new WeakMap();
    var specifiers = /* @__PURE__ */ new Map();
    var toHook = [];
    var proxyHandler = {
      set(target, name, value) {
        const set = setters.get(target);
        const setter = set && set[name];
        if (typeof setter === "function") {
          return setter(value);
        }
        return true;
      },
      get(target, name) {
        if (name === Symbol.toStringTag) {
          return "Module";
        }
        const getter = getters.get(target)[name];
        if (typeof getter === "function") {
          return getter();
        }
      },
      defineProperty(target, property, descriptor) {
        if (!("value" in descriptor)) {
          throw new Error("Getters/setters are not supported for exports property descriptors.");
        }
        const set = setters.get(target);
        const setter = set && set[property];
        if (typeof setter === "function") {
          return setter(descriptor.value);
        }
        return true;
      }
    };
    function register(name, namespace, set, get, specifier) {
      specifiers.set(name, specifier);
      setters.set(namespace, set);
      getters.set(namespace, get);
      const proxy = new Proxy(namespace, proxyHandler);
      importHooks.forEach((hook) => hook(name, proxy, specifier));
      toHook.push([name, proxy, specifier]);
    }
    __name(register, "register");
    var RETRY_DELAYS = [0, 10, 50];
    var ModuleBinder = class {
      static {
        __name(this, "ModuleBinder");
      }
      // Mimics a Module namespace object (https://tc39.es/ecma262/#sec-module-namespace-objects).
      namespace = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
      set = {};
      get = {};
      #overridden = /* @__PURE__ */ Object.create(null);
      #pending = [];
      /**
       * Seeds `key` from `source` and installs its proxy accessors. A value that is
       * undefined or throws `ReferenceError` (temporal dead zone during a circular
       * import) is deferred to `flush`; any other throw propagates.
       *
       * @param {string} key The export name.
       * @param {object} source The real module namespace to read the value from.
       * @param {(value: unknown) => void} write Assigns the wrapper's local binding.
       * @param {() => unknown} read Reads the wrapper's local binding.
       * @param {boolean} useFallback Fall back to `source.default` (the synthetic
       * `module.exports` name a builtin does not expose on its ESM namespace).
       * @returns {void}
       */
      bind(key, source, write, read, useFallback) {
        const readSource = useFallback ? () => source[key] ?? source.default : () => source[key];
        this.#overridden[key] = false;
        let deferred = false;
        try {
          const value = readSource();
          write(value);
          this.namespace[key] = value;
        } catch (error) {
          if (!(error instanceof ReferenceError)) throw error;
          deferred = true;
        }
        if (deferred || read() === void 0) {
          this.#pending.push(this.#makeUpdater(key, readSource, write));
        }
        this.set[key] = (value) => {
          this.#overridden[key] = true;
          write(value);
          return true;
        };
        this.get[key] = read;
      }
      /**
       * @param {string} key The export name to update.
       * @param {() => unknown} readSource Reads the current value from the real module.
       * @param {(value: unknown) => void} write Assigns the wrapper's local binding.
       * @returns {() => boolean} Updater returning whether the value is now settled.
       */
      #makeUpdater(key, readSource, write) {
        return () => {
          if (this.#overridden[key] === true) return true;
          try {
            const value = readSource();
            if (value !== void 0) {
              write(value);
              this.namespace[key] = value;
              return true;
            }
            return false;
          } catch (error) {
            if (error instanceof ReferenceError) return false;
            throw error;
          }
        };
      }
      #flushOnce() {
        const next = [];
        for (const updater of this.#pending) {
          if (updater() !== true) next.push(updater);
        }
        this.#pending = next;
      }
      /**
       * Resolves exports deferred by `bind` (undefined or TDZ at wrapper-eval time).
       * Retries on a microtask, then at `RETRY_DELAYS`, giving up afterwards to avoid
       * unbounded retries. A no-op when nothing was deferred.
       *
       * @returns {void}
       */
      flush() {
        if (this.#pending.length === 0) return;
        queueMicrotask(() => {
          this.#flushOnce();
          this.#scheduleRetry(0);
        });
      }
      /**
       * @param {number} attempt Index into `RETRY_DELAYS` for the next retry.
       * @returns {void}
       */
      #scheduleRetry(attempt) {
        if (this.#pending.length === 0) return;
        if (attempt >= RETRY_DELAYS.length) {
          this.#pending = [];
          return;
        }
        const timer = setTimeout(() => {
          this.#flushOnce();
          this.#scheduleRetry(attempt + 1);
        }, RETRY_DELAYS[attempt]);
        if (timer && typeof timer.unref === "function") timer.unref();
      }
    };
    exports.register = register;
    exports.ModuleBinder = ModuleBinder;
    exports.importHooks = importHooks;
    exports.specifiers = specifiers;
    exports.toHook = toHook;
  }
});

// packages/core/node_modules/import-in-the-middle/index.js
var require_import_in_the_middle = __commonJS({
  "packages/core/node_modules/import-in-the-middle/index.js"(exports, module) {
    init_esbuild_shims();
    var path2 = __require("path");
    var moduleDetailsFromPath = require_module_details_from_path();
    var { fileURLToPath } = __require("url");
    var { MessageChannel } = __require("worker_threads");
    var { isBuiltin } = __require("module");
    if (!isBuiltin) {
      isBuiltin = /* @__PURE__ */ __name(() => true, "isBuiltin");
    }
    var {
      importHooks,
      specifiers,
      toHook
    } = require_register();
    function isTurbopackSpecifier(specifier, baseDir) {
      const usingTurbopack = process.env.TURBOPACK ?? process.argv.includes("--turbo");
      if (!usingTurbopack) return false;
      const specifierWithoutTurbopackHash = specifier.slice(0, specifier.lastIndexOf("-"));
      return baseDir.endsWith(specifierWithoutTurbopackHash);
    }
    __name(isTurbopackSpecifier, "isTurbopackSpecifier");
    function addHook(hook) {
      importHooks.push(hook);
      toHook.forEach(([name, namespace, specifier]) => hook(name, namespace, specifier));
    }
    __name(addHook, "addHook");
    function removeHook(hook) {
      const index = importHooks.indexOf(hook);
      if (index > -1) {
        importHooks.splice(index, 1);
      }
    }
    __name(removeHook, "removeHook");
    function callHookFn(hookFn, namespace, name, baseDir) {
      const newDefault = hookFn(namespace, name, baseDir);
      if (newDefault && newDefault !== namespace) {
        if ("default" in namespace) {
          namespace.default = newDefault;
        }
      }
    }
    __name(callHookFn, "callHookFn");
    var sendModulesToLoader;
    function createAddHookMessageChannel() {
      const { port1, port2 } = new MessageChannel();
      let pendingAckCount = 0;
      let resolveFn;
      sendModulesToLoader = /* @__PURE__ */ __name((modules) => {
        pendingAckCount++;
        port1.postMessage(modules);
      }, "sendModulesToLoader");
      port1.on("message", () => {
        pendingAckCount--;
        if (resolveFn && pendingAckCount <= 0) {
          resolveFn();
        }
      }).unref();
      function waitForAllMessagesAcknowledged() {
        const timer = setInterval(() => {
        }, 1e3);
        const promise = new Promise((resolve) => {
          resolveFn = resolve;
        }).then(() => {
          clearInterval(timer);
        });
        if (pendingAckCount === 0) {
          resolveFn();
        }
        return promise;
      }
      __name(waitForAllMessagesAcknowledged, "waitForAllMessagesAcknowledged");
      const addHookMessagePort = port2;
      const registerOptions = { data: { addHookMessagePort, include: [] }, transferList: [addHookMessagePort] };
      return { registerOptions, addHookMessagePort, waitForAllMessagesAcknowledged };
    }
    __name(createAddHookMessageChannel, "createAddHookMessageChannel");
    function Hook(modules, options, hookFn) {
      if (this instanceof Hook === false) return new Hook(modules, options, hookFn);
      if (typeof modules === "function") {
        hookFn = modules;
        modules = null;
        options = null;
      } else if (typeof options === "function") {
        hookFn = options;
        options = null;
      }
      const internals = options ? options.internals === true : false;
      if (sendModulesToLoader && Array.isArray(modules)) {
        sendModulesToLoader(modules);
      }
      this._iitmHook = (name, namespace, specifier) => {
        const loadUrl = name;
        const isNodeUrl = loadUrl.startsWith("node:");
        let filePath, baseDir;
        if (isNodeUrl) {
          const unprefixed = name.slice(5);
          if (isBuiltin(unprefixed)) {
            name = unprefixed;
          }
        } else if (loadUrl.startsWith("file://")) {
          const stackTraceLimit = Error.stackTraceLimit;
          Error.stackTraceLimit = 0;
          try {
            filePath = fileURLToPath(name);
            name = filePath;
          } catch (e) {
          }
          Error.stackTraceLimit = stackTraceLimit;
          if (filePath) {
            const details = moduleDetailsFromPath(filePath);
            if (details) {
              name = details.name;
              baseDir = details.basedir;
            }
          }
        }
        if (modules) {
          for (const matchArg of modules) {
            if (filePath && matchArg === filePath) {
              callHookFn(hookFn, namespace, filePath, void 0);
            } else if (matchArg === name) {
              if (!baseDir) {
                callHookFn(hookFn, namespace, name, baseDir);
              } else if (baseDir.endsWith(specifiers.get(loadUrl)) || isTurbopackSpecifier(specifiers.get(loadUrl), baseDir)) {
                callHookFn(hookFn, namespace, name, baseDir);
              } else if (internals) {
                const internalPath = name + path2.sep + path2.relative(baseDir, filePath);
                callHookFn(hookFn, namespace, internalPath, baseDir);
              }
            } else if (matchArg === specifier) {
              callHookFn(hookFn, namespace, specifier, baseDir);
            }
          }
        } else {
          callHookFn(hookFn, namespace, name, baseDir);
        }
      };
      addHook(this._iitmHook);
    }
    __name(Hook, "Hook");
    Hook.prototype.unhook = function() {
      removeHook(this._iitmHook);
    };
    module.exports = Hook;
    module.exports.Hook = Hook;
    module.exports.addHook = addHook;
    module.exports.removeHook = removeHook;
    module.exports.createAddHookMessageChannel = createAddHookMessageChannel;
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation/build/src/utils.js
var require_utils4 = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation/build/src/utils.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isWrapped = exports.safeExecuteInTheMiddleAsync = exports.safeExecuteInTheMiddle = void 0;
    function safeExecuteInTheMiddle(execute, onFinish, preventThrowingError) {
      let error;
      let result;
      try {
        result = execute();
      } catch (e) {
        error = e;
      } finally {
        onFinish(error, result);
        if (error && !preventThrowingError) {
          throw error;
        }
        return result;
      }
    }
    __name(safeExecuteInTheMiddle, "safeExecuteInTheMiddle");
    exports.safeExecuteInTheMiddle = safeExecuteInTheMiddle;
    async function safeExecuteInTheMiddleAsync(execute, onFinish, preventThrowingError) {
      let error;
      let result;
      try {
        result = await execute();
      } catch (e) {
        error = e;
      } finally {
        await onFinish(error, result);
        if (error && !preventThrowingError) {
          throw error;
        }
        return result;
      }
    }
    __name(safeExecuteInTheMiddleAsync, "safeExecuteInTheMiddleAsync");
    exports.safeExecuteInTheMiddleAsync = safeExecuteInTheMiddleAsync;
    function isWrapped(func) {
      return typeof func === "function" && typeof func.__original === "function" && typeof func.__unwrap === "function" && func.__wrapped === true;
    }
    __name(isWrapped, "isWrapped");
    exports.isWrapped = isWrapped;
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation/build/src/platform/node/instrumentation.js
var require_instrumentation2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation/build/src/platform/node/instrumentation.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.InstrumentationBase = void 0;
    var path2 = __require("path");
    var util_1 = __require("util");
    var semver_1 = require_semver();
    var shimmer_1 = require_shimmer();
    var instrumentation_1 = require_instrumentation();
    var RequireInTheMiddleSingleton_1 = require_RequireInTheMiddleSingleton();
    var import_in_the_middle_1 = require_import_in_the_middle();
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var require_in_the_middle_1 = require_require_in_the_middle();
    var fs_1 = __require("fs");
    var utils_1 = require_utils4();
    var InstrumentationBase = class extends instrumentation_1.InstrumentationAbstract {
      static {
        __name(this, "InstrumentationBase");
      }
      _modules;
      _hooks = [];
      _requireInTheMiddleSingleton = RequireInTheMiddleSingleton_1.RequireInTheMiddleSingleton.getInstance();
      _enabled = false;
      constructor(instrumentationName, instrumentationVersion, config) {
        super(instrumentationName, instrumentationVersion, config);
        let modules = this.init();
        if (modules && !Array.isArray(modules)) {
          modules = [modules];
        }
        this._modules = modules || [];
        if (this._config.enabled) {
          this.enable();
        }
      }
      _wrap = /* @__PURE__ */ __name((moduleExports, name, wrapper) => {
        if ((0, utils_1.isWrapped)(moduleExports[name])) {
          this._unwrap(moduleExports, name);
        }
        if (!util_1.types.isProxy(moduleExports)) {
          return (0, shimmer_1.wrap)(moduleExports, name, wrapper);
        } else {
          const wrapped = (0, shimmer_1.wrap)(Object.assign({}, moduleExports), name, wrapper);
          Object.defineProperty(moduleExports, name, {
            value: wrapped
          });
          return wrapped;
        }
      }, "_wrap");
      _unwrap = /* @__PURE__ */ __name((moduleExports, name) => {
        if (!util_1.types.isProxy(moduleExports)) {
          return (0, shimmer_1.unwrap)(moduleExports, name);
        } else {
          return Object.defineProperty(moduleExports, name, {
            value: moduleExports[name]
          });
        }
      }, "_unwrap");
      _massWrap = /* @__PURE__ */ __name((moduleExportsArray, names, wrapper) => {
        if (!moduleExportsArray) {
          api_1.diag.error("must provide one or more modules to patch");
          return;
        } else if (!Array.isArray(moduleExportsArray)) {
          moduleExportsArray = [moduleExportsArray];
        }
        if (!(names && Array.isArray(names))) {
          api_1.diag.error("must provide one or more functions to wrap on modules");
          return;
        }
        moduleExportsArray.forEach((moduleExports) => {
          names.forEach((name) => {
            this._wrap(moduleExports, name, wrapper);
          });
        });
      }, "_massWrap");
      _massUnwrap = /* @__PURE__ */ __name((moduleExportsArray, names) => {
        if (!moduleExportsArray) {
          api_1.diag.error("must provide one or more modules to patch");
          return;
        } else if (!Array.isArray(moduleExportsArray)) {
          moduleExportsArray = [moduleExportsArray];
        }
        if (!(names && Array.isArray(names))) {
          api_1.diag.error("must provide one or more functions to wrap on modules");
          return;
        }
        moduleExportsArray.forEach((moduleExports) => {
          names.forEach((name) => {
            this._unwrap(moduleExports, name);
          });
        });
      }, "_massUnwrap");
      _warnOnPreloadedModules() {
        const nodeRequire = globalThis.require;
        if (!nodeRequire?.resolve || !nodeRequire?.cache)
          return;
        this._modules.forEach((module2) => {
          const { name } = module2;
          try {
            const resolvedModule = nodeRequire.resolve(name);
            if (nodeRequire.cache[resolvedModule]?.loaded) {
              this._diag.warn(`Module ${name} has been loaded before ${this.instrumentationName} so it might not work, please initialize it before requiring ${name}`);
            }
          } catch {
          }
        });
      }
      _extractPackageVersion(baseDir) {
        try {
          const json = (0, fs_1.readFileSync)(path2.join(baseDir, "package.json"), {
            encoding: "utf8"
          });
          const version = JSON.parse(json).version;
          return typeof version === "string" ? version : void 0;
        } catch {
          api_1.diag.warn("Failed extracting version", baseDir);
        }
        return void 0;
      }
      _onRequire(module2, exports2, name, baseDir) {
        if (!baseDir) {
          if (typeof module2.patch === "function") {
            module2.moduleExports = exports2;
            if (this._enabled) {
              this._diag.debug("Applying instrumentation patch for nodejs core module on require hook", {
                module: module2.name
              });
              return module2.patch(exports2);
            }
          }
          return exports2;
        }
        const version = this._extractPackageVersion(baseDir);
        module2.moduleVersion = version;
        if (module2.name === name) {
          if (isSupported(module2.supportedVersions, version, module2.includePrerelease)) {
            if (typeof module2.patch === "function") {
              module2.moduleExports = exports2;
              if (this._enabled) {
                this._diag.debug("Applying instrumentation patch for module on require hook", {
                  module: module2.name,
                  version: module2.moduleVersion,
                  baseDir
                });
                return module2.patch(exports2, module2.moduleVersion);
              }
            }
          }
          return exports2;
        }
        const files = module2.files ?? [];
        const normalizedName = path2.normalize(name);
        const supportedFileInstrumentations = files.filter((f) => f.name === normalizedName && isSupported(f.supportedVersions, version, module2.includePrerelease));
        return supportedFileInstrumentations.reduce((patchedExports, file) => {
          file.moduleExports = patchedExports;
          if (this._enabled) {
            this._diag.debug("Applying instrumentation patch for nodejs module file on require hook", {
              module: module2.name,
              version: module2.moduleVersion,
              fileName: file.name,
              baseDir
            });
            return file.patch(patchedExports, module2.moduleVersion);
          }
          return patchedExports;
        }, exports2);
      }
      enable() {
        if (this._enabled) {
          return;
        }
        this._enabled = true;
        if (this._hooks.length > 0) {
          for (const module2 of this._modules) {
            if (typeof module2.patch === "function" && module2.moduleExports) {
              this._diag.debug("Applying instrumentation patch for nodejs module on instrumentation enabled", {
                module: module2.name,
                version: module2.moduleVersion
              });
              module2.patch(module2.moduleExports, module2.moduleVersion);
            }
            for (const file of module2.files) {
              if (file.moduleExports) {
                this._diag.debug("Applying instrumentation patch for nodejs module file on instrumentation enabled", {
                  module: module2.name,
                  version: module2.moduleVersion,
                  fileName: file.name
                });
                file.patch(file.moduleExports, module2.moduleVersion);
              }
            }
          }
          return;
        }
        this._warnOnPreloadedModules();
        for (const module2 of this._modules) {
          const hookFn = /* @__PURE__ */ __name((exports2, name, baseDir) => {
            if (!baseDir && path2.isAbsolute(name)) {
              const parsedPath = path2.parse(name);
              name = parsedPath.name;
              baseDir = parsedPath.dir;
            }
            return this._onRequire(module2, exports2, name, baseDir);
          }, "hookFn");
          const onRequire = /* @__PURE__ */ __name((exports2, name, baseDir) => {
            return this._onRequire(module2, exports2, name, baseDir);
          }, "onRequire");
          const hook = path2.isAbsolute(module2.name) ? new require_in_the_middle_1.Hook([module2.name], { internals: true }, onRequire) : this._requireInTheMiddleSingleton.register(module2.name, onRequire);
          this._hooks.push(hook);
          const esmHook = new import_in_the_middle_1.Hook([module2.name], { internals: true }, hookFn);
          this._hooks.push(esmHook);
        }
      }
      disable() {
        if (!this._enabled) {
          return;
        }
        this._enabled = false;
        for (const module2 of this._modules) {
          if (typeof module2.unpatch === "function" && module2.moduleExports) {
            this._diag.debug("Removing instrumentation patch for nodejs module on instrumentation disabled", {
              module: module2.name,
              version: module2.moduleVersion
            });
            module2.unpatch(module2.moduleExports, module2.moduleVersion);
          }
          for (const file of module2.files) {
            if (file.moduleExports) {
              this._diag.debug("Removing instrumentation patch for nodejs module file on instrumentation disabled", {
                module: module2.name,
                version: module2.moduleVersion,
                fileName: file.name
              });
              file.unpatch(file.moduleExports, module2.moduleVersion);
            }
          }
        }
      }
      isEnabled() {
        return this._enabled;
      }
    };
    exports.InstrumentationBase = InstrumentationBase;
    function isSupported(supportedVersions, version, includePrerelease) {
      if (typeof version === "undefined") {
        return supportedVersions.includes("*");
      }
      return supportedVersions.some((supportedVersion) => {
        return (0, semver_1.satisfies)(version, supportedVersion, { includePrerelease });
      });
    }
    __name(isSupported, "isSupported");
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation/build/src/platform/node/normalize.js
var require_normalize = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation/build/src/platform/node/normalize.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.normalize = void 0;
    var path_1 = __require("path");
    Object.defineProperty(exports, "normalize", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return path_1.normalize;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation/build/src/platform/node/index.js
var require_node4 = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation/build/src/platform/node/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.normalize = exports.InstrumentationBase = void 0;
    var instrumentation_1 = require_instrumentation2();
    Object.defineProperty(exports, "InstrumentationBase", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return instrumentation_1.InstrumentationBase;
    }, "get") });
    var normalize_1 = require_normalize();
    Object.defineProperty(exports, "normalize", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return normalize_1.normalize;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation/build/src/platform/index.js
var require_platform4 = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation/build/src/platform/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.normalize = exports.InstrumentationBase = void 0;
    var node_1 = require_node4();
    Object.defineProperty(exports, "InstrumentationBase", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.InstrumentationBase;
    }, "get") });
    Object.defineProperty(exports, "normalize", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.normalize;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation/build/src/instrumentationNodeModuleDefinition.js
var require_instrumentationNodeModuleDefinition = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation/build/src/instrumentationNodeModuleDefinition.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.InstrumentationNodeModuleDefinition = void 0;
    var InstrumentationNodeModuleDefinition = class {
      static {
        __name(this, "InstrumentationNodeModuleDefinition");
      }
      files;
      name;
      supportedVersions;
      patch;
      unpatch;
      constructor(name, supportedVersions, patch, unpatch, files) {
        this.files = files || [];
        this.name = name;
        this.supportedVersions = supportedVersions;
        this.patch = patch;
        this.unpatch = unpatch;
      }
    };
    exports.InstrumentationNodeModuleDefinition = InstrumentationNodeModuleDefinition;
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation/build/src/instrumentationNodeModuleFile.js
var require_instrumentationNodeModuleFile = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation/build/src/instrumentationNodeModuleFile.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.InstrumentationNodeModuleFile = void 0;
    var index_1 = require_platform4();
    var InstrumentationNodeModuleFile = class {
      static {
        __name(this, "InstrumentationNodeModuleFile");
      }
      name;
      supportedVersions;
      patch;
      unpatch;
      constructor(name, supportedVersions, patch, unpatch) {
        this.name = (0, index_1.normalize)(name);
        this.supportedVersions = supportedVersions;
        this.patch = patch;
        this.unpatch = unpatch;
      }
    };
    exports.InstrumentationNodeModuleFile = InstrumentationNodeModuleFile;
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation/build/src/semconvStability.js
var require_semconvStability = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation/build/src/semconvStability.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.semconvStabilityFromStr = exports.SemconvStability = void 0;
    var SemconvStability;
    (function(SemconvStability2) {
      SemconvStability2[SemconvStability2["STABLE"] = 1] = "STABLE";
      SemconvStability2[SemconvStability2["OLD"] = 2] = "OLD";
      SemconvStability2[SemconvStability2["DUPLICATE"] = 3] = "DUPLICATE";
    })(SemconvStability || (exports.SemconvStability = SemconvStability = {}));
    function semconvStabilityFromStr(namespace, str) {
      let semconvStability = SemconvStability.OLD;
      const entries = str?.split(",").map((v) => v.trim()).filter((s) => s !== "");
      for (const entry of entries ?? []) {
        if (entry.toLowerCase() === namespace + "/dup") {
          semconvStability = SemconvStability.DUPLICATE;
          break;
        } else if (entry.toLowerCase() === namespace) {
          semconvStability = SemconvStability.STABLE;
        }
      }
      return semconvStability;
    }
    __name(semconvStabilityFromStr, "semconvStabilityFromStr");
    exports.semconvStabilityFromStr = semconvStabilityFromStr;
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation/build/src/index.js
var require_src11 = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation/build/src/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.semconvStabilityFromStr = exports.SemconvStability = exports.safeExecuteInTheMiddleAsync = exports.safeExecuteInTheMiddle = exports.isWrapped = exports.InstrumentationNodeModuleFile = exports.InstrumentationNodeModuleDefinition = exports.InstrumentationBase = exports.registerInstrumentations = void 0;
    var autoLoader_1 = require_autoLoader();
    Object.defineProperty(exports, "registerInstrumentations", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return autoLoader_1.registerInstrumentations;
    }, "get") });
    var index_1 = require_platform4();
    Object.defineProperty(exports, "InstrumentationBase", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return index_1.InstrumentationBase;
    }, "get") });
    var instrumentationNodeModuleDefinition_1 = require_instrumentationNodeModuleDefinition();
    Object.defineProperty(exports, "InstrumentationNodeModuleDefinition", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return instrumentationNodeModuleDefinition_1.InstrumentationNodeModuleDefinition;
    }, "get") });
    var instrumentationNodeModuleFile_1 = require_instrumentationNodeModuleFile();
    Object.defineProperty(exports, "InstrumentationNodeModuleFile", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return instrumentationNodeModuleFile_1.InstrumentationNodeModuleFile;
    }, "get") });
    var utils_1 = require_utils4();
    Object.defineProperty(exports, "isWrapped", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return utils_1.isWrapped;
    }, "get") });
    Object.defineProperty(exports, "safeExecuteInTheMiddle", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return utils_1.safeExecuteInTheMiddle;
    }, "get") });
    Object.defineProperty(exports, "safeExecuteInTheMiddleAsync", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return utils_1.safeExecuteInTheMiddleAsync;
    }, "get") });
    var semconvStability_1 = require_semconvStability();
    Object.defineProperty(exports, "SemconvStability", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return semconvStability_1.SemconvStability;
    }, "get") });
    Object.defineProperty(exports, "semconvStabilityFromStr", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return semconvStability_1.semconvStabilityFromStr;
    }, "get") });
  }
});

// sdk-node-exporter-stub:@opentelemetry/exporter-logs-otlp-http
var require_exporter_logs_otlp_http = __commonJS({
  "sdk-node-exporter-stub:@opentelemetry/exporter-logs-otlp-http"(exports, module) {
    init_esbuild_shims();
    var throwStubbed = /* @__PURE__ */ __name((name) => {
      throw new Error(
        "qwen-code bundles @opentelemetry/sdk-node without @opentelemetry/exporter-logs-otlp-http (env-based exporter selection is unsupported; configure telemetry via qwen-code settings instead). Attempted to construct: " + name
      );
    }, "throwStubbed");
    var handler = {
      // Module interop and thenable probes must see a plain, non-callable
      // namespace: a bundler or await import() reads then and __esModule
      // (Symbol.* keys are already covered by the typeof check), and
      // constructing those as "exporters" would throw a confusing error.
      get: /* @__PURE__ */ __name((_t, prop) => {
        if (typeof prop !== "string" || prop === "then" || prop === "__esModule") {
          return void 0;
        }
        return /* @__PURE__ */ __name(function stubbedExporter() {
          throwStubbed(prop);
        }, "stubbedExporter");
      }, "get")
    };
    module.exports = new Proxy({}, handler);
  }
});

// sdk-node-exporter-stub:@opentelemetry/exporter-logs-otlp-grpc
var require_exporter_logs_otlp_grpc = __commonJS({
  "sdk-node-exporter-stub:@opentelemetry/exporter-logs-otlp-grpc"(exports, module) {
    init_esbuild_shims();
    var throwStubbed = /* @__PURE__ */ __name((name) => {
      throw new Error(
        "qwen-code bundles @opentelemetry/sdk-node without @opentelemetry/exporter-logs-otlp-grpc (env-based exporter selection is unsupported; configure telemetry via qwen-code settings instead). Attempted to construct: " + name
      );
    }, "throwStubbed");
    var handler = {
      // Module interop and thenable probes must see a plain, non-callable
      // namespace: a bundler or await import() reads then and __esModule
      // (Symbol.* keys are already covered by the typeof check), and
      // constructing those as "exporters" would throw a confusing error.
      get: /* @__PURE__ */ __name((_t, prop) => {
        if (typeof prop !== "string" || prop === "then" || prop === "__esModule") {
          return void 0;
        }
        return /* @__PURE__ */ __name(function stubbedExporter() {
          throwStubbed(prop);
        }, "stubbedExporter");
      }, "get")
    };
    module.exports = new Proxy({}, handler);
  }
});

// sdk-node-exporter-stub:@opentelemetry/exporter-logs-otlp-proto
var require_exporter_logs_otlp_proto = __commonJS({
  "sdk-node-exporter-stub:@opentelemetry/exporter-logs-otlp-proto"(exports, module) {
    init_esbuild_shims();
    var throwStubbed = /* @__PURE__ */ __name((name) => {
      throw new Error(
        "qwen-code bundles @opentelemetry/sdk-node without @opentelemetry/exporter-logs-otlp-proto (env-based exporter selection is unsupported; configure telemetry via qwen-code settings instead). Attempted to construct: " + name
      );
    }, "throwStubbed");
    var handler = {
      // Module interop and thenable probes must see a plain, non-callable
      // namespace: a bundler or await import() reads then and __esModule
      // (Symbol.* keys are already covered by the typeof check), and
      // constructing those as "exporters" would throw a confusing error.
      get: /* @__PURE__ */ __name((_t, prop) => {
        if (typeof prop !== "string" || prop === "then" || prop === "__esModule") {
          return void 0;
        }
        return /* @__PURE__ */ __name(function stubbedExporter() {
          throwStubbed(prop);
        }, "stubbedExporter");
      }, "get")
    };
    module.exports = new Proxy({}, handler);
  }
});

// sdk-node-exporter-stub:@opentelemetry/exporter-prometheus
var require_exporter_prometheus = __commonJS({
  "sdk-node-exporter-stub:@opentelemetry/exporter-prometheus"(exports, module) {
    init_esbuild_shims();
    var throwStubbed = /* @__PURE__ */ __name((name) => {
      throw new Error(
        "qwen-code bundles @opentelemetry/sdk-node without @opentelemetry/exporter-prometheus (env-based exporter selection is unsupported; configure telemetry via qwen-code settings instead). Attempted to construct: " + name
      );
    }, "throwStubbed");
    var handler = {
      // Module interop and thenable probes must see a plain, non-callable
      // namespace: a bundler or await import() reads then and __esModule
      // (Symbol.* keys are already covered by the typeof check), and
      // constructing those as "exporters" would throw a confusing error.
      get: /* @__PURE__ */ __name((_t, prop) => {
        if (typeof prop !== "string" || prop === "then" || prop === "__esModule") {
          return void 0;
        }
        return /* @__PURE__ */ __name(function stubbedExporter() {
          throwStubbed(prop);
        }, "stubbedExporter");
      }, "get")
    };
    module.exports = new Proxy({}, handler);
  }
});

// sdk-node-exporter-stub:@opentelemetry/exporter-trace-otlp-proto
var require_exporter_trace_otlp_proto = __commonJS({
  "sdk-node-exporter-stub:@opentelemetry/exporter-trace-otlp-proto"(exports, module) {
    init_esbuild_shims();
    var throwStubbed = /* @__PURE__ */ __name((name) => {
      throw new Error(
        "qwen-code bundles @opentelemetry/sdk-node without @opentelemetry/exporter-trace-otlp-proto (env-based exporter selection is unsupported; configure telemetry via qwen-code settings instead). Attempted to construct: " + name
      );
    }, "throwStubbed");
    var handler = {
      // Module interop and thenable probes must see a plain, non-callable
      // namespace: a bundler or await import() reads then and __esModule
      // (Symbol.* keys are already covered by the typeof check), and
      // constructing those as "exporters" would throw a confusing error.
      get: /* @__PURE__ */ __name((_t, prop) => {
        if (typeof prop !== "string" || prop === "then" || prop === "__esModule") {
          return void 0;
        }
        return /* @__PURE__ */ __name(function stubbedExporter() {
          throwStubbed(prop);
        }, "stubbedExporter");
      }, "get")
    };
    module.exports = new Proxy({}, handler);
  }
});

// sdk-node-exporter-stub:@opentelemetry/exporter-trace-otlp-http
var require_exporter_trace_otlp_http = __commonJS({
  "sdk-node-exporter-stub:@opentelemetry/exporter-trace-otlp-http"(exports, module) {
    init_esbuild_shims();
    var throwStubbed = /* @__PURE__ */ __name((name) => {
      throw new Error(
        "qwen-code bundles @opentelemetry/sdk-node without @opentelemetry/exporter-trace-otlp-http (env-based exporter selection is unsupported; configure telemetry via qwen-code settings instead). Attempted to construct: " + name
      );
    }, "throwStubbed");
    var handler = {
      // Module interop and thenable probes must see a plain, non-callable
      // namespace: a bundler or await import() reads then and __esModule
      // (Symbol.* keys are already covered by the typeof check), and
      // constructing those as "exporters" would throw a confusing error.
      get: /* @__PURE__ */ __name((_t, prop) => {
        if (typeof prop !== "string" || prop === "then" || prop === "__esModule") {
          return void 0;
        }
        return /* @__PURE__ */ __name(function stubbedExporter() {
          throwStubbed(prop);
        }, "stubbedExporter");
      }, "get")
    };
    module.exports = new Proxy({}, handler);
  }
});

// sdk-node-exporter-stub:@opentelemetry/exporter-trace-otlp-grpc
var require_exporter_trace_otlp_grpc = __commonJS({
  "sdk-node-exporter-stub:@opentelemetry/exporter-trace-otlp-grpc"(exports, module) {
    init_esbuild_shims();
    var throwStubbed = /* @__PURE__ */ __name((name) => {
      throw new Error(
        "qwen-code bundles @opentelemetry/sdk-node without @opentelemetry/exporter-trace-otlp-grpc (env-based exporter selection is unsupported; configure telemetry via qwen-code settings instead). Attempted to construct: " + name
      );
    }, "throwStubbed");
    var handler = {
      // Module interop and thenable probes must see a plain, non-callable
      // namespace: a bundler or await import() reads then and __esModule
      // (Symbol.* keys are already covered by the typeof check), and
      // constructing those as "exporters" would throw a confusing error.
      get: /* @__PURE__ */ __name((_t, prop) => {
        if (typeof prop !== "string" || prop === "then" || prop === "__esModule") {
          return void 0;
        }
        return /* @__PURE__ */ __name(function stubbedExporter() {
          throwStubbed(prop);
        }, "stubbedExporter");
      }, "get")
    };
    module.exports = new Proxy({}, handler);
  }
});

// sdk-node-exporter-stub:@opentelemetry/exporter-zipkin
var require_exporter_zipkin = __commonJS({
  "sdk-node-exporter-stub:@opentelemetry/exporter-zipkin"(exports, module) {
    init_esbuild_shims();
    var throwStubbed = /* @__PURE__ */ __name((name) => {
      throw new Error(
        "qwen-code bundles @opentelemetry/sdk-node without @opentelemetry/exporter-zipkin (env-based exporter selection is unsupported; configure telemetry via qwen-code settings instead). Attempted to construct: " + name
      );
    }, "throwStubbed");
    var handler = {
      // Module interop and thenable probes must see a plain, non-callable
      // namespace: a bundler or await import() reads then and __esModule
      // (Symbol.* keys are already covered by the typeof check), and
      // constructing those as "exporters" would throw a confusing error.
      get: /* @__PURE__ */ __name((_t, prop) => {
        if (typeof prop !== "string" || prop === "then" || prop === "__esModule") {
          return void 0;
        }
        return /* @__PURE__ */ __name(function stubbedExporter() {
          throwStubbed(prop);
        }, "stubbedExporter");
      }, "get")
    };
    module.exports = new Proxy({}, handler);
  }
});

// packages/core/node_modules/@opentelemetry/propagator-b3/build/src/common.js
var require_common = __commonJS({
  "packages/core/node_modules/@opentelemetry/propagator-b3/build/src/common.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.B3_DEBUG_FLAG_KEY = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    exports.B3_DEBUG_FLAG_KEY = (0, api_1.createContextKey)("OpenTelemetry Context Key B3 Debug Flag");
  }
});

// packages/core/node_modules/@opentelemetry/propagator-b3/build/src/constants.js
var require_constants = __commonJS({
  "packages/core/node_modules/@opentelemetry/propagator-b3/build/src/constants.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.X_B3_FLAGS = exports.X_B3_PARENT_SPAN_ID = exports.X_B3_SAMPLED = exports.X_B3_SPAN_ID = exports.X_B3_TRACE_ID = exports.B3_CONTEXT_HEADER = void 0;
    exports.B3_CONTEXT_HEADER = "b3";
    exports.X_B3_TRACE_ID = "x-b3-traceid";
    exports.X_B3_SPAN_ID = "x-b3-spanid";
    exports.X_B3_SAMPLED = "x-b3-sampled";
    exports.X_B3_PARENT_SPAN_ID = "x-b3-parentspanid";
    exports.X_B3_FLAGS = "x-b3-flags";
  }
});

// packages/core/node_modules/@opentelemetry/propagator-b3/build/src/B3MultiPropagator.js
var require_B3MultiPropagator = __commonJS({
  "packages/core/node_modules/@opentelemetry/propagator-b3/build/src/B3MultiPropagator.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.B3MultiPropagator = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src3();
    var common_1 = require_common();
    var constants_1 = require_constants();
    var VALID_SAMPLED_VALUES = /* @__PURE__ */ new Set([true, "true", "True", "1", 1]);
    var VALID_UNSAMPLED_VALUES = /* @__PURE__ */ new Set([false, "false", "False", "0", 0]);
    function isValidSampledValue(sampled) {
      return sampled === api_1.TraceFlags.SAMPLED || sampled === api_1.TraceFlags.NONE;
    }
    __name(isValidSampledValue, "isValidSampledValue");
    function parseHeader(header) {
      return Array.isArray(header) ? header[0] : header;
    }
    __name(parseHeader, "parseHeader");
    function getHeaderValue(carrier, getter, key) {
      const header = getter.get(carrier, key);
      return parseHeader(header);
    }
    __name(getHeaderValue, "getHeaderValue");
    function getTraceId(carrier, getter) {
      const traceId = getHeaderValue(carrier, getter, constants_1.X_B3_TRACE_ID);
      if (typeof traceId === "string") {
        return traceId.padStart(32, "0");
      }
      return "";
    }
    __name(getTraceId, "getTraceId");
    function getSpanId(carrier, getter) {
      const spanId = getHeaderValue(carrier, getter, constants_1.X_B3_SPAN_ID);
      if (typeof spanId === "string") {
        return spanId;
      }
      return "";
    }
    __name(getSpanId, "getSpanId");
    function getDebug(carrier, getter) {
      const debug = getHeaderValue(carrier, getter, constants_1.X_B3_FLAGS);
      return debug === "1" ? "1" : void 0;
    }
    __name(getDebug, "getDebug");
    function getTraceFlags(carrier, getter) {
      const traceFlags = getHeaderValue(carrier, getter, constants_1.X_B3_SAMPLED);
      const debug = getDebug(carrier, getter);
      if (debug === "1" || VALID_SAMPLED_VALUES.has(traceFlags)) {
        return api_1.TraceFlags.SAMPLED;
      }
      if (traceFlags === void 0 || VALID_UNSAMPLED_VALUES.has(traceFlags)) {
        return api_1.TraceFlags.NONE;
      }
      return;
    }
    __name(getTraceFlags, "getTraceFlags");
    var B3MultiPropagator = class {
      static {
        __name(this, "B3MultiPropagator");
      }
      inject(context, carrier, setter) {
        const spanContext = api_1.trace.getSpanContext(context);
        if (!spanContext || !(0, api_1.isSpanContextValid)(spanContext) || (0, core_1.isTracingSuppressed)(context))
          return;
        const debug = context.getValue(common_1.B3_DEBUG_FLAG_KEY);
        setter.set(carrier, constants_1.X_B3_TRACE_ID, spanContext.traceId);
        setter.set(carrier, constants_1.X_B3_SPAN_ID, spanContext.spanId);
        if (debug === "1") {
          setter.set(carrier, constants_1.X_B3_FLAGS, debug);
        } else if (spanContext.traceFlags !== void 0) {
          setter.set(carrier, constants_1.X_B3_SAMPLED, (api_1.TraceFlags.SAMPLED & spanContext.traceFlags) === api_1.TraceFlags.SAMPLED ? "1" : "0");
        }
      }
      extract(context, carrier, getter) {
        const traceId = getTraceId(carrier, getter);
        const spanId = getSpanId(carrier, getter);
        const traceFlags = getTraceFlags(carrier, getter);
        const debug = getDebug(carrier, getter);
        if ((0, api_1.isValidTraceId)(traceId) && (0, api_1.isValidSpanId)(spanId) && isValidSampledValue(traceFlags)) {
          context = context.setValue(common_1.B3_DEBUG_FLAG_KEY, debug);
          return api_1.trace.setSpanContext(context, {
            traceId,
            spanId,
            isRemote: true,
            traceFlags
          });
        }
        return context;
      }
      fields() {
        return [
          constants_1.X_B3_TRACE_ID,
          constants_1.X_B3_SPAN_ID,
          constants_1.X_B3_FLAGS,
          constants_1.X_B3_SAMPLED,
          constants_1.X_B3_PARENT_SPAN_ID
        ];
      }
    };
    exports.B3MultiPropagator = B3MultiPropagator;
  }
});

// packages/core/node_modules/@opentelemetry/propagator-b3/build/src/B3SinglePropagator.js
var require_B3SinglePropagator = __commonJS({
  "packages/core/node_modules/@opentelemetry/propagator-b3/build/src/B3SinglePropagator.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.B3SinglePropagator = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src3();
    var common_1 = require_common();
    var constants_1 = require_constants();
    var B3_CONTEXT_REGEX = /((?:[0-9a-f]{16}){1,2})-([0-9a-f]{16})(?:-([01d](?![0-9a-f])))?(?:-([0-9a-f]{16}))?/;
    var PADDING = "0".repeat(16);
    var SAMPLED_VALUES = /* @__PURE__ */ new Set(["d", "1"]);
    var DEBUG_STATE = "d";
    function convertToTraceId128(traceId) {
      return traceId.length === 32 ? traceId : `${PADDING}${traceId}`;
    }
    __name(convertToTraceId128, "convertToTraceId128");
    function convertToTraceFlags(samplingState) {
      if (samplingState && SAMPLED_VALUES.has(samplingState)) {
        return api_1.TraceFlags.SAMPLED;
      }
      return api_1.TraceFlags.NONE;
    }
    __name(convertToTraceFlags, "convertToTraceFlags");
    var B3SinglePropagator = class {
      static {
        __name(this, "B3SinglePropagator");
      }
      inject(context, carrier, setter) {
        const spanContext = api_1.trace.getSpanContext(context);
        if (!spanContext || !(0, api_1.isSpanContextValid)(spanContext) || (0, core_1.isTracingSuppressed)(context))
          return;
        const samplingState = context.getValue(common_1.B3_DEBUG_FLAG_KEY) || spanContext.traceFlags & 1;
        const value = `${spanContext.traceId}-${spanContext.spanId}-${samplingState}`;
        setter.set(carrier, constants_1.B3_CONTEXT_HEADER, value);
      }
      extract(context, carrier, getter) {
        const header = getter.get(carrier, constants_1.B3_CONTEXT_HEADER);
        const b3Context = Array.isArray(header) ? header[0] : header;
        if (typeof b3Context !== "string")
          return context;
        const match = b3Context.match(B3_CONTEXT_REGEX);
        if (!match)
          return context;
        const [, extractedTraceId, spanId, samplingState] = match;
        const traceId = convertToTraceId128(extractedTraceId);
        if (!(0, api_1.isValidTraceId)(traceId) || !(0, api_1.isValidSpanId)(spanId))
          return context;
        const traceFlags = convertToTraceFlags(samplingState);
        if (samplingState === DEBUG_STATE) {
          context = context.setValue(common_1.B3_DEBUG_FLAG_KEY, samplingState);
        }
        return api_1.trace.setSpanContext(context, {
          traceId,
          spanId,
          isRemote: true,
          traceFlags
        });
      }
      fields() {
        return [constants_1.B3_CONTEXT_HEADER];
      }
    };
    exports.B3SinglePropagator = B3SinglePropagator;
  }
});

// packages/core/node_modules/@opentelemetry/propagator-b3/build/src/types.js
var require_types = __commonJS({
  "packages/core/node_modules/@opentelemetry/propagator-b3/build/src/types.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.B3InjectEncoding = void 0;
    var B3InjectEncoding;
    (function(B3InjectEncoding2) {
      B3InjectEncoding2[B3InjectEncoding2["SINGLE_HEADER"] = 0] = "SINGLE_HEADER";
      B3InjectEncoding2[B3InjectEncoding2["MULTI_HEADER"] = 1] = "MULTI_HEADER";
    })(B3InjectEncoding || (exports.B3InjectEncoding = B3InjectEncoding = {}));
  }
});

// packages/core/node_modules/@opentelemetry/propagator-b3/build/src/B3Propagator.js
var require_B3Propagator = __commonJS({
  "packages/core/node_modules/@opentelemetry/propagator-b3/build/src/B3Propagator.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.B3Propagator = void 0;
    var core_1 = require_src3();
    var B3MultiPropagator_1 = require_B3MultiPropagator();
    var B3SinglePropagator_1 = require_B3SinglePropagator();
    var constants_1 = require_constants();
    var types_1 = require_types();
    var B3Propagator = class {
      static {
        __name(this, "B3Propagator");
      }
      _b3MultiPropagator = new B3MultiPropagator_1.B3MultiPropagator();
      _b3SinglePropagator = new B3SinglePropagator_1.B3SinglePropagator();
      _inject;
      _fields;
      constructor(config = {}) {
        if (config.injectEncoding === types_1.B3InjectEncoding.MULTI_HEADER) {
          this._inject = this._b3MultiPropagator.inject;
          this._fields = this._b3MultiPropagator.fields();
        } else {
          this._inject = this._b3SinglePropagator.inject;
          this._fields = this._b3SinglePropagator.fields();
        }
      }
      inject(context, carrier, setter) {
        if ((0, core_1.isTracingSuppressed)(context)) {
          return;
        }
        this._inject(context, carrier, setter);
      }
      extract(context, carrier, getter) {
        const header = getter.get(carrier, constants_1.B3_CONTEXT_HEADER);
        const b3Context = Array.isArray(header) ? header[0] : header;
        if (b3Context) {
          return this._b3SinglePropagator.extract(context, carrier, getter);
        } else {
          return this._b3MultiPropagator.extract(context, carrier, getter);
        }
      }
      fields() {
        return this._fields;
      }
    };
    exports.B3Propagator = B3Propagator;
  }
});

// packages/core/node_modules/@opentelemetry/propagator-b3/build/src/index.js
var require_src12 = __commonJS({
  "packages/core/node_modules/@opentelemetry/propagator-b3/build/src/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.B3InjectEncoding = exports.X_B3_TRACE_ID = exports.X_B3_SPAN_ID = exports.X_B3_SAMPLED = exports.X_B3_PARENT_SPAN_ID = exports.X_B3_FLAGS = exports.B3_CONTEXT_HEADER = exports.B3Propagator = void 0;
    var B3Propagator_1 = require_B3Propagator();
    Object.defineProperty(exports, "B3Propagator", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return B3Propagator_1.B3Propagator;
    }, "get") });
    var constants_1 = require_constants();
    Object.defineProperty(exports, "B3_CONTEXT_HEADER", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return constants_1.B3_CONTEXT_HEADER;
    }, "get") });
    Object.defineProperty(exports, "X_B3_FLAGS", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return constants_1.X_B3_FLAGS;
    }, "get") });
    Object.defineProperty(exports, "X_B3_PARENT_SPAN_ID", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return constants_1.X_B3_PARENT_SPAN_ID;
    }, "get") });
    Object.defineProperty(exports, "X_B3_SAMPLED", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return constants_1.X_B3_SAMPLED;
    }, "get") });
    Object.defineProperty(exports, "X_B3_SPAN_ID", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return constants_1.X_B3_SPAN_ID;
    }, "get") });
    Object.defineProperty(exports, "X_B3_TRACE_ID", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return constants_1.X_B3_TRACE_ID;
    }, "get") });
    var types_1 = require_types();
    Object.defineProperty(exports, "B3InjectEncoding", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return types_1.B3InjectEncoding;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/propagator-jaeger/build/src/JaegerPropagator.js
var require_JaegerPropagator = __commonJS({
  "packages/core/node_modules/@opentelemetry/propagator-jaeger/build/src/JaegerPropagator.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.JaegerPropagator = exports.UBER_BAGGAGE_HEADER_PREFIX = exports.UBER_TRACE_ID_HEADER = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src3();
    exports.UBER_TRACE_ID_HEADER = "uber-trace-id";
    exports.UBER_BAGGAGE_HEADER_PREFIX = "uberctx";
    var JaegerPropagator = class {
      static {
        __name(this, "JaegerPropagator");
      }
      _jaegerTraceHeader;
      _jaegerBaggageHeaderPrefix;
      constructor(config) {
        if (typeof config === "string") {
          this._jaegerTraceHeader = config;
          this._jaegerBaggageHeaderPrefix = exports.UBER_BAGGAGE_HEADER_PREFIX;
        } else {
          this._jaegerTraceHeader = config?.customTraceHeader || exports.UBER_TRACE_ID_HEADER;
          this._jaegerBaggageHeaderPrefix = config?.customBaggageHeaderPrefix || exports.UBER_BAGGAGE_HEADER_PREFIX;
        }
      }
      inject(context, carrier, setter) {
        const spanContext = api_1.trace.getSpanContext(context);
        const baggage = api_1.propagation.getBaggage(context);
        if (spanContext && (0, core_1.isTracingSuppressed)(context) === false) {
          const traceFlags = `0${(spanContext.traceFlags || api_1.TraceFlags.NONE).toString(16)}`;
          setter.set(carrier, this._jaegerTraceHeader, `${spanContext.traceId}:${spanContext.spanId}:0:${traceFlags}`);
        }
        if (baggage) {
          for (const [key, entry] of baggage.getAllEntries()) {
            setter.set(carrier, `${this._jaegerBaggageHeaderPrefix}-${key}`, encodeURIComponent(entry.value));
          }
        }
      }
      extract(context, carrier, getter) {
        const uberTraceIdHeader = getter.get(carrier, this._jaegerTraceHeader);
        const uberTraceId = Array.isArray(uberTraceIdHeader) ? uberTraceIdHeader[0] : uberTraceIdHeader;
        const baggageValues = getter.keys(carrier).filter((key) => key.startsWith(`${this._jaegerBaggageHeaderPrefix}-`)).map((key) => {
          const value = getter.get(carrier, key);
          return {
            key: key.substring(this._jaegerBaggageHeaderPrefix.length + 1),
            value: Array.isArray(value) ? value[0] : value
          };
        });
        let newContext = context;
        if (typeof uberTraceId === "string") {
          const spanContext = deserializeSpanContext(uberTraceId);
          if (spanContext) {
            newContext = api_1.trace.setSpanContext(newContext, spanContext);
          }
        }
        if (baggageValues.length === 0)
          return newContext;
        let currentBaggage = api_1.propagation.getBaggage(context) ?? api_1.propagation.createBaggage();
        for (const baggageEntry of baggageValues) {
          if (baggageEntry.value === void 0)
            continue;
          let decodedValue;
          try {
            decodedValue = decodeURIComponent(baggageEntry.value);
          } catch {
            continue;
          }
          currentBaggage = currentBaggage.setEntry(baggageEntry.key, {
            value: decodedValue
          });
        }
        newContext = api_1.propagation.setBaggage(newContext, currentBaggage);
        return newContext;
      }
      fields() {
        return [this._jaegerTraceHeader];
      }
    };
    exports.JaegerPropagator = JaegerPropagator;
    var VALID_HEX_RE = /^[0-9a-f]{1,2}$/i;
    function deserializeSpanContext(serializedString) {
      let decoded;
      try {
        decoded = decodeURIComponent(serializedString);
      } catch {
        return null;
      }
      const headers = decoded.split(":");
      if (headers.length !== 4) {
        return null;
      }
      const [_traceId, _spanId, , flags] = headers;
      const traceId = _traceId.padStart(32, "0");
      const spanId = _spanId.padStart(16, "0");
      const traceFlags = VALID_HEX_RE.test(flags) ? parseInt(flags, 16) & 1 : 1;
      return { traceId, spanId, isRemote: true, traceFlags };
    }
    __name(deserializeSpanContext, "deserializeSpanContext");
  }
});

// packages/core/node_modules/@opentelemetry/propagator-jaeger/build/src/index.js
var require_src13 = __commonJS({
  "packages/core/node_modules/@opentelemetry/propagator-jaeger/build/src/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.UBER_TRACE_ID_HEADER = exports.UBER_BAGGAGE_HEADER_PREFIX = exports.JaegerPropagator = void 0;
    var JaegerPropagator_1 = require_JaegerPropagator();
    Object.defineProperty(exports, "JaegerPropagator", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return JaegerPropagator_1.JaegerPropagator;
    }, "get") });
    Object.defineProperty(exports, "UBER_BAGGAGE_HEADER_PREFIX", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return JaegerPropagator_1.UBER_BAGGAGE_HEADER_PREFIX;
    }, "get") });
    Object.defineProperty(exports, "UBER_TRACE_ID_HEADER", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return JaegerPropagator_1.UBER_TRACE_ID_HEADER;
    }, "get") });
  }
});

// sdk-node-exporter-stub:@opentelemetry/otlp-exporter-base
var require_otlp_exporter_base = __commonJS({
  "sdk-node-exporter-stub:@opentelemetry/otlp-exporter-base"(exports, module) {
    init_esbuild_shims();
    var throwStubbed = /* @__PURE__ */ __name((name) => {
      throw new Error(
        "qwen-code bundles @opentelemetry/sdk-node without @opentelemetry/otlp-exporter-base (env-based exporter selection is unsupported; configure telemetry via qwen-code settings instead). Attempted to construct: " + name
      );
    }, "throwStubbed");
    var handler = {
      // Module interop and thenable probes must see a plain, non-callable
      // namespace: a bundler or await import() reads then and __esModule
      // (Symbol.* keys are already covered by the typeof check), and
      // constructing those as "exporters" would throw a confusing error.
      get: /* @__PURE__ */ __name((_t, prop) => {
        if (typeof prop !== "string" || prop === "then" || prop === "__esModule") {
          return void 0;
        }
        return /* @__PURE__ */ __name(function stubbedExporter() {
          throwStubbed(prop);
        }, "stubbedExporter");
      }, "get")
    };
    module.exports = new Proxy({}, handler);
  }
});

// sdk-node-exporter-stub:@opentelemetry/otlp-grpc-exporter-base
var require_otlp_grpc_exporter_base = __commonJS({
  "sdk-node-exporter-stub:@opentelemetry/otlp-grpc-exporter-base"(exports, module) {
    init_esbuild_shims();
    var throwStubbed = /* @__PURE__ */ __name((name) => {
      throw new Error(
        "qwen-code bundles @opentelemetry/sdk-node without @opentelemetry/otlp-grpc-exporter-base (env-based exporter selection is unsupported; configure telemetry via qwen-code settings instead). Attempted to construct: " + name
      );
    }, "throwStubbed");
    var handler = {
      // Module interop and thenable probes must see a plain, non-callable
      // namespace: a bundler or await import() reads then and __esModule
      // (Symbol.* keys are already covered by the typeof check), and
      // constructing those as "exporters" would throw a confusing error.
      get: /* @__PURE__ */ __name((_t, prop) => {
        if (typeof prop !== "string" || prop === "then" || prop === "__esModule") {
          return void 0;
        }
        return /* @__PURE__ */ __name(function stubbedExporter() {
          throwStubbed(prop);
        }, "stubbedExporter");
      }, "get")
    };
    module.exports = new Proxy({}, handler);
  }
});

// sdk-node-exporter-stub:@opentelemetry/configuration
var require_configuration = __commonJS({
  "sdk-node-exporter-stub:@opentelemetry/configuration"(exports, module) {
    init_esbuild_shims();
    var throwStubbed = /* @__PURE__ */ __name((name) => {
      throw new Error(
        "qwen-code bundles @opentelemetry/sdk-node without @opentelemetry/configuration (env-based exporter selection is unsupported; configure telemetry via qwen-code settings instead). Attempted to construct: " + name
      );
    }, "throwStubbed");
    var handler = {
      // Module interop and thenable probes must see a plain, non-callable
      // namespace: a bundler or await import() reads then and __esModule
      // (Symbol.* keys are already covered by the typeof check), and
      // constructing those as "exporters" would throw a confusing error.
      get: /* @__PURE__ */ __name((_t, prop) => {
        if (typeof prop !== "string" || prop === "then" || prop === "__esModule") {
          return void 0;
        }
        return /* @__PURE__ */ __name(function stubbedExporter() {
          throwStubbed(prop);
        }, "stubbedExporter");
      }, "get")
    };
    module.exports = new Proxy({}, handler);
  }
});

// sdk-node-exporter-stub:@opentelemetry/exporter-metrics-otlp-grpc
var require_exporter_metrics_otlp_grpc = __commonJS({
  "sdk-node-exporter-stub:@opentelemetry/exporter-metrics-otlp-grpc"(exports, module) {
    init_esbuild_shims();
    var throwStubbed = /* @__PURE__ */ __name((name) => {
      throw new Error(
        "qwen-code bundles @opentelemetry/sdk-node without @opentelemetry/exporter-metrics-otlp-grpc (env-based exporter selection is unsupported; configure telemetry via qwen-code settings instead). Attempted to construct: " + name
      );
    }, "throwStubbed");
    var handler = {
      // Module interop and thenable probes must see a plain, non-callable
      // namespace: a bundler or await import() reads then and __esModule
      // (Symbol.* keys are already covered by the typeof check), and
      // constructing those as "exporters" would throw a confusing error.
      get: /* @__PURE__ */ __name((_t, prop) => {
        if (typeof prop !== "string" || prop === "then" || prop === "__esModule") {
          return void 0;
        }
        return /* @__PURE__ */ __name(function stubbedExporter() {
          throwStubbed(prop);
        }, "stubbedExporter");
      }, "get")
    };
    module.exports = new Proxy({}, handler);
  }
});

// sdk-node-exporter-stub:@opentelemetry/exporter-metrics-otlp-http
var require_exporter_metrics_otlp_http = __commonJS({
  "sdk-node-exporter-stub:@opentelemetry/exporter-metrics-otlp-http"(exports, module) {
    init_esbuild_shims();
    var throwStubbed = /* @__PURE__ */ __name((name) => {
      throw new Error(
        "qwen-code bundles @opentelemetry/sdk-node without @opentelemetry/exporter-metrics-otlp-http (env-based exporter selection is unsupported; configure telemetry via qwen-code settings instead). Attempted to construct: " + name
      );
    }, "throwStubbed");
    var handler = {
      // Module interop and thenable probes must see a plain, non-callable
      // namespace: a bundler or await import() reads then and __esModule
      // (Symbol.* keys are already covered by the typeof check), and
      // constructing those as "exporters" would throw a confusing error.
      get: /* @__PURE__ */ __name((_t, prop) => {
        if (typeof prop !== "string" || prop === "then" || prop === "__esModule") {
          return void 0;
        }
        return /* @__PURE__ */ __name(function stubbedExporter() {
          throwStubbed(prop);
        }, "stubbedExporter");
      }, "get")
    };
    module.exports = new Proxy({}, handler);
  }
});

// sdk-node-exporter-stub:@opentelemetry/exporter-metrics-otlp-proto
var require_exporter_metrics_otlp_proto = __commonJS({
  "sdk-node-exporter-stub:@opentelemetry/exporter-metrics-otlp-proto"(exports, module) {
    init_esbuild_shims();
    var throwStubbed = /* @__PURE__ */ __name((name) => {
      throw new Error(
        "qwen-code bundles @opentelemetry/sdk-node without @opentelemetry/exporter-metrics-otlp-proto (env-based exporter selection is unsupported; configure telemetry via qwen-code settings instead). Attempted to construct: " + name
      );
    }, "throwStubbed");
    var handler = {
      // Module interop and thenable probes must see a plain, non-callable
      // namespace: a bundler or await import() reads then and __esModule
      // (Symbol.* keys are already covered by the typeof check), and
      // constructing those as "exporters" would throw a confusing error.
      get: /* @__PURE__ */ __name((_t, prop) => {
        if (typeof prop !== "string" || prop === "then" || prop === "__esModule") {
          return void 0;
        }
        return /* @__PURE__ */ __name(function stubbedExporter() {
          throwStubbed(prop);
        }, "stubbedExporter");
      }, "get")
    };
    module.exports = new Proxy({}, handler);
  }
});

// packages/core/node_modules/@opentelemetry/sdk-node/build/src/create-from-env.js
var require_create_from_env = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-node/build/src/create-from-env.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createBatchSpanProcessorFromEnv = exports.createSpanLimitsFromEnv = exports.createSamplerFromEnv = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src3();
    var sdk_trace_1 = require_src9();
    var sdk_trace_2 = require_src9();
    var utils_1 = require_utils5();
    var DEFAULT_RATIO = 1;
    function createSamplerFromEnv() {
      const samplerName = (0, core_1.getStringFromEnv)("OTEL_TRACES_SAMPLER");
      if (samplerName === void 0) {
        return void 0;
      }
      switch (samplerName) {
        case "always_on":
          return new sdk_trace_2.AlwaysOnSampler();
        case "always_off":
          return new sdk_trace_2.AlwaysOffSampler();
        case "parentbased_always_on":
          return new sdk_trace_2.ParentBasedSampler({
            root: new sdk_trace_2.AlwaysOnSampler()
          });
        case "parentbased_always_off":
          return new sdk_trace_2.ParentBasedSampler({
            root: new sdk_trace_2.AlwaysOffSampler()
          });
        case "traceidratio":
          return new sdk_trace_2.TraceIdRatioBasedSampler(getSamplerRatioFromEnv());
        case "parentbased_traceidratio":
          return new sdk_trace_2.ParentBasedSampler({
            root: new sdk_trace_2.TraceIdRatioBasedSampler(getSamplerRatioFromEnv())
          });
        default:
          api_1.diag.error(`unknown OTEL_TRACES_SAMPLER value "${samplerName}", using default`);
          return void 0;
      }
    }
    __name(createSamplerFromEnv, "createSamplerFromEnv");
    exports.createSamplerFromEnv = createSamplerFromEnv;
    function getSamplerRatioFromEnv() {
      const ratio = (0, core_1.getNumberFromEnv)("OTEL_TRACES_SAMPLER_ARG");
      if (ratio == null) {
        api_1.diag.error(`OTEL_TRACES_SAMPLER_ARG is blank, defaulting to ${DEFAULT_RATIO}.`);
        return DEFAULT_RATIO;
      }
      if (ratio < 0 || ratio > 1) {
        api_1.diag.error(`OTEL_TRACES_SAMPLER_ARG=${ratio} was given, but it is out of range ([0..1]), defaulting to ${DEFAULT_RATIO}.`);
        return DEFAULT_RATIO;
      }
      return ratio;
    }
    __name(getSamplerRatioFromEnv, "getSamplerRatioFromEnv");
    function createSpanLimitsFromEnv() {
      return {
        attributeCountLimit: (0, core_1.getNumberFromEnv)("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT") ?? (0, core_1.getNumberFromEnv)("OTEL_ATTRIBUTE_COUNT_LIMIT"),
        attributeValueLengthLimit: (0, core_1.getNumberFromEnv)("OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT") ?? (0, core_1.getNumberFromEnv)("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT"),
        eventCountLimit: (0, core_1.getNumberFromEnv)("OTEL_SPAN_EVENT_COUNT_LIMIT"),
        linkCountLimit: (0, core_1.getNumberFromEnv)("OTEL_SPAN_LINK_COUNT_LIMIT"),
        attributePerEventCountLimit: (0, core_1.getNumberFromEnv)("OTEL_SPAN_ATTRIBUTE_PER_EVENT_COUNT_LIMIT"),
        attributePerLinkCountLimit: (0, core_1.getNumberFromEnv)("OTEL_SPAN_ATTRIBUTE_PER_LINK_COUNT_LIMIT")
      };
    }
    __name(createSpanLimitsFromEnv, "createSpanLimitsFromEnv");
    exports.createSpanLimitsFromEnv = createSpanLimitsFromEnv;
    function createBatchSpanProcessorFromEnv(exporter, selfObsMeterProvider) {
      return new sdk_trace_1.BatchSpanProcessor({
        exporter,
        selfObsMeterProvider,
        maxQueueSize: (0, utils_1.getNonNegativeNumberFromEnv)("OTEL_BSP_MAX_QUEUE_SIZE"),
        scheduledDelayMillis: (0, utils_1.getNonNegativeNumberFromEnv)("OTEL_BSP_SCHEDULE_DELAY"),
        exportTimeoutMillis: (0, utils_1.getNonNegativeNumberFromEnv)("OTEL_BSP_EXPORT_TIMEOUT"),
        maxExportBatchSize: (0, utils_1.getNonNegativeNumberFromEnv)("OTEL_BSP_MAX_EXPORT_BATCH_SIZE")
      });
    }
    __name(createBatchSpanProcessorFromEnv, "createBatchSpanProcessorFromEnv");
    exports.createBatchSpanProcessorFromEnv = createBatchSpanProcessorFromEnv;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-node/build/src/utils.js
var require_utils5 = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-node/build/src/utils.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.buildSamplerFromConfig = exports.getSamplerFromConfiguration = exports.getInstanceID = exports.getMeterViewsFromConfiguration = exports.getAggregationType = exports.getInstrumentType = exports.getMeterReadersFromConfiguration = exports.getIdGeneratorFromConfiguration = exports.getSpanProcessorsFromConfiguration = exports.getSpanExporter = exports.getGrpcMetadataFromHeaders = exports.getGrpcCredentialsFromTls = exports.getHttpAgentOptionsFromTls = exports.validateExporterTimeout = exports.getHeadersFromConfiguration = exports.getBatchLogRecordProcessorFromEnv = exports.getBatchLogRecordProcessorConfigFromEnv = exports.getLoggerProviderConfigFromEnv = exports.getPeriodicMetricReaderFromConfiguration = exports.getMetricExporter = exports.getOtlpMetricExporterFromEnv = exports.getPeriodicExportingMetricReaderFromEnv = exports.getNonNegativeNumberFromEnv = exports.getKeyListFromObjectArray = exports.setupPropagator = exports.setupContextManager = exports.getPropagatorFromConfiguration = exports.getPropagatorFromEnv = exports.getSpanProcessorsFromEnv = exports.getOtlpProtocolFromEnv = exports.getResourceDetectorsFromConfiguration = exports.getResourceDetectorsFromEnv = exports.getResourceFromConfiguration = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src3();
    var exporter_trace_otlp_proto_1 = require_exporter_trace_otlp_proto();
    var exporter_trace_otlp_http_1 = require_exporter_trace_otlp_http();
    var exporter_trace_otlp_grpc_1 = require_exporter_trace_otlp_grpc();
    var exporter_zipkin_1 = require_exporter_zipkin();
    var resources_1 = require_src4();
    var sdk_trace_1 = require_src9();
    var propagator_b3_1 = require_src12();
    var propagator_jaeger_1 = require_src13();
    var context_async_hooks_1 = require_src7();
    var otlp_exporter_base_1 = require_otlp_exporter_base();
    var otlp_grpc_exporter_base_1 = require_otlp_grpc_exporter_base();
    var configuration_1 = require_configuration();
    var sdk_metrics_1 = require_src5();
    var exporter_metrics_otlp_grpc_1 = require_exporter_metrics_otlp_grpc();
    var exporter_metrics_otlp_http_1 = require_exporter_metrics_otlp_http();
    var exporter_metrics_otlp_http_2 = require_exporter_metrics_otlp_http();
    var exporter_metrics_otlp_proto_1 = require_exporter_metrics_otlp_proto();
    var sdk_logs_1 = require_src6();
    var fs2 = __require("fs");
    var util_1 = __require("util");
    var create_from_env_1 = require_create_from_env();
    var RESOURCE_DETECTOR_ENVIRONMENT = "env";
    var RESOURCE_DETECTOR_HOST = "host";
    var RESOURCE_DETECTOR_OS = "os";
    var RESOURCE_DETECTOR_PROCESS = "process";
    var RESOURCE_DETECTOR_SERVICE_INSTANCE_ID = "serviceinstance";
    function getResourceFromConfiguration(config) {
      if (!config.resource) {
        return void 0;
      }
      const configAttrs = (0, configuration_1.mergeResourceAttributesConfig)(config.resource.attributes, config.resource.attributes_list);
      if (!configAttrs) {
        return void 0;
      }
      const attrs = {};
      for (let i = 0; i < configAttrs.length; i++) {
        const a = configAttrs[i];
        if (a.value !== null) {
          attrs[a.name] = a.value;
        }
      }
      return (0, resources_1.resourceFromAttributes)(attrs, {
        schemaUrl: config.resource.schema_url ?? void 0
      });
    }
    __name(getResourceFromConfiguration, "getResourceFromConfiguration");
    exports.getResourceFromConfiguration = getResourceFromConfiguration;
    function getResourceDetectorsFromEnv() {
      const resourceDetectors = /* @__PURE__ */ new Map([
        [RESOURCE_DETECTOR_HOST, resources_1.hostDetector],
        [RESOURCE_DETECTOR_OS, resources_1.osDetector],
        [RESOURCE_DETECTOR_SERVICE_INSTANCE_ID, resources_1.serviceInstanceIdDetector],
        [RESOURCE_DETECTOR_PROCESS, resources_1.processDetector],
        [RESOURCE_DETECTOR_ENVIRONMENT, resources_1.envDetector]
      ]);
      const resourceDetectorsFromEnv = (0, core_1.getStringListFromEnv)("OTEL_NODE_RESOURCE_DETECTORS") ?? ["all"];
      if (resourceDetectorsFromEnv.includes("all")) {
        return [...resourceDetectors.values()].flat();
      }
      if (resourceDetectorsFromEnv.includes("none")) {
        return [];
      }
      return resourceDetectorsFromEnv.flatMap((detector) => {
        const resourceDetector = resourceDetectors.get(detector);
        if (!resourceDetector) {
          api_1.diag.warn(`Invalid resource detector "${detector}" specified in the environment variable OTEL_NODE_RESOURCE_DETECTORS`);
        }
        return resourceDetector || [];
      });
    }
    __name(getResourceDetectorsFromEnv, "getResourceDetectorsFromEnv");
    exports.getResourceDetectorsFromEnv = getResourceDetectorsFromEnv;
    function getResourceDetectorsFromConfiguration(config) {
      const detectors = config.resource?.["detection/development"]?.detectors ?? [];
      return detectors.flatMap((detector) => {
        const result = [];
        if (detector.host !== void 0)
          result.push(resources_1.hostDetector);
        if (detector.os !== void 0)
          result.push(resources_1.osDetector);
        if (detector.process !== void 0)
          result.push(resources_1.processDetector);
        if (detector.service !== void 0)
          result.push(resources_1.serviceInstanceIdDetector);
        if (detector.env !== void 0)
          result.push(resources_1.envDetector);
        return result;
      });
    }
    __name(getResourceDetectorsFromConfiguration, "getResourceDetectorsFromConfiguration");
    exports.getResourceDetectorsFromConfiguration = getResourceDetectorsFromConfiguration;
    function getOtlpProtocolFromEnv() {
      return (0, core_1.getStringFromEnv)("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL") ?? (0, core_1.getStringFromEnv)("OTEL_EXPORTER_OTLP_PROTOCOL") ?? "http/protobuf";
    }
    __name(getOtlpProtocolFromEnv, "getOtlpProtocolFromEnv");
    exports.getOtlpProtocolFromEnv = getOtlpProtocolFromEnv;
    function getOtlpExporterFromEnv() {
      const protocol = getOtlpProtocolFromEnv();
      switch (protocol) {
        case "grpc":
          return new exporter_trace_otlp_grpc_1.OTLPTraceExporter();
        case "http/json":
          return new exporter_trace_otlp_http_1.OTLPTraceExporter();
        case "http/protobuf":
          return new exporter_trace_otlp_proto_1.OTLPTraceExporter();
        default:
          api_1.diag.warn(`Unsupported OTLP traces protocol: ${protocol}. Using http/protobuf.`);
          return new exporter_trace_otlp_proto_1.OTLPTraceExporter();
      }
    }
    __name(getOtlpExporterFromEnv, "getOtlpExporterFromEnv");
    function getSpanProcessorsFromEnv(selfObsMeterProvider) {
      const exportersMap = /* @__PURE__ */ new Map([
        ["otlp", () => getOtlpExporterFromEnv()],
        ["zipkin", () => new exporter_zipkin_1.ZipkinExporter()],
        ["console", () => new sdk_trace_1.ConsoleSpanExporter()]
      ]);
      const exporters = [];
      const processors = [];
      let traceExportersList = Array.from(new Set((0, core_1.getStringListFromEnv)("OTEL_TRACES_EXPORTER"))).filter((s) => s !== "null");
      if (traceExportersList[0] === "none") {
        api_1.diag.warn('OTEL_TRACES_EXPORTER contains "none". SDK will not be initialized.');
        return [];
      }
      if (traceExportersList.length === 0) {
        api_1.diag.debug("OTEL_TRACES_EXPORTER is empty. Using default otlp exporter.");
        traceExportersList = ["otlp"];
      } else if (traceExportersList.length > 1 && traceExportersList.includes("none")) {
        api_1.diag.warn('OTEL_TRACES_EXPORTER contains "none" along with other exporters. Using default otlp exporter.');
        traceExportersList = ["otlp"];
      }
      for (const name of traceExportersList) {
        const exporter = exportersMap.get(name)?.();
        if (exporter) {
          exporters.push(exporter);
        } else {
          api_1.diag.warn(`Unrecognized OTEL_TRACES_EXPORTER value: ${name}.`);
        }
      }
      for (const exp of exporters) {
        if (exp instanceof sdk_trace_1.ConsoleSpanExporter) {
          processors.push(new sdk_trace_1.SimpleSpanProcessor({ exporter: exp, selfObsMeterProvider }));
        } else {
          processors.push((0, create_from_env_1.createBatchSpanProcessorFromEnv)(exp, selfObsMeterProvider));
        }
      }
      if (exporters.length === 0) {
        api_1.diag.warn("Unable to set up trace exporter(s) due to invalid exporter and/or protocol values.");
      }
      return processors;
    }
    __name(getSpanProcessorsFromEnv, "getSpanProcessorsFromEnv");
    exports.getSpanProcessorsFromEnv = getSpanProcessorsFromEnv;
    function getPropagatorFromEnv() {
      const propagatorsEnvVarValue = (0, core_1.getStringListFromEnv)("OTEL_PROPAGATORS");
      if (propagatorsEnvVarValue == null) {
        return void 0;
      }
      if (propagatorsEnvVarValue.includes("none")) {
        return null;
      }
      const propagatorsFactory = /* @__PURE__ */ new Map([
        ["tracecontext", () => new core_1.W3CTraceContextPropagator()],
        ["baggage", () => new core_1.W3CBaggagePropagator()],
        ["b3", () => new propagator_b3_1.B3Propagator()],
        [
          "b3multi",
          () => new propagator_b3_1.B3Propagator({ injectEncoding: propagator_b3_1.B3InjectEncoding.MULTI_HEADER })
        ],
        [
          "jaeger",
          () => {
            api_1.diag.warn('The Jaeger propagator is deprecated and will be removed in a future release. Use the W3C TraceContext propagator ("tracecontext") instead.');
            return new propagator_jaeger_1.JaegerPropagator();
          }
        ]
      ]);
      const uniquePropagatorNames = Array.from(new Set(propagatorsEnvVarValue));
      const validPropagators = [];
      uniquePropagatorNames.forEach((name) => {
        const propagator = propagatorsFactory.get(name)?.();
        if (!propagator) {
          api_1.diag.warn(`Propagator "${name}" requested through environment variable is unavailable.`);
          return;
        }
        validPropagators.push(propagator);
      });
      if (validPropagators.length === 0) {
        return null;
      } else if (uniquePropagatorNames.length === 1) {
        return validPropagators[0];
      } else {
        return new core_1.CompositePropagator({
          propagators: validPropagators
        });
      }
    }
    __name(getPropagatorFromEnv, "getPropagatorFromEnv");
    exports.getPropagatorFromEnv = getPropagatorFromEnv;
    function getPropagatorFromConfiguration(config) {
      if (!config.propagator) {
        return void 0;
      }
      const configComposite = (0, configuration_1.mergePropagatorCompositeConfig)(config.propagator.composite, config.propagator.composite_list);
      if (!configComposite) {
        return void 0;
      }
      const kvFromItem = /* @__PURE__ */ __name((item) => {
        const keys = [];
        let value = void 0;
        for (const key of Object.keys(item)) {
          value = item[key];
          if (value === void 0) {
            continue;
          }
          keys.push(key);
        }
        if (keys.length !== 1) {
          throw new Error(`invalid "propagator" entry in configuration, there must be exactly one key (with a non-undefined value): ${(0, util_1.inspect)(item)}`);
        }
        return [keys[0], value];
      }, "kvFromItem");
      const names = /* @__PURE__ */ new Set();
      const kvs = [];
      for (const item of configComposite) {
        const kv = kvFromItem(item);
        const k = kv[0];
        if (names.has(k)) {
          continue;
        }
        names.add(k);
        kvs.push(kv);
        if (k === "none") {
          return void 0;
        }
      }
      const propagatorsFactory = /* @__PURE__ */ new Map([
        ["tracecontext", () => new core_1.W3CTraceContextPropagator()],
        ["baggage", () => new core_1.W3CBaggagePropagator()],
        ["b3", () => new propagator_b3_1.B3Propagator()],
        [
          "b3multi",
          () => new propagator_b3_1.B3Propagator({ injectEncoding: propagator_b3_1.B3InjectEncoding.MULTI_HEADER })
        ],
        [
          "jaeger",
          () => {
            api_1.diag.warn('The Jaeger propagator is deprecated and will be removed in a future release. Use the W3C TraceContext propagator ("tracecontext") instead.');
            return new propagator_jaeger_1.JaegerPropagator();
          }
        ]
      ]);
      const validPropagators = [];
      for (const [name] of kvs) {
        const propagator = propagatorsFactory.get(name)?.();
        if (!propagator) {
          api_1.diag.warn(`Propagator "${name}" requested through configuration is unavailable.`);
          continue;
        }
        validPropagators.push(propagator);
      }
      if (validPropagators.length === 0) {
        return void 0;
      } else if (validPropagators.length === 1) {
        return validPropagators[0];
      } else {
        return new core_1.CompositePropagator({
          propagators: validPropagators
        });
      }
    }
    __name(getPropagatorFromConfiguration, "getPropagatorFromConfiguration");
    exports.getPropagatorFromConfiguration = getPropagatorFromConfiguration;
    function setupContextManager(contextManager) {
      if (contextManager === null) {
        return;
      }
      if (contextManager === void 0) {
        const defaultContextManager = new context_async_hooks_1.AsyncLocalStorageContextManager();
        defaultContextManager.enable();
        api_1.context.setGlobalContextManager(defaultContextManager);
        return;
      }
      contextManager.enable();
      api_1.context.setGlobalContextManager(contextManager);
    }
    __name(setupContextManager, "setupContextManager");
    exports.setupContextManager = setupContextManager;
    function setupPropagator(propagator) {
      if (propagator === null) {
        return;
      }
      if (propagator === void 0) {
        api_1.propagation.setGlobalPropagator(new core_1.CompositePropagator({
          propagators: [
            new core_1.W3CTraceContextPropagator(),
            new core_1.W3CBaggagePropagator()
          ]
        }));
        return;
      }
      api_1.propagation.setGlobalPropagator(propagator);
    }
    __name(setupPropagator, "setupPropagator");
    exports.setupPropagator = setupPropagator;
    function getKeyListFromObjectArray(obj) {
      if (!obj || obj.length === 0) {
        return void 0;
      }
      const keys = [];
      for (const item of obj) {
        for (const key of Object.keys(item)) {
          keys.push(key);
        }
      }
      return keys;
    }
    __name(getKeyListFromObjectArray, "getKeyListFromObjectArray");
    exports.getKeyListFromObjectArray = getKeyListFromObjectArray;
    function getNonNegativeNumberFromEnv(envVarName) {
      const value = (0, core_1.getNumberFromEnv)(envVarName);
      if (value != null && value <= 0) {
        api_1.diag.warn(`${envVarName} (${value}) is invalid, expected number greater than 0, using default.`);
        return void 0;
      }
      return value;
    }
    __name(getNonNegativeNumberFromEnv, "getNonNegativeNumberFromEnv");
    exports.getNonNegativeNumberFromEnv = getNonNegativeNumberFromEnv;
    function getPeriodicExportingMetricReaderFromEnv(exporter) {
      const defaultTimeoutMillis = 3e4;
      const defaultIntervalMillis = 6e4;
      const rawExportIntervalMillis = getNonNegativeNumberFromEnv("OTEL_METRIC_EXPORT_INTERVAL");
      const rawExportTimeoutMillis = getNonNegativeNumberFromEnv("OTEL_METRIC_EXPORT_TIMEOUT");
      const exportIntervalMillis = rawExportIntervalMillis ?? defaultIntervalMillis;
      let exportTimeoutMillis = rawExportTimeoutMillis ?? defaultTimeoutMillis;
      if (exportTimeoutMillis > exportIntervalMillis) {
        const timeoutSource = rawExportTimeoutMillis != null ? rawExportTimeoutMillis.toString() : `${defaultTimeoutMillis}, default`;
        const intervalSource = rawExportIntervalMillis != null ? rawExportIntervalMillis.toString() : `${defaultIntervalMillis}, default`;
        const bothSetByUser = rawExportTimeoutMillis != null && rawExportIntervalMillis != null;
        const logMessage = `OTEL_METRIC_EXPORT_TIMEOUT (${timeoutSource}) is greater than OTEL_METRIC_EXPORT_INTERVAL (${intervalSource}). Clamping timeout to interval value.`;
        if (bothSetByUser) {
          api_1.diag.warn(logMessage);
        } else {
          api_1.diag.info(logMessage);
        }
        exportTimeoutMillis = exportIntervalMillis;
      }
      return new sdk_metrics_1.PeriodicExportingMetricReader({
        exportTimeoutMillis,
        exportIntervalMillis,
        exporter
      });
    }
    __name(getPeriodicExportingMetricReaderFromEnv, "getPeriodicExportingMetricReaderFromEnv");
    exports.getPeriodicExportingMetricReaderFromEnv = getPeriodicExportingMetricReaderFromEnv;
    function getOtlpMetricExporterFromEnv() {
      const protocol = ((0, core_1.getStringFromEnv)("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL") ?? (0, core_1.getStringFromEnv)("OTEL_EXPORTER_OTLP_PROTOCOL"))?.trim() || "http/protobuf";
      switch (protocol) {
        case "grpc":
          return new exporter_metrics_otlp_grpc_1.OTLPMetricExporter();
        case "http/json":
          return new exporter_metrics_otlp_http_1.OTLPMetricExporter();
        case "http/protobuf":
          return new exporter_metrics_otlp_proto_1.OTLPMetricExporter();
      }
      api_1.diag.warn(`Unsupported OTLP metrics protocol: "${protocol}". Using http/protobuf.`);
      return new exporter_metrics_otlp_proto_1.OTLPMetricExporter();
    }
    __name(getOtlpMetricExporterFromEnv, "getOtlpMetricExporterFromEnv");
    exports.getOtlpMetricExporterFromEnv = getOtlpMetricExporterFromEnv;
    function getMetricProducersFromConfiguration(producers) {
      if (!producers || producers.length === 0) {
        return void 0;
      }
      const result = [];
      for (const producer of producers) {
        api_1.diag.warn(`Unsupported metric producer in configuration: "${producer}". Skipping.`);
      }
      return result.length > 0 ? result : void 0;
    }
    __name(getMetricProducersFromConfiguration, "getMetricProducersFromConfiguration");
    function getMetricTemporalityPreference(preference) {
      switch (preference) {
        case "delta":
          return exporter_metrics_otlp_http_2.AggregationTemporalityPreference.DELTA;
        case "low_memory":
          return exporter_metrics_otlp_http_2.AggregationTemporalityPreference.LOWMEMORY;
        case "cumulative":
          return exporter_metrics_otlp_http_2.AggregationTemporalityPreference.CUMULATIVE;
        default:
          return void 0;
      }
    }
    __name(getMetricTemporalityPreference, "getMetricTemporalityPreference");
    function getMetricAggregationPreference(aggregation) {
      let histogramAggregation;
      switch (aggregation) {
        case "base2_exponential_bucket_histogram":
          histogramAggregation = { type: sdk_metrics_1.AggregationType.EXPONENTIAL_HISTOGRAM };
          break;
        case "explicit_bucket_histogram":
          histogramAggregation = {
            type: sdk_metrics_1.AggregationType.EXPLICIT_BUCKET_HISTOGRAM
          };
          break;
        default:
          return void 0;
      }
      return (instrumentType) => instrumentType === sdk_metrics_1.InstrumentType.HISTOGRAM ? histogramAggregation : { type: sdk_metrics_1.AggregationType.DEFAULT };
    }
    __name(getMetricAggregationPreference, "getMetricAggregationPreference");
    function getOtlpHttpMetricExporter(otlpHttp) {
      const encoding = otlpHttp?.encoding ?? "protobuf";
      const options = {
        compression: otlpHttp?.compression === "gzip" ? otlp_exporter_base_1.CompressionAlgorithm.GZIP : otlp_exporter_base_1.CompressionAlgorithm.NONE,
        url: otlpHttp?.endpoint ?? void 0,
        headers: getHeadersFromConfiguration(otlpHttp?.headers),
        timeoutMillis: validateExporterTimeout(otlpHttp?.timeout),
        httpAgentOptions: getHttpAgentOptionsFromTls(otlpHttp?.tls),
        temporalityPreference: getMetricTemporalityPreference(otlpHttp?.temporality_preference),
        aggregationPreference: getMetricAggregationPreference(otlpHttp?.default_histogram_aggregation)
      };
      if (encoding === "json") {
        return new exporter_metrics_otlp_http_1.OTLPMetricExporter(options);
      } else if (encoding === "protobuf") {
        return new exporter_metrics_otlp_proto_1.OTLPMetricExporter(options);
      }
      api_1.diag.warn(`Unsupported OTLP metrics encoding: ${encoding}.`);
      return void 0;
    }
    __name(getOtlpHttpMetricExporter, "getOtlpHttpMetricExporter");
    function getOtlpGrpcMetricExporter(otlpGrpc) {
      return new exporter_metrics_otlp_grpc_1.OTLPMetricExporter({
        compression: otlpGrpc?.compression === "gzip" ? otlp_exporter_base_1.CompressionAlgorithm.GZIP : otlp_exporter_base_1.CompressionAlgorithm.NONE,
        url: otlpGrpc?.endpoint ?? void 0,
        timeoutMillis: validateExporterTimeout(otlpGrpc?.timeout),
        credentials: getGrpcCredentialsFromTls(otlpGrpc?.tls),
        metadata: getGrpcMetadataFromHeaders(otlpGrpc?.headers),
        temporalityPreference: getMetricTemporalityPreference(otlpGrpc?.temporality_preference),
        aggregationPreference: getMetricAggregationPreference(otlpGrpc?.default_histogram_aggregation)
      });
    }
    __name(getOtlpGrpcMetricExporter, "getOtlpGrpcMetricExporter");
    function getMetricExporter(exporter) {
      if (exporter.otlp_http !== void 0) {
        return getOtlpHttpMetricExporter(exporter.otlp_http);
      }
      if (exporter.otlp_grpc !== void 0) {
        return getOtlpGrpcMetricExporter(exporter.otlp_grpc);
      }
      if (exporter.console !== void 0) {
        return new sdk_metrics_1.ConsoleMetricExporter();
      }
      api_1.diag.warn("Unsupported Metric Exporter.");
      return void 0;
    }
    __name(getMetricExporter, "getMetricExporter");
    exports.getMetricExporter = getMetricExporter;
    function getPeriodicMetricReaderFromConfiguration(periodic) {
      if (!periodic.exporter) {
        api_1.diag.warn("Unsupported Metric Exporter.");
        return void 0;
      }
      const exporter = getMetricExporter(periodic.exporter);
      if (!exporter) {
        return void 0;
      }
      const metricProducers = getMetricProducersFromConfiguration(periodic.producers);
      return new sdk_metrics_1.PeriodicExportingMetricReader({
        exportIntervalMillis: periodic.interval ?? 6e4,
        exportTimeoutMillis: periodic.timeout ?? 3e4,
        exporter,
        metricProducers
      });
    }
    __name(getPeriodicMetricReaderFromConfiguration, "getPeriodicMetricReaderFromConfiguration");
    exports.getPeriodicMetricReaderFromConfiguration = getPeriodicMetricReaderFromConfiguration;
    function getLoggerProviderConfigFromEnv() {
      return {
        logRecordLimits: {
          attributeCountLimit: getNonNegativeNumberFromEnv("OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT") ?? getNonNegativeNumberFromEnv("OTEL_ATTRIBUTE_COUNT_LIMIT"),
          attributeValueLengthLimit: getNonNegativeNumberFromEnv("OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT") ?? getNonNegativeNumberFromEnv("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT")
        }
      };
    }
    __name(getLoggerProviderConfigFromEnv, "getLoggerProviderConfigFromEnv");
    exports.getLoggerProviderConfigFromEnv = getLoggerProviderConfigFromEnv;
    function getBatchLogRecordProcessorConfigFromEnv() {
      return {
        maxQueueSize: getNonNegativeNumberFromEnv("OTEL_BLRP_MAX_QUEUE_SIZE"),
        scheduledDelayMillis: getNonNegativeNumberFromEnv("OTEL_BLRP_SCHEDULE_DELAY"),
        exportTimeoutMillis: getNonNegativeNumberFromEnv("OTEL_BLRP_EXPORT_TIMEOUT"),
        maxExportBatchSize: getNonNegativeNumberFromEnv("OTEL_BLRP_MAX_EXPORT_BATCH_SIZE")
      };
    }
    __name(getBatchLogRecordProcessorConfigFromEnv, "getBatchLogRecordProcessorConfigFromEnv");
    exports.getBatchLogRecordProcessorConfigFromEnv = getBatchLogRecordProcessorConfigFromEnv;
    function getBatchLogRecordProcessorFromEnv(exporter, selfObsMeterProvider) {
      return new sdk_logs_1.BatchLogRecordProcessor({
        exporter,
        selfObsMeterProvider,
        ...getBatchLogRecordProcessorConfigFromEnv()
      });
    }
    __name(getBatchLogRecordProcessorFromEnv, "getBatchLogRecordProcessorFromEnv");
    exports.getBatchLogRecordProcessorFromEnv = getBatchLogRecordProcessorFromEnv;
    function getHeadersFromConfiguration(headers) {
      if (!headers) {
        return void 0;
      }
      const result = {};
      headers.forEach((header) => {
        if (header.value !== null) {
          result[header.name] = header.value;
        }
      });
      return result;
    }
    __name(getHeadersFromConfiguration, "getHeadersFromConfiguration");
    exports.getHeadersFromConfiguration = getHeadersFromConfiguration;
    function validateExporterTimeout(timeout) {
      if (timeout === null) {
        return void 0;
      } else if (timeout === 0) {
        api_1.diag.warn("Exporter timeout of 0 (infinite) is not supported. Using default timeout.");
        return void 0;
      }
      return timeout;
    }
    __name(validateExporterTimeout, "validateExporterTimeout");
    exports.validateExporterTimeout = validateExporterTimeout;
    function getHttpAgentOptionsFromTls(tls) {
      if (tls && (tls.ca_file || tls.cert_file || tls.key_file)) {
        return {
          ca: readFileOrWarn(tls.ca_file, "TLS CA"),
          cert: readFileOrWarn(tls.cert_file, "TLS cert"),
          key: readFileOrWarn(tls.key_file, "TLS key")
        };
      }
      return void 0;
    }
    __name(getHttpAgentOptionsFromTls, "getHttpAgentOptionsFromTls");
    exports.getHttpAgentOptionsFromTls = getHttpAgentOptionsFromTls;
    function getGrpcCredentialsFromTls(tls) {
      if (tls?.insecure) {
        return (0, otlp_grpc_exporter_base_1.createInsecureCredentials)();
      }
      const rootCert = readFileOrWarn(tls?.ca_file, "TLS CA");
      const privateKey = readFileOrWarn(tls?.key_file, "TLS key");
      const certChain = readFileOrWarn(tls?.cert_file, "TLS cert");
      if (rootCert || privateKey || certChain) {
        try {
          return (0, otlp_grpc_exporter_base_1.createSslCredentials)(rootCert, privateKey, certChain);
        } catch (e) {
          api_1.diag.warn(`Failed to create gRPC SSL credentials: ${e}`);
          return void 0;
        }
      }
      return void 0;
    }
    __name(getGrpcCredentialsFromTls, "getGrpcCredentialsFromTls");
    exports.getGrpcCredentialsFromTls = getGrpcCredentialsFromTls;
    function getGrpcMetadataFromHeaders(headers) {
      if (!headers || headers.length === 0) {
        return void 0;
      }
      const metadata = (0, otlp_grpc_exporter_base_1.createEmptyMetadata)();
      for (const header of headers) {
        if (header.value !== null) {
          metadata.set(header.name, header.value);
        }
      }
      return metadata;
    }
    __name(getGrpcMetadataFromHeaders, "getGrpcMetadataFromHeaders");
    exports.getGrpcMetadataFromHeaders = getGrpcMetadataFromHeaders;
    function readFileOrWarn(filePath, label) {
      if (!filePath)
        return void 0;
      try {
        return fs2.readFileSync(filePath);
      } catch (e) {
        api_1.diag.warn(`Failed to read ${label} file at ${filePath}: ${e}`);
        return void 0;
      }
    }
    __name(readFileOrWarn, "readFileOrWarn");
    function getSpanExporter(exporter) {
      if (exporter.otlp_http !== void 0) {
        const encoding = exporter.otlp_http?.encoding ?? "protobuf";
        if (encoding === "json") {
          return new exporter_trace_otlp_http_1.OTLPTraceExporter({
            compression: exporter.otlp_http?.compression === "gzip" ? otlp_exporter_base_1.CompressionAlgorithm.GZIP : otlp_exporter_base_1.CompressionAlgorithm.NONE,
            url: exporter.otlp_http?.endpoint ?? void 0,
            headers: getHeadersFromConfiguration(exporter.otlp_http?.headers),
            timeoutMillis: validateExporterTimeout(exporter.otlp_http?.timeout),
            httpAgentOptions: getHttpAgentOptionsFromTls(exporter.otlp_http?.tls)
          });
        } else {
          return new exporter_trace_otlp_proto_1.OTLPTraceExporter({
            compression: exporter.otlp_http?.compression === "gzip" ? otlp_exporter_base_1.CompressionAlgorithm.GZIP : otlp_exporter_base_1.CompressionAlgorithm.NONE,
            url: exporter.otlp_http?.endpoint ?? void 0,
            headers: getHeadersFromConfiguration(exporter.otlp_http?.headers),
            timeoutMillis: validateExporterTimeout(exporter.otlp_http?.timeout),
            httpAgentOptions: getHttpAgentOptionsFromTls(exporter.otlp_http?.tls)
          });
        }
      } else if (exporter.otlp_grpc !== void 0) {
        return new exporter_trace_otlp_grpc_1.OTLPTraceExporter({
          compression: exporter.otlp_grpc?.compression === "gzip" ? otlp_exporter_base_1.CompressionAlgorithm.GZIP : otlp_exporter_base_1.CompressionAlgorithm.NONE,
          url: exporter.otlp_grpc?.endpoint ?? void 0,
          timeoutMillis: validateExporterTimeout(exporter.otlp_grpc?.timeout),
          credentials: getGrpcCredentialsFromTls(exporter.otlp_grpc?.tls),
          metadata: getGrpcMetadataFromHeaders(exporter.otlp_grpc?.headers)
        });
      } else if (exporter.console !== void 0) {
        return new sdk_trace_1.ConsoleSpanExporter();
      }
      api_1.diag.warn("Unsupported Exporter value. No Span Exporter registered");
      return void 0;
    }
    __name(getSpanExporter, "getSpanExporter");
    exports.getSpanExporter = getSpanExporter;
    function getSpanProcessorsFromConfiguration(config) {
      const spanProcessors = [];
      config.tracer_provider?.processors?.forEach((processor) => {
        if (processor.batch) {
          const exporter = getSpanExporter(processor.batch.exporter);
          if (exporter) {
            spanProcessors.push(new sdk_trace_1.BatchSpanProcessor({
              exporter,
              maxQueueSize: processor.batch.max_queue_size ?? void 0,
              maxExportBatchSize: processor.batch.max_export_batch_size ?? void 0,
              scheduledDelayMillis: processor.batch.schedule_delay ?? void 0,
              exportTimeoutMillis: processor.batch.export_timeout ?? void 0
            }));
          }
        }
        if (processor.simple) {
          const exporter = getSpanExporter(processor.simple.exporter);
          if (exporter) {
            spanProcessors.push(new sdk_trace_1.SimpleSpanProcessor({ exporter }));
          }
        }
      });
      if (spanProcessors.length > 0) {
        return spanProcessors;
      }
      return void 0;
    }
    __name(getSpanProcessorsFromConfiguration, "getSpanProcessorsFromConfiguration");
    exports.getSpanProcessorsFromConfiguration = getSpanProcessorsFromConfiguration;
    function getIdGeneratorFromConfiguration(config) {
      const idGenerator = config.tracer_provider?.id_generator;
      if (!idGenerator) {
        return void 0;
      }
      if (idGenerator.random !== void 0) {
        return new sdk_trace_1.RandomIdGenerator();
      }
      const unknownKeys = Object.keys(idGenerator).filter((k) => k !== "random");
      if (unknownKeys.length > 0) {
        api_1.diag.warn(`Unsupported id_generator type(s): ${unknownKeys.join(", ")}. Using default.`);
      }
      return void 0;
    }
    __name(getIdGeneratorFromConfiguration, "getIdGeneratorFromConfiguration");
    exports.getIdGeneratorFromConfiguration = getIdGeneratorFromConfiguration;
    function getMeterReadersFromConfiguration(config) {
      const metricReaders = [];
      config.meter_provider?.readers?.forEach((reader) => {
        if (reader.periodic) {
          const periodicReader = getPeriodicMetricReaderFromConfiguration(reader.periodic);
          if (periodicReader) {
            metricReaders.push(periodicReader);
          }
        }
      });
      if (metricReaders.length > 0) {
        return metricReaders;
      }
      return void 0;
    }
    __name(getMeterReadersFromConfiguration, "getMeterReadersFromConfiguration");
    exports.getMeterReadersFromConfiguration = getMeterReadersFromConfiguration;
    function getInstrumentType(instrument) {
      switch (instrument) {
        case "counter":
          return sdk_metrics_1.InstrumentType.COUNTER;
        case "gauge":
          return sdk_metrics_1.InstrumentType.GAUGE;
        case "histogram":
          return sdk_metrics_1.InstrumentType.HISTOGRAM;
        case "observable_counter":
          return sdk_metrics_1.InstrumentType.OBSERVABLE_COUNTER;
        case "observable_gauge":
          return sdk_metrics_1.InstrumentType.OBSERVABLE_GAUGE;
        case "observable_up_down_counter":
          return sdk_metrics_1.InstrumentType.OBSERVABLE_UP_DOWN_COUNTER;
        case "up_down_counter":
          return sdk_metrics_1.InstrumentType.UP_DOWN_COUNTER;
        default:
          api_1.diag.warn(`Unsupported instrument type: ${instrument}`);
          return void 0;
      }
    }
    __name(getInstrumentType, "getInstrumentType");
    exports.getInstrumentType = getInstrumentType;
    function getAggregationType(aggregation) {
      if (aggregation.default) {
        return {
          type: sdk_metrics_1.AggregationType.DEFAULT
        };
      }
      if (aggregation.drop) {
        return {
          type: sdk_metrics_1.AggregationType.DROP
        };
      }
      if (aggregation.explicit_bucket_histogram) {
        return {
          type: sdk_metrics_1.AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: {
            recordMinMax: aggregation.explicit_bucket_histogram.record_min_max ?? true,
            boundaries: aggregation.explicit_bucket_histogram.boundaries ?? [
              0,
              5,
              10,
              25,
              50,
              75,
              100,
              250,
              500,
              750,
              1e3,
              2500,
              5e3,
              7500,
              1e4
            ]
          }
        };
      }
      if (aggregation.base2_exponential_bucket_histogram) {
        return {
          type: sdk_metrics_1.AggregationType.EXPONENTIAL_HISTOGRAM,
          options: {
            recordMinMax: aggregation.base2_exponential_bucket_histogram.record_min_max ?? void 0,
            maxSize: aggregation.base2_exponential_bucket_histogram.max_size ?? void 0
          }
        };
      }
      if (aggregation.last_value) {
        return {
          type: sdk_metrics_1.AggregationType.LAST_VALUE
        };
      }
      if (aggregation.sum) {
        return {
          type: sdk_metrics_1.AggregationType.SUM
        };
      }
      api_1.diag.warn("Unsupported aggregation type");
      return void 0;
    }
    __name(getAggregationType, "getAggregationType");
    exports.getAggregationType = getAggregationType;
    function getMeterViewsFromConfiguration(config) {
      const metricViews = [];
      config.meter_provider?.views?.forEach((view) => {
        const viewOption = {};
        if (view.selector) {
          if (view.selector.instrument_name) {
            viewOption.instrumentName = view.selector.instrument_name;
          }
          if (view.selector.instrument_type) {
            const instrumentType = getInstrumentType(view.selector.instrument_type);
            if (instrumentType) {
              viewOption.instrumentType = instrumentType;
            }
          }
          if (view.selector.unit) {
            viewOption.instrumentUnit = view.selector.unit;
          }
          if (view.selector.meter_name) {
            viewOption.meterName = view.selector.meter_name;
          }
          if (view.selector.meter_version) {
            viewOption.meterVersion = view.selector.meter_version;
          }
          if (view.selector.meter_schema_url) {
            viewOption.meterSchemaUrl = view.selector.meter_schema_url;
          }
        }
        if (view.stream) {
          if (view.stream.name) {
            viewOption.name = view.stream.name;
          }
          viewOption.aggregationCardinalityLimit = view.stream.aggregation_cardinality_limit ?? 2e3;
          if (view.stream.description) {
            viewOption.description = view.stream.description;
          }
          if (view.stream.aggregation) {
            const aggregationType = getAggregationType(view.stream.aggregation);
            if (aggregationType) {
              viewOption.aggregation = aggregationType;
            }
          }
          if (view.stream.attribute_keys) {
            const processors = [];
            if (view.stream.attribute_keys.included && view.stream.attribute_keys.included.length > 0) {
              processors.push((0, sdk_metrics_1.createAllowListAttributesProcessor)(view.stream.attribute_keys.included));
            }
            if (view.stream.attribute_keys.excluded && view.stream.attribute_keys.excluded.length > 0) {
              processors.push((0, sdk_metrics_1.createDenyListAttributesProcessor)(view.stream.attribute_keys.excluded));
            }
            if (processors.length > 0) {
              viewOption.attributesProcessors = processors;
            }
          }
        }
        if (Object.keys(viewOption).length > 0) {
          metricViews.push(viewOption);
        }
      });
      if (metricViews.length > 0) {
        return metricViews;
      }
      return void 0;
    }
    __name(getMeterViewsFromConfiguration, "getMeterViewsFromConfiguration");
    exports.getMeterViewsFromConfiguration = getMeterViewsFromConfiguration;
    function getInstanceID(config) {
      if (config.resource?.attributes) {
        for (let i = 0; i < config.resource.attributes.length; i++) {
          const element = config.resource.attributes[i];
          if (element.name === "service.instance.id") {
            return element.value?.toString();
          }
        }
      }
      return void 0;
    }
    __name(getInstanceID, "getInstanceID");
    exports.getInstanceID = getInstanceID;
    var DEFAULT_RATIO = 1;
    function getSamplerFromConfiguration(config) {
      const samplerConfig = config.tracer_provider?.sampler;
      if (!samplerConfig) {
        return void 0;
      }
      return buildSamplerFromConfig(samplerConfig);
    }
    __name(getSamplerFromConfiguration, "getSamplerFromConfiguration");
    exports.getSamplerFromConfiguration = getSamplerFromConfiguration;
    function buildSamplerFromConfig(samplerConfig) {
      if (samplerConfig.always_on !== void 0) {
        return new sdk_trace_1.AlwaysOnSampler();
      }
      if (samplerConfig.always_off !== void 0) {
        return new sdk_trace_1.AlwaysOffSampler();
      }
      if (samplerConfig.trace_id_ratio_based !== void 0) {
        return new sdk_trace_1.TraceIdRatioBasedSampler(samplerConfig.trace_id_ratio_based?.ratio ?? DEFAULT_RATIO);
      }
      if (samplerConfig.parent_based !== void 0) {
        const pb = samplerConfig.parent_based ?? {};
        return new sdk_trace_1.ParentBasedSampler({
          root: pb.root ? buildSamplerFromConfig(pb.root) : new sdk_trace_1.AlwaysOnSampler(),
          remoteParentSampled: pb.remote_parent_sampled ? buildSamplerFromConfig(pb.remote_parent_sampled) : void 0,
          remoteParentNotSampled: pb.remote_parent_not_sampled ? buildSamplerFromConfig(pb.remote_parent_not_sampled) : void 0,
          localParentSampled: pb.local_parent_sampled ? buildSamplerFromConfig(pb.local_parent_sampled) : void 0,
          localParentNotSampled: pb.local_parent_not_sampled ? buildSamplerFromConfig(pb.local_parent_not_sampled) : void 0
        });
      }
      api_1.diag.warn("Unknown sampler config, defaulting to ParentBased(AlwaysOn).");
      return new sdk_trace_1.ParentBasedSampler({ root: new sdk_trace_1.AlwaysOnSampler() });
    }
    __name(buildSamplerFromConfig, "buildSamplerFromConfig");
    exports.buildSamplerFromConfig = buildSamplerFromConfig;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-node/build/src/sdk.js
var require_sdk = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-node/build/src/sdk.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.NodeSDK = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var api_logs_1 = require_src2();
    var instrumentation_1 = require_src11();
    var resources_1 = require_src4();
    var sdk_logs_1 = require_src6();
    var exporter_logs_otlp_http_1 = require_exporter_logs_otlp_http();
    var exporter_logs_otlp_grpc_1 = require_exporter_logs_otlp_grpc();
    var exporter_logs_otlp_proto_1 = require_exporter_logs_otlp_proto();
    var exporter_prometheus_1 = require_exporter_prometheus();
    var sdk_metrics_1 = require_src5();
    var sdk_trace_1 = require_src9();
    var semantic_conventions_1 = (init_esm2(), __toCommonJS(esm_exports2));
    var core_1 = require_src3();
    var utils_1 = require_utils5();
    var create_from_env_1 = require_create_from_env();
    function getMetricReadersFromEnv() {
      const metricReaders = [];
      const enabledExporters = Array.from(new Set((0, core_1.getStringListFromEnv)("OTEL_METRICS_EXPORTER") ?? []));
      if (enabledExporters.length === 0) {
        api_1.diag.debug("OTEL_METRICS_EXPORTER is empty. Using default otlp exporter.");
        enabledExporters.push("otlp");
      }
      if (enabledExporters.includes("none")) {
        api_1.diag.info('OTEL_METRICS_EXPORTER contains "none". Metric provider will not be initialized.');
        return metricReaders;
      }
      enabledExporters.forEach((exporter) => {
        if (exporter === "otlp") {
          metricReaders.push((0, utils_1.getPeriodicExportingMetricReaderFromEnv)((0, utils_1.getOtlpMetricExporterFromEnv)()));
        } else if (exporter === "console") {
          metricReaders.push(new sdk_metrics_1.PeriodicExportingMetricReader({
            exporter: new sdk_metrics_1.ConsoleMetricExporter()
          }));
        } else if (exporter === "prometheus") {
          metricReaders.push(new exporter_prometheus_1.PrometheusExporter());
        } else {
          api_1.diag.warn(`Unsupported OTEL_METRICS_EXPORTER value: "${exporter}". Supported values are: otlp, console, prometheus, none.`);
        }
      });
      return metricReaders;
    }
    __name(getMetricReadersFromEnv, "getMetricReadersFromEnv");
    var NodeSDK2 = class {
      static {
        __name(this, "NodeSDK");
      }
      _loggerProviderConfig;
      _meterProviderConfig;
      _instrumentations;
      _resource;
      _resourceDetectors;
      _autoDetectResources;
      _tracerProvider;
      _loggerProvider;
      _meterProvider;
      _serviceName;
      _configuration;
      _disabled;
      /**
       * Create a new NodeJS SDK instance
       */
      constructor(configuration = {}) {
        if ((0, core_1.getBooleanFromEnv)("OTEL_SDK_DISABLED")) {
          this._disabled = true;
        }
        const logLevel = (0, core_1.getStringFromEnv)("OTEL_LOG_LEVEL");
        if (logLevel != null) {
          api_1.diag.setLogger(new api_1.DiagConsoleLogger(), {
            logLevel: (0, core_1.diagLogLevelFromString)(logLevel)
          });
        }
        this._configuration = configuration;
        this._resource = configuration.resource ?? (0, resources_1.defaultResource)();
        this._autoDetectResources = configuration.autoDetectResources ?? true;
        if (!this._autoDetectResources) {
          this._resourceDetectors = [];
        } else if (configuration.resourceDetectors != null) {
          this._resourceDetectors = configuration.resourceDetectors;
        } else if ((0, core_1.getStringFromEnv)("OTEL_NODE_RESOURCE_DETECTORS")) {
          this._resourceDetectors = (0, utils_1.getResourceDetectorsFromEnv)();
        } else {
          this._resourceDetectors = [resources_1.envDetector, resources_1.processDetector, resources_1.hostDetector];
        }
        this._serviceName = configuration.serviceName;
        if (configuration.spanProcessor) {
          api_1.diag.warn("The 'spanProcessor' option is deprecated. Please use 'spanProcessors' instead.");
        }
        if (configuration.logRecordProcessors) {
          this._loggerProviderConfig = {
            logRecordProcessors: configuration.logRecordProcessors
          };
        } else if (configuration.logRecordProcessor) {
          this._loggerProviderConfig = {
            logRecordProcessors: [configuration.logRecordProcessor]
          };
          api_1.diag.warn("The 'logRecordProcessor' option is deprecated. Please use 'logRecordProcessors' instead.");
        }
        if (configuration.metricReaders) {
          this._meterProviderConfig = {
            readers: configuration.metricReaders,
            views: configuration.views
          };
        } else if (configuration.metricReader) {
          this._meterProviderConfig = {
            readers: [configuration.metricReader],
            views: configuration.views
          };
          api_1.diag.warn("The 'metricReader' option is deprecated. Please use 'metricReaders' instead.");
        } else {
          this._meterProviderConfig = {
            readers: getMetricReadersFromEnv(),
            views: configuration.views
          };
        }
        this._instrumentations = configuration.instrumentations?.flat() ?? [];
      }
      /**
       * Call this method to construct SDK components and register them with the OpenTelemetry API.
       */
      start() {
        if (this._disabled) {
          return;
        }
        (0, instrumentation_1.registerInstrumentations)({
          instrumentations: this._instrumentations
        });
        (0, utils_1.setupContextManager)(this._configuration?.contextManager);
        (0, utils_1.setupPropagator)(this._configuration?.textMapPropagator === null ? null : this._configuration?.textMapPropagator ?? (0, utils_1.getPropagatorFromEnv)());
        if (this._autoDetectResources) {
          const internalConfig = {
            detectors: this._resourceDetectors
          };
          this._resource = this._resource.merge((0, resources_1.detectResources)(internalConfig));
        }
        this._resource = this._serviceName === void 0 ? this._resource : this._resource.merge((0, resources_1.resourceFromAttributes)({
          [semantic_conventions_1.ATTR_SERVICE_NAME]: this._serviceName
        }));
        const sdkMetricsEnabled = (0, core_1.getBooleanFromEnv)("OTEL_NODE_EXPERIMENTAL_SDK_METRICS");
        if (this._meterProviderConfig?.readers && // only register if there is a reader, otherwise we waste compute/memory.
        this._meterProviderConfig.readers.length > 0) {
          const meterProvider = new sdk_metrics_1.MeterProvider({
            resource: this._resource,
            views: this._meterProviderConfig?.views ?? [],
            readers: this._meterProviderConfig.readers,
            sdkMetricsEnabled
          });
          this._meterProvider = meterProvider;
          api_1.metrics.setGlobalMeterProvider(meterProvider);
          for (const instrumentation of this._instrumentations) {
            instrumentation.setMeterProvider(api_1.metrics.getMeterProvider());
          }
        }
        let spanProcessors;
        if (this._configuration?.spanProcessors) {
          spanProcessors = this._configuration.spanProcessors;
        } else if (this._configuration?.spanProcessor) {
          spanProcessors = [this._configuration.spanProcessor];
        } else if (this._configuration?.traceExporter) {
          spanProcessors = [
            (0, create_from_env_1.createBatchSpanProcessorFromEnv)(this._configuration.traceExporter, sdkMetricsEnabled ? this._meterProvider : void 0)
          ];
        } else {
          spanProcessors = (0, utils_1.getSpanProcessorsFromEnv)(sdkMetricsEnabled ? this._meterProvider : void 0);
        }
        if (spanProcessors.length > 0) {
          this._tracerProvider = new sdk_trace_1.TracerProvider({
            sampler: this._configuration?.sampler ?? (0, create_from_env_1.createSamplerFromEnv)(),
            spanLimits: {
              ...(0, create_from_env_1.createSpanLimitsFromEnv)(),
              ...this._configuration?.spanLimits
            },
            resource: this._resource,
            meterProvider: sdkMetricsEnabled ? this._meterProvider : void 0,
            idGenerator: this._configuration?.idGenerator,
            spanProcessors
          });
          api_1.trace.setGlobalTracerProvider(this._tracerProvider);
        }
        if (!this._loggerProviderConfig) {
          this.configureLoggerProviderFromEnv(sdkMetricsEnabled ? this._meterProvider : void 0);
        }
        if (this._loggerProviderConfig) {
          const loggerProvider = new sdk_logs_1.LoggerProvider({
            ...(0, utils_1.getLoggerProviderConfigFromEnv)(),
            resource: this._resource,
            processors: this._loggerProviderConfig.logRecordProcessors,
            meterProvider: sdkMetricsEnabled ? this._meterProvider : void 0
          });
          this._loggerProvider = loggerProvider;
          api_logs_1.logs.setGlobalLoggerProvider(loggerProvider);
        }
      }
      shutdown() {
        const promises = [];
        if (this._tracerProvider) {
          promises.push(this._tracerProvider.shutdown());
        }
        if (this._loggerProvider) {
          promises.push(this._loggerProvider.shutdown());
        }
        if (this._meterProvider) {
          promises.push(this._meterProvider.shutdown());
        }
        return Promise.all(promises).then(() => {
        });
      }
      configureLoggerProviderFromEnv(meterProvider) {
        const enabledExporters = Array.from(new Set((0, core_1.getStringListFromEnv)("OTEL_LOGS_EXPORTER") ?? []));
        if (enabledExporters.length === 0) {
          api_1.diag.debug("OTEL_LOGS_EXPORTER is empty. Using default otlp exporter.");
          enabledExporters.push("otlp");
        }
        if (enabledExporters.includes("none")) {
          api_1.diag.info('OTEL_LOGS_EXPORTER contains "none". Logger provider will not be initialized.');
          return;
        }
        const exporters = [];
        enabledExporters.forEach((exporter) => {
          if (exporter === "otlp") {
            const protocol = ((0, core_1.getStringFromEnv)("OTEL_EXPORTER_OTLP_LOGS_PROTOCOL") ?? (0, core_1.getStringFromEnv)("OTEL_EXPORTER_OTLP_PROTOCOL"))?.trim() || "http/protobuf";
            switch (protocol) {
              case "grpc":
                exporters.push(new exporter_logs_otlp_grpc_1.OTLPLogExporter());
                break;
              case "http/json":
                exporters.push(new exporter_logs_otlp_http_1.OTLPLogExporter());
                break;
              case "http/protobuf":
                exporters.push(new exporter_logs_otlp_proto_1.OTLPLogExporter());
                break;
              default:
                api_1.diag.warn(`Unsupported OTLP logs protocol: "${protocol}". Using http/protobuf.`);
                exporters.push(new exporter_logs_otlp_proto_1.OTLPLogExporter());
            }
          } else if (exporter === "console") {
            exporters.push(new sdk_logs_1.ConsoleLogRecordExporter());
          } else {
            api_1.diag.warn(`Unsupported OTEL_LOGS_EXPORTER value: "${exporter}". Supported values are: otlp, console, none.`);
          }
        });
        if (exporters.length > 0) {
          this._loggerProviderConfig = {
            logRecordProcessors: exporters.map((exporter) => {
              if (exporter instanceof sdk_logs_1.ConsoleLogRecordExporter) {
                return new sdk_logs_1.SimpleLogRecordProcessor({
                  exporter,
                  selfObsMeterProvider: meterProvider
                });
              } else {
                return (0, utils_1.getBatchLogRecordProcessorFromEnv)(exporter, meterProvider);
              }
            })
          };
        }
      }
    };
    exports.NodeSDK = NodeSDK2;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-node/build/src/semconv.js
var require_semconv4 = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-node/build/src/semconv.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ATTR_SERVICE_NAMESPACE = exports.ATTR_SERVICE_INSTANCE_ID = exports.ATTR_PROCESS_PID = exports.ATTR_HOST_NAME = void 0;
    exports.ATTR_HOST_NAME = "host.name";
    exports.ATTR_PROCESS_PID = "process.pid";
    exports.ATTR_SERVICE_INSTANCE_ID = "service.instance.id";
    exports.ATTR_SERVICE_NAMESPACE = "service.namespace";
  }
});

// packages/core/node_modules/@opentelemetry/sdk-node/build/src/diag.js
var require_diag = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-node/build/src/diag.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.diagLogLevelFromSeverityNumberConfig = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    function diagLogLevelFromSeverityNumberConfig(sevNum = "info") {
      let level;
      switch (sevNum) {
        case "trace":
          level = api_1.DiagLogLevel.ALL;
          break;
        case "trace2":
        case "trace3":
        case "trace4":
          level = api_1.DiagLogLevel.VERBOSE;
          break;
        case "debug":
        case "debug2":
        case "debug3":
        case "debug4":
          level = api_1.DiagLogLevel.DEBUG;
          break;
        case "info":
        case "info2":
        case "info3":
        case "info4":
          level = api_1.DiagLogLevel.INFO;
          break;
        case "warn":
        case "warn2":
        case "warn3":
        case "warn4":
          level = api_1.DiagLogLevel.WARN;
          break;
        case "error":
        case "error2":
        case "error3":
        case "error4":
          level = api_1.DiagLogLevel.ERROR;
          break;
        case "fatal":
        case "fatal2":
        case "fatal3":
        case "fatal4":
          level = api_1.DiagLogLevel.NONE;
          break;
        default:
          throw new Error(`unexpected SeverityNumberConfigModel value: ${sevNum}`);
      }
      return level;
    }
    __name(diagLogLevelFromSeverityNumberConfig, "diagLogLevelFromSeverityNumberConfig");
    exports.diagLogLevelFromSeverityNumberConfig = diagLogLevelFromSeverityNumberConfig;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-node/build/src/create-from-config.js
var require_create_from_config = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-node/build/src/create-from-config.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createSpanLimitsFromConfig = exports.createLoggerProviderFromConfig = exports.createLogRecordProcessorFromConfig = exports.createLogRecordExporterFromConfig = exports.createLogRecordLimitsFromConfig = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var exporter_logs_otlp_http_1 = require_exporter_logs_otlp_http();
    var exporter_logs_otlp_grpc_1 = require_exporter_logs_otlp_grpc();
    var exporter_logs_otlp_proto_1 = require_exporter_logs_otlp_proto();
    var otlp_exporter_base_1 = require_otlp_exporter_base();
    var sdk_logs_1 = require_src6();
    var utils_1 = require_utils5();
    function checkConfigUse(name, props, handledProps) {
      if (!props)
        return;
      const unhandledProps = Object.keys(props).filter((k) => !handledProps.includes(k));
      if (unhandledProps.length > 0) {
        api_1.diag.warn(`Config warning: some specified ${name} configuration properties were not handled by SDK setup: ${JSON.stringify(unhandledProps)}`);
      }
    }
    __name(checkConfigUse, "checkConfigUse");
    function mustSingleEntry(configObj, configTypeName) {
      const entries = Object.entries(configObj).filter(([_name, properties]) => properties !== void 0);
      if (entries.length !== 1) {
        const entryNames = entries.map((e) => e[0]);
        throw Error(`invalid ${configTypeName} in configuration: must have exactly one entry: entries=${JSON.stringify(entryNames)}`);
      }
      return entries[0];
    }
    __name(mustSingleEntry, "mustSingleEntry");
    function createLogRecordLimitsFromConfig(limits, attribute_limits) {
      if (!limits && !attribute_limits) {
        return void 0;
      }
      return {
        attributeValueLengthLimit: limits?.attribute_value_length_limit ?? attribute_limits?.attribute_value_length_limit ?? void 0,
        attributeCountLimit: limits?.attribute_count_limit ?? attribute_limits?.attribute_count_limit ?? void 0
      };
    }
    __name(createLogRecordLimitsFromConfig, "createLogRecordLimitsFromConfig");
    exports.createLogRecordLimitsFromConfig = createLogRecordLimitsFromConfig;
    function createLogRecordExporterFromConfig(exporter) {
      const [name, properties] = mustSingleEntry(exporter, "LogRecordExporter");
      switch (name) {
        case "otlp_http": {
          checkConfigUse("LogRecordExporter", properties, [
            "compression",
            "endpoint",
            "headers",
            "timeout",
            "tls",
            "encoding"
          ]);
          const props = properties;
          const commonOpts = {
            compression: props?.compression === "gzip" ? otlp_exporter_base_1.CompressionAlgorithm.GZIP : otlp_exporter_base_1.CompressionAlgorithm.NONE,
            url: props?.endpoint ?? void 0,
            headers: (0, utils_1.getHeadersFromConfiguration)(props?.headers),
            timeoutMillis: (0, utils_1.validateExporterTimeout)(props?.timeout),
            httpAgentOptions: (0, utils_1.getHttpAgentOptionsFromTls)(props?.tls)
          };
          const encoding = props?.encoding ?? "protobuf";
          switch (encoding) {
            case "json":
              return new exporter_logs_otlp_http_1.OTLPLogExporter(commonOpts);
            case "protobuf":
              return new exporter_logs_otlp_proto_1.OTLPLogExporter(commonOpts);
            default:
              throw new Error(`unknown OtlpHttpExporter encoding in configuration: "${encoding}"`);
          }
        }
        case "otlp_grpc": {
          checkConfigUse("LogRecordExporter", properties, [
            "compression",
            "endpoint",
            "timeout",
            "tls",
            "headers"
          ]);
          const props = properties;
          return new exporter_logs_otlp_grpc_1.OTLPLogExporter({
            compression: props?.compression === "gzip" ? otlp_exporter_base_1.CompressionAlgorithm.GZIP : otlp_exporter_base_1.CompressionAlgorithm.NONE,
            url: props?.endpoint ?? void 0,
            timeoutMillis: (0, utils_1.validateExporterTimeout)(props?.timeout),
            credentials: (0, utils_1.getGrpcCredentialsFromTls)(props?.tls),
            metadata: (0, utils_1.getGrpcMetadataFromHeaders)(props?.headers)
          });
        }
        case "console":
          return new sdk_logs_1.ConsoleLogRecordExporter();
        default:
          throw new Error(`unknown LogRecordExporter name in configuration: "${name}"`);
      }
    }
    __name(createLogRecordExporterFromConfig, "createLogRecordExporterFromConfig");
    exports.createLogRecordExporterFromConfig = createLogRecordExporterFromConfig;
    function createLogRecordProcessorFromConfig(processor) {
      const [name, properties] = mustSingleEntry(processor, "LogRecordProcessor");
      switch (name) {
        case "batch": {
          checkConfigUse("BatchLogRecordProcessor", properties, [
            "exporter",
            "max_queue_size",
            "max_export_batch_size",
            "schedule_delay",
            "export_timeout"
          ]);
          const props = properties;
          const exporter = createLogRecordExporterFromConfig(props.exporter);
          return new sdk_logs_1.BatchLogRecordProcessor({
            exporter,
            maxQueueSize: props.max_queue_size ?? void 0,
            maxExportBatchSize: props.max_export_batch_size ?? void 0,
            scheduledDelayMillis: props.schedule_delay ?? void 0,
            exportTimeoutMillis: props.export_timeout ?? void 0
          });
        }
        case "simple": {
          const props = properties;
          const exporter = createLogRecordExporterFromConfig(props.exporter);
          return new sdk_logs_1.SimpleLogRecordProcessor({ exporter });
        }
        default:
          throw new Error(`unknown LogRecordProcessor name: "${name}"`);
      }
    }
    __name(createLogRecordProcessorFromConfig, "createLogRecordProcessorFromConfig");
    exports.createLogRecordProcessorFromConfig = createLogRecordProcessorFromConfig;
    function createLoggerProviderFromConfig(resource, logger_provider, attribute_limits) {
      const processors = logger_provider.processors.map((p) => createLogRecordProcessorFromConfig(p));
      const logRecordLimits = createLogRecordLimitsFromConfig(logger_provider.limits, attribute_limits);
      checkConfigUse("LoggerProvider", logger_provider, ["processors", "limits"]);
      return new sdk_logs_1.LoggerProvider({
        resource,
        processors,
        logRecordLimits
        // TODO: loggerConfigurator
        // TODO: meterProvider
        // Note: forceFlushTimeoutMillis not configurable via decl conf.
      });
    }
    __name(createLoggerProviderFromConfig, "createLoggerProviderFromConfig");
    exports.createLoggerProviderFromConfig = createLoggerProviderFromConfig;
    function createSpanLimitsFromConfig(limits, attribute_limits) {
      if (!limits && !attribute_limits) {
        return void 0;
      }
      return {
        attributeValueLengthLimit: limits?.attribute_value_length_limit ?? attribute_limits?.attribute_value_length_limit ?? void 0,
        attributeCountLimit: limits?.attribute_count_limit ?? attribute_limits?.attribute_count_limit ?? void 0,
        eventCountLimit: limits?.event_count_limit ?? void 0,
        linkCountLimit: limits?.link_count_limit ?? void 0,
        attributePerEventCountLimit: limits?.event_attribute_count_limit ?? void 0,
        attributePerLinkCountLimit: limits?.link_attribute_count_limit ?? void 0
      };
    }
    __name(createSpanLimitsFromConfig, "createSpanLimitsFromConfig");
    exports.createSpanLimitsFromConfig = createSpanLimitsFromConfig;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-node/build/src/start.js
var require_start = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-node/build/src/start.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.setupResource = exports.startNodeSDK = exports.NOOP_SDK = void 0;
    var configuration_1 = require_configuration();
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var utils_1 = require_utils5();
    var instrumentation_1 = require_src11();
    var sdk_metrics_1 = require_src5();
    var sdk_trace_1 = require_src9();
    var api_logs_1 = require_src2();
    var resources_1 = require_src4();
    var context_async_hooks_1 = require_src7();
    var semconv_1 = require_semconv4();
    var diag_1 = require_diag();
    var create_from_config_1 = require_create_from_config();
    exports.NOOP_SDK = {
      shutdown: /* @__PURE__ */ __name(async () => {
      }, "shutdown")
    };
    function startNodeSDK(sdkOptions) {
      let config;
      try {
        const configFactory = (0, configuration_1.createConfigFactory)();
        config = configFactory.getConfigModel();
      } catch (configErr) {
        const logLevel2 = (0, diag_1.diagLogLevelFromSeverityNumberConfig)();
        api_1.diag.setLogger(new api_1.DiagConsoleLogger(), { logLevel: logLevel2 });
        api_1.diag.error(`Could not load OpenTelemetry configuration, SDK will not be setup: ${configErr.message}`);
        return exports.NOOP_SDK;
      }
      if (config.disabled) {
        return exports.NOOP_SDK;
      }
      const logLevel = (0, diag_1.diagLogLevelFromSeverityNumberConfig)(config.log_level);
      api_1.diag.setLogger(new api_1.DiagConsoleLogger(), { logLevel });
      (0, instrumentation_1.registerInstrumentations)({
        instrumentations: sdkOptions?.instrumentations?.flat() ?? []
      });
      let components;
      try {
        components = create(config, sdkOptions);
      } catch (createErr) {
        api_1.diag.error(`Could not create OpenTelemetry SDK: ${createErr.message}`);
        return exports.NOOP_SDK;
      }
      if (components.contextManager) {
        api_1.context.setGlobalContextManager(components.contextManager);
      }
      if (components.loggerProvider) {
        api_logs_1.logs.setGlobalLoggerProvider(components.loggerProvider);
      }
      if (components.meterProvider) {
        api_1.metrics.setGlobalMeterProvider(components.meterProvider);
      }
      if (components.tracerProvider) {
        api_1.trace.setGlobalTracerProvider(components.tracerProvider);
      }
      if (components.propagator) {
        api_1.propagation.setGlobalPropagator(components.propagator);
      }
      const shutdownFn = /* @__PURE__ */ __name(async () => {
        const promises = [];
        if (components.loggerProvider) {
          promises.push(components.loggerProvider.shutdown());
        }
        if (components.meterProvider) {
          promises.push(components.meterProvider.shutdown());
        }
        if (components.tracerProvider) {
          promises.push(components.tracerProvider.shutdown());
        }
        await Promise.all(promises);
      }, "shutdownFn");
      return { shutdown: shutdownFn };
    }
    __name(startNodeSDK, "startNodeSDK");
    exports.startNodeSDK = startNodeSDK;
    function create(config, sdkOptions) {
      const components = {};
      try {
        components.contextManager = new context_async_hooks_1.AsyncLocalStorageContextManager();
        components.contextManager.enable();
        const resource = setupResource(config, sdkOptions);
        const propagator = sdkOptions?.textMapPropagator === null ? null : sdkOptions?.textMapPropagator ?? (0, utils_1.getPropagatorFromConfiguration)(config);
        if (propagator) {
          components.propagator = propagator;
        }
        if (config.logger_provider) {
          components.loggerProvider = (0, create_from_config_1.createLoggerProviderFromConfig)(resource, config.logger_provider, config.attribute_limits);
        }
        const meterReaders = (0, utils_1.getMeterReadersFromConfiguration)(config);
        if (meterReaders) {
          const meterViews = (0, utils_1.getMeterViewsFromConfiguration)(config);
          const meterProvider = new sdk_metrics_1.MeterProvider({
            resource,
            readers: meterReaders,
            views: meterViews ?? []
          });
          components.meterProvider = meterProvider;
        }
        const spanProcessors = (0, utils_1.getSpanProcessorsFromConfiguration)(config);
        if (spanProcessors) {
          const idGenerator = (0, utils_1.getIdGeneratorFromConfiguration)(config);
          const sampler = (0, utils_1.getSamplerFromConfiguration)(config);
          const tracerProvider = new sdk_trace_1.TracerProvider({
            resource,
            spanProcessors,
            idGenerator,
            sampler,
            spanLimits: (0, create_from_config_1.createSpanLimitsFromConfig)(config.tracer_provider?.limits, config.attribute_limits)
            // TODO (6624): support for `meterProvider: components.meterProvider`
          });
          components.tracerProvider = tracerProvider;
        }
        return components;
      } catch (createErr) {
        if (components.loggerProvider) {
          void components.loggerProvider.shutdown();
        }
        if (components.meterProvider) {
          void components.meterProvider.shutdown();
        }
        if (components.tracerProvider) {
          void components.tracerProvider.shutdown();
        }
        throw createErr;
      }
    }
    __name(create, "create");
    function setupResource(config, sdkOptions) {
      let resource = (0, utils_1.getResourceFromConfiguration)(config) ?? (0, resources_1.defaultResource)();
      let resourceDetectors = [];
      if (sdkOptions?.resourceDetectors != null) {
        resourceDetectors = sdkOptions.resourceDetectors;
      } else if (config.resource?.["detection/development"]?.detectors) {
        resourceDetectors = (0, utils_1.getResourceDetectorsFromConfiguration)(config);
      }
      if (resourceDetectors.length > 0) {
        const internalConfig = {
          detectors: resourceDetectors
        };
        resource = resource.merge((0, resources_1.detectResources)(internalConfig));
      }
      const instanceId = (0, utils_1.getInstanceID)(config);
      resource = instanceId === void 0 ? resource : resource.merge((0, resources_1.resourceFromAttributes)({
        [semconv_1.ATTR_SERVICE_INSTANCE_ID]: instanceId
      }));
      return resource;
    }
    __name(setupResource, "setupResource");
    exports.setupResource = setupResource;
  }
});

// packages/core/node_modules/@opentelemetry/sdk-node/build/src/index.js
var require_src14 = __commonJS({
  "packages/core/node_modules/@opentelemetry/sdk-node/build/src/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.startNodeSDK = exports.NodeSDK = exports.tracing = exports.node = exports.resources = exports.metrics = exports.logs = exports.core = exports.contextBase = exports.api = void 0;
    exports.api = (init_esm(), __toCommonJS(esm_exports));
    exports.contextBase = (init_esm(), __toCommonJS(esm_exports));
    exports.core = require_src3();
    exports.logs = require_src6();
    exports.metrics = require_src5();
    exports.resources = require_src4();
    exports.node = require_src10();
    exports.tracing = require_index_shim();
    var sdk_1 = require_sdk();
    Object.defineProperty(exports, "NodeSDK", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return sdk_1.NodeSDK;
    }, "get") });
    var start_1 = require_start();
    Object.defineProperty(exports, "startNodeSDK", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return start_1.startNodeSDK;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation-http/build/src/version.js
var require_version3 = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation-http/build/src/version.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.VERSION = void 0;
    exports.VERSION = "0.221.0";
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation-http/build/src/semconv.js
var require_semconv5 = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation-http/build/src/semconv.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.USER_AGENT_SYNTHETIC_TYPE_VALUE_TEST = exports.USER_AGENT_SYNTHETIC_TYPE_VALUE_BOT = exports.ATTR_USER_AGENT_SYNTHETIC_TYPE = void 0;
    exports.ATTR_USER_AGENT_SYNTHETIC_TYPE = "user_agent.synthetic.type";
    exports.USER_AGENT_SYNTHETIC_TYPE_VALUE_BOT = "bot";
    exports.USER_AGENT_SYNTHETIC_TYPE_VALUE_TEST = "test";
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation-http/build/src/internal-types.js
var require_internal_types = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation-http/build/src/internal-types.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DEFAULT_QUERY_STRINGS_TO_REDACT = exports.STR_REDACTED = exports.SYNTHETIC_BOT_NAMES = exports.SYNTHETIC_TEST_NAMES = void 0;
    exports.SYNTHETIC_TEST_NAMES = ["alwayson"];
    exports.SYNTHETIC_BOT_NAMES = ["googlebot", "bingbot"];
    exports.STR_REDACTED = "REDACTED";
    exports.DEFAULT_QUERY_STRINGS_TO_REDACT = [
      "sig",
      "Signature",
      "AWSAccessKeyId",
      "X-Goog-Signature"
    ];
  }
});

// node_modules/forwarded-parse/lib/error.js
var require_error = __commonJS({
  "node_modules/forwarded-parse/lib/error.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var util = __require("util");
    function ParseError(message, input) {
      Error.captureStackTrace(this, ParseError);
      this.name = this.constructor.name;
      this.message = message;
      this.input = input;
    }
    __name(ParseError, "ParseError");
    util.inherits(ParseError, Error);
    module.exports = ParseError;
  }
});

// node_modules/forwarded-parse/lib/ascii.js
var require_ascii = __commonJS({
  "node_modules/forwarded-parse/lib/ascii.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    function isDelimiter(code) {
      return code === 34 || code === 40 || code === 41 || code === 44 || code === 47 || code >= 58 && code <= 64 || code >= 91 && code <= 93 || code === 123 || code === 125;
    }
    __name(isDelimiter, "isDelimiter");
    function isTokenChar(code) {
      return code === 33 || code >= 35 && code <= 39 || code === 42 || code === 43 || code === 45 || code === 46 || code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 94 && code <= 122 || code === 124 || code === 126;
    }
    __name(isTokenChar, "isTokenChar");
    function isPrint(code) {
      return code >= 32 && code <= 126;
    }
    __name(isPrint, "isPrint");
    function isExtended(code) {
      return code >= 128 && code <= 255;
    }
    __name(isExtended, "isExtended");
    module.exports = {
      isDelimiter,
      isTokenChar,
      isExtended,
      isPrint
    };
  }
});

// node_modules/forwarded-parse/index.js
var require_forwarded_parse = __commonJS({
  "node_modules/forwarded-parse/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var util = __require("util");
    var ParseError = require_error();
    var ascii = require_ascii();
    var isDelimiter = ascii.isDelimiter;
    var isTokenChar = ascii.isTokenChar;
    var isExtended = ascii.isExtended;
    var isPrint = ascii.isPrint;
    function decode(str) {
      return str.replace(/\\(.)/g, "$1");
    }
    __name(decode, "decode");
    function unexpectedCharacterMessage(header, position) {
      return util.format(
        "Unexpected character '%s' at index %d",
        header.charAt(position),
        position
      );
    }
    __name(unexpectedCharacterMessage, "unexpectedCharacterMessage");
    function parse(header) {
      var mustUnescape = false;
      var isEscaping = false;
      var inQuotes = false;
      var forwarded = {};
      var output = [];
      var start = -1;
      var end = -1;
      var parameter;
      var code;
      for (var i = 0; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (parameter === void 0) {
          if (i !== 0 && start === -1 && (code === 32 || code === 9)) {
            continue;
          }
          if (isTokenChar(code)) {
            if (start === -1) start = i;
          } else if (code === 61 && start !== -1) {
            parameter = header.slice(start, i).toLowerCase();
            start = -1;
          } else {
            throw new ParseError(unexpectedCharacterMessage(header, i), header);
          }
        } else {
          if (isEscaping && (code === 9 || isPrint(code) || isExtended(code))) {
            isEscaping = false;
          } else if (isTokenChar(code)) {
            if (end !== -1) {
              throw new ParseError(unexpectedCharacterMessage(header, i), header);
            }
            if (start === -1) start = i;
          } else if (isDelimiter(code) || isExtended(code)) {
            if (inQuotes) {
              if (code === 34) {
                inQuotes = false;
                end = i;
              } else if (code === 92) {
                if (start === -1) start = i;
                isEscaping = mustUnescape = true;
              } else if (start === -1) {
                start = i;
              }
            } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
              inQuotes = true;
            } else if ((code === 44 || code === 59) && (start !== -1 || end !== -1)) {
              if (start !== -1) {
                if (end === -1) end = i;
                forwarded[parameter] = mustUnescape ? decode(header.slice(start, end)) : header.slice(start, end);
              } else {
                forwarded[parameter] = "";
              }
              if (code === 44) {
                output.push(forwarded);
                forwarded = {};
              }
              parameter = void 0;
              start = end = -1;
            } else {
              throw new ParseError(unexpectedCharacterMessage(header, i), header);
            }
          } else if (code === 32 || code === 9) {
            if (end !== -1) continue;
            if (inQuotes) {
              if (start === -1) start = i;
            } else if (start !== -1) {
              end = i;
            } else {
              throw new ParseError(unexpectedCharacterMessage(header, i), header);
            }
          } else {
            throw new ParseError(unexpectedCharacterMessage(header, i), header);
          }
        }
      }
      if (parameter === void 0 || inQuotes || start === -1 && end === -1 || code === 32 || code === 9) {
        throw new ParseError("Unexpected end of input", header);
      }
      if (start !== -1) {
        if (end === -1) end = i;
        forwarded[parameter] = mustUnescape ? decode(header.slice(start, end)) : header.slice(start, end);
      } else {
        forwarded[parameter] = "";
      }
      output.push(forwarded);
      return output;
    }
    __name(parse, "parse");
    module.exports = parse;
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation-http/build/src/utils.js
var require_utils6 = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation-http/build/src/utils.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.headerCapture = exports.getIncomingStableRequestMetricAttributesOnResponse = exports.getIncomingRequestAttributesOnResponse = exports.getIncomingRequestAttributes = exports.getRemoteClientAddress = exports.getOutgoingStableRequestMetricAttributesOnResponse = exports.getOutgoingRequestAttributesOnResponse = exports.getOutgoingRequestAttributes = exports.extractHostnameAndPort = exports.isValidOptionsType = exports.getRequestInfo = exports.isCompressed = exports.setSpanWithError = exports.satisfiesPattern = exports.parseResponseStatus = exports.getAbsoluteUrl = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var semantic_conventions_1 = (init_esm2(), __toCommonJS(esm_exports2));
    var semconv_1 = require_semconv5();
    var core_1 = require_src3();
    var url = __require("url");
    var internal_types_1 = require_internal_types();
    var internal_types_2 = require_internal_types();
    var forwardedParse = require_forwarded_parse();
    var getAbsoluteUrl = /* @__PURE__ */ __name((requestUrl, headers, fallbackProtocol = "http:", redactedQueryParams = Array.from(internal_types_2.DEFAULT_QUERY_STRINGS_TO_REDACT)) => {
      const reqUrlObject = requestUrl || {};
      const protocol = reqUrlObject.protocol || fallbackProtocol;
      const port = (reqUrlObject.port || "").toString();
      let path2 = reqUrlObject.path || "/";
      let host = reqUrlObject.host || reqUrlObject.hostname || headers.host || "localhost";
      if (host.indexOf(":") === -1 && port && port !== "80" && port !== "443") {
        host += `:${port}`;
      }
      if (path2.includes("?")) {
        try {
          const parsedUrl = new URL(path2, "http://localhost");
          const sensitiveParamsToRedact = redactedQueryParams || [];
          for (const sensitiveParam of sensitiveParamsToRedact) {
            if (parsedUrl.searchParams.get(sensitiveParam)) {
              parsedUrl.searchParams.set(sensitiveParam, internal_types_2.STR_REDACTED);
            }
          }
          path2 = `${parsedUrl.pathname}${parsedUrl.search}`;
        } catch {
        }
      }
      const authPart = reqUrlObject.auth ? `${internal_types_2.STR_REDACTED}:${internal_types_2.STR_REDACTED}@` : "";
      return `${protocol}//${authPart}${host}${path2}`;
    }, "getAbsoluteUrl");
    exports.getAbsoluteUrl = getAbsoluteUrl;
    var parseResponseStatus = /* @__PURE__ */ __name((kind, statusCode) => {
      const upperBound = kind === api_1.SpanKind.CLIENT ? 400 : 500;
      if (statusCode && statusCode >= 100 && statusCode < upperBound) {
        return api_1.SpanStatusCode.UNSET;
      }
      return api_1.SpanStatusCode.ERROR;
    }, "parseResponseStatus");
    exports.parseResponseStatus = parseResponseStatus;
    var satisfiesPattern = /* @__PURE__ */ __name((constant, pattern) => {
      if (typeof pattern === "string") {
        return pattern === constant;
      } else if (pattern instanceof RegExp) {
        return pattern.test(constant);
      } else if (typeof pattern === "function") {
        return pattern(constant);
      } else {
        throw new TypeError("Pattern is in unsupported datatype");
      }
    }, "satisfiesPattern");
    exports.satisfiesPattern = satisfiesPattern;
    var setSpanWithError = /* @__PURE__ */ __name((span, error) => {
      const message = error.message;
      span.setAttribute(semantic_conventions_1.ATTR_ERROR_TYPE, error.name);
      span.setStatus({ code: api_1.SpanStatusCode.ERROR, message });
      span.recordException(error);
    }, "setSpanWithError");
    exports.setSpanWithError = setSpanWithError;
    var isCompressed = /* @__PURE__ */ __name((headers) => {
      const encoding = headers["content-encoding"];
      return !!encoding && encoding !== "identity";
    }, "isCompressed");
    exports.isCompressed = isCompressed;
    function stringUrlToHttpOptions(stringUrl) {
      const { hostname, pathname, port, username, password, search, protocol, hash, href, origin, host } = new URL(stringUrl);
      const options = {
        protocol,
        hostname: hostname && hostname[0] === "[" ? hostname.slice(1, -1) : hostname,
        hash,
        search,
        pathname,
        path: `${pathname || ""}${search || ""}`,
        href,
        origin,
        host
      };
      if (port !== "") {
        options.port = Number(port);
      }
      if (username || password) {
        options.auth = `${decodeURIComponent(username)}:${decodeURIComponent(password)}`;
      }
      return options;
    }
    __name(stringUrlToHttpOptions, "stringUrlToHttpOptions");
    var getRequestInfo = /* @__PURE__ */ __name((logger, options, extraOptions) => {
      let pathname;
      let origin;
      let optionsParsed;
      let invalidUrl = false;
      if (typeof options === "string") {
        try {
          const convertedOptions = stringUrlToHttpOptions(options);
          optionsParsed = convertedOptions;
          pathname = convertedOptions.pathname || "/";
        } catch (e) {
          invalidUrl = true;
          logger.verbose("Unable to parse URL provided to HTTP request, using fallback to determine path. Original error:", e);
          optionsParsed = {
            path: options
          };
          pathname = optionsParsed.path || "/";
        }
        origin = `${optionsParsed.protocol || "http:"}//${optionsParsed.host}`;
        if (extraOptions !== void 0) {
          Object.assign(optionsParsed, extraOptions);
        }
      } else if (options instanceof url.URL) {
        optionsParsed = {
          protocol: options.protocol,
          hostname: typeof options.hostname === "string" && options.hostname.startsWith("[") ? options.hostname.slice(1, -1) : options.hostname,
          path: `${options.pathname || ""}${options.search || ""}`
        };
        if (options.port !== "") {
          optionsParsed.port = Number(options.port);
        }
        if (options.username || options.password) {
          optionsParsed.auth = `${options.username}:${options.password}`;
        }
        pathname = options.pathname;
        origin = options.origin;
        if (extraOptions !== void 0) {
          Object.assign(optionsParsed, extraOptions);
        }
      } else {
        optionsParsed = Object.assign({ protocol: options.host ? "http:" : void 0 }, options);
        const hostname = optionsParsed.host || (optionsParsed.port != null ? `${optionsParsed.hostname}${optionsParsed.port}` : optionsParsed.hostname);
        origin = `${optionsParsed.protocol || "http:"}//${hostname}`;
        pathname = options.pathname;
        if (!pathname && optionsParsed.path) {
          try {
            const parsedUrl = new URL(optionsParsed.path, origin);
            pathname = parsedUrl.pathname || "/";
          } catch {
            pathname = "/";
          }
        }
      }
      const method = optionsParsed.method ? optionsParsed.method.toUpperCase() : "GET";
      return { origin, pathname, method, optionsParsed, invalidUrl };
    }, "getRequestInfo");
    exports.getRequestInfo = getRequestInfo;
    var isValidOptionsType = /* @__PURE__ */ __name((options) => {
      if (!options) {
        return false;
      }
      const type = typeof options;
      return type === "string" || type === "object" && !Array.isArray(options);
    }, "isValidOptionsType");
    exports.isValidOptionsType = isValidOptionsType;
    var extractHostnameAndPort = /* @__PURE__ */ __name((requestOptions) => {
      if (requestOptions.hostname && requestOptions.port) {
        return { hostname: requestOptions.hostname, port: requestOptions.port };
      }
      const matches = requestOptions.host?.match(/^([^:/ ]+)(:\d{1,5})?/) || null;
      const hostname = requestOptions.hostname || (matches === null ? "localhost" : matches[1]);
      let port = requestOptions.port;
      if (!port) {
        if (matches && matches[2]) {
          port = matches[2].substring(1);
        } else {
          port = requestOptions.protocol === "https:" ? "443" : "80";
        }
      }
      return { hostname, port };
    }, "extractHostnameAndPort");
    exports.extractHostnameAndPort = extractHostnameAndPort;
    var getOutgoingRequestAttributes = /* @__PURE__ */ __name((requestOptions, options, enableSyntheticSourceDetection) => {
      const hostname = options.hostname;
      const port = options.port;
      const method = requestOptions.method ?? "GET";
      const normalizedMethod = normalizeMethod(method);
      const headers = requestOptions.headers || {};
      const userAgent = headers["user-agent"];
      const urlFull = (0, exports.getAbsoluteUrl)(requestOptions, headers, `${options.component}:`, options.redactedQueryParams);
      const attributes = {
        // Required attributes
        [semantic_conventions_1.ATTR_HTTP_REQUEST_METHOD]: normalizedMethod,
        [semantic_conventions_1.ATTR_SERVER_ADDRESS]: hostname,
        [semantic_conventions_1.ATTR_SERVER_PORT]: Number(port),
        [semantic_conventions_1.ATTR_URL_FULL]: urlFull,
        [semantic_conventions_1.ATTR_USER_AGENT_ORIGINAL]: userAgent
        // leaving out protocol version, it is not yet negotiated
        // leaving out protocol name, it is only required when protocol version is set
        // retries and redirects not supported
        // Opt-in attributes left off for now
      };
      if (method !== normalizedMethod) {
        attributes[semantic_conventions_1.ATTR_HTTP_REQUEST_METHOD_ORIGINAL] = method;
      }
      if (enableSyntheticSourceDetection && userAgent) {
        attributes[semconv_1.ATTR_USER_AGENT_SYNTHETIC_TYPE] = getSyntheticType(userAgent);
      }
      return Object.assign(attributes, options.hookAttributes);
    }, "getOutgoingRequestAttributes");
    exports.getOutgoingRequestAttributes = getOutgoingRequestAttributes;
    var getSyntheticType = /* @__PURE__ */ __name((userAgent) => {
      const userAgentString = String(userAgent).toLowerCase();
      for (const name of internal_types_1.SYNTHETIC_TEST_NAMES) {
        if (userAgentString.includes(name)) {
          return semconv_1.USER_AGENT_SYNTHETIC_TYPE_VALUE_TEST;
        }
      }
      for (const name of internal_types_1.SYNTHETIC_BOT_NAMES) {
        if (userAgentString.includes(name)) {
          return semconv_1.USER_AGENT_SYNTHETIC_TYPE_VALUE_BOT;
        }
      }
      return;
    }, "getSyntheticType");
    var getOutgoingRequestAttributesOnResponse = /* @__PURE__ */ __name((response) => {
      const { statusCode, socket } = response;
      const attributes = {};
      if (statusCode != null) {
        attributes[semantic_conventions_1.ATTR_HTTP_RESPONSE_STATUS_CODE] = statusCode;
      }
      if (socket) {
        const { remoteAddress, remotePort } = socket;
        attributes[semantic_conventions_1.ATTR_NETWORK_PEER_ADDRESS] = remoteAddress;
        attributes[semantic_conventions_1.ATTR_NETWORK_PEER_PORT] = remotePort;
        attributes[semantic_conventions_1.ATTR_NETWORK_PROTOCOL_VERSION] = response.httpVersion;
      }
      return attributes;
    }, "getOutgoingRequestAttributesOnResponse");
    exports.getOutgoingRequestAttributesOnResponse = getOutgoingRequestAttributesOnResponse;
    var getOutgoingStableRequestMetricAttributesOnResponse = /* @__PURE__ */ __name((spanAttributes) => {
      const metricAttributes = {};
      if (spanAttributes[semantic_conventions_1.ATTR_NETWORK_PROTOCOL_VERSION]) {
        metricAttributes[semantic_conventions_1.ATTR_NETWORK_PROTOCOL_VERSION] = spanAttributes[semantic_conventions_1.ATTR_NETWORK_PROTOCOL_VERSION];
      }
      const statusCode = spanAttributes[semantic_conventions_1.ATTR_HTTP_RESPONSE_STATUS_CODE];
      if (statusCode) {
        metricAttributes[semantic_conventions_1.ATTR_HTTP_RESPONSE_STATUS_CODE] = statusCode;
        if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 600) {
          metricAttributes[semantic_conventions_1.ATTR_ERROR_TYPE] ??= String(statusCode);
        }
      }
      return metricAttributes;
    }, "getOutgoingStableRequestMetricAttributesOnResponse");
    exports.getOutgoingStableRequestMetricAttributesOnResponse = getOutgoingStableRequestMetricAttributesOnResponse;
    function parseHostHeader(hostHeader, proto) {
      const parts = hostHeader.split(":");
      if (parts.length === 1) {
        if (proto === "http") {
          return { host: parts[0], port: "80" };
        }
        if (proto === "https") {
          return { host: parts[0], port: "443" };
        }
        return { host: parts[0] };
      }
      if (parts.length === 2) {
        return {
          host: parts[0],
          port: parts[1]
        };
      }
      if (parts[0].startsWith("[")) {
        if (parts[parts.length - 1].endsWith("]")) {
          if (proto === "http") {
            return { host: hostHeader, port: "80" };
          }
          if (proto === "https") {
            return { host: hostHeader, port: "443" };
          }
        } else if (parts[parts.length - 2].endsWith("]")) {
          return {
            host: parts.slice(0, -1).join(":"),
            port: parts[parts.length - 1]
          };
        }
      }
      return { host: hostHeader };
    }
    __name(parseHostHeader, "parseHostHeader");
    function getServerAddress(request, component) {
      const forwardedHeader = request.headers["forwarded"];
      if (forwardedHeader) {
        for (const entry of parseForwardedHeader(forwardedHeader)) {
          if (entry.host) {
            return parseHostHeader(entry.host, entry.proto);
          }
        }
      }
      const xForwardedHost = request.headers["x-forwarded-host"];
      if (typeof xForwardedHost === "string") {
        if (typeof request.headers["x-forwarded-proto"] === "string") {
          return parseHostHeader(xForwardedHost, request.headers["x-forwarded-proto"]);
        }
        if (Array.isArray(request.headers["x-forwarded-proto"])) {
          return parseHostHeader(xForwardedHost, request.headers["x-forwarded-proto"][0]);
        }
        return parseHostHeader(xForwardedHost);
      } else if (Array.isArray(xForwardedHost) && typeof xForwardedHost[0] === "string" && xForwardedHost[0].length > 0) {
        if (typeof request.headers["x-forwarded-proto"] === "string") {
          return parseHostHeader(xForwardedHost[0], request.headers["x-forwarded-proto"]);
        }
        if (Array.isArray(request.headers["x-forwarded-proto"])) {
          return parseHostHeader(xForwardedHost[0], request.headers["x-forwarded-proto"][0]);
        }
        return parseHostHeader(xForwardedHost[0]);
      }
      const host = request.headers["host"];
      if (typeof host === "string" && host.length > 0) {
        return parseHostHeader(host, component);
      }
      return null;
    }
    __name(getServerAddress, "getServerAddress");
    function getRemoteClientAddress(request) {
      const forwardedHeader = request.headers["forwarded"];
      if (forwardedHeader) {
        for (const entry of parseForwardedHeader(forwardedHeader)) {
          if (entry.for) {
            return removePortFromAddress(entry.for);
          }
        }
      }
      const xForwardedFor = request.headers["x-forwarded-for"];
      if (xForwardedFor) {
        let xForwardedForVal;
        if (typeof xForwardedFor === "string") {
          xForwardedForVal = xForwardedFor;
        } else if (Array.isArray(xForwardedFor)) {
          xForwardedForVal = xForwardedFor[0];
        }
        if (typeof xForwardedForVal === "string") {
          xForwardedForVal = xForwardedForVal.split(",")[0].trim();
          return removePortFromAddress(xForwardedForVal);
        }
      }
      const remote = request.socket.remoteAddress;
      if (remote) {
        return remote;
      }
      return null;
    }
    __name(getRemoteClientAddress, "getRemoteClientAddress");
    exports.getRemoteClientAddress = getRemoteClientAddress;
    function removePortFromAddress(input) {
      try {
        const { hostname: address } = new URL(`http://${input}`);
        if (address.startsWith("[") && address.endsWith("]")) {
          return address.slice(1, -1);
        }
        return address;
      } catch {
        return input;
      }
    }
    __name(removePortFromAddress, "removePortFromAddress");
    function getInfoFromIncomingMessage(component, request, logger) {
      try {
        if (request.headers.host) {
          return new URL(request.url ?? "/", `${component}://${request.headers.host}`);
        } else {
          const unsafeParsedUrl = new URL(
            request.url ?? "/",
            // using localhost as a workaround to still use the URL constructor for parsing
            `${component}://localhost`
          );
          return {
            pathname: unsafeParsedUrl.pathname,
            search: unsafeParsedUrl.search,
            toString: /* @__PURE__ */ __name(function() {
              return unsafeParsedUrl.pathname + unsafeParsedUrl.search;
            }, "toString")
          };
        }
      } catch (e) {
        logger.verbose("Unable to get URL from request", e);
        return {};
      }
    }
    __name(getInfoFromIncomingMessage, "getInfoFromIncomingMessage");
    var getIncomingRequestAttributes = /* @__PURE__ */ __name((request, options, logger) => {
      const { component, enableSyntheticSourceDetection, hookAttributes } = options;
      const { headers, method } = request;
      const { "user-agent": userAgent } = headers;
      const parsedUrl = getInfoFromIncomingMessage(component, request, logger);
      const normalizedMethod = normalizeMethod(method);
      const serverAddress = getServerAddress(request, component);
      const remoteClientAddress = getRemoteClientAddress(request);
      const attributes = {
        [semantic_conventions_1.ATTR_HTTP_REQUEST_METHOD]: normalizedMethod,
        [semantic_conventions_1.ATTR_URL_SCHEME]: component,
        [semantic_conventions_1.ATTR_SERVER_ADDRESS]: serverAddress?.host,
        [semantic_conventions_1.ATTR_NETWORK_PEER_ADDRESS]: request.socket.remoteAddress,
        [semantic_conventions_1.ATTR_NETWORK_PEER_PORT]: request.socket.remotePort,
        [semantic_conventions_1.ATTR_NETWORK_PROTOCOL_VERSION]: request.httpVersion,
        [semantic_conventions_1.ATTR_USER_AGENT_ORIGINAL]: userAgent
      };
      if (parsedUrl.pathname != null) {
        attributes[semantic_conventions_1.ATTR_URL_PATH] = parsedUrl.pathname;
      }
      if (parsedUrl.search) {
        attributes[semantic_conventions_1.ATTR_URL_QUERY] = parsedUrl.search.slice(1);
      }
      if (remoteClientAddress != null) {
        attributes[semantic_conventions_1.ATTR_CLIENT_ADDRESS] = remoteClientAddress;
      }
      if (serverAddress?.port != null) {
        attributes[semantic_conventions_1.ATTR_SERVER_PORT] = Number(serverAddress.port);
      }
      if (method !== normalizedMethod) {
        attributes[semantic_conventions_1.ATTR_HTTP_REQUEST_METHOD_ORIGINAL] = method;
      }
      if (enableSyntheticSourceDetection && userAgent) {
        attributes[semconv_1.ATTR_USER_AGENT_SYNTHETIC_TYPE] = getSyntheticType(userAgent);
      }
      return Object.assign(attributes, hookAttributes);
    }, "getIncomingRequestAttributes");
    exports.getIncomingRequestAttributes = getIncomingRequestAttributes;
    var getIncomingRequestAttributesOnResponse = /* @__PURE__ */ __name((response) => {
      const { statusCode } = response;
      const attributes = {
        [semantic_conventions_1.ATTR_HTTP_RESPONSE_STATUS_CODE]: statusCode
      };
      const rpcMetadata = (0, core_1.getRPCMetadata)(api_1.context.active());
      if (rpcMetadata?.type === core_1.RPCType.HTTP && rpcMetadata.route !== void 0) {
        attributes[semantic_conventions_1.ATTR_HTTP_ROUTE] = rpcMetadata.route;
      }
      return attributes;
    }, "getIncomingRequestAttributesOnResponse");
    exports.getIncomingRequestAttributesOnResponse = getIncomingRequestAttributesOnResponse;
    var getIncomingStableRequestMetricAttributesOnResponse = /* @__PURE__ */ __name((spanAttributes) => {
      const metricAttributes = {};
      if (spanAttributes[semantic_conventions_1.ATTR_HTTP_ROUTE] !== void 0) {
        metricAttributes[semantic_conventions_1.ATTR_HTTP_ROUTE] = spanAttributes[semantic_conventions_1.ATTR_HTTP_ROUTE];
      }
      const statusCode = spanAttributes[semantic_conventions_1.ATTR_HTTP_RESPONSE_STATUS_CODE];
      if (statusCode) {
        metricAttributes[semantic_conventions_1.ATTR_HTTP_RESPONSE_STATUS_CODE] = statusCode;
        if (typeof statusCode === "number" && statusCode >= 500 && statusCode < 600) {
          metricAttributes[semantic_conventions_1.ATTR_ERROR_TYPE] ??= String(statusCode);
        }
      }
      return metricAttributes;
    }, "getIncomingStableRequestMetricAttributesOnResponse");
    exports.getIncomingStableRequestMetricAttributesOnResponse = getIncomingStableRequestMetricAttributesOnResponse;
    function headerCapture(type, headers) {
      const normalizedHeaders = /* @__PURE__ */ new Map();
      for (let i = 0, len = headers.length; i < len; i++) {
        const capturedHeader = headers[i].toLowerCase();
        normalizedHeaders.set(capturedHeader, capturedHeader);
      }
      return (getHeader) => {
        const attributes = {};
        for (const capturedHeader of normalizedHeaders.keys()) {
          const value = getHeader(capturedHeader);
          if (value === void 0) {
            continue;
          }
          const normalizedHeader = normalizedHeaders.get(capturedHeader);
          const key = `http.${type}.header.${normalizedHeader}`;
          if (typeof value === "string") {
            attributes[key] = [value];
          } else if (Array.isArray(value)) {
            attributes[key] = value;
          } else {
            attributes[key] = [value];
          }
        }
        return attributes;
      };
    }
    __name(headerCapture, "headerCapture");
    exports.headerCapture = headerCapture;
    var KNOWN_METHODS = /* @__PURE__ */ new Set([
      // methods from https://www.rfc-editor.org/rfc/rfc9110.html#name-methods
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "DELETE",
      "CONNECT",
      "OPTIONS",
      "TRACE",
      // PATCH from https://www.rfc-editor.org/rfc/rfc5789.html
      "PATCH",
      // QUERY from https://datatracker.ietf.org/doc/draft-ietf-httpbis-safe-method-w-body/
      "QUERY"
    ]);
    function normalizeMethod(method) {
      if (method == null) {
        return "GET";
      }
      const upper = method.toUpperCase();
      if (KNOWN_METHODS.has(upper)) {
        return upper;
      }
      return "_OTHER";
    }
    __name(normalizeMethod, "normalizeMethod");
    function parseForwardedHeader(header) {
      try {
        return forwardedParse(header);
      } catch {
        return [];
      }
    }
    __name(parseForwardedHeader, "parseForwardedHeader");
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation-http/build/src/http.js
var require_http = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation-http/build/src/http.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.HttpInstrumentation = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src3();
    var url = __require("url");
    var version_1 = require_version3();
    var instrumentation_1 = require_src11();
    var events_1 = __require("events");
    var semantic_conventions_1 = (init_esm2(), __toCommonJS(esm_exports2));
    var utils_1 = require_utils6();
    var HttpInstrumentation2 = class extends instrumentation_1.InstrumentationBase {
      static {
        __name(this, "HttpInstrumentation");
      }
      /** keep track on spans not ended */
      _spanNotEnded = /* @__PURE__ */ new WeakSet();
      _headerCapture;
      _httpPatched = false;
      _httpsPatched = false;
      constructor(config = {}) {
        super("@opentelemetry/instrumentation-http", version_1.VERSION, config);
        this._headerCapture = this._createHeaderCapture();
      }
      _updateMetricInstruments() {
        this._httpServerDurationHistogram = this.meter.createHistogram(semantic_conventions_1.METRIC_HTTP_SERVER_REQUEST_DURATION, {
          description: "Duration of HTTP server requests.",
          unit: "s",
          valueType: api_1.ValueType.DOUBLE,
          advice: {
            explicitBucketBoundaries: [
              5e-3,
              0.01,
              0.025,
              0.05,
              0.075,
              0.1,
              0.25,
              0.5,
              0.75,
              1,
              2.5,
              5,
              7.5,
              10
            ]
          }
        });
        this._httpClientDurationHistogram = this.meter.createHistogram(semantic_conventions_1.METRIC_HTTP_CLIENT_REQUEST_DURATION, {
          description: "Duration of HTTP client requests.",
          unit: "s",
          valueType: api_1.ValueType.DOUBLE,
          advice: {
            explicitBucketBoundaries: [
              5e-3,
              0.01,
              0.025,
              0.05,
              0.075,
              0.1,
              0.25,
              0.5,
              0.75,
              1,
              2.5,
              5,
              7.5,
              10
            ]
          }
        });
      }
      _recordServerDuration(durationMs, attributes) {
        this._httpServerDurationHistogram.record(durationMs / 1e3, attributes);
      }
      _recordClientDuration(durationMs, attributes) {
        this._httpClientDurationHistogram.record(durationMs / 1e3, attributes);
      }
      setConfig(config = {}) {
        super.setConfig(config);
        this._headerCapture = this._createHeaderCapture();
      }
      init() {
        return [this._getHttpsInstrumentation(), this._getHttpInstrumentation()];
      }
      _getHttpInstrumentation() {
        return new instrumentation_1.InstrumentationNodeModuleDefinition("http", ["*"], (moduleExports) => {
          if (this._httpPatched) {
            return moduleExports;
          }
          this._httpPatched = true;
          const isESM = moduleExports[Symbol.toStringTag] === "Module";
          if (!this.getConfig().disableOutgoingRequestInstrumentation) {
            const patchedRequest = this._wrap(moduleExports, "request", this._getPatchOutgoingRequestFunction("http"));
            const patchedGet = this._wrap(moduleExports, "get", this._getPatchOutgoingGetFunction(patchedRequest));
            if (isESM) {
              moduleExports.default.request = patchedRequest;
              moduleExports.default.get = patchedGet;
            }
          }
          if (!this.getConfig().disableIncomingRequestInstrumentation) {
            this._wrap(moduleExports.Server.prototype, "emit", this._getPatchIncomingRequestFunction("http"));
          }
          return moduleExports;
        }, (moduleExports) => {
          this._httpPatched = false;
          if (moduleExports === void 0)
            return;
          if (!this.getConfig().disableOutgoingRequestInstrumentation) {
            this._unwrap(moduleExports, "request");
            this._unwrap(moduleExports, "get");
          }
          if (!this.getConfig().disableIncomingRequestInstrumentation) {
            this._unwrap(moduleExports.Server.prototype, "emit");
          }
        });
      }
      _getHttpsInstrumentation() {
        return new instrumentation_1.InstrumentationNodeModuleDefinition("https", ["*"], (moduleExports) => {
          if (this._httpsPatched) {
            return moduleExports;
          }
          this._httpsPatched = true;
          const isESM = moduleExports[Symbol.toStringTag] === "Module";
          if (!this.getConfig().disableOutgoingRequestInstrumentation) {
            const patchedRequest = this._wrap(moduleExports, "request", this._getPatchHttpsOutgoingRequestFunction("https"));
            const patchedGet = this._wrap(moduleExports, "get", this._getPatchHttpsOutgoingGetFunction(patchedRequest));
            if (isESM) {
              moduleExports.default.request = patchedRequest;
              moduleExports.default.get = patchedGet;
            }
          }
          if (!this.getConfig().disableIncomingRequestInstrumentation) {
            this._wrap(moduleExports.Server.prototype, "emit", this._getPatchIncomingRequestFunction("https"));
          }
          return moduleExports;
        }, (moduleExports) => {
          this._httpsPatched = false;
          if (moduleExports === void 0)
            return;
          if (!this.getConfig().disableOutgoingRequestInstrumentation) {
            this._unwrap(moduleExports, "request");
            this._unwrap(moduleExports, "get");
          }
          if (!this.getConfig().disableIncomingRequestInstrumentation) {
            this._unwrap(moduleExports.Server.prototype, "emit");
          }
        });
      }
      /**
       * Creates spans for incoming requests, restoring spans' context if applied.
       */
      _getPatchIncomingRequestFunction(component) {
        return (original) => {
          return this._incomingRequestFunction(component, original);
        };
      }
      /**
       * Creates spans for outgoing requests, sending spans' context for distributed
       * tracing.
       */
      _getPatchOutgoingRequestFunction(component) {
        return (original) => {
          return this._outgoingRequestFunction(component, original);
        };
      }
      _getPatchOutgoingGetFunction(clientRequest) {
        return (_original) => {
          return /* @__PURE__ */ __name(function outgoingGetRequest(options, ...args) {
            const req = clientRequest(options, ...args);
            req.end();
            return req;
          }, "outgoingGetRequest");
        };
      }
      /** Patches HTTPS outgoing requests */
      _getPatchHttpsOutgoingRequestFunction(component) {
        return (original) => {
          const instrumentation = this;
          return /* @__PURE__ */ __name(function httpsOutgoingRequest(options, ...args) {
            if (component === "https" && typeof options === "object" && options?.constructor?.name !== "URL") {
              options = Object.assign({}, options);
              instrumentation._setDefaultOptions(options);
            }
            return instrumentation._getPatchOutgoingRequestFunction(component)(original)(options, ...args);
          }, "httpsOutgoingRequest");
        };
      }
      _setDefaultOptions(options) {
        options.protocol = options.protocol || "https:";
        options.port = options.port || 443;
      }
      /** Patches HTTPS outgoing get requests */
      _getPatchHttpsOutgoingGetFunction(clientRequest) {
        return (original) => {
          const instrumentation = this;
          return /* @__PURE__ */ __name(function httpsOutgoingRequest(options, ...args) {
            return instrumentation._getPatchOutgoingGetFunction(clientRequest)(original)(options, ...args);
          }, "httpsOutgoingRequest");
        };
      }
      /**
       * Attach event listeners to a client request to end span and add span attributes.
       *
       * @param request The original request object.
       * @param span representing the current operation
       * @param startTime representing the start time of the request to calculate duration in Metric
       * @param metricAttributes metric attributes for the request duration metric
       */
      _traceClientRequest(request, span, startTime, metricAttributes) {
        if (this.getConfig().requestHook) {
          this._callRequestHook(span, request);
        }
        let responseFinished = false;
        request.prependListener("response", (response) => {
          this._diag.debug("outgoingRequest on response()");
          if (request.listenerCount("response") <= 1) {
            response.resume();
          }
          const responseAttributes = (0, utils_1.getOutgoingRequestAttributesOnResponse)(response);
          span.setAttributes(responseAttributes);
          metricAttributes = Object.assign(metricAttributes, (0, utils_1.getOutgoingStableRequestMetricAttributesOnResponse)(responseAttributes));
          if (this.getConfig().responseHook) {
            this._callResponseHook(span, response);
          }
          span.setAttributes(this._headerCapture.client.captureRequestHeaders((header) => request.getHeader(header)));
          span.setAttributes(this._headerCapture.client.captureResponseHeaders((header) => response.headers[header]));
          api_1.context.bind(api_1.context.active(), response);
          const endHandler = /* @__PURE__ */ __name(() => {
            this._diag.debug("outgoingRequest on end()");
            if (responseFinished) {
              return;
            }
            responseFinished = true;
            let status;
            if (response.aborted && !response.complete) {
              status = { code: api_1.SpanStatusCode.ERROR };
            } else {
              status = {
                code: (0, utils_1.parseResponseStatus)(api_1.SpanKind.CLIENT, response.statusCode)
              };
            }
            span.setStatus(status);
            if (this.getConfig().applyCustomAttributesOnSpan) {
              (0, instrumentation_1.safeExecuteInTheMiddle)(() => this.getConfig().applyCustomAttributesOnSpan(span, request, response), () => {
              }, true);
            }
            this._closeHttpSpan(span, api_1.SpanKind.CLIENT, startTime, metricAttributes);
          }, "endHandler");
          response.on("end", endHandler);
          response.on(events_1.errorMonitor, (error) => {
            this._diag.debug("outgoingRequest on error()", error);
            if (responseFinished) {
              return;
            }
            responseFinished = true;
            this._onOutgoingRequestError(span, metricAttributes, startTime, error);
          });
        });
        request.on("close", () => {
          this._diag.debug("outgoingRequest on request close()");
          if (request.aborted || responseFinished) {
            return;
          }
          responseFinished = true;
          this._closeHttpSpan(span, api_1.SpanKind.CLIENT, startTime, metricAttributes);
        });
        request.on(events_1.errorMonitor, (error) => {
          this._diag.debug("outgoingRequest on request error()", error);
          if (responseFinished) {
            return;
          }
          responseFinished = true;
          this._onOutgoingRequestError(span, metricAttributes, startTime, error);
        });
        this._diag.debug("http.ClientRequest return request");
        return request;
      }
      _incomingRequestFunction(component, original) {
        const instrumentation = this;
        return /* @__PURE__ */ __name(function incomingRequest(event, ...args) {
          if (event !== "request") {
            return original.apply(this, [event, ...args]);
          }
          const request = args[0];
          const response = args[1];
          const method = request.method || "GET";
          instrumentation._diag.debug(`${component} instrumentation incomingRequest`);
          if ((0, instrumentation_1.safeExecuteInTheMiddle)(() => instrumentation.getConfig().ignoreIncomingRequestHook?.(request), (e) => {
            if (e != null) {
              instrumentation._diag.error("caught ignoreIncomingRequestHook error: ", e);
            }
          }, true)) {
            return api_1.context.with((0, core_1.suppressTracing)(api_1.context.active()), () => {
              api_1.context.bind(api_1.context.active(), request);
              api_1.context.bind(api_1.context.active(), response);
              return original.apply(this, [event, ...args]);
            });
          }
          const headers = request.headers;
          const spanAttributes = (0, utils_1.getIncomingRequestAttributes)(request, {
            component,
            hookAttributes: instrumentation._callStartSpanHook(request, instrumentation.getConfig().startIncomingSpanHook),
            enableSyntheticSourceDetection: instrumentation.getConfig().enableSyntheticSourceDetection || false
          }, instrumentation._diag);
          Object.assign(spanAttributes, instrumentation._headerCapture.server.captureRequestHeaders((header) => request.headers[header]));
          const spanOptions = {
            kind: api_1.SpanKind.SERVER,
            attributes: spanAttributes
          };
          const startTime = (0, core_1.hrTime)();
          const metricAttributes = {
            [semantic_conventions_1.ATTR_HTTP_REQUEST_METHOD]: spanAttributes[semantic_conventions_1.ATTR_HTTP_REQUEST_METHOD],
            [semantic_conventions_1.ATTR_URL_SCHEME]: spanAttributes[semantic_conventions_1.ATTR_URL_SCHEME]
          };
          if (spanAttributes[semantic_conventions_1.ATTR_NETWORK_PROTOCOL_VERSION]) {
            metricAttributes[semantic_conventions_1.ATTR_NETWORK_PROTOCOL_VERSION] = spanAttributes[semantic_conventions_1.ATTR_NETWORK_PROTOCOL_VERSION];
          }
          const ctx = api_1.propagation.extract(api_1.ROOT_CONTEXT, headers);
          const span = instrumentation._startHttpSpan(method, spanOptions, ctx);
          const rpcMetadata = {
            type: core_1.RPCType.HTTP,
            span
          };
          return api_1.context.with((0, core_1.setRPCMetadata)(api_1.trace.setSpan(ctx, span), rpcMetadata), () => {
            api_1.context.bind(api_1.context.active(), request);
            api_1.context.bind(api_1.context.active(), response);
            if (instrumentation.getConfig().requestHook) {
              instrumentation._callRequestHook(span, request);
            }
            if (instrumentation.getConfig().responseHook) {
              instrumentation._callResponseHook(span, response);
            }
            let hasError = false;
            response.on("close", () => {
              if (hasError) {
                return;
              }
              instrumentation._onServerResponseFinish(request, response, span, metricAttributes, startTime);
            });
            response.on(events_1.errorMonitor, (err) => {
              hasError = true;
              instrumentation._onServerResponseError(span, metricAttributes, startTime, err);
            });
            return (0, instrumentation_1.safeExecuteInTheMiddle)(() => original.apply(this, [event, ...args]), (error) => {
              if (error) {
                instrumentation._onServerResponseError(span, metricAttributes, startTime, error);
                throw error;
              }
            });
          });
        }, "incomingRequest");
      }
      _outgoingRequestFunction(component, original) {
        const instrumentation = this;
        return /* @__PURE__ */ __name(function outgoingRequest(options, ...args) {
          if (!(0, utils_1.isValidOptionsType)(options)) {
            return original.apply(this, [options, ...args]);
          }
          const extraOptions = typeof args[0] === "object" && (typeof options === "string" || options instanceof url.URL) ? args.shift() : void 0;
          const { method, invalidUrl, optionsParsed } = (0, utils_1.getRequestInfo)(instrumentation._diag, options, extraOptions);
          if ((0, instrumentation_1.safeExecuteInTheMiddle)(() => instrumentation.getConfig().ignoreOutgoingRequestHook?.(optionsParsed), (e) => {
            if (e != null) {
              instrumentation._diag.error("caught ignoreOutgoingRequestHook error: ", e);
            }
          }, true)) {
            return original.apply(this, [optionsParsed, ...args]);
          }
          const { hostname, port } = (0, utils_1.extractHostnameAndPort)(optionsParsed);
          const attributes = (0, utils_1.getOutgoingRequestAttributes)(optionsParsed, {
            component,
            port,
            hostname,
            hookAttributes: instrumentation._callStartSpanHook(optionsParsed, instrumentation.getConfig().startOutgoingSpanHook),
            redactedQueryParams: instrumentation.getConfig().redactedQueryParams
            // Added config for adding custom query strings
          }, instrumentation.getConfig().enableSyntheticSourceDetection || false);
          const startTime = (0, core_1.hrTime)();
          const metricAttributes = {
            [semantic_conventions_1.ATTR_HTTP_REQUEST_METHOD]: attributes[semantic_conventions_1.ATTR_HTTP_REQUEST_METHOD],
            [semantic_conventions_1.ATTR_SERVER_ADDRESS]: attributes[semantic_conventions_1.ATTR_SERVER_ADDRESS],
            [semantic_conventions_1.ATTR_SERVER_PORT]: attributes[semantic_conventions_1.ATTR_SERVER_PORT]
          };
          if (attributes[semantic_conventions_1.ATTR_HTTP_RESPONSE_STATUS_CODE]) {
            metricAttributes[semantic_conventions_1.ATTR_HTTP_RESPONSE_STATUS_CODE] = attributes[semantic_conventions_1.ATTR_HTTP_RESPONSE_STATUS_CODE];
          }
          if (attributes[semantic_conventions_1.ATTR_NETWORK_PROTOCOL_VERSION]) {
            metricAttributes[semantic_conventions_1.ATTR_NETWORK_PROTOCOL_VERSION] = attributes[semantic_conventions_1.ATTR_NETWORK_PROTOCOL_VERSION];
          }
          const spanOptions = {
            kind: api_1.SpanKind.CLIENT,
            attributes
          };
          const span = instrumentation._startHttpSpan(method, spanOptions);
          const parentContext = api_1.context.active();
          const requestContext = api_1.trace.setSpan(parentContext, span);
          if (!optionsParsed.headers) {
            optionsParsed.headers = {};
          } else {
            optionsParsed.headers = Object.assign({}, optionsParsed.headers);
          }
          api_1.propagation.inject(requestContext, optionsParsed.headers);
          return api_1.context.with(requestContext, () => {
            const cb = args[args.length - 1];
            if (typeof cb === "function") {
              args[args.length - 1] = api_1.context.bind(parentContext, cb);
            }
            const request = (0, instrumentation_1.safeExecuteInTheMiddle)(() => {
              if (invalidUrl) {
                return original.apply(this, [options, ...args]);
              } else {
                return original.apply(this, [optionsParsed, ...args]);
              }
            }, (error) => {
              if (error) {
                instrumentation._onOutgoingRequestError(span, metricAttributes, startTime, error);
                throw error;
              }
            });
            instrumentation._diag.debug(`${component} instrumentation outgoingRequest`);
            api_1.context.bind(parentContext, request);
            return instrumentation._traceClientRequest(request, span, startTime, metricAttributes);
          });
        }, "outgoingRequest");
      }
      _onServerResponseFinish(request, response, span, metricAttributes, startTime) {
        const attributes = (0, utils_1.getIncomingRequestAttributesOnResponse)(response);
        metricAttributes = Object.assign(metricAttributes, (0, utils_1.getIncomingStableRequestMetricAttributesOnResponse)(attributes));
        span.setAttributes(this._headerCapture.server.captureResponseHeaders((header) => response.getHeader(header)));
        span.setAttributes(attributes).setStatus({
          code: (0, utils_1.parseResponseStatus)(api_1.SpanKind.SERVER, response.statusCode)
        });
        const route = attributes[semantic_conventions_1.ATTR_HTTP_ROUTE];
        if (route) {
          span.updateName(`${request.method || "GET"} ${route}`);
        }
        if (this.getConfig().applyCustomAttributesOnSpan) {
          (0, instrumentation_1.safeExecuteInTheMiddle)(() => this.getConfig().applyCustomAttributesOnSpan(span, request, response), () => {
          }, true);
        }
        this._closeHttpSpan(span, api_1.SpanKind.SERVER, startTime, metricAttributes);
      }
      _onOutgoingRequestError(span, metricAttributes, startTime, error) {
        (0, utils_1.setSpanWithError)(span, error);
        metricAttributes[semantic_conventions_1.ATTR_ERROR_TYPE] = error.name;
        this._closeHttpSpan(span, api_1.SpanKind.CLIENT, startTime, metricAttributes);
      }
      _onServerResponseError(span, metricAttributes, startTime, error) {
        (0, utils_1.setSpanWithError)(span, error);
        metricAttributes[semantic_conventions_1.ATTR_ERROR_TYPE] = error.name;
        this._closeHttpSpan(span, api_1.SpanKind.SERVER, startTime, metricAttributes);
      }
      _startHttpSpan(name, options, ctx = api_1.context.active()) {
        const requireParent = options.kind === api_1.SpanKind.CLIENT ? this.getConfig().requireParentforOutgoingSpans : this.getConfig().requireParentforIncomingSpans;
        let span;
        const currentSpan = api_1.trace.getSpan(ctx);
        if (requireParent === true && (!currentSpan || !api_1.trace.isSpanContextValid(currentSpan.spanContext()))) {
          span = api_1.trace.wrapSpanContext(api_1.INVALID_SPAN_CONTEXT);
        } else if (requireParent === true && currentSpan?.spanContext().isRemote) {
          span = currentSpan;
        } else {
          span = this.tracer.startSpan(name, options, ctx);
        }
        this._spanNotEnded.add(span);
        return span;
      }
      _closeHttpSpan(span, spanKind, startTime, metricAttributes) {
        if (!this._spanNotEnded.has(span)) {
          return;
        }
        span.end();
        this._spanNotEnded.delete(span);
        const duration = (0, core_1.hrTimeToMilliseconds)((0, core_1.hrTimeDuration)(startTime, (0, core_1.hrTime)()));
        if (spanKind === api_1.SpanKind.SERVER) {
          this._recordServerDuration(duration, metricAttributes);
        } else if (spanKind === api_1.SpanKind.CLIENT) {
          this._recordClientDuration(duration, metricAttributes);
        }
      }
      _callResponseHook(span, response) {
        (0, instrumentation_1.safeExecuteInTheMiddle)(() => this.getConfig().responseHook(span, response), () => {
        }, true);
      }
      _callRequestHook(span, request) {
        (0, instrumentation_1.safeExecuteInTheMiddle)(() => this.getConfig().requestHook(span, request), () => {
        }, true);
      }
      _callStartSpanHook(request, hookFunc) {
        if (typeof hookFunc === "function") {
          return (0, instrumentation_1.safeExecuteInTheMiddle)(() => hookFunc(request), () => {
          }, true);
        }
      }
      _createHeaderCapture() {
        const config = this.getConfig();
        return {
          client: {
            captureRequestHeaders: (0, utils_1.headerCapture)("request", config.headersToSpanAttributes?.client?.requestHeaders ?? []),
            captureResponseHeaders: (0, utils_1.headerCapture)("response", config.headersToSpanAttributes?.client?.responseHeaders ?? [])
          },
          server: {
            captureRequestHeaders: (0, utils_1.headerCapture)("request", config.headersToSpanAttributes?.server?.requestHeaders ?? []),
            captureResponseHeaders: (0, utils_1.headerCapture)("response", config.headersToSpanAttributes?.server?.responseHeaders ?? [])
          }
        };
      }
    };
    exports.HttpInstrumentation = HttpInstrumentation2;
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation-http/build/src/index.js
var require_src15 = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation-http/build/src/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.HttpInstrumentation = void 0;
    var http_1 = require_http();
    Object.defineProperty(exports, "HttpInstrumentation", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return http_1.HttpInstrumentation;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation-undici/build/src/version.js
var require_version4 = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation-undici/build/src/version.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.PACKAGE_NAME = exports.PACKAGE_VERSION = void 0;
    exports.PACKAGE_VERSION = "0.31.0";
    exports.PACKAGE_NAME = "@opentelemetry/instrumentation-undici";
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation-undici/build/src/undici.js
var require_undici = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation-undici/build/src/undici.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.UndiciInstrumentation = void 0;
    var diagch = __require("diagnostics_channel");
    var url_1 = __require("url");
    var instrumentation_1 = require_src11();
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var core_1 = require_src3();
    var semantic_conventions_1 = (init_esm2(), __toCommonJS(esm_exports2));
    var version_1 = require_version4();
    var UndiciInstrumentation2 = class extends instrumentation_1.InstrumentationBase {
      static {
        __name(this, "UndiciInstrumentation");
      }
      _recordFromReq = /* @__PURE__ */ new WeakMap();
      constructor(config = {}) {
        super(version_1.PACKAGE_NAME, version_1.PACKAGE_VERSION, config);
      }
      // No need to instrument files/modules
      init() {
        return void 0;
      }
      disable() {
        super.disable();
        this._channelSubs.forEach((sub) => sub.unsubscribe());
        this._channelSubs.length = 0;
      }
      enable() {
        super.enable();
        this._channelSubs = this._channelSubs || [];
        if (this._channelSubs.length > 0) {
          return;
        }
        this.subscribeToChannel("undici:request:create", this.onRequestCreated.bind(this));
        this.subscribeToChannel("undici:client:sendHeaders", this.onRequestHeaders.bind(this));
        this.subscribeToChannel("undici:request:headers", this.onResponseHeaders.bind(this));
        this.subscribeToChannel("undici:request:trailers", this.onDone.bind(this));
        this.subscribeToChannel("undici:request:error", this.onError.bind(this));
      }
      _updateMetricInstruments() {
        this._httpClientDurationHistogram = this.meter.createHistogram(semantic_conventions_1.METRIC_HTTP_CLIENT_REQUEST_DURATION, {
          description: "Measures the duration of outbound HTTP requests.",
          unit: "s",
          valueType: api_1.ValueType.DOUBLE,
          advice: {
            explicitBucketBoundaries: [
              5e-3,
              0.01,
              0.025,
              0.05,
              0.075,
              0.1,
              0.25,
              0.5,
              0.75,
              1,
              2.5,
              5,
              7.5,
              10
            ]
          }
        });
      }
      subscribeToChannel(diagnosticChannel, onMessage) {
        const [major, minor] = process.version.replace("v", "").split(".").map((n) => Number(n));
        const useNewSubscribe = major > 18 || major === 18 && minor >= 19;
        let unsubscribe;
        if (useNewSubscribe) {
          diagch.subscribe?.(diagnosticChannel, onMessage);
          unsubscribe = /* @__PURE__ */ __name(() => diagch.unsubscribe?.(diagnosticChannel, onMessage), "unsubscribe");
        } else {
          const channel = diagch.channel(diagnosticChannel);
          channel.subscribe(onMessage);
          unsubscribe = /* @__PURE__ */ __name(() => channel.unsubscribe(onMessage), "unsubscribe");
        }
        this._channelSubs.push({
          name: diagnosticChannel,
          unsubscribe
        });
      }
      parseRequestHeaders(request) {
        const result = /* @__PURE__ */ new Map();
        if (Array.isArray(request.headers)) {
          for (let i = 0; i < request.headers.length; i += 2) {
            const key = request.headers[i];
            const value = request.headers[i + 1];
            if (typeof key === "string") {
              result.set(key.toLowerCase(), value);
            }
          }
        } else if (typeof request.headers === "string") {
          const headers = request.headers.split("\r\n");
          for (const line of headers) {
            if (!line) {
              continue;
            }
            const colonIndex = line.indexOf(":");
            if (colonIndex === -1) {
              continue;
            }
            const key = line.substring(0, colonIndex).toLowerCase();
            const value = line.substring(colonIndex + 1).trim();
            const allValues = result.get(key);
            if (allValues && Array.isArray(allValues)) {
              allValues.push(value);
            } else if (allValues) {
              result.set(key, [allValues, value]);
            } else {
              result.set(key, value);
            }
          }
        }
        return result;
      }
      // This is the 1st message we receive for each request (fired after request creation). Here we will
      // create the span and populate some atttributes, then link the span to the request for further
      // span processing
      onRequestCreated({ request }) {
        const config = this.getConfig();
        const enabled = config.enabled !== false;
        const shouldIgnoreReq = (0, instrumentation_1.safeExecuteInTheMiddle)(() => !enabled || request.method === "CONNECT" || config.ignoreRequestHook?.(request), (e) => e && this._diag.error("caught ignoreRequestHook error: ", e), true);
        if (shouldIgnoreReq) {
          return;
        }
        const startTime = (0, core_1.hrTime)();
        let requestUrl;
        try {
          requestUrl = new url_1.URL(request.path, request.origin);
        } catch (err) {
          this._diag.warn("could not determine url.full:", err);
          return;
        }
        const urlScheme = requestUrl.protocol.replace(":", "");
        const requestMethod = this.getRequestMethod(request.method);
        const attributes = {
          [semantic_conventions_1.ATTR_HTTP_REQUEST_METHOD]: requestMethod,
          [semantic_conventions_1.ATTR_HTTP_REQUEST_METHOD_ORIGINAL]: request.method,
          [semantic_conventions_1.ATTR_URL_FULL]: requestUrl.toString(),
          [semantic_conventions_1.ATTR_URL_PATH]: requestUrl.pathname,
          [semantic_conventions_1.ATTR_URL_QUERY]: requestUrl.search,
          [semantic_conventions_1.ATTR_URL_SCHEME]: urlScheme
        };
        const schemePorts = { https: "443", http: "80" };
        const serverAddress = requestUrl.hostname;
        const serverPort = requestUrl.port || schemePorts[urlScheme];
        attributes[semantic_conventions_1.ATTR_SERVER_ADDRESS] = serverAddress;
        if (serverPort && !isNaN(Number(serverPort))) {
          attributes[semantic_conventions_1.ATTR_SERVER_PORT] = Number(serverPort);
        }
        const headersMap = this.parseRequestHeaders(request);
        const userAgentValues = headersMap.get("user-agent");
        if (userAgentValues) {
          const userAgent = Array.isArray(userAgentValues) ? userAgentValues[userAgentValues.length - 1] : userAgentValues;
          attributes[semantic_conventions_1.ATTR_USER_AGENT_ORIGINAL] = userAgent;
        }
        const hookAttributes = (0, instrumentation_1.safeExecuteInTheMiddle)(() => config.startSpanHook?.(request), (e) => e && this._diag.error("caught startSpanHook error: ", e), true);
        if (hookAttributes) {
          Object.entries(hookAttributes).forEach(([key, val]) => {
            attributes[key] = val;
          });
        }
        const activeCtx = api_1.context.active();
        const currentSpan = api_1.trace.getSpan(activeCtx);
        let span;
        if (config.requireParentforSpans && (!currentSpan || !api_1.trace.isSpanContextValid(currentSpan.spanContext()))) {
          span = api_1.trace.wrapSpanContext(api_1.INVALID_SPAN_CONTEXT);
        } else {
          span = this.tracer.startSpan(requestMethod === "_OTHER" ? "HTTP" : requestMethod, {
            kind: api_1.SpanKind.CLIENT,
            attributes
          }, activeCtx);
        }
        (0, instrumentation_1.safeExecuteInTheMiddle)(() => config.requestHook?.(span, request), (e) => e && this._diag.error("caught requestHook error: ", e), true);
        const requestContext = api_1.trace.setSpan(api_1.context.active(), span);
        const addedHeaders = {};
        api_1.propagation.inject(requestContext, addedHeaders);
        const headerEntries = Object.entries(addedHeaders);
        for (let i = 0; i < headerEntries.length; i++) {
          const [k, v] = headerEntries[i];
          if (typeof request.addHeader === "function") {
            request.addHeader(k, v);
          } else if (typeof request.headers === "string") {
            request.headers += `${k}: ${v}\r
`;
          } else if (Array.isArray(request.headers)) {
            request.headers.push(k, v);
          }
        }
        this._recordFromReq.set(request, { span, attributes, startTime });
      }
      // This is the 2nd message we receive for each request. It is fired when connection with
      // the remote is established and about to send the first byte. Here we do have info about the
      // remote address and port so we can populate some `network.*` attributes into the span
      onRequestHeaders({ request, socket }) {
        const record = this._recordFromReq.get(request);
        if (!record) {
          return;
        }
        const config = this.getConfig();
        const { span } = record;
        const { remoteAddress, remotePort } = socket;
        const spanAttributes = {
          [semantic_conventions_1.ATTR_NETWORK_PEER_ADDRESS]: remoteAddress,
          [semantic_conventions_1.ATTR_NETWORK_PEER_PORT]: remotePort
        };
        if (config.headersToSpanAttributes?.requestHeaders) {
          const headersToAttribs = new Set(config.headersToSpanAttributes.requestHeaders.map((n) => n.toLowerCase()));
          const headersMap = this.parseRequestHeaders(request);
          for (const [name, value] of headersMap.entries()) {
            if (headersToAttribs.has(name)) {
              const attrValue = Array.isArray(value) ? value : [value];
              spanAttributes[`http.request.header.${name}`] = attrValue;
            }
          }
        }
        span.setAttributes(spanAttributes);
      }
      // This is the 3rd message we get for each request and it's fired when the server
      // headers are received, body may not be accessible yet.
      // From the response headers we can set the status and content length
      onResponseHeaders({ request, response }) {
        const record = this._recordFromReq.get(request);
        if (!record) {
          return;
        }
        const { span, attributes } = record;
        const spanAttributes = {
          [semantic_conventions_1.ATTR_HTTP_RESPONSE_STATUS_CODE]: response.statusCode
        };
        const config = this.getConfig();
        (0, instrumentation_1.safeExecuteInTheMiddle)(() => config.responseHook?.(span, { request, response }), (e) => e && this._diag.error("caught responseHook error: ", e), true);
        if (config.headersToSpanAttributes?.responseHeaders) {
          const headersToAttribs = /* @__PURE__ */ new Set();
          config.headersToSpanAttributes?.responseHeaders.forEach((name) => headersToAttribs.add(name.toLowerCase()));
          for (let idx = 0; idx < response.headers.length; idx = idx + 2) {
            const name = response.headers[idx].toString().toLowerCase();
            const value = response.headers[idx + 1];
            if (headersToAttribs.has(name)) {
              const attrName = `http.response.header.${name}`;
              if (!Object.hasOwn(spanAttributes, attrName)) {
                spanAttributes[attrName] = [value.toString()];
              } else {
                spanAttributes[attrName].push(value.toString());
              }
            }
          }
        }
        span.setAttributes(spanAttributes);
        span.setStatus({
          code: response.statusCode >= 400 ? api_1.SpanStatusCode.ERROR : api_1.SpanStatusCode.UNSET
        });
        record.attributes = Object.assign(attributes, spanAttributes);
      }
      // This is the last event we receive if the request went without any errors
      onDone({ request }) {
        const record = this._recordFromReq.get(request);
        if (!record) {
          return;
        }
        const { span, attributes, startTime } = record;
        span.end();
        this._recordFromReq.delete(request);
        this.recordRequestDuration(attributes, startTime);
      }
      // This is the event we get when something is wrong in the request like
      // - invalid options when calling `fetch` global API or any undici method for request
      // - connectivity errors such as unreachable host
      // - requests aborted through an `AbortController.signal`
      // NOTE: server errors are considered valid responses and it's the lib consumer
      // who should deal with that.
      onError({ request, error }) {
        const record = this._recordFromReq.get(request);
        if (!record) {
          return;
        }
        const { span, attributes, startTime } = record;
        const isAbort = error.name === "AbortError" || typeof DOMException !== "undefined" && error instanceof DOMException && error.code === DOMException.ABORT_ERR;
        if (isAbort) {
          span.end();
        } else {
          span.recordException(error);
          span.setStatus({
            code: api_1.SpanStatusCode.ERROR,
            message: error.message
          });
          span.end();
          attributes[semantic_conventions_1.ATTR_ERROR_TYPE] = error.message;
        }
        this._recordFromReq.delete(request);
        this.recordRequestDuration(attributes, startTime);
      }
      recordRequestDuration(attributes, startTime) {
        const metricsAttributes = {};
        const keysToCopy = [
          semantic_conventions_1.ATTR_HTTP_RESPONSE_STATUS_CODE,
          semantic_conventions_1.ATTR_HTTP_REQUEST_METHOD,
          semantic_conventions_1.ATTR_SERVER_ADDRESS,
          semantic_conventions_1.ATTR_SERVER_PORT,
          semantic_conventions_1.ATTR_URL_SCHEME,
          semantic_conventions_1.ATTR_ERROR_TYPE
        ];
        keysToCopy.forEach((key) => {
          if (key in attributes) {
            metricsAttributes[key] = attributes[key];
          }
        });
        const durationSeconds = (0, core_1.hrTimeToMilliseconds)((0, core_1.hrTimeDuration)(startTime, (0, core_1.hrTime)())) / 1e3;
        this._httpClientDurationHistogram.record(durationSeconds, metricsAttributes);
      }
      getRequestMethod(original) {
        const knownMethods = {
          CONNECT: true,
          OPTIONS: true,
          HEAD: true,
          GET: true,
          POST: true,
          PUT: true,
          PATCH: true,
          DELETE: true,
          TRACE: true,
          // QUERY from https://datatracker.ietf.org/doc/draft-ietf-httpbis-safe-method-w-body/
          QUERY: true
        };
        if (original.toUpperCase() in knownMethods) {
          return original.toUpperCase();
        }
        return "_OTHER";
      }
    };
    exports.UndiciInstrumentation = UndiciInstrumentation2;
  }
});

// packages/core/node_modules/@opentelemetry/instrumentation-undici/build/src/index.js
var require_src16 = __commonJS({
  "packages/core/node_modules/@opentelemetry/instrumentation-undici/build/src/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.UndiciInstrumentation = void 0;
    var undici_1 = require_undici();
    Object.defineProperty(exports, "UndiciInstrumentation", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return undici_1.UndiciInstrumentation;
    }, "get") });
  }
});

// packages/core/src/telemetry/sdk-impl.ts
init_esbuild_shims();
init_esm();
var import_core2 = __toESM(require_src3(), 1);
var import_sdk_node = __toESM(require_src14(), 1);
init_esm2();
var import_resources = __toESM(require_src4(), 1);
var import_sdk_trace_node = __toESM(require_src10(), 1);
var import_sdk_logs = __toESM(require_src6(), 1);
var import_sdk_metrics2 = __toESM(require_src5(), 1);
var import_instrumentation_http = __toESM(require_src15(), 1);
var import_instrumentation_undici = __toESM(require_src16(), 1);

// packages/core/src/telemetry/file-exporters.ts
init_esbuild_shims();
var import_core = __toESM(require_src3(), 1);
var import_sdk_metrics = __toESM(require_src5(), 1);
import * as fs from "node:fs";
import * as path from "node:path";
var FileExporter = class {
  static {
    __name(this, "FileExporter");
  }
  writeStream;
  constructor(filePath) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch {
    }
    this.writeStream = fs.createWriteStream(filePath, { flags: "a" });
    this.writeStream.on("error", () => {
    });
  }
  serialize(data) {
    return safeJsonStringify(data, 2) + "\n";
  }
  shutdown() {
    return new Promise((resolve) => {
      this.writeStream.end(resolve);
    });
  }
};
var FileSpanExporter = class extends FileExporter {
  static {
    __name(this, "FileSpanExporter");
  }
  export(spans, resultCallback) {
    const data = spans.map((span) => this.serialize(span)).join("");
    this.writeStream.write(data, (err) => {
      resultCallback({
        code: err ? import_core.ExportResultCode.FAILED : import_core.ExportResultCode.SUCCESS,
        error: err || void 0
      });
    });
  }
};
var FileLogExporter = class extends FileExporter {
  static {
    __name(this, "FileLogExporter");
  }
  export(logs, resultCallback) {
    const data = logs.map((log) => this.serialize(log)).join("");
    this.writeStream.write(data, (err) => {
      resultCallback({
        code: err ? import_core.ExportResultCode.FAILED : import_core.ExportResultCode.SUCCESS,
        error: err || void 0
      });
    });
  }
  async forceFlush() {
  }
};
var FileMetricExporter = class extends FileExporter {
  static {
    __name(this, "FileMetricExporter");
  }
  export(metrics, resultCallback) {
    const data = this.serialize(metrics);
    this.writeStream.write(data, (err) => {
      resultCallback({
        code: err ? import_core.ExportResultCode.FAILED : import_core.ExportResultCode.SUCCESS,
        error: err || void 0
      });
    });
  }
  getPreferredAggregationTemporality() {
    return import_sdk_metrics.AggregationTemporality.CUMULATIVE;
  }
  async forceFlush() {
    return Promise.resolve();
  }
};

// packages/core/src/telemetry/otlp-urls.ts
init_esbuild_shims();
var OTLP_SIGNAL_PATHS = {
  traces: "v1/traces",
  logs: "v1/logs",
  metrics: "v1/metrics"
};
function resolveHttpOtlpUrl(baseEndpoint, signal) {
  const signalPath = OTLP_SIGNAL_PATHS[signal];
  const url = new URL(baseEndpoint);
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (normalizedPath.endsWith(signalPath)) {
    return url.href;
  }
  url.pathname = normalizedPath + "/" + signalPath;
  return url.href;
}
__name(resolveHttpOtlpUrl, "resolveHttpOtlpUrl");

// packages/core/src/telemetry/sdk-impl.ts
var NOOP_PROPAGATOR = {
  inject() {
  },
  extract(context) {
    return context;
  },
  fields() {
    return [];
  }
};
function parseOtlpEndpoint(otlpEndpointSetting, protocol) {
  if (!otlpEndpointSetting) {
    return void 0;
  }
  const trimmedEndpoint = otlpEndpointSetting.replace(/^["']|["']$/g, "");
  try {
    const url = new URL(trimmedEndpoint);
    if (protocol === "grpc") {
      return url.origin;
    }
    return url.href;
  } catch (error) {
    diag.error("Invalid OTLP endpoint URL provided:", trimmedEndpoint, error);
    return void 0;
  }
}
__name(parseOtlpEndpoint, "parseOtlpEndpoint");
function validateUrl(url) {
  if (!url) return void 0;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      diag.error(
        `OTLP endpoint must use http or https, got ${parsed.protocol}`
      );
      return void 0;
    }
    if (!parsed.hostname) {
      diag.error("OTLP endpoint missing hostname");
      return void 0;
    }
    return url;
  } catch {
    diag.error("Invalid OTLP signal endpoint URL, skipping:", url);
    return void 0;
  }
}
__name(validateUrl, "validateUrl");
var SessionIdSpanProcessor = class {
  static {
    __name(this, "SessionIdSpanProcessor");
  }
  onStart(span, parentContext) {
    try {
      const existingSessionId = span.attributes["session.id"];
      if (typeof existingSessionId === "string" && existingSessionId) return;
      const sessionId = getSessionIdFromContext(parentContext) ?? (sessionIdContext.getStore() || getCurrentSessionId());
      if (sessionId) {
        span.setAttribute("session.id", sessionId);
      }
    } catch {
    }
  }
  onEnd(_span) {
  }
  async shutdown() {
  }
  async forceFlush() {
  }
};
async function startTelemetrySdk(config) {
  const debugLogger = createDebugLogger("OTEL");
  const userAttrs = config.getTelemetryResourceAttributes() ?? {};
  const userServiceName = userAttrs["service.name"];
  const {
    "service.name": _ignoredServiceName,
    "service.version": _ignoredServiceVersion,
    "session.id": _ignoredSessionId,
    ...nonReservedUserAttrs
  } = userAttrs;
  const resource = (0, import_resources.resourceFromAttributes)({
    ...nonReservedUserAttrs,
    // `.trim() || SERVICE_NAME`: catches both empty string (`""`) and
    // whitespace-only values (`" "`, `"\t"`) that would otherwise produce
    // a blank service name on Resource (some backends reject these). Both
    // settings (no value trimming there) and env (`%20` decodes to `" "`)
    // can deliver whitespace-only values, so trim at the fallback point.
    [SemanticResourceAttributes.SERVICE_NAME]: userServiceName?.trim() || SERVICE_NAME,
    [SemanticResourceAttributes.SERVICE_VERSION]: config.getCliVersion() || "unknown"
  });
  const attrWarnings = config.getTelemetryResourceAttributeWarnings() ?? [];
  if (attrWarnings.length > 0) {
    console.warn(
      `[qwen-code telemetry] ${attrWarnings.length} resource attribute issue(s):`
    );
    for (const w of attrWarnings) {
      console.warn(`  - ${w}`);
    }
  }
  const otlpEndpoint = config.getTelemetryOtlpEndpoint();
  const otlpProtocol = config.getTelemetryOtlpProtocol();
  const parsedEndpoint = parseOtlpEndpoint(otlpEndpoint, otlpProtocol);
  const telemetryOutfile = config.getTelemetryOutfile();
  const hasPerSignalEndpoint = !!config.getTelemetryOtlpTracesEndpoint() || !!config.getTelemetryOtlpLogsEndpoint() || !!config.getTelemetryOtlpMetricsEndpoint();
  const useOtlp = (!!parsedEndpoint || hasPerSignalEndpoint) && !telemetryOutfile;
  let spanExporter;
  let logExporter;
  let metricReader;
  let logToSpanProcessor;
  if (useOtlp) {
    if (otlpProtocol === "http") {
      const tracesUrl = validateUrl(
        config.getTelemetryOtlpTracesEndpoint() ?? (parsedEndpoint ? resolveHttpOtlpUrl(parsedEndpoint, "traces") : void 0)
      );
      const logsUrl = validateUrl(
        config.getTelemetryOtlpLogsEndpoint() ?? (parsedEndpoint ? resolveHttpOtlpUrl(parsedEndpoint, "logs") : void 0)
      );
      const metricsUrl = validateUrl(
        config.getTelemetryOtlpMetricsEndpoint() ?? (parsedEndpoint ? resolveHttpOtlpUrl(parsedEndpoint, "metrics") : void 0)
      );
      debugLogger.debug(
        `OTLP HTTP endpoints: traces=${tracesUrl ?? "none"}, logs=${logsUrl ?? "none"}, metrics=${metricsUrl ?? "none"}`
      );
      if (tracesUrl || logsUrl || metricsUrl) {
        const { createHttpExporters } = await import("./sdk-exporters-http-SWXTEEVT.js");
        const httpExporters = createHttpExporters({
          tracesUrl,
          logsUrl,
          metricsUrl,
          logToSpan: {
            includeSensitiveSpanAttributes: config.getTelemetryIncludeSensitiveSpanAttributes(),
            // In interactive (TUI) mode, route bridge diagnostics to the OTEL
            // debug log file so they don't break out of the Ink render area
            // via raw stderr. In non-interactive mode, leave the default sink
            // alone so CI / scripts can still see export failures on stderr
            // the canonical diagnostic channel for batch runs.
            //
            // Caveat for interactive mode: when the user has explicitly
            // disabled file logging via QWEN_DEBUG_LOG_FILE=0, debugLogger.warn
            // silently no-ops and bridge diagnostics are fully lost — accepted
            // trade-off, since falling back to stderr would re-introduce the
            // TUI pollution this injection was added to prevent.
            ...config.isInteractive() && {
              diagnosticsSink: /* @__PURE__ */ __name((message) => debugLogger.warn(message), "diagnosticsSink")
            }
          }
        });
        spanExporter = httpExporters.spanExporter;
        logExporter = httpExporters.logExporter;
        metricReader = httpExporters.metricReader;
        logToSpanProcessor = httpExporters.logToSpanProcessor;
      }
    } else {
      if (!parsedEndpoint) {
        const warning = 'Per-signal OTLP endpoints are only supported with HTTP protocol. Set otlpProtocol to "http" or provide a base otlpEndpoint for gRPC. Telemetry SDK startup was skipped because no supported gRPC endpoint was configured.';
        diag.warn(warning);
        debugLogger.warn(warning);
        return void 0;
      } else {
        const { createGrpcExporters } = await import("./sdk-exporters-grpc-Y2ZUQDUQ.js");
        const grpcExporters = createGrpcExporters(parsedEndpoint);
        spanExporter = grpcExporters.spanExporter;
        logExporter = grpcExporters.logExporter;
        metricReader = grpcExporters.metricReader;
      }
    }
  } else if (telemetryOutfile) {
    spanExporter = new FileSpanExporter(telemetryOutfile);
    logExporter = new FileLogExporter(telemetryOutfile);
    metricReader = new import_sdk_metrics2.PeriodicExportingMetricReader({
      exporter: new FileMetricExporter(telemetryOutfile),
      exportIntervalMillis: 1e4
    });
  }
  function normalizeOtlpPrefix(raw) {
    if (!raw) return void 0;
    const s = raw.trim().replace(/^["']|["']$/g, "");
    try {
      const u = new URL(s);
      const pathname = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
      return { origin: u.origin, pathname };
    } catch {
      diag.warn(
        `Telemetry OTLP endpoint "${raw}" is not a valid URL; instrumentation feedback-loop guard for it is disabled.`
      );
      return void 0;
    }
  }
  __name(normalizeOtlpPrefix, "normalizeOtlpPrefix");
  const otlpUrlPrefixes = [
    config.getTelemetryOtlpEndpoint(),
    config.getTelemetryOtlpTracesEndpoint(),
    config.getTelemetryOtlpLogsEndpoint(),
    config.getTelemetryOtlpMetricsEndpoint()
  ].map(normalizeOtlpPrefix).filter((u) => !!u);
  const matchesOtlpPrefix = /* @__PURE__ */ __name((origin, path2) => {
    for (const prefix of otlpUrlPrefixes) {
      if (origin !== prefix.origin) continue;
      if (prefix.pathname === "") return true;
      if (!path2.startsWith(prefix.pathname)) continue;
      const next = path2.charAt(prefix.pathname.length);
      if (next === "" || next === "/" || next === "?" || next === "#") {
        return true;
      }
    }
    return false;
  }, "matchesOtlpPrefix");
  const stripPathSuffix = /* @__PURE__ */ __name((path2) => {
    const qIdx = path2.indexOf("?");
    const fIdx = path2.indexOf("#");
    let cut = path2.length;
    if (qIdx !== -1) cut = Math.min(cut, qIdx);
    if (fIdx !== -1) cut = Math.min(cut, fIdx);
    return path2.slice(0, cut);
  }, "stripPathSuffix");
  const textMapPropagator = config.getOutboundCorrelationPropagateTraceContext() ? void 0 : NOOP_PROPAGATOR;
  const spanAttributeValueLengthLimit = (0, import_core2.getNumberFromEnv)("OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT") ?? (0, import_core2.getNumberFromEnv)("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT") ?? Infinity;
  configureContextUsageAttributeLengthLimit(spanAttributeValueLengthLimit);
  const sdk = new import_sdk_node.NodeSDK({
    resource,
    // Disable async host/process/env resource detectors: they leave attributes
    // pending and trigger an OTel diag.error on any resource attribute read
    // before the detectors settle (e.g. during HttpInstrumentation span creation).
    autoDetectResources: false,
    ...textMapPropagator && { textMapPropagator },
    spanLimits: {
      attributeValueLengthLimit: spanAttributeValueLengthLimit
    },
    spanProcessors: spanExporter ? [new SessionIdSpanProcessor(), new import_sdk_trace_node.BatchSpanProcessor(spanExporter)] : [],
    logRecordProcessors: logExporter ? [new import_sdk_logs.BatchLogRecordProcessor({ exporter: logExporter })] : logToSpanProcessor ? [logToSpanProcessor] : [],
    // In 0.221, omitting both metrics fields enables constructor-time env
    // fallback. An explicit empty array keeps metrics disabled when qwen-code
    // has no configured reader, before the start() env scrub can take effect.
    metricReaders: metricReader ? [metricReader] : [],
    instrumentations: [
      new import_instrumentation_http.HttpInstrumentation({
        // OTLP HTTP exporter uses node:http (patched here, not by undici).
        // Without this, every OTLP upload batch creates a parasitic client
        // span that itself gets exported → feedback loop.
        ignoreOutgoingRequestHook: /* @__PURE__ */ __name((req) => {
          if (otlpUrlPrefixes.length === 0) return false;
          const proto = req.protocol ? String(req.protocol).replace(/:$/, "") : void 0;
          if (!proto) return false;
          let host = req.hostname || "";
          if (!host && req.host) {
            const h = String(req.host);
            const bracketEnd = h.indexOf("]");
            const portIdx = bracketEnd !== -1 ? h.indexOf(":", bracketEnd) : h.indexOf(":");
            host = portIdx !== -1 ? h.slice(0, portIdx) : h;
          }
          const portPart = req.port !== void 0 && req.port !== null && String(req.port) ? `:${req.port}` : "";
          let origin;
          try {
            origin = new URL(`${proto}://${host}${portPart}`).origin;
          } catch {
            return false;
          }
          const path2 = typeof req.path === "string" ? stripPathSuffix(req.path) : "";
          return matchesOtlpPrefix(origin, path2);
        }, "ignoreOutgoingRequestHook")
      }),
      // Modern fetch (`globalThis.fetch` / undici) is the HTTP layer used by
      // `openai`, `@google/genai`, and `@anthropic-ai/sdk`. Without this
      // instrumentation, outbound LLM requests carry no `traceparent` header
      // and the trace tree terminates at the qwen-code process boundary.
      new import_instrumentation_undici.UndiciInstrumentation({
        ignoreRequestHook: /* @__PURE__ */ __name((request) => {
          if (otlpUrlPrefixes.length === 0) return false;
          const path2 = typeof request.path === "string" ? stripPathSuffix(request.path) : "";
          return matchesOtlpPrefix(request.origin, path2);
        }, "ignoreRequestHook")
      })
    ]
  });
  setDaemonFallbackPropagator(new import_core2.W3CTraceContextPropagator());
  return { sdk, metricReader };
}
__name(startTelemetrySdk, "startTelemetrySdk");
export {
  startTelemetrySdk
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
