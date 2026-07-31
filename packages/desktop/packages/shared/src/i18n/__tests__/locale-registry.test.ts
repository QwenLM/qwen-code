import { describe, it, expect } from "bun:test";
import { readdirSync } from "fs";
import { join } from "path";
import { LOCALE_REGISTRY, type LanguageCode } from "../registry";
import { SUPPORTED_LANGUAGE_CODES, LANGUAGES } from "../languages";
import { getDateLocale } from "../date-locale";

// ---------------------------------------------------------------------------
// Registry completeness — every locale file on disk must be in the registry
// ---------------------------------------------------------------------------

const LOCALES_DIR = join(import.meta.dir, "../locales");
const localeFilesOnDisk = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(".json", ""));

describe("locale registry completeness", () => {
  const registryCodes = Object.keys(LOCALE_REGISTRY);

  it("every locale file on disk is registered in LOCALE_REGISTRY", () => {
    const unregistered = localeFilesOnDisk.filter(
      (code) => !registryCodes.includes(code),
    );
    expect(unregistered).toEqual([]);
  });

  it("every registry entry has a locale file on disk", () => {
    const missingFiles = registryCodes.filter(
      (code) => !localeFilesOnDisk.includes(code),
    );
    expect(missingFiles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Registry entry validation — each entry has all required fields
// ---------------------------------------------------------------------------

describe("locale registry entries", () => {
  for (const [code, entry] of Object.entries(LOCALE_REGISTRY)) {
    it(`${code} has a non-empty nativeName`, () => {
      expect(entry.nativeName.length).toBeGreaterThan(0);
    });

    it(`${code} has messages (non-empty object)`, () => {
      expect(Object.keys(entry.messages).length).toBeGreaterThan(0);
    });

    it(`${code} has a dateLocale`, () => {
      expect(entry.dateLocale).toBeDefined();
      expect(entry.dateLocale.code).toBeDefined();
    });
  }
});

// ---------------------------------------------------------------------------
// Derived exports — SUPPORTED_LANGUAGE_CODES and LANGUAGES stay in sync
// ---------------------------------------------------------------------------

describe("derived exports", () => {
  it("SUPPORTED_LANGUAGE_CODES matches registry keys", () => {
    const registryCodes = Object.keys(LOCALE_REGISTRY).sort() as string[];
    const supported = ([...SUPPORTED_LANGUAGE_CODES] as string[]).sort();
    expect(supported).toEqual(registryCodes);
  });

  it("LANGUAGES has an entry for every supported code", () => {
    for (const code of SUPPORTED_LANGUAGE_CODES) {
      expect(LANGUAGES[code]).toBeDefined();
      expect(LANGUAGES[code].nativeName.length).toBeGreaterThan(0);
    }
  });

  it("LANGUAGES nativeNames match registry", () => {
    for (const code of SUPPORTED_LANGUAGE_CODES) {
      expect(LANGUAGES[code].nativeName).toBe(
        LOCALE_REGISTRY[code as LanguageCode].nativeName,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Date locale resolution — each supported locale resolves correctly
// ---------------------------------------------------------------------------

describe("getDateLocale", () => {
  it("en resolves to English (US)", () => {
    const locale = getDateLocale("en");
    expect(locale.code).toBe("en-US");
  });

  it("es resolves to Spanish", () => {
    const locale = getDateLocale("es");
    expect(locale.code).toBe("es");
  });

  it("zh-Hans resolves to Simplified Chinese", () => {
    const locale = getDateLocale("zh-Hans");
    expect(locale.code).toBe("zh-CN");
  });

  it("hu resolves to Hungarian", () => {
    const locale = getDateLocale("hu");
    expect(locale.code).toBe("hu");
  });

  it("de resolves to German", () => {
    const locale = getDateLocale("de");
    expect(locale.code).toBe("de");
  });

  it("pl resolves to Polish", () => {
    const locale = getDateLocale("pl");
    expect(locale.code).toBe("pl");
  });

  it("unknown locale falls back to English", () => {
    const locale = getDateLocale("xx-FAKE");
    expect(locale.code).toBe("en-US");
  });
});
