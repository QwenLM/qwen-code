// Force strict mode and setup for ESM
"use strict";
import {
  require_src as require_src2,
  require_src3
} from "./chunk-7NXSVSFB.js";
import {
  require_src
} from "./chunk-74TONY4F.js";
import {
  createNoopMeter,
  diag,
  esm_exports,
  init_esm
} from "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __commonJS,
  __esm,
  __export,
  __name,
  __toCommonJS,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/configuration/legacy-node-configuration.js
var CompressionAlgorithm;
var init_legacy_node_configuration = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/configuration/legacy-node-configuration.js"() {
    init_esbuild_shims();
    (function(CompressionAlgorithm2) {
      CompressionAlgorithm2["NONE"] = "none";
      CompressionAlgorithm2["GZIP"] = "gzip";
    })(CompressionAlgorithm || (CompressionAlgorithm = {}));
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/OTLPExporterBase.js
var OTLPExporterBase;
var init_OTLPExporterBase = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/OTLPExporterBase.js"() {
    init_esbuild_shims();
    OTLPExporterBase = class {
      static {
        __name(this, "OTLPExporterBase");
      }
      _delegate;
      constructor(delegate) {
        this._delegate = delegate;
      }
      /**
       * Export items.
       * @param items
       * @param resultCallback
       */
      export(items, resultCallback) {
        this._delegate.export(items, resultCallback);
      }
      forceFlush() {
        return this._delegate.forceFlush();
      }
      shutdown() {
        return this._delegate.shutdown();
      }
      setMetrics(metrics) {
        this._delegate.setMetrics(metrics);
      }
    };
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/types.js
var OTLPExporterError;
var init_types = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/types.js"() {
    init_esbuild_shims();
    OTLPExporterError = class extends Error {
      static {
        __name(this, "OTLPExporterError");
      }
      code;
      name = "OTLPExporterError";
      data;
      constructor(message, code, data) {
        super(message);
        this.data = data;
        this.code = code;
      }
    };
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/configuration/shared-configuration.js
function validateTimeoutMillis(timeoutMillis) {
  if (Number.isFinite(timeoutMillis) && timeoutMillis > 0) {
    return timeoutMillis;
  }
  throw new Error(`Configuration: timeoutMillis is invalid, expected number greater than 0 (actual: '${timeoutMillis}')`);
}
function wrapStaticHeadersInFunction(headers) {
  if (headers == null) {
    return void 0;
  }
  return async () => headers;
}
function mergeOtlpSharedConfigurationWithDefaults(userProvidedConfiguration, fallbackConfiguration, defaultConfiguration) {
  return {
    timeoutMillis: validateTimeoutMillis(userProvidedConfiguration.timeoutMillis ?? fallbackConfiguration.timeoutMillis ?? defaultConfiguration.timeoutMillis),
    concurrencyLimit: userProvidedConfiguration.concurrencyLimit ?? fallbackConfiguration.concurrencyLimit ?? defaultConfiguration.concurrencyLimit,
    compression: userProvidedConfiguration.compression ?? fallbackConfiguration.compression ?? defaultConfiguration.compression
  };
}
function getSharedConfigurationDefaults() {
  return {
    timeoutMillis: 1e4,
    concurrencyLimit: 30,
    compression: "none"
  };
}
var init_shared_configuration = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/configuration/shared-configuration.js"() {
    init_esbuild_shims();
    __name(validateTimeoutMillis, "validateTimeoutMillis");
    __name(wrapStaticHeadersInFunction, "wrapStaticHeadersInFunction");
    __name(mergeOtlpSharedConfigurationWithDefaults, "mergeOtlpSharedConfigurationWithDefaults");
    __name(getSharedConfigurationDefaults, "getSharedConfigurationDefaults");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/bounded-queue-export-promise-handler.js
function createBoundedQueueExportPromiseHandler(options) {
  return new BoundedQueueExportPromiseHandler(options.concurrencyLimit);
}
var BoundedQueueExportPromiseHandler;
var init_bounded_queue_export_promise_handler = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/bounded-queue-export-promise-handler.js"() {
    init_esbuild_shims();
    BoundedQueueExportPromiseHandler = class {
      static {
        __name(this, "BoundedQueueExportPromiseHandler");
      }
      _concurrencyLimit;
      _sendingPromises = [];
      /**
       * @param concurrencyLimit maximum promises allowed in a queue at the same time.
       */
      constructor(concurrencyLimit) {
        this._concurrencyLimit = concurrencyLimit;
      }
      pushPromise(promise) {
        if (this.hasReachedLimit()) {
          throw new Error("Concurrency Limit reached");
        }
        this._sendingPromises.push(promise);
        const popPromise = /* @__PURE__ */ __name(() => {
          const index = this._sendingPromises.indexOf(promise);
          void this._sendingPromises.splice(index, 1);
        }, "popPromise");
        promise.then(popPromise, popPromise);
      }
      hasReachedLimit() {
        return this._sendingPromises.length >= this._concurrencyLimit;
      }
      async awaitAll() {
        await Promise.all(this._sendingPromises);
      }
    };
    __name(createBoundedQueueExportPromiseHandler, "createBoundedQueueExportPromiseHandler");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/logging-response-handler.js
function isPartialSuccessResponse(response) {
  return Object.prototype.hasOwnProperty.call(response, "partialSuccess");
}
function createLoggingPartialSuccessResponseHandler() {
  return {
    handleResponse(response) {
      if (response == null || !isPartialSuccessResponse(response) || response.partialSuccess == null || Object.keys(response.partialSuccess).length === 0) {
        return;
      }
      diag.warn("Received Partial Success response:", JSON.stringify(response.partialSuccess));
    }
  };
}
var init_logging_response_handler = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/logging-response-handler.js"() {
    init_esbuild_shims();
    init_esm();
    __name(isPartialSuccessResponse, "isPartialSuccessResponse");
    __name(createLoggingPartialSuccessResponseHandler, "createLoggingPartialSuccessResponseHandler");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/otlp-export-delegate.js
function createOtlpExportDelegate(components, settings) {
  return new OTLPExportDelegate(components.transport, components.serializer, createLoggingPartialSuccessResponseHandler(), components.promiseHandler, components.metrics, settings.timeout);
}
var import_core, OTLPExportDelegate;
var init_otlp_export_delegate = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/otlp-export-delegate.js"() {
    init_esbuild_shims();
    import_core = __toESM(require_src2());
    init_types();
    init_logging_response_handler();
    init_esm();
    OTLPExportDelegate = class {
      static {
        __name(this, "OTLPExportDelegate");
      }
      _metrics;
      _diagLogger;
      _transport;
      _serializer;
      _responseHandler;
      _promiseQueue;
      _timeout;
      constructor(transport, serializer, responseHandler, promiseQueue, metrics, timeout) {
        this._transport = transport;
        this._serializer = serializer;
        this._responseHandler = responseHandler;
        this._promiseQueue = promiseQueue;
        this._timeout = timeout;
        this._diagLogger = diag.createComponentLogger({
          namespace: "OTLPExportDelegate"
        });
        this._metrics = metrics;
      }
      export(internalRepresentation, resultCallback) {
        this._diagLogger.debug("items to be sent", internalRepresentation);
        if (this._promiseQueue.hasReachedLimit()) {
          resultCallback({
            code: import_core.ExportResultCode.FAILED,
            error: new Error("Concurrent export limit reached")
          });
          return;
        }
        const serializedRequest = this._serializer.serializeRequest(internalRepresentation);
        if (serializedRequest == null) {
          resultCallback({
            code: import_core.ExportResultCode.FAILED,
            error: new Error("Nothing to send")
          });
          return;
        }
        const finishExport = this._metrics.startExport(internalRepresentation);
        this._promiseQueue.pushPromise(this._transport.send(serializedRequest, this._timeout).then((response) => {
          if (response.status === "success") {
            finishExport(void 0);
            if (response.data != null) {
              try {
                this._responseHandler.handleResponse(this._serializer.deserializeResponse(response.data));
              } catch (e) {
                this._diagLogger.warn("Export succeeded but could not deserialize response - is the response specification compliant?", e, response.data);
              }
            }
            resultCallback({
              code: import_core.ExportResultCode.SUCCESS
            });
            return;
          } else if (response.status === "failure" && response.error) {
            finishExport(response.error);
            resultCallback({
              code: import_core.ExportResultCode.FAILED,
              error: response.error
            });
            return;
          } else if (response.status === "retryable") {
            finishExport("export_max_retries");
            resultCallback({
              code: import_core.ExportResultCode.FAILED,
              error: response.error ?? new OTLPExporterError("Export failed with retryable status")
            });
          } else {
            finishExport("export_failed");
            resultCallback({
              code: import_core.ExportResultCode.FAILED,
              error: new OTLPExporterError("Export failed with unknown error")
            });
          }
        }, (reason) => {
          finishExport(reason);
          resultCallback({
            code: import_core.ExportResultCode.FAILED,
            error: reason
          });
        }));
      }
      forceFlush() {
        return this._promiseQueue.awaitAll();
      }
      setMetrics(metrics) {
        this._metrics = metrics;
      }
      async shutdown() {
        this._diagLogger.debug("shutdown started");
        await this.forceFlush();
        this._transport.shutdown();
      }
    };
    __name(createOtlpExportDelegate, "createOtlpExportDelegate");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/otlp-network-export-delegate.js
function createOtlpNetworkExportDelegate(options, serializer, metrics, transport) {
  return createOtlpExportDelegate({
    transport,
    serializer,
    promiseHandler: createBoundedQueueExportPromiseHandler(options),
    metrics
  }, { timeout: options.timeoutMillis });
}
var init_otlp_network_export_delegate = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/otlp-network-export-delegate.js"() {
    init_esbuild_shims();
    init_bounded_queue_export_promise_handler();
    init_otlp_export_delegate();
    __name(createOtlpNetworkExportDelegate, "createOtlpNetworkExportDelegate");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/semconv.js
var ATTR_HTTP_RESPONSE_STATUS_CODE, ATTR_OTEL_COMPONENT_NAME, ATTR_OTEL_COMPONENT_TYPE, ATTR_SERVER_ADDRESS, ATTR_SERVER_PORT, ATTR_ERROR_TYPE;
var init_semconv = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/semconv.js"() {
    init_esbuild_shims();
    ATTR_HTTP_RESPONSE_STATUS_CODE = "http.response.status_code";
    ATTR_OTEL_COMPONENT_NAME = "otel.component.name";
    ATTR_OTEL_COMPONENT_TYPE = "otel.component.type";
    ATTR_SERVER_ADDRESS = "server.address";
    ATTR_SERVER_PORT = "server.port";
    ATTR_ERROR_TYPE = "error.type";
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/version.js
var VERSION;
var init_version = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/version.js"() {
    init_esbuild_shims();
    VERSION = "0.221.0";
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/ExporterMetrics.js
var import_core2, componentCounter, ExporterMetrics;
var init_ExporterMetrics = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/ExporterMetrics.js"() {
    init_esbuild_shims();
    init_esm();
    import_core2 = __toESM(require_src2());
    init_semconv();
    init_version();
    componentCounter = /* @__PURE__ */ new Map();
    ExporterMetrics = class {
      static {
        __name(this, "ExporterMetrics");
      }
      inflight;
      exported;
      duration;
      standardAttrs;
      responseAttributesFromError;
      helper;
      constructor(options) {
        const { componentType, metricsHelper, meterProvider, url, responseAttributesFromError } = options;
        this.responseAttributesFromError = responseAttributesFromError;
        const meter = meterProvider ? meterProvider.getMeter("@opentelemetry/otlp-exporter", VERSION) : createNoopMeter();
        const counter = componentCounter.get(componentType) ?? 0;
        componentCounter.set(componentType, counter + 1);
        this.standardAttrs = {
          [ATTR_OTEL_COMPONENT_TYPE]: componentType,
          [ATTR_OTEL_COMPONENT_NAME]: `${componentType}/${counter}`
        };
        if (url) {
          let urlToParse = url;
          if (!url.includes("://")) {
            urlToParse = `http://${url}`;
          }
          try {
            const parsedUrl = new URL(urlToParse);
            this.standardAttrs[ATTR_SERVER_ADDRESS] = parsedUrl.hostname;
            let port = void 0;
            if (parsedUrl.port) {
              port = Number(parsedUrl.port);
            } else if (parsedUrl.protocol === "http:") {
              port = 80;
            } else if (parsedUrl.protocol === "https:") {
              port = 443;
            }
            if (typeof port === "number") {
              this.standardAttrs[ATTR_SERVER_PORT] = port;
            }
          } catch {
          }
        }
        this.helper = metricsHelper;
        this.inflight = meter.createUpDownCounter(`otel.sdk.exporter.${this.helper.name}.inflight`, {
          unit: `{${this.helper.name}}`,
          description: `The number of ${this.helper.name}s which were passed to the exporter, but that have not been exported yet (neither successful, nor failed).`
        });
        this.exported = meter.createCounter(`otel.sdk.exporter.${this.helper.name}.exported`, {
          unit: `{${this.helper.name}}`,
          description: `The number of ${this.helper.name}s for which the export has finished, either successful or failed.`
        });
        this.duration = meter.createHistogram("otel.sdk.exporter.operation.duration", {
          unit: "s",
          description: "The duration of exporting a batch of telemetry records.",
          advice: {
            explicitBucketBoundaries: []
          }
        });
      }
      startExport(request) {
        const numItems = this.helper.countItems(request);
        const startTime = (0, import_core2.hrTime)();
        this.inflight.add(numItems, this.standardAttrs);
        return (error) => {
          const endTime = (0, import_core2.hrTime)();
          this.inflight.add(-numItems, this.standardAttrs);
          const exportedAttrs = error ? {
            ...this.standardAttrs,
            [ATTR_ERROR_TYPE]: error instanceof Error ? error.name : "export_failed"
          } : this.standardAttrs;
          this.exported.add(numItems, exportedAttrs);
          const durationAttrs = {
            ...exportedAttrs,
            ...this.responseAttributesFromError(error)
          };
          const duration = (0, import_core2.hrTimeToMilliseconds)((0, import_core2.hrTimeDuration)(startTime, endTime)) / 1e3;
          this.duration.record(duration, durationAttrs);
        };
      }
    };
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/index.js
var esm_exports2 = {};
__export(esm_exports2, {
  CompressionAlgorithm: () => CompressionAlgorithm,
  ExporterMetrics: () => ExporterMetrics,
  OTLPExporterBase: () => OTLPExporterBase,
  OTLPExporterError: () => OTLPExporterError,
  createOtlpNetworkExportDelegate: () => createOtlpNetworkExportDelegate,
  getSharedConfigurationDefaults: () => getSharedConfigurationDefaults,
  mergeOtlpSharedConfigurationWithDefaults: () => mergeOtlpSharedConfigurationWithDefaults
});
var init_esm2 = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/index.js"() {
    init_esbuild_shims();
    init_OTLPExporterBase();
    init_types();
    init_shared_configuration();
    init_legacy_node_configuration();
    init_otlp_network_export_delegate();
    init_ExporterMetrics();
  }
});

// packages/core/node_modules/@opentelemetry/exporter-metrics-otlp-http/build/src/OTLPMetricExporterOptions.js
var require_OTLPMetricExporterOptions = __commonJS({
  "packages/core/node_modules/@opentelemetry/exporter-metrics-otlp-http/build/src/OTLPMetricExporterOptions.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AggregationTemporalityPreference = void 0;
    var AggregationTemporalityPreference;
    (function(AggregationTemporalityPreference2) {
      AggregationTemporalityPreference2[AggregationTemporalityPreference2["DELTA"] = 0] = "DELTA";
      AggregationTemporalityPreference2[AggregationTemporalityPreference2["CUMULATIVE"] = 1] = "CUMULATIVE";
      AggregationTemporalityPreference2[AggregationTemporalityPreference2["LOWMEMORY"] = 2] = "LOWMEMORY";
    })(AggregationTemporalityPreference || (exports.AggregationTemporalityPreference = AggregationTemporalityPreference = {}));
  }
});

// packages/core/node_modules/@opentelemetry/exporter-metrics-otlp-http/build/src/OTLPMetricExporterBase.js
var require_OTLPMetricExporterBase = __commonJS({
  "packages/core/node_modules/@opentelemetry/exporter-metrics-otlp-http/build/src/OTLPMetricExporterBase.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OTLPMetricExporterBase = exports.LowMemoryTemporalitySelector = exports.DeltaTemporalitySelector = exports.CumulativeTemporalitySelector = void 0;
    var core_1 = require_src2();
    var sdk_metrics_1 = require_src3();
    var OTLPMetricExporterOptions_1 = require_OTLPMetricExporterOptions();
    var otlp_exporter_base_1 = (init_esm2(), __toCommonJS(esm_exports2));
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var CumulativeTemporalitySelector = /* @__PURE__ */ __name(() => sdk_metrics_1.AggregationTemporality.CUMULATIVE, "CumulativeTemporalitySelector");
    exports.CumulativeTemporalitySelector = CumulativeTemporalitySelector;
    var DeltaTemporalitySelector = /* @__PURE__ */ __name((instrumentType) => {
      switch (instrumentType) {
        case sdk_metrics_1.InstrumentType.COUNTER:
        case sdk_metrics_1.InstrumentType.OBSERVABLE_COUNTER:
        case sdk_metrics_1.InstrumentType.GAUGE:
        case sdk_metrics_1.InstrumentType.HISTOGRAM:
        case sdk_metrics_1.InstrumentType.OBSERVABLE_GAUGE:
          return sdk_metrics_1.AggregationTemporality.DELTA;
        case sdk_metrics_1.InstrumentType.UP_DOWN_COUNTER:
        case sdk_metrics_1.InstrumentType.OBSERVABLE_UP_DOWN_COUNTER:
          return sdk_metrics_1.AggregationTemporality.CUMULATIVE;
      }
    }, "DeltaTemporalitySelector");
    exports.DeltaTemporalitySelector = DeltaTemporalitySelector;
    var LowMemoryTemporalitySelector = /* @__PURE__ */ __name((instrumentType) => {
      switch (instrumentType) {
        case sdk_metrics_1.InstrumentType.COUNTER:
        case sdk_metrics_1.InstrumentType.HISTOGRAM:
          return sdk_metrics_1.AggregationTemporality.DELTA;
        case sdk_metrics_1.InstrumentType.GAUGE:
        case sdk_metrics_1.InstrumentType.UP_DOWN_COUNTER:
        case sdk_metrics_1.InstrumentType.OBSERVABLE_UP_DOWN_COUNTER:
        case sdk_metrics_1.InstrumentType.OBSERVABLE_COUNTER:
        case sdk_metrics_1.InstrumentType.OBSERVABLE_GAUGE:
          return sdk_metrics_1.AggregationTemporality.CUMULATIVE;
      }
    }, "LowMemoryTemporalitySelector");
    exports.LowMemoryTemporalitySelector = LowMemoryTemporalitySelector;
    function chooseTemporalitySelectorFromEnvironment() {
      const configuredTemporality = ((0, core_1.getStringFromEnv)("OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE") ?? "cumulative").toLowerCase();
      if (configuredTemporality === "cumulative") {
        return exports.CumulativeTemporalitySelector;
      }
      if (configuredTemporality === "delta") {
        return exports.DeltaTemporalitySelector;
      }
      if (configuredTemporality === "lowmemory") {
        return exports.LowMemoryTemporalitySelector;
      }
      api_1.diag.warn(`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE is set to '${configuredTemporality}', but only 'cumulative' and 'delta' are allowed. Using default ('cumulative') instead.`);
      return exports.CumulativeTemporalitySelector;
    }
    __name(chooseTemporalitySelectorFromEnvironment, "chooseTemporalitySelectorFromEnvironment");
    function chooseTemporalitySelector(temporalityPreference) {
      if (temporalityPreference != null) {
        if (temporalityPreference === OTLPMetricExporterOptions_1.AggregationTemporalityPreference.DELTA) {
          return exports.DeltaTemporalitySelector;
        } else if (temporalityPreference === OTLPMetricExporterOptions_1.AggregationTemporalityPreference.LOWMEMORY) {
          return exports.LowMemoryTemporalitySelector;
        }
        return exports.CumulativeTemporalitySelector;
      }
      return chooseTemporalitySelectorFromEnvironment();
    }
    __name(chooseTemporalitySelector, "chooseTemporalitySelector");
    var DEFAULT_AGGREGATION = Object.freeze({
      type: sdk_metrics_1.AggregationType.DEFAULT
    });
    function chooseAggregationSelector(config) {
      return config?.aggregationPreference ?? (() => DEFAULT_AGGREGATION);
    }
    __name(chooseAggregationSelector, "chooseAggregationSelector");
    var OTLPMetricExporterBase = class extends otlp_exporter_base_1.OTLPExporterBase {
      static {
        __name(this, "OTLPMetricExporterBase");
      }
      _aggregationTemporalitySelector;
      _aggregationSelector;
      constructor(delegate, config) {
        super(delegate);
        this._aggregationSelector = chooseAggregationSelector(config);
        this._aggregationTemporalitySelector = chooseTemporalitySelector(config?.temporalityPreference);
      }
      selectAggregation(instrumentType) {
        return this._aggregationSelector(instrumentType);
      }
      selectAggregationTemporality(instrumentType) {
        return this._aggregationTemporalitySelector(instrumentType);
      }
    };
    exports.OTLPMetricExporterBase = OTLPMetricExporterBase;
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/metrics/index.js
var require_metrics = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/metrics/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MetricsExporterMetricsHelper = void 0;
    exports.MetricsExporterMetricsHelper = {
      name: "metric_data_point",
      countItems: /* @__PURE__ */ __name((request) => {
        let count = 0;
        for (const scopeMetrics of request.scopeMetrics) {
          for (const metric of scopeMetrics.metrics) {
            count += metric.dataPoints.length;
          }
        }
        return count;
      }, "countItems")
    };
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/trace/index.js
var require_trace = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/trace/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.TraceExporterMetricsHelper = void 0;
    exports.TraceExporterMetricsHelper = {
      name: "span",
      countItems: /* @__PURE__ */ __name((request) => request.length, "countItems")
    };
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/logs/index.js
var require_logs = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/logs/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.LogsExporterMetricsHelper = void 0;
    exports.LogsExporterMetricsHelper = {
      name: "log",
      countItems: /* @__PURE__ */ __name((request) => request.length, "countItems")
    };
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/common/protobuf/utils.js
var require_utils = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/common/protobuf/utils.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.estimateVarintSize = void 0;
    function estimateVarintSize(v) {
      if (v < 0)
        return 10;
      if (v < 128)
        return 1;
      if (v < 16384)
        return 2;
      if (v < 2097152)
        return 3;
      if (v < 268435456)
        return 4;
      if (v < 34359738368)
        return 5;
      if (v < 4398046511104)
        return 6;
      if (v < 562949953421312)
        return 7;
      if (v < 72057594037927940)
        return 8;
      return 9;
    }
    __name(estimateVarintSize, "estimateVarintSize");
    exports.estimateVarintSize = estimateVarintSize;
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/common/protobuf/protobuf-writer.js
var require_protobuf_writer = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/common/protobuf/protobuf-writer.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ProtobufWriter = exports.GROWING_BUFFER_DEBUG_MESSAGE = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var utils_1 = require_utils();
    exports.GROWING_BUFFER_DEBUG_MESSAGE = "ProtobufWriter: estimated size was too small, growing buffer.";
    var RESERVED_LENGTH_BYTES = 1;
    var ProtobufWriter = class {
      static {
        __name(this, "ProtobufWriter");
      }
      _buffer;
      // Avoid using TextEncoder type. While the global is there on all supported runtimes, types may differ.
      _textEncoder;
      _dataView;
      pos = 0;
      constructor(estimatedSize = 65536) {
        this._buffer = new Uint8Array(estimatedSize);
        this._textEncoder = new TextEncoder();
        this._dataView = new DataView(this._buffer.buffer, this._buffer.byteOffset);
      }
      /**
       * Ensure buffer has capacity for at least size more bytes
       */
      _ensureCapacity(size) {
        const needed = this.pos + size;
        if (needed <= this._buffer.length) {
          return;
        }
        api_1.diag.debug(exports.GROWING_BUFFER_DEBUG_MESSAGE);
        let newSize = this._buffer.length * 2;
        while (newSize < needed) {
          newSize *= 2;
        }
        const newBuffer = new Uint8Array(newSize);
        newBuffer.set(this._buffer);
        this._buffer = newBuffer;
        this._dataView = new DataView(this._buffer.buffer, this._buffer.byteOffset);
      }
      /**
       * Get the written bytes as a Uint8Array
       */
      finish() {
        return this._buffer.subarray(0, this.pos);
      }
      /**
       * Insert placeholder for length. Update later with {@link finishLengthDelimited}
       * Returns the position where to write the length.
       */
      startLengthDelimited() {
        const lengthPos = this.pos;
        this._ensureCapacity(RESERVED_LENGTH_BYTES);
        this.pos += RESERVED_LENGTH_BYTES;
        return lengthPos;
      }
      /**
       * Write length varint at placeholder position and shift content forward if needed.
       * Most messages are small (< 128 bytes), so we reserve 1 byte and only shift
       * when the length needs more bytes.
       */
      finishLengthDelimited(pos, length) {
        const v = length >>> 0;
        const varintSize = (0, utils_1.estimateVarintSize)(v);
        if (varintSize > RESERVED_LENGTH_BYTES) {
          const additionalBytes = varintSize - RESERVED_LENGTH_BYTES;
          this._ensureCapacity(additionalBytes);
          this._buffer.copyWithin(pos + varintSize, pos + RESERVED_LENGTH_BYTES, this.pos);
          this.pos += additionalBytes;
        }
        let writePos = pos;
        if (v < 128) {
          this._buffer[writePos] = v;
        } else if (v < 16384) {
          this._buffer[writePos++] = v & 127 | 128;
          this._buffer[writePos] = v >>> 7;
        } else if (v < 2097152) {
          this._buffer[writePos++] = v & 127 | 128;
          this._buffer[writePos++] = v >>> 7 & 127 | 128;
          this._buffer[writePos] = v >>> 14;
        } else if (v < 268435456) {
          this._buffer[writePos++] = v & 127 | 128;
          this._buffer[writePos++] = v >>> 7 & 127 | 128;
          this._buffer[writePos++] = v >>> 14 & 127 | 128;
          this._buffer[writePos] = v >>> 21;
        } else {
          this._buffer[writePos++] = v & 127 | 128;
          this._buffer[writePos++] = v >>> 7 & 127 | 128;
          this._buffer[writePos++] = v >>> 14 & 127 | 128;
          this._buffer[writePos++] = v >>> 21 & 127 | 128;
          this._buffer[writePos] = v >>> 28;
        }
      }
      /**
       * Write a sint32 value using zigzag encoding
       */
      writeSint32(value) {
        this.writeVarint((value << 1 ^ value >> 31) >>> 0);
      }
      /**
       * Write a signed 64-bit fixed integer (sfixed64) from a JS number.
       * Handles negative values via two's complement.
       */
      writeSfixed64(value) {
        let low;
        let high;
        if (value >= 0) {
          low = value >>> 0;
          high = value / 4294967296 >>> 0;
        } else {
          const abs = Math.abs(value);
          low = abs >>> 0;
          high = abs / 4294967296 >>> 0;
          low = ~low >>> 0;
          high = ~high >>> 0;
          low = low + 1 >>> 0;
          if (low === 0) {
            high = high + 1 >>> 0;
          }
        }
        this.writeFixed64(low, high);
      }
      /**
       * Write a varint (variable-length integer)
       */
      writeVarint(value) {
        this._ensureCapacity((0, utils_1.estimateVarintSize)(value));
        if (value >= 0 && value <= 4294967295) {
          let v = value >>> 0;
          while (v > 127) {
            this._buffer[this.pos++] = v & 127 | 128;
            v >>>= 7;
          }
          this._buffer[this.pos++] = v;
        } else {
          let low;
          let high;
          if (value >= 0) {
            low = value >>> 0;
            high = value / 4294967296 >>> 0;
          } else {
            const abs = Math.abs(value);
            low = abs >>> 0;
            high = abs / 4294967296 >>> 0;
            low = ~low >>> 0;
            high = ~high >>> 0;
            low = low + 1 >>> 0;
            if (low === 0) {
              high = high + 1 >>> 0;
            }
          }
          while (high > 0 || low > 127) {
            this._buffer[this.pos++] = low & 127 | 128;
            low = (low >>> 7 | high << 25) >>> 0;
            high >>>= 7;
          }
          this._buffer[this.pos++] = low & 127;
        }
      }
      /**
       * Write a 32-bit fixed integer (little-endian)
       */
      writeFixed32(value) {
        this._ensureCapacity(4);
        const v = value >>> 0;
        this._buffer[this.pos++] = v & 255;
        this._buffer[this.pos++] = v >>> 8 & 255;
        this._buffer[this.pos++] = v >>> 16 & 255;
        this._buffer[this.pos++] = v >>> 24 & 255;
      }
      /**
       * Write a 64-bit fixed integer (little-endian)
       * @param low - Low 32 bits
       * @param high - High 32 bits
       */
      writeFixed64(low, high) {
        this._ensureCapacity(8);
        const l = low >>> 0;
        const h = high >>> 0;
        this._buffer[this.pos++] = l & 255;
        this._buffer[this.pos++] = l >>> 8 & 255;
        this._buffer[this.pos++] = l >>> 16 & 255;
        this._buffer[this.pos++] = l >>> 24 & 255;
        this._buffer[this.pos++] = h & 255;
        this._buffer[this.pos++] = h >>> 8 & 255;
        this._buffer[this.pos++] = h >>> 16 & 255;
        this._buffer[this.pos++] = h >>> 24 & 255;
      }
      /**
       * Write length-delimited data (varint length + bytes)
       */
      writeBytes(bytes) {
        this.writeVarint(bytes.length);
        this._ensureCapacity(bytes.length);
        this._buffer.set(bytes, this.pos);
        this.pos += bytes.length;
      }
      /**
       * Write a field key (field number + wire type)
       */
      writeTag(fieldNumber, wireType) {
        this.writeVarint(fieldNumber << 3 | wireType);
      }
      /**
       * Write a double (64-bit IEEE 754)
       */
      writeDouble(value) {
        this._ensureCapacity(8);
        this._dataView.setFloat64(this.pos, value, true);
        this.pos += 8;
      }
      /**
       * Write a string as UTF-8 bytes (length-delimited)
       */
      writeString(str) {
        let isAscii = true;
        const len = str.length;
        for (let i = 0; i < len; i++) {
          if (str.charCodeAt(i) > 127) {
            isAscii = false;
            break;
          }
        }
        if (isAscii) {
          this.writeVarint(len);
          this._ensureCapacity(len);
          for (let i = 0; i < len; i++) {
            this._buffer[this.pos++] = str.charCodeAt(i);
          }
        } else {
          const bytes = this._textEncoder.encode(str);
          this.writeBytes(bytes);
        }
      }
    };
    exports.ProtobufWriter = ProtobufWriter;
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/common/hex-to-binary.js
var require_hex_to_binary = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/common/hex-to-binary.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.hexToBinary = void 0;
    function intValue(charCode) {
      if (charCode >= 48 && charCode <= 57) {
        return charCode - 48;
      }
      if (charCode >= 97 && charCode <= 102) {
        return charCode - 87;
      }
      return charCode - 55;
    }
    __name(intValue, "intValue");
    function hexToBinary(hexStr) {
      const buf = new Uint8Array(hexStr.length / 2);
      let offset = 0;
      for (let i = 0; i < hexStr.length; i += 2) {
        const hi = intValue(hexStr.charCodeAt(i));
        const lo = intValue(hexStr.charCodeAt(i + 1));
        buf[offset++] = hi << 4 | lo;
      }
      return buf;
    }
    __name(hexToBinary, "hexToBinary");
    exports.hexToBinary = hexToBinary;
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/common/protobuf/common-serializer.js
var require_common_serializer = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/common/protobuf/common-serializer.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.writeResource = exports.writeInstrumentationScope = exports.writeAnyValue = exports.writeKeyValue = exports.writeAttributes = exports.writeHrTimeAsFixed64 = void 0;
    function writeHrTimeAsFixed64(serializer, hrTime2) {
      const seconds = hrTime2[0];
      const nanos = hrTime2[1];
      const nanosPerSecond = 1e9;
      const secondsLower16Bits = seconds & 65535;
      const secondsUpperBits = seconds / 65536 >>> 0;
      const nanosFromLower16Bits = secondsLower16Bits * nanosPerSecond;
      const nanosFromUpperBits = secondsUpperBits * nanosPerSecond;
      const lower16ContributionLow32 = nanosFromLower16Bits >>> 0;
      const lower16ContributionHigh32 = Math.floor(nanosFromLower16Bits / 4294967296);
      const upperBitsContributionLow32 = (nanosFromUpperBits & 65535) * 65536 >>> 0;
      const upperBitsContributionHigh32 = nanosFromUpperBits / 65536 >>> 0;
      const low32WithCarry = lower16ContributionLow32 + upperBitsContributionLow32 + nanos;
      const totalLow = low32WithCarry >>> 0;
      const carry = Math.floor(low32WithCarry / 4294967296);
      const totalHigh = lower16ContributionHigh32 + upperBitsContributionHigh32 + carry >>> 0;
      serializer.writeFixed64(totalLow, totalHigh);
    }
    __name(writeHrTimeAsFixed64, "writeHrTimeAsFixed64");
    exports.writeHrTimeAsFixed64 = writeHrTimeAsFixed64;
    function writeAttributes(writer, attributes, fieldNumber) {
      for (const key in attributes) {
        if (!Object.prototype.hasOwnProperty.call(attributes, key)) {
          continue;
        }
        const value = attributes[key];
        writer.writeTag(fieldNumber, 2);
        const kvStart = writer.startLengthDelimited();
        const startPos = writer.pos;
        writeKeyValue(writer, key, value);
        writer.finishLengthDelimited(kvStart, writer.pos - startPos);
      }
    }
    __name(writeAttributes, "writeAttributes");
    exports.writeAttributes = writeAttributes;
    function writeKeyValue(writer, key, value) {
      writer.writeTag(1, 2);
      writer.writeString(key);
      writer.writeTag(2, 2);
      const valueStart = writer.startLengthDelimited();
      const startPos = writer.pos;
      writeAnyValue(writer, value);
      writer.finishLengthDelimited(valueStart, writer.pos - startPos);
    }
    __name(writeKeyValue, "writeKeyValue");
    exports.writeKeyValue = writeKeyValue;
    var MIN_64_BIT_INT = -(2 ** 63);
    var MAX_64_BIT_INT = 2 ** 63;
    function writeAnyValue(writer, value) {
      const t = typeof value;
      if (t === "string") {
        writer.writeTag(1, 2);
        writer.writeString(value);
      } else if (t === "boolean") {
        writer.writeTag(2, 0);
        writer.writeVarint(value ? 1 : 0);
      } else if (t === "number") {
        const numValue = value;
        if (Number.isInteger(numValue) && numValue >= MIN_64_BIT_INT && numValue < MAX_64_BIT_INT) {
          writer.writeTag(3, 0);
          writer.writeVarint(numValue);
        } else {
          writer.writeTag(4, 1);
          writer.writeDouble(numValue);
        }
      } else if (value instanceof Uint8Array) {
        writer.writeTag(7, 2);
        writer.writeBytes(value);
      } else if (Array.isArray(value)) {
        writer.writeTag(5, 2);
        const arrayStart = writer.startLengthDelimited();
        const arrayStartPos = writer.pos;
        for (const item of value) {
          writer.writeTag(1, 2);
          const itemStart = writer.startLengthDelimited();
          const itemStartPos = writer.pos;
          writeAnyValue(writer, item);
          writer.finishLengthDelimited(itemStart, writer.pos - itemStartPos);
        }
        writer.finishLengthDelimited(arrayStart, writer.pos - arrayStartPos);
      } else if (t === "object" && value != null) {
        writer.writeTag(6, 2);
        const kvlistStart = writer.startLengthDelimited();
        const kvlistStartPos = writer.pos;
        const obj = value;
        for (const k in obj) {
          if (!Object.prototype.hasOwnProperty.call(obj, k)) {
            continue;
          }
          const v = obj[k];
          writer.writeTag(1, 2);
          const kvStart = writer.startLengthDelimited();
          const kvStartPos = writer.pos;
          writer.writeTag(1, 2);
          writer.writeString(k);
          writer.writeTag(2, 2);
          const valueStart = writer.startLengthDelimited();
          const valueStartPos = writer.pos;
          writeAnyValue(writer, v);
          writer.finishLengthDelimited(valueStart, writer.pos - valueStartPos);
          writer.finishLengthDelimited(kvStart, writer.pos - kvStartPos);
        }
        writer.finishLengthDelimited(kvlistStart, writer.pos - kvlistStartPos);
      }
    }
    __name(writeAnyValue, "writeAnyValue");
    exports.writeAnyValue = writeAnyValue;
    function writeInstrumentationScope(writer, scope, fieldNumber) {
      writer.writeTag(fieldNumber, 2);
      const start = writer.startLengthDelimited();
      const startPos = writer.pos;
      writer.writeTag(1, 2);
      writer.writeString(scope.name);
      if (scope.version) {
        writer.writeTag(2, 2);
        writer.writeString(scope.version);
      }
      if (scope.attributes) {
        writeAttributes(writer, scope.attributes, 3);
      }
      if (scope.droppedAttributesCount) {
        writer.writeTag(4, 0);
        writer.writeVarint(scope.droppedAttributesCount);
      }
      writer.finishLengthDelimited(start, writer.pos - startPos);
    }
    __name(writeInstrumentationScope, "writeInstrumentationScope");
    exports.writeInstrumentationScope = writeInstrumentationScope;
    function writeResource(writer, resource, fieldNumber) {
      writer.writeTag(fieldNumber, 2);
      const resourceStart = writer.startLengthDelimited();
      const resourceStartPos = writer.pos;
      if (resource.attributes) {
        writeAttributes(writer, resource.attributes, 1);
      }
      writer.writeTag(2, 0);
      writer.writeVarint(0);
      writer.finishLengthDelimited(resourceStart, writer.pos - resourceStartPos);
    }
    __name(writeResource, "writeResource");
    exports.writeResource = writeResource;
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/common/protobuf/protobuf-size-estimator.js
var require_protobuf_size_estimator = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/common/protobuf/protobuf-size-estimator.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ProtobufSizeEstimator = void 0;
    var utils_1 = require_utils();
    function utf8ByteLength(str) {
      const len = str.length;
      let byteLen = 0;
      for (let i = 0; i < len; i++) {
        const code = str.charCodeAt(i);
        if (code < 128) {
          byteLen += 1;
        } else if (code < 2048) {
          byteLen += 2;
        } else if (code < 55296 || code >= 57344) {
          byteLen += 3;
        } else {
          i++;
          byteLen += 4;
        }
      }
      return byteLen;
    }
    __name(utf8ByteLength, "utf8ByteLength");
    var ProtobufSizeEstimator = class {
      static {
        __name(this, "ProtobufSizeEstimator");
      }
      pos = 0;
      startLengthDelimited() {
        return this.pos;
      }
      finishLengthDelimited(_, length) {
        this.pos += (0, utils_1.estimateVarintSize)(length);
      }
      writeVarint(value) {
        this.pos += (0, utils_1.estimateVarintSize)(value);
      }
      writeSint32(value) {
        this.pos += (0, utils_1.estimateVarintSize)((value << 1 ^ value >> 31) >>> 0);
      }
      writeSfixed64(_value) {
        this.pos += 8;
      }
      writeFixed32(_value) {
        this.pos += 4;
      }
      writeFixed64(_low, _high) {
        this.pos += 8;
      }
      writeBytes(bytes) {
        this.pos += (0, utils_1.estimateVarintSize)(bytes.length);
        this.pos += bytes.length;
      }
      writeTag(fieldNumber, wireType) {
        this.writeVarint(fieldNumber << 3 | wireType);
      }
      writeDouble(_value) {
        this.pos += 8;
      }
      writeString(str) {
        const byteLen = utf8ByteLength(str);
        this.pos += (0, utils_1.estimateVarintSize)(byteLen);
        this.pos += byteLen;
      }
    };
    exports.ProtobufSizeEstimator = ProtobufSizeEstimator;
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/logs/protobuf/logs-serializer.js
var require_logs_serializer = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/logs/protobuf/logs-serializer.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.serializeLogsExportRequest = void 0;
    var protobuf_writer_1 = require_protobuf_writer();
    var hex_to_binary_1 = require_hex_to_binary();
    var api_logs_1 = require_src();
    var common_serializer_1 = require_common_serializer();
    var protobuf_size_estimator_1 = require_protobuf_size_estimator();
    function serializeLogRecord(writer, logRecord) {
      const logStart = writer.startLengthDelimited();
      const logStartPos = writer.pos;
      writer.writeTag(1, 1);
      (0, common_serializer_1.writeHrTimeAsFixed64)(writer, logRecord.hrTime);
      if (logRecord.severityNumber !== void 0 && logRecord.severityNumber !== api_logs_1.SeverityNumber.UNSPECIFIED) {
        writer.writeTag(2, 0);
        writer.writeVarint(logRecord.severityNumber);
      }
      if (logRecord.severityText) {
        writer.writeTag(3, 2);
        writer.writeString(logRecord.severityText);
      }
      if (logRecord.body !== void 0) {
        writer.writeTag(5, 2);
        const bodyStart = writer.startLengthDelimited();
        const bodyStartPos = writer.pos;
        (0, common_serializer_1.writeAnyValue)(writer, logRecord.body);
        writer.finishLengthDelimited(bodyStart, writer.pos - bodyStartPos);
      }
      if (logRecord.attributes) {
        (0, common_serializer_1.writeAttributes)(writer, logRecord.attributes, 6);
      }
      writer.writeTag(7, 0);
      writer.writeVarint(logRecord.droppedAttributesCount);
      if (logRecord.spanContext?.traceFlags) {
        writer.writeTag(8, 5);
        writer.writeFixed32(logRecord.spanContext.traceFlags);
      }
      if (logRecord.spanContext?.traceId) {
        writer.writeTag(9, 2);
        writer.writeBytes((0, hex_to_binary_1.hexToBinary)(logRecord.spanContext.traceId));
      }
      if (logRecord.spanContext?.spanId) {
        writer.writeTag(10, 2);
        writer.writeBytes((0, hex_to_binary_1.hexToBinary)(logRecord.spanContext.spanId));
      }
      writer.writeTag(11, 1);
      (0, common_serializer_1.writeHrTimeAsFixed64)(writer, logRecord.hrTimeObserved);
      if (logRecord.eventName) {
        writer.writeTag(12, 2);
        writer.writeString(logRecord.eventName);
      }
      writer.finishLengthDelimited(logStart, writer.pos - logStartPos);
    }
    __name(serializeLogRecord, "serializeLogRecord");
    function serializeScopeLogs(writer, scope, logRecords) {
      const scopeLogsStart = writer.startLengthDelimited();
      const scopeLogsStartPos = writer.pos;
      (0, common_serializer_1.writeInstrumentationScope)(writer, scope, 1);
      for (const logRecord of logRecords) {
        writer.writeTag(2, 2);
        serializeLogRecord(writer, logRecord);
      }
      if (scope.schemaUrl) {
        writer.writeTag(3, 2);
        writer.writeString(scope.schemaUrl);
      }
      writer.finishLengthDelimited(scopeLogsStart, writer.pos - scopeLogsStartPos);
    }
    __name(serializeScopeLogs, "serializeScopeLogs");
    function serializeResourceLogs(writer, resource, scopeMap) {
      const resourceLogsStart = writer.startLengthDelimited();
      const resourceLogsStartPos = writer.pos;
      (0, common_serializer_1.writeResource)(writer, resource, 1);
      for (const scopeLogs of scopeMap.values()) {
        writer.writeTag(2, 2);
        const scope = scopeLogs[0].instrumentationScope;
        serializeScopeLogs(writer, scope, scopeLogs);
      }
      if (resource.schemaUrl) {
        writer.writeTag(3, 2);
        writer.writeString(resource.schemaUrl);
      }
      writer.finishLengthDelimited(resourceLogsStart, writer.pos - resourceLogsStartPos);
    }
    __name(serializeResourceLogs, "serializeResourceLogs");
    function createResourceMap(logRecords) {
      const resourceMap = /* @__PURE__ */ new Map();
      for (const record of logRecords) {
        const resource = record.resource;
        const scope = record.instrumentationScope;
        let ismMap = resourceMap.get(resource);
        if (!ismMap) {
          ismMap = /* @__PURE__ */ new Map();
          resourceMap.set(resource, ismMap);
        }
        let records = ismMap.get(scope);
        if (!records) {
          records = [];
          ismMap.set(scope, records);
        }
        records.push(record);
      }
      return resourceMap;
    }
    __name(createResourceMap, "createResourceMap");
    function serializeLogsExportRequest(logRecords) {
      const resourceMap = createResourceMap(logRecords);
      const estimator = new protobuf_size_estimator_1.ProtobufSizeEstimator();
      for (const [resource, scopeMap] of resourceMap) {
        estimator.writeTag(1, 2);
        serializeResourceLogs(estimator, resource, scopeMap);
      }
      const writer = new protobuf_writer_1.ProtobufWriter(estimator.pos);
      for (const [resource, scopeMap] of resourceMap) {
        writer.writeTag(1, 2);
        serializeResourceLogs(writer, resource, scopeMap);
      }
      return writer.finish();
    }
    __name(serializeLogsExportRequest, "serializeLogsExportRequest");
    exports.serializeLogsExportRequest = serializeLogsExportRequest;
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/common/protobuf/protobuf-reader.js
var require_protobuf_reader = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/common/protobuf/protobuf-reader.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ProtobufReader = void 0;
    var ProtobufReader = class {
      static {
        __name(this, "ProtobufReader");
      }
      pos = 0;
      _buf;
      _textDecoder;
      constructor(buf) {
        this._buf = buf;
        this._textDecoder = new TextDecoder();
      }
      isAtEnd() {
        return this.pos >= this._buf.length;
      }
      /** Read a varint and decode it as a tag, returning field number and wire type. */
      readTag() {
        const raw = this.readVarint();
        return { fieldNumber: raw >>> 3, wireType: raw & 7 };
      }
      /**
       * Read a base-128 varint.
       * Returns a JS `number`; precision above 2^53 is silently lost.
       * Throws if the buffer is truncated mid-varint.
       */
      readVarint() {
        let result = 0;
        let shift = 0;
        let terminated = false;
        while (this.pos < this._buf.length) {
          const b = this._buf[this.pos++];
          result += (b & 127) * Math.pow(2, shift);
          shift += 7;
          if ((b & 128) === 0) {
            terminated = true;
            break;
          }
        }
        if (!terminated) {
          throw new Error("Truncated buffer: unexpected end of data while reading varint");
        }
        return result;
      }
      /** Read a length-delimited byte sequence (bytes field or embedded message). */
      readBytes() {
        const len = this.readVarint();
        if (this.pos + len > this._buf.length) {
          throw new Error(`Truncated buffer: expected ${len} bytes at position ${this.pos}, but only ${this._buf.length - this.pos} available`);
        }
        const slice = this._buf.subarray(this.pos, this.pos + len);
        this.pos += len;
        return slice;
      }
      /** Read a length-delimited UTF-8 string. */
      readString() {
        return this._textDecoder.decode(this.readBytes());
      }
      /**
       * Skip an unknown field.
       * Handles wire types 0 (varint), 1 (64-bit), 2 (length-delimited),
       * and 5 (32-bit).
       *
       * Wire types 3 and 4 (start-group / end-group) are deprecated in proto3
       * and are not used by any OpenTelemetry proto definition. Encountering
       * them is treated as an error.
       */
      skip(wireType) {
        switch (wireType) {
          case 0:
            this.readVarint();
            break;
          case 1:
            this.pos += 8;
            break;
          case 2:
            this.readBytes();
            break;
          case 5:
            this.pos += 4;
            break;
          default:
            throw new Error(`Unknown wire type ${wireType}, cannot safely skip`);
        }
      }
    };
    exports.ProtobufReader = ProtobufReader;
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/logs/protobuf/response-deserializer.js
var require_response_deserializer = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/logs/protobuf/response-deserializer.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.deserializeExportLogsServiceResponse = void 0;
    var protobuf_reader_1 = require_protobuf_reader();
    function deserializePartialSuccess(data) {
      const reader = new protobuf_reader_1.ProtobufReader(data);
      const result = {};
      while (!reader.isAtEnd()) {
        const { fieldNumber, wireType } = reader.readTag();
        switch (fieldNumber) {
          case 1:
            if (wireType === 0) {
              result.rejectedLogRecords = reader.readVarint();
            } else {
              reader.skip(wireType);
            }
            break;
          case 2:
            if (wireType === 2) {
              result.errorMessage = reader.readString();
            } else {
              reader.skip(wireType);
            }
            break;
          default:
            reader.skip(wireType);
            break;
        }
      }
      return result;
    }
    __name(deserializePartialSuccess, "deserializePartialSuccess");
    function deserializeExportLogsServiceResponse(data) {
      const reader = new protobuf_reader_1.ProtobufReader(data);
      const result = {};
      while (!reader.isAtEnd()) {
        const { fieldNumber, wireType } = reader.readTag();
        switch (fieldNumber) {
          case 1:
            if (wireType === 2) {
              result.partialSuccess = deserializePartialSuccess(reader.readBytes());
            } else {
              reader.skip(wireType);
            }
            break;
          default:
            reader.skip(wireType);
            break;
        }
      }
      return result;
    }
    __name(deserializeExportLogsServiceResponse, "deserializeExportLogsServiceResponse");
    exports.deserializeExportLogsServiceResponse = deserializeExportLogsServiceResponse;
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/logs/protobuf/logs.js
var require_logs2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/logs/protobuf/logs.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ProtobufLogsSerializer = void 0;
    var logs_serializer_1 = require_logs_serializer();
    var response_deserializer_1 = require_response_deserializer();
    exports.ProtobufLogsSerializer = {
      serializeRequest: /* @__PURE__ */ __name((arg) => {
        return (0, logs_serializer_1.serializeLogsExportRequest)(arg);
      }, "serializeRequest"),
      deserializeResponse: /* @__PURE__ */ __name((arg) => {
        return (0, response_deserializer_1.deserializeExportLogsServiceResponse)(arg);
      }, "deserializeResponse")
    };
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/logs/protobuf/index.js
var require_protobuf = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/logs/protobuf/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ProtobufLogsSerializer = void 0;
    var logs_1 = require_logs2();
    Object.defineProperty(exports, "ProtobufLogsSerializer", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return logs_1.ProtobufLogsSerializer;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/metrics/protobuf/metrics-serializer.js
var require_metrics_serializer = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/metrics/protobuf/metrics-serializer.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.serializeMetricsExportRequest = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var sdk_metrics_1 = require_src3();
    var common_serializer_1 = require_common_serializer();
    var protobuf_size_estimator_1 = require_protobuf_size_estimator();
    var protobuf_writer_1 = require_protobuf_writer();
    function serializeNumberDataPoint(writer, dataPoint, valueType) {
      const start = writer.startLengthDelimited();
      const startPos = writer.pos;
      writer.writeTag(2, 1);
      (0, common_serializer_1.writeHrTimeAsFixed64)(writer, dataPoint.startTime);
      writer.writeTag(3, 1);
      (0, common_serializer_1.writeHrTimeAsFixed64)(writer, dataPoint.endTime);
      if (valueType === api_1.ValueType.INT) {
        writer.writeTag(6, 1);
        writer.writeSfixed64(dataPoint.value);
      } else {
        writer.writeTag(4, 1);
        writer.writeDouble(dataPoint.value);
      }
      if (dataPoint.attributes) {
        (0, common_serializer_1.writeAttributes)(writer, dataPoint.attributes, 7);
      }
      writer.finishLengthDelimited(start, writer.pos - startPos);
    }
    __name(serializeNumberDataPoint, "serializeNumberDataPoint");
    function serializeHistogramDataPoint(writer, dataPoint) {
      const start = writer.startLengthDelimited();
      const startPos = writer.pos;
      const histogram = dataPoint.value;
      writer.writeTag(2, 1);
      (0, common_serializer_1.writeHrTimeAsFixed64)(writer, dataPoint.startTime);
      writer.writeTag(3, 1);
      (0, common_serializer_1.writeHrTimeAsFixed64)(writer, dataPoint.endTime);
      writer.writeTag(4, 1);
      writer.writeFixed64(histogram.count >>> 0, histogram.count / 4294967296 >>> 0);
      if (histogram.sum !== void 0) {
        writer.writeTag(5, 1);
        writer.writeDouble(histogram.sum);
      }
      if (histogram.buckets.counts.length > 0) {
        writer.writeTag(6, 2);
        const countsStart = writer.startLengthDelimited();
        const countsStartPos = writer.pos;
        for (const count of histogram.buckets.counts) {
          writer.writeFixed64(count >>> 0, count / 4294967296 >>> 0);
        }
        writer.finishLengthDelimited(countsStart, writer.pos - countsStartPos);
      }
      if (histogram.buckets.boundaries.length > 0) {
        writer.writeTag(7, 2);
        const boundsStart = writer.startLengthDelimited();
        const boundsStartPos = writer.pos;
        for (const bound of histogram.buckets.boundaries) {
          writer.writeDouble(bound);
        }
        writer.finishLengthDelimited(boundsStart, writer.pos - boundsStartPos);
      }
      if (dataPoint.attributes) {
        (0, common_serializer_1.writeAttributes)(writer, dataPoint.attributes, 9);
      }
      if (histogram.min !== void 0) {
        writer.writeTag(11, 1);
        writer.writeDouble(histogram.min);
      }
      if (histogram.max !== void 0) {
        writer.writeTag(12, 1);
        writer.writeDouble(histogram.max);
      }
      writer.finishLengthDelimited(start, writer.pos - startPos);
    }
    __name(serializeHistogramDataPoint, "serializeHistogramDataPoint");
    function serializeExponentialBuckets(writer, offset, bucketCounts) {
      const start = writer.startLengthDelimited();
      const startPos = writer.pos;
      if (offset !== 0) {
        writer.writeTag(1, 0);
        writer.writeSint32(offset);
      }
      if (bucketCounts.length > 0) {
        writer.writeTag(2, 2);
        const bcStart = writer.startLengthDelimited();
        const bcStartPos = writer.pos;
        for (const count of bucketCounts) {
          writer.writeVarint(count);
        }
        writer.finishLengthDelimited(bcStart, writer.pos - bcStartPos);
      }
      writer.finishLengthDelimited(start, writer.pos - startPos);
    }
    __name(serializeExponentialBuckets, "serializeExponentialBuckets");
    function serializeExponentialHistogramDataPoint(writer, dataPoint) {
      const start = writer.startLengthDelimited();
      const startPos = writer.pos;
      const histogram = dataPoint.value;
      if (dataPoint.attributes) {
        (0, common_serializer_1.writeAttributes)(writer, dataPoint.attributes, 1);
      }
      writer.writeTag(2, 1);
      (0, common_serializer_1.writeHrTimeAsFixed64)(writer, dataPoint.startTime);
      writer.writeTag(3, 1);
      (0, common_serializer_1.writeHrTimeAsFixed64)(writer, dataPoint.endTime);
      writer.writeTag(4, 1);
      writer.writeFixed64(histogram.count >>> 0, histogram.count / 4294967296 >>> 0);
      if (histogram.sum !== void 0) {
        writer.writeTag(5, 1);
        writer.writeDouble(histogram.sum);
      }
      if (histogram.scale !== 0) {
        writer.writeTag(6, 0);
        writer.writeSint32(histogram.scale);
      }
      writer.writeTag(7, 1);
      writer.writeFixed64(histogram.zeroCount >>> 0, histogram.zeroCount / 4294967296 >>> 0);
      writer.writeTag(8, 2);
      serializeExponentialBuckets(writer, histogram.positive.offset, histogram.positive.bucketCounts);
      writer.writeTag(9, 2);
      serializeExponentialBuckets(writer, histogram.negative.offset, histogram.negative.bucketCounts);
      if (histogram.min !== void 0) {
        writer.writeTag(12, 1);
        writer.writeDouble(histogram.min);
      }
      if (histogram.max !== void 0) {
        writer.writeTag(13, 1);
        writer.writeDouble(histogram.max);
      }
      writer.finishLengthDelimited(start, writer.pos - startPos);
    }
    __name(serializeExponentialHistogramDataPoint, "serializeExponentialHistogramDataPoint");
    function serializeMetric(writer, metricData) {
      const metricStart = writer.startLengthDelimited();
      const metricStartPos = writer.pos;
      writer.writeTag(1, 2);
      writer.writeString(metricData.descriptor.name);
      if (metricData.descriptor.description) {
        writer.writeTag(2, 2);
        writer.writeString(metricData.descriptor.description);
      }
      if (metricData.descriptor.unit) {
        writer.writeTag(3, 2);
        writer.writeString(metricData.descriptor.unit);
      }
      switch (metricData.dataPointType) {
        case sdk_metrics_1.DataPointType.GAUGE:
          writer.writeTag(5, 2);
          serializeGauge(writer, metricData);
          break;
        case sdk_metrics_1.DataPointType.SUM:
          writer.writeTag(7, 2);
          serializeSum(writer, metricData);
          break;
        case sdk_metrics_1.DataPointType.HISTOGRAM:
          writer.writeTag(9, 2);
          serializeHistogramMetric(writer, metricData);
          break;
        case sdk_metrics_1.DataPointType.EXPONENTIAL_HISTOGRAM:
          writer.writeTag(10, 2);
          serializeExponentialHistogramMetric(writer, metricData);
          break;
        default: {
          const _exhaustive = metricData;
          void _exhaustive;
        }
      }
      writer.finishLengthDelimited(metricStart, writer.pos - metricStartPos);
    }
    __name(serializeMetric, "serializeMetric");
    function serializeGauge(writer, metricData) {
      const start = writer.startLengthDelimited();
      const startPos = writer.pos;
      for (const dataPoint of metricData.dataPoints) {
        writer.writeTag(1, 2);
        serializeNumberDataPoint(writer, dataPoint, metricData.descriptor.valueType);
      }
      writer.finishLengthDelimited(start, writer.pos - startPos);
    }
    __name(serializeGauge, "serializeGauge");
    function serializeSum(writer, metricData) {
      const start = writer.startLengthDelimited();
      const startPos = writer.pos;
      for (const dataPoint of metricData.dataPoints) {
        writer.writeTag(1, 2);
        serializeNumberDataPoint(writer, dataPoint, metricData.descriptor.valueType);
      }
      const temporality = toProtoAggregationTemporality(metricData.aggregationTemporality);
      if (temporality !== 0) {
        writer.writeTag(2, 0);
        writer.writeVarint(temporality);
      }
      if (metricData.isMonotonic) {
        writer.writeTag(3, 0);
        writer.writeVarint(1);
      }
      writer.finishLengthDelimited(start, writer.pos - startPos);
    }
    __name(serializeSum, "serializeSum");
    function serializeHistogramMetric(writer, metricData) {
      const start = writer.startLengthDelimited();
      const startPos = writer.pos;
      for (const dataPoint of metricData.dataPoints) {
        writer.writeTag(1, 2);
        serializeHistogramDataPoint(writer, dataPoint);
      }
      const temporality = toProtoAggregationTemporality(metricData.aggregationTemporality);
      if (temporality !== 0) {
        writer.writeTag(2, 0);
        writer.writeVarint(temporality);
      }
      writer.finishLengthDelimited(start, writer.pos - startPos);
    }
    __name(serializeHistogramMetric, "serializeHistogramMetric");
    function serializeExponentialHistogramMetric(writer, metricData) {
      const start = writer.startLengthDelimited();
      const startPos = writer.pos;
      for (const dataPoint of metricData.dataPoints) {
        writer.writeTag(1, 2);
        serializeExponentialHistogramDataPoint(writer, dataPoint);
      }
      const temporality = toProtoAggregationTemporality(metricData.aggregationTemporality);
      if (temporality !== 0) {
        writer.writeTag(2, 0);
        writer.writeVarint(temporality);
      }
      writer.finishLengthDelimited(start, writer.pos - startPos);
    }
    __name(serializeExponentialHistogramMetric, "serializeExponentialHistogramMetric");
    function serializeScopeMetrics(writer, scopeMetrics) {
      const scopeStart = writer.startLengthDelimited();
      const scopeStartPos = writer.pos;
      (0, common_serializer_1.writeInstrumentationScope)(writer, scopeMetrics.scope, 1);
      for (const metric of scopeMetrics.metrics) {
        writer.writeTag(2, 2);
        serializeMetric(writer, metric);
      }
      if (scopeMetrics.scope.schemaUrl) {
        writer.writeTag(3, 2);
        writer.writeString(scopeMetrics.scope.schemaUrl);
      }
      writer.finishLengthDelimited(scopeStart, writer.pos - scopeStartPos);
    }
    __name(serializeScopeMetrics, "serializeScopeMetrics");
    function serializeResourceMetrics(writer, resourceMetrics) {
      const start = writer.startLengthDelimited();
      const startPos = writer.pos;
      (0, common_serializer_1.writeResource)(writer, resourceMetrics.resource, 1);
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        writer.writeTag(2, 2);
        serializeScopeMetrics(writer, scopeMetrics);
      }
      if (resourceMetrics.resource.schemaUrl) {
        writer.writeTag(3, 2);
        writer.writeString(resourceMetrics.resource.schemaUrl);
      }
      writer.finishLengthDelimited(start, writer.pos - startPos);
    }
    __name(serializeResourceMetrics, "serializeResourceMetrics");
    function toProtoAggregationTemporality(temporality) {
      switch (temporality) {
        case sdk_metrics_1.AggregationTemporality.DELTA:
          return 1;
        case sdk_metrics_1.AggregationTemporality.CUMULATIVE:
          return 2;
        default:
          return 0;
      }
    }
    __name(toProtoAggregationTemporality, "toProtoAggregationTemporality");
    function serializeMetricsExportRequest(resourceMetrics) {
      const estimator = new protobuf_size_estimator_1.ProtobufSizeEstimator();
      estimator.writeTag(1, 2);
      serializeResourceMetrics(estimator, resourceMetrics);
      const writer = new protobuf_writer_1.ProtobufWriter(estimator.pos);
      writer.writeTag(1, 2);
      serializeResourceMetrics(writer, resourceMetrics);
      return writer.finish();
    }
    __name(serializeMetricsExportRequest, "serializeMetricsExportRequest");
    exports.serializeMetricsExportRequest = serializeMetricsExportRequest;
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/metrics/protobuf/response-deserializer.js
var require_response_deserializer2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/metrics/protobuf/response-deserializer.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.deserializeExportMetricsServiceResponse = void 0;
    var protobuf_reader_1 = require_protobuf_reader();
    function deserializePartialSuccess(data) {
      const reader = new protobuf_reader_1.ProtobufReader(data);
      const result = {};
      while (!reader.isAtEnd()) {
        const { fieldNumber, wireType } = reader.readTag();
        switch (fieldNumber) {
          case 1:
            if (wireType === 0) {
              result.rejectedDataPoints = reader.readVarint();
            } else {
              reader.skip(wireType);
            }
            break;
          case 2:
            if (wireType === 2) {
              result.errorMessage = reader.readString();
            } else {
              reader.skip(wireType);
            }
            break;
          default:
            reader.skip(wireType);
            break;
        }
      }
      return result;
    }
    __name(deserializePartialSuccess, "deserializePartialSuccess");
    function deserializeExportMetricsServiceResponse(data) {
      const reader = new protobuf_reader_1.ProtobufReader(data);
      const result = {};
      while (!reader.isAtEnd()) {
        const { fieldNumber, wireType } = reader.readTag();
        switch (fieldNumber) {
          case 1:
            if (wireType === 2) {
              result.partialSuccess = deserializePartialSuccess(reader.readBytes());
            } else {
              reader.skip(wireType);
            }
            break;
          default:
            reader.skip(wireType);
            break;
        }
      }
      return result;
    }
    __name(deserializeExportMetricsServiceResponse, "deserializeExportMetricsServiceResponse");
    exports.deserializeExportMetricsServiceResponse = deserializeExportMetricsServiceResponse;
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/metrics/protobuf/metrics.js
var require_metrics2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/metrics/protobuf/metrics.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ProtobufMetricsSerializer = void 0;
    var metrics_serializer_1 = require_metrics_serializer();
    var response_deserializer_1 = require_response_deserializer2();
    exports.ProtobufMetricsSerializer = {
      serializeRequest: /* @__PURE__ */ __name((arg) => {
        return (0, metrics_serializer_1.serializeMetricsExportRequest)(arg);
      }, "serializeRequest"),
      deserializeResponse: /* @__PURE__ */ __name((arg) => {
        return (0, response_deserializer_1.deserializeExportMetricsServiceResponse)(arg);
      }, "deserializeResponse")
    };
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/metrics/protobuf/index.js
var require_protobuf2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/metrics/protobuf/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ProtobufMetricsSerializer = void 0;
    var metrics_1 = require_metrics2();
    Object.defineProperty(exports, "ProtobufMetricsSerializer", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return metrics_1.ProtobufMetricsSerializer;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/trace/protobuf/trace-serializer.js
var require_trace_serializer = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/trace/protobuf/trace-serializer.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.serializeTraceExportRequest = void 0;
    var protobuf_writer_1 = require_protobuf_writer();
    var hex_to_binary_1 = require_hex_to_binary();
    var common_serializer_1 = require_common_serializer();
    var protobuf_size_estimator_1 = require_protobuf_size_estimator();
    var SPAN_FLAGS_CONTEXT_HAS_IS_REMOTE_MASK = 256;
    var SPAN_FLAGS_CONTEXT_IS_REMOTE_MASK = 512;
    function buildSpanFlags(traceFlags, isRemote) {
      let flags = traceFlags & 255 | SPAN_FLAGS_CONTEXT_HAS_IS_REMOTE_MASK;
      if (isRemote) {
        flags |= SPAN_FLAGS_CONTEXT_IS_REMOTE_MASK;
      }
      return flags;
    }
    __name(buildSpanFlags, "buildSpanFlags");
    function serializeStatus(writer, status) {
      const statusStart = writer.startLengthDelimited();
      const statusStartPos = writer.pos;
      if (status.message) {
        writer.writeTag(2, 2);
        writer.writeString(status.message);
      }
      writer.writeTag(3, 0);
      writer.writeVarint(status.code);
      writer.finishLengthDelimited(statusStart, writer.pos - statusStartPos);
    }
    __name(serializeStatus, "serializeStatus");
    function serializeEvent(writer, event) {
      const eventStart = writer.startLengthDelimited();
      const eventStartPos = writer.pos;
      writer.writeTag(1, 1);
      (0, common_serializer_1.writeHrTimeAsFixed64)(writer, event.time);
      writer.writeTag(2, 2);
      writer.writeString(event.name);
      if (event.attributes) {
        (0, common_serializer_1.writeAttributes)(writer, event.attributes, 3);
      }
      writer.writeTag(4, 0);
      writer.writeVarint(event.droppedAttributesCount || 0);
      writer.finishLengthDelimited(eventStart, writer.pos - eventStartPos);
    }
    __name(serializeEvent, "serializeEvent");
    function serializeLink(writer, link) {
      const linkStart = writer.startLengthDelimited();
      const linkStartPos = writer.pos;
      const context = link.context;
      writer.writeTag(1, 2);
      writer.writeBytes((0, hex_to_binary_1.hexToBinary)(context.traceId));
      writer.writeTag(2, 2);
      writer.writeBytes((0, hex_to_binary_1.hexToBinary)(context.spanId));
      const linkTraceState = context.traceState?.serialize();
      if (linkTraceState) {
        writer.writeTag(3, 2);
        writer.writeString(linkTraceState);
      }
      if (link.attributes) {
        (0, common_serializer_1.writeAttributes)(writer, link.attributes, 4);
      }
      writer.writeTag(5, 0);
      writer.writeVarint(link.droppedAttributesCount || 0);
      const linkFlags = buildSpanFlags(context.traceFlags, context.isRemote);
      if (linkFlags) {
        writer.writeTag(6, 5);
        writer.writeFixed32(linkFlags);
      }
      writer.finishLengthDelimited(linkStart, writer.pos - linkStartPos);
    }
    __name(serializeLink, "serializeLink");
    function serializeSpan(writer, span) {
      const spanStart = writer.startLengthDelimited();
      const spanStartPos = writer.pos;
      const ctx = span.spanContext();
      writer.writeTag(1, 2);
      writer.writeBytes((0, hex_to_binary_1.hexToBinary)(ctx.traceId));
      writer.writeTag(2, 2);
      writer.writeBytes((0, hex_to_binary_1.hexToBinary)(ctx.spanId));
      const traceState = ctx.traceState?.serialize();
      if (traceState) {
        writer.writeTag(3, 2);
        writer.writeString(traceState);
      }
      if (span.parentSpanContext?.spanId) {
        writer.writeTag(4, 2);
        writer.writeBytes((0, hex_to_binary_1.hexToBinary)(span.parentSpanContext.spanId));
      }
      writer.writeTag(5, 2);
      writer.writeString(span.name);
      const kind = span.kind == null ? 0 : span.kind + 1;
      if (kind !== 0) {
        writer.writeTag(6, 0);
        writer.writeVarint(kind);
      }
      writer.writeTag(7, 1);
      (0, common_serializer_1.writeHrTimeAsFixed64)(writer, span.startTime);
      writer.writeTag(8, 1);
      (0, common_serializer_1.writeHrTimeAsFixed64)(writer, span.endTime);
      if (span.attributes) {
        (0, common_serializer_1.writeAttributes)(writer, span.attributes, 9);
      }
      writer.writeTag(10, 0);
      writer.writeVarint(span.droppedAttributesCount);
      for (const event of span.events) {
        writer.writeTag(11, 2);
        serializeEvent(writer, event);
      }
      writer.writeTag(12, 0);
      writer.writeVarint(span.droppedEventsCount);
      for (const link of span.links) {
        writer.writeTag(13, 2);
        serializeLink(writer, link);
      }
      writer.writeTag(14, 0);
      writer.writeVarint(span.droppedLinksCount);
      writer.writeTag(15, 2);
      serializeStatus(writer, span.status);
      const flags = buildSpanFlags(ctx.traceFlags, span.parentSpanContext?.isRemote);
      if (flags) {
        writer.writeTag(16, 5);
        writer.writeFixed32(flags);
      }
      writer.finishLengthDelimited(spanStart, writer.pos - spanStartPos);
    }
    __name(serializeSpan, "serializeSpan");
    function serializeScopeSpans(writer, scope, spans) {
      const scopeSpansStart = writer.startLengthDelimited();
      const scopeSpansStartPos = writer.pos;
      (0, common_serializer_1.writeInstrumentationScope)(writer, scope, 1);
      for (const span of spans) {
        writer.writeTag(2, 2);
        serializeSpan(writer, span);
      }
      if (scope.schemaUrl) {
        writer.writeTag(3, 2);
        writer.writeString(scope.schemaUrl);
      }
      writer.finishLengthDelimited(scopeSpansStart, writer.pos - scopeSpansStartPos);
    }
    __name(serializeScopeSpans, "serializeScopeSpans");
    function serializeResourceSpans(writer, resource, scopeMap) {
      const resourceSpansStart = writer.startLengthDelimited();
      const resourceSpansStartPos = writer.pos;
      (0, common_serializer_1.writeResource)(writer, resource, 1);
      for (const scopeSpans of scopeMap.values()) {
        writer.writeTag(2, 2);
        const scope = scopeSpans[0].instrumentationScope;
        serializeScopeSpans(writer, scope, scopeSpans);
      }
      if (resource.schemaUrl) {
        writer.writeTag(3, 2);
        writer.writeString(resource.schemaUrl);
      }
      writer.finishLengthDelimited(resourceSpansStart, writer.pos - resourceSpansStartPos);
    }
    __name(serializeResourceSpans, "serializeResourceSpans");
    function createResourceMap(spans) {
      const resourceMap = /* @__PURE__ */ new Map();
      for (const span of spans) {
        const resource = span.resource;
        const scope = span.instrumentationScope;
        let scopeMap = resourceMap.get(resource);
        if (!scopeMap) {
          scopeMap = /* @__PURE__ */ new Map();
          resourceMap.set(resource, scopeMap);
        }
        let records = scopeMap.get(scope);
        if (!records) {
          records = [];
          scopeMap.set(scope, records);
        }
        records.push(span);
      }
      return resourceMap;
    }
    __name(createResourceMap, "createResourceMap");
    function serializeTraceExportRequest(spans) {
      const resourceMap = createResourceMap(spans);
      const estimator = new protobuf_size_estimator_1.ProtobufSizeEstimator();
      for (const [resource, scopeMap] of resourceMap) {
        estimator.writeTag(1, 2);
        serializeResourceSpans(estimator, resource, scopeMap);
      }
      const writer = new protobuf_writer_1.ProtobufWriter(estimator.pos);
      for (const [resource, scopeMap] of resourceMap) {
        writer.writeTag(1, 2);
        serializeResourceSpans(writer, resource, scopeMap);
      }
      return writer.finish();
    }
    __name(serializeTraceExportRequest, "serializeTraceExportRequest");
    exports.serializeTraceExportRequest = serializeTraceExportRequest;
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/trace/protobuf/response-deserializer.js
var require_response_deserializer3 = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/trace/protobuf/response-deserializer.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.deserializeExportTraceServiceResponse = void 0;
    var protobuf_reader_1 = require_protobuf_reader();
    function deserializePartialSuccess(data) {
      const reader = new protobuf_reader_1.ProtobufReader(data);
      const result = {};
      while (!reader.isAtEnd()) {
        const { fieldNumber, wireType } = reader.readTag();
        switch (fieldNumber) {
          case 1:
            if (wireType === 0) {
              result.rejectedSpans = reader.readVarint();
            } else {
              reader.skip(wireType);
            }
            break;
          case 2:
            if (wireType === 2) {
              result.errorMessage = reader.readString();
            } else {
              reader.skip(wireType);
            }
            break;
          default:
            reader.skip(wireType);
            break;
        }
      }
      return result;
    }
    __name(deserializePartialSuccess, "deserializePartialSuccess");
    function deserializeExportTraceServiceResponse(data) {
      const reader = new protobuf_reader_1.ProtobufReader(data);
      const result = {};
      while (!reader.isAtEnd()) {
        const { fieldNumber, wireType } = reader.readTag();
        switch (fieldNumber) {
          case 1:
            if (wireType === 2) {
              result.partialSuccess = deserializePartialSuccess(reader.readBytes());
            } else {
              reader.skip(wireType);
            }
            break;
          default:
            reader.skip(wireType);
            break;
        }
      }
      return result;
    }
    __name(deserializeExportTraceServiceResponse, "deserializeExportTraceServiceResponse");
    exports.deserializeExportTraceServiceResponse = deserializeExportTraceServiceResponse;
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/trace/protobuf/trace.js
var require_trace2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/trace/protobuf/trace.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ProtobufTraceSerializer = void 0;
    var trace_serializer_1 = require_trace_serializer();
    var response_deserializer_1 = require_response_deserializer3();
    exports.ProtobufTraceSerializer = {
      serializeRequest: /* @__PURE__ */ __name((arg) => {
        return (0, trace_serializer_1.serializeTraceExportRequest)(arg);
      }, "serializeRequest"),
      deserializeResponse: /* @__PURE__ */ __name((arg) => {
        return (0, response_deserializer_1.deserializeExportTraceServiceResponse)(arg);
      }, "deserializeResponse")
    };
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/trace/protobuf/index.js
var require_protobuf3 = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/trace/protobuf/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ProtobufTraceSerializer = void 0;
    var trace_1 = require_trace2();
    Object.defineProperty(exports, "ProtobufTraceSerializer", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return trace_1.ProtobufTraceSerializer;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/common/internal.js
var require_internal = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/common/internal.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.toAnyValue = exports.toKeyValue = exports.toAttributes = exports.createInstrumentationScope = exports.createResource = void 0;
    function createResource(resource, encoder) {
      const result = {
        attributes: toAttributes(resource.attributes, encoder),
        droppedAttributesCount: 0
      };
      const schemaUrl = resource.schemaUrl;
      if (schemaUrl && schemaUrl !== "")
        result.schemaUrl = schemaUrl;
      return result;
    }
    __name(createResource, "createResource");
    exports.createResource = createResource;
    function createInstrumentationScope(scope, encoder) {
      const result = {
        name: scope.name,
        version: scope.version
      };
      if (scope.attributes && Object.keys(scope.attributes).length > 0) {
        result.attributes = toAttributes(scope.attributes, encoder);
        result.droppedAttributesCount = scope.droppedAttributesCount ?? 0;
      }
      return result;
    }
    __name(createInstrumentationScope, "createInstrumentationScope");
    exports.createInstrumentationScope = createInstrumentationScope;
    function toAttributes(attributes, encoder) {
      return Object.keys(attributes).map((key) => toKeyValue(key, attributes[key], encoder));
    }
    __name(toAttributes, "toAttributes");
    exports.toAttributes = toAttributes;
    function toKeyValue(key, value, encoder) {
      return {
        key,
        value: toAnyValue(value, encoder)
      };
    }
    __name(toKeyValue, "toKeyValue");
    exports.toKeyValue = toKeyValue;
    function toAnyValue(value, encoder) {
      const t = typeof value;
      if (t === "string")
        return { stringValue: value };
      if (t === "number") {
        if (!Number.isInteger(value))
          return { doubleValue: value };
        return { intValue: value };
      }
      if (t === "boolean")
        return { boolValue: value };
      if (value instanceof Uint8Array)
        return { bytesValue: encoder.encodeUint8Array(value) };
      if (Array.isArray(value)) {
        const values = new Array(value.length);
        for (let i = 0; i < value.length; i++) {
          values[i] = toAnyValue(value[i], encoder);
        }
        return { arrayValue: { values } };
      }
      if (t === "object" && value != null) {
        const keys = Object.keys(value);
        const values = new Array(keys.length);
        for (let i = 0; i < keys.length; i++) {
          values[i] = {
            key: keys[i],
            value: toAnyValue(value[keys[i]], encoder)
          };
        }
        return { kvlistValue: { values } };
      }
      return {};
    }
    __name(toAnyValue, "toAnyValue");
    exports.toAnyValue = toAnyValue;
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/logs/internal.js
var require_internal2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/logs/internal.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createExportLogsServiceRequest = void 0;
    var internal_1 = require_internal();
    function createExportLogsServiceRequest(logRecords, encoder) {
      return {
        resourceLogs: logRecordsToResourceLogs(logRecords, encoder)
      };
    }
    __name(createExportLogsServiceRequest, "createExportLogsServiceRequest");
    exports.createExportLogsServiceRequest = createExportLogsServiceRequest;
    function createResourceMap(logRecords) {
      const resourceMap = /* @__PURE__ */ new Map();
      for (const record of logRecords) {
        const { resource, instrumentationScope } = record;
        let ismMap = resourceMap.get(resource);
        if (!ismMap) {
          ismMap = /* @__PURE__ */ new Map();
          resourceMap.set(resource, ismMap);
        }
        let records = ismMap.get(instrumentationScope);
        if (!records) {
          records = [];
          ismMap.set(instrumentationScope, records);
        }
        records.push(record);
      }
      return resourceMap;
    }
    __name(createResourceMap, "createResourceMap");
    function logRecordsToResourceLogs(logRecords, encoder) {
      const resourceMap = createResourceMap(logRecords);
      return Array.from(resourceMap, ([resource, ismMap]) => {
        const processedResource = (0, internal_1.createResource)(resource, encoder);
        return {
          resource: processedResource,
          scopeLogs: Array.from(ismMap, ([, scopeLogs]) => {
            return {
              scope: (0, internal_1.createInstrumentationScope)(scopeLogs[0].instrumentationScope, encoder),
              logRecords: scopeLogs.map((log) => toLogRecord(log, encoder)),
              schemaUrl: scopeLogs[0].instrumentationScope.schemaUrl
            };
          }),
          schemaUrl: processedResource.schemaUrl
        };
      });
    }
    __name(logRecordsToResourceLogs, "logRecordsToResourceLogs");
    function toLogRecord(log, encoder) {
      return {
        timeUnixNano: encoder.encodeHrTime(log.hrTime),
        observedTimeUnixNano: encoder.encodeHrTime(log.hrTimeObserved),
        severityNumber: toSeverityNumber(log.severityNumber),
        severityText: log.severityText,
        body: (0, internal_1.toAnyValue)(log.body, encoder),
        eventName: log.eventName,
        attributes: (0, internal_1.toAttributes)(log.attributes, encoder),
        droppedAttributesCount: log.droppedAttributesCount,
        flags: log.spanContext?.traceFlags,
        traceId: encoder.encodeOptionalSpanContext(log.spanContext?.traceId),
        spanId: encoder.encodeOptionalSpanContext(log.spanContext?.spanId)
      };
    }
    __name(toLogRecord, "toLogRecord");
    function toSeverityNumber(severityNumber) {
      return severityNumber;
    }
    __name(toSeverityNumber, "toSeverityNumber");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/common/utils.js
var require_utils2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/common/utils.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.JSON_ENCODER = exports.PROTOBUF_ENCODER = exports.encodeAsString = exports.encodeAsLongBits = exports.toLongBits = exports.hrTimeToNanos = void 0;
    var core_1 = require_src2();
    var hex_to_binary_1 = require_hex_to_binary();
    function hrTimeToNanos(hrTime2) {
      const NANOSECONDS = BigInt(1e9);
      return BigInt(Math.trunc(hrTime2[0])) * NANOSECONDS + BigInt(Math.trunc(hrTime2[1]));
    }
    __name(hrTimeToNanos, "hrTimeToNanos");
    exports.hrTimeToNanos = hrTimeToNanos;
    function toLongBits(value) {
      const low = Number(BigInt.asUintN(32, value));
      const high = Number(BigInt.asUintN(32, value >> BigInt(32)));
      return { low, high };
    }
    __name(toLongBits, "toLongBits");
    exports.toLongBits = toLongBits;
    function encodeAsLongBits(hrTime2) {
      const nanos = hrTimeToNanos(hrTime2);
      return toLongBits(nanos);
    }
    __name(encodeAsLongBits, "encodeAsLongBits");
    exports.encodeAsLongBits = encodeAsLongBits;
    function encodeAsString(hrTime2) {
      const nanos = hrTimeToNanos(hrTime2);
      return nanos.toString();
    }
    __name(encodeAsString, "encodeAsString");
    exports.encodeAsString = encodeAsString;
    var encodeTimestamp = typeof BigInt !== "undefined" ? encodeAsString : core_1.hrTimeToNanoseconds;
    function identity(value) {
      return value;
    }
    __name(identity, "identity");
    function optionalHexToBinary(str) {
      if (str === void 0)
        return void 0;
      return (0, hex_to_binary_1.hexToBinary)(str);
    }
    __name(optionalHexToBinary, "optionalHexToBinary");
    exports.PROTOBUF_ENCODER = {
      encodeHrTime: encodeAsLongBits,
      encodeSpanContext: hex_to_binary_1.hexToBinary,
      encodeOptionalSpanContext: optionalHexToBinary,
      encodeUint8Array: identity
    };
    exports.JSON_ENCODER = {
      encodeHrTime: encodeTimestamp,
      encodeSpanContext: identity,
      encodeOptionalSpanContext: identity,
      encodeUint8Array: /* @__PURE__ */ __name((bytes) => {
        if (typeof Buffer !== "undefined") {
          return Buffer.from(bytes).toString("base64");
        }
        const chars = new Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) {
          chars[i] = String.fromCharCode(bytes[i]);
        }
        return btoa(chars.join(""));
      }, "encodeUint8Array")
    };
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/logs/json/logs.js
var require_logs3 = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/logs/json/logs.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.JsonLogsSerializer = void 0;
    var internal_1 = require_internal2();
    var utils_1 = require_utils2();
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    exports.JsonLogsSerializer = {
      serializeRequest: /* @__PURE__ */ __name((arg) => {
        const request = (0, internal_1.createExportLogsServiceRequest)(arg, utils_1.JSON_ENCODER);
        const encoder = new TextEncoder();
        return encoder.encode(JSON.stringify(request));
      }, "serializeRequest"),
      deserializeResponse: /* @__PURE__ */ __name((arg) => {
        if (arg.length === 0) {
          return {};
        }
        const decoder = new TextDecoder();
        try {
          return JSON.parse(decoder.decode(arg));
        } catch (err) {
          api_1.diag.warn(`Failed to parse logs export response: ${err.message}. Returning empty response`);
          return {};
        }
      }, "deserializeResponse")
    };
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/logs/json/index.js
var require_json = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/logs/json/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.JsonLogsSerializer = void 0;
    var logs_1 = require_logs3();
    Object.defineProperty(exports, "JsonLogsSerializer", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return logs_1.JsonLogsSerializer;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/metrics/internal-types.js
var require_internal_types = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/metrics/internal-types.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.EAggregationTemporality = void 0;
    var EAggregationTemporality;
    (function(EAggregationTemporality2) {
      EAggregationTemporality2[EAggregationTemporality2["AGGREGATION_TEMPORALITY_UNSPECIFIED"] = 0] = "AGGREGATION_TEMPORALITY_UNSPECIFIED";
      EAggregationTemporality2[EAggregationTemporality2["AGGREGATION_TEMPORALITY_DELTA"] = 1] = "AGGREGATION_TEMPORALITY_DELTA";
      EAggregationTemporality2[EAggregationTemporality2["AGGREGATION_TEMPORALITY_CUMULATIVE"] = 2] = "AGGREGATION_TEMPORALITY_CUMULATIVE";
    })(EAggregationTemporality || (exports.EAggregationTemporality = EAggregationTemporality = {}));
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/metrics/internal.js
var require_internal3 = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/metrics/internal.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createExportMetricsServiceRequest = exports.toMetric = exports.toScopeMetrics = exports.toResourceMetrics = void 0;
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    var sdk_metrics_1 = require_src3();
    var internal_types_1 = require_internal_types();
    var internal_1 = require_internal();
    function toResourceMetrics(resourceMetrics, encoder) {
      const processedResource = (0, internal_1.createResource)(resourceMetrics.resource, encoder);
      return {
        resource: processedResource,
        schemaUrl: processedResource.schemaUrl,
        scopeMetrics: toScopeMetrics(resourceMetrics.scopeMetrics, encoder)
      };
    }
    __name(toResourceMetrics, "toResourceMetrics");
    exports.toResourceMetrics = toResourceMetrics;
    function toScopeMetrics(scopeMetrics, encoder) {
      return Array.from(scopeMetrics.map((metrics) => ({
        scope: (0, internal_1.createInstrumentationScope)(metrics.scope, encoder),
        metrics: metrics.metrics.map((metricData) => toMetric(metricData, encoder)),
        schemaUrl: metrics.scope.schemaUrl
      })));
    }
    __name(toScopeMetrics, "toScopeMetrics");
    exports.toScopeMetrics = toScopeMetrics;
    function toMetric(metricData, encoder) {
      const out = {
        name: metricData.descriptor.name,
        description: metricData.descriptor.description,
        unit: metricData.descriptor.unit
      };
      const aggregationTemporality = toAggregationTemporality(metricData.aggregationTemporality);
      switch (metricData.dataPointType) {
        case sdk_metrics_1.DataPointType.SUM:
          out.sum = {
            aggregationTemporality,
            isMonotonic: metricData.isMonotonic,
            dataPoints: toSingularDataPoints(metricData, encoder)
          };
          break;
        case sdk_metrics_1.DataPointType.GAUGE:
          out.gauge = {
            dataPoints: toSingularDataPoints(metricData, encoder)
          };
          break;
        case sdk_metrics_1.DataPointType.HISTOGRAM:
          out.histogram = {
            aggregationTemporality,
            dataPoints: toHistogramDataPoints(metricData, encoder)
          };
          break;
        case sdk_metrics_1.DataPointType.EXPONENTIAL_HISTOGRAM:
          out.exponentialHistogram = {
            aggregationTemporality,
            dataPoints: toExponentialHistogramDataPoints(metricData, encoder)
          };
          break;
      }
      return out;
    }
    __name(toMetric, "toMetric");
    exports.toMetric = toMetric;
    function toSingularDataPoint(dataPoint, valueType, encoder) {
      const out = {
        attributes: (0, internal_1.toAttributes)(dataPoint.attributes, encoder),
        startTimeUnixNano: encoder.encodeHrTime(dataPoint.startTime),
        timeUnixNano: encoder.encodeHrTime(dataPoint.endTime)
      };
      switch (valueType) {
        case api_1.ValueType.INT:
          out.asInt = dataPoint.value;
          break;
        case api_1.ValueType.DOUBLE:
          out.asDouble = dataPoint.value;
          break;
      }
      return out;
    }
    __name(toSingularDataPoint, "toSingularDataPoint");
    function toSingularDataPoints(metricData, encoder) {
      return metricData.dataPoints.map((dataPoint) => {
        return toSingularDataPoint(dataPoint, metricData.descriptor.valueType, encoder);
      });
    }
    __name(toSingularDataPoints, "toSingularDataPoints");
    function toHistogramDataPoints(metricData, encoder) {
      return metricData.dataPoints.map((dataPoint) => {
        const histogram = dataPoint.value;
        return {
          attributes: (0, internal_1.toAttributes)(dataPoint.attributes, encoder),
          bucketCounts: histogram.buckets.counts,
          explicitBounds: histogram.buckets.boundaries,
          count: histogram.count,
          sum: histogram.sum,
          min: histogram.min,
          max: histogram.max,
          startTimeUnixNano: encoder.encodeHrTime(dataPoint.startTime),
          timeUnixNano: encoder.encodeHrTime(dataPoint.endTime)
        };
      });
    }
    __name(toHistogramDataPoints, "toHistogramDataPoints");
    function toExponentialHistogramDataPoints(metricData, encoder) {
      return metricData.dataPoints.map((dataPoint) => {
        const histogram = dataPoint.value;
        return {
          attributes: (0, internal_1.toAttributes)(dataPoint.attributes, encoder),
          count: histogram.count,
          min: histogram.min,
          max: histogram.max,
          sum: histogram.sum,
          positive: {
            offset: histogram.positive.offset,
            bucketCounts: histogram.positive.bucketCounts
          },
          negative: {
            offset: histogram.negative.offset,
            bucketCounts: histogram.negative.bucketCounts
          },
          scale: histogram.scale,
          zeroCount: histogram.zeroCount,
          startTimeUnixNano: encoder.encodeHrTime(dataPoint.startTime),
          timeUnixNano: encoder.encodeHrTime(dataPoint.endTime)
        };
      });
    }
    __name(toExponentialHistogramDataPoints, "toExponentialHistogramDataPoints");
    function toAggregationTemporality(temporality) {
      switch (temporality) {
        case sdk_metrics_1.AggregationTemporality.DELTA:
          return internal_types_1.EAggregationTemporality.AGGREGATION_TEMPORALITY_DELTA;
        case sdk_metrics_1.AggregationTemporality.CUMULATIVE:
          return internal_types_1.EAggregationTemporality.AGGREGATION_TEMPORALITY_CUMULATIVE;
      }
    }
    __name(toAggregationTemporality, "toAggregationTemporality");
    function createExportMetricsServiceRequest(resourceMetrics, encoder) {
      return {
        resourceMetrics: resourceMetrics.map((metrics) => toResourceMetrics(metrics, encoder))
      };
    }
    __name(createExportMetricsServiceRequest, "createExportMetricsServiceRequest");
    exports.createExportMetricsServiceRequest = createExportMetricsServiceRequest;
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/metrics/json/metrics.js
var require_metrics3 = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/metrics/json/metrics.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.JsonMetricsSerializer = void 0;
    var internal_1 = require_internal3();
    var utils_1 = require_utils2();
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    exports.JsonMetricsSerializer = {
      serializeRequest: /* @__PURE__ */ __name((arg) => {
        const request = (0, internal_1.createExportMetricsServiceRequest)([arg], utils_1.JSON_ENCODER);
        const encoder = new TextEncoder();
        return encoder.encode(JSON.stringify(request));
      }, "serializeRequest"),
      deserializeResponse: /* @__PURE__ */ __name((arg) => {
        if (arg.length === 0) {
          return {};
        }
        const decoder = new TextDecoder();
        try {
          return JSON.parse(decoder.decode(arg));
        } catch (err) {
          api_1.diag.warn(`Failed to parse metrics export response: ${err.message}. Returning empty response`);
          return {};
        }
      }, "deserializeResponse")
    };
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/metrics/json/index.js
var require_json2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/metrics/json/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.JsonMetricsSerializer = void 0;
    var metrics_1 = require_metrics3();
    Object.defineProperty(exports, "JsonMetricsSerializer", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return metrics_1.JsonMetricsSerializer;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/trace/internal.js
var require_internal4 = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/trace/internal.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createExportTraceServiceRequest = exports.toOtlpSpanEvent = exports.toOtlpLink = exports.sdkSpanToOtlpSpan = void 0;
    var internal_1 = require_internal();
    var SPAN_FLAGS_CONTEXT_HAS_IS_REMOTE_MASK = 256;
    var SPAN_FLAGS_CONTEXT_IS_REMOTE_MASK = 512;
    function buildSpanFlagsFrom(traceFlags, isRemote) {
      let flags = traceFlags & 255 | SPAN_FLAGS_CONTEXT_HAS_IS_REMOTE_MASK;
      if (isRemote) {
        flags |= SPAN_FLAGS_CONTEXT_IS_REMOTE_MASK;
      }
      return flags;
    }
    __name(buildSpanFlagsFrom, "buildSpanFlagsFrom");
    function sdkSpanToOtlpSpan(span, encoder) {
      const ctx = span.spanContext();
      const status = span.status;
      const parentSpanId = span.parentSpanContext?.spanId ? encoder.encodeSpanContext(span.parentSpanContext?.spanId) : void 0;
      return {
        traceId: encoder.encodeSpanContext(ctx.traceId),
        spanId: encoder.encodeSpanContext(ctx.spanId),
        parentSpanId,
        traceState: ctx.traceState?.serialize(),
        name: span.name,
        // Span kind is offset by 1 because the API does not define a value for unset
        kind: span.kind == null ? 0 : span.kind + 1,
        startTimeUnixNano: encoder.encodeHrTime(span.startTime),
        endTimeUnixNano: encoder.encodeHrTime(span.endTime),
        attributes: (0, internal_1.toAttributes)(span.attributes, encoder),
        droppedAttributesCount: span.droppedAttributesCount,
        events: span.events.map((event) => toOtlpSpanEvent(event, encoder)),
        droppedEventsCount: span.droppedEventsCount,
        status: {
          // API and proto enums share the same values
          code: status.code,
          message: status.message
        },
        links: span.links.map((link) => toOtlpLink(link, encoder)),
        droppedLinksCount: span.droppedLinksCount,
        flags: buildSpanFlagsFrom(ctx.traceFlags, span.parentSpanContext?.isRemote)
      };
    }
    __name(sdkSpanToOtlpSpan, "sdkSpanToOtlpSpan");
    exports.sdkSpanToOtlpSpan = sdkSpanToOtlpSpan;
    function toOtlpLink(link, encoder) {
      return {
        attributes: link.attributes ? (0, internal_1.toAttributes)(link.attributes, encoder) : [],
        spanId: encoder.encodeSpanContext(link.context.spanId),
        traceId: encoder.encodeSpanContext(link.context.traceId),
        traceState: link.context.traceState?.serialize(),
        droppedAttributesCount: link.droppedAttributesCount || 0,
        flags: buildSpanFlagsFrom(link.context.traceFlags, link.context.isRemote)
      };
    }
    __name(toOtlpLink, "toOtlpLink");
    exports.toOtlpLink = toOtlpLink;
    function toOtlpSpanEvent(timedEvent, encoder) {
      return {
        attributes: timedEvent.attributes ? (0, internal_1.toAttributes)(timedEvent.attributes, encoder) : [],
        name: timedEvent.name,
        timeUnixNano: encoder.encodeHrTime(timedEvent.time),
        droppedAttributesCount: timedEvent.droppedAttributesCount || 0
      };
    }
    __name(toOtlpSpanEvent, "toOtlpSpanEvent");
    exports.toOtlpSpanEvent = toOtlpSpanEvent;
    function createExportTraceServiceRequest(spans, encoder) {
      return {
        resourceSpans: spanRecordsToResourceSpans(spans, encoder)
      };
    }
    __name(createExportTraceServiceRequest, "createExportTraceServiceRequest");
    exports.createExportTraceServiceRequest = createExportTraceServiceRequest;
    function createResourceMap(readableSpans) {
      const resourceMap = /* @__PURE__ */ new Map();
      for (const record of readableSpans) {
        let ilsMap = resourceMap.get(record.resource);
        if (!ilsMap) {
          ilsMap = /* @__PURE__ */ new Map();
          resourceMap.set(record.resource, ilsMap);
        }
        const instrumentationScopeKey = `${record.instrumentationScope.name}@${record.instrumentationScope.version || ""}:${record.instrumentationScope.schemaUrl || ""}`;
        let records = ilsMap.get(instrumentationScopeKey);
        if (!records) {
          records = [];
          ilsMap.set(instrumentationScopeKey, records);
        }
        records.push(record);
      }
      return resourceMap;
    }
    __name(createResourceMap, "createResourceMap");
    function spanRecordsToResourceSpans(readableSpans, encoder) {
      const resourceMap = createResourceMap(readableSpans);
      const out = [];
      const entryIterator = resourceMap.entries();
      let entry = entryIterator.next();
      while (!entry.done) {
        const [resource, ilmMap] = entry.value;
        const scopeResourceSpans = [];
        const ilmIterator = ilmMap.values();
        let ilmEntry = ilmIterator.next();
        while (!ilmEntry.done) {
          const scopeSpans = ilmEntry.value;
          if (scopeSpans.length > 0) {
            const spans = scopeSpans.map((readableSpan) => sdkSpanToOtlpSpan(readableSpan, encoder));
            scopeResourceSpans.push({
              scope: (0, internal_1.createInstrumentationScope)(scopeSpans[0].instrumentationScope, encoder),
              spans,
              schemaUrl: scopeSpans[0].instrumentationScope.schemaUrl
            });
          }
          ilmEntry = ilmIterator.next();
        }
        const processedResource = (0, internal_1.createResource)(resource, encoder);
        const transformedSpans = {
          resource: processedResource,
          scopeSpans: scopeResourceSpans,
          schemaUrl: processedResource.schemaUrl
        };
        out.push(transformedSpans);
        entry = entryIterator.next();
      }
      return out;
    }
    __name(spanRecordsToResourceSpans, "spanRecordsToResourceSpans");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/trace/json/trace.js
var require_trace3 = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/trace/json/trace.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.JsonTraceSerializer = void 0;
    var internal_1 = require_internal4();
    var utils_1 = require_utils2();
    var api_1 = (init_esm(), __toCommonJS(esm_exports));
    exports.JsonTraceSerializer = {
      serializeRequest: /* @__PURE__ */ __name((arg) => {
        const request = (0, internal_1.createExportTraceServiceRequest)(arg, utils_1.JSON_ENCODER);
        const encoder = new TextEncoder();
        return encoder.encode(JSON.stringify(request));
      }, "serializeRequest"),
      deserializeResponse: /* @__PURE__ */ __name((arg) => {
        if (arg.length === 0) {
          return {};
        }
        const decoder = new TextDecoder();
        try {
          return JSON.parse(decoder.decode(arg));
        } catch (err) {
          api_1.diag.warn(`Failed to parse trace export response: ${err.message}. Returning empty response`);
          return {};
        }
      }, "deserializeResponse")
    };
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/trace/json/index.js
var require_json3 = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/trace/json/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.JsonTraceSerializer = void 0;
    var trace_1 = require_trace3();
    Object.defineProperty(exports, "JsonTraceSerializer", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return trace_1.JsonTraceSerializer;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/index.js
var require_src4 = __commonJS({
  "packages/core/node_modules/@opentelemetry/otlp-transformer/build/src/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.JsonTraceSerializer = exports.JsonMetricsSerializer = exports.JsonLogsSerializer = exports.ProtobufTraceSerializer = exports.ProtobufMetricsSerializer = exports.ProtobufLogsSerializer = exports.LogsExporterMetricsHelper = exports.TraceExporterMetricsHelper = exports.MetricsExporterMetricsHelper = void 0;
    var metrics_1 = require_metrics();
    Object.defineProperty(exports, "MetricsExporterMetricsHelper", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return metrics_1.MetricsExporterMetricsHelper;
    }, "get") });
    var trace_1 = require_trace();
    Object.defineProperty(exports, "TraceExporterMetricsHelper", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return trace_1.TraceExporterMetricsHelper;
    }, "get") });
    var logs_1 = require_logs();
    Object.defineProperty(exports, "LogsExporterMetricsHelper", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return logs_1.LogsExporterMetricsHelper;
    }, "get") });
    var protobuf_1 = require_protobuf();
    Object.defineProperty(exports, "ProtobufLogsSerializer", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return protobuf_1.ProtobufLogsSerializer;
    }, "get") });
    var protobuf_2 = require_protobuf2();
    Object.defineProperty(exports, "ProtobufMetricsSerializer", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return protobuf_2.ProtobufMetricsSerializer;
    }, "get") });
    var protobuf_3 = require_protobuf3();
    Object.defineProperty(exports, "ProtobufTraceSerializer", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return protobuf_3.ProtobufTraceSerializer;
    }, "get") });
    var json_1 = require_json();
    Object.defineProperty(exports, "JsonLogsSerializer", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return json_1.JsonLogsSerializer;
    }, "get") });
    var json_2 = require_json2();
    Object.defineProperty(exports, "JsonMetricsSerializer", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return json_2.JsonMetricsSerializer;
    }, "get") });
    var json_3 = require_json3();
    Object.defineProperty(exports, "JsonTraceSerializer", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return json_3.JsonTraceSerializer;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/util.js
function validateAndNormalizeHeaders(partialHeaders) {
  const headers = {};
  Object.entries(partialHeaders ?? {}).forEach(([key, value]) => {
    if (typeof value !== "undefined") {
      headers[key] = String(value);
    } else {
      diag.warn(`Header "${key}" has invalid value (${value}) and will be ignored`);
    }
  });
  return headers;
}
var init_util = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/util.js"() {
    init_esbuild_shims();
    init_esm();
    __name(validateAndNormalizeHeaders, "validateAndNormalizeHeaders");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/configuration/otlp-http-configuration.js
function mergeHeaders(userProvidedHeaders, fallbackHeaders, defaultHeaders) {
  return async () => {
    const requiredHeaders = {
      ...await defaultHeaders()
    };
    const headers = {};
    if (fallbackHeaders != null) {
      Object.assign(headers, await fallbackHeaders());
    }
    if (userProvidedHeaders != null) {
      Object.assign(headers, validateAndNormalizeHeaders(await userProvidedHeaders()));
    }
    return Object.assign(headers, requiredHeaders);
  };
}
function validateUserProvidedUrl(url) {
  if (url == null) {
    return void 0;
  }
  try {
    const base = globalThis.location?.href;
    return new URL(url, base).href;
  } catch {
    throw new Error(`Configuration: Could not parse user-provided export URL: '${url}'`);
  }
}
function mergeOtlpHttpConfigurationWithDefaults(userProvidedConfiguration, fallbackConfiguration, defaultConfiguration) {
  return {
    ...mergeOtlpSharedConfigurationWithDefaults(userProvidedConfiguration, fallbackConfiguration, defaultConfiguration),
    headers: mergeHeaders(userProvidedConfiguration.headers, fallbackConfiguration.headers, defaultConfiguration.headers),
    url: validateUserProvidedUrl(userProvidedConfiguration.url) ?? fallbackConfiguration.url ?? defaultConfiguration.url
  };
}
function getHttpConfigurationDefaults(requiredHeaders, signalResourcePath) {
  return {
    ...getSharedConfigurationDefaults(),
    headers: /* @__PURE__ */ __name(async () => requiredHeaders, "headers"),
    url: "http://localhost:4318/" + signalResourcePath
  };
}
var init_otlp_http_configuration = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/configuration/otlp-http-configuration.js"() {
    init_esbuild_shims();
    init_shared_configuration();
    init_util();
    __name(mergeHeaders, "mergeHeaders");
    __name(validateUserProvidedUrl, "validateUserProvidedUrl");
    __name(mergeOtlpHttpConfigurationWithDefaults, "mergeOtlpHttpConfigurationWithDefaults");
    __name(getHttpConfigurationDefaults, "getHttpConfigurationDefaults");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/configuration/otlp-node-http-configuration.js
function httpAgentFactoryFromOptions(options) {
  return async (protocol) => {
    const isInsecure = protocol === "http:";
    const module = isInsecure ? import("http") : import("https");
    const { Agent } = await module;
    if (isInsecure) {
      const { ca, cert, key, ...insecureOptions } = options;
      return new Agent(insecureOptions);
    }
    return new Agent(options);
  };
}
function mergeOtlpNodeHttpConfigurationWithDefaults(userProvidedConfiguration, fallbackConfiguration, defaultConfiguration) {
  return {
    ...mergeOtlpHttpConfigurationWithDefaults(userProvidedConfiguration, fallbackConfiguration, defaultConfiguration),
    agentFactory: userProvidedConfiguration.agentFactory ?? fallbackConfiguration.agentFactory ?? defaultConfiguration.agentFactory,
    userAgent: userProvidedConfiguration.userAgent
  };
}
function getNodeHttpConfigurationDefaults(requiredHeaders, signalResourcePath) {
  return {
    ...getHttpConfigurationDefaults(requiredHeaders, signalResourcePath),
    agentFactory: httpAgentFactoryFromOptions({ keepAlive: true })
  };
}
var init_otlp_node_http_configuration = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/configuration/otlp-node-http-configuration.js"() {
    init_esbuild_shims();
    init_otlp_http_configuration();
    __name(httpAgentFactoryFromOptions, "httpAgentFactoryFromOptions");
    __name(mergeOtlpNodeHttpConfigurationWithDefaults, "mergeOtlpNodeHttpConfigurationWithDefaults");
    __name(getNodeHttpConfigurationDefaults, "getNodeHttpConfigurationDefaults");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/is-export-retryable.js
function isExportHTTPErrorRetryable(statusCode) {
  return statusCode === 429 || statusCode === 502 || statusCode === 503 || statusCode === 504;
}
function parseRetryAfterToMills(retryAfter) {
  if (retryAfter == null) {
    return void 0;
  }
  const seconds = Number.parseInt(retryAfter, 10);
  if (Number.isInteger(seconds)) {
    return seconds > 0 ? seconds * 1e3 : -1;
  }
  const delay = new Date(retryAfter).getTime() - Date.now();
  if (delay >= 0) {
    return delay;
  }
  return 0;
}
var init_is_export_retryable = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/is-export-retryable.js"() {
    init_esbuild_shims();
    __name(isExportHTTPErrorRetryable, "isExportHTTPErrorRetryable");
    __name(parseRetryAfterToMills, "parseRetryAfterToMills");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/transport/http-transport-utils.js
import * as zlib from "zlib";
import { Readable } from "stream";
function sendWithHttp(request, url, headers, compression, userAgent, agent, data, timeoutMillis) {
  return new Promise((resolve2) => {
    const parsedUrl = new URL(url);
    if (userAgent) {
      headers["User-Agent"] = `${userAgent} ${DEFAULT_USER_AGENT}`;
    } else {
      headers["User-Agent"] = DEFAULT_USER_AGENT;
    }
    const options = {
      method: "POST",
      headers,
      agent
    };
    const req = request(parsedUrl, options, (res) => {
      const responseData = [];
      let responseSize = 0;
      res.on("data", (chunk) => {
        responseSize += chunk.length;
        if (responseSize > MAX_RESPONSE_BODY_SIZE) {
          const sizeError = new Error(`OTLP export response body exceeded size limit of ${MAX_RESPONSE_BODY_SIZE} bytes`);
          resolve2({ status: "failure", error: sizeError });
          res.destroy();
          return;
        }
        responseData.push(chunk);
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode <= 299) {
          resolve2({
            status: "success",
            data: Buffer.concat(responseData)
          });
        } else if (res.statusCode && isExportHTTPErrorRetryable(res.statusCode)) {
          resolve2({
            status: "retryable",
            retryInMillis: parseRetryAfterToMills(res.headers["retry-after"])
          });
        } else {
          const error = new OTLPExporterError(res.statusMessage, res.statusCode, Buffer.concat(responseData).toString());
          resolve2({
            status: "failure",
            error
          });
        }
      });
      res.on("error", (error) => {
        if (res.statusCode && res.statusCode <= 299) {
          resolve2({
            status: "success"
          });
        } else if (res.statusCode && isExportHTTPErrorRetryable(res.statusCode)) {
          resolve2({
            status: "retryable",
            error,
            retryInMillis: parseRetryAfterToMills(res.headers["retry-after"])
          });
        } else {
          resolve2({
            status: "failure",
            error
          });
        }
      });
    });
    req.setTimeout(timeoutMillis, () => {
      req.destroy();
      resolve2({
        status: "retryable",
        error: new Error("Request timed out")
      });
    });
    req.on("error", (error) => {
      if (isHttpTransportNetworkErrorRetryable(error)) {
        resolve2({
          status: "retryable",
          error
        });
      } else {
        resolve2({
          status: "failure",
          error
        });
      }
    });
    compressAndSend(req, compression, data, (error) => {
      resolve2({
        status: "failure",
        error
      });
    });
  });
}
function compressAndSend(req, compression, data, onError) {
  let dataStream = readableFromUint8Array(data);
  if (compression === "gzip") {
    req.setHeader("Content-Encoding", "gzip");
    dataStream = dataStream.on("error", onError).pipe(zlib.createGzip()).on("error", onError);
  }
  dataStream.pipe(req).on("error", onError);
}
function readableFromUint8Array(buff) {
  const readable = new Readable();
  readable.push(buff);
  readable.push(null);
  return readable;
}
function isHttpTransportNetworkErrorRetryable(error) {
  const RETRYABLE_NETWORK_ERROR_CODES = /* @__PURE__ */ new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "ENETUNREACH",
    "EHOSTUNREACH"
  ]);
  if ("code" in error && typeof error.code === "string") {
    return RETRYABLE_NETWORK_ERROR_CODES.has(error.code);
  }
  return false;
}
var DEFAULT_USER_AGENT, MAX_RESPONSE_BODY_SIZE;
var init_http_transport_utils = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/transport/http-transport-utils.js"() {
    init_esbuild_shims();
    init_is_export_retryable();
    init_types();
    init_version();
    DEFAULT_USER_AGENT = `OTel-OTLP-Exporter-JavaScript/${VERSION}`;
    MAX_RESPONSE_BODY_SIZE = 4 * 1024 * 1024;
    __name(sendWithHttp, "sendWithHttp");
    __name(compressAndSend, "compressAndSend");
    __name(readableFromUint8Array, "readableFromUint8Array");
    __name(isHttpTransportNetworkErrorRetryable, "isHttpTransportNetworkErrorRetryable");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/transport/http-exporter-transport.js
async function requestFunctionFactory(protocol) {
  const module = protocol === "http:" ? import("http") : import("https");
  const { request } = await module;
  return request;
}
function createHttpExporterTransport(parameters) {
  return new HttpExporterTransport(parameters);
}
var HttpExporterTransport;
var init_http_exporter_transport = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/transport/http-exporter-transport.js"() {
    init_esbuild_shims();
    init_http_transport_utils();
    HttpExporterTransport = class {
      static {
        __name(this, "HttpExporterTransport");
      }
      _utils = null;
      _parameters;
      constructor(parameters) {
        this._parameters = parameters;
      }
      async send(data, timeoutMillis) {
        const { agent, request } = await this._loadUtils();
        const headers = await this._parameters.headers();
        return sendWithHttp(request, this._parameters.url, headers, this._parameters.compression, this._parameters.userAgent, agent, data, timeoutMillis);
      }
      shutdown() {
      }
      async _loadUtils() {
        let utils = this._utils;
        if (utils === null) {
          const protocol = new URL(this._parameters.url).protocol;
          const [agent, request] = await Promise.all([
            this._parameters.agentFactory(protocol),
            requestFunctionFactory(protocol)
          ]);
          utils = this._utils = { agent, request };
        }
        return utils;
      }
    };
    __name(requestFunctionFactory, "requestFunctionFactory");
    __name(createHttpExporterTransport, "createHttpExporterTransport");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/retrying-transport.js
function getJitter() {
  return Math.random() * (2 * JITTER) - JITTER;
}
function createRetryingTransport(options) {
  return new RetryingTransport(options.transport);
}
var MAX_ATTEMPTS, INITIAL_BACKOFF, MAX_BACKOFF, BACKOFF_MULTIPLIER, JITTER, RetryingTransport;
var init_retrying_transport = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/retrying-transport.js"() {
    init_esbuild_shims();
    init_esm();
    MAX_ATTEMPTS = 5;
    INITIAL_BACKOFF = 1e3;
    MAX_BACKOFF = 5e3;
    BACKOFF_MULTIPLIER = 1.5;
    JITTER = 0.2;
    __name(getJitter, "getJitter");
    RetryingTransport = class {
      static {
        __name(this, "RetryingTransport");
      }
      _transport;
      constructor(transport) {
        this._transport = transport;
      }
      retry(data, timeoutMillis, inMillis) {
        return new Promise((resolve2, reject) => {
          setTimeout(() => {
            this._transport.send(data, timeoutMillis).then(resolve2, reject);
          }, inMillis);
        });
      }
      async send(data, timeoutMillis) {
        let attempts = MAX_ATTEMPTS;
        let nextBackoff = INITIAL_BACKOFF;
        const deadline = Date.now() + timeoutMillis;
        let result = await this._transport.send(data, timeoutMillis);
        while (result.status === "retryable" && attempts > 0) {
          attempts--;
          const backoff = Math.max(Math.min(nextBackoff * (1 + getJitter()), MAX_BACKOFF), 0);
          nextBackoff = nextBackoff * BACKOFF_MULTIPLIER;
          const retryInMillis = result.retryInMillis ?? backoff;
          const remainingTimeoutMillis = deadline - Date.now();
          if (retryInMillis > remainingTimeoutMillis) {
            diag.info(`Export retry time ${Math.round(retryInMillis)}ms exceeds remaining timeout ${Math.round(remainingTimeoutMillis)}ms, not retrying further.`);
            return result;
          }
          diag.verbose(`Scheduling export retry in ${Math.round(retryInMillis)}ms`);
          result = await this.retry(data, remainingTimeoutMillis, retryInMillis);
        }
        if (result.status === "success") {
          diag.verbose(`Export succeeded after ${MAX_ATTEMPTS - attempts} retry attempts.`);
        } else if (result.status === "retryable") {
          diag.info(`Export failed after maximum retry attempts (${MAX_ATTEMPTS}).`);
        } else {
          diag.info(`Export failed with non-retryable error: ${result.error}`);
        }
        return result;
      }
      shutdown() {
        return this._transport.shutdown();
      }
    };
    __name(createRetryingTransport, "createRetryingTransport");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/otlp-http-export-delegate.js
function createOtlpHttpExporterMetrics(metricsComponentType, exporterMetricsHelper, url, meterProvider) {
  return new ExporterMetrics({
    componentType: metricsComponentType,
    metricsHelper: exporterMetricsHelper,
    url,
    meterProvider,
    responseAttributesFromError: /* @__PURE__ */ __name((error) => {
      if (!error) {
        return {
          [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200
        };
      }
      if (!(error instanceof OTLPExporterError)) {
        return {};
      }
      return {
        [ATTR_HTTP_RESPONSE_STATUS_CODE]: error.code
      };
    }, "responseAttributesFromError")
  });
}
function createOtlpHttpExportDelegate(options, serializer, metricsComponentType, exporterMetricsHelper, meterProvider) {
  return createOtlpExportDelegate({
    transport: createRetryingTransport({
      transport: createHttpExporterTransport(options)
    }),
    serializer,
    promiseHandler: createBoundedQueueExportPromiseHandler(options),
    metrics: createOtlpHttpExporterMetrics(metricsComponentType, exporterMetricsHelper, options.url, meterProvider)
  }, { timeout: options.timeoutMillis });
}
var init_otlp_http_export_delegate = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/otlp-http-export-delegate.js"() {
    init_esbuild_shims();
    init_otlp_export_delegate();
    init_http_exporter_transport();
    init_bounded_queue_export_promise_handler();
    init_retrying_transport();
    init_types();
    init_semconv();
    init_ExporterMetrics();
    __name(createOtlpHttpExporterMetrics, "createOtlpHttpExporterMetrics");
    __name(createOtlpHttpExportDelegate, "createOtlpHttpExportDelegate");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/configuration/shared-env-configuration.js
function parseAndValidateTimeoutFromEnv(timeoutEnvVar) {
  const envTimeout = (0, import_core3.getNumberFromEnv)(timeoutEnvVar);
  if (envTimeout != null) {
    if (Number.isFinite(envTimeout) && envTimeout > 0) {
      return envTimeout;
    }
    diag.warn(`Configuration: ${timeoutEnvVar} is invalid, expected number greater than 0 (actual: ${envTimeout})`);
  }
  return void 0;
}
function getTimeoutFromEnv(signalIdentifier) {
  const specificTimeout = parseAndValidateTimeoutFromEnv(`OTEL_EXPORTER_OTLP_${signalIdentifier}_TIMEOUT`);
  const nonSpecificTimeout = parseAndValidateTimeoutFromEnv("OTEL_EXPORTER_OTLP_TIMEOUT");
  return specificTimeout ?? nonSpecificTimeout;
}
function parseAndValidateCompressionFromEnv(compressionEnvVar) {
  const compression = (0, import_core3.getStringFromEnv)(compressionEnvVar)?.trim();
  if (compression == null || compression === "none" || compression === "gzip") {
    return compression;
  }
  diag.warn(`Configuration: ${compressionEnvVar} is invalid, expected 'none' or 'gzip' (actual: '${compression}')`);
  return void 0;
}
function getCompressionFromEnv(signalIdentifier) {
  const specificCompression = parseAndValidateCompressionFromEnv(`OTEL_EXPORTER_OTLP_${signalIdentifier}_COMPRESSION`);
  const nonSpecificCompression = parseAndValidateCompressionFromEnv("OTEL_EXPORTER_OTLP_COMPRESSION");
  return specificCompression ?? nonSpecificCompression;
}
function getSharedConfigurationFromEnvironment(signalIdentifier) {
  return {
    timeoutMillis: getTimeoutFromEnv(signalIdentifier),
    compression: getCompressionFromEnv(signalIdentifier)
  };
}
var import_core3;
var init_shared_env_configuration = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/configuration/shared-env-configuration.js"() {
    init_esbuild_shims();
    import_core3 = __toESM(require_src2());
    init_esm();
    __name(parseAndValidateTimeoutFromEnv, "parseAndValidateTimeoutFromEnv");
    __name(getTimeoutFromEnv, "getTimeoutFromEnv");
    __name(parseAndValidateCompressionFromEnv, "parseAndValidateCompressionFromEnv");
    __name(getCompressionFromEnv, "getCompressionFromEnv");
    __name(getSharedConfigurationFromEnvironment, "getSharedConfigurationFromEnvironment");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/configuration/otlp-node-http-env-configuration.js
import * as fs from "fs";
import * as path from "path";
function getStaticHeadersFromEnv(signalIdentifier) {
  const signalSpecificRawHeaders = (0, import_core4.getStringFromEnv)(`OTEL_EXPORTER_OTLP_${signalIdentifier}_HEADERS`);
  const nonSignalSpecificRawHeaders = (0, import_core4.getStringFromEnv)("OTEL_EXPORTER_OTLP_HEADERS");
  const signalSpecificHeaders = (0, import_core4.parseKeyPairsIntoRecord)(signalSpecificRawHeaders);
  const nonSignalSpecificHeaders = (0, import_core4.parseKeyPairsIntoRecord)(nonSignalSpecificRawHeaders);
  if (Object.keys(signalSpecificHeaders).length === 0 && Object.keys(nonSignalSpecificHeaders).length === 0) {
    return void 0;
  }
  return Object.assign({}, (0, import_core4.parseKeyPairsIntoRecord)(nonSignalSpecificRawHeaders), (0, import_core4.parseKeyPairsIntoRecord)(signalSpecificRawHeaders));
}
function appendRootPathToUrlIfNeeded(url) {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.toString();
  } catch {
    diag.warn(`Configuration: Could not parse environment-provided export URL: '${url}', falling back to undefined`);
    return void 0;
  }
}
function appendResourcePathToUrl(url, path2) {
  try {
    new URL(url);
  } catch {
    diag.warn(`Configuration: Could not parse environment-provided export URL: '${url}', falling back to undefined`);
    return void 0;
  }
  if (!url.endsWith("/")) {
    url = url + "/";
  }
  url += path2;
  try {
    new URL(url);
  } catch {
    diag.warn(`Configuration: Provided URL appended with '${path2}' is not a valid URL, using 'undefined' instead of '${url}'`);
    return void 0;
  }
  return url;
}
function getNonSpecificUrlFromEnv(signalResourcePath) {
  const envUrl = (0, import_core4.getStringFromEnv)("OTEL_EXPORTER_OTLP_ENDPOINT");
  if (envUrl === void 0) {
    return void 0;
  }
  return appendResourcePathToUrl(envUrl, signalResourcePath);
}
function getSpecificUrlFromEnv(signalIdentifier) {
  const envUrl = (0, import_core4.getStringFromEnv)(`OTEL_EXPORTER_OTLP_${signalIdentifier}_ENDPOINT`);
  if (envUrl === void 0) {
    return void 0;
  }
  return appendRootPathToUrlIfNeeded(envUrl);
}
function readFileFromEnv(signalSpecificEnvVar, nonSignalSpecificEnvVar, warningMessage) {
  const signalSpecificPath = (0, import_core4.getStringFromEnv)(signalSpecificEnvVar);
  const nonSignalSpecificPath = (0, import_core4.getStringFromEnv)(nonSignalSpecificEnvVar);
  const filePath = signalSpecificPath ?? nonSignalSpecificPath;
  if (filePath != null) {
    try {
      return fs.readFileSync(path.resolve(process.cwd(), filePath));
    } catch {
      diag.warn(warningMessage);
      return void 0;
    }
  } else {
    return void 0;
  }
}
function getClientCertificateFromEnv(signalIdentifier) {
  return readFileFromEnv(`OTEL_EXPORTER_OTLP_${signalIdentifier}_CLIENT_CERTIFICATE`, "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE", "Failed to read client certificate chain file");
}
function getClientKeyFromEnv(signalIdentifier) {
  return readFileFromEnv(`OTEL_EXPORTER_OTLP_${signalIdentifier}_CLIENT_KEY`, "OTEL_EXPORTER_OTLP_CLIENT_KEY", "Failed to read client certificate private key file");
}
function getRootCertificateFromEnv(signalIdentifier) {
  return readFileFromEnv(`OTEL_EXPORTER_OTLP_${signalIdentifier}_CERTIFICATE`, "OTEL_EXPORTER_OTLP_CERTIFICATE", "Failed to read root certificate file");
}
function getNodeHttpConfigurationFromEnvironment(signalIdentifier, signalResourcePath) {
  return {
    ...getSharedConfigurationFromEnvironment(signalIdentifier),
    url: getSpecificUrlFromEnv(signalIdentifier) ?? getNonSpecificUrlFromEnv(signalResourcePath),
    headers: wrapStaticHeadersInFunction(getStaticHeadersFromEnv(signalIdentifier)),
    agentFactory: httpAgentFactoryFromOptions({
      keepAlive: true,
      ca: getRootCertificateFromEnv(signalIdentifier),
      cert: getClientCertificateFromEnv(signalIdentifier),
      key: getClientKeyFromEnv(signalIdentifier)
    })
  };
}
var import_core4;
var init_otlp_node_http_env_configuration = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/configuration/otlp-node-http-env-configuration.js"() {
    init_esbuild_shims();
    import_core4 = __toESM(require_src2());
    init_esm();
    init_shared_env_configuration();
    init_shared_configuration();
    init_otlp_node_http_configuration();
    __name(getStaticHeadersFromEnv, "getStaticHeadersFromEnv");
    __name(appendRootPathToUrlIfNeeded, "appendRootPathToUrlIfNeeded");
    __name(appendResourcePathToUrl, "appendResourcePathToUrl");
    __name(getNonSpecificUrlFromEnv, "getNonSpecificUrlFromEnv");
    __name(getSpecificUrlFromEnv, "getSpecificUrlFromEnv");
    __name(readFileFromEnv, "readFileFromEnv");
    __name(getClientCertificateFromEnv, "getClientCertificateFromEnv");
    __name(getClientKeyFromEnv, "getClientKeyFromEnv");
    __name(getRootCertificateFromEnv, "getRootCertificateFromEnv");
    __name(getNodeHttpConfigurationFromEnvironment, "getNodeHttpConfigurationFromEnvironment");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/configuration/convert-legacy-http-options.js
function convertLegacyHeaders(config) {
  if (typeof config.headers === "function") {
    return config.headers;
  }
  return wrapStaticHeadersInFunction(config.headers);
}
var init_convert_legacy_http_options = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/configuration/convert-legacy-http-options.js"() {
    init_esbuild_shims();
    init_shared_configuration();
    __name(convertLegacyHeaders, "convertLegacyHeaders");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/configuration/convert-legacy-node-http-options.js
function convertLegacyAgentOptions(config) {
  if (typeof config.httpAgentOptions === "function") {
    return config.httpAgentOptions;
  }
  let legacy = config.httpAgentOptions;
  if (config.keepAlive != null) {
    legacy = { keepAlive: config.keepAlive, ...legacy };
  }
  if (legacy != null) {
    return httpAgentFactoryFromOptions(legacy);
  } else {
    return void 0;
  }
}
function convertLegacyHttpOptions(config, signalIdentifier, signalResourcePath, requiredHeaders) {
  if (config.metadata) {
    diag.warn("Metadata cannot be set when using http");
  }
  return mergeOtlpNodeHttpConfigurationWithDefaults({
    url: config.url,
    headers: convertLegacyHeaders(config),
    concurrencyLimit: config.concurrencyLimit,
    timeoutMillis: config.timeoutMillis,
    compression: config.compression,
    agentFactory: convertLegacyAgentOptions(config),
    userAgent: config.userAgent
  }, getNodeHttpConfigurationFromEnvironment(signalIdentifier, signalResourcePath), getNodeHttpConfigurationDefaults(requiredHeaders, signalResourcePath));
}
var init_convert_legacy_node_http_options = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/configuration/convert-legacy-node-http-options.js"() {
    init_esbuild_shims();
    init_esm();
    init_otlp_node_http_configuration();
    init_index_node_http();
    init_otlp_node_http_env_configuration();
    init_convert_legacy_http_options();
    __name(convertLegacyAgentOptions, "convertLegacyAgentOptions");
    __name(convertLegacyHttpOptions, "convertLegacyHttpOptions");
  }
});

// packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/index-node-http.js
var index_node_http_exports = {};
__export(index_node_http_exports, {
  convertLegacyHttpOptions: () => convertLegacyHttpOptions,
  createOtlpHttpExportDelegate: () => createOtlpHttpExportDelegate,
  createOtlpHttpExporterMetrics: () => createOtlpHttpExporterMetrics,
  getSharedConfigurationFromEnvironment: () => getSharedConfigurationFromEnvironment,
  httpAgentFactoryFromOptions: () => httpAgentFactoryFromOptions
});
var init_index_node_http = __esm({
  "packages/core/node_modules/@opentelemetry/otlp-exporter-base/build/esm/index-node-http.js"() {
    init_esbuild_shims();
    init_otlp_node_http_configuration();
    init_otlp_http_export_delegate();
    init_shared_env_configuration();
    init_convert_legacy_node_http_options();
  }
});

// packages/core/node_modules/@opentelemetry/exporter-metrics-otlp-http/build/src/semconv.js
var require_semconv = __commonJS({
  "packages/core/node_modules/@opentelemetry/exporter-metrics-otlp-http/build/src/semconv.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_METRIC_EXPORTER = void 0;
    exports.OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_METRIC_EXPORTER = "otlp_http_metric_exporter";
  }
});

// packages/core/node_modules/@opentelemetry/exporter-metrics-otlp-http/build/src/platform/node/OTLPMetricExporter.js
var require_OTLPMetricExporter = __commonJS({
  "packages/core/node_modules/@opentelemetry/exporter-metrics-otlp-http/build/src/platform/node/OTLPMetricExporter.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OTLPMetricExporter = void 0;
    var OTLPMetricExporterBase_1 = require_OTLPMetricExporterBase();
    var otlp_transformer_1 = require_src4();
    var node_http_1 = (init_index_node_http(), __toCommonJS(index_node_http_exports));
    var semconv_1 = require_semconv();
    var OTLPMetricExporter = class extends OTLPMetricExporterBase_1.OTLPMetricExporterBase {
      static {
        __name(this, "OTLPMetricExporter");
      }
      _url;
      constructor(config) {
        super((0, node_http_1.createOtlpHttpExportDelegate)((0, node_http_1.convertLegacyHttpOptions)(config ?? {}, "METRICS", "v1/metrics", {
          "Content-Type": "application/json"
        }), otlp_transformer_1.JsonMetricsSerializer, semconv_1.OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_METRIC_EXPORTER, otlp_transformer_1.MetricsExporterMetricsHelper, config?.selfObsMeterProvider), config);
        this._url = config?.url;
      }
      /**
       * Sets the meter provider to use to collect metrics for the exporter itself.
       * @experimental This method is experimental and is subject to breaking changes in minor releases.
       */
      setSelfObsMeterProvider(meterProvider) {
        this.setMetrics((0, node_http_1.createOtlpHttpExporterMetrics)(semconv_1.OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_METRIC_EXPORTER, otlp_transformer_1.MetricsExporterMetricsHelper, this._url, meterProvider));
      }
    };
    exports.OTLPMetricExporter = OTLPMetricExporter;
  }
});

// packages/core/node_modules/@opentelemetry/exporter-metrics-otlp-http/build/src/platform/node/index.js
var require_node = __commonJS({
  "packages/core/node_modules/@opentelemetry/exporter-metrics-otlp-http/build/src/platform/node/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OTLPMetricExporter = void 0;
    var OTLPMetricExporter_1 = require_OTLPMetricExporter();
    Object.defineProperty(exports, "OTLPMetricExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return OTLPMetricExporter_1.OTLPMetricExporter;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/exporter-metrics-otlp-http/build/src/platform/index.js
var require_platform = __commonJS({
  "packages/core/node_modules/@opentelemetry/exporter-metrics-otlp-http/build/src/platform/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OTLPMetricExporter = void 0;
    var node_1 = require_node();
    Object.defineProperty(exports, "OTLPMetricExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.OTLPMetricExporter;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/exporter-metrics-otlp-http/build/src/index.js
var require_src5 = __commonJS({
  "packages/core/node_modules/@opentelemetry/exporter-metrics-otlp-http/build/src/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OTLPMetricExporterBase = exports.LowMemoryTemporalitySelector = exports.DeltaTemporalitySelector = exports.CumulativeTemporalitySelector = exports.AggregationTemporalityPreference = exports.OTLPMetricExporter = void 0;
    var platform_1 = require_platform();
    Object.defineProperty(exports, "OTLPMetricExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.OTLPMetricExporter;
    }, "get") });
    var OTLPMetricExporterOptions_1 = require_OTLPMetricExporterOptions();
    Object.defineProperty(exports, "AggregationTemporalityPreference", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return OTLPMetricExporterOptions_1.AggregationTemporalityPreference;
    }, "get") });
    var OTLPMetricExporterBase_1 = require_OTLPMetricExporterBase();
    Object.defineProperty(exports, "CumulativeTemporalitySelector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return OTLPMetricExporterBase_1.CumulativeTemporalitySelector;
    }, "get") });
    Object.defineProperty(exports, "DeltaTemporalitySelector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return OTLPMetricExporterBase_1.DeltaTemporalitySelector;
    }, "get") });
    Object.defineProperty(exports, "LowMemoryTemporalitySelector", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return OTLPMetricExporterBase_1.LowMemoryTemporalitySelector;
    }, "get") });
    Object.defineProperty(exports, "OTLPMetricExporterBase", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return OTLPMetricExporterBase_1.OTLPMetricExporterBase;
    }, "get") });
  }
});

export {
  CompressionAlgorithm,
  esm_exports2 as esm_exports,
  init_esm2 as init_esm,
  require_src4 as require_src,
  index_node_http_exports,
  init_index_node_http,
  require_src5 as require_src2
};
