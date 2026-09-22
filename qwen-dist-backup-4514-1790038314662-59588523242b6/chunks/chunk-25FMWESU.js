// Force strict mode and setup for ESM
"use strict";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorMessage,
  isAbortError,
  isNodeError
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __commonJS,
  __name,
  __require,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// node_modules/chardet/lib/fs/node.js
var require_node = __commonJS({
  "node_modules/chardet/lib/fs/node.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    var fsModule;
    exports.default = () => {
      if (typeof module === "object" && typeof module.exports === "object") {
        fsModule = fsModule ? fsModule : __require("fs");
        return fsModule;
      }
      throw new Error("File system is not available");
    };
  }
});

// node_modules/chardet/lib/match.js
var require_match = __commonJS({
  "node_modules/chardet/lib/match.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = (ctx, rec, confidence) => ({
      confidence,
      name: rec.name(ctx),
      lang: rec.language ? rec.language() : void 0
    });
  }
});

// node_modules/chardet/lib/encoding/ascii.js
var require_ascii = __commonJS({
  "node_modules/chardet/lib/encoding/ascii.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    var match_1 = __importDefault(require_match());
    var Ascii = class {
      static {
        __name(this, "Ascii");
      }
      name() {
        return "ASCII";
      }
      match(det) {
        const input = det.rawInput;
        for (let i = 0; i < det.rawLen; i++) {
          const b = input[i];
          if (b < 32 || b > 126) {
            return (0, match_1.default)(det, this, 0);
          }
        }
        return (0, match_1.default)(det, this, 100);
      }
    };
    exports.default = Ascii;
  }
});

// node_modules/chardet/lib/encoding/utf8.js
var require_utf8 = __commonJS({
  "node_modules/chardet/lib/encoding/utf8.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    var match_1 = __importDefault(require_match());
    var Utf8 = class {
      static {
        __name(this, "Utf8");
      }
      name() {
        return "UTF-8";
      }
      match(det) {
        let hasBOM = false, numValid = 0, numInvalid = 0, trailBytes = 0, confidence;
        const input = det.rawInput;
        if (det.rawLen >= 3 && (input[0] & 255) == 239 && (input[1] & 255) == 187 && (input[2] & 255) == 191) {
          hasBOM = true;
        }
        for (let i = 0; i < det.rawLen; i++) {
          const b = input[i];
          if ((b & 128) == 0)
            continue;
          if ((b & 224) == 192) {
            trailBytes = 1;
          } else if ((b & 240) == 224) {
            trailBytes = 2;
          } else if ((b & 248) == 240) {
            trailBytes = 3;
          } else {
            numInvalid++;
            if (numInvalid > 5)
              break;
            trailBytes = 0;
          }
          for (; ; ) {
            i++;
            if (i >= det.rawLen)
              break;
            if ((input[i] & 192) != 128) {
              numInvalid++;
              break;
            }
            if (--trailBytes == 0) {
              numValid++;
              break;
            }
          }
        }
        confidence = 0;
        if (hasBOM && numInvalid == 0)
          confidence = 100;
        else if (hasBOM && numValid > numInvalid * 10)
          confidence = 80;
        else if (numValid > 3 && numInvalid == 0)
          confidence = 100;
        else if (numValid > 0 && numInvalid == 0)
          confidence = 80;
        else if (numValid == 0 && numInvalid == 0)
          confidence = 10;
        else if (numValid > numInvalid * 10)
          confidence = 25;
        else
          return null;
        return (0, match_1.default)(det, this, confidence);
      }
    };
    exports.default = Utf8;
  }
});

// node_modules/chardet/lib/encoding/unicode.js
var require_unicode = __commonJS({
  "node_modules/chardet/lib/encoding/unicode.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.UTF_32LE = exports.UTF_32BE = exports.UTF_16LE = exports.UTF_16BE = void 0;
    var match_1 = __importDefault(require_match());
    var UTF_16BE = class {
      static {
        __name(this, "UTF_16BE");
      }
      name() {
        return "UTF-16BE";
      }
      match(det) {
        const input = det.rawInput;
        if (input.length >= 2 && (input[0] & 255) == 254 && (input[1] & 255) == 255) {
          return (0, match_1.default)(det, this, 100);
        }
        return null;
      }
    };
    exports.UTF_16BE = UTF_16BE;
    var UTF_16LE = class {
      static {
        __name(this, "UTF_16LE");
      }
      name() {
        return "UTF-16LE";
      }
      match(det) {
        const input = det.rawInput;
        if (input.length >= 2 && (input[0] & 255) == 255 && (input[1] & 255) == 254) {
          if (input.length >= 4 && input[2] == 0 && input[3] == 0) {
            return null;
          }
          return (0, match_1.default)(det, this, 100);
        }
        return null;
      }
    };
    exports.UTF_16LE = UTF_16LE;
    var UTF_32 = class {
      static {
        __name(this, "UTF_32");
      }
      name() {
        return "UTF-32";
      }
      getChar(_input, _index) {
        return -1;
      }
      match(det) {
        let numValid = 0, numInvalid = 0, hasBOM = false, confidence = 0;
        const limit = det.rawLen / 4 * 4;
        const input = det.rawInput;
        if (limit == 0) {
          return null;
        }
        if (this.getChar(input, 0) == 65279) {
          hasBOM = true;
        }
        for (let i = 0; i < limit; i += 4) {
          const ch = this.getChar(input, i);
          if (ch < 0 || ch >= 1114111 || ch >= 55296 && ch <= 57343) {
            numInvalid += 1;
          } else {
            numValid += 1;
          }
        }
        if (hasBOM && numInvalid == 0) {
          confidence = 100;
        } else if (hasBOM && numValid > numInvalid * 10) {
          confidence = 80;
        } else if (numValid > 3 && numInvalid == 0) {
          confidence = 100;
        } else if (numValid > 0 && numInvalid == 0) {
          confidence = 80;
        } else if (numValid > numInvalid * 10) {
          confidence = 25;
        }
        return confidence == 0 ? null : (0, match_1.default)(det, this, confidence);
      }
    };
    var UTF_32BE = class extends UTF_32 {
      static {
        __name(this, "UTF_32BE");
      }
      name() {
        return "UTF-32BE";
      }
      getChar(input, index) {
        return (input[index + 0] & 255) << 24 | (input[index + 1] & 255) << 16 | (input[index + 2] & 255) << 8 | input[index + 3] & 255;
      }
    };
    exports.UTF_32BE = UTF_32BE;
    var UTF_32LE = class extends UTF_32 {
      static {
        __name(this, "UTF_32LE");
      }
      name() {
        return "UTF-32LE";
      }
      getChar(input, index) {
        return (input[index + 3] & 255) << 24 | (input[index + 2] & 255) << 16 | (input[index + 1] & 255) << 8 | input[index + 0] & 255;
      }
    };
    exports.UTF_32LE = UTF_32LE;
  }
});

// node_modules/chardet/lib/encoding/mbcs.js
var require_mbcs = __commonJS({
  "node_modules/chardet/lib/encoding/mbcs.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.gb_18030 = exports.euc_kr = exports.euc_jp = exports.big5 = exports.sjis = void 0;
    var match_1 = __importDefault(require_match());
    function binarySearch(arr, searchValue) {
      const find = /* @__PURE__ */ __name((arr2, searchValue2, left, right) => {
        if (right < left)
          return -1;
        const mid = Math.floor(left + right >>> 1);
        if (searchValue2 > arr2[mid])
          return find(arr2, searchValue2, mid + 1, right);
        if (searchValue2 < arr2[mid])
          return find(arr2, searchValue2, left, mid - 1);
        return mid;
      }, "find");
      return find(arr, searchValue, 0, arr.length - 1);
    }
    __name(binarySearch, "binarySearch");
    var IteratedChar = class {
      static {
        __name(this, "IteratedChar");
      }
      constructor() {
        this.charValue = 0;
        this.index = 0;
        this.nextIndex = 0;
        this.error = false;
        this.done = false;
      }
      reset() {
        this.charValue = 0;
        this.index = -1;
        this.nextIndex = 0;
        this.error = false;
        this.done = false;
      }
      nextByte(det) {
        if (this.nextIndex >= det.rawLen) {
          this.done = true;
          return -1;
        }
        const byteValue = det.rawInput[this.nextIndex++] & 255;
        return byteValue;
      }
    };
    var mbcs = class {
      static {
        __name(this, "mbcs");
      }
      constructor() {
        this.commonChars = [];
      }
      name() {
        return "mbcs";
      }
      match(det) {
        let doubleByteCharCount = 0, commonCharCount = 0, badCharCount = 0, totalCharCount = 0, confidence = 0;
        const iter = new IteratedChar();
        detectBlock: {
          for (iter.reset(); this.nextChar(iter, det); ) {
            totalCharCount++;
            if (iter.error) {
              badCharCount++;
            } else {
              const cv = iter.charValue & 4294967295;
              if (cv > 255) {
                doubleByteCharCount++;
                if (this.commonChars != null) {
                  if (binarySearch(this.commonChars, cv) >= 0) {
                    commonCharCount++;
                  }
                }
              }
            }
            if (badCharCount >= 2 && badCharCount * 5 >= doubleByteCharCount) {
              break detectBlock;
            }
          }
          if (doubleByteCharCount <= 10 && badCharCount == 0) {
            if (doubleByteCharCount == 0 && totalCharCount < 10) {
              confidence = 0;
            } else {
              confidence = 10;
            }
            break detectBlock;
          }
          if (doubleByteCharCount < 20 * badCharCount) {
            confidence = 0;
            break detectBlock;
          }
          if (this.commonChars == null) {
            confidence = 30 + doubleByteCharCount - 20 * badCharCount;
            if (confidence > 100) {
              confidence = 100;
            }
          } else {
            const maxVal = Math.log(doubleByteCharCount / 4);
            const scaleFactor = 90 / maxVal;
            confidence = Math.floor(Math.log(commonCharCount + 1) * scaleFactor + 10);
            confidence = Math.min(confidence, 100);
          }
        }
        return confidence == 0 ? null : (0, match_1.default)(det, this, confidence);
      }
      nextChar(_iter, _det) {
        return true;
      }
    };
    var sjis = class extends mbcs {
      static {
        __name(this, "sjis");
      }
      constructor() {
        super(...arguments);
        this.commonChars = [
          33088,
          33089,
          33090,
          33093,
          33115,
          33129,
          33130,
          33141,
          33142,
          33440,
          33442,
          33444,
          33449,
          33450,
          33451,
          33453,
          33455,
          33457,
          33459,
          33461,
          33463,
          33469,
          33470,
          33473,
          33476,
          33477,
          33478,
          33480,
          33481,
          33484,
          33485,
          33500,
          33504,
          33511,
          33512,
          33513,
          33514,
          33520,
          33521,
          33601,
          33603,
          33614,
          33615,
          33624,
          33630,
          33634,
          33639,
          33653,
          33654,
          33673,
          33674,
          33675,
          33677,
          33683,
          36502,
          37882,
          38314
        ];
      }
      name() {
        return "Shift_JIS";
      }
      language() {
        return "ja";
      }
      nextChar(iter, det) {
        iter.index = iter.nextIndex;
        iter.error = false;
        const firstByte = iter.charValue = iter.nextByte(det);
        if (firstByte < 0)
          return false;
        if (firstByte <= 127 || firstByte > 160 && firstByte <= 223)
          return true;
        const secondByte = iter.nextByte(det);
        if (secondByte < 0)
          return false;
        iter.charValue = firstByte << 8 | secondByte;
        if (!(secondByte >= 64 && secondByte <= 127 || secondByte >= 128 && secondByte <= 255)) {
          iter.error = true;
        }
        return true;
      }
    };
    exports.sjis = sjis;
    var big5 = class extends mbcs {
      static {
        __name(this, "big5");
      }
      constructor() {
        super(...arguments);
        this.commonChars = [
          41280,
          41281,
          41282,
          41283,
          41287,
          41289,
          41333,
          41334,
          42048,
          42054,
          42055,
          42056,
          42065,
          42068,
          42071,
          42084,
          42090,
          42092,
          42103,
          42147,
          42148,
          42151,
          42177,
          42190,
          42193,
          42207,
          42216,
          42237,
          42304,
          42312,
          42328,
          42345,
          42445,
          42471,
          42583,
          42593,
          42594,
          42600,
          42608,
          42664,
          42675,
          42681,
          42707,
          42715,
          42726,
          42738,
          42816,
          42833,
          42841,
          42970,
          43171,
          43173,
          43181,
          43217,
          43219,
          43236,
          43260,
          43456,
          43474,
          43507,
          43627,
          43706,
          43710,
          43724,
          43772,
          44103,
          44111,
          44208,
          44242,
          44377,
          44745,
          45024,
          45290,
          45423,
          45747,
          45764,
          45935,
          46156,
          46158,
          46412,
          46501,
          46525,
          46544,
          46552,
          46705,
          47085,
          47207,
          47428,
          47832,
          47940,
          48033,
          48593,
          49860,
          50105,
          50240,
          50271
        ];
      }
      name() {
        return "Big5";
      }
      language() {
        return "zh";
      }
      nextChar(iter, det) {
        iter.index = iter.nextIndex;
        iter.error = false;
        const firstByte = iter.charValue = iter.nextByte(det);
        if (firstByte < 0)
          return false;
        if (firstByte <= 127 || firstByte == 255)
          return true;
        const secondByte = iter.nextByte(det);
        if (secondByte < 0)
          return false;
        iter.charValue = iter.charValue << 8 | secondByte;
        if (secondByte < 64 || secondByte == 127 || secondByte == 255)
          iter.error = true;
        return true;
      }
    };
    exports.big5 = big5;
    function eucNextChar(iter, det) {
      iter.index = iter.nextIndex;
      iter.error = false;
      let firstByte = 0;
      let secondByte = 0;
      let thirdByte = 0;
      buildChar: {
        firstByte = iter.charValue = iter.nextByte(det);
        if (firstByte < 0) {
          iter.done = true;
          break buildChar;
        }
        if (firstByte <= 141) {
          break buildChar;
        }
        secondByte = iter.nextByte(det);
        iter.charValue = iter.charValue << 8 | secondByte;
        if (firstByte >= 161 && firstByte <= 254) {
          if (secondByte < 161) {
            iter.error = true;
          }
          break buildChar;
        }
        if (firstByte == 142) {
          if (secondByte < 161) {
            iter.error = true;
          }
          break buildChar;
        }
        if (firstByte == 143) {
          thirdByte = iter.nextByte(det);
          iter.charValue = iter.charValue << 8 | thirdByte;
          if (thirdByte < 161) {
            iter.error = true;
          }
        }
      }
      return iter.done == false;
    }
    __name(eucNextChar, "eucNextChar");
    var euc_jp = class extends mbcs {
      static {
        __name(this, "euc_jp");
      }
      constructor() {
        super(...arguments);
        this.commonChars = [
          41377,
          41378,
          41379,
          41382,
          41404,
          41418,
          41419,
          41430,
          41431,
          42146,
          42148,
          42150,
          42152,
          42154,
          42155,
          42156,
          42157,
          42159,
          42161,
          42163,
          42165,
          42167,
          42169,
          42171,
          42173,
          42175,
          42176,
          42177,
          42179,
          42180,
          42182,
          42183,
          42184,
          42185,
          42186,
          42187,
          42190,
          42191,
          42192,
          42206,
          42207,
          42209,
          42210,
          42212,
          42216,
          42217,
          42218,
          42219,
          42220,
          42223,
          42226,
          42227,
          42402,
          42403,
          42404,
          42406,
          42407,
          42410,
          42413,
          42415,
          42416,
          42419,
          42421,
          42423,
          42424,
          42425,
          42431,
          42435,
          42438,
          42439,
          42440,
          42441,
          42443,
          42448,
          42453,
          42454,
          42455,
          42462,
          42464,
          42465,
          42469,
          42473,
          42474,
          42475,
          42476,
          42477,
          42483,
          47273,
          47572,
          47854,
          48072,
          48880,
          49079,
          50410,
          50940,
          51133,
          51896,
          51955,
          52188,
          52689
        ];
        this.nextChar = eucNextChar;
      }
      name() {
        return "EUC-JP";
      }
      language() {
        return "ja";
      }
    };
    exports.euc_jp = euc_jp;
    var euc_kr = class extends mbcs {
      static {
        __name(this, "euc_kr");
      }
      constructor() {
        super(...arguments);
        this.commonChars = [
          45217,
          45235,
          45253,
          45261,
          45268,
          45286,
          45293,
          45304,
          45306,
          45308,
          45496,
          45497,
          45511,
          45527,
          45538,
          45994,
          46011,
          46274,
          46287,
          46297,
          46315,
          46501,
          46517,
          46527,
          46535,
          46569,
          46835,
          47023,
          47042,
          47054,
          47270,
          47278,
          47286,
          47288,
          47291,
          47337,
          47531,
          47534,
          47564,
          47566,
          47613,
          47800,
          47822,
          47824,
          47857,
          48103,
          48115,
          48125,
          48301,
          48314,
          48338,
          48374,
          48570,
          48576,
          48579,
          48581,
          48838,
          48840,
          48863,
          48878,
          48888,
          48890,
          49057,
          49065,
          49088,
          49124,
          49131,
          49132,
          49144,
          49319,
          49327,
          49336,
          49338,
          49339,
          49341,
          49351,
          49356,
          49358,
          49359,
          49366,
          49370,
          49381,
          49403,
          49404,
          49572,
          49574,
          49590,
          49622,
          49631,
          49654,
          49656,
          50337,
          50637,
          50862,
          51151,
          51153,
          51154,
          51160,
          51173,
          51373
        ];
        this.nextChar = eucNextChar;
      }
      name() {
        return "EUC-KR";
      }
      language() {
        return "ko";
      }
    };
    exports.euc_kr = euc_kr;
    var gb_18030 = class extends mbcs {
      static {
        __name(this, "gb_18030");
      }
      constructor() {
        super(...arguments);
        this.commonChars = [
          41377,
          41378,
          41379,
          41380,
          41392,
          41393,
          41457,
          41459,
          41889,
          41900,
          41914,
          45480,
          45496,
          45502,
          45755,
          46025,
          46070,
          46323,
          46525,
          46532,
          46563,
          46767,
          46804,
          46816,
          47010,
          47016,
          47037,
          47062,
          47069,
          47284,
          47327,
          47350,
          47531,
          47561,
          47576,
          47610,
          47613,
          47821,
          48039,
          48086,
          48097,
          48122,
          48316,
          48347,
          48382,
          48588,
          48845,
          48861,
          49076,
          49094,
          49097,
          49332,
          49389,
          49611,
          49883,
          50119,
          50396,
          50410,
          50636,
          50935,
          51192,
          51371,
          51403,
          51413,
          51431,
          51663,
          51706,
          51889,
          51893,
          51911,
          51920,
          51926,
          51957,
          51965,
          52460,
          52728,
          52906,
          52932,
          52946,
          52965,
          53173,
          53186,
          53206,
          53442,
          53445,
          53456,
          53460,
          53671,
          53930,
          53938,
          53941,
          53947,
          53972,
          54211,
          54224,
          54269,
          54466,
          54490,
          54754,
          54992
        ];
      }
      name() {
        return "GB18030";
      }
      language() {
        return "zh";
      }
      nextChar(iter, det) {
        iter.index = iter.nextIndex;
        iter.error = false;
        let firstByte = 0;
        let secondByte = 0;
        let thirdByte = 0;
        let fourthByte = 0;
        buildChar: {
          firstByte = iter.charValue = iter.nextByte(det);
          if (firstByte < 0) {
            iter.done = true;
            break buildChar;
          }
          if (firstByte <= 128) {
            break buildChar;
          }
          secondByte = iter.nextByte(det);
          iter.charValue = iter.charValue << 8 | secondByte;
          if (firstByte >= 129 && firstByte <= 254) {
            if (secondByte >= 64 && secondByte <= 126 || secondByte >= 80 && secondByte <= 254) {
              break buildChar;
            }
            if (secondByte >= 48 && secondByte <= 57) {
              thirdByte = iter.nextByte(det);
              if (thirdByte >= 129 && thirdByte <= 254) {
                fourthByte = iter.nextByte(det);
                if (fourthByte >= 48 && fourthByte <= 57) {
                  iter.charValue = iter.charValue << 16 | thirdByte << 8 | fourthByte;
                  break buildChar;
                }
              }
            }
            iter.error = true;
            break buildChar;
          }
        }
        return iter.done == false;
      }
    };
    exports.gb_18030 = gb_18030;
  }
});

// node_modules/chardet/lib/encoding/sbcs.js
var require_sbcs = __commonJS({
  "node_modules/chardet/lib/encoding/sbcs.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.KOI8_R = exports.windows_1256 = exports.windows_1251 = exports.ISO_8859_9 = exports.ISO_8859_8 = exports.ISO_8859_7 = exports.ISO_8859_6 = exports.ISO_8859_5 = exports.ISO_8859_2 = exports.ISO_8859_1 = void 0;
    var match_1 = __importDefault(require_match());
    var N_GRAM_MASK = 16777215;
    var NGramParser = class {
      static {
        __name(this, "NGramParser");
      }
      constructor(theNgramList, theByteMap) {
        this.byteIndex = 0;
        this.ngram = 0;
        this.ngramCount = 0;
        this.hitCount = 0;
        this.spaceChar = 32;
        this.ngramList = theNgramList;
        this.byteMap = theByteMap;
      }
      search(table, value) {
        let index = 0;
        if (table[index + 32] <= value)
          index += 32;
        if (table[index + 16] <= value)
          index += 16;
        if (table[index + 8] <= value)
          index += 8;
        if (table[index + 4] <= value)
          index += 4;
        if (table[index + 2] <= value)
          index += 2;
        if (table[index + 1] <= value)
          index += 1;
        if (table[index] > value)
          index -= 1;
        if (index < 0 || table[index] != value)
          return -1;
        return index;
      }
      lookup(thisNgram) {
        this.ngramCount += 1;
        if (this.search(this.ngramList, thisNgram) >= 0) {
          this.hitCount += 1;
        }
      }
      addByte(b) {
        this.ngram = (this.ngram << 8) + (b & 255) & N_GRAM_MASK;
        this.lookup(this.ngram);
      }
      nextByte(det) {
        if (this.byteIndex >= det.inputLen)
          return -1;
        return det.inputBytes[this.byteIndex++] & 255;
      }
      parse(det, spaceCh) {
        let b, ignoreSpace = false;
        this.spaceChar = spaceCh;
        while ((b = this.nextByte(det)) >= 0) {
          const mb = this.byteMap[b];
          if (mb != 0) {
            if (!(mb == this.spaceChar && ignoreSpace)) {
              this.addByte(mb);
            }
            ignoreSpace = mb == this.spaceChar;
          }
        }
        this.addByte(this.spaceChar);
        const rawPercent = this.hitCount / this.ngramCount;
        if (rawPercent > 0.33)
          return 98;
        return Math.floor(rawPercent * 300);
      }
    };
    var NGramsPlusLang = class {
      static {
        __name(this, "NGramsPlusLang");
      }
      constructor(la, ng) {
        this.fLang = la;
        this.fNGrams = ng;
      }
    };
    var isFlatNgrams = /* @__PURE__ */ __name((val) => Array.isArray(val) && isFinite(val[0]), "isFlatNgrams");
    var sbcs = class {
      static {
        __name(this, "sbcs");
      }
      constructor() {
        this.spaceChar = 32;
        this.nGramLang = void 0;
      }
      ngrams() {
        return [];
      }
      byteMap() {
        return [];
      }
      name(_input) {
        return "sbcs";
      }
      language() {
        return this.nGramLang;
      }
      match(det) {
        this.nGramLang = void 0;
        const ngrams = this.ngrams();
        if (isFlatNgrams(ngrams)) {
          const parser = new NGramParser(ngrams, this.byteMap());
          const confidence = parser.parse(det, this.spaceChar);
          return confidence <= 0 ? null : (0, match_1.default)(det, this, confidence);
        }
        let bestConfidence = -1;
        for (let i = ngrams.length - 1; i >= 0; i--) {
          const ngl = ngrams[i];
          const parser = new NGramParser(ngl.fNGrams, this.byteMap());
          const confidence = parser.parse(det, this.spaceChar);
          if (confidence > bestConfidence) {
            bestConfidence = confidence;
            this.nGramLang = ngl.fLang;
          }
        }
        return bestConfidence <= 0 ? null : (0, match_1.default)(det, this, bestConfidence);
      }
    };
    var ISO_8859_1 = class extends sbcs {
      static {
        __name(this, "ISO_8859_1");
      }
      byteMap() {
        return [
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          0,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          170,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          181,
          32,
          32,
          32,
          32,
          186,
          32,
          32,
          32,
          32,
          32,
          224,
          225,
          226,
          227,
          228,
          229,
          230,
          231,
          232,
          233,
          234,
          235,
          236,
          237,
          238,
          239,
          240,
          241,
          242,
          243,
          244,
          245,
          246,
          32,
          248,
          249,
          250,
          251,
          252,
          253,
          254,
          223,
          224,
          225,
          226,
          227,
          228,
          229,
          230,
          231,
          232,
          233,
          234,
          235,
          236,
          237,
          238,
          239,
          240,
          241,
          242,
          243,
          244,
          245,
          246,
          32,
          248,
          249,
          250,
          251,
          252,
          253,
          254,
          255
        ];
      }
      ngrams() {
        return [
          new NGramsPlusLang("da", [
            2122086,
            2122100,
            2122853,
            2123118,
            2123122,
            2123375,
            2123873,
            2124064,
            2125157,
            2125671,
            2126053,
            2126697,
            2126708,
            2126953,
            2127465,
            6383136,
            6385184,
            6385252,
            6386208,
            6386720,
            6579488,
            6579566,
            6579570,
            6579572,
            6627443,
            6644768,
            6644837,
            6647328,
            6647396,
            6648352,
            6648421,
            6648608,
            6648864,
            6713202,
            6776096,
            6776174,
            6776178,
            6907749,
            6908960,
            6909543,
            7038240,
            7039845,
            7103858,
            7104871,
            7105637,
            7169380,
            7234661,
            7234848,
            7235360,
            7235429,
            7300896,
            7302432,
            7303712,
            7398688,
            7479396,
            7479397,
            7479411,
            7496992,
            7566437,
            7610483,
            7628064,
            7628146,
            7629164,
            7759218
          ]),
          new NGramsPlusLang("de", [
            2122094,
            2122101,
            2122341,
            2122849,
            2122853,
            2122857,
            2123113,
            2123621,
            2123873,
            2124142,
            2125161,
            2126691,
            2126693,
            2127214,
            2127461,
            2127471,
            2127717,
            2128501,
            6448498,
            6514720,
            6514789,
            6514804,
            6578547,
            6579566,
            6579570,
            6580581,
            6627428,
            6627443,
            6646126,
            6646132,
            6647328,
            6648352,
            6648608,
            6776174,
            6841710,
            6845472,
            6906728,
            6907168,
            6909472,
            6909541,
            6911008,
            7104867,
            7105637,
            7217249,
            7217252,
            7217267,
            7234592,
            7234661,
            7234848,
            7235360,
            7235429,
            7238757,
            7479396,
            7496805,
            7497065,
            7562088,
            7566437,
            7610468,
            7628064,
            7628142,
            7628146,
            7695972,
            7695975,
            7759218
          ]),
          new NGramsPlusLang("en", [
            2122016,
            2122094,
            2122341,
            2122607,
            2123375,
            2123873,
            2123877,
            2124142,
            2125153,
            2125670,
            2125938,
            2126437,
            2126689,
            2126708,
            2126952,
            2126959,
            2127720,
            6383972,
            6384672,
            6385184,
            6385252,
            6386464,
            6386720,
            6386789,
            6386793,
            6561889,
            6561908,
            6627425,
            6627443,
            6627444,
            6644768,
            6647412,
            6648352,
            6648608,
            6713202,
            6840692,
            6841632,
            6841714,
            6906912,
            6909472,
            6909543,
            6909806,
            6910752,
            7217249,
            7217268,
            7234592,
            7235360,
            7238688,
            7300640,
            7302688,
            7303712,
            7496992,
            7500576,
            7544929,
            7544948,
            7561577,
            7566368,
            7610484,
            7628146,
            7628897,
            7628901,
            7629167,
            7630624,
            7631648
          ]),
          new NGramsPlusLang("es", [
            2122016,
            2122593,
            2122607,
            2122853,
            2123116,
            2123118,
            2123123,
            2124142,
            2124897,
            2124911,
            2125921,
            2125935,
            2125938,
            2126197,
            2126437,
            2126693,
            2127214,
            2128160,
            6365283,
            6365284,
            6365285,
            6365292,
            6365296,
            6382441,
            6382703,
            6384672,
            6386208,
            6386464,
            6515187,
            6516590,
            6579488,
            6579564,
            6582048,
            6627428,
            6627429,
            6627436,
            6646816,
            6647328,
            6647412,
            6648608,
            6648692,
            6907246,
            6943598,
            7102752,
            7106419,
            7217253,
            7238757,
            7282788,
            7282789,
            7302688,
            7303712,
            7303968,
            7364978,
            7435621,
            7495968,
            7497075,
            7544932,
            7544933,
            7544944,
            7562528,
            7628064,
            7630624,
            7693600,
            15953440
          ]),
          new NGramsPlusLang("fr", [
            2122101,
            2122607,
            2122849,
            2122853,
            2122869,
            2123118,
            2123124,
            2124897,
            2124901,
            2125921,
            2125935,
            2125938,
            2126197,
            2126693,
            2126703,
            2127214,
            2154528,
            6385268,
            6386793,
            6513952,
            6516590,
            6579488,
            6579571,
            6583584,
            6627425,
            6627427,
            6627428,
            6627429,
            6627436,
            6627440,
            6627443,
            6647328,
            6647412,
            6648352,
            6648608,
            6648864,
            6649202,
            6909806,
            6910752,
            6911008,
            7102752,
            7103776,
            7103859,
            7169390,
            7217252,
            7234848,
            7238432,
            7238688,
            7302688,
            7302772,
            7304562,
            7435621,
            7479404,
            7496992,
            7544929,
            7544932,
            7544933,
            7544940,
            7544944,
            7610468,
            7628064,
            7629167,
            7693600,
            7696928
          ]),
          new NGramsPlusLang("it", [
            2122092,
            2122600,
            2122607,
            2122853,
            2122857,
            2123040,
            2124140,
            2124142,
            2124897,
            2125925,
            2125938,
            2127214,
            6365283,
            6365284,
            6365296,
            6365299,
            6386799,
            6514789,
            6516590,
            6579564,
            6580512,
            6627425,
            6627427,
            6627428,
            6627433,
            6627436,
            6627440,
            6627443,
            6646816,
            6646892,
            6647412,
            6648352,
            6841632,
            6889569,
            6889571,
            6889572,
            6889587,
            6906144,
            6908960,
            6909472,
            6909806,
            7102752,
            7103776,
            7104800,
            7105633,
            7234848,
            7235872,
            7237408,
            7238757,
            7282785,
            7282788,
            7282793,
            7282803,
            7302688,
            7302757,
            7366002,
            7495968,
            7496992,
            7563552,
            7627040,
            7628064,
            7629088,
            7630624,
            8022383
          ]),
          new NGramsPlusLang("nl", [
            2122092,
            2122341,
            2122849,
            2122853,
            2122857,
            2123109,
            2123118,
            2123621,
            2123877,
            2124142,
            2125153,
            2125157,
            2125680,
            2126949,
            2127457,
            2127461,
            2127471,
            2127717,
            2128489,
            6381934,
            6381938,
            6385184,
            6385252,
            6386208,
            6386720,
            6514804,
            6579488,
            6579566,
            6579570,
            6627426,
            6627446,
            6645102,
            6645106,
            6647328,
            6648352,
            6648435,
            6648864,
            6776174,
            6841716,
            6907168,
            6909472,
            6909543,
            6910752,
            7217250,
            7217252,
            7217253,
            7217256,
            7217263,
            7217270,
            7234661,
            7235360,
            7302756,
            7303026,
            7303200,
            7303712,
            7562088,
            7566437,
            7610468,
            7628064,
            7628142,
            7628146,
            7758190,
            7759218,
            7761775
          ]),
          new NGramsPlusLang("no", [
            2122100,
            2122102,
            2122853,
            2123118,
            2123122,
            2123375,
            2123873,
            2124064,
            2125157,
            2125671,
            2126053,
            2126693,
            2126699,
            2126703,
            2126708,
            2126953,
            2127465,
            2155808,
            6385252,
            6386208,
            6386720,
            6579488,
            6579566,
            6579572,
            6627443,
            6644768,
            6647328,
            6647397,
            6648352,
            6648421,
            6648864,
            6648948,
            6713202,
            6776174,
            6908779,
            6908960,
            6909543,
            7038240,
            7039845,
            7103776,
            7105637,
            7169380,
            7169390,
            7217267,
            7234848,
            7235360,
            7235429,
            7237221,
            7300896,
            7302432,
            7303712,
            7398688,
            7479411,
            7496992,
            7565165,
            7566437,
            7610483,
            7628064,
            7628142,
            7628146,
            7629164,
            7631904,
            7631973,
            7759218
          ]),
          new NGramsPlusLang("pt", [
            2122016,
            2122607,
            2122849,
            2122853,
            2122863,
            2123040,
            2123123,
            2125153,
            2125423,
            2125600,
            2125921,
            2125935,
            2125938,
            2126197,
            2126437,
            2126693,
            2127213,
            6365281,
            6365283,
            6365284,
            6365296,
            6382693,
            6382703,
            6384672,
            6386208,
            6386273,
            6386464,
            6516589,
            6516590,
            6578464,
            6579488,
            6582048,
            6582131,
            6627425,
            6627428,
            6647072,
            6647412,
            6648608,
            6648692,
            6906144,
            6906721,
            7169390,
            7238757,
            7238767,
            7282785,
            7282787,
            7282788,
            7282789,
            7282800,
            7303968,
            7364978,
            7435621,
            7495968,
            7497075,
            7544929,
            7544932,
            7544933,
            7544944,
            7566433,
            7628064,
            7630624,
            7693600,
            14905120,
            15197039
          ]),
          new NGramsPlusLang("sv", [
            2122100,
            2122102,
            2122853,
            2123118,
            2123510,
            2123873,
            2124064,
            2124142,
            2124655,
            2125157,
            2125667,
            2126053,
            2126699,
            2126703,
            2126708,
            2126953,
            2127457,
            2127465,
            2155634,
            6382693,
            6385184,
            6385252,
            6386208,
            6386804,
            6514720,
            6579488,
            6579566,
            6579570,
            6579572,
            6644768,
            6647328,
            6648352,
            6648864,
            6747762,
            6776174,
            6909036,
            6909543,
            7037216,
            7105568,
            7169380,
            7217267,
            7233824,
            7234661,
            7235360,
            7235429,
            7235950,
            7299944,
            7302432,
            7302688,
            7398688,
            7479393,
            7479411,
            7495968,
            7564129,
            7565165,
            7610483,
            7627040,
            7628064,
            7628146,
            7629164,
            7631904,
            7758194,
            14971424,
            16151072
          ])
        ];
      }
      name(input) {
        return input && input.c1Bytes ? "windows-1252" : "ISO-8859-1";
      }
    };
    exports.ISO_8859_1 = ISO_8859_1;
    var ISO_8859_2 = class extends sbcs {
      static {
        __name(this, "ISO_8859_2");
      }
      byteMap() {
        return [
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          0,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          177,
          32,
          179,
          32,
          181,
          182,
          32,
          32,
          185,
          186,
          187,
          188,
          32,
          190,
          191,
          32,
          177,
          32,
          179,
          32,
          181,
          182,
          183,
          32,
          185,
          186,
          187,
          188,
          32,
          190,
          191,
          224,
          225,
          226,
          227,
          228,
          229,
          230,
          231,
          232,
          233,
          234,
          235,
          236,
          237,
          238,
          239,
          240,
          241,
          242,
          243,
          244,
          245,
          246,
          32,
          248,
          249,
          250,
          251,
          252,
          253,
          254,
          223,
          224,
          225,
          226,
          227,
          228,
          229,
          230,
          231,
          232,
          233,
          234,
          235,
          236,
          237,
          238,
          239,
          240,
          241,
          242,
          243,
          244,
          245,
          246,
          32,
          248,
          249,
          250,
          251,
          252,
          253,
          254,
          32
        ];
      }
      ngrams() {
        return [
          new NGramsPlusLang("cs", [
            2122016,
            2122361,
            2122863,
            2124389,
            2125409,
            2125413,
            2125600,
            2125668,
            2125935,
            2125938,
            2126072,
            2126447,
            2126693,
            2126703,
            2126708,
            2126959,
            2127392,
            2127481,
            2128481,
            6365296,
            6513952,
            6514720,
            6627440,
            6627443,
            6627446,
            6647072,
            6647533,
            6844192,
            6844260,
            6910836,
            6972704,
            7042149,
            7103776,
            7104800,
            7233824,
            7268640,
            7269408,
            7269664,
            7282800,
            7300206,
            7301737,
            7304052,
            7304480,
            7304801,
            7368548,
            7368554,
            7369327,
            7403621,
            7562528,
            7565173,
            7566433,
            7566441,
            7566446,
            7628146,
            7630573,
            7630624,
            7676016,
            12477728,
            14773997,
            15296623,
            15540336,
            15540339,
            15559968,
            16278884
          ]),
          new NGramsPlusLang("hu", [
            2122016,
            2122106,
            2122341,
            2123111,
            2123116,
            2123365,
            2123873,
            2123887,
            2124147,
            2124645,
            2124649,
            2124790,
            2124901,
            2125153,
            2125157,
            2125161,
            2125413,
            2126714,
            2126949,
            2156915,
            6365281,
            6365291,
            6365293,
            6365299,
            6384416,
            6385184,
            6388256,
            6447470,
            6448494,
            6645625,
            6646560,
            6646816,
            6646885,
            6647072,
            6647328,
            6648421,
            6648864,
            6648933,
            6648948,
            6781216,
            6844263,
            6909556,
            6910752,
            7020641,
            7075450,
            7169383,
            7170414,
            7217249,
            7233899,
            7234923,
            7234925,
            7238688,
            7300985,
            7544929,
            7567973,
            7567988,
            7568097,
            7596391,
            7610465,
            7631904,
            7659891,
            8021362,
            14773792,
            15299360
          ]),
          new NGramsPlusLang("pl", [
            2122618,
            2122863,
            2124064,
            2124389,
            2124655,
            2125153,
            2125161,
            2125409,
            2125417,
            2125668,
            2125935,
            2125938,
            2126697,
            2127648,
            2127721,
            2127737,
            2128416,
            2128481,
            6365296,
            6365303,
            6385257,
            6514720,
            6519397,
            6519417,
            6582048,
            6584937,
            6627440,
            6627443,
            6627447,
            6627450,
            6645615,
            6646304,
            6647072,
            6647401,
            6778656,
            6906144,
            6907168,
            6907242,
            7037216,
            7039264,
            7039333,
            7170405,
            7233824,
            7235937,
            7235941,
            7282800,
            7305057,
            7305065,
            7368556,
            7369313,
            7369327,
            7369338,
            7502437,
            7502457,
            7563754,
            7564137,
            7566433,
            7825765,
            7955304,
            7957792,
            8021280,
            8022373,
            8026400,
            15955744
          ]),
          new NGramsPlusLang("ro", [
            2122016,
            2122083,
            2122593,
            2122597,
            2122607,
            2122613,
            2122853,
            2122857,
            2124897,
            2125153,
            2125925,
            2125938,
            2126693,
            2126819,
            2127214,
            2144873,
            2158190,
            6365283,
            6365284,
            6386277,
            6386720,
            6386789,
            6386976,
            6513010,
            6516590,
            6518048,
            6546208,
            6579488,
            6627425,
            6627427,
            6627428,
            6627440,
            6627443,
            6644e3,
            6646048,
            6646885,
            6647412,
            6648692,
            6889569,
            6889571,
            6889572,
            6889584,
            6907168,
            6908192,
            6909472,
            7102752,
            7103776,
            7106418,
            7107945,
            7234848,
            7238770,
            7303712,
            7365998,
            7496992,
            7497057,
            7501088,
            7594784,
            7628064,
            7631477,
            7660320,
            7694624,
            7695392,
            12216608,
            15625760
          ])
        ];
      }
      name(det) {
        return det && det.c1Bytes ? "windows-1250" : "ISO-8859-2";
      }
    };
    exports.ISO_8859_2 = ISO_8859_2;
    var ISO_8859_5 = class extends sbcs {
      static {
        __name(this, "ISO_8859_5");
      }
      byteMap() {
        return [
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          0,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          241,
          242,
          243,
          244,
          245,
          246,
          247,
          248,
          249,
          250,
          251,
          252,
          32,
          254,
          255,
          208,
          209,
          210,
          211,
          212,
          213,
          214,
          215,
          216,
          217,
          218,
          219,
          220,
          221,
          222,
          223,
          224,
          225,
          226,
          227,
          228,
          229,
          230,
          231,
          232,
          233,
          234,
          235,
          236,
          237,
          238,
          239,
          208,
          209,
          210,
          211,
          212,
          213,
          214,
          215,
          216,
          217,
          218,
          219,
          220,
          221,
          222,
          223,
          224,
          225,
          226,
          227,
          228,
          229,
          230,
          231,
          232,
          233,
          234,
          235,
          236,
          237,
          238,
          239,
          32,
          241,
          242,
          243,
          244,
          245,
          246,
          247,
          248,
          249,
          250,
          251,
          252,
          32,
          254,
          255
        ];
      }
      ngrams() {
        return [
          2150944,
          2151134,
          2151646,
          2152400,
          2152480,
          2153168,
          2153182,
          2153936,
          2153941,
          2154193,
          2154462,
          2154464,
          2154704,
          2154974,
          2154978,
          2155230,
          2156514,
          2158050,
          13688280,
          13689580,
          13884960,
          14015468,
          14015960,
          14016994,
          14017056,
          14164191,
          14210336,
          14211104,
          14216992,
          14407133,
          14407712,
          14413021,
          14536736,
          14538016,
          14538965,
          14538991,
          14540320,
          14540498,
          14557394,
          14557407,
          14557409,
          14602784,
          14602960,
          14603230,
          14604576,
          14605292,
          14605344,
          14606818,
          14671579,
          14672085,
          14672088,
          14672094,
          14733522,
          14734804,
          14803664,
          14803666,
          14803672,
          14806816,
          14865883,
          14868e3,
          14868192,
          14871584,
          15196894,
          15459616
        ];
      }
      name() {
        return "ISO-8859-5";
      }
      language() {
        return "ru";
      }
    };
    exports.ISO_8859_5 = ISO_8859_5;
    var ISO_8859_6 = class extends sbcs {
      static {
        __name(this, "ISO_8859_6");
      }
      byteMap() {
        return [
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          0,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          193,
          194,
          195,
          196,
          197,
          198,
          199,
          200,
          201,
          202,
          203,
          204,
          205,
          206,
          207,
          208,
          209,
          210,
          211,
          212,
          213,
          214,
          215,
          216,
          217,
          218,
          32,
          32,
          32,
          32,
          32,
          224,
          225,
          226,
          227,
          228,
          229,
          230,
          231,
          232,
          233,
          234,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32
        ];
      }
      ngrams() {
        return [
          2148324,
          2148326,
          2148551,
          2152932,
          2154986,
          2155748,
          2156006,
          2156743,
          13050055,
          13091104,
          13093408,
          13095200,
          13100064,
          13100227,
          13100231,
          13100232,
          13100234,
          13100236,
          13100237,
          13100239,
          13100243,
          13100249,
          13100258,
          13100261,
          13100264,
          13100266,
          13100320,
          13100576,
          13100746,
          13115591,
          13181127,
          13181153,
          13181156,
          13181157,
          13181160,
          13246663,
          13574343,
          13617440,
          13705415,
          13748512,
          13836487,
          14229703,
          14279913,
          14805536,
          14950599,
          14993696,
          15001888,
          15002144,
          15016135,
          15058720,
          15059232,
          15066656,
          15081671,
          15147207,
          15189792,
          15255524,
          15263264,
          15278279,
          15343815,
          15343845,
          15343848,
          15386912,
          15388960,
          15394336
        ];
      }
      name() {
        return "ISO-8859-6";
      }
      language() {
        return "ar";
      }
    };
    exports.ISO_8859_6 = ISO_8859_6;
    var ISO_8859_7 = class extends sbcs {
      static {
        __name(this, "ISO_8859_7");
      }
      byteMap() {
        return [
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          0,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          161,
          162,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          220,
          32,
          221,
          222,
          223,
          32,
          252,
          32,
          253,
          254,
          192,
          225,
          226,
          227,
          228,
          229,
          230,
          231,
          232,
          233,
          234,
          235,
          236,
          237,
          238,
          239,
          240,
          241,
          32,
          243,
          244,
          245,
          246,
          247,
          248,
          249,
          250,
          251,
          220,
          221,
          222,
          223,
          224,
          225,
          226,
          227,
          228,
          229,
          230,
          231,
          232,
          233,
          234,
          235,
          236,
          237,
          238,
          239,
          240,
          241,
          242,
          243,
          244,
          245,
          246,
          247,
          248,
          249,
          250,
          251,
          252,
          253,
          254,
          32
        ];
      }
      ngrams() {
        return [
          2154989,
          2154992,
          2155497,
          2155753,
          2156016,
          2156320,
          2157281,
          2157797,
          2158049,
          2158368,
          2158817,
          2158831,
          2158833,
          2159604,
          2159605,
          2159847,
          2159855,
          14672160,
          14754017,
          14754036,
          14805280,
          14806304,
          14807292,
          14807584,
          14936545,
          15067424,
          15069728,
          15147252,
          15199520,
          15200800,
          15278324,
          15327520,
          15330014,
          15331872,
          15393257,
          15393268,
          15525152,
          15540449,
          15540453,
          15540464,
          15589664,
          15725088,
          15725856,
          15790069,
          15790575,
          15793184,
          15868129,
          15868133,
          15868138,
          15868144,
          15868148,
          15983904,
          15984416,
          15987951,
          16048416,
          16048617,
          16050157,
          16050162,
          16050666,
          16052e3,
          16052213,
          16054765,
          16379168,
          16706848
        ];
      }
      name(det) {
        return det && det.c1Bytes ? "windows-1253" : "ISO-8859-7";
      }
      language() {
        return "el";
      }
    };
    exports.ISO_8859_7 = ISO_8859_7;
    var ISO_8859_8 = class extends sbcs {
      static {
        __name(this, "ISO_8859_8");
      }
      byteMap() {
        return [
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          0,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          181,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          224,
          225,
          226,
          227,
          228,
          229,
          230,
          231,
          232,
          233,
          234,
          235,
          236,
          237,
          238,
          239,
          240,
          241,
          242,
          243,
          244,
          245,
          246,
          247,
          248,
          249,
          250,
          32,
          32,
          32,
          32,
          32
        ];
      }
      ngrams() {
        return [
          new NGramsPlusLang("he", [
            2154725,
            2154727,
            2154729,
            2154746,
            2154985,
            2154990,
            2155744,
            2155749,
            2155753,
            2155758,
            2155762,
            2155769,
            2155770,
            2157792,
            2157796,
            2158304,
            2159340,
            2161132,
            14744096,
            14950624,
            14950625,
            14950628,
            14950636,
            14950638,
            14950649,
            15001056,
            15065120,
            15068448,
            15068960,
            15071264,
            15071776,
            15278308,
            15328288,
            15328762,
            15329773,
            15330592,
            15331104,
            15333408,
            15333920,
            15474912,
            15474916,
            15523872,
            15524896,
            15540448,
            15540449,
            15540452,
            15540460,
            15540462,
            15540473,
            15655968,
            15671524,
            15787040,
            15788320,
            15788525,
            15920160,
            16261348,
            16312813,
            16378912,
            16392416,
            16392417,
            16392420,
            16392428,
            16392430,
            16392441
          ]),
          new NGramsPlusLang("he", [
            2154725,
            2154732,
            2155753,
            2155756,
            2155758,
            2155760,
            2157040,
            2157810,
            2157817,
            2158053,
            2158057,
            2158565,
            2158569,
            2160869,
            2160873,
            2161376,
            2161381,
            2161385,
            14688484,
            14688492,
            14688493,
            14688506,
            14738464,
            14738916,
            14740512,
            14741024,
            14754020,
            14754029,
            14754042,
            14950628,
            14950633,
            14950636,
            14950637,
            14950639,
            14950648,
            14950650,
            15002656,
            15065120,
            15066144,
            15196192,
            15327264,
            15327520,
            15328288,
            15474916,
            15474925,
            15474938,
            15528480,
            15530272,
            15591913,
            15591920,
            15591928,
            15605988,
            15605997,
            15606010,
            15655200,
            15655968,
            15918112,
            16326884,
            16326893,
            16326906,
            16376864,
            16441376,
            16442400,
            16442857
          ])
        ];
      }
      name(det) {
        return det && det.c1Bytes ? "windows-1255" : "ISO-8859-8";
      }
      language() {
        return "he";
      }
    };
    exports.ISO_8859_8 = ISO_8859_8;
    var ISO_8859_9 = class extends sbcs {
      static {
        __name(this, "ISO_8859_9");
      }
      byteMap() {
        return [
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          0,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          170,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          181,
          32,
          32,
          32,
          32,
          186,
          32,
          32,
          32,
          32,
          32,
          224,
          225,
          226,
          227,
          228,
          229,
          230,
          231,
          232,
          233,
          234,
          235,
          236,
          237,
          238,
          239,
          240,
          241,
          242,
          243,
          244,
          245,
          246,
          32,
          248,
          249,
          250,
          251,
          252,
          105,
          254,
          223,
          224,
          225,
          226,
          227,
          228,
          229,
          230,
          231,
          232,
          233,
          234,
          235,
          236,
          237,
          238,
          239,
          240,
          241,
          242,
          243,
          244,
          245,
          246,
          32,
          248,
          249,
          250,
          251,
          252,
          253,
          254,
          255
        ];
      }
      ngrams() {
        return [
          2122337,
          2122345,
          2122357,
          2122849,
          2122853,
          2123621,
          2123873,
          2124140,
          2124641,
          2124655,
          2125153,
          2125676,
          2126689,
          2126945,
          2127461,
          2128225,
          6365282,
          6384416,
          6384737,
          6384993,
          6385184,
          6385405,
          6386208,
          6386273,
          6386429,
          6386685,
          6388065,
          6449522,
          6578464,
          6579488,
          6580512,
          6627426,
          6627435,
          6644841,
          6647328,
          6648352,
          6648425,
          6648681,
          6909029,
          6909472,
          6909545,
          6910496,
          7102830,
          7102834,
          7103776,
          7103858,
          7217249,
          7217250,
          7217259,
          7234657,
          7234661,
          7234848,
          7235872,
          7235950,
          7273760,
          7498094,
          7535982,
          7759136,
          7954720,
          7958386,
          16608800,
          16608868,
          16609021,
          16642301
        ];
      }
      name(det) {
        return det && det.c1Bytes ? "windows-1254" : "ISO-8859-9";
      }
      language() {
        return "tr";
      }
    };
    exports.ISO_8859_9 = ISO_8859_9;
    var windows_1251 = class extends sbcs {
      static {
        __name(this, "windows_1251");
      }
      byteMap() {
        return [
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          0,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          144,
          131,
          32,
          131,
          32,
          32,
          32,
          32,
          32,
          32,
          154,
          32,
          156,
          157,
          158,
          159,
          144,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          154,
          32,
          156,
          157,
          158,
          159,
          32,
          162,
          162,
          188,
          32,
          180,
          32,
          32,
          184,
          32,
          186,
          32,
          32,
          32,
          32,
          191,
          32,
          32,
          179,
          179,
          180,
          181,
          32,
          32,
          184,
          32,
          186,
          32,
          188,
          190,
          190,
          191,
          224,
          225,
          226,
          227,
          228,
          229,
          230,
          231,
          232,
          233,
          234,
          235,
          236,
          237,
          238,
          239,
          240,
          241,
          242,
          243,
          244,
          245,
          246,
          247,
          248,
          249,
          250,
          251,
          252,
          253,
          254,
          255,
          224,
          225,
          226,
          227,
          228,
          229,
          230,
          231,
          232,
          233,
          234,
          235,
          236,
          237,
          238,
          239,
          240,
          241,
          242,
          243,
          244,
          245,
          246,
          247,
          248,
          249,
          250,
          251,
          252,
          253,
          254,
          255
        ];
      }
      ngrams() {
        return [
          2155040,
          2155246,
          2155758,
          2156512,
          2156576,
          2157280,
          2157294,
          2158048,
          2158053,
          2158305,
          2158574,
          2158576,
          2158816,
          2159086,
          2159090,
          2159342,
          2160626,
          2162162,
          14740968,
          14742268,
          14937632,
          15068156,
          15068648,
          15069682,
          15069728,
          15212783,
          15263008,
          15263776,
          15269664,
          15459821,
          15460384,
          15465709,
          15589408,
          15590688,
          15591653,
          15591679,
          15592992,
          15593186,
          15605986,
          15605999,
          15606001,
          15655456,
          15655648,
          15655918,
          15657248,
          15657980,
          15658016,
          15659506,
          15724267,
          15724773,
          15724776,
          15724782,
          15786210,
          15787492,
          15856352,
          15856354,
          15856360,
          15859488,
          15918571,
          15920672,
          15920880,
          15924256,
          16249582,
          16512288
        ];
      }
      name() {
        return "windows-1251";
      }
      language() {
        return "ru";
      }
    };
    exports.windows_1251 = windows_1251;
    var windows_1256 = class extends sbcs {
      static {
        __name(this, "windows_1256");
      }
      byteMap() {
        return [
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          0,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          129,
          32,
          131,
          32,
          32,
          32,
          32,
          136,
          32,
          138,
          32,
          156,
          141,
          142,
          143,
          144,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          152,
          32,
          154,
          32,
          156,
          32,
          32,
          159,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          170,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          181,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          192,
          193,
          194,
          195,
          196,
          197,
          198,
          199,
          200,
          201,
          202,
          203,
          204,
          205,
          206,
          207,
          208,
          209,
          210,
          211,
          212,
          213,
          214,
          32,
          216,
          217,
          218,
          219,
          220,
          221,
          222,
          223,
          224,
          225,
          226,
          227,
          228,
          229,
          230,
          231,
          232,
          233,
          234,
          235,
          236,
          237,
          238,
          239,
          32,
          32,
          32,
          32,
          244,
          32,
          32,
          32,
          32,
          249,
          32,
          251,
          252,
          32,
          32,
          255
        ];
      }
      ngrams() {
        return [
          2148321,
          2148324,
          2148551,
          2153185,
          2153965,
          2154977,
          2155492,
          2156231,
          13050055,
          13091104,
          13093408,
          13095200,
          13099296,
          13099459,
          13099463,
          13099464,
          13099466,
          13099468,
          13099469,
          13099471,
          13099475,
          13099482,
          13099486,
          13099491,
          13099494,
          13099501,
          13099808,
          13100064,
          13100234,
          13115591,
          13181127,
          13181149,
          13181153,
          13181155,
          13181158,
          13246663,
          13574343,
          13617440,
          13705415,
          13748512,
          13836487,
          14295239,
          14344684,
          14544160,
          14753991,
          14797088,
          14806048,
          14806304,
          14885063,
          14927648,
          14928160,
          14935072,
          14950599,
          15016135,
          15058720,
          15124449,
          15131680,
          15474887,
          15540423,
          15540451,
          15540454,
          15583520,
          15585568,
          15590432
        ];
      }
      name() {
        return "windows-1256";
      }
      language() {
        return "ar";
      }
    };
    exports.windows_1256 = windows_1256;
    var KOI8_R = class extends sbcs {
      static {
        __name(this, "KOI8_R");
      }
      byteMap() {
        return [
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          0,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          97,
          98,
          99,
          100,
          101,
          102,
          103,
          104,
          105,
          106,
          107,
          108,
          109,
          110,
          111,
          112,
          113,
          114,
          115,
          116,
          117,
          118,
          119,
          120,
          121,
          122,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          163,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          163,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          32,
          192,
          193,
          194,
          195,
          196,
          197,
          198,
          199,
          200,
          201,
          202,
          203,
          204,
          205,
          206,
          207,
          208,
          209,
          210,
          211,
          212,
          213,
          214,
          215,
          216,
          217,
          218,
          219,
          220,
          221,
          222,
          223,
          192,
          193,
          194,
          195,
          196,
          197,
          198,
          199,
          200,
          201,
          202,
          203,
          204,
          205,
          206,
          207,
          208,
          209,
          210,
          211,
          212,
          213,
          214,
          215,
          216,
          217,
          218,
          219,
          220,
          221,
          222,
          223
        ];
      }
      ngrams() {
        return [
          2147535,
          2148640,
          2149313,
          2149327,
          2150081,
          2150085,
          2150338,
          2150607,
          2150610,
          2151105,
          2151375,
          2151380,
          2151631,
          2152224,
          2152399,
          2153153,
          2153684,
          2154196,
          12701385,
          12702936,
          12963032,
          12963529,
          12964820,
          12964896,
          13094688,
          13181136,
          13223200,
          13224224,
          13226272,
          13419982,
          13420832,
          13424846,
          13549856,
          13550880,
          13552069,
          13552081,
          13553440,
          13553623,
          13574352,
          13574355,
          13574359,
          13617103,
          13617696,
          13618392,
          13618464,
          13620180,
          13621024,
          13621185,
          13684684,
          13685445,
          13685449,
          13685455,
          13812183,
          13813188,
          13881632,
          13882561,
          13882569,
          13882583,
          13944268,
          13946656,
          13946834,
          13948960,
          14272544,
          14603471
        ];
      }
      name() {
        return "KOI8-R";
      }
      language() {
        return "ru";
      }
    };
    exports.KOI8_R = KOI8_R;
  }
});

// node_modules/chardet/lib/encoding/iso2022.js
var require_iso2022 = __commonJS({
  "node_modules/chardet/lib/encoding/iso2022.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ISO_2022_CN = exports.ISO_2022_KR = exports.ISO_2022_JP = void 0;
    var match_1 = __importDefault(require_match());
    var ISO_2022 = class {
      static {
        __name(this, "ISO_2022");
      }
      constructor() {
        this.escapeSequences = [];
      }
      name() {
        return "ISO_2022";
      }
      match(det) {
        let i, j;
        let escN;
        let hits = 0;
        let misses = 0;
        let shifts = 0;
        let confidence;
        const text = det.inputBytes;
        const textLen = det.inputLen;
        scanInput: for (i = 0; i < textLen; i++) {
          if (text[i] == 27) {
            checkEscapes: for (escN = 0; escN < this.escapeSequences.length; escN++) {
              const seq = this.escapeSequences[escN];
              if (textLen - i < seq.length)
                continue checkEscapes;
              for (j = 1; j < seq.length; j++)
                if (seq[j] != text[i + j])
                  continue checkEscapes;
              hits++;
              i += seq.length - 1;
              continue scanInput;
            }
            misses++;
          }
          if (text[i] == 14 || text[i] == 15)
            shifts++;
        }
        if (hits == 0)
          return null;
        confidence = (100 * hits - 100 * misses) / (hits + misses);
        if (hits + shifts < 5)
          confidence -= (5 - (hits + shifts)) * 10;
        return confidence <= 0 ? null : (0, match_1.default)(det, this, confidence);
      }
    };
    var ISO_2022_JP = class extends ISO_2022 {
      static {
        __name(this, "ISO_2022_JP");
      }
      constructor() {
        super(...arguments);
        this.escapeSequences = [
          [27, 36, 40, 67],
          [27, 36, 40, 68],
          [27, 36, 64],
          [27, 36, 65],
          [27, 36, 66],
          [27, 38, 64],
          [27, 40, 66],
          [27, 40, 72],
          [27, 40, 73],
          [27, 40, 74],
          [27, 46, 65],
          [27, 46, 70]
        ];
      }
      name() {
        return "ISO-2022-JP";
      }
      language() {
        return "ja";
      }
    };
    exports.ISO_2022_JP = ISO_2022_JP;
    var ISO_2022_KR = class extends ISO_2022 {
      static {
        __name(this, "ISO_2022_KR");
      }
      constructor() {
        super(...arguments);
        this.escapeSequences = [[27, 36, 41, 67]];
      }
      name() {
        return "ISO-2022-KR";
      }
      language() {
        return "kr";
      }
    };
    exports.ISO_2022_KR = ISO_2022_KR;
    var ISO_2022_CN = class extends ISO_2022 {
      static {
        __name(this, "ISO_2022_CN");
      }
      constructor() {
        super(...arguments);
        this.escapeSequences = [
          [27, 36, 41, 65],
          [27, 36, 41, 71],
          [27, 36, 42, 72],
          [27, 36, 41, 69],
          [27, 36, 43, 73],
          [27, 36, 43, 74],
          [27, 36, 43, 75],
          [27, 36, 43, 76],
          [27, 36, 43, 77],
          [27, 78],
          [27, 79]
        ];
      }
      name() {
        return "ISO-2022-CN";
      }
      language() {
        return "zh";
      }
    };
    exports.ISO_2022_CN = ISO_2022_CN;
  }
});

// node_modules/chardet/lib/utils.js
var require_utils = __commonJS({
  "node_modules/chardet/lib/utils.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isByteArray = void 0;
    var isByteArray = /* @__PURE__ */ __name((input) => {
      if (input == null || typeof input != "object")
        return false;
      return isFinite(input.length) && input.length >= 0;
    }, "isByteArray");
    exports.isByteArray = isByteArray;
  }
});

// node_modules/chardet/lib/index.js
var require_lib = __commonJS({
  "node_modules/chardet/lib/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var __createBinding = exports && exports.__createBinding || (Object.create ? function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: /* @__PURE__ */ __name(function() {
          return m[k];
        }, "get") };
      }
      Object.defineProperty(o, k2, desc);
    } : function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    });
    var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    } : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports && exports.__importStar || /* @__PURE__ */ function() {
      var ownKeys = /* @__PURE__ */ __name(function(o) {
        ownKeys = Object.getOwnPropertyNames || function(o2) {
          var ar = [];
          for (var k in o2) if (Object.prototype.hasOwnProperty.call(o2, k)) ar[ar.length] = k;
          return ar;
        };
        return ownKeys(o);
      }, "ownKeys");
      return function(mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) {
          for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        }
        __setModuleDefault(result, mod);
        return result;
      };
    }();
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.detectFileSync = exports.detectFile = exports.analyse = exports.detect = void 0;
    var node_1 = __importDefault(require_node());
    var ascii_1 = __importDefault(require_ascii());
    var utf8_1 = __importDefault(require_utf8());
    var unicode = __importStar(require_unicode());
    var mbcs = __importStar(require_mbcs());
    var sbcs = __importStar(require_sbcs());
    var iso2022 = __importStar(require_iso2022());
    var utils_1 = require_utils();
    var recognisers = [
      new utf8_1.default(),
      new unicode.UTF_16BE(),
      new unicode.UTF_16LE(),
      new unicode.UTF_32BE(),
      new unicode.UTF_32LE(),
      new mbcs.sjis(),
      new mbcs.big5(),
      new mbcs.euc_jp(),
      new mbcs.euc_kr(),
      new mbcs.gb_18030(),
      new iso2022.ISO_2022_JP(),
      new iso2022.ISO_2022_KR(),
      new iso2022.ISO_2022_CN(),
      new sbcs.ISO_8859_1(),
      new sbcs.ISO_8859_2(),
      new sbcs.ISO_8859_5(),
      new sbcs.ISO_8859_6(),
      new sbcs.ISO_8859_7(),
      new sbcs.ISO_8859_8(),
      new sbcs.ISO_8859_9(),
      new sbcs.windows_1251(),
      new sbcs.windows_1256(),
      new sbcs.KOI8_R(),
      new ascii_1.default()
    ];
    var detect = /* @__PURE__ */ __name((buffer) => {
      const matches = (0, exports.analyse)(buffer);
      return matches.length > 0 ? matches[0].name : null;
    }, "detect");
    exports.detect = detect;
    var analyse = /* @__PURE__ */ __name((buffer) => {
      if (!(0, utils_1.isByteArray)(buffer)) {
        throw new Error("Input must be a byte array, e.g. Buffer or Uint8Array");
      }
      const byteStats = [];
      for (let i = 0; i < 256; i++)
        byteStats[i] = 0;
      for (let i = buffer.length - 1; i >= 0; i--)
        byteStats[buffer[i] & 255]++;
      let c1Bytes = false;
      for (let i = 128; i <= 159; i += 1) {
        if (byteStats[i] !== 0) {
          c1Bytes = true;
          break;
        }
      }
      const context = {
        byteStats,
        c1Bytes,
        rawInput: buffer,
        rawLen: buffer.length,
        inputBytes: buffer,
        inputLen: buffer.length
      };
      const matches = recognisers.map((rec) => {
        return rec.match(context);
      }).filter((match) => {
        return !!match;
      }).sort((a, b) => {
        return b.confidence - a.confidence;
      });
      return matches;
    }, "analyse");
    exports.analyse = analyse;
    var detectFile = /* @__PURE__ */ __name((filepath, opts = {}) => new Promise((resolve, reject) => {
      let fd;
      const fs4 = (0, node_1.default)();
      const handler = /* @__PURE__ */ __name((err, buffer) => {
        if (fd) {
          fs4.closeSync(fd);
        }
        if (err) {
          reject(err);
        } else {
          resolve((0, exports.detect)(buffer));
        }
      }, "handler");
      if (opts && opts.sampleSize) {
        fd = fs4.openSync(filepath, "r");
        const sample = Buffer.allocUnsafe(opts.sampleSize);
        fs4.read(fd, sample, 0, opts.sampleSize, opts.offset, (err) => {
          handler(err, sample);
        });
        return;
      }
      fs4.readFile(filepath, handler);
    }), "detectFile");
    exports.detectFile = detectFile;
    var detectFileSync = /* @__PURE__ */ __name((filepath, opts = {}) => {
      const fs4 = (0, node_1.default)();
      if (opts && opts.sampleSize) {
        const fd = fs4.openSync(filepath, "r");
        const sample = Buffer.allocUnsafe(opts.sampleSize);
        fs4.readSync(fd, sample, 0, opts.sampleSize, opts.offset);
        fs4.closeSync(fd);
        return (0, exports.detect)(sample);
      }
      return (0, exports.detect)(fs4.readFileSync(filepath));
    }, "detectFileSync");
    exports.detectFileSync = detectFileSync;
    exports.default = {
      analyse: exports.analyse,
      detect: exports.detect,
      detectFileSync: exports.detectFileSync,
      detectFile: exports.detectFile
    };
  }
});

// packages/core/src/utils/memory-constants.ts
init_esbuild_shims();
var DEFAULT_CONTEXT_FILENAME = "QWEN.md";
var AGENT_CONTEXT_FILENAME = "AGENTS.md";
var LOCAL_CONTEXT_FILENAME = "QWEN.local.md";
var MEMORY_SECTION_HEADER = "## Qwen Added Memories";
var currentMemoryFilename = [
  DEFAULT_CONTEXT_FILENAME,
  AGENT_CONTEXT_FILENAME
];
function setMemoryFilename(newFilename) {
  if (Array.isArray(newFilename)) {
    if (newFilename.length > 0) {
      currentMemoryFilename = newFilename.map((name) => name.trim());
    }
  } else if (newFilename && newFilename.trim() !== "") {
    currentMemoryFilename = newFilename.trim();
  }
}
__name(setMemoryFilename, "setMemoryFilename");
function getCurrentMemoryFilename() {
  if (Array.isArray(currentMemoryFilename)) {
    for (const entry of currentMemoryFilename) {
      if (typeof entry === "string" && entry.trim() !== "") {
        return entry.trim();
      }
    }
    return DEFAULT_CONTEXT_FILENAME;
  }
  return currentMemoryFilename;
}
__name(getCurrentMemoryFilename, "getCurrentMemoryFilename");
function getAllMemoryFilenames() {
  if (Array.isArray(currentMemoryFilename)) {
    return currentMemoryFilename;
  }
  return [currentMemoryFilename];
}
__name(getAllMemoryFilenames, "getAllMemoryFilenames");
var getAllGeminiMdFilenames = getAllMemoryFilenames;

// packages/core/src/utils/pdf.ts
init_esbuild_shims();
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// packages/core/src/utils/request-tokenizer/textTokenizer.ts
init_esbuild_shims();
var NON_ASCII_RE = /[\u0080-\uffff]/;
var TOKEN_ESTIMATE_UNITS_PER_TOKEN = 20;
function estimateTextTokens(text) {
  if (!text || text.length === 0) {
    return 0;
  }
  if (!NON_ASCII_RE.test(text)) {
    return Math.ceil(text.length / 4);
  }
  const nonAsciiChars = countNonAsciiChars(text);
  const asciiChars = text.length - nonAsciiChars;
  return Math.ceil(asciiChars / 4 + nonAsciiChars * 1.1);
}
__name(estimateTextTokens, "estimateTextTokens");
function estimateTextTokenUnits(text) {
  if (!text || text.length === 0) {
    return 0;
  }
  if (!NON_ASCII_RE.test(text)) {
    return text.length * 5;
  }
  const nonAsciiChars = countNonAsciiChars(text);
  const asciiChars = text.length - nonAsciiChars;
  return asciiChars * 5 + nonAsciiChars * 22;
}
__name(estimateTextTokenUnits, "estimateTextTokenUnits");
function countNonAsciiChars(text) {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      count++;
    }
  }
  return count;
}
__name(countNonAsciiChars, "countNonAsciiChars");

// packages/core/src/utils/pdf.ts
var MAX_PDF_TEXT_OUTPUT_CHARS = 1e5;
var PDF_FULL_TEXT_PAGE_LIMIT = 10;
var PDF_MAX_PAGES_PER_READ = 20;
var PDF_PAGE_COUNT_SIZE_HEURISTIC_BYTES = 100 * 1024;
var PDF_TEXT_RESULT_MAX_TOKENS = 12e3;
var PDF_TEXT_RESULT_WRAPPER_TOKEN_CHARS = 64;
var PDF_TEXT_RESULT_CHARS_PER_TOKEN = 4;
var PDF_TEXT_EXTRACTION_UNAVAILABLE_MESSAGE = "pdftotext is not installed. Install poppler-utils to enable PDF text extraction (e.g. `apt-get install poppler-utils` or `brew install poppler`).";
var PDF_RENDER_UNAVAILABLE_MESSAGE = "pdftoppm is not installed. Install poppler-utils to enable PDF page rendering (e.g. `apt-get install poppler-utils` or `brew install poppler`).";
var PDF_RENDER_SCALE_TO_PX = 1600;
var PDF_RENDER_MAX_TOTAL_BASE64_BYTES = 25 * 1024 * 1024;
var PDF_RENDER_TIMEOUT_MS = 12e4;
var MAX_PDF_PAGE_NUMBER = 1e6;
function shouldRequirePDFPageRange(pageCount, sizeBytes) {
  const hadPdfInfo = pageCount !== null;
  const effectivePageCount = pageCount ?? Math.ceil(sizeBytes / PDF_PAGE_COUNT_SIZE_HEURISTIC_BYTES);
  return {
    required: effectivePageCount > PDF_FULL_TEXT_PAGE_LIMIT,
    effectivePageCount,
    hadPdfInfo
  };
}
__name(shouldRequirePDFPageRange, "shouldRequirePDFPageRange");
function estimatePDFTextOutputTokens(text) {
  return Math.ceil(
    estimateTextTokens(text) + PDF_TEXT_RESULT_WRAPPER_TOKEN_CHARS / PDF_TEXT_RESULT_CHARS_PER_TOKEN
  );
}
__name(estimatePDFTextOutputTokens, "estimatePDFTextOutputTokens");
function buildLargePDFGuidance(displayName, requirement) {
  const source = requirement.hadPdfInfo ? "has" : "appears to have about";
  return `PDF "${displayName}" ${source} ${requirement.effectivePageCount} pages, which is too many to read at once. Use the 'pages' parameter to read a specific page range such as '1-5'. Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`;
}
__name(buildLargePDFGuidance, "buildLargePDFGuidance");
function buildPDFTextTooLargeGuidance(displayName, estimatedTokens, pagesUsed) {
  const pageRange = pagesUsed ? parsePDFPageRange(pagesUsed) : null;
  const prefix = `PDF text extracted from "${displayName}" is too large to return safely (${estimatedTokens} estimated tokens; limit ${PDF_TEXT_RESULT_MAX_TOKENS}).`;
  if (pageRange && pageRange.firstPage === pageRange.lastPage) {
    return `${prefix} The selected page exceeds the output limit. Use a native PDF-capable model, split the page content externally, or extract a smaller section with another tool.`;
  }
  if (pageRange) {
    const suggestedEnd = Math.floor(
      (pageRange.firstPage + pageRange.lastPage) / 2
    );
    if (suggestedEnd === pageRange.firstPage) {
      return `${prefix} Use the 'pages' parameter with a single page, for example '${pageRange.firstPage}'.`;
    }
    return `${prefix} Use the 'pages' parameter with fewer pages, for example '${pageRange.firstPage}-${suggestedEnd}' or a single page.`;
  }
  return `${prefix} Use the 'pages' parameter with a narrower range, for example '1-2' or a single page.`;
}
__name(buildPDFTextTooLargeGuidance, "buildPDFTextTooLargeGuidance");
function execCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", ...options },
      (error, stdout, stderr) => {
        if (error) {
          const errAny = error;
          const maxBufferExceeded = errAny.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          const timedOut = !maxBufferExceeded && (errAny.code === "ETIMEDOUT" || errAny.killed === true && (errAny.signal === "SIGTERM" || errAny.signal === void 0 || errAny.signal === null));
          resolve({
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            code: typeof error.code === "number" ? error.code : 1,
            maxBufferExceeded,
            timedOut
          });
          return;
        }
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code: 0,
          maxBufferExceeded: false,
          timedOut: false
        });
      }
    );
  });
}
__name(execCommand, "execCommand");
function parsePDFPageRange(pages) {
  const trimmed = pages.trim();
  if (!trimmed) {
    return null;
  }
  const inRange = /* @__PURE__ */ __name((n) => Number.isFinite(n) && n >= 1 && n <= MAX_PDF_PAGE_NUMBER, "inRange");
  const openEnded = /^(\d+)\s*-$/.exec(trimmed);
  if (openEnded) {
    const first = Number(openEnded[1]);
    if (!inRange(first)) return null;
    return { firstPage: first, lastPage: Infinity };
  }
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
  if (range) {
    const first = Number(range[1]);
    const last = Number(range[2]);
    if (!inRange(first) || !inRange(last) || last < first) return null;
    return { firstPage: first, lastPage: last };
  }
  const single = /^(\d+)$/.exec(trimmed);
  if (single) {
    const page = Number(single[1]);
    if (!inRange(page)) return null;
    return { firstPage: page, lastPage: page };
  }
  return null;
}
__name(parsePDFPageRange, "parsePDFPageRange");
var pdftotextAvailable;
var pdftotextAvailablePromise;
async function isPdftotextAvailable() {
  if (pdftotextAvailable !== void 0) return pdftotextAvailable;
  if (pdftotextAvailablePromise) return pdftotextAvailablePromise;
  pdftotextAvailablePromise = (async () => {
    try {
      const { code } = await execCommand("pdftotext", ["-v"], {
        timeout: 5e3
      });
      return code === 0;
    } catch {
      return false;
    }
  })().then((result) => {
    pdftotextAvailable = result;
    return result;
  }).finally(() => {
    pdftotextAvailablePromise = void 0;
  });
  return pdftotextAvailablePromise;
}
__name(isPdftotextAvailable, "isPdftotextAvailable");
async function getPDFPageCount(filePath) {
  try {
    const { stdout, code } = await execCommand("pdfinfo", ["--", filePath], {
      timeout: 1e4
    });
    if (code !== 0) {
      return null;
    }
    const match = /^Pages:\s+(\d+)/m.exec(stdout);
    if (!match) {
      return null;
    }
    const count = parseInt(match[1], 10);
    return isNaN(count) ? null : count;
  } catch {
    return null;
  }
}
__name(getPDFPageCount, "getPDFPageCount");
async function extractPDFText(filePath, options) {
  const available = await isPdftotextAvailable();
  if (!available) {
    return {
      success: false,
      error: PDF_TEXT_EXTRACTION_UNAVAILABLE_MESSAGE
    };
  }
  const args = ["-layout"];
  if (options?.firstPage) {
    args.push("-f", String(options.firstPage));
  }
  if (options?.lastPage && options.lastPage !== Infinity) {
    args.push("-l", String(options.lastPage));
  }
  args.push("--", filePath, "-");
  try {
    const { stdout, stderr, code, maxBufferExceeded, timedOut } = await execCommand("pdftotext", args, {
      timeout: 3e4,
      // Keep the buffer just above MAX_PDF_TEXT_OUTPUT_CHARS — anything
      // past that is going to be truncated anyway, and capping the child
      // prevents unbounded memory use on pathological text-dense PDFs.
      maxBuffer: MAX_PDF_TEXT_OUTPUT_CHARS * 2,
      // Caller cancellation kills the subprocess instead of blocking the
      // tool invocation for up to the 30s timeout.
      signal: options?.signal
    });
    if (options?.signal?.aborted) {
      return { success: false, error: "PDF text extraction was cancelled." };
    }
    if (timedOut) {
      return {
        success: false,
        error: `pdftotext timed out after 30s. The PDF may be unusually large or complex; try the 'pages' parameter to narrow the range.`
      };
    }
    if (maxBufferExceeded && Buffer.byteLength(stdout, "utf8") >= MAX_PDF_TEXT_OUTPUT_CHARS) {
      const wasCharTruncated = stdout.length > MAX_PDF_TEXT_OUTPUT_CHARS;
      const text = wasCharTruncated ? stdout.substring(0, MAX_PDF_TEXT_OUTPUT_CHARS) : stdout;
      const truncationReason = wasCharTruncated ? `at ${MAX_PDF_TEXT_OUTPUT_CHARS} characters` : "after reaching the PDF text buffer limit";
      return {
        success: true,
        text: text + `

... [text truncated ${truncationReason}. Use the 'pages' parameter to read specific page ranges.]`
      };
    }
    if (code !== 0 || maxBufferExceeded) {
      if (/password/i.test(stderr)) {
        return {
          success: false,
          error: "PDF is password-protected. Please provide an unprotected version."
        };
      }
      if (/damaged|corrupt|invalid/i.test(stderr)) {
        return {
          success: false,
          error: "PDF file is corrupted or invalid."
        };
      }
      return {
        success: false,
        error: `pdftotext failed: ${stderr || "(no stderr)"}`
      };
    }
    if (!stdout.trim()) {
      return {
        success: false,
        error: "pdftotext produced no text output. The PDF may contain only images."
      };
    }
    if (stdout.length > MAX_PDF_TEXT_OUTPUT_CHARS) {
      return {
        success: true,
        text: stdout.substring(0, MAX_PDF_TEXT_OUTPUT_CHARS) + `

... [text truncated at ${MAX_PDF_TEXT_OUTPUT_CHARS} characters. Use the 'pages' parameter to read specific page ranges.]`
      };
    }
    return { success: true, text: stdout };
  } catch (e) {
    return {
      success: false,
      error: `pdftotext execution failed: ${e instanceof Error ? e.message : String(e)}`
    };
  }
}
__name(extractPDFText, "extractPDFText");
var pdftoppmAvailable;
var pdftoppmAvailablePromise;
async function isPdftoppmAvailable() {
  if (pdftoppmAvailable !== void 0) return pdftoppmAvailable;
  if (pdftoppmAvailablePromise) return pdftoppmAvailablePromise;
  pdftoppmAvailablePromise = (async () => {
    try {
      const { code } = await execCommand("pdftoppm", ["-v"], {
        timeout: 5e3
      });
      return code === 0;
    } catch {
      return false;
    }
  })().then((result) => {
    pdftoppmAvailable = result;
    return result;
  }).finally(() => {
    pdftoppmAvailablePromise = void 0;
  });
  return pdftoppmAvailablePromise;
}
__name(isPdftoppmAvailable, "isPdftoppmAvailable");
function comparePdfPageFilenames(a, b) {
  const pageNumber = /* @__PURE__ */ __name((name) => {
    const match = /(\d+)\.jpg$/i.exec(name);
    return match ? parseInt(match[1], 10) : 0;
  }, "pageNumber");
  return pageNumber(a) - pageNumber(b);
}
__name(comparePdfPageFilenames, "comparePdfPageFilenames");
async function renderPDFPagesToImages(filePath, options) {
  const available = await isPdftoppmAvailable();
  if (!available) {
    return { success: false, error: PDF_RENDER_UNAVAILABLE_MESSAGE };
  }
  let tempDir;
  try {
    tempDir = await mkdtemp(join(tmpdir(), "pdf-render-"));
    const outputPrefix = join(tempDir, "page");
    const args = [
      "-jpeg",
      "-scale-to",
      String(PDF_RENDER_SCALE_TO_PX)
    ];
    if (options?.firstPage) {
      args.push("-f", String(options.firstPage));
    }
    if (options?.lastPage && options.lastPage !== Infinity) {
      args.push("-l", String(options.lastPage));
    }
    args.push("--", filePath, outputPrefix);
    const { stderr, code, timedOut } = await execCommand("pdftoppm", args, {
      timeout: PDF_RENDER_TIMEOUT_MS
    });
    if (timedOut) {
      return {
        success: false,
        error: `pdftoppm timed out after ${Math.round(
          PDF_RENDER_TIMEOUT_MS / 1e3
        )}s. The PDF may be unusually large or complex; try the 'pages' parameter to narrow the range.`
      };
    }
    if (code !== 0) {
      if (/password/i.test(stderr)) {
        return {
          success: false,
          error: "PDF is password-protected. Please provide an unprotected version."
        };
      }
      if (/damaged|corrupt|invalid/i.test(stderr)) {
        return { success: false, error: "PDF file is corrupted or invalid." };
      }
      return {
        success: false,
        error: `pdftoppm failed: ${stderr || "(no stderr)"}`
      };
    }
    const entries = (await readdir(tempDir)).filter((name) => name.toLowerCase().endsWith(".jpg")).sort(comparePdfPageFilenames);
    if (entries.length === 0) {
      return {
        success: false,
        error: "pdftoppm produced no image output. The PDF may be empty or the page range may be out of bounds."
      };
    }
    const images = [];
    let totalBytes = 0;
    let bytesTruncated = false;
    for (const name of entries) {
      const buffer = await readFile(join(tempDir, name));
      const data = buffer.toString("base64");
      if (images.length > 0 && totalBytes + data.length > PDF_RENDER_MAX_TOTAL_BASE64_BYTES) {
        bytesTruncated = true;
        break;
      }
      totalBytes += data.length;
      images.push({ data, mimeType: "image/jpeg" });
    }
    return { success: true, images, bytesTruncated };
  } catch (e) {
    return {
      success: false,
      error: `pdftoppm execution failed: ${e instanceof Error ? e.message : String(e)}`
    };
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {
      });
    }
  }
}
__name(renderPDFPagesToImages, "renderPDFPagesToImages");

// packages/core/src/utils/binary-content.ts
init_esbuild_shims();
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
var BINARY_APPLICATION_TYPES = /* @__PURE__ */ new Set([
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/octet-stream",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
  "application/wasm",
  "application/java-archive"
]);
function isBinaryContentType(contentType) {
  if (!contentType) return false;
  const mt = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (mt.startsWith("text/")) return false;
  if (mt.endsWith("+json") || mt.endsWith("+xml")) return false;
  if (mt.startsWith("image/") || mt.startsWith("audio/") || mt.startsWith("video/") || mt.startsWith("font/")) {
    return true;
  }
  if (BINARY_APPLICATION_TYPES.has(mt)) return true;
  if (mt.startsWith("application/vnd.openxmlformats")) return true;
  if (mt.startsWith("application/vnd.oasis.opendocument")) return true;
  return false;
}
__name(isBinaryContentType, "isBinaryContentType");
var MIME_EXTENSIONS = /* @__PURE__ */ new Map([
  ["application/pdf", "pdf"],
  ["application/zip", "zip"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "docx"
  ],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "pptx"
  ],
  ["application/msword", "doc"],
  ["application/vnd.ms-excel", "xls"],
  ["application/vnd.ms-powerpoint", "ppt"],
  ["application/gzip", "gz"],
  ["application/x-gzip", "gz"],
  ["application/x-tar", "tar"],
  ["application/x-7z-compressed", "7z"],
  ["application/x-rar-compressed", "rar"],
  ["application/vnd.rar", "rar"],
  ["application/wasm", "wasm"],
  ["application/java-archive", "jar"],
  ["audio/mpeg", "mp3"],
  ["audio/wav", "wav"],
  ["audio/ogg", "ogg"],
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/svg+xml", "svg"]
]);
function extensionForMimeType(mimeType) {
  if (!mimeType) return "bin";
  const mt = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  return MIME_EXTENSIONS.get(mt) ?? "bin";
}
__name(extensionForMimeType, "extensionForMimeType");
var KNOWN_EXTENSIONS = /* @__PURE__ */ new Set([...MIME_EXTENSIONS.values(), "jpeg", "bin"]);
function extensionFromFilename(name) {
  if (!name) return void 0;
  const ext = name.split(".").pop()?.trim().toLowerCase();
  return ext && ext !== name && KNOWN_EXTENSIONS.has(ext) ? ext : void 0;
}
__name(extensionFromFilename, "extensionFromFilename");
function filenameFromContentDisposition(contentDisposition) {
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(contentDisposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      return star[1].trim();
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(contentDisposition);
  return plain?.[1]?.trim();
}
__name(filenameFromContentDisposition, "filenameFromContentDisposition");
function sniffFileKind(bytes, contentType, contentDisposition, url) {
  const dispositionExt = extensionFromFilename(
    filenameFromContentDisposition(contentDisposition)
  );
  let urlExt;
  try {
    urlExt = extensionFromFilename(new URL(url).pathname.split("/").pop());
  } catch {
    urlExt = void 0;
  }
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    return {
      extension: "pdf",
      mimeType: "application/pdf",
      magicMatched: true,
      extensionSource: "magic"
    };
  }
  if (bytes.length >= 4 && bytes[0] === 80 && bytes[1] === 75 && bytes[2] === 3 && bytes[3] === 4) {
    const zipHint = dispositionExt ?? urlExt ?? extensionForMimeType(contentType);
    const refined = zipHint && ["docx", "xlsx", "pptx", "jar"].includes(zipHint) ? zipHint : "zip";
    return {
      extension: refined,
      mimeType: contentType || "application/zip",
      magicMatched: true,
      extensionSource: "magic"
    };
  }
  if (bytes.length >= 2 && bytes[0] === 31 && bytes[1] === 139) {
    return {
      extension: "gz",
      mimeType: "application/gzip",
      magicMatched: true,
      extensionSource: "magic"
    };
  }
  if (bytes.length >= 7 && bytes.subarray(0, 4).toString("latin1") === "Rar!" && bytes[4] === 26 && bytes[5] === 7) {
    return {
      extension: "rar",
      mimeType: "application/vnd.rar",
      magicMatched: true,
      extensionSource: "magic"
    };
  }
  if (bytes.length >= 8 && bytes[0] === 137 && bytes.subarray(1, 4).toString("latin1") === "PNG") {
    return {
      extension: "png",
      mimeType: "image/png",
      magicMatched: true,
      extensionSource: "magic"
    };
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return {
      extension: "jpg",
      mimeType: "image/jpeg",
      magicMatched: true,
      extensionSource: "magic"
    };
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("latin1") === "GIF8") {
    return {
      extension: "gif",
      mimeType: "image/gif",
      magicMatched: true,
      extensionSource: "magic"
    };
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return {
      extension: "webp",
      mimeType: "image/webp",
      magicMatched: true,
      extensionSource: "magic"
    };
  }
  const nameExt = dispositionExt ?? urlExt;
  if (nameExt) {
    return {
      extension: nameExt,
      mimeType: contentType,
      magicMatched: false,
      extensionSource: "name"
    };
  }
  const mimeExt = extensionForMimeType(contentType);
  return {
    extension: mimeExt,
    mimeType: contentType,
    magicMatched: false,
    extensionSource: mimeExt !== "bin" ? "mime" : "fallback"
  };
}
__name(sniffFileKind, "sniffFileKind");
function looksLikeText(bytes) {
  const window = bytes.subarray(0, 8192);
  if (window.includes(0)) return false;
  const decoded = new TextDecoder("utf-8").decode(window);
  let bad = 0;
  for (let i = 0; i < decoded.length; i++) {
    if (decoded[i] === "\uFFFD" && ++bad > 2) return false;
  }
  return true;
}
__name(looksLikeText, "looksLikeText");
async function persistBinaryContent(bytes, ext, dir, persistId) {
  const filepath = path.join(dir, `${persistId}.${ext}`);
  try {
    await mkdir(dir, { recursive: true, mode: 448 });
    await writeFile(filepath, bytes, { mode: 384 });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { filepath, size: bytes.length, ext };
}
__name(persistBinaryContent, "persistBinaryContent");
function formatByteSize(sizeInBytes) {
  const kb = sizeInBytes / 1024;
  if (kb < 1) return `${sizeInBytes} bytes`;
  const fmt = /* @__PURE__ */ __name((n) => n.toFixed(1).replace(/\.0$/, ""), "fmt");
  if (kb < 1024) return `${fmt(kb)}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${fmt(mb)}MB`;
  return `${fmt(mb / 1024)}GB`;
}
__name(formatByteSize, "formatByteSize");

// packages/core/src/utils/notebook.ts
init_esbuild_shims();
import fs from "node:fs";
var LARGE_OUTPUT_THRESHOLD = 1e4;
var MAX_NOTEBOOK_OUTPUT_CHARS = 1e5;
var ANSI_ESCAPE_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[P_^X][^\x1B]*\x1B\\|[@-Z\\-_])/g;
function stripAnsi(input) {
  return input.replace(ANSI_ESCAPE_RE, "");
}
__name(stripAnsi, "stripAnsi");
var MIME_TYPE_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\+[A-Za-z0-9!#$&^_.+-]+)?$/;
function sanitizeMimeTypes(keys) {
  return keys.filter((k) => MIME_TYPE_RE.test(k));
}
__name(sanitizeMimeTypes, "sanitizeMimeTypes");
function normalizeSource(source) {
  return Array.isArray(source) ? source.join("") : source;
}
__name(normalizeSource, "normalizeSource");
function parseNotebook(content) {
  const jsonContent = content.charCodeAt(0) === 65279 ? content.slice(1) : content;
  const parsed = JSON.parse(jsonContent);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid notebook: expected a JSON object");
  }
  const notebook = parsed;
  if (!Array.isArray(notebook.cells)) {
    throw new Error("Invalid notebook: missing cells array");
  }
  for (let i = 0; i < notebook.cells.length; i++) {
    const cell = notebook.cells[i];
    if (!cell || typeof cell !== "object" || Array.isArray(cell)) {
      throw new Error(`Invalid notebook: cell at index ${i} is not an object`);
    }
  }
  return notebook;
}
__name(parseNotebook, "parseNotebook");
function inferNotebookJsonFormat(content) {
  const lineMatch = content.match(/\n([ \t]+)"/);
  const indent = lineMatch?.[1];
  let inferredIndent;
  if (indent !== void 0) {
    inferredIndent = /^ +$/.test(indent) ? indent.length : indent;
  }
  return {
    indent: inferredIndent,
    trailingNewline: content.endsWith("\n")
  };
}
__name(inferNotebookJsonFormat, "inferNotebookJsonFormat");
function serializeNotebook(notebook, format = { indent: 1, trailingNewline: true }) {
  const serialized = JSON.stringify(notebook, null, format.indent);
  return format.trailingNewline ? `${serialized}
` : serialized;
}
__name(serializeNotebook, "serializeNotebook");
function getCellDisplayId(cell, index) {
  return typeof cell.id === "string" && cell.id.length > 0 ? cell.id : `cell-${index}`;
}
__name(getCellDisplayId, "getCellDisplayId");
function hasStableCellIds(notebook) {
  return notebook.cells.every(
    (cell) => typeof cell.id === "string" && cell.id.length > 0
  );
}
__name(hasStableCellIds, "hasStableCellIds");
function findCellIndexesByDisplayId(notebook, cellId) {
  const indexes = [];
  notebook.cells.forEach((cell, index) => {
    if (getCellDisplayId(cell, index) === cellId) {
      indexes.push(index);
    }
  });
  return indexes;
}
__name(findCellIndexesByDisplayId, "findCellIndexesByDisplayId");
function isAmbiguousCellId(notebook, cellId) {
  return findCellIndexesByDisplayId(notebook, cellId).length > 1;
}
__name(isAmbiguousCellId, "isAmbiguousCellId");
function findCellIndex(notebook, cellId) {
  const indexes = findCellIndexesByDisplayId(notebook, cellId);
  return indexes.length === 1 ? indexes[0] : -1;
}
__name(findCellIndex, "findCellIndex");
function getNotebookLanguage(notebook) {
  return notebook.metadata?.language_info?.name ?? notebook.metadata?.kernelspec?.language ?? "python";
}
__name(getNotebookLanguage, "getNotebookLanguage");
function shouldGenerateCellIds(notebook) {
  return (notebook.nbformat ?? 0) > 4 || (notebook.nbformat ?? 0) === 4 && (notebook.nbformat_minor ?? 0) >= 5;
}
__name(shouldGenerateCellIds, "shouldGenerateCellIds");
function makeCellId(notebook) {
  if (!shouldGenerateCellIds(notebook)) {
    return void 0;
  }
  const existingDisplayIds = new Set(
    notebook.cells.map((cell, index) => getCellDisplayId(cell, index))
  );
  let fallbackIndex = 1;
  let fallback = `qwen-cell-${fallbackIndex}`;
  while (existingDisplayIds.has(fallback)) {
    fallbackIndex++;
    fallback = `qwen-cell-${fallbackIndex}`;
  }
  return fallback;
}
__name(makeCellId, "makeCellId");
function inferNotebookSourceArrayStyle(notebook) {
  const sourceCell = notebook.cells.find((cell) => cell.source !== void 0);
  return sourceCell ? Array.isArray(sourceCell.source) : true;
}
__name(inferNotebookSourceArrayStyle, "inferNotebookSourceArrayStyle");
function inferInsertedCellSourceArrayStyle(notebook, insertAt) {
  const previousCell = notebook.cells[insertAt - 1];
  if (previousCell?.source !== void 0) {
    return Array.isArray(previousCell.source);
  }
  const nextCell = notebook.cells[insertAt];
  if (nextCell?.source !== void 0) {
    return Array.isArray(nextCell.source);
  }
  return inferNotebookSourceArrayStyle(notebook);
}
__name(inferInsertedCellSourceArrayStyle, "inferInsertedCellSourceArrayStyle");
function toNotebookSource(source, preferArray) {
  if (!preferArray) {
    return source;
  }
  if (source.length === 0) {
    return [];
  }
  const lines = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") {
      lines.push(source.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < source.length) {
    lines.push(source.slice(start));
  }
  return lines;
}
__name(toNotebookSource, "toNotebookSource");
function normalizeEditedCell(cell, finalType) {
  cell.cell_type = finalType;
  cell.metadata ??= {};
  if (finalType === "code") {
    cell.execution_count = null;
    cell.outputs = [];
    return;
  }
  delete cell.execution_count;
  delete cell.outputs;
}
__name(normalizeEditedCell, "normalizeEditedCell");
function processOutputText(text) {
  if (!text) return "";
  return Array.isArray(text) ? text.join("") : text;
}
__name(processOutputText, "processOutputText");
function processOutput(output) {
  switch (output.output_type) {
    case "stream":
      return stripAnsi(processOutputText(output.text));
    case "execute_result":
    case "display_data": {
      const textData = output.data?.["text/plain"];
      if (typeof textData === "string") return stripAnsi(textData);
      if (Array.isArray(textData)) return stripAnsi(textData.join(""));
      const mimeTypes = output.data ? sanitizeMimeTypes(Object.keys(output.data)) : [];
      if (mimeTypes.length > 0) {
        return `[non-text output: ${mimeTypes.join(", ")}]`;
      }
      return "";
    }
    case "error": {
      const parts = [];
      if (output.ename) parts.push(output.ename);
      if (output.evalue) parts.push(output.evalue);
      if (output.traceback?.length) {
        parts.push(output.traceback.join("\n"));
      }
      return stripAnsi(parts.join(": "));
    }
    default:
      return "";
  }
}
__name(processOutput, "processOutput");
function processCell(cell, index, language) {
  const cellId = getCellDisplayId(cell, index);
  const source = normalizeSource(cell.source);
  const parts = [];
  switch (cell.cell_type) {
    case "code": {
      const execLabel = cell.execution_count != null ? ` [${cell.execution_count}]` : "";
      parts.push(`--- Code Cell ${cellId}${execLabel} ---`);
      parts.push(`\`\`\`${language}`);
      parts.push(source);
      parts.push("```");
      if (cell.outputs?.length) {
        const outputTexts = cell.outputs.map(processOutput).filter((t) => t.length > 0);
        if (outputTexts.length > 0) {
          let combined = outputTexts.join("\n");
          if (combined.length > LARGE_OUTPUT_THRESHOLD) {
            combined = combined.substring(0, LARGE_OUTPUT_THRESHOLD) + `
... [output truncated, total ${combined.length} chars. Use shell: cat <notebook_path> | jq '.cells[${index}].outputs']`;
          }
          parts.push("Output:");
          parts.push(combined);
        }
      }
      break;
    }
    case "markdown":
      parts.push(`--- Markdown Cell ${cellId} ---`);
      parts.push(source);
      break;
    case "raw":
      parts.push(`--- Raw Cell ${cellId} ---`);
      parts.push(source);
      break;
    default:
      parts.push(`--- Cell ${cellId} ---`);
      parts.push(source);
      break;
  }
  return parts.join("\n");
}
__name(processCell, "processCell");
async function readNotebookWithMetadata(filePath) {
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const notebook = parseNotebook(raw);
  const language = getNotebookLanguage(notebook);
  if (!notebook.cells || notebook.cells.length === 0) {
    return { content: "(empty notebook)", isTruncated: false };
  }
  const header = `Jupyter Notebook (${language}, ${notebook.cells.length} cells)`;
  const cellTexts = [];
  let totalLength = header.length;
  let isTruncated = false;
  for (let i = 0; i < notebook.cells.length; i++) {
    const cellText = processCell(notebook.cells[i], i, language);
    totalLength += cellText.length + 2;
    if (totalLength > MAX_NOTEBOOK_OUTPUT_CHARS) {
      isTruncated = true;
      cellTexts.push(
        `... [${notebook.cells.length - i} remaining cells truncated, total ${notebook.cells.length} cells. Use shell to inspect: cat <path> | jq '.cells[${i}:]']`
      );
      break;
    }
    cellTexts.push(cellText);
  }
  return {
    content: `${header}

${cellTexts.join("\n\n")}`,
    isTruncated
  };
}
__name(readNotebookWithMetadata, "readNotebookWithMetadata");

// packages/core/src/utils/image-view.ts
init_esbuild_shims();
import fs2 from "node:fs/promises";
var IMAGE_VIEW_MAX_EDGE = 1568;
var IMAGE_VIEW_MAX_PATCHES = 1568;
var IMAGE_PATCH_SIZE = 28;
var IMAGE_MAX_UPSCALE = 8;
var IMAGE_JPEG_QUALITY = 92;
var IMAGE_MAX_SOURCE_BYTES = 100 * 1024 * 1024;
var IMAGE_MAX_OUTPUT_BYTES = 9 * 1024 * 1024;
var SUPPORTED_IMAGE_FORMATS = /* @__PURE__ */ new Set(["jpeg", "png", "webp"]);
var ImageViewError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  static {
    __name(this, "ImageViewError");
  }
};
function orientedSize(metadata) {
  const autoOrient = metadata.autoOrient;
  if (autoOrient) {
    return { width: autoOrient.width, height: autoOrient.height };
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const orientation = metadata.orientation ?? 0;
  return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
}
__name(orientedSize, "orientedSize");
function fitsVisualBudget({ width, height }) {
  return width <= IMAGE_VIEW_MAX_EDGE && height <= IMAGE_VIEW_MAX_EDGE && Math.ceil(width / IMAGE_PATCH_SIZE) * Math.ceil(height / IMAGE_PATCH_SIZE) <= IMAGE_VIEW_MAX_PATCHES;
}
__name(fitsVisualBudget, "fitsVisualBudget");
function boundedSize(width, height, maxUpscale) {
  const widthIsLongEdge = width >= height;
  const maxLongEdge = Math.min(
    IMAGE_VIEW_MAX_EDGE,
    Math.max(width, height) * maxUpscale
  );
  let low = 1;
  let high = maxLongEdge;
  let best = { width: 1, height: 1 };
  while (low <= high) {
    const longEdge = Math.floor((low + high) / 2);
    const candidate = widthIsLongEdge ? {
      width: longEdge,
      height: Math.max(1, Math.round(height / width * longEdge))
    } : {
      width: Math.max(1, Math.round(width / height * longEdge)),
      height: longEdge
    };
    if (fitsVisualBudget(candidate)) {
      best = candidate;
      low = longEdge + 1;
    } else {
      high = longEdge - 1;
    }
  }
  return best;
}
__name(boundedSize, "boundedSize");
async function prepareImage(filePath, signal) {
  signal.throwIfAborted();
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    throw new ImageViewError(
      "renderer_unavailable",
      'Image rendering is unavailable because the "sharp" image module could not be loaded.'
    );
  }
  let stats;
  try {
    stats = await fs2.stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ImageViewError(
        "file_not_found",
        `Image file not found: ${filePath}`
      );
    }
    throw error;
  }
  if (stats.isDirectory()) {
    throw new ImageViewError(
      "target_is_directory",
      `Image path is a directory: ${filePath}`
    );
  }
  if (!stats.isFile()) {
    throw new ImageViewError(
      "target_not_regular_file",
      `Image path is not a regular file: ${filePath}`
    );
  }
  if (stats.size > IMAGE_MAX_SOURCE_BYTES) {
    throw new ImageViewError(
      "source_too_large",
      `Image file exceeds the 100 MB source limit: ${filePath}`
    );
  }
  const bytes = await fs2.readFile(filePath, { signal });
  if (bytes.length > IMAGE_MAX_SOURCE_BYTES) {
    throw new ImageViewError(
      "source_too_large",
      `Image file exceeds the 100 MB source limit: ${filePath}`
    );
  }
  let metadata;
  try {
    metadata = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: true
    }).metadata();
  } catch {
    signal.throwIfAborted();
    throw new ImageViewError(
      "decode_failed",
      `Failed to decode image (file may be corrupt or not a static PNG, JPEG, or WebP): ${filePath}`
    );
  }
  signal.throwIfAborted();
  if (!SUPPORTED_IMAGE_FORMATS.has(metadata.format)) {
    throw new ImageViewError(
      "unsupported_image",
      `Unsupported image. Expected a static PNG, JPEG, or WebP file: ${filePath}`
    );
  }
  if ((metadata.pages ?? 1) > 1) {
    throw new ImageViewError(
      "animated_image",
      `Only static images are supported: ${filePath}`
    );
  }
  return { bytes, metadata, sharp };
}
__name(prepareImage, "prepareImage");
async function renderImageView(filePath, prepared, selection, outputSize, signal) {
  const { bytes, metadata, sharp } = prepared;
  const sourceSize = orientedSize(metadata);
  let output;
  try {
    output = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: true
    }).rotate().extract(selection).resize(outputSize.width, outputSize.height, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3
    }).flatten({ background: "#ffffff" }).jpeg({
      quality: IMAGE_JPEG_QUALITY,
      chromaSubsampling: "4:4:4"
    }).toBuffer();
  } catch {
    signal.throwIfAborted();
    throw new ImageViewError(
      "decode_failed",
      `Failed to render image overview: ${filePath}`
    );
  }
  signal.throwIfAborted();
  if (output.length > IMAGE_MAX_OUTPUT_BYTES) {
    throw new ImageViewError(
      "output_too_large",
      `Rendered image exceeds the 9 MB output limit: ${filePath}`
    );
  }
  return {
    bytes: output,
    mimeType: "image/jpeg",
    sourceWidth: sourceSize.width,
    sourceHeight: sourceSize.height,
    selectedWidth: selection.width,
    selectedHeight: selection.height,
    outputWidth: outputSize.width,
    outputHeight: outputSize.height
  };
}
__name(renderImageView, "renderImageView");
async function renderImageOverview(filePath, signal) {
  const prepared = await prepareImage(filePath, signal);
  const { width: sourceWidth, height: sourceHeight } = orientedSize(
    prepared.metadata
  );
  const outputSize = boundedSize(sourceWidth, sourceHeight, 1);
  return renderImageView(
    filePath,
    prepared,
    { left: 0, top: 0, width: sourceWidth, height: sourceHeight },
    outputSize,
    signal
  );
}
__name(renderImageOverview, "renderImageOverview");
async function renderNormalizedImageCrop(filePath, region, signal) {
  const prepared = await prepareImage(filePath, signal);
  const { width: sourceWidth, height: sourceHeight } = orientedSize(
    prepared.metadata
  );
  const left = Math.min(
    sourceWidth - 1,
    Math.max(0, Math.floor(region.x1 / 1e3 * sourceWidth))
  );
  const top = Math.min(
    sourceHeight - 1,
    Math.max(0, Math.floor(region.y1 / 1e3 * sourceHeight))
  );
  const right = Math.min(
    sourceWidth,
    Math.max(left + 1, Math.ceil(region.x2 / 1e3 * sourceWidth))
  );
  const bottom = Math.min(
    sourceHeight,
    Math.max(top + 1, Math.ceil(region.y2 / 1e3 * sourceHeight))
  );
  const selectedWidth = right - left;
  const selectedHeight = bottom - top;
  const outputSize = boundedSize(
    selectedWidth,
    selectedHeight,
    IMAGE_MAX_UPSCALE
  );
  return renderImageView(
    filePath,
    prepared,
    { left, top, width: selectedWidth, height: selectedHeight },
    outputSize,
    signal
  );
}
__name(renderNormalizedImageCrop, "renderNormalizedImageCrop");

// packages/core/src/utils/fileUtils.ts
init_esbuild_shims();
import fs3 from "node:fs";
import fsPromises from "node:fs/promises";
import path3 from "node:path";

// packages/core/node_modules/mime/dist/src/index_lite.js
init_esbuild_shims();

// packages/core/node_modules/mime/dist/types/standard.js
init_esbuild_shims();
var types = {
  "application/andrew-inset": ["ez"],
  "application/appinstaller": ["appinstaller"],
  "application/applixware": ["aw"],
  "application/appx": ["appx"],
  "application/appxbundle": ["appxbundle"],
  "application/atom+xml": ["atom"],
  "application/atomcat+xml": ["atomcat"],
  "application/atomdeleted+xml": ["atomdeleted"],
  "application/atomsvc+xml": ["atomsvc"],
  "application/atsc-dwd+xml": ["dwd"],
  "application/atsc-held+xml": ["held"],
  "application/atsc-rsat+xml": ["rsat"],
  "application/automationml-aml+xml": ["aml"],
  "application/automationml-amlx+zip": ["amlx"],
  "application/bdoc": ["bdoc"],
  "application/calendar+xml": ["xcs"],
  "application/ccxml+xml": ["ccxml"],
  "application/cdfx+xml": ["cdfx"],
  "application/cdmi-capability": ["cdmia"],
  "application/cdmi-container": ["cdmic"],
  "application/cdmi-domain": ["cdmid"],
  "application/cdmi-object": ["cdmio"],
  "application/cdmi-queue": ["cdmiq"],
  "application/cpl+xml": ["cpl"],
  "application/cu-seeme": ["cu"],
  "application/cwl": ["cwl"],
  "application/dash+xml": ["mpd"],
  "application/dash-patch+xml": ["mpp"],
  "application/davmount+xml": ["davmount"],
  "application/dicom": ["dcm"],
  "application/docbook+xml": ["dbk"],
  "application/dssc+der": ["dssc"],
  "application/dssc+xml": ["xdssc"],
  "application/ecmascript": ["ecma"],
  "application/emma+xml": ["emma"],
  "application/emotionml+xml": ["emotionml"],
  "application/epub+zip": ["epub"],
  "application/exi": ["exi"],
  "application/express": ["exp"],
  "application/fdf": ["fdf"],
  "application/fdt+xml": ["fdt"],
  "application/font-tdpfr": ["pfr"],
  "application/geo+json": ["geojson"],
  "application/gml+xml": ["gml"],
  "application/gpx+xml": ["gpx"],
  "application/gxf": ["gxf"],
  "application/gzip": ["gz"],
  "application/hjson": ["hjson"],
  "application/hyperstudio": ["stk"],
  "application/inkml+xml": ["ink", "inkml"],
  "application/ipfix": ["ipfix"],
  "application/its+xml": ["its"],
  "application/java-archive": ["jar", "war", "ear"],
  "application/java-serialized-object": ["ser"],
  "application/java-vm": ["class"],
  "application/javascript": ["*js"],
  "application/json": ["json", "map"],
  "application/json5": ["json5"],
  "application/jsonml+json": ["jsonml"],
  "application/ld+json": ["jsonld"],
  "application/lgr+xml": ["lgr"],
  "application/lost+xml": ["lostxml"],
  "application/mac-binhex40": ["hqx"],
  "application/mac-compactpro": ["cpt"],
  "application/mads+xml": ["mads"],
  "application/manifest+json": ["webmanifest"],
  "application/marc": ["mrc"],
  "application/marcxml+xml": ["mrcx"],
  "application/mathematica": ["ma", "nb", "mb"],
  "application/mathml+xml": ["mathml"],
  "application/mbox": ["mbox"],
  "application/media-policy-dataset+xml": ["mpf"],
  "application/mediaservercontrol+xml": ["mscml"],
  "application/metalink+xml": ["metalink"],
  "application/metalink4+xml": ["meta4"],
  "application/mets+xml": ["mets"],
  "application/mmt-aei+xml": ["maei"],
  "application/mmt-usd+xml": ["musd"],
  "application/mods+xml": ["mods"],
  "application/mp21": ["m21", "mp21"],
  "application/mp4": ["*mp4", "*mpg4", "mp4s", "m4p"],
  "application/msix": ["msix"],
  "application/msixbundle": ["msixbundle"],
  "application/msword": ["doc", "dot"],
  "application/mxf": ["mxf"],
  "application/n-quads": ["nq"],
  "application/n-triples": ["nt"],
  "application/node": ["cjs"],
  "application/octet-stream": [
    "bin",
    "dms",
    "lrf",
    "mar",
    "so",
    "dist",
    "distz",
    "pkg",
    "bpk",
    "dump",
    "elc",
    "deploy",
    "exe",
    "dll",
    "deb",
    "dmg",
    "iso",
    "img",
    "msi",
    "msp",
    "msm",
    "buffer"
  ],
  "application/oda": ["oda"],
  "application/oebps-package+xml": ["opf"],
  "application/ogg": ["ogx"],
  "application/omdoc+xml": ["omdoc"],
  "application/onenote": [
    "onetoc",
    "onetoc2",
    "onetmp",
    "onepkg",
    "one",
    "onea"
  ],
  "application/oxps": ["oxps"],
  "application/p2p-overlay+xml": ["relo"],
  "application/patch-ops-error+xml": ["xer"],
  "application/pdf": ["pdf"],
  "application/pgp-encrypted": ["pgp"],
  "application/pgp-keys": ["asc"],
  "application/pgp-signature": ["sig", "*asc"],
  "application/pics-rules": ["prf"],
  "application/pkcs10": ["p10"],
  "application/pkcs7-mime": ["p7m", "p7c"],
  "application/pkcs7-signature": ["p7s"],
  "application/pkcs8": ["p8"],
  "application/pkix-attr-cert": ["ac"],
  "application/pkix-cert": ["cer"],
  "application/pkix-crl": ["crl"],
  "application/pkix-pkipath": ["pkipath"],
  "application/pkixcmp": ["pki"],
  "application/pls+xml": ["pls"],
  "application/postscript": ["ai", "eps", "ps"],
  "application/provenance+xml": ["provx"],
  "application/pskc+xml": ["pskcxml"],
  "application/raml+yaml": ["raml"],
  "application/rdf+xml": ["rdf", "owl"],
  "application/reginfo+xml": ["rif"],
  "application/relax-ng-compact-syntax": ["rnc"],
  "application/resource-lists+xml": ["rl"],
  "application/resource-lists-diff+xml": ["rld"],
  "application/rls-services+xml": ["rs"],
  "application/route-apd+xml": ["rapd"],
  "application/route-s-tsid+xml": ["sls"],
  "application/route-usd+xml": ["rusd"],
  "application/rpki-ghostbusters": ["gbr"],
  "application/rpki-manifest": ["mft"],
  "application/rpki-roa": ["roa"],
  "application/rsd+xml": ["rsd"],
  "application/rss+xml": ["rss"],
  "application/rtf": ["rtf"],
  "application/sbml+xml": ["sbml"],
  "application/scvp-cv-request": ["scq"],
  "application/scvp-cv-response": ["scs"],
  "application/scvp-vp-request": ["spq"],
  "application/scvp-vp-response": ["spp"],
  "application/sdp": ["sdp"],
  "application/senml+xml": ["senmlx"],
  "application/sensml+xml": ["sensmlx"],
  "application/set-payment-initiation": ["setpay"],
  "application/set-registration-initiation": ["setreg"],
  "application/shf+xml": ["shf"],
  "application/sieve": ["siv", "sieve"],
  "application/smil+xml": ["smi", "smil"],
  "application/sparql-query": ["rq"],
  "application/sparql-results+xml": ["srx"],
  "application/sql": ["sql"],
  "application/srgs": ["gram"],
  "application/srgs+xml": ["grxml"],
  "application/sru+xml": ["sru"],
  "application/ssdl+xml": ["ssdl"],
  "application/ssml+xml": ["ssml"],
  "application/swid+xml": ["swidtag"],
  "application/tei+xml": ["tei", "teicorpus"],
  "application/thraud+xml": ["tfi"],
  "application/timestamped-data": ["tsd"],
  "application/toml": ["toml"],
  "application/trig": ["trig"],
  "application/ttml+xml": ["ttml"],
  "application/ubjson": ["ubj"],
  "application/urc-ressheet+xml": ["rsheet"],
  "application/urc-targetdesc+xml": ["td"],
  "application/voicexml+xml": ["vxml"],
  "application/wasm": ["wasm"],
  "application/watcherinfo+xml": ["wif"],
  "application/widget": ["wgt"],
  "application/winhlp": ["hlp"],
  "application/wsdl+xml": ["wsdl"],
  "application/wspolicy+xml": ["wspolicy"],
  "application/xaml+xml": ["xaml"],
  "application/xcap-att+xml": ["xav"],
  "application/xcap-caps+xml": ["xca"],
  "application/xcap-diff+xml": ["xdf"],
  "application/xcap-el+xml": ["xel"],
  "application/xcap-ns+xml": ["xns"],
  "application/xenc+xml": ["xenc"],
  "application/xfdf": ["xfdf"],
  "application/xhtml+xml": ["xhtml", "xht"],
  "application/xliff+xml": ["xlf"],
  "application/xml": ["xml", "xsl", "xsd", "rng"],
  "application/xml-dtd": ["dtd"],
  "application/xop+xml": ["xop"],
  "application/xproc+xml": ["xpl"],
  "application/xslt+xml": ["*xsl", "xslt"],
  "application/xspf+xml": ["xspf"],
  "application/xv+xml": ["mxml", "xhvml", "xvml", "xvm"],
  "application/yang": ["yang"],
  "application/yin+xml": ["yin"],
  "application/zip": ["zip"],
  "application/zip+dotlottie": ["lottie"],
  "audio/3gpp": ["*3gpp"],
  "audio/aac": ["adts", "aac"],
  "audio/adpcm": ["adp"],
  "audio/amr": ["amr"],
  "audio/basic": ["au", "snd"],
  "audio/midi": ["mid", "midi", "kar", "rmi"],
  "audio/mobile-xmf": ["mxmf"],
  "audio/mp3": ["*mp3"],
  "audio/mp4": ["m4a", "mp4a", "m4b"],
  "audio/mpeg": ["mpga", "mp2", "mp2a", "mp3", "m2a", "m3a"],
  "audio/ogg": ["oga", "ogg", "spx", "opus"],
  "audio/s3m": ["s3m"],
  "audio/silk": ["sil"],
  "audio/wav": ["wav"],
  "audio/wave": ["*wav"],
  "audio/webm": ["weba"],
  "audio/xm": ["xm"],
  "font/collection": ["ttc"],
  "font/otf": ["otf"],
  "font/ttf": ["ttf"],
  "font/woff": ["woff"],
  "font/woff2": ["woff2"],
  "image/aces": ["exr"],
  "image/apng": ["apng"],
  "image/avci": ["avci"],
  "image/avcs": ["avcs"],
  "image/avif": ["avif"],
  "image/bmp": ["bmp", "dib"],
  "image/cgm": ["cgm"],
  "image/dicom-rle": ["drle"],
  "image/dpx": ["dpx"],
  "image/emf": ["emf"],
  "image/fits": ["fits"],
  "image/g3fax": ["g3"],
  "image/gif": ["gif"],
  "image/heic": ["heic"],
  "image/heic-sequence": ["heics"],
  "image/heif": ["heif"],
  "image/heif-sequence": ["heifs"],
  "image/hej2k": ["hej2"],
  "image/ief": ["ief"],
  "image/jaii": ["jaii"],
  "image/jais": ["jais"],
  "image/jls": ["jls"],
  "image/jp2": ["jp2", "jpg2"],
  "image/jpeg": ["jpg", "jpeg", "jpe"],
  "image/jph": ["jph"],
  "image/jphc": ["jhc"],
  "image/jpm": ["jpm", "jpgm"],
  "image/jpx": ["jpx", "jpf"],
  "image/jxl": ["jxl"],
  "image/jxr": ["jxr"],
  "image/jxra": ["jxra"],
  "image/jxrs": ["jxrs"],
  "image/jxs": ["jxs"],
  "image/jxsc": ["jxsc"],
  "image/jxsi": ["jxsi"],
  "image/jxss": ["jxss"],
  "image/ktx": ["ktx"],
  "image/ktx2": ["ktx2"],
  "image/pjpeg": ["jfif"],
  "image/png": ["png"],
  "image/sgi": ["sgi"],
  "image/svg+xml": ["svg", "svgz"],
  "image/t38": ["t38"],
  "image/tiff": ["tif", "tiff"],
  "image/tiff-fx": ["tfx"],
  "image/webp": ["webp"],
  "image/wmf": ["wmf"],
  "message/disposition-notification": ["disposition-notification"],
  "message/global": ["u8msg"],
  "message/global-delivery-status": ["u8dsn"],
  "message/global-disposition-notification": ["u8mdn"],
  "message/global-headers": ["u8hdr"],
  "message/rfc822": ["eml", "mime", "mht", "mhtml"],
  "model/3mf": ["3mf"],
  "model/gltf+json": ["gltf"],
  "model/gltf-binary": ["glb"],
  "model/iges": ["igs", "iges"],
  "model/jt": ["jt"],
  "model/mesh": ["msh", "mesh", "silo"],
  "model/mtl": ["mtl"],
  "model/obj": ["obj"],
  "model/prc": ["prc"],
  "model/step": ["step", "stp", "stpnc", "p21", "210"],
  "model/step+xml": ["stpx"],
  "model/step+zip": ["stpz"],
  "model/step-xml+zip": ["stpxz"],
  "model/stl": ["stl"],
  "model/u3d": ["u3d"],
  "model/vrml": ["wrl", "vrml"],
  "model/x3d+binary": ["*x3db", "x3dbz"],
  "model/x3d+fastinfoset": ["x3db"],
  "model/x3d+vrml": ["*x3dv", "x3dvz"],
  "model/x3d+xml": ["x3d", "x3dz"],
  "model/x3d-vrml": ["x3dv"],
  "text/cache-manifest": ["appcache", "manifest"],
  "text/calendar": ["ics", "ifb"],
  "text/coffeescript": ["coffee", "litcoffee"],
  "text/css": ["css"],
  "text/csv": ["csv"],
  "text/html": ["html", "htm", "shtml"],
  "text/jade": ["jade"],
  "text/javascript": ["js", "mjs"],
  "text/jsx": ["jsx"],
  "text/less": ["less"],
  "text/markdown": ["md", "markdown"],
  "text/mathml": ["mml"],
  "text/mdx": ["mdx"],
  "text/n3": ["n3"],
  "text/plain": ["txt", "text", "conf", "def", "list", "log", "in", "ini"],
  "text/richtext": ["rtx"],
  "text/rtf": ["*rtf"],
  "text/sgml": ["sgml", "sgm"],
  "text/shex": ["shex"],
  "text/slim": ["slim", "slm"],
  "text/spdx": ["spdx"],
  "text/stylus": ["stylus", "styl"],
  "text/tab-separated-values": ["tsv"],
  "text/troff": ["t", "tr", "roff", "man", "me", "ms"],
  "text/turtle": ["ttl"],
  "text/uri-list": ["uri", "uris", "urls"],
  "text/vcard": ["vcard"],
  "text/vtt": ["vtt"],
  "text/wgsl": ["wgsl"],
  "text/xml": ["*xml"],
  "text/yaml": ["yaml", "yml"],
  "video/3gpp": ["3gp", "3gpp"],
  "video/3gpp2": ["3g2"],
  "video/h261": ["h261"],
  "video/h263": ["h263"],
  "video/h264": ["h264"],
  "video/iso.segment": ["m4s"],
  "video/jpeg": ["jpgv"],
  "video/jpm": ["*jpm", "*jpgm"],
  "video/mj2": ["mj2", "mjp2"],
  "video/mp2t": ["ts", "m2t", "m2ts", "mts"],
  "video/mp4": ["mp4", "mp4v", "mpg4"],
  "video/mpeg": ["mpeg", "mpg", "mpe", "m1v", "m2v"],
  "video/ogg": ["ogv"],
  "video/quicktime": ["qt", "mov"],
  "video/webm": ["webm"]
};
Object.freeze(types);
var standard_default = types;

// packages/core/node_modules/mime/dist/src/Mime.js
init_esbuild_shims();
var __classPrivateFieldGet = function(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _Mime_extensionToType;
var _Mime_typeToExtension;
var _Mime_typeToExtensions;
var Mime = class {
  static {
    __name(this, "Mime");
  }
  constructor(...args) {
    _Mime_extensionToType.set(this, /* @__PURE__ */ new Map());
    _Mime_typeToExtension.set(this, /* @__PURE__ */ new Map());
    _Mime_typeToExtensions.set(this, /* @__PURE__ */ new Map());
    for (const arg of args) {
      this.define(arg);
    }
  }
  define(typeMap, force = false) {
    for (let [type, extensions] of Object.entries(typeMap)) {
      type = type.toLowerCase();
      extensions = extensions.map((ext) => ext.toLowerCase());
      if (!__classPrivateFieldGet(this, _Mime_typeToExtensions, "f").has(type)) {
        __classPrivateFieldGet(this, _Mime_typeToExtensions, "f").set(type, /* @__PURE__ */ new Set());
      }
      const allExtensions = __classPrivateFieldGet(this, _Mime_typeToExtensions, "f").get(type);
      let first = true;
      for (let extension of extensions) {
        const starred = extension.startsWith("*");
        extension = starred ? extension.slice(1) : extension;
        allExtensions?.add(extension);
        if (first) {
          __classPrivateFieldGet(this, _Mime_typeToExtension, "f").set(type, extension);
        }
        first = false;
        if (starred)
          continue;
        const currentType = __classPrivateFieldGet(this, _Mime_extensionToType, "f").get(extension);
        if (currentType && currentType != type && !force) {
          throw new Error(`"${type} -> ${extension}" conflicts with "${currentType} -> ${extension}". Pass \`force=true\` to override this definition.`);
        }
        __classPrivateFieldGet(this, _Mime_extensionToType, "f").set(extension, type);
      }
    }
    return this;
  }
  getType(path4) {
    if (typeof path4 !== "string")
      return null;
    const last = path4.replace(/^.*[/\\]/s, "").toLowerCase();
    const ext = last.replace(/^.*\./s, "").toLowerCase();
    const hasPath = last.length < path4.length;
    const hasDot = ext.length < last.length - 1;
    if (!hasDot && hasPath)
      return null;
    return __classPrivateFieldGet(this, _Mime_extensionToType, "f").get(ext) ?? null;
  }
  getExtension(type) {
    if (typeof type !== "string")
      return null;
    type = type?.split?.(";")[0];
    return (type && __classPrivateFieldGet(this, _Mime_typeToExtension, "f").get(type.trim().toLowerCase())) ?? null;
  }
  getAllExtensions(type) {
    if (typeof type !== "string")
      return null;
    return __classPrivateFieldGet(this, _Mime_typeToExtensions, "f").get(type.toLowerCase()) ?? null;
  }
  _freeze() {
    this.define = () => {
      throw new Error("define() not allowed for built-in Mime objects. See https://github.com/broofa/mime/blob/main/README.md#custom-mime-instances");
    };
    Object.freeze(this);
    for (const extensions of __classPrivateFieldGet(this, _Mime_typeToExtensions, "f").values()) {
      Object.freeze(extensions);
    }
    return this;
  }
  _getTestState() {
    return {
      types: __classPrivateFieldGet(this, _Mime_extensionToType, "f"),
      extensions: __classPrivateFieldGet(this, _Mime_typeToExtension, "f")
    };
  }
};
_Mime_extensionToType = /* @__PURE__ */ new WeakMap(), _Mime_typeToExtension = /* @__PURE__ */ new WeakMap(), _Mime_typeToExtensions = /* @__PURE__ */ new WeakMap();
var Mime_default = Mime;

// packages/core/node_modules/mime/dist/src/index_lite.js
var index_lite_default = new Mime_default(standard_default)._freeze();

// packages/core/src/utils/encoding.ts
init_esbuild_shims();
function isUtf8CompatibleEncoding(encoding) {
  const lower = encoding.toLowerCase().replace(/[^a-z0-9]/g, "");
  return lower === "utf8" || lower === "ascii" || lower === "usascii";
}
__name(isUtf8CompatibleEncoding, "isUtf8CompatibleEncoding");

// packages/core/src/utils/load-iconv-lite.ts
init_esbuild_shims();
var iconvLiteModulePromise;
function isIconvLite(candidate) {
  return "decode" in candidate && typeof candidate.decode === "function" && "encode" in candidate && typeof candidate.encode === "function" && "encodingExists" in candidate && typeof candidate.encodingExists === "function";
}
__name(isIconvLite, "isIconvLite");
function loadIconvLite() {
  iconvLiteModulePromise ??= import("./lib-RUF3WZA6.js").then((module) => {
    const imported = module;
    const candidate = "default" in imported && imported.default ? imported.default : imported;
    if (!isIconvLite(candidate)) {
      throw new Error("iconv-lite module does not match the expected API");
    }
    return candidate;
  });
  return iconvLiteModulePromise;
}
__name(loadIconvLite, "loadIconvLite");

// packages/core/src/utils/ignorePatterns.ts
init_esbuild_shims();
import path2 from "node:path";
var COMMON_IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/bower_components/**",
  "**/.svn/**",
  "**/.hg/**"
];
var BINARY_FILE_PATTERNS = [
  "**/*.bin",
  "**/*.exe",
  "**/*.dll",
  "**/*.so",
  "**/*.dylib",
  "**/*.class",
  "**/*.jar",
  "**/*.war",
  "**/*.zip",
  "**/*.tar",
  "**/*.gz",
  "**/*.bz2",
  "**/*.rar",
  "**/*.7z",
  "**/*.doc",
  "**/*.docx",
  "**/*.xls",
  "**/*.xlsx",
  "**/*.ppt",
  "**/*.pptx",
  "**/*.odt",
  "**/*.ods",
  "**/*.odp"
];
var MEDIA_FILE_PATTERNS = [
  "**/*.pdf",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.webp",
  "**/*.bmp",
  "**/*.svg"
];
var COMMON_DIRECTORY_EXCLUDES = [
  "**/.vscode/**",
  "**/.idea/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/__pycache__/**"
];
var PYTHON_EXCLUDES = ["**/*.pyc", "**/*.pyo"];
var SYSTEM_FILE_EXCLUDES = ["**/.DS_Store", "**/.env"];
var DEFAULT_FILE_EXCLUDES = [
  ...COMMON_IGNORE_PATTERNS,
  ...COMMON_DIRECTORY_EXCLUDES,
  ...BINARY_FILE_PATTERNS,
  ...PYTHON_EXCLUDES,
  ...SYSTEM_FILE_EXCLUDES
];
var FileExclusions = class {
  constructor(config) {
    this.config = config;
  }
  static {
    __name(this, "FileExclusions");
  }
  /**
   * Gets core ignore patterns for basic file operations like glob.
   * These are the minimal essential patterns that should almost always be excluded.
   */
  getCoreIgnorePatterns() {
    return [...COMMON_IGNORE_PATTERNS];
  }
  /**
   * Gets comprehensive default exclusion patterns for operations like read-many-files.
   * Includes all standard exclusions: directories, binary files, system files, etc.
   */
  getDefaultExcludePatterns(options = {}) {
    const {
      includeDefaults = true,
      customPatterns = [],
      runtimePatterns = [],
      includeDynamicPatterns = true
    } = options;
    const patterns = [];
    if (includeDefaults) {
      patterns.push(...DEFAULT_FILE_EXCLUDES);
    }
    if (includeDynamicPatterns) {
      for (const filename of getAllMemoryFilenames()) {
        patterns.push(`**/${filename}`);
      }
    }
    if (this.config) {
      const configCustomExcludes = this.config.getCustomExcludes?.() ?? [];
      patterns.push(...configCustomExcludes);
    }
    patterns.push(...customPatterns);
    patterns.push(...runtimePatterns);
    return patterns;
  }
  /**
   * Gets exclude patterns for read-many-files tool with legacy compatibility.
   * This maintains the same behavior as the previous getDefaultExcludes() function.
   */
  getReadManyFilesExcludes(additionalExcludes = []) {
    return this.getDefaultExcludePatterns({
      includeDefaults: true,
      runtimePatterns: additionalExcludes,
      includeDynamicPatterns: true
    });
  }
  /**
   * Gets exclude patterns for glob tool operations.
   * Uses core patterns by default but can be extended with additional patterns.
   */
  getGlobExcludes(additionalExcludes = []) {
    const corePatterns = this.getCoreIgnorePatterns();
    const configPatterns = this.config?.getCustomExcludes?.() ?? [];
    return [...corePatterns, ...configPatterns, ...additionalExcludes];
  }
  /**
   * Builds exclude patterns with full customization options.
   * This is the most flexible method for advanced use cases.
   */
  buildExcludePatterns(options) {
    return this.getDefaultExcludePatterns(options);
  }
};
function extractExtensionsFromPatterns(patterns) {
  const extensions = new Set(
    patterns.filter((pattern) => pattern.includes("*.")).flatMap((pattern) => {
      const extPart = pattern.substring(pattern.lastIndexOf("*.") + 1);
      if (extPart.startsWith(".{") && extPart.endsWith("}")) {
        const inner = extPart.slice(2, -1);
        return inner.split(",").map((ext) => `.${ext.trim()}`).filter((ext) => ext !== ".");
      }
      if (extPart.startsWith(".") && !extPart.includes("/") && !extPart.includes("{") && !extPart.includes("}")) {
        const extracted = path2.extname(`dummy${extPart}`);
        const result = extracted || extPart;
        return result && result !== "." && !result.substring(1).includes(".") ? [result] : [];
      }
      return [];
    })
  );
  return Array.from(extensions).sort();
}
__name(extractExtensionsFromPatterns, "extractExtensionsFromPatterns");
var BINARY_EXTENSIONS = [
  ...extractExtensionsFromPatterns([
    ...BINARY_FILE_PATTERNS,
    ...MEDIA_FILE_PATTERNS,
    ...PYTHON_EXCLUDES
  ]),
  // Additional binary extensions not in the main patterns
  ".obj",
  ".o",
  ".a",
  ".lib",
  ".wasm"
].sort();

// packages/core/src/utils/systemEncoding.ts
init_esbuild_shims();
var import_chardet = __toESM(require_lib(), 1);
import { isUtf8 } from "node:buffer";
import { execSync } from "node:child_process";
import os from "node:os";
var debugLogger = createDebugLogger("ENCODING");
var cachedSystemEncoding = void 0;
function getCachedEncodingForBuffer(buffer) {
  if (isUtf8(buffer)) {
    return "utf-8";
  }
  const detected = detectEncodingFromBuffer(buffer);
  if (detected) {
    return detected;
  }
  if (cachedSystemEncoding === void 0) {
    cachedSystemEncoding = getSystemEncoding();
  }
  if (cachedSystemEncoding) {
    return cachedSystemEncoding;
  }
  return "utf-8";
}
__name(getCachedEncodingForBuffer, "getCachedEncodingForBuffer");
function getSystemEncoding() {
  if (os.platform() === "win32") {
    try {
      const output = execSync("chcp", { encoding: "utf8" });
      const match2 = output.match(/:\s*(\d+)/);
      if (match2) {
        const codePage = parseInt(match2[1], 10);
        if (!isNaN(codePage)) {
          return windowsCodePageToEncoding(codePage);
        }
      }
      throw new Error(
        `Unable to parse Windows code page from 'chcp' output "${output.trim()}". `
      );
    } catch (error) {
      debugLogger.warn(
        `Failed to get Windows code page using 'chcp' command: ${error instanceof Error ? error.message : String(error)}. Will attempt to detect encoding from command output instead.`
      );
    }
    return null;
  }
  const env = process.env;
  let locale = env["LC_ALL"] || env["LC_CTYPE"] || env["LANG"] || "";
  if (!locale) {
    try {
      locale = execSync("locale charmap", { encoding: "utf8" }).toString().trim();
    } catch (_e) {
      debugLogger.warn("Failed to get locale charmap.");
      return null;
    }
  }
  const match = locale.match(/\.(.+)/);
  if (match && match[1]) {
    return match[1].toLowerCase();
  }
  if (locale && !locale.includes(".")) {
    return locale.toLowerCase();
  }
  return null;
}
__name(getSystemEncoding, "getSystemEncoding");
function windowsCodePageToEncoding(cp) {
  const map = {
    437: "cp437",
    850: "cp850",
    852: "cp852",
    866: "cp866",
    874: "windows-874",
    932: "shift_jis",
    936: "gbk",
    949: "euc-kr",
    950: "big5",
    1200: "utf-16le",
    1201: "utf-16be",
    1250: "windows-1250",
    1251: "windows-1251",
    1252: "windows-1252",
    1253: "windows-1253",
    1254: "windows-1254",
    1255: "windows-1255",
    1256: "windows-1256",
    1257: "windows-1257",
    1258: "windows-1258",
    65001: "utf-8"
  };
  if (map[cp]) {
    return map[cp];
  }
  debugLogger.warn(`Unable to determine encoding for windows code page ${cp}.`);
  return null;
}
__name(windowsCodePageToEncoding, "windowsCodePageToEncoding");
function detectEncodingFromBuffer(buffer) {
  try {
    const detected = (0, import_chardet.detect)(buffer);
    if (detected && typeof detected === "string") {
      return detected.toLowerCase();
    }
  } catch (error) {
    debugLogger.warn("Failed to detect encoding with chardet:", error);
  }
  return null;
}
__name(detectEncodingFromBuffer, "detectEncodingFromBuffer");

// packages/core/src/utils/vision-bridge-constants.ts
init_esbuild_shims();
var VISION_BRIDGE_MAX_IMAGES = 4;
var VISION_BRIDGE_MAX_IMAGE_BASE64_BYTES = Math.floor(
  9.9 * 1024 * 1024
);

// packages/core/src/utils/read-text-range.ts
init_esbuild_shims();
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { TextDecoder as TextDecoder2 } from "node:util";

// packages/core/src/utils/text-range-constants.ts
init_esbuild_shims();
var TEXT_RANGE_FAST_PATH_MAX_SIZE = 10 * 1024 * 1024;
var DEFAULT_RANGE_READ_BYTES = 25e3;

// packages/core/src/utils/read-text-range.ts
var CursorNotAtLineBoundaryError = class extends Error {
  constructor(startOffset, maxSnapBytes) {
    super(
      `Byte offset ${startOffset} is not the start of a line, and no line break was found within ${maxSnapBytes} bytes after it. Resume from a cursor this reader returned.`
    );
    this.startOffset = startOffset;
    this.maxSnapBytes = maxSnapBytes;
    this.name = "CursorNotAtLineBoundaryError";
  }
  static {
    __name(this, "CursorNotAtLineBoundaryError");
  }
};
var LargeNonUtf8TextError = class extends Error {
  constructor(encoding, reason) {
    super(
      reason === "invalid-utf8" ? "Large text file contains invalid UTF-8 byte sequence beyond the initial encoding sample. Convert or extract a smaller UTF-8 slice and read that instead." : `Large non-UTF-8 text files are not supported for streaming reads (detected ${encoding}). Convert or extract a smaller UTF-8 slice and read that instead.`
    );
    this.encoding = encoding;
    this.reason = reason;
    this.name = "LargeNonUtf8TextError";
  }
  static {
    __name(this, "LargeNonUtf8TextError");
  }
};
var TextScanBudgetExceededError = class extends Error {
  constructor(scannedBytes, maxScanBytes) {
    super(
      `Locating the requested line window would read more than ${maxScanBytes} bytes (line offsets are resolved by scanning from the start of the file). Use a byte-offset read to reach this part of the file.`
    );
    this.scannedBytes = scannedBytes;
    this.maxScanBytes = maxScanBytes;
    this.name = "TextScanBudgetExceededError";
  }
  static {
    __name(this, "TextScanBudgetExceededError");
  }
};
async function readTextRange(request) {
  request.signal?.throwIfAborted();
  const stats = request.stats ?? await stat(request.path);
  const maxOutputBytes = normalizeMaxBytes(request.maxOutputBytes);
  const maxScanBytes = request.maxScanBytes ?? Number.POSITIVE_INFINITY;
  if (stats.size < TEXT_RANGE_FAST_PATH_MAX_SIZE && stats.size <= maxScanBytes) {
    const { content, encoding, bom } = await readFileWithEncodingInfo(
      request.path,
      request.signal
    );
    request.signal?.throwIfAborted();
    const range = sliceDecodedContent(
      content,
      request.offset,
      request.limit,
      maxOutputBytes
    );
    return {
      ...range,
      encoding,
      bom,
      lineEnding: detectLineEndingFromContent(content)
    };
  }
  return readLargeUtf8Range(
    request.path,
    request,
    maxOutputBytes,
    maxScanBytes,
    stats.size
  );
}
__name(readTextRange, "readTextRange");
async function readTextRangeFromHandle(fileHandle, request) {
  request.signal?.throwIfAborted();
  return readLargeUtf8Range(
    fileHandle,
    request,
    normalizeMaxBytes(request.maxOutputBytes),
    request.maxScanBytes,
    request.fileSize
  );
}
__name(readTextRangeFromHandle, "readTextRangeFromHandle");
async function readTextCursorWindowFromHandle(fileHandle, request) {
  request.signal?.throwIfAborted();
  const encoding = await detectFileEncoding(fileHandle);
  request.signal?.throwIfAborted();
  if (!isUtf8CompatibleEncoding(encoding)) {
    throw new LargeNonUtf8TextError(encoding);
  }
  const bom = await hasUtf8Bom(fileHandle, request.fileSize);
  const maxOutputBytes = normalizeMaxBytes(request.maxOutputBytes);
  const startOffset = await snapToLineStart(fileHandle, request);
  if (startOffset >= request.fileSize) {
    return {
      content: "",
      startOffset,
      encoding: "utf-8",
      bom,
      lineEnding: "lf",
      truncatedByBytes: false
    };
  }
  const decoder = new TextDecoder2("utf-8", { fatal: true, ignoreBOM: true });
  const decode = /* @__PURE__ */ __name((chunk, options) => {
    try {
      return decoder.decode(chunk, options);
    } catch {
      throw new LargeNonUtf8TextError(encoding, "invalid-utf8");
    }
  }, "decode");
  const lines = [];
  let contentBytes = 0;
  let consumedBytes = 0;
  let truncatedByBytes = false;
  let stop = false;
  let skipRestOfLine = false;
  let sawCrlf = await precededByCrlfTerminator(fileHandle, startOffset);
  const emit = /* @__PURE__ */ __name((line, hadNewline) => {
    const separator = lines.length > 0 ? 1 : 0;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (contentBytes + separator + lineBytes > maxOutputBytes) {
      if (lines.length > 0) {
        stop = true;
        return;
      }
      const cut = truncateUtf8(line, maxOutputBytes);
      lines.push(cut.content);
      if (hadNewline && line.endsWith("\r")) sawCrlf = true;
      contentBytes = Buffer.byteLength(cut.content, "utf8");
      consumedBytes += contentBytes;
      truncatedByBytes = true;
      skipRestOfLine = true;
      stop = true;
      return;
    }
    lines.push(line);
    if (hadNewline && line.endsWith("\r")) sawCrlf = true;
    contentBytes += separator + lineBytes;
    consumedBytes += lineBytes + (hadNewline ? 1 : 0);
    if (request.limit !== void 0 && lines.length >= request.limit) {
      stop = true;
    }
  }, "emit");
  let pending = "";
  let firstChunk = true;
  let reachedEof = true;
  for await (const raw of chunksFromHandle(
    fileHandle,
    startOffset,
    request.fileSize,
    request.signal
  )) {
    request.signal?.throwIfAborted();
    let text = decode(raw, { stream: true });
    if (firstChunk) {
      firstChunk = false;
      if (startOffset === 0 && text.charCodeAt(0) === 65279) {
        text = text.slice(1);
        consumedBytes += UTF8_BOM_BYTES;
      }
    }
    pending += text;
    let newline = pending.indexOf("\n");
    const pendingLine = newline === -1 ? pending : pending.slice(0, newline);
    const pendingSeparator = lines.length > 0 ? 1 : 0;
    if (contentBytes + pendingSeparator + Buffer.byteLength(pendingLine, "utf8") > maxOutputBytes) {
      if (lines.length === 0) {
        emit(pendingLine, newline !== -1);
      } else {
        stop = true;
      }
      reachedEof = false;
      break;
    }
    while (newline !== -1) {
      emit(pending.slice(0, newline), true);
      pending = pending.slice(newline + 1);
      if (stop) break;
      newline = pending.indexOf("\n");
    }
    if (stop) {
      reachedEof = false;
      break;
    }
  }
  if (reachedEof) {
    decode();
    if (!stop) emit(pending, false);
  }
  if (skipRestOfLine) {
    const resumeAt = await snapToLineStart(
      fileHandle,
      {
        ...request,
        startOffset: startOffset + Math.max(consumedBytes, 1),
        // This offset was produced internally after returning a truncated prefix,
        // so it must advance past the rest of that line. `maxSnapBytes` protects
        // only client-supplied offsets.
        maxSnapBytes: request.fileSize
      },
      true
    );
    consumedBytes = resumeAt - startOffset;
    if (!sawCrlf) {
      sawCrlf = await precededByCrlfTerminator(fileHandle, resumeAt);
    }
  }
  const content = lines.join("\n");
  const nextOffset = startOffset + consumedBytes;
  return {
    content,
    startOffset,
    ...nextOffset < request.fileSize ? { nextOffset } : {},
    encoding: "utf-8",
    bom,
    lineEnding: sawCrlf ? "crlf" : "lf",
    truncatedByBytes
  };
}
__name(readTextCursorWindowFromHandle, "readTextCursorWindowFromHandle");
var UTF8_BOM_BYTES = 3;
var LINE_FEED = 10;
var CARRIAGE_RETURN = 13;
async function precededByCrlfTerminator(fileHandle, startOffset) {
  if (startOffset < 2) return false;
  const probe = Buffer.alloc(2);
  const { bytesRead } = await fileHandle.read(probe, 0, 2, startOffset - 2);
  return bytesRead === 2 && probe[0] === CARRIAGE_RETURN && probe[1] === LINE_FEED;
}
__name(precededByCrlfTerminator, "precededByCrlfTerminator");
async function hasUtf8Bom(fileHandle, fileSize) {
  if (fileSize < UTF8_BOM_BYTES) return false;
  const probe = Buffer.alloc(UTF8_BOM_BYTES);
  const { bytesRead } = await fileHandle.read(probe, 0, UTF8_BOM_BYTES, 0);
  return bytesRead === UTF8_BOM_BYTES && probe[0] === 239 && probe[1] === 187 && probe[2] === 191;
}
__name(hasUtf8Bom, "hasUtf8Bom");
async function snapToLineStart(fileHandle, request, allowEof = false) {
  const { startOffset, fileSize, maxSnapBytes, signal } = request;
  if (startOffset <= 0) return 0;
  if (startOffset >= fileSize) return startOffset;
  const previous = Buffer.alloc(1);
  const { bytesRead } = await fileHandle.read(previous, 0, 1, startOffset - 1);
  if (bytesRead === 1 && previous[0] === LINE_FEED) return startOffset;
  let scanned = 0;
  const snapEnd = Math.min(fileSize, startOffset + maxSnapBytes);
  for await (const chunk of chunksFromHandle(
    fileHandle,
    startOffset,
    snapEnd,
    signal
  )) {
    const index = chunk.indexOf(LINE_FEED);
    if (index !== -1) return startOffset + scanned + index + 1;
    scanned += chunk.length;
  }
  if (allowEof) return fileSize;
  throw new CursorNotAtLineBoundaryError(startOffset, maxSnapBytes);
}
__name(snapToLineStart, "snapToLineStart");
function normalizeMaxBytes(maxOutputBytes) {
  if (maxOutputBytes === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }
  if (!Number.isFinite(maxOutputBytes)) {
    return DEFAULT_RANGE_READ_BYTES;
  }
  return Math.max(0, Math.floor(maxOutputBytes));
}
__name(normalizeMaxBytes, "normalizeMaxBytes");
function sliceDecodedContent(content, offset, limit, maxOutputBytes) {
  const lines = content.split("\n");
  const originalLineCount = lines.length;
  const start = Math.min(Math.max(0, offset ?? 0), originalLineCount);
  const end = limit === void 0 ? originalLineCount : Math.min(start + Math.max(0, limit), originalLineCount);
  const selected = lines.slice(start, end).join("\n");
  const truncated = truncateUtf8(selected, maxOutputBytes);
  return {
    content: truncated.content,
    originalLineCount,
    originalLineCountExact: true,
    truncatedByBytes: truncated.truncated
  };
}
__name(sliceDecodedContent, "sliceDecodedContent");
async function readLargeUtf8Range(source, request, maxOutputBytes, maxScanBytes, sourceSize) {
  const encoding = await detectFileEncoding(source);
  request.signal?.throwIfAborted();
  if (!isUtf8CompatibleEncoding(encoding)) {
    throw new LargeNonUtf8TextError(encoding);
  }
  const offset = Math.max(0, request.offset ?? 0);
  const endLine = offset + Math.max(0, request.limit ?? Number.POSITIVE_INFINITY);
  let currentLine = 0;
  let output = "";
  let outputBytes = 0;
  let truncatedByBytes = false;
  let bom = false;
  let firstChunk = true;
  let lineEnding = "lf";
  let previousChunkEndedWithCR = false;
  let originalLineCountExact = true;
  let stoppedEarly = false;
  let scannedBytes = 0;
  let consumedBytes = 0;
  const decoder = new TextDecoder2("utf-8", {
    fatal: true,
    ignoreBOM: true
  });
  let pathStream;
  let chunks;
  const sourceEnd = Math.min(
    sourceSize ?? Number.POSITIVE_INFINITY,
    maxScanBytes
  );
  if (sourceEnd <= 0 && (sourceSize ?? 0) > 0) {
    throw new TextScanBudgetExceededError(0, maxScanBytes);
  }
  if (typeof source === "string") {
    pathStream = createReadStream(source, {
      highWaterMark: 512 * 1024,
      signal: request.signal,
      ...Number.isFinite(sourceEnd) ? { end: Math.max(0, sourceEnd - 1) } : {}
    });
    chunks = pathStream;
  } else {
    chunks = chunksFromHandle(source, 0, sourceEnd, request.signal);
  }
  function appendSelected(fragment) {
    if (fragment.length === 0 || truncatedByBytes) {
      return;
    }
    const available = maxOutputBytes - outputBytes;
    if (available <= 0) {
      truncatedByBytes = true;
      return;
    }
    const truncated = truncateUtf8(fragment, available);
    output += truncated.content;
    outputBytes += Buffer.byteLength(truncated.content, "utf8");
    if (truncated.truncated) {
      truncatedByBytes = true;
    }
  }
  __name(appendSelected, "appendSelected");
  function isSelectedLine() {
    return currentLine >= offset && currentLine < endLine;
  }
  __name(isSelectedLine, "isSelectedLine");
  function decodeUtf8Chunk(chunk, options) {
    try {
      return decoder.decode(chunk, options);
    } catch {
      throw new LargeNonUtf8TextError(encoding, "invalid-utf8");
    }
  }
  __name(decodeUtf8Chunk, "decodeUtf8Chunk");
  try {
    for await (const rawChunk of chunks) {
      request.signal?.throwIfAborted();
      scannedBytes += rawChunk.length;
      let chunk = decodeUtf8Chunk(rawChunk, { stream: true });
      if (firstChunk) {
        firstChunk = false;
        if (chunk.charCodeAt(0) === 65279) {
          chunk = chunk.slice(1);
          bom = true;
          consumedBytes += 3;
        }
      }
      if (isSelectedLine() && previousChunkEndedWithCR && chunk.startsWith("\n")) {
        lineEnding = "crlf";
      }
      previousChunkEndedWithCR = chunk.endsWith("\r");
      let start = 0;
      let newline = chunk.indexOf("\n", start);
      while (newline !== -1) {
        if (isSelectedLine()) {
          const fragment = chunk.slice(start, newline);
          if (fragment.endsWith("\r")) lineEnding = "crlf";
          appendSelected(fragment);
          if (currentLine + 1 < endLine) {
            appendSelected("\n");
          }
        }
        consumedBytes += Buffer.byteLength(chunk.slice(start, newline), "utf8") + 1;
        currentLine++;
        start = newline + 1;
        if (currentLine >= endLine || truncatedByBytes) {
          originalLineCountExact = false;
          stoppedEarly = true;
          break;
        }
        newline = chunk.indexOf("\n", start);
      }
      if (!stoppedEarly && start < chunk.length) {
        const tail = chunk.slice(start);
        if (isSelectedLine()) {
          appendSelected(tail);
        }
        consumedBytes += Buffer.byteLength(tail, "utf8");
      }
      if (currentLine >= endLine || truncatedByBytes) {
        originalLineCountExact = false;
        stoppedEarly = true;
        break;
      }
    }
  } finally {
    if (pathStream !== void 0 && !pathStream.destroyed) {
      pathStream.destroy();
    }
  }
  const budgetExhausted = !stoppedEarly && sourceSize !== void 0 && sourceSize > maxScanBytes && scannedBytes >= maxScanBytes;
  if (budgetExhausted) {
    throw new TextScanBudgetExceededError(scannedBytes, maxScanBytes);
  }
  if (!stoppedEarly) {
    decodeUtf8Chunk();
  }
  return {
    content: output,
    originalLineCount: currentLine + 1,
    ...stoppedEarly && !truncatedByBytes && consumedBytes < (sourceSize ?? Number.POSITIVE_INFINITY) ? { nextByteOffset: consumedBytes } : {},
    encoding: "utf-8",
    bom,
    lineEnding,
    originalLineCountExact,
    truncatedByBytes
  };
}
__name(readLargeUtf8Range, "readLargeUtf8Range");
async function* chunksFromHandle(fileHandle, from = 0, toExclusive = Number.POSITIVE_INFINITY, signal) {
  const highWaterMark = 512 * 1024;
  const buffer = Buffer.allocUnsafe(highWaterMark);
  let position = from;
  while (position < toExclusive) {
    signal?.throwIfAborted();
    const bytesToRead = Math.min(highWaterMark, toExclusive - position);
    const { bytesRead } = await fileHandle.read(
      buffer,
      0,
      bytesToRead,
      position
    );
    signal?.throwIfAborted();
    if (bytesRead === 0) return;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}
__name(chunksFromHandle, "chunksFromHandle");
function truncateUtf8(content, maxBytes) {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= maxBytes) {
    return { content, truncated: false };
  }
  if (maxBytes <= 0) {
    return { content: "", truncated: true };
  }
  const buffer = Buffer.from(content, "utf8");
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0 && (buffer[end] & 192) === 128) {
    end--;
  }
  return {
    content: buffer.subarray(0, end).toString("utf8"),
    truncated: true
  };
}
__name(truncateUtf8, "truncateUtf8");
function detectLineEndingFromContent(content) {
  return content.includes("\r\n") ? "crlf" : "lf";
}
__name(detectLineEndingFromContent, "detectLineEndingFromContent");

// packages/core/src/utils/request-tokenizer/supportedImageFormats.ts
init_esbuild_shims();
var SUPPORTED_IMAGE_MIME_TYPES = [
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/jpg",
  // Alternative MIME type for JPEG
  "image/png",
  "image/tiff",
  "image/webp",
  "image/heic"
];
var PIPELINE_IMAGE_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp"
];
function isSupportedImageMimeType(mimeType) {
  return SUPPORTED_IMAGE_MIME_TYPES.includes(
    mimeType
  );
}
__name(isSupportedImageMimeType, "isSupportedImageMimeType");
function getSupportedImageFormatsString() {
  return PIPELINE_IMAGE_MIME_TYPES.map(
    (type) => type.replace("image/", "").toUpperCase()
  ).join(", ");
}
__name(getSupportedImageFormatsString, "getSupportedImageFormatsString");
function getUnsupportedImageFormatWarning() {
  return `Only the following image formats are supported: ${getSupportedImageFormatsString()}. Other formats may not work as expected.`;
}
__name(getUnsupportedImageFormatWarning, "getUnsupportedImageFormatWarning");

// packages/core/src/utils/fileUtils.ts
var debugLogger2 = createDebugLogger("FILE_UTILS");
var CANONICAL_IMAGE_MIME_TYPES = /* @__PURE__ */ new Set([
  "image/jpeg",
  "image/png",
  "image/webp"
]);
var CANONICAL_IMAGE_EXTENSIONS = new Set(
  [...CANONICAL_IMAGE_MIME_TYPES].map(
    (mimeType) => extensionForMimeType(mimeType)
  )
);
var SNIFFABLE_IMAGE_MIME_TYPES = /* @__PURE__ */ new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);
var IMAGE_SNIFF_BYTES = 8192;
var PROVIDER_SAFE_IMAGE_MIME_TYPES = new Set(
  PIPELINE_IMAGE_MIME_TYPES
);
var PDF_FULL_TEXT_EXTRACTION_MAX_MB = 100;
var PDF_PAGED_TEXT_EXTRACTION_MAX_MB = 512;
function detectBOM(buf) {
  if (buf.length >= 4) {
    if (buf[0] === 255 && buf[1] === 254 && buf[2] === 0 && buf[3] === 0) {
      return { encoding: "utf32le", bomLength: 4 };
    }
    if (buf[0] === 0 && buf[1] === 0 && buf[2] === 254 && buf[3] === 255) {
      return { encoding: "utf32be", bomLength: 4 };
    }
  }
  if (buf.length >= 3) {
    if (buf[0] === 239 && buf[1] === 187 && buf[2] === 191) {
      return { encoding: "utf8", bomLength: 3 };
    }
  }
  if (buf.length >= 2) {
    if (buf[0] === 255 && buf[1] === 254 && (buf.length < 4 || buf[2] !== 0 || buf[3] !== 0)) {
      return { encoding: "utf16le", bomLength: 2 };
    }
    if (buf[0] === 254 && buf[1] === 255) {
      return { encoding: "utf16be", bomLength: 2 };
    }
  }
  return null;
}
__name(detectBOM, "detectBOM");
function decodeUTF16BE(buf) {
  if (buf.length === 0) return "";
  const swapped = Buffer.from(buf);
  swapped.swap16();
  return swapped.toString("utf16le");
}
__name(decodeUTF16BE, "decodeUTF16BE");
function decodeUTF32(buf, littleEndian) {
  if (buf.length < 4) return "";
  const usable = buf.length - buf.length % 4;
  let out = "";
  for (let i = 0; i < usable; i += 4) {
    const cp = littleEndian ? (buf[i] | buf[i + 1] << 8 | buf[i + 2] << 16 | buf[i + 3] << 24) >>> 0 : (buf[i + 3] | buf[i + 2] << 8 | buf[i + 1] << 16 | buf[i] << 24) >>> 0;
    if (cp <= 1114111 && !(cp >= 55296 && cp <= 57343)) {
      out += String.fromCodePoint(cp);
    } else {
      out += "\uFFFD";
    }
  }
  return out;
}
__name(decodeUTF32, "decodeUTF32");
function isValidUtf8(buffer) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}
__name(isValidUtf8, "isValidUtf8");
async function decodeBufferWithEncodingInfoAsync(full) {
  if (full.length === 0) {
    return { content: "", encoding: "utf-8", bom: false };
  }
  const bomInfo = detectBOM(full);
  if (bomInfo) {
    return {
      content: decodeBOMBuffer(full, bomInfo),
      encoding: bomEncodingToName(bomInfo.encoding),
      // Mark bom: true for all Unicode BOM variants (UTF-8/16/32) so that
      // the BOM is re-written on save and the file's original format is preserved.
      bom: true
    };
  }
  if (isValidUtf8(full)) {
    return { content: full.toString("utf8"), encoding: "utf-8", bom: false };
  }
  const detected = detectEncodingFromBuffer(full);
  if (detected && !isUtf8CompatibleEncoding(detected)) {
    try {
      const iconvLite = await loadIconvLite();
      if (iconvLite.encodingExists(detected)) {
        return {
          content: iconvLite.decode(full, detected),
          encoding: detected,
          bom: false
        };
      }
    } catch (e) {
      debugLogger2.warn(
        `Failed to decode buffer as ${detected}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  return { content: full.toString("utf8"), encoding: "utf-8", bom: false };
}
__name(decodeBufferWithEncodingInfoAsync, "decodeBufferWithEncodingInfoAsync");
function decodeBOMBuffer(buf, bomInfo) {
  const content = buf.subarray(bomInfo.bomLength);
  switch (bomInfo.encoding) {
    case "utf8":
      return content.toString("utf8");
    case "utf16le":
      return content.toString("utf16le");
    case "utf16be":
      return decodeUTF16BE(content);
    case "utf32le":
      return decodeUTF32(content, true);
    case "utf32be":
      return decodeUTF32(content, false);
    default:
      return content.toString("utf8");
  }
}
__name(decodeBOMBuffer, "decodeBOMBuffer");
function bomEncodingToName(bomEncoding) {
  switch (bomEncoding) {
    case "utf8":
      return "utf-8";
    case "utf16le":
      return "utf-16le";
    case "utf16be":
      return "utf-16be";
    case "utf32le":
      return "utf-32le";
    case "utf32be":
      return "utf-32be";
    default:
      return "utf-8";
  }
}
__name(bomEncodingToName, "bomEncodingToName");
async function readFileWithEncodingInfo(filePath, signal) {
  const full = await fs3.promises.readFile(
    filePath,
    signal === void 0 ? void 0 : { signal }
  );
  return await decodeBufferWithEncodingInfoAsync(full);
}
__name(readFileWithEncodingInfo, "readFileWithEncodingInfo");
async function readFileWithEncoding(filePath) {
  const result = await readFileWithEncodingInfo(filePath);
  return result.content;
}
__name(readFileWithEncoding, "readFileWithEncoding");
async function countFileLines(filePath) {
  const result = await readFileWithEncodingInfo(filePath);
  return result.content.split("\n").length;
}
__name(countFileLines, "countFileLines");
async function readFileWithLineAndLimit(params) {
  const { path: filePath, limit, line, maxOutputBytes, signal } = params;
  const stats = params.stats ?? await fs3.promises.stat(filePath);
  if (line !== void 0 && line > 0 || Number.isFinite(limit) || maxOutputBytes !== void 0) {
    return readTextRange({
      path: filePath,
      offset: line || 0,
      limit,
      maxOutputBytes: normalizeRangeReadByteLimit(maxOutputBytes),
      stats,
      ...signal !== void 0 ? { signal } : {}
    });
  }
  signal?.throwIfAborted();
  const { content, encoding, bom } = await readFileWithEncodingInfo(
    filePath,
    signal
  );
  signal?.throwIfAborted();
  const lines = content.split("\n");
  const originalLineCount = lines.length;
  const startLine = line || 0;
  const endLine = Math.min(startLine + limit, originalLineCount);
  const actualStartLine = Math.min(startLine, originalLineCount);
  const selectedLines = lines.slice(actualStartLine, endLine);
  const joined = selectedLines.join("\n");
  return {
    content: joined,
    bom,
    encoding,
    originalLineCount,
    originalLineCountExact: true,
    truncatedByBytes: false,
    lineEnding: detectLineEndingFromContent(joined)
  };
}
__name(readFileWithLineAndLimit, "readFileWithLineAndLimit");
async function detectFileEncoding(source) {
  let opened = null;
  try {
    const fh = typeof source === "string" ? opened = await fs3.promises.open(source, "r") : source;
    const stats = await fh.stat();
    if (stats.size === 0) return "utf-8";
    const sampleSize = Math.min(8192, stats.size);
    const buf = Buffer.alloc(sampleSize);
    const { bytesRead } = await fh.read(buf, 0, sampleSize, 0);
    if (bytesRead === 0) return "utf-8";
    const sample = buf.subarray(0, bytesRead);
    const bom = detectBOM(sample);
    if (bom) return bomEncodingToName(bom.encoding);
    if (isValidUtf8(sample)) return "utf-8";
    const detected = detectEncodingFromBuffer(sample);
    if (detected && !isUtf8CompatibleEncoding(detected)) {
      return detected;
    }
    return "utf-8";
  } catch {
    return "utf-8";
  } finally {
    if (opened) {
      try {
        await opened.close();
      } catch {
      }
    }
  }
}
__name(detectFileEncoding, "detectFileEncoding");
function getSpecificMimeType(filePath) {
  const lookedUpMime = index_lite_default.getType(filePath);
  return typeof lookedUpMime === "string" ? lookedUpMime : void 0;
}
__name(getSpecificMimeType, "getSpecificMimeType");
function isWithinRoot(pathToCheck, rootDirectory) {
  const normalizedPathToCheck = path3.resolve(pathToCheck);
  const normalizedRootDirectory = path3.resolve(rootDirectory);
  const rootWithSeparator = normalizedRootDirectory === path3.sep || normalizedRootDirectory.endsWith(path3.sep) ? normalizedRootDirectory : normalizedRootDirectory + path3.sep;
  return normalizedPathToCheck === normalizedRootDirectory || normalizedPathToCheck.startsWith(rootWithSeparator);
}
__name(isWithinRoot, "isWithinRoot");
async function isBinaryFile(filePath) {
  let fh = null;
  try {
    fh = await fs3.promises.open(filePath, "r");
    const stats = await fh.stat();
    const fileSize = stats.size;
    if (fileSize === 0) return false;
    const sampleSize = Math.min(4096, fileSize);
    const buf = Buffer.alloc(sampleSize);
    const { bytesRead } = await fh.read(buf, 0, sampleSize, 0);
    if (bytesRead === 0) return false;
    const bom = detectBOM(buf.subarray(0, Math.min(4, bytesRead)));
    if (bom) return false;
    let nonPrintableCount = 0;
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
      if (buf[i] < 9 || buf[i] > 13 && buf[i] < 32) {
        nonPrintableCount++;
      }
    }
    return nonPrintableCount / bytesRead > 0.3;
  } catch (error) {
    debugLogger2.warn(
      `Failed to check if file is binary: ${filePath}`,
      error instanceof Error ? error.message : String(error)
    );
    return false;
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch (closeError) {
        debugLogger2.warn(
          `Failed to close file handle for: ${filePath}`,
          closeError instanceof Error ? closeError.message : String(closeError)
        );
      }
    }
  }
}
__name(isBinaryFile, "isBinaryFile");
var KNOWN_TEXT_APPLICATION_MIMES = /* @__PURE__ */ new Set([
  "application/javascript",
  "application/ecmascript",
  "application/node",
  "application/json",
  "application/xml",
  "application/toml"
]);
var KNOWN_TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
  // C / C++
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".inl",
  ".tpp",
  // Python
  ".py",
  ".pyi",
  ".pyw",
  ".pyx",
  // Rust
  ".rs",
  // Go
  ".go",
  // JVM
  ".gradle",
  ".groovy",
  ".java",
  ".kt",
  ".kts",
  ".sc",
  ".scala",
  // .NET
  ".cs",
  ".fs",
  ".fsi",
  ".fsx",
  ".vb",
  // Apple platforms
  ".m",
  ".mm",
  ".swift",
  // Functional
  ".cljc",
  ".cljs",
  ".clj",
  ".edn",
  ".erl",
  ".ex",
  ".exs",
  ".hrl",
  ".hs",
  ".lhs",
  ".ml",
  ".mli",
  // Web frontend (`.tsx` is handled by the early-return at the top
  // of detectFileType alongside `.ts` / `.mts` / `.cts` to keep all
  // TypeScript-family extensions in one place).
  ".astro",
  ".jsx",
  ".svelte",
  ".vue",
  // Scripting
  ".bash",
  ".dart",
  ".fish",
  ".lua",
  ".php",
  ".pl",
  ".pm",
  ".ps1",
  ".r",
  ".rb",
  ".sh",
  ".zsh",
  // Newer / niche source languages
  ".cr",
  ".nim",
  ".sol",
  ".zig",
  // Schema / IDL / queries
  ".gql",
  ".graphql",
  ".proto",
  ".sql",
  ".thrift",
  // Markup / typesetting
  ".adoc",
  ".bib",
  ".org",
  ".rst",
  ".tex",
  // Config / build
  ".cfg",
  ".cmake",
  ".conf",
  ".containerfile",
  ".dockerfile",
  ".hcl",
  ".ini",
  ".mk",
  ".nomad",
  ".properties",
  ".tf",
  ".tfvars",
  ".toml"
]);
var KNOWN_TEXT_BASENAMES = /* @__PURE__ */ new Set([
  "Dockerfile",
  "Containerfile",
  "Makefile",
  "GNUmakefile",
  "Jenkinsfile",
  "Vagrantfile",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "BUILD",
  "WORKSPACE",
  "CMakeLists.txt",
  // also caught by .txt but pin explicitly
  "go.mod",
  "go.sum",
  "go.work",
  "Cargo.lock",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "requirements.txt",
  ".gitignore",
  ".gitattributes",
  ".dockerignore",
  ".npmignore",
  ".editorconfig",
  ".env",
  ".bashrc",
  ".zshrc",
  ".profile",
  "LICENSE",
  "COPYING",
  "AUTHORS",
  "CHANGELOG",
  "README",
  "NOTICE"
]);
function isTextMime(lookedUpMimeType) {
  if (lookedUpMimeType.startsWith("text/")) {
    return true;
  }
  if (lookedUpMimeType.endsWith("+xml") || lookedUpMimeType.endsWith("+json")) {
    return true;
  }
  return KNOWN_TEXT_APPLICATION_MIMES.has(lookedUpMimeType);
}
__name(isTextMime, "isTextMime");
var MIME_LITE_MISSING_MEDIA_TYPES = /* @__PURE__ */ new Map([
  [".m4v", "video/x-m4v"],
  [".mkv", "video/x-matroska"],
  [".avi", "video/x-msvideo"],
  [".flac", "audio/x-flac"],
  [".aac", "audio/x-aac"]
]);
async function classifyImageContent(filePath, mimeType) {
  if (!SNIFFABLE_IMAGE_MIME_TYPES.has(mimeType)) return "image";
  let handle;
  try {
    handle = await fs3.promises.open(
      filePath,
      (fs3.constants?.O_RDONLY ?? 0) | (fs3.constants?.O_NONBLOCK ?? 0)
    );
    if ((await handle.stat()).size > IMAGE_MAX_SOURCE_BYTES) return "image";
    const sample = Buffer.alloc(IMAGE_SNIFF_BYTES);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    const bytes = sample.subarray(0, bytesRead);
    if (bytes.length === 0) return "image";
    const sniffed = sniffFileKind(bytes, mimeType, "", `file://${filePath}`);
    let result;
    if (sniffed.magicMatched) {
      result = sniffed.extension === extensionForMimeType(mimeType) || CANONICAL_IMAGE_EXTENSIONS.has(sniffed.extension) ? "image" : "binary";
    } else {
      result = bytes.length < 3 || !(detectBOM(bytes) || looksLikeText(bytes)) ? "binary" : "text";
    }
    if (result !== "image") {
      debugLogger2.debug(
        `classifyImageContent: ${filePath} -> ${result} (mime ${mimeType})`
      );
    }
    return result;
  } catch (error) {
    debugLogger2.debug(
      `Unable to sniff image content for ${filePath}; preserving extension classification`,
      error instanceof Error ? error.message : String(error)
    );
    return "image";
  } finally {
    await handle?.close().catch(() => void 0);
  }
}
__name(classifyImageContent, "classifyImageContent");
async function detectFileType(filePath) {
  const ext = path3.extname(filePath).toLowerCase();
  if ([".ts", ".mts", ".cts", ".tsx"].includes(ext)) {
    return "text";
  }
  if (ext === ".svg") {
    return "svg";
  }
  if (ext === ".ipynb") {
    return "notebook";
  }
  const lookedUpMimeType = index_lite_default.getType(filePath) ?? MIME_LITE_MISSING_MEDIA_TYPES.get(ext) ?? null;
  if (lookedUpMimeType) {
    if (lookedUpMimeType.startsWith("image/")) {
      return classifyImageContent(filePath, lookedUpMimeType);
    }
    if (lookedUpMimeType.startsWith("audio/")) {
      return "audio";
    }
    if (lookedUpMimeType.startsWith("video/")) {
      return "video";
    }
    if (lookedUpMimeType === "application/pdf") {
      return "pdf";
    }
    if (isTextMime(lookedUpMimeType)) {
      debugLogger2.debug(
        `detectFileType: ${filePath} \u2192 text (mime-trust: ${lookedUpMimeType})`
      );
      return "text";
    }
  }
  if (BINARY_EXTENSIONS.includes(ext)) {
    return "binary";
  }
  if (KNOWN_TEXT_EXTENSIONS.has(ext)) {
    debugLogger2.debug(
      `detectFileType: ${filePath} \u2192 text (extension-override, mime ${lookedUpMimeType ?? "null"})`
    );
    return "text";
  }
  if (KNOWN_TEXT_BASENAMES.has(path3.basename(filePath))) {
    debugLogger2.debug(
      `detectFileType: ${filePath} \u2192 text (basename-override, mime ${lookedUpMimeType ?? "null"})`
    );
    return "text";
  }
  if (await isBinaryFile(filePath)) {
    return "binary";
  }
  return "text";
}
__name(detectFileType, "detectFileType");
function isCacheableReadResult(result) {
  return typeof result.llmContent === "string" && result.originalLineCount !== void 0;
}
__name(isCacheableReadResult, "isCacheableReadResult");
function mediaModalityKey(fileType) {
  if (fileType === "image" || fileType === "pdf" || fileType === "audio" || fileType === "video") {
    return fileType;
  }
  return void 0;
}
__name(mediaModalityKey, "mediaModalityKey");
function unsupportedModalityMessage(modality, displayName) {
  const hint = `This model does not support ${modality} input. The read_file tool cannot process this type of file either. To handle this file, try using skills if applicable, or any tools installed at system wide, or let the user know you cannot process this type of file.`;
  return `[Unsupported ${modality} file: "${displayName}". ${hint}]`;
}
__name(unsupportedModalityMessage, "unsupportedModalityMessage");
async function processSingleFileContent(filePath, config, optionsOrOffset, legacyLimit, legacyPages) {
  const options = typeof optionsOrOffset === "object" && optionsOrOffset !== null ? optionsOrOffset : {
    offset: optionsOrOffset,
    limit: legacyLimit,
    pages: legacyPages
  };
  const {
    offset,
    limit,
    pages,
    preserveUnsupportedImage = false,
    preparePdfForVisionBridge = false,
    signal,
    largePdfBehavior = "error",
    displayPath = filePath
  } = options;
  const rootDirectory = config.getTargetDir();
  const relativePathForDisplay = (path3.isAbsolute(displayPath) ? path3.relative(rootDirectory, displayPath) : displayPath).replace(/\\/g, "/");
  try {
    signal?.throwIfAborted();
    let stats;
    try {
      stats = options.textFileStats ?? await fs3.promises.stat(filePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {
          llmContent: "Could not read file because no file was found at the specified path.",
          returnDisplay: "File not found.",
          error: `File not found: ${displayPath}`,
          errorType: "file_not_found" /* FILE_NOT_FOUND */
        };
      }
      throw error;
    }
    if (stats.isDirectory()) {
      return {
        llmContent: "Could not read file because the provided path is a directory, not a file.",
        returnDisplay: "Path is a directory.",
        error: `Path is a directory, not a file: ${displayPath}`,
        errorType: "target_is_directory" /* TARGET_IS_DIRECTORY */
      };
    }
    if (!stats.isFile()) {
      return {
        llmContent: `Cannot read file: ${path3.basename(filePath)} is not a regular file (e.g. device, socket, or pipe).`,
        returnDisplay: "Not a regular file.",
        error: `Not a regular file: ${displayPath}`,
        errorType: "read_content_failure" /* READ_CONTENT_FAILURE */
      };
    }
    const mediaMimeType = index_lite_default.getType(filePath) ?? MIME_LITE_MISSING_MEDIA_TYPES.get(path3.extname(filePath).toLowerCase()) ?? "application/octet-stream";
    const bridgePreservesImage = preserveUnsupportedImage && mediaMimeType.startsWith("image/") && SNIFFABLE_IMAGE_MIME_TYPES.has(mediaMimeType);
    const fileType = options.textFileHandle ? "text" : options.fileType ?? (bridgePreservesImage ? "image" : await detectFileType(filePath));
    const shouldRenderImageOverview = fileType === "image" && CANONICAL_IMAGE_MIME_TYPES.has(mediaMimeType);
    const displayName = path3.basename(displayPath);
    const modalities = config.getContentGeneratorConfig?.()?.modalities ?? {};
    const willRenderPdfImages = fileType === "pdf" && !!modalities.image && largePdfBehavior !== "reference";
    const renderForBridge = fileType === "pdf" && !modalities.image && !modalities.pdf && (preserveUnsupportedImage || preparePdfForVisionBridge);
    const fileSizeInMB = stats.size / (1024 * 1024);
    const normalizedPages = pages?.trim();
    let pageRange;
    let pdfPageCount;
    if (fileType === "pdf" && normalizedPages !== void 0) {
      const invalidPagesDisplay = `Invalid PDF pages parameter: ${relativePathForDisplay}`;
      const invalidPagesResult = /* @__PURE__ */ __name((message) => ({
        llmContent: message,
        returnDisplay: invalidPagesDisplay,
        error: message,
        errorType: "invalid_tool_params" /* INVALID_TOOL_PARAMS */
      }), "invalidPagesResult");
      const parsedPageRange = parsePDFPageRange(normalizedPages);
      if (!parsedPageRange) {
        return invalidPagesResult(
          `Invalid pages parameter: '${normalizedPages}'. Use formats like '5' or '1-10'.`
        );
      }
      if (parsedPageRange.lastPage === Infinity) {
        return invalidPagesResult(
          `Open-ended page ranges (e.g. '3-') are not supported; specify an explicit end page within the ${PDF_MAX_PAGES_PER_READ}-page limit (e.g. '3-22').`
        );
      }
      if (parsedPageRange.lastPage - parsedPageRange.firstPage + 1 > PDF_MAX_PAGES_PER_READ) {
        return invalidPagesResult(
          `Pages range exceeds maximum of ${PDF_MAX_PAGES_PER_READ} pages per request.`
        );
      }
      pageRange = parsedPageRange;
    }
    const willExtractPdfText = fileType === "pdf" && (pageRange !== void 0 || !modalities.pdf);
    if (!pageRange && willExtractPdfText && fileSizeInMB > PDF_FULL_TEXT_EXTRACTION_MAX_MB) {
      return {
        llmContent: `PDF file is too large for full text extraction: ${fileSizeInMB.toFixed(2)}MB exceeds the ${PDF_FULL_TEXT_EXTRACTION_MAX_MB}MB limit. Use the 'pages' parameter to read a narrower range, or split the document into smaller files before retrying.`,
        returnDisplay: `PDF file too large (${fileSizeInMB.toFixed(2)}MB > ${PDF_FULL_TEXT_EXTRACTION_MAX_MB}MB).`,
        error: `PDF exceeds extraction size limit: ${displayPath} (${fileSizeInMB.toFixed(2)}MB)`,
        errorType: "file_too_large" /* FILE_TOO_LARGE */,
        stats
      };
    }
    if (pageRange && fileSizeInMB > PDF_PAGED_TEXT_EXTRACTION_MAX_MB) {
      return {
        llmContent: `PDF file is too large for page-range text extraction: ${fileSizeInMB.toFixed(2)}MB exceeds the ${PDF_PAGED_TEXT_EXTRACTION_MAX_MB}MB limit. Split the document into smaller files before retrying.`,
        returnDisplay: `PDF file too large (${fileSizeInMB.toFixed(2)}MB > ${PDF_PAGED_TEXT_EXTRACTION_MAX_MB}MB).`,
        error: `PDF exceeds page-range extraction size limit: ${displayPath} (${fileSizeInMB.toFixed(2)}MB)`,
        errorType: "file_too_large" /* FILE_TOO_LARGE */,
        stats
      };
    }
    if (willExtractPdfText && !pageRange) {
      pdfPageCount = await getPDFPageCount(filePath);
      const requirement = shouldRequirePDFPageRange(pdfPageCount, stats.size);
      const rangeRequired = willRenderPdfImages ? requirement.effectivePageCount > PDF_MAX_PAGES_PER_READ : requirement.required;
      debugLogger2.debug(
        `PDF full-text fallback gate: file=${relativePathForDisplay}, sizeMB=${fileSizeInMB.toFixed(2)}, pageCount=${pdfPageCount ?? "unknown"}, required=${requirement.required}, rangeRequired=${rangeRequired}, effectivePageCount=${requirement.effectivePageCount}, hadPdfInfo=${requirement.hadPdfInfo}, behavior=${largePdfBehavior}`
      );
      if (rangeRequired) {
        if (largePdfBehavior === "error" && !await isPdftotextAvailable()) {
          return {
            llmContent: `[Cannot extract text from PDF: "${displayName}". ${PDF_TEXT_EXTRACTION_UNAVAILABLE_MESSAGE}]`,
            returnDisplay: `Failed to read pdf: ${relativePathForDisplay}`,
            error: PDF_TEXT_EXTRACTION_UNAVAILABLE_MESSAGE,
            errorType: "read_content_failure" /* READ_CONTENT_FAILURE */,
            stats
          };
        }
        const guidance = buildLargePDFGuidance(displayName, requirement);
        const returnDisplay = largePdfBehavior === "reference" ? `Referenced large PDF: ${relativePathForDisplay}` : `PDF requires page range: ${relativePathForDisplay}`;
        return {
          llmContent: guidance,
          returnDisplay,
          ...largePdfBehavior === "error" ? {
            error: guidance,
            errorType: "file_too_large" /* FILE_TOO_LARGE */
          } : {},
          stats
        };
      }
    }
    let omniModule;
    if ((fileType === "video" && modalities.video || fileType === "audio" && modalities.audio || fileType === "image" && modalities.image) && // Cheap gate BEFORE the dynamic import: the import itself touches
    // the filesystem (vitest SSR transforms), which breaks mock-fs
    // suites and wastes a module load for every non-omni user.
    config.isOmniEnabled?.()) {
      const omni = await config.loadOmniMediaReader();
      if (omni.isOmniDeliveryActive(config)) {
        const sniffedModality = await omni.sniffFileModality(filePath);
        if (sniffedModality === fileType) {
          omniModule = omni;
        }
      }
    }
    if (shouldRenderImageOverview && omniModule === void 0 && stats.size > IMAGE_MAX_SOURCE_BYTES) {
      return {
        llmContent: "Image file exceeds the 100 MB source limit.",
        returnDisplay: "Image file exceeds the 100 MB source limit.",
        error: `Image file exceeds the 100 MB source limit: ${displayPath}`,
        errorType: "file_too_large" /* FILE_TOO_LARGE */
      };
    }
    if (fileSizeInMB > 9.9 && !willExtractPdfText && fileType !== "text" && !shouldRenderImageOverview && omniModule === void 0) {
      return {
        llmContent: "File size exceeds the 10MB limit.",
        returnDisplay: "File size exceeds the 10MB limit.",
        error: `File size exceeds the 10MB limit: ${displayPath} (${fileSizeInMB.toFixed(2)}MB)`,
        errorType: "file_too_large" /* FILE_TOO_LARGE */
      };
    }
    const modality = mediaModalityKey(fileType);
    if (modality && modality !== "pdf") {
      if (!modalities[modality]) {
        const bridgeWillHandleImage = modality === "image" && preserveUnsupportedImage;
        if (!bridgeWillHandleImage) {
          const message = unsupportedModalityMessage(modality, displayName);
          debugLogger2.warn(
            `Model '${config.getModel()}' does not support ${modality} input. Skipping file: ${relativePathForDisplay}`
          );
          return {
            llmContent: message,
            returnDisplay: `Skipped ${fileType} file: ${relativePathForDisplay} (model doesn't support ${modality} input)`
          };
        }
        debugLogger2.debug(
          `Preserving unsupported image for vision bridge: ${relativePathForDisplay}`
        );
      }
    }
    switch (fileType) {
      case "binary": {
        return {
          llmContent: `Cannot display content of binary file: ${relativePathForDisplay}`,
          returnDisplay: `Skipped binary file: ${relativePathForDisplay}`,
          stats
        };
      }
      case "svg": {
        const SVG_MAX_SIZE_BYTES = 1 * 1024 * 1024;
        if (stats.size > SVG_MAX_SIZE_BYTES) {
          return {
            llmContent: `Cannot display content of SVG file larger than 1MB: ${relativePathForDisplay}`,
            returnDisplay: `Skipped large SVG file (>1MB): ${relativePathForDisplay}`,
            stats
          };
        }
        const content = await readFileWithEncoding(filePath);
        return {
          llmContent: content,
          returnDisplay: `Read SVG as text: ${relativePathForDisplay}`,
          originalLineCount: content.split("\n").length,
          isTruncated: false,
          stats
        };
      }
      case "text": {
        const fileSystemService = config.getFileSystemService();
        const maxOutputBytes = getRangeReadByteLimit(config);
        const readTextFileFromHandle = fileSystemService.readTextFileFromHandle;
        const { content, _meta } = options.textFileHandle ? await readTextFileFromHandle.call(fileSystemService, {
          fileHandle: options.textFileHandle,
          fileSize: stats.size,
          limit: limit ?? config.getTruncateToolOutputLines(),
          line: offset,
          maxOutputBytes,
          maxScanBytes: options.textFileMaxScanBytes ?? maxOutputBytes,
          ...signal !== void 0 ? { signal } : {}
        }) : await fileSystemService.readTextFile({
          path: filePath,
          limit: limit ?? config.getTruncateToolOutputLines(),
          line: offset,
          maxOutputBytes,
          stats,
          ...signal !== void 0 ? { signal } : {}
        });
        const selectedLines = content.split("\n").map((line) => line.trimEnd());
        const startLine = offset || 0;
        const selectedLineCount = content.length === 0 ? 0 : selectedLines.length;
        const hasOriginalLineCount = _meta?.originalLineCount !== void 0;
        const originalLineCount = _meta?.originalLineCount ?? (stats.size >= TEXT_RANGE_FAST_PATH_MAX_SIZE ? startLine + selectedLineCount : await countFileLines(filePath));
        const originalLineCountExact = _meta?.originalLineCountExact === false ? false : hasOriginalLineCount || stats.size < TEXT_RANGE_FAST_PATH_MAX_SIZE;
        const configCharLimit = config.getTruncateToolOutputThreshold();
        let llmContent = "";
        let contentLengthTruncated = false;
        let linesIncluded = 0;
        if (Number.isFinite(configCharLimit)) {
          const formattedLines = [];
          let currentLength = 0;
          for (const line of selectedLines) {
            const sep = linesIncluded > 0 ? 1 : 0;
            linesIncluded++;
            const projectedLength = currentLength + line.length + sep;
            if (projectedLength <= configCharLimit) {
              formattedLines.push(line);
              currentLength = projectedLength;
            } else {
              const remaining = Math.max(
                configCharLimit - currentLength - sep,
                10
              );
              formattedLines.push(
                line.substring(0, remaining) + "... [truncated]"
              );
              contentLengthTruncated = true;
              break;
            }
          }
          llmContent = formattedLines.join("\n");
        } else {
          llmContent = selectedLines.join("\n");
          linesIncluded = selectedLines.length;
        }
        if (_meta?.truncatedByBytes === true) {
          const marker = "... [truncated]";
          if (!llmContent.endsWith(marker)) {
            const prefix = Number.isFinite(configCharLimit) ? llmContent.slice(
              0,
              Math.max(configCharLimit - marker.length - 1, 0)
            ) : llmContent;
            const separator = prefix.length === 0 || prefix.endsWith("\n") ? "" : "\n";
            llmContent = prefix + separator + marker;
          }
          contentLengthTruncated = true;
        }
        const actualEndLine = startLine + linesIncluded;
        const contentRangeTruncated = startLine > 0 || !originalLineCountExact || actualEndLine < originalLineCount;
        const isTruncated = contentRangeTruncated || contentLengthTruncated;
        const lineCountLabel = originalLineCountExact ? `${originalLineCount}` : `at least ${originalLineCount}`;
        let returnDisplay = "";
        if (isTruncated) {
          returnDisplay = `Read lines ${startLine + 1}-${actualEndLine} of ${lineCountLabel} from ${relativePathForDisplay}`;
          if (contentLengthTruncated) {
            returnDisplay += " (truncated)";
          }
        }
        return {
          llmContent,
          returnDisplay,
          isTruncated,
          originalLineCount,
          originalLineCountExact,
          linesShown: [startLine + 1, actualEndLine],
          stats
        };
      }
      case "image": {
        if (omniModule) {
          return await omniModule.readMediaViaOmniDelivery({
            filePath,
            config,
            displayName,
            relativePathForDisplay,
            expectedModality: "image",
            signal
          });
        }
        if (shouldRenderImageOverview) {
          try {
            const view = await renderImageOverview(
              filePath,
              signal ?? new AbortController().signal
            );
            const zoomHint = config.getCodeModeOnly?.() ? `If details are too small, call tools.zoom_image with coordinates normalized from 0 to 1000.` : `If details are too small, use tool_search for "zoom image", then call zoom_image with coordinates normalized from 0 to 1000.`;
            return {
              llmContent: [
                {
                  text: `Image overview: ${view.outputWidth}x${view.outputHeight}; oriented source: ${view.sourceWidth}x${view.sourceHeight}. ` + zoomHint
                },
                {
                  inlineData: {
                    data: view.bytes.toString("base64"),
                    mimeType: view.mimeType,
                    displayName
                  }
                }
              ],
              returnDisplay: `Read image file: ${relativePathForDisplay}`
            };
          } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof ImageViewError) {
              if (error.code === "source_too_large" || error.code === "output_too_large") {
                const userMessage = error.message.replace(`: ${filePath}`, "");
                return {
                  llmContent: userMessage,
                  returnDisplay: userMessage,
                  error: error.message,
                  errorType: "file_too_large" /* FILE_TOO_LARGE */
                };
              }
              if ((error.code === "decode_failed" || error.code === "unsupported_image") && !preserveUnsupportedImage) {
                const notice = `Image ${relativePathForDisplay} could not be decoded (corrupt or unsupported encoding), so its data was omitted from the model request. Ask the user for a readable PNG, JPEG, or WebP version if the image content matters.`;
                return {
                  llmContent: notice,
                  returnDisplay: `Omitted undecodable image: ${relativePathForDisplay}`
                };
              }
            } else {
              throw error;
            }
          }
        }
        if (!PROVIDER_SAFE_IMAGE_MIME_TYPES.has(mediaMimeType) && !preserveUnsupportedImage) {
          const notice = `Image format ${mediaMimeType} (${relativePathForDisplay}) cannot be safely sent to the model, so its data was omitted from the request. Ask the user for a PNG, JPEG, WebP, or GIF version if the image content matters.`;
          return {
            llmContent: notice,
            returnDisplay: `Omitted unsupported image format: ${relativePathForDisplay} (${mediaMimeType})`
          };
        }
        const contentBuffer = await fs3.promises.readFile(filePath);
        if (mediaMimeType === "image/gif") {
          const sharpModule = await import("sharp").catch(() => void 0);
          if (sharpModule) {
            try {
              await sharpModule.default(contentBuffer, {
                failOn: "error"
              }).metadata();
            } catch {
              signal?.throwIfAborted();
              if (!preserveUnsupportedImage) {
                const notice = `Image ${relativePathForDisplay} could not be decoded (corrupt or unsupported encoding), so its data was omitted from the model request. Ask the user for a readable PNG, JPEG, WebP, or GIF version if the image content matters.`;
                return {
                  llmContent: notice,
                  returnDisplay: `Omitted undecodable image: ${relativePathForDisplay}`
                };
              }
            }
          }
        }
        const base64Data = contentBuffer.toString("base64");
        const base64SizeInMB = base64Data.length / (1024 * 1024);
        if (base64SizeInMB > 9.9) {
          return {
            llmContent: `File exceeds the 10MB data URI limit after base64 encoding (${base64SizeInMB.toFixed(2)}MB encoded).`,
            returnDisplay: `File exceeds the 10MB data URI limit after base64 encoding.`,
            error: `File exceeds the 10MB data URI limit after base64 encoding: ${displayPath} (${base64SizeInMB.toFixed(2)}MB encoded)`,
            errorType: "file_too_large" /* FILE_TOO_LARGE */
          };
        }
        return {
          llmContent: {
            inlineData: {
              data: base64Data,
              mimeType: mediaMimeType,
              displayName
            }
          },
          returnDisplay: `Read image file: ${relativePathForDisplay}`
        };
      }
      case "audio":
      case "video": {
        if (omniModule) {
          return await omniModule.readMediaViaOmniDelivery({
            filePath,
            config,
            displayName,
            relativePathForDisplay,
            expectedModality: fileType,
            signal
          });
        }
        const contentBuffer = await fs3.promises.readFile(filePath);
        const base64Data = contentBuffer.toString("base64");
        const base64SizeInMB = base64Data.length / (1024 * 1024);
        if (base64SizeInMB > 9.9) {
          return {
            llmContent: `File exceeds the 10MB data URI limit after base64 encoding (${base64SizeInMB.toFixed(2)}MB encoded).`,
            returnDisplay: `File exceeds the 10MB data URI limit after base64 encoding.`,
            error: `File exceeds the 10MB data URI limit after base64 encoding: ${displayPath} (${base64SizeInMB.toFixed(2)}MB encoded)`,
            errorType: "file_too_large" /* FILE_TOO_LARGE */
          };
        }
        return {
          llmContent: {
            inlineData: {
              data: base64Data,
              mimeType: mediaMimeType,
              displayName
            }
          },
          returnDisplay: `Read ${fileType} file: ${relativePathForDisplay}`
        };
      }
      case "pdf": {
        if (!pageRange && modalities.pdf) {
          const contentBuffer = await fs3.promises.readFile(filePath);
          const base64Data = contentBuffer.toString("base64");
          const base64SizeInMB = base64Data.length / (1024 * 1024);
          if (base64SizeInMB > 9.9) {
            return {
              llmContent: `File exceeds the 10MB data URI limit after base64 encoding (${base64SizeInMB.toFixed(2)}MB encoded).`,
              returnDisplay: `File exceeds the 10MB data URI limit after base64 encoding.`,
              error: `File exceeds the 10MB data URI limit after base64 encoding: ${displayPath} (${base64SizeInMB.toFixed(2)}MB encoded)`,
              errorType: "file_too_large" /* FILE_TOO_LARGE */
            };
          }
          return {
            llmContent: {
              inlineData: {
                data: base64Data,
                mimeType: "application/pdf",
                displayName
              }
            },
            returnDisplay: `Read pdf file: ${relativePathForDisplay}`
          };
        }
        const pdfResult = await extractPDFText(filePath, pageRange);
        const estimatedTokens = pdfResult.success ? estimatePDFTextOutputTokens(pdfResult.text) : 0;
        if (pdfResult.success) {
          if (estimatedTokens <= PDF_TEXT_RESULT_MAX_TOKENS) {
            const pagesLabel = normalizedPages ? ` (pages ${normalizedPages})` : "";
            return {
              llmContent: pdfResult.text,
              returnDisplay: `Read pdf as text${pagesLabel}: ${relativePathForDisplay}`,
              stats
            };
          }
        }
        const toImageParts = /* @__PURE__ */ __name((images, startPage) => images.map((image, index) => ({
          inlineData: {
            data: image.data,
            mimeType: image.mimeType,
            displayName: `${displayName} (page ${startPage + index})`
          }
        })), "toImageParts");
        if (willRenderPdfImages) {
          const startPage = pageRange?.firstPage ?? 1;
          const render = await renderPDFPagesToImages(
            filePath,
            pageRange ?? { firstPage: 1, lastPage: PDF_MAX_PAGES_PER_READ }
          );
          if (render.success && render.images.length > 0) {
            const parts = toImageParts(render.images, startPage);
            if (render.bytesTruncated) {
              parts.push({
                text: `[Rendered the first ${render.images.length} page(s) of "${displayName}"; later pages were omitted to stay within size limits. Use the 'pages' parameter to read a specific range.]`
              });
            } else if (!pageRange && render.images.length >= PDF_MAX_PAGES_PER_READ) {
              parts.push({
                text: `[Rendered the first ${render.images.length} page(s) (the per-read maximum) of "${displayName}". If the document has more pages, use the 'pages' parameter to read a later range.]`
              });
            }
            return {
              llmContent: parts,
              returnDisplay: `Read pdf as ${render.images.length} image(s): ${relativePathForDisplay}`,
              stats
            };
          }
          const renderError = render.success ? "renderer returned no page images" : render.error;
          debugLogger2.debug(
            `PDF image render failed, falling back to text outcome: file=${relativePathForDisplay}, error=${renderError}`
          );
        }
        const isSinglePageRead = pageRange ? pageRange.firstPage === pageRange.lastPage : pdfPageCount === 1;
        const singlePageTextOverflow = pdfResult.success && estimatedTokens > PDF_TEXT_RESULT_MAX_TOKENS && isSinglePageRead;
        if (renderForBridge && (!pdfResult.success || singlePageTextOverflow)) {
          if (pageRange && pdfPageCount === void 0) {
            pdfPageCount = await getPDFPageCount(filePath);
          }
          const firstPage = pageRange?.firstPage ?? 1;
          const requestedLastPage = pageRange?.lastPage ?? pdfPageCount ?? firstPage + VISION_BRIDGE_MAX_IMAGES - 1;
          const effectiveRequestedLastPage = pdfPageCount == null ? requestedLastPage : Math.min(requestedLastPage, pdfPageCount);
          const lastPage = Math.min(
            effectiveRequestedLastPage,
            firstPage + VISION_BRIDGE_MAX_IMAGES - 1
          );
          const render = lastPage >= firstPage ? await renderPDFPagesToImages(filePath, {
            firstPage,
            lastPage
          }) : {
            success: false,
            error: "The requested page range is outside the PDF."
          };
          if (render.success && render.images.length > 0) {
            const parts = toImageParts(render.images, firstPage);
            const renderedLastPage = firstPage + render.images.length - 1;
            let continuation;
            if (pdfPageCount != null) {
              const actualRequestedLastPage = pageRange ? Math.min(pageRange.lastPage, pdfPageCount) : pdfPageCount;
              if (actualRequestedLastPage > renderedLastPage) {
                continuation = {
                  certainty: "known",
                  firstPage: renderedLastPage + 1,
                  lastPage: actualRequestedLastPage
                };
              }
            } else {
              const renderedRequestedPageCount = lastPage - firstPage + 1;
              const reachedEndOfFile = render.images.length < renderedRequestedPageCount && !render.bytesTruncated;
              const requestedHasMore = pageRange == null || pageRange.lastPage > renderedLastPage;
              if (!reachedEndOfFile && requestedHasMore && (render.bytesTruncated || render.images.length >= VISION_BRIDGE_MAX_IMAGES)) {
                continuation = {
                  certainty: "possible",
                  firstPage: renderedLastPage + 1,
                  ...pageRange && {
                    requestedLastPage: pageRange.lastPage
                  }
                };
              }
            }
            if (continuation) {
              const suggestedLast = Math.min(
                (continuation.certainty === "known" ? continuation.lastPage : continuation.requestedLastPage) ?? continuation.firstPage + VISION_BRIDGE_MAX_IMAGES - 1,
                continuation.firstPage + VISION_BRIDGE_MAX_IMAGES - 1
              );
              const omitted = continuation.certainty === "known" ? `pages ${continuation.firstPage}-${continuation.lastPage} were not included` : continuation.requestedLastPage ? `additional requested pages may exist from page ${continuation.firstPage} through page ${continuation.requestedLastPage}` : `later pages may remain after page ${renderedLastPage}`;
              const instruction = continuation.certainty === "known" ? "Use" : "If continuation is needed, use";
              parts.push({
                text: `[Rendered PDF pages ${firstPage}-${renderedLastPage} of ${JSON.stringify(displayName)} for transcription; ${omitted}. ${instruction} read_file on the original PDF with pages "${continuation.firstPage}-${suggestedLast}" to continue.]`
              });
            }
            let candidate;
            if (preparePdfForVisionBridge) {
              let fallback;
              if (pdfResult.success) {
                const guidance = buildPDFTextTooLargeGuidance(
                  displayName,
                  estimatedTokens,
                  normalizedPages
                );
                fallback = {
                  llmContent: guidance,
                  returnDisplay: `PDF text too large: ${relativePathForDisplay}`,
                  error: guidance,
                  errorType: "file_too_large" /* FILE_TOO_LARGE */
                };
              } else {
                fallback = {
                  llmContent: `[Cannot extract text from PDF: "${displayName}". ${pdfResult.error}]`,
                  returnDisplay: `Failed to read pdf: ${relativePathForDisplay}`,
                  error: pdfResult.error,
                  errorType: "read_content_failure" /* READ_CONTENT_FAILURE */
                };
              }
              candidate = {
                reason: pdfResult.success ? "single_page_text_overflow" : "text_extraction_failed",
                displayName,
                renderedRange: {
                  firstPage,
                  lastPage: renderedLastPage
                },
                ...continuation && { continuation },
                fallback
              };
            }
            return {
              llmContent: parts,
              returnDisplay: `Rendered ${render.images.length} page(s) for transcription: ${relativePathForDisplay}`,
              stats,
              ...candidate && { pdfVisionBridgeCandidate: candidate }
            };
          }
          const renderError = render.success ? "renderer returned no page images" : render.error;
          debugLogger2.debug(
            `PDF bridge render failed, falling back to text outcome: file=${relativePathForDisplay}, error=${renderError}`
          );
        }
        if (pdfResult.success) {
          const guidance = buildPDFTextTooLargeGuidance(
            displayName,
            estimatedTokens,
            normalizedPages
          );
          debugLogger2.debug(
            `PDF text extraction output exceeds token limit: file=${relativePathForDisplay}, pages=${normalizedPages ?? "all"}, limit=${PDF_TEXT_RESULT_MAX_TOKENS}`
          );
          if (!pageRange && largePdfBehavior === "reference") {
            return {
              llmContent: guidance,
              returnDisplay: `Referenced large PDF: ${relativePathForDisplay}`,
              stats
            };
          }
          return {
            llmContent: guidance,
            returnDisplay: `PDF text too large: ${relativePathForDisplay}`,
            error: guidance,
            errorType: "file_too_large" /* FILE_TOO_LARGE */,
            stats
          };
        }
        return {
          llmContent: `[Cannot extract text from PDF: "${displayName}". ${pdfResult.error}]`,
          returnDisplay: `Failed to read pdf: ${relativePathForDisplay}`,
          error: pdfResult.error,
          errorType: "read_content_failure" /* READ_CONTENT_FAILURE */
        };
      }
      case "notebook": {
        try {
          const { content, isTruncated } = await readNotebookWithMetadata(filePath);
          return {
            llmContent: content,
            returnDisplay: `Read notebook: ${relativePathForDisplay}`,
            isTruncated,
            stats
          };
        } catch (e) {
          const msg = getErrorMessage(e);
          return {
            llmContent: `Error parsing notebook ${relativePathForDisplay}: ${msg}`,
            returnDisplay: `Error reading notebook: ${relativePathForDisplay}`,
            error: `Error parsing notebook ${displayPath}: ${msg}`,
            errorType: "read_content_failure" /* READ_CONTENT_FAILURE */
          };
        }
      }
      default: {
        const exhaustiveCheck = fileType;
        return {
          llmContent: `Unhandled file type: ${exhaustiveCheck}`,
          returnDisplay: `Skipped unhandled file type: ${relativePathForDisplay}`,
          error: `Unhandled file type for ${displayPath}`
        };
      }
    }
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      throw error;
    }
    const errorMessage = getErrorMessage(error);
    return {
      llmContent: `Error reading file ${relativePathForDisplay}: ${errorMessage}`,
      returnDisplay: `Error reading file ${relativePathForDisplay}: ${errorMessage}`,
      error: `Error reading file ${relativePathForDisplay}: ${errorMessage}`,
      errorType: "read_content_failure" /* READ_CONTENT_FAILURE */
    };
  }
}
__name(processSingleFileContent, "processSingleFileContent");
function getRangeReadByteLimit(config) {
  const charLimit = config.getTruncateToolOutputThreshold();
  if (charLimit === Number.POSITIVE_INFINITY) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (!Number.isFinite(charLimit)) {
    return DEFAULT_RANGE_READ_BYTES;
  }
  return Math.max(DEFAULT_RANGE_READ_BYTES, Math.floor(charLimit) * 4);
}
__name(getRangeReadByteLimit, "getRangeReadByteLimit");
function normalizeRangeReadByteLimit(maxOutputBytes) {
  if (maxOutputBytes === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }
  return typeof maxOutputBytes === "number" && Number.isFinite(maxOutputBytes) ? maxOutputBytes : DEFAULT_RANGE_READ_BYTES;
}
__name(normalizeRangeReadByteLimit, "normalizeRangeReadByteLimit");
async function fileExists(filePath) {
  try {
    await fsPromises.access(filePath, fs3.constants.F_OK);
    return true;
  } catch (_) {
    return false;
  }
}
__name(fileExists, "fileExists");

export {
  TOKEN_ESTIMATE_UNITS_PER_TOKEN,
  estimateTextTokens,
  estimateTextTokenUnits,
  isUtf8CompatibleEncoding,
  loadIconvLite,
  LOCAL_CONTEXT_FILENAME,
  MEMORY_SECTION_HEADER,
  setMemoryFilename,
  getCurrentMemoryFilename,
  getAllMemoryFilenames,
  getAllGeminiMdFilenames,
  FileExclusions,
  getCachedEncodingForBuffer,
  getSystemEncoding,
  PDF_MAX_PAGES_PER_READ,
  parsePDFPageRange,
  extractPDFText,
  VISION_BRIDGE_MAX_IMAGES,
  VISION_BRIDGE_MAX_IMAGE_BASE64_BYTES,
  isBinaryContentType,
  sniffFileKind,
  looksLikeText,
  persistBinaryContent,
  formatByteSize,
  normalizeSource,
  parseNotebook,
  inferNotebookJsonFormat,
  serializeNotebook,
  getCellDisplayId,
  hasStableCellIds,
  isAmbiguousCellId,
  findCellIndex,
  getNotebookLanguage,
  makeCellId,
  inferInsertedCellSourceArrayStyle,
  toNotebookSource,
  normalizeEditedCell,
  CursorNotAtLineBoundaryError,
  LargeNonUtf8TextError,
  TextScanBudgetExceededError,
  readTextRangeFromHandle,
  readTextCursorWindowFromHandle,
  ImageViewError,
  renderNormalizedImageCrop,
  isSupportedImageMimeType,
  getUnsupportedImageFormatWarning,
  decodeBufferWithEncodingInfoAsync,
  readFileWithLineAndLimit,
  getSpecificMimeType,
  isWithinRoot,
  detectFileType,
  isCacheableReadResult,
  processSingleFileContent,
  fileExists
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
