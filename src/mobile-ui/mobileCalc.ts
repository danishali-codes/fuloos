/**
 * Safe recursive-descent arithmetic evaluator for the Quick Add calculator numpad.
 * Supports +, -, *, / (and Unicode −, ×, ÷) with standard operator precedence.
 * Returns null if the expression is empty, malformed, or non-finite.
 */
export function evaluateCalculatorExpression(raw: string): number | null {
  const normalized = raw
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/−/g, "-")
    .replace(/\s+/g, "");

  if (!normalized) return null;
  if (!/^[0-9+\-*/.]+$/.test(normalized)) return null;

  const tokens: string[] = [];
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if ("+-*/".includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }
    let j = i;
    let dots = 0;
    while (
      j < normalized.length &&
      (normalized[j] === "." || (normalized[j] >= "0" && normalized[j] <= "9"))
    ) {
      if (normalized[j] === ".") dots++;
      if (dots > 1) return null;
      j++;
    }
    const numStr = normalized.slice(i, j);
    if (numStr === ".") return null;
    tokens.push(numStr);
    i = j;
  }

  while (tokens.length > 0 && "+-*/".includes(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  if (tokens.length === 0) return null;

  let pos = 0;

  function parseNumber(): number | null {
    if (pos >= tokens.length) return null;
    let sign = 1;
    if (tokens[pos] === "+") {
      pos++;
    } else if (tokens[pos] === "-") {
      sign = -1;
      pos++;
    }
    if (pos >= tokens.length || "+-*/".includes(tokens[pos])) return null;
    const val = Number(tokens[pos++]);
    if (!Number.isFinite(val)) return null;
    return sign * val;
  }

  function parseTerm(): number | null {
    let left = parseNumber();
    if (left === null) return null;
    while (pos < tokens.length && (tokens[pos] === "*" || tokens[pos] === "/")) {
      const op = tokens[pos++];
      const right = parseNumber();
      if (right === null) return null;
      if (op === "*") left = left * right;
      else {
        if (right === 0) return null;
        left = left / right;
      }
      if (!Number.isFinite(left)) return null;
    }
    return left;
  }

  function parseExpr(): number | null {
    let left = parseTerm();
    if (left === null) return null;
    while (pos < tokens.length && (tokens[pos] === "+" || tokens[pos] === "-")) {
      const op = tokens[pos++];
      const right = parseTerm();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
      if (!Number.isFinite(left)) return null;
    }
    return left;
  }

  const result = parseExpr();
  if (result === null || pos !== tokens.length || !Number.isFinite(result)) {
    return null;
  }
  return Math.round(result * 100) / 100;
}

/**
 * Lightens a #RRGGBB hex color slightly to produce a rich two-stop card gradient.
 */
export function lightenHex(hex: string, amount = 22): string {
  const clean = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return "#25644d";
  const r = Math.min(255, parseInt(clean.slice(0, 2), 16) + amount);
  const g = Math.min(255, parseInt(clean.slice(2, 4), 16) + amount);
  const b = Math.min(255, parseInt(clean.slice(4, 6), 16) + amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/**
 * Converts a #RRGGBB hex color to rgba(r, g, b, alpha) for soft category badge pills.
 */
export function hexAlpha(hex: string | undefined, alpha = 0.16): string {
  const clean = (hex ?? "#1b4a39").trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return `rgba(27, 74, 57, ${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
