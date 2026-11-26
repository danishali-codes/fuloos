import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateCalculatorExpression,
  hexAlpha,
  lightenHex,
} from "../src/mobile-ui/mobileCalc.ts";

describe("Quick Add calculator expression evaluator", () => {
  it("evaluates numbers, decimals, and Unicode operators with precedence", () => {
    assert.equal(evaluateCalculatorExpression("48.50"), 48.5);
    assert.equal(evaluateCalculatorExpression("25+15.50"), 40.5);
    assert.equal(evaluateCalculatorExpression("100−32.25"), 67.75);
    assert.equal(evaluateCalculatorExpression("10+5×4"), 30);
    assert.equal(evaluateCalculatorExpression("150÷4"), 37.5);
  });

  it("handles trailing operators gracefully while user is typing", () => {
    assert.equal(evaluateCalculatorExpression("48+"), 48);
    assert.equal(evaluateCalculatorExpression("12.5×"), 12.5);
  });

  it("rejects division by zero, invalid characters, and empty input", () => {
    assert.equal(evaluateCalculatorExpression("10÷0"), null);
    assert.equal(evaluateCalculatorExpression(""), null);
    assert.equal(evaluateCalculatorExpression("12.3.4"), null);
    assert.equal(evaluateCalculatorExpression("alert(1)"), null);
  });
});

describe("Mobile color helpers", () => {
  it("lightens valid hex colors and falls back safely", () => {
    assert.equal(lightenHex("#1b5a45", 20), "#2f6e59");
    assert.equal(lightenHex("#ffffff", 20), "#ffffff");
    assert.equal(lightenHex("invalid"), "#25644d");
  });

  it("converts hex to rgba with fallback", () => {
    assert.equal(hexAlpha("#1b4a39", 0.2), "rgba(27, 74, 57, 0.2)");
    assert.equal(hexAlpha(undefined, 0.16), "rgba(27, 74, 57, 0.16)");
  });
});
